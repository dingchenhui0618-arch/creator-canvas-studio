// 快捷创作对话（r214 建立，r217 加流式）：一页 DeepSeek —— 长上下文、联网搜索、读链接、思考模式。
//
// 为什么要单独一条链路：以前的「对话」是对话预设的短轮问答（每次带预设、输出类型、结构化草稿），
// 用户说那本质上是伪智能体。这里换成平台对话模型的直接多轮：
//  - 会话在服务端存，关页面、换设备回来还在；
//  - 上下文取最近 30 条（单条最长 8000 字），不是只带上一句；
//  - 联网搜索 / 读链接是官方服务端工具，思考模式开到官方 thinking；
//  - 先扣费后调用，失败、空回复、用户按停止都全额退回；没登录不扣费（本地演示）。
//
// r217 补上流式：`sendChatMessage`（一次性）与 `streamChatMessage`（逐字）共用同一套
// 「扣费 → 落用户这句 → 调模型 → 落回答 / 退款」的流程，只是取结果的方式不同。
// 两条链路的行为必须一致，所以下面把前半段（beginChat）和收尾（finishChat / failChat）抽出来，
// 不各写一份——以前每加一条链路就要把退款口径再抄一遍，抄漏一次就是真金白银的差评。
//
// r218 接上附件：脚本/文档/表格/PDF 先在服务端读成文字，再连同问题一起问模型（server/chat-files.mjs）。
// 附件是「这一轮的上下文」，不是文件托管：原文落盘 20 份轮转，抽出的文字跟着这条消息进上下文。
// 还没做的：OCR（扫描件里的字）、图片理解进对话、语音、联网搜索的真实上游验证。
import { callTextModel, callTextModelStream } from './llm.mjs'
import { charge, priceOf, refund } from './credits.mjs'
import { contextMessages, createConversation, getConversation, saveConversation, titleFrom } from './chat-store.mjs'
import { CHAT_FILE_LIMITS, resolveChatFiles } from './chat-files.mjs'

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

/** 这一轮带哪几个附件：先按归属读，读不到就跳过（别人的 / 已删除），不让整次对话失败。 */
function readAttachments(userId, input = {}) {
  const raw = Array.isArray(input?.files) ? input.files.map(String).filter(Boolean) : []
  if (!raw.length) return { files: [], text: '', skipped: 0, chars: 0 }
  if (raw.length > CHAT_FILE_LIMITS.maxPerMessage) {
    throw fail(400, 'CHAT_FILES', '一条消息最多带 ' + CHAT_FILE_LIMITS.maxPerMessage + ' 个附件')
  }
  return resolveChatFiles(userId, raw)
}

function messageId(prefix = 'm') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** 扣费 + 落用户这句话，两条链路共用。 */
function beginChat(user, input = {}) {
  const content = String(input?.content || '').trim()
  if (!content) throw fail(400, 'CHAT_EMPTY', '说点什么再发送')
  if (content.length > MAX_INPUT) throw fail(400, 'CHAT_TOO_LONG', '一次最多 ' + MAX_INPUT + ' 字，长文请分几条发')
  if (!user?.id) throw fail(401, 'LOGIN_REQUIRED', '请先登录')

  // 附件先解析再扣费：附件读不出来（扫描件、超过 5 个）时一分钱都不该扣
  const attachments = readAttachments(user.id, input)
  const options = chatOptionsFrom(input)
  let conv = input.conversationId ? getConversation(user.id, input.conversationId) : null
  if (input.conversationId && !conv) throw fail(404, 'CHAT_NOT_FOUND', '这条对话已经不在了')
  if (!conv) conv = createConversation(user.id, { title: titleFrom(content) })

  const paid = charge(user.id, 'chat', {
    ref: '对话 · ' + conv.title,
    amount: priceOf('chat'),
    meta: { conversationId: conv.id, search: options.search, readUrl: options.readUrl, thinking: options.thinking },
  })
  if (!paid.ok) {
    const error = fail(402, paid.code || 'CREDIT_INSUFFICIENT', paid.message || '余额不够发起这次对话')
    error.balance = paid.balance
    error.needed = paid.needed
    throw error
  }

  const startedAt = Date.now()
  // 界面会先建一条空会话再发第一句（这样才能「一边建一边打字」），于是标题一直停在「新对话」。
  // 第一句进来时用它的开头当标题：这是左侧列表唯一能认出来的信息（r217 实测：以前十条全是「新对话」）。
  if (!conv.messages.some((item) => item.role === 'user')) conv.title = titleFrom(content)
  // 附件抽出来的文字跟这条消息一起存：下一轮还能用上（长对话里最早的那几轮会被上下文窗口挤掉，
  // 挤掉就只剩文件名，界面与文档都这么说，不假装还记着）。
  conv.messages.push({
    id: messageId('u'),
    role: 'user',
    content,
    at: startedAt,
    files: attachments.files,
    docText: attachments.text,
  })
  conv = saveConversation(user.id, conv) || conv

  const tools = officialTools(options)
  const extra = {}
  if (tools.length) extra.tools = tools
  if (options.thinking) extra.thinking = { type: 'enabled' }

  return {
    conv,
    options,
    tools,
    extra,
    paid,
    startedAt,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...contextMessages(conv.messages)],
    attachments,
  }
}

/** 落回答 + 返回给前端；正文为空算这次没成，交给 failChat 退款。 */
function finishChat(user, ctx, result) {
  const reply = String(result?.text ?? result?.message?.content ?? '').trim()
  if (!reply) throw fail(502, 'CHAT_EMPTY_REPLY', '模型没有返回内容，这次不计费')
  const truncated = result?.finishReason === 'length'
  ctx.conv.messages.push({
    id: messageId('a'),
    role: 'assistant',
    content: reply,
    at: Date.now(),
    model: result?.model,
    ms: Date.now() - ctx.startedAt,
    meta: {
      tools: ctx.tools.map((item) => item.type),
      files: ctx.attachments.files.map((item) => item.name),
      thinking: ctx.options.thinking,
      finishReason: result?.finishReason || '',
      usage: result?.usage || null,
      streamed: Boolean(result?.streamed),
      truncated,
    },
  })
  const saved = saveConversation(user.id, ctx.conv)
  return {
    conversation: saved,
    reply: saved.messages[saved.messages.length - 1],
    model: result?.model,
    cost: ctx.paid.cost,
    balance: ctx.paid.balance,
    truncated,
  }
}

/** 退款 + 包口径：停止与失败都走这里，钱只退一次。 */
function failChat(user, ctx, error) {
  if (ctx.paid.cost > 0) {
    try {
      refund(user.id, 'chat', { ref: '对话 · ' + ctx.conv.title, amount: ctx.paid.cost, meta: { conversationId: ctx.conv.id, failed: true } })
    } catch {
      /* 退款失败不掩盖原错误 */
    }
  }
  const stopped = Boolean(error?.aborted) || error?.name === 'AbortError'
  const wrapped = fail(
    stopped ? 499 : error?.status || 502,
    stopped ? 'CHAT_ABORTED' : error?.code || 'CHAT_UPSTREAM',
    stopped ? '已停止生成，这次不计费（积分已退回）' : '这次没有回上来，积分已退回：' + String(error?.message || error),
  )
  wrapped.detail = String(error?.stack || error).slice(0, 400)
  wrapped.stopped = stopped
  return wrapped
}

export async function sendChatMessage(user, input = {}) {
  const ctx = beginChat(user, input)
  try {
    const result = await callTextModel(ctx.messages, {
      temperature: 0.6,
      maxTokens: MAX_OUTPUT_TOKENS,
      extra: Object.keys(ctx.extra).length ? ctx.extra : null,
      meter: { kind: 'text', ref: ctx.conv.id },
    })
    return finishChat(user, ctx, result)
  } catch (error) {
    throw failChat(user, ctx, error)
  }
}

/**
 * 流式回答（r217）。hooks.onDelta(text) 每拿到一段正文就调一次；hooks.signal 是「停止」通道。
 * 停止：不落半截回答（用户看到的是自己按了停），积分全额退回；
 * 上游不认流式：退回一次性回答，拿到整段后一次性推给界面，用户不会因为网关差异拿不到答案。
 */
export async function streamChatMessage(user, input = {}, hooks = {}) {
  const ctx = beginChat(user, input)
  try {
    let result = null
    let fellBack = false
    try {
      result = await callTextModelStream(ctx.messages, {
        temperature: 0.6,
        maxTokens: MAX_OUTPUT_TOKENS,
        extra: Object.keys(ctx.extra).length ? ctx.extra : null,
        meter: { kind: 'text', ref: ctx.conv.id },
        signal: hooks.signal,
        onDelta: hooks.onDelta,
      })
    } catch (error) {
      if (error?.code !== 'STREAM_UNSUPPORTED') throw error
      fellBack = true
      result = await callTextModel(ctx.messages, {
        temperature: 0.6,
        maxTokens: MAX_OUTPUT_TOKENS,
        extra: Object.keys(ctx.extra).length ? ctx.extra : null,
        meter: { kind: 'text', ref: ctx.conv.id },
      })
      // 降级路径没有增量：拿到整段后一次性推给界面，用户看到的仍然是「有回答」，不是空白等到底
      const whole = String(result?.text || '').trim()
      if (whole) hooks.onDelta?.(whole)
    }
    const answer = finishChat(user, ctx, result)
    return { ...answer, fellBack }
  } catch (error) {
    throw failChat(user, ctx, error)
  }
}

export { MAX_INPUT, CONTEXT_MESSAGES }
