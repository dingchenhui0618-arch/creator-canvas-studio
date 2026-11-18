// 作品流（r213）：GET /api/works —— 快捷创作 / 工作流 / 无限画布合成一条。
import { sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { listWorks } from '../works-feed.mjs'

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
      return false
    },
  }
}
