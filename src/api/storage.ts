// 素材占用：用户看自己的（/api/storage），管理员看全部并可设上限（/api/admin/storage）。
// 上限与积分额度是两回事：积分是「能花多少」，这里是「能占多少盘」。
import { request } from './client'

export interface StorageUsage {
  ok: boolean
  bytes: number
  limitMb: number
  limitBytes: number
  unlimited: boolean
  overridden: boolean
  remainingBytes: number | null
  over: boolean
  percent: number | null
}

export interface StorageAccountRow {
  userId: string
  email: string
  name: string
  kind: string
  active: boolean
  templates: number
  bytes: number
  limitMb: number
  unlimited: boolean
  overridden: boolean
  over: boolean
}

export interface AdminStorage {
  ok: boolean
  dataDir: string
  bytes: number
  files: number
  items: { name: string; bytes: number; files: number }[]
  disk: { totalBytes: number; freeBytes: number } | null
  frames: { bytes: number; files: number; dirs: number }
  shared: { bytes: number }
  orphans: { count: number; bytes: number; ids: string[] }
  accounts: StorageAccountRow[]
  limits: { defaultMb: number; overrides: Record<string, number>; updatedAt: string; updatedBy: string }
  checkedAt: string
}

/** 字节数只在这个文件里格式化：全站同一套口径，不各写一份。 */
export function formatSize(bytes?: number | null): string {
  const value = Number(bytes) || 0
  const MB = 1024 * 1024
  if (value >= 1024 * MB) return (value / (1024 * MB)).toFixed(2) + ' GB'
  if (value >= MB) return (value / MB).toFixed(1) + ' MB'
  if (value >= 1024) return Math.round(value / 1024) + ' KB'
  return value + ' B'
}

export const getStorage = () => request<StorageUsage>('/api/storage')

export const getAdminStorage = () => request<AdminStorage>('/api/admin/storage')

export const saveStorageLimit = (defaultMb: number) =>
  request<AdminStorage>('/api/admin/storage', { method: 'PUT', body: JSON.stringify({ defaultMb }) })

export const setStorageLimit = (userId: string, limitMb: number) =>
  request<AdminStorage>('/api/admin/storage/overrides/' + userId, { method: 'PUT', body: JSON.stringify({ limitMb }) })

export const clearStorageLimit = (userId: string) =>
  request<AdminStorage>('/api/admin/storage/overrides/' + userId, { method: 'DELETE' })

export const cleanOrphanFrames = () =>
  request<AdminStorage & { dirs: number; bytes: number }>('/api/admin/storage/clean', { method: 'POST', body: '{}' })
