import { sendJson, readBody } from './_shared.mjs'
import { reviewVisual, reviewStatus } from '../review.mjs'
import { saveReview, listReviews, getReview } from '../reviews.mjs'
import { getProject, listProjects } from '../projects.mjs'
import { projectsById, withReviewProject } from '../review-ownership.mjs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.mjs'
import { currentUser } from '../auth.mjs'
import { charge, refund } from '../credits.mjs'
import { enter, leave } from '../gate.mjs'
import { publicError } from '../public-error.mjs'
import { modelServiceState, noteModelFailure, noteModelSuccess } from '../service-state.mjs'

const MEDIA_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

// 本地媒体文件（模板库帧图）→ 字节
async function readLocalMedia(mediaPath) {
  const absolute = path.join(config.dataDir, mediaPath.replace(/^\/+/, ''))
  const normalized = path.normalize(absolute)
  if (!normalized.startsWith(path.normalize(config.dataDir))) throw new Error('非法路径')
  const bytes = await fsp.readFile(normalized)
  return { bytes, mime: MEDIA_MIME[path.extname(normalized).toLowerCase()] || 'image/jpeg' }
}

const REVIEW_ITEM = /^\/api\/reviews\/([\w-]+)$/

export function createReviewRouter() {
  return {
    prefix: '/api/review',
    extraPrefixes: ['/api/reviews'],
    async handle(req, res, url, pathname) {
      const user = currentUser(req)

      // 评审历史：列表与详情都按账号隔离（管理员可见全部）
      if (pathname === '/api/reviews' && req.method === 'GET') {
        const result = await listReviews({
          limit: url.searchParams.get('limit') || 20,
          offset: url.searchParams.get('offset') || 0,
          verdict: url.searchParams.get('verdict') || '',
          projectId: url.searchParams.get('projectId') || '',
          orphan: url.searchParams.get('orphan') === '1',
        }, user)
        // 评审只记 projectId，作品标题现算：作品改名后历史评审跟着改口，不用回写两百条记录
        const byId = projectsById(await listProjects(user))
        const projects = result.facets.projects.map((entry) => ({
          id: entry.id,
          title: byId.get(entry.id)?.title || '未命名作品',
          count: entry.count,
        }))
        sendJson(res, 200, {
          ...result,
          items: withReviewProject(result.items, byId),
          facets: { ...result.facets, projects },
        })
        return true
      }
      const reviewItem = pathname.match(REVIEW_ITEM)
      if (reviewItem && req.method === 'GET') {
        const record = await getReview(reviewItem[1], user)
        if (!record) {
          sendJson(res, 404, { error: '评审记录不存在' })
          return true
        }
        sendJson(res, 200, withReviewProject([record], projectsById(await listProjects(user)))[0])
        return true
      }

      if (pathname === '/api/review/health') {
        sendJson(res, 200, await reviewStatus())
        return true
      }
      if (pathname === '/api/review' && req.method === 'POST') {
        const body = await readBody(req)
        // 从作品页发起的评审：先确认作品还在，再扣积分——不能收完钱才发现记不进任何作品
        const projectId = body.projectId ? String(body.projectId) : ''
        // 作品的第几版：评审落库时按当前版本记账，多版本对照才不会串
        let projectVersion = 0
        if (projectId) {
          const scopedProject = await getProject(projectId, user)
          if (!scopedProject) {
            sendJson(res, 404, { error: '这次评审要记入的作品不见了，评审没有开始，也未扣积分', code: 'PROJECT_NOT_FOUND' })
            return true
          }
          projectVersion = scopedProject.version
        }
        // 已知模型服务不可用（额度 / 凭证）：直接说明，不先扣再退
        const provider = modelServiceState()
        if (!provider.available) {
          sendJson(res, 503, {
            error: provider.message,
            code: 'MODEL_UNAVAILABLE',
            retryAfterSec: provider.retryAfterSec,
            ...(config.ui.mode === 'internal' ? { detail: provider.internalDetail, upstream: provider.upstreamMessage } : {}),
          })
          return true
        }
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
          // 插件服务出结论时没有用到平台模型，不清除模型侧状态
          if (result.mode === 'local-model') noteModelSuccess()
          const source = body.media
            ? { kind: 'template', label: body.label || body.intent || '', media: body.media }
            : { kind: body.imageUrl ? 'url' : 'unknown', label: body.label || body.intent || '', imageUrl: body.imageUrl || '' }
          const saved = await saveReview({
            user,
            source,
            intent: body.intent ? String(body.intent).slice(0, 300) : '',
            result,
            credits: { cost: paid.cost, balance: paid.balance },
            projectId,
            version: projectVersion,
          })
          sendJson(res, 200, { ...result, reviewId: saved.id, credits: { cost: paid.cost, balance: paid.balance } })
        } catch (error) {
          noteModelFailure(error)
          if (user?.id && paid.cost > 0) refund(user.id, 'review', { amount: paid.cost, ref: '评审失败退款' })
          console.error('[review] ' + (error?.stack || error?.message || error))
          sendJson(res, 500, { error: publicError(error, '评审服务暂时不可用，积分已退回') })
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
