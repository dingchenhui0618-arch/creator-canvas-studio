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
