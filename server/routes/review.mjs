import { sendJson, readBody } from './_shared.mjs'
import { reviewVisual, reviewStatus } from '../review.mjs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.mjs'
import { currentUser } from '../auth.mjs'
import { charge, refund } from '../credits.mjs'
import { enter, leave } from '../gate.mjs'

const MEDIA_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

// 本地媒体文件（模板库帧图）→ 字节
async function readLocalMedia(mediaPath) {
  const absolute = path.join(config.dataDir, mediaPath.replace(/^\/+/, ''))
  const normalized = path.normalize(absolute)
  if (!normalized.startsWith(path.normalize(config.dataDir))) throw new Error('非法路径')
  const bytes = await fsp.readFile(normalized)
  return { bytes, mime: MEDIA_MIME[path.extname(normalized).toLowerCase()] || 'image/jpeg' }
}

export function createReviewRouter() {
  return {
    prefix: '/api/review',
    async handle(req, res, url, pathname) {
      if (pathname === '/api/review/health') {
        sendJson(res, 200, await reviewStatus())
        return true
      }
      if (pathname === '/api/review' && req.method === 'POST') {
        const body = await readBody(req)
        const user = currentUser(req)
        // 评审按次扣积分：先扣后调，失败退款
        const limit = Number(config.credits.concurrency.review || 0)
        if (user?.id && !enter(user.id, 'review', limit)) {
          sendJson(res, 429, { error: '这个账号还有评审在跑，等它结束再试', code: 'CONCURRENCY_LIMIT', limit })
          return true
        }
        const paid = user?.id ? charge(user.id, 'review', { ref: body.intent ? String(body.intent).slice(0, 60) : '视觉评审' }) : { ok: true, cost: 0, balance: null }
        if (!paid.ok) {
          if (user?.id) leave(user.id, 'review')
          sendJson(res, 402, {
            error: '积分不足：本次评审需要 ' + paid.cost + ' 积分，当前余额 ' + paid.balance + ' 积分',
            code: 'CREDIT_INSUFFICIENT',
            balance: paid.balance,
            cost: paid.cost,
            needed: paid.needed,
          })
          return true
        }
        try {
          let imageBytes
          let mime = 'image/jpeg'
          if (body.media) {
            const local = await readLocalMedia(String(body.media))
            imageBytes = local.bytes
            mime = local.mime
          }
          const result = await reviewVisual({
            imageUrl: body.imageUrl ? String(body.imageUrl) : undefined,
            imageBytes,
            mime,
            intent: body.intent ? String(body.intent).slice(0, 300) : '',
            log: (message) => console.log('[review] ' + message),
          })
          sendJson(res, 200, { ...result, credits: { cost: paid.cost, balance: paid.balance } })
        } catch (error) {
          if (user?.id && paid.cost > 0) refund(user.id, 'review', { amount: paid.cost, ref: '评审失败退款' })
          sendJson(res, 500, { error: String(error?.message || error) })
        } finally {
          if (user?.id) leave(user.id, 'review')
        }
        return true
      }
      sendJson(res, 404, { error: 'review route not found' })
      return true
    },
  }
}
