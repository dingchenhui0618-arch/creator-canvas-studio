// 快捷创作对话（DeepSeek 全家桶）：会话、流式回复、文件解析（r213）。
// 契约见 docs/quick-create-deepseek-2026-11-18.md。
import { sendJson } from './_shared.mjs'

export function createChatRouter() {
  return {
    prefix: '/api/chat',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/chat')) return false
      sendJson(res, 404, { ok: false, code: 'CHAT_NOT_READY', error: '对话接口还在装配' })
      return true
    },
  }
}
