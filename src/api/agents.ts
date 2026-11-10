// 智能体 API 客户端：与 server/routes/agents.mjs 的契约一一对应。
import { request as apiRequest } from './client'

export const AGENT_CATEGORIES = ['内容复刻', '视觉评审', '脚本分镜', '投放素材'] as const
export type AgentCategory = (typeof AGENT_CATEGORIES)[number]

export const OUTPUT_TYPES = ['脚本', '分镜', '评审', '文案'] as const
export type OutputType = (typeof OUTPUT_TYPES)[number]

export type AgentRecord = {
  id: string
  name: string
  category: AgentCategory
  role: string
  systemPrompt: string
  model: string
  temperature: number
  knowledge: string[]
  tools: string[]
  createdAt: string
  updatedAt: string
  runCount: number
  lastRunAt: string | null
  lastModel: string
}

export type AgentTool = {
  id: string
  label: string
  description: string
  scope: string
  state: 'ready' | 'planned'
}

export type AgentCategoryMeta = { id: string; label: string; hint: string }

export type AgentsList = {
  items: AgentRecord[]
  total: number
  runs: number
  byCategory: Record<string, number>
  categories: AgentCategoryMeta[]
  tools: AgentTool[]
  models: string[]
  defaultModel: string
  outputTypes: { id: string; label: string }[]
  vision: { enabled: boolean }
}

export type AgentInput = {
  name: string
  category: AgentCategory
  role: string
  systemPrompt: string
  model: string
  temperature: number
  knowledge: string[]
  tools: string[]
}

export type AgentChatReply = {
  reply: string
  model: string
  latencyMs: number
  usage: unknown
  attempted: string[]
  memory: { turns: number; messages: number }
  outputType: OutputType
  agent: { id: string; name: string; runCount: number; lastRunAt: string | null }
}

type ResponseBody = {
  error?: string
  code?: string
  suggestion?: string
  model?: string
  upstreamStatus?: number
  attempted?: string[]
}

type RequestError = Error & {
  status?: number
  code?: string
  suggestion?: string
  model?: string
  upstreamStatus?: number
  attempted?: string[]
}

// 公共请求封装（src/api/client.ts）只抛带 status 的 Error；这里补上智能体接口的结构化字段。
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await apiRequest<T>(path, init)
  } catch (caught) {
    const error = caught as RequestError & { body?: ResponseBody }
    const body = error.body || {}
    error.code = body.code || (error.status ? 'HTTP_' + error.status : 'NETWORK')
    error.suggestion = body.suggestion || ''
    error.model = body.model || ''
    error.upstreamStatus = body.upstreamStatus
    error.attempted = body.attempted
    throw error
  }
}

// 跨页面的一次性选中意图（编辑页点「开始对话」→ 列表页选中它）。
// 用模块变量而不是 sessionStorage，避免 React StrictMode 双重挂载时被提前消费。
let pendingSelectAgentId = ''

export function setPendingSelectAgent(id: string) {
  pendingSelectAgentId = id
}

export function peekPendingSelectAgent() {
  return pendingSelectAgentId
}

export function clearPendingSelectAgent() {
  pendingSelectAgentId = ''
}

export function listAgents(params: { q?: string; category?: string } = {}) {
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.category) query.set('category', params.category)
  const suffix = query.toString()
  return request<AgentsList>('/api/agents' + (suffix ? '?' + suffix : ''))
}

export const getAgent = (id: string) => request<AgentRecord>('/api/agents/' + id)
export const createAgent = (input: AgentInput) =>
  request<AgentRecord>('/api/agents', { method: 'POST', body: JSON.stringify(input) })
export const updateAgent = (id: string, input: Partial<AgentInput>) =>
  request<AgentRecord>('/api/agents/' + id, { method: 'PATCH', body: JSON.stringify(input) })
export const deleteAgent = (id: string) =>
  request<{ ok: boolean; id: string }>('/api/agents/' + id, { method: 'DELETE' })

export type ChatMemoryItem = { role: 'user' | 'assistant'; content: string }

export const chatWithAgent = (
  id: string,
  input: { message: string; outputType: OutputType; model?: string; history?: ChatMemoryItem[] },
) =>
  request<AgentChatReply>('/api/agents/' + id + '/chat', {
    method: 'POST',
    body: JSON.stringify({ ...input, count: 1 }),
  })

const pad = (value: number) => String(value).padStart(2, '0')

export function formatRelative(iso: string | null | undefined) {
  if (!iso) return '未运行'
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return '未运行'
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前'
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前'
  const date = new Date(time)
  return date.getFullYear() === new Date().getFullYear()
    ? pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    : date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

export function formatClock(iso: string | null | undefined) {
  if (!iso) return ''
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}