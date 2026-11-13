// /api/feedback：应用内反馈提交与「我的反馈」。
// 提交不要求登录：登录进不来本身是最常见的求助场景；匿名时联系方式变成必填。
// 读自己的反馈要求登录，只回本账号的条目（管理员回复也在这里看到）。
import { sendJson, readBody } from './_shared.mjs'
import { currentUser, clientIp } from '../auth.mjs'
import { createFeedback, listMyFeedback } from '../feedback.mjs'
import { logEvent } from '../log.mjs'

const MAX_BODY_BYTES = 16 * 1024

export function createFeedbackRouter() {
  return {
    prefix: '/api/feedback',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/feedback')) return false

      if (pathname === '/api/feedback' && req.method === 'POST') {
        const declared = Number(req.headers?.['content-length']) || 0
        if (declared > MAX_BODY_BYTES) {
          sendJson(res, 413, { error: '反馈内容过大' })
          return true
        }
        const body = await readBody(req)
        const user = currentUser(req)
        const result = await createFeedback({
          kind: String(body.kind || 'other'),
          body: String(body.body || ''),
          contact: String(body.contact || ''),
          page: String(body.page || ''),
          user,
          ip: clientIp(req),
          ua: String(req.headers?.['user-agent'] || ''),
        })
        if (!result.ok) {
          if (result.code === 'BODY_TOO_SHORT') return (sendJson(res, 400, { error: '请至少写 5 个字，说清遇到什么问题或想要什么', field: 'body' }), true)
          if (result.code === 'CONTACT_REQUIRED') return (sendJson(res, 400, { error: '匿名提交需要留一个能联系到你的方式', field: 'contact' }), true)
          return (sendJson(res, 400, { error: '反馈没有保存' }), true)
        }
        logEvent('feedback-create', {
          kind: result.item.kind,
          id: result.item.id,
          anonymous: user ? 'no' : 'yes',
          duplicate: result.duplicate,
        })
        sendJson(res, 201, { ok: true, id: result.item.id, duplicate: result.duplicate, status: result.item.status })
        return true
      }

      if (pathname === '/api/feedback/mine' && req.method === 'GET') {
        const user = currentUser(req)
        if (!user) return (sendJson(res, 401, { error: '未登录', loginRequired: true }), true)
        const items = (await listMyFeedback(user.id, Number(url.searchParams.get('limit')) || 10)).map((item) => ({
          id: item.id,
          kind: item.kind,
          body: item.body,
          page: item.page,
          status: item.status,
          reply: item.reply,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          resolvedAt: item.resolvedAt,
        }))
        sendJson(res, 200, { ok: true, items })
        return true
      }

      sendJson(res, 404, { error: '未知的反馈接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}
