import { sendJson, readBody } from './_shared.mjs'
import { reviewVisual, reviewStatus } from '../review.mjs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.mjs'

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
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, 500, { error: String(error?.message || error) })
        }
        return true
      }
      sendJson(res, 404, { error: 'review route not found' })
      return true
    },
  }
}
