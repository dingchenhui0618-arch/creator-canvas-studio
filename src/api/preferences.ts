// 账号级偏好：目前只有首选模型。服务端持久化，换浏览器仍是同一选择。
import { request } from './client'

export type PreferencesResponse = { ok: boolean; model: string; updatedAt: string | null }

export const getPreferences = () => request<PreferencesResponse>('/api/preferences')

export const saveModelPreference = (model: string) =>
  request<PreferencesResponse>('/api/preferences', { method: 'PUT', body: JSON.stringify({ model }) })
