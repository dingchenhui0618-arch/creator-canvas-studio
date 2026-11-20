// 作品流（r213）：GET /api/works —— 快捷创作 / 工作流 / 无限画布合成一条。
import { sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { listWorks } from '../works-feed.mjs'
import { loadCanvasNodes } from '../bdc.mjs'
import { canvasOwnerId, isCanvasAdmin } from '../canvas-owner.mjs'
import { Readable } from 'node:stream'

export function createWorksRouter() {
  return {
    prefix: '/api/works',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/works')) return false
      if (pathname === '/api/works' && req.method === 'GET') {
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { ok: false, code: 'LOGIN_REQUIRED', error: '请先登录' })
          return true
        }
        const result = await listWorks(user, {
          kind: url.searchParams.get('kind') || 'all',
          limit: url.searchParams.get('limit') || undefined,
          before: url.searchParams.get('before') || '',
          // 搜作品（r281）：只在这批扫进内存的条目里过滤，不打上游、不扣积分
          q: url.searchParams.get('q') || '',
        })
        if (result.error === 'WORKS_KIND') {
          sendJson(res, 400, { ok: false, code: 'WORKS_KIND', error: '不认识的筛选条件' })
          return true
        }
        if (result.error === 'WORKS_CURSOR') {
          sendJson(res, 400, { ok: false, code: 'WORKS_CURSOR', error: '翻页位置不对，请刷新后重试' })
          return true
        }
        sendJson(res, 200, { ok: true, ...result })
        return true
      }
      // 画布里出过的图 / 视频：代画布的 6677 转发，避免前端直连画布域名（有 Basic Auth，还要跨站 cookie）。
      // 先验归属：不是自己的画布不给流量；路径只认画布自己的 /api/workspace/，不代理任意地址。
      if (pathname === '/api/works/canvas-file' && req.method === 'GET') {
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { ok: false, code: 'LOGIN_REQUIRED', error: '请先登录' })
          return true
        }
        const canvas = String(url.searchParams.get('canvas') || '')
        const nodeId = String(url.searchParams.get('node') || '')
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(canvas) || !nodeId) {
          sendJson(res, 400, { ok: false, code: 'WORKS_CANVAS_ID', error: '画布或节点不合法' })
          return true
        }
        if (!isCanvasAdmin(user) && canvasOwnerId(canvas) !== String(user.id)) {
          sendJson(res, 403, { ok: false, code: 'WORKS_CANVAS_FORBIDDEN', error: '这块画布不属于当前账号' })
          return true
        }
        let loaded
        try {
          loaded = await loadCanvasNodes(canvas)
        } catch {
          sendJson(res, 404, { ok: false, code: 'WORKS_CANVAS_MISSING', error: '画布读不到，可能已被删除' })
          return true
        }
        const node = loaded.nodes.find((item) => String(item?.id || '') === nodeId)
        const target = String(node?.output || '')
        if (!node || !target.startsWith('/api/workspace/') || target.includes('..')) {
          sendJson(res, 404, { ok: false, code: 'WORKS_CANVAS_FILE', error: '这条产物不在画布里' })
          return true
        }
        const headers = {}
        const range = String(req.headers.range || '')
        if (range) headers.Range = range
        let upstream
        try {
          upstream = await fetch((process.env.BDC_FILE_URL || 'http://127.0.0.1:6677') + target, { headers })
        } catch {
          sendJson(res, 502, { ok: false, code: 'WORKS_CANVAS_DOWN', error: '无限画布服务没有连上，稍后刷新' })
          return true
        }
        if (!upstream.ok || !upstream.body) {
          sendJson(res, upstream.status === 404 ? 404 : 502, { ok: false, code: 'WORKS_CANVAS_DOWN', error: '画布没有返回这个文件' })
          return true
        }
        res.statusCode = upstream.status
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream')
        for (const name of ['content-length', 'content-range', 'accept-ranges']) {
          const value = upstream.headers.get(name)
          if (value) res.setHeader(name, value)
        }
        res.setHeader('Cache-Control', 'private, max-age=3600')
        Readable.fromWeb(upstream.body).pipe(res)
        return true
      }
      return false
    },
  }
}
