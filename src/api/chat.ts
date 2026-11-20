// 快捷创作对话（r214）：会话与消息都在服务端，关页面回来还在。
import { request, safeFetch } from './client'

export type ChatToolOptions = { search: boolean; readUrl: boolean; thinking: boolean }

// 这一轮搜了什么（r246）：界面只列来源（标题 + 站点 + 地址），摘要与网页正文在服务端上下文里。
export type ChatSearch = {
  ok: boolean
  query: string
  provider: string
  providerLabel: string
  note: string
  results: { title: string; url: string; site: string }[]
}

// 搜索服务通没通：界面据此决定「联网搜索」开关能不能点。
export type ChatSearchStatus = { configured: boolean; providerLabel: string; note: string }

// 这一轮是「直接生成」（r288）：会话里只留任务号与规格，进度与结果按任务号轮询
// /api/media/tasks/:id（只读元数据、不打上游、不扣积分），所以改一次状态不用重写聊天记录。
export type ChatMediaInfo = {
  id: string
  kind: 'image' | 'video'
  status: 'processing' | 'succeeded' | 'failed'
  model: string
  mode?: string
  ratio: string
  size: string
  duration: number | null
  resolution: string
  prompt: string
  // 失败时说清是哪一步没成：卡片在「已失败」状态下不轮询，原因只能从这里带出来
  error?: string
  downloadUrl: string
  credits: { cost: number; balance: number | null; refunded: boolean }
}

// 这一轮读到的链接（r219）：只留地址、标题、字数与失败原因；页面文字在服务端，不进聊天记录。
export type ChatLink = {
  url: string
  finalUrl: string
  title: string
  ok: boolean
  chars: number
  truncated: boolean
  note: string
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  at: number
  model?: string
  ms?: number
  meta?:
    | { tools?: string[]; thinking?: boolean; finishReason?: string; usage?: unknown; files?: string[]; streamed?: boolean; media?: ChatMediaInfo }
    | null
  // 这一轮带的附件（只留名字、字数与来源）：原文在服务端，聊天记录里不重复存
  files?: ChatFile[]
  links?: ChatLink[]
  search?: ChatSearch
}

export type ChatConversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  // 会话列表满了（最多 30 条）时，新建会话会腾掉最早的一条：这里告诉界面挪的是哪一条（r247）
  retired?: { id: string; title: string }
  // 一条会话最多留 200 条消息：dropped 是累计被挤掉的条数（刷新后仍然知道少了多少），
  // trimmedNow 只在刚刚这一轮挤掉消息时出现，用来提醒一次（r248）
  dropped?: number
  trimmedNow?: number
}

export type ChatSummary = {
  id: string
  title: string
  preview: string
  messageCount: number
  createdAt: number
  updatedAt: number
}

export const listChatConversations = () =>
  request<{ ok: boolean; items: ChatSummary[] }>('/api/chat/conversations')

export const createChatConversation = () =>
  request<{ ok: boolean; conversation: ChatConversation }>('/api/chat/conversations', { method: 'POST' })

export const getChatConversation = (id: string) =>
  request<{ ok: boolean; conversation: ChatConversation }>('/api/chat/conversations/' + id)

export const deleteChatConversation = (id: string) =>
  request<{ ok: boolean }>('/api/chat/conversations/' + id, { method: 'DELETE' })

export const sendChatMessage = (id: string, body: { content: string; tools?: Partial<ChatToolOptions>; files?: string[] }) =>
  request<{ ok: boolean; conversation: ChatConversation; reply: ChatMessage; model: string; cost: number; balance: number | null }>(
    '/api/chat/conversations/' + id + '/messages',
    { method: 'POST', body: JSON.stringify(body) },
  )

export type ChatStreamResult = {
  conversation: ChatConversation
  reply: ChatMessage
  model: string
  cost: number
  balance: number | null
  truncated?: boolean
  fellBack?: boolean
  // 生成指令这一轮：任务已经建好，界面按 media.id 轮询结果（r288）
  media?: ChatMediaInfo
}

export type ChatStreamFailure = { code?: string; error?: string; balance?: number; stopped?: boolean }

function parseSseEvent(raw: string): { event: string; data: unknown } | null {
  let event = 'message'
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  if (!data.length) return null
  try {
    return { event, data: JSON.parse(data.join('\n')) }
  } catch {
    return null
  }
}

/**
 * 流式发送（r217）：逐段回调 onDelta，最后的 done 事件带回整条会话与余额。
 * 「停止」= abort 传进来的 signal：浏览器断开连接，服务端立刻中止上游并全额退款，
 * 所以停止之后不要自己再拼接半截回答，以 done / 重新拉取的会话为准。
 */
export async function streamChatMessage(
  id: string,
  body: { content: string; tools?: Partial<ChatToolOptions>; files?: string[] },
  handlers: { onDelta?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<ChatStreamResult> {
  const response = await safeFetch('/api/chat/conversations/' + id + '/messages/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: handlers.signal,
  })
  if (!response.ok || !response.body) {
    const raw = await response.text().catch(() => '')
    let payload: (Record<string, unknown> & { error?: string }) | null = null
    try {
      payload = raw ? (JSON.parse(raw) as Record<string, unknown> & { error?: string }) : null
    } catch {
      payload = null
    }
    const message = typeof payload?.error === 'string' ? payload.error : 'HTTP ' + response.status
    throw Object.assign(new Error(message), { status: response.status, body: payload })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done: ChatStreamResult | null = null
  let failure: ChatStreamFailure | null = null
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let cut = buffer.indexOf('\n\n')
    while (cut >= 0) {
      const raw = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      cut = buffer.indexOf('\n\n')
      const parsed = parseSseEvent(raw)
      if (!parsed) continue
      if (parsed.event === 'delta') {
        const data = parsed.data as { text?: string }
        if (data?.text) handlers.onDelta?.(data.text)
      } else if (parsed.event === 'done') {
        done = parsed.data as ChatStreamResult
      } else if (parsed.event === 'error') {
        failure = parsed.data as ChatStreamFailure
      }
    }
  }
  if (failure) {
    throw Object.assign(new Error(failure.error || '这次没有回上来'), {
      status: 502,
      code: failure.code,
      body: failure,
      stopped: Boolean(failure.stopped),
    })
  }
  if (!done) throw new Error('连接中途断开了，这次没有回上来（积分已退回）')
  return done
}

// ── 附件（r218） ─────────────────────────────────────────────────────────────
// 附件先上传解析（服务端读成文字），发消息时只带文件号：原文不进 JSON body、也不进聊天记录。
export type ChatFile = {
  id: string
  name: string
  // r245：image 是「原图直接给模型看」，本地不转文字（chars 为 0，看 bytes 与 mime）
  kind: 'text' | 'docx' | 'xlsx' | 'pdf' | 'image' | string
  kindLabel: string
  bytes: number
  chars: number
  truncated: boolean
  note: string
  // 图片多一个 mime；不是图片时是空串
  mime: string
  createdAt: string
}

export type ChatFileLimits = {
  bytes: number
  fileChars: number
  totalChars: number
  maxPerMessage: number
  imagesPerMessage: number
  keepFiles: number
}

/** 搜索服务有没有接通（没接通时开关禁用，并说明「先发链接来」）。 */
export const getChatSearch = () =>
  request<{ ok: boolean } & ChatSearchStatus>('/api/chat/search')

/** 图片原图地址（缩略图与「我发的是哪一张」）：只给上传它的人，服务端按归属校验。 */
export const chatFileRawUrl = (id: string) => '/api/chat/files/' + encodeURIComponent(id) + '/raw'

export const listChatFiles = () =>
  request<{ ok: boolean; items: ChatFile[]; limits: ChatFileLimits }>('/api/chat/files')

export const getChatFile = (id: string) =>
  request<{ ok: boolean; file: ChatFile; text: string }>('/api/chat/files/' + id)

export const deleteChatFile = (id: string) =>
  request<{ ok: boolean }>('/api/chat/files/' + id, { method: 'DELETE' })

/**
 * 上传一个附件：原始字节 + 文件名走 header（服务端不解析 multipart）。
 * 不用 request()：那条会把 Content-Type 钉成 application/json。
 */
export async function uploadChatFile(file: File): Promise<ChatFile> {
  let name = file.name
  try {
    name = encodeURIComponent(file.name)
  } catch {
    name = 'file'
  }
  const response = await safeFetch('/api/chat/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': name },
    body: file,
  })
  const text = await response.text()
  let body: { ok?: boolean; file?: ChatFile; error?: string; code?: string } | null = null
  try {
    body = text ? (JSON.parse(text) as { ok?: boolean; file?: ChatFile; error?: string; code?: string }) : null
  } catch {
    body = null
  }
  if (!response.ok || !body?.file) {
    throw Object.assign(new Error(body?.error || 'HTTP ' + response.status), { status: response.status, code: body?.code })
  }
  return body.file
}
