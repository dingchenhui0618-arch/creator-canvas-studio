// 快捷创作对话（r214）：会话 CRUD + 一次发送。契约见 docs/quick-create-deepseek-2026-11-18.md。
import { readBody, sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { createConversation, deleteConversation, getConversation, listConversations } from '../chat-store.mjs'
import { sendChatMessage } from '../chat.mjs'

const CONV = /^\/api\/chat\/conversations\/([A-Za-z0-9_-]{6,40})(\/messages)?$/

export function createChatRouter() {
  return {
    prefix: '/api/chat',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/chat')) return false
      const user = currentUser(req)
      if (!user) {
        sendJson(res, 401, { ok: false, code: 'LOGIN_REQUIRED', error: '请先登录' })
        return true
      }

      if (pathname === '/api/chat/conversations' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, items: listConversations(user.id) })
        return true
      }

      if (pathname === '/api/chat/conversations' && req.method === 'POST') {
        const conv = createConversation(user.id, {})
        sendJson(res, 200, { ok: true, conversation: conv })
        return true
      }

      const matched = pathname.match(CONV)
      if (!matched) {
        sendJson(res, 404, { ok: false, code: 'CHAT_ROUTE', error: '未知的对话接口：' + req.method + ' ' + pathname })
        return true
      }
      const id = matched[1]
      const isMessages = Boolean(matched[2])

      if (!isMessages && req.method === 'GET') {
        const conv = getConversation(user.id, id)
        if (!conv) {
          sendJson(res, 404, { ok: false, code: 'CHAT_NOT_FOUND', error: '这条对话已经不在了' })
          return true
        }
        sendJson(res, 200, { ok: true, conversation: conv })
        return true
      }

      if (!isMessages && req.method === 'DELETE') {
        const removed = deleteConversation(user.id, id)
        sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, code: 'CHAT_NOT_FOUND', error: '这条对话已经不在了' })
        return true
      }

      if (isMessages && req.method === 'POST') {
        const body = await readBody(req)
        try {
          const result = await sendChatMessage(user, { ...body, conversationId: id })
          sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          sendJson(res, error?.status || 502, {
            ok: false,
            code: error?.code || 'CHAT_UPSTREAM',
            error: error?.message || '这次没有回上来',
            ...(error?.detail ? { detail: error.detail } : {}),
            ...(error?.balance != null ? { balance: error.balance } : {}),
            ...(error?.needed != null ? { needed: error.needed } : {}),
          })
        }
        return true
      }

      sendJson(res, 405, { ok: false, code: 'CHAT_METHOD', error: '这个接口不支持 ' + req.method })
      return true
    },
  }
}
