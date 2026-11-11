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
  lastTest: { ok: boolean; status: number; ms: number; at: string; error?: string; models?: string[] } | null
}

export type ModelKeyList = {
  items: ModelKey[]
  summary: { total: number; enabled: number; cooling: number; counts: Record<string, number> }
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
  request<{ ok: boolean; status: number; ms: number; models: string[]; error?: string; key: ModelKey }>(
    '/api/admin/model-keys/' + id + '/test',
    { method: 'POST' },
  )
