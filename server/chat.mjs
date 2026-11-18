// 快捷创作对话（r214）：一页 DeepSeek —— 长上下文、联网搜索、读链接、思考模式。
//
// 为什么要单独一条链路：以前的「对话」是对话预设的短轮问答（每次带预设、输出类型、结构化草稿），
// 用户说那本质上是伪智能体。这里换成平台对话模型的直接多轮：
//  - 会话在服务端存，关页面、换设备回来还在；
//  - 上下文取最近 30 条（单条最长 8000 字），不是只带上一句；
//  - 联网搜索 / 读链接是官方服务端工具，思考模式开到官方 thinking；
//  - 先扣费后调用，失败或空回复全额退回；没登录不扣费（本地演示）。
//
// 还没做的（写在 docs/quick-create-deepseek-2026-11-18.md）：文件解析、OCR、语音、图片理解进对话、
// 流式输出。它们要动的是上传与 SSE，不是这条链路的取舍，别在这里假装已经有了。
import { callTextModel } from './llm.mjs'
import { charge, priceOf, refund } from './credits.mjs'
import { contextMessages, createConversation, getConversation, saveConversation, titleFrom } from './chat-store.mjs'

const MAX_INPUT = 8000
const CONTEXT_MESSAGES = 30
const MAX_OUTPUT_TOKENS = 4096

const SYSTEM_PROMPT = [
  '你是平台里的创作助手，回答一律用简体中文。',
  '你的用户在做短视频与图文内容：找选题、拆结构、写脚本、出分镜、写提示词、复盘数据。',
  '说话要具体、能直接照着做；不要寒暄，不要复述用户的问题，不要编造数据与来源。',
  '需要最新信息或具体链接时，先联网搜索或读取用户给的链接，再给结论；引用时把链接原样写出来。',
  '不确定就说不确定，并说明还需要什么信息。',
].join('\n')

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

export function chatOptionsFrom(input = {}) {
  const tools = input && typeof input.tools === 'object' && input.tools ? input.tools : {}
  return { search: Boolean(tools.search), readUrl: Boolean(tools.readUrl), thinking: Boolean(tools.thinking) }
}

/** 官方服务端工具：开关打开才带，关掉就是一次普通对话（不搜索、不抓链接）。 */
export function officialTools(options = {}) {
  const tools = []
  if (options.search) tools.push({ type: 'deepseek_web_search' })
  if (options.readUrl) tools.push({ type: 'deepseek_read_url' })
  return tools
}

function messageId(prefix = 'm') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

export async function sendChatMessage(user, input = {}) {
  const content = String(input?.content || '').trim()
  if (!content) throw fail(400, 'CHAT_EMPTY', '说点什么再发送')
  if (content.length > MAX_INPUT) throw fail(400, 'CHAT_TOO_LONG', '一次最多 ' + MAX_INPUT + ' 字，长文请分几条发')
  if (!user?.id) throw fail(401, 'LOGIN_REQUIRED', '请先登录')

  const options = chatOptionsFrom(input)
  let conv = input.conversationId ? getConversation(user.id, input.conversationId) : null
  if (input.conversationId && !conv) throw fail(404, 'CHAT_NOT_FOUND', '这条对话已经不在了')
  if (!conv) conv = createConversation(user.id, { title: titleFrom(content) })

  const price = priceOf('chat')
  const paid = charge(user.id, 'chat', {
    ref: '对话 · ' + conv.title,
    amount: price,
    meta: { conversationId: conv.id, search: options.search, readUrl: options.readUrl, thinking: options.thinking },
  })
  if (!paid.ok) {
    const error = fail(402, paid.code || 'CREDIT_INSUFFICIENT', paid.message || '余额不够发起这次对话')
    error.balance = paid.balance
    error.needed = paid.needed
    throw error
  }

  const startedAt = Date.now()
  conv.messages.push({ id: messageId('u'), role: 'user', content, at: startedAt })
  conv = saveConversation(user.id, conv) || conv

  const extra = {}
  const tools = officialTools(options)
  if (tools.length) extra.tools = tools
  if (options.thinking) extra.thinking = { type: 'enabled' }

  try {
    const result = await callTextModel(
      [{ role: 'system', content: SYSTEM_PROMPT }, ...contextMessages(conv.messages)],
      {
        temperature: 0.6,
        maxTokens: MAX_OUTPUT_TOKENS,
        extra: Object.keys(extra).length ? extra : null,
        meter: { kind: 'text', ref: conv.id },
      },
    )
    const reply = String(result.text || '').trim()
    if (!reply) throw fail(502, 'CHAT_EMPTY_REPLY', '模型没有返回内容，这次不计费')
    conv.messages.push({
      id: messageId('a'),
      role: 'assistant',
      content: reply,
      at: Date.now(),
      model: result.model,
      ms: Date.now() - startedAt,
      meta: {
        tools: tools.map((item) => item.type),
        thinking: options.thinking,
        finishReason: result.finishReason || '',
        usage: result.usage || null,
      },
    })
    const saved = saveConversation(user.id, conv)
    return { conversation: saved, reply: saved.messages[saved.messages.length - 1], model: result.model, cost: paid.cost, balance: paid.balance }
  } catch (error) {
    if (paid.cost > 0) {
      try { refund(user.id, 'chat', { ref: '对话 · ' + conv.title, amount: paid.cost, meta: { conversationId: conv.id, failed: true } }) } catch { /* 退款失败不掩盖原错误 */ }
    }
    const wrapped = fail(error?.status || 502, error?.code || 'CHAT_UPSTREAM', '这次没有回上来，积分已退回：' + String(error?.message || error))
    wrapped.detail = String(error?.stack || error).slice(0, 400)
    throw wrapped
  }
}

export { MAX_INPUT, CONTEXT_MESSAGES }
