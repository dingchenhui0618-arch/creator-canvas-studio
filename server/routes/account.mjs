// /api/account/*：账号自助——导出自己的数据、注销账号。
// 两个动作都只作用于「当前登录的这个人」，不需要管理员。
import { readBody, sendJson } from './_shared.mjs'
import { clearCookie, currentUser, verifyPassword } from '../auth.mjs'
import { deleteOwnAccount, exportAccount, exportFileName } from '../account.mjs'
import { logEvent } from '../log.mjs'

export function createAccountRouter() {
  return {
    prefix: '/api/account',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/account')) return false
      const user = currentUser(req)
      if (!user) {
        sendJson(res, 401, { error: '请先登录', loginRequired: true })
        return true
      }

      // 导出：直接给一个 JSON 附件，浏览器落盘；内容只含这个账号自己的数据
      if (pathname === '/api/account/export' && req.method === 'GET') {
        const data = await exportAccount(user)
        const body = JSON.stringify(data, null, 2)
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + exportFileName(user) + '"',
          'Cache-Control': 'no-store',
        })
        res.end(body)
        logEvent('account-export', {
          by: user.email,
          templates: data.templates.length,
          flows: data.flows.length,
          agents: data.agents.length,
          reviews: data.reviews.length,
          bytes: Buffer.byteLength(body),
        })
        return true
      }

      // 注销：口令 + 手输「注销」两个字；可选连内容一起删
      if (pathname === '/api/account/delete' && req.method === 'POST') {
        const body = await readBody(req)
        if (String(body.confirm || '').trim() !== '注销') {
          return (sendJson(res, 400, { error: '请输入「注销」两个字确认', field: 'confirm' }), true)
        }
        if (!verifyPassword(String(body.password || ''), user.password_hash)) {
          return (sendJson(res, 400, { error: '口令不正确', field: 'password' }), true)
        }
        const result = await deleteOwnAccount(user, { deleteContent: body.deleteContent !== false })
        if (!result.ok) {
          if (result.code === 'LAST_ADMIN') {
            return (sendJson(res, 400, {
              error: '这是最后一个管理员账号：先把另一个账号设为管理员，再注销自己',
              code: 'LAST_ADMIN',
            }), true)
          }
          return (sendJson(res, 404, { error: '账号不存在' }), true)
        }
        res.setHeader('Set-Cookie', clearCookie())
        logEvent('account-delete', { by: user.email, deleteContent: result.deleteContent, ...result.removed })
        sendJson(res, 200, { ok: true, removed: result.removed, deleteContent: result.deleteContent })
        return true
      }

      sendJson(res, 404, { error: '未知的账号接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}
