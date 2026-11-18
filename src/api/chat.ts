// 快捷创作对话（r214）：会话与消息都在服务端，关页面回来还在。
import { request } from './client'

export type ChatToolOptions = { search: boolean; readUrl: boolean; thinking: boolean }

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  at: number
  model?: string
  ms?: number
  meta?: { tools?: string[]; thinking?: boolean; finishReason?: string; usage?: unknown } | null
}

export type ChatConversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
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

export const sendChatMessage = (id: string, body: { content: string; tools?: Partial<ChatToolOptions> }) =>
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
  body: { content: string; tools?: Partial<ChatToolOptions> },
  handlers: { onDelta?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<ChatStreamResult> {
  const response = await fetch('/api/chat/conversations/' + id + '/messages/stream', {
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
