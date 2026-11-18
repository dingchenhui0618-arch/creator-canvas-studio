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
