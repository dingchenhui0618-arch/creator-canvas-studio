import { request } from './client'

export type ModelKey = {
  id: string
  name: string
  provider: string
  baseUrl: string
  models: string[]
  capabilities: string[]
  priority: number
  weight: number
  enabled: boolean
  masked: string
  createdAt: string
  updatedAt: string
  cooling: boolean
  lastTest: ModelKeyTest | null
  usage: {
    ok: number
    fail: number
    lastError: string
    lastErrorAt: string
    lastUsedAt: string
    cooldownSec: number
  }
}

export type ModelKeyTest = {
  ok: boolean
  /** real-call = 打了一次真实对话请求；credential-probe = 只验证凭证（出图 / 视频会产生费用） */
  mode?: 'real-call' | 'credential-probe'
  note?: string
  model?: string
  status: number
  ms: number
  at?: string
  error?: string
  reply?: string
  models?: string[]
  /** 判断能力会额外真跑一次判断（见 server/judge.mjs 的 judgeSelfCheck） */
  judge?: {
    ok: boolean
    protocol: 'systemone' | 'chat'
    model: string
    answers: { evidenceConsistent: number | null; verdictSupport: string; publishRisk: number | null; actionable: number | null } | null
    error: string
  } | null
}

export type ModelKeyList = {
  items: ModelKey[]
  summary: { total: number; enabled: number; cooling: number; counts: Record<string, number>; usage: { ok: number; fail: number } }
  providers: { id: string; label: string; baseUrl: string }[]
  fallback: { configured: boolean; model: string; baseUrl: string }
}

export type ModelKeyInput = {
  name: string
  provider: string
  baseUrl: string
  apiKey?: string
  models: string[]
  capabilities: string[]
  priority: number
  weight: number
}

export const listModelKeys = () => request<ModelKeyList>('/api/admin/model-keys')

export const createModelKey = (input: ModelKeyInput) =>
  request<{ ok: boolean; key: ModelKey }>('/api/admin/model-keys', { method: 'POST', body: JSON.stringify(input) })

export const updateModelKey = (id: string, patch: Partial<ModelKeyInput> & { enabled?: boolean }) =>
  request<{ ok: boolean; key: ModelKey }>('/api/admin/model-keys/' + id, { method: 'PATCH', body: JSON.stringify(patch) })

export const deleteModelKey = (id: string) =>
  request<{ ok: boolean; id: string }>('/api/admin/model-keys/' + id, { method: 'DELETE' })

export const testModelKey = (id: string) =>
  request<ModelKeyTest & { key: ModelKey }>('/api/admin/model-keys/' + id + '/test', { method: 'POST' })

export const listModelRoutes = (limit = 50) =>
  request<RouteList>('/api/admin/model-keys/routes?limit=' + encodeURIComponent(String(limit)))

export const previewModelRoute = (input: { capability: string; model: string }) =>
  request<RoutePreview>('/api/admin/model-keys/preview', { method: 'POST', body: JSON.stringify(input) })

export type RouteKeyRow = {
  id: string
  name: string
  provider: string
  priority: number
  weight: number
  /** eligible = 这次可选；其余是被跳过的原因 */
  state: 'eligible' | 'disabled' | 'capability' | 'model' | 'cooling'
  reason: string
  /** 只在同优先级候选组里有值：按权重被选中的概率百分比 */
  share?: number
}

export type RoutePreview = {
  ok: true
  capability: string
  model: string
  keys: RouteKeyRow[]
  eligible: RouteKeyRow[]
  group: RouteKeyRow[]
  priority: number | null
  chosen: RouteKeyRow | null
  description: string
  fallback: { configured: boolean; model: string }
}

export type RouteEntry = {
  id: string
  at: string
  capability: string
  model: string
  keyId: string
  keyName: string
  source: 'pool' | 'env' | 'none'
  reason: string
  attempt: number
  ms: number
  ok: boolean
  /** 人话结论，例如「额度不足（HTTP 402）」 */
  error: string
  /** 原始上游报错，悬停查看；没有做归类时为空 */
  detail?: string
}

export type RouteList = {
  items: RouteEntry[]
  summary: {
    total: number
    ok: number
    fail: number
    env: number
    none: number
    /** 换 Key 成功的次数：第一把失败、后面某把接住了 */
    failover: number
    avgMs: number
    lastAt: string
    byKey: { keyId: string; keyName: string; ok: number; fail: number; count: number; avgMs: number }[]
  }
  fallback: { configured: boolean; model: string; baseUrl: string }
}

