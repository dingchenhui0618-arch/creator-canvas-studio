// 自己传一张图：POST /api/media/upload（原始字节，不是 JSON、也不是 multipart）。
//
// 为什么是原始字节：客户端只有一张图，multipart 要在服务端再解析一遍边界与头部，
// 解析器本身就是一块内存和一片攻击面；body 直接就是文件内容，读出来落盘即可。
//
// 读回来：GET /media/uploads/<账号 id>/<文件名>，必须登录且只能读自己的（管理员可读所有人的）。
// 这条与 /media/frames 的差别写在 docs/review-upload-*.md 里：模板帧是「作品的素材」，
// 上传图是「你传给我的东西」，默认只给传的人看，不进分享页、不进交付包。
import { sendJson } from './_shared.mjs'
import { sendAuthImage } from '../image-response.mjs'
import { readBinaryBody } from '../body-reader.mjs'
import { currentUser, isAdmin } from '../auth.mjs'
import { refusalResponse } from '../public-error.mjs'
import { logEvent } from '../log.mjs'
import { UPLOAD_LIMITS, listUploads, resolveUpload, saveUpload, uploadUsage } from '../uploads.mjs'

const UPLOAD_PATH = /^\/media\/uploads\/([A-Za-z0-9_-]{3,64})\/([^/]+)$/

function sendRefusal(res, error) {
  const mapped = refusalResponse(error)
  if (!mapped) return false
  sendJson(res, mapped.status, mapped.body)
  return true
}

export function createMediaRouter() {
  return {
    prefix: '/api/media',
    extraPrefixes: ['/media/uploads'],
    async handle(req, res, url, pathname) {
      // 上传：登录门在 index.mjs 里已经挡过一次（/api/* 都要登录）；这里再判一次，
      // 因为这条路由也会被单测直接调用，行为不该依赖外面那一层。
      if (pathname === '/api/media/upload') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          sendJson(res, 405, { error: '只支持 POST' })
          return true
        }
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        try {
          // 上限显式写在这里：单张图与评审入口同一个 8 MB
          const buffer = await readBinaryBody(req, { maxBytes: UPLOAD_LIMITS.maxBytes })
          const saved = await saveUpload({ userId: user.id, buffer })
          logEvent('media.upload', { by: user.email, bytes: saved.bytes })
          sendJson(res, 200, { ok: true, ...saved })
          return true
        } catch (error) {
          if (sendRefusal(res, error)) return true
          throw error
        }
      }

      // 我最近传的几张：页面刷新后还能拿回刚传的那张，不用重传
      if (pathname === '/api/media/uploads' && req.method === 'GET') {
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        const limit = Number(url.searchParams.get('limit') || 8)
        sendJson(res, 200, { ok: true, items: await listUploads(user.id, limit), usage: await uploadUsage(user.id) })
        return true
      }

      const match = pathname.match(UPLOAD_PATH)
      if (match) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          sendJson(res, 405, { error: '只支持 GET' })
          return true
        }
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        const [, ownerId, fileName] = match
        // 归属：自己的图自己看；管理员排障时能看所有人的。别人一律 404——
        // 「这条路径存不存在」本身也不该告诉别人。
        if (ownerId !== user.id && !isAdmin(user)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return true
        }
        const target = resolveUpload(ownerId, fileName)
        if (!target) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return true
        }
        // 私有 + 必须重验（v0.9.89）：以前给 max-age=300，退出登录后这五分钟里
        // 浏览器不会回源，画面就还留在屏幕上；现在每次用之前都回源，没变回 304
        if (!(await sendAuthImage(req, res, target.file, target.mime))) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end('not found')
        }
        return true
      }

      return false
    },
  }
}
