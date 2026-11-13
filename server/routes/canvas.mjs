// /api/canvas：给画布 iframe 发一张短时信任票据（画布拿它换自己的会话）。
// 票据只回答「现在是谁」，不带积分与业务权限；没开互通时返回 503，前端据此继续用画布原生登录。
import { sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { canvasTrustEnabled, mintCanvasTicket } from '../canvas-session.mjs'
import { canvasQueueView } from '../waterline.mjs'

export function createCanvasRouter() {
  return {
    prefix: '/api/canvas',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/canvas')) return false
      const user = currentUser(req)
      if (!user) {
        sendJson(res, 401, { error: '未登录', loginRequired: true })
        return true
      }

      if (pathname === '/api/canvas/session-token' && req.method === 'GET') {
        if (!canvasTrustEnabled()) {
          sendJson(res, 503, { error: '画布账号互通还没开启', code: 'CANVAS_TRUST_DISABLED' })
          return true
        }
        try {
          const ticket = mintCanvasTicket(user)
          sendJson(res, 200, {
            ok: true,
            token: ticket.token,
            expiresAt: ticket.expiresAt,
            issuer: ticket.issuer,
            audience: ticket.audience,
          })
        } catch (error) {
          sendJson(res, error?.status || 500, { error: error?.message || '票据签发失败', code: error?.code })
        }
        return true
      }

      // 画布出图的排队位（v0.9.83）：画布页的状态条轮询它，只读、不扣积分、不调上游。
      // 只回聚合数（在跑几条、在等几条、最久的等了多久），票号不进这条响应。
      if (pathname === '/api/canvas/queue' && req.method === 'GET') {
        sendJson(res, 200, canvasQueueView())
        return true
      }

      sendJson(res, 404, { error: '未知的画布接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}
