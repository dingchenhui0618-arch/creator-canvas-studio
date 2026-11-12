// 智能体 API 客户端：与 server/routes/agents.mjs 的契约一一对应。
import { request as apiRequest } from './client'
import type { Project, ProjectScript } from '../domain/project'

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

export type AgentToolEvidence = { id: string; label: string; detail: string }
export type AgentArtifact = { name: string; type: string; content: string; bytes: number }
export type AgentToolsResult = {
  used: AgentToolEvidence[]
  artifacts: AgentArtifact[]
  skipped: { id: string; label: string; reason: string }[]
}

// 结构化草稿：服务端从回复里的 ```draft 块整理出来，三个出口（存为模板 / 送到画布 / 写进作品）都用它。
// 秒数是服务端按口播字数算的，界面上直接显示、不再自己算一遍。
export type AgentDraftBeat = {
  beat: string
  startSec: number
  endSec: number
  voiceover: string
  onScreen: string
  purpose: string
  expectedSec: number
  fit?: string
}

export type AgentDraftShot = {
  shotNo: number
  startSec: number
  endSec: number
  visual: string
  camera: string
  caption: string
  audio: string
  purpose: string
  expectedSec: number
  fit?: string
}

export type AgentDraft = {
  title: string
  hook: string
  contentType: string
  structure: AgentDraftBeat[]
  storyboard: AgentDraftShot[]
  stats: { beats: number; shots: number; voiceoverSec: number; storyboardSec: number; durationSec: number }
}

export type AgentChatReply = {
  credits?: { cost: number; balance: number | null }
  reply: string
  model: string
  latencyMs: number
  usage: unknown
  attempted: string[]
  tools?: AgentToolsResult
  draft?: AgentDraft | null
  run?: { id: string; createdAt: string; credits: { cost: number; balance: number | null; refunded: boolean } | null }
  memory: { turns: number; messages: number }
  outputType: OutputType
  agent: { id: string; name: string; runCount: number; lastRunAt: string | null }
}

export type AgentRunRecord = {
  id: string
  agentId: string
  agentName: string
  status: 'success' | 'error'
  conversationId?: string
  message: string
  reply: string
  error: string
  model: string
  outputType: string
  latencyMs: number
  credits: { cost: number; balance: number | null; refunded: boolean } | null
  tools: {
    used: AgentToolEvidence[]
    skipped: { id: string; label: string; reason: string }[]
    artifacts: { name: string; type: string; bytes: number }[]
  } | null
  createdAt: string
}

export type AgentHistory = {
  items: AgentRunRecord[]
  total: number
  offset: number
  limit: number
  agent: { id: string; name: string; runCount: number; lastRunAt: string | null; lastModel: string }
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
// 作品页「让智能体写」带过来的那条作品：模块变量而不是地址参数——地址栏里不出现内部 id，
// 与上面那个「选中哪一个智能体」同一种一次性交接。
let pendingAgentProjectId = ''

export function setPendingAgentProject(id: string) {
  pendingAgentProjectId = id
}

export function peekPendingAgentProject() {
  return pendingAgentProjectId
}

export function clearPendingAgentProject() {
  pendingAgentProjectId = ''
}

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
  input: { message: string; outputType: OutputType; model?: string; history?: ChatMemoryItem[]; conversationId?: string },
) =>
  request<AgentChatReply>('/api/agents/' + id + '/chat', {
    method: 'POST',
    body: JSON.stringify({ ...input, count: 1 }),
  })

// 两个出口都不扣积分：没有模型调用，只是把已经产出的内容落到模板库或画布。
export const saveAgentDraftAsTemplate = (id: string, draft: AgentDraft) =>
  request<{ template: { id: string; title: string; contentType: string; platformLabel: string; beats: number; shots: number; durationSec: number } }>(
    '/api/agents/' + id + '/draft/template',
    { method: 'POST', body: JSON.stringify({ draft }) },
  )

export const sendAgentDraftToCanvas = (id: string, draft: AgentDraft) =>
  request<{ flow: { id: string; name: string; nodes: number } }>('/api/agents/' + id + '/draft/canvas', {
    method: 'POST',
    body: JSON.stringify({ draft }),
  })

// 写进作品：只写脚本（钩子 + 段落），分镜留在草稿里——要镜头走「送到画布」。
// 服务端走作品脚本的 copy-on-write：模板与别的作品不动；回执带被换掉的那一份（来源与段数）。
export type DraftProjectResult = {
  ok: boolean
  project: Project
  script: ProjectScript | null
  canvas: { synced: boolean; flowId: string; reason: 'synced' | 'no-canvas' | 'canvas-missing' | 'hand-edited' | 'save-failed' }
  replaced: { source: '' | 'project' | 'template'; beats: number }
}

export const writeAgentDraftToProject = (id: string, draft: AgentDraft, projectId: string) =>
  request<DraftProjectResult>('/api/agents/' + id + '/draft/project', {
    method: 'POST',
    body: JSON.stringify({ draft, projectId }),
  })

export const listAgentHistory = (id: string, params: { limit?: number; offset?: number } = {}) => {
  const query = new URLSearchParams()
  if (params.limit) query.set('limit', String(params.limit))
  if (params.offset) query.set('offset', String(params.offset))
  const suffix = query.toString()
  return request<AgentHistory>('/api/agents/' + id + '/history' + (suffix ? '?' + suffix : ''))
}

export const clearAgentHistory = (id: string) =>
  request<{ ok: boolean; removed: number }>('/api/agents/' + id + '/history', { method: 'DELETE' })

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