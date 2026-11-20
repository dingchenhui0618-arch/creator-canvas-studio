// 素材占用：用户看自己的（/api/storage），管理员看全部并可设上限（/api/admin/storage）。
// 上限与积分额度是两回事：积分是「能花多少」，这里是「能占多少盘」。
import { request } from './client'

/** 工作流画面（r279）：工作流跑完贴回分镜的图存自己的库，不占「上传素材」那 20 张。 */
export interface ShotFrameUsage {
  files: number
  bytes: number
  projects: number
  maxFiles: number
  maxBytes: number
  maxProjectFiles: number
}

/** 按作品拆开的一行（r280）：哪条作品占了多少张、多少字节。 */
export interface ShotFrameProjectRow {
  projectId: string
  title: string
  inTrash: boolean
  files: number
  bytes: number
  newestAt: string
}

/** 工作流画面的对账（r280）：总量、按作品拆开、以及「有 N 张没人引用」。 */
export interface ShotFrameOverview {
  ok: boolean
  usage: ShotFrameUsage
  projects: ShotFrameProjectRow[]
  orphans: { files: number; bytes: number }
}

export interface ShotFrameClearResult {
  ok: boolean
  scope: 'project' | 'unused'
  removed: number
  bytes: number
  projectId?: string
  title?: string
  shotsCleared?: number
}

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
  shotFrames?: ShotFrameUsage
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

/** 工作流画面（r280）：清之前先看清是哪条作品占的。 */
export const getShotFrames = () => request<ShotFrameOverview>('/api/storage/shotframes')

export const clearShotFrameProject = (projectId: string) =>
  request<ShotFrameClearResult>('/api/storage/shotframes/clear', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })

export const clearUnusedShotFrames = () =>
  request<ShotFrameClearResult>('/api/storage/shotframes/clear', {
    method: 'POST',
    body: JSON.stringify({ scope: 'unused' }),
  })

export const getAdminStorage = () => request<AdminStorage>('/api/admin/storage')

export const saveStorageLimit = (defaultMb: number) =>
  request<AdminStorage>('/api/admin/storage', { method: 'PUT', body: JSON.stringify({ defaultMb }) })

export const setStorageLimit = (userId: string, limitMb: number) =>
  request<AdminStorage>('/api/admin/storage/overrides/' + userId, { method: 'PUT', body: JSON.stringify({ limitMb }) })

export const clearStorageLimit = (userId: string) =>
  request<AdminStorage>('/api/admin/storage/overrides/' + userId, { method: 'DELETE' })

export const cleanOrphanFrames = () =>
  request<AdminStorage & { dirs: number; bytes: number }>('/api/admin/storage/clean', { method: 'POST', body: '{}' })
