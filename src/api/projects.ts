import { request } from './client'
import type { Project, ProjectDetail, ProjectScript, ProjectSummary } from '../domain/project'

export const listProjects = () => request<{ ok: boolean; items: ProjectSummary[]; total: number }>('/api/projects')

export const getProject = (id: string) => request<ProjectDetail>('/api/projects/' + id)

export const createProject = (payload: { templateId: string; title?: string }) =>
  request<{ ok: boolean; project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(payload) })

export const updateProject = (id: string, payload: { title?: string; flowId?: string; status?: 'active' | 'done' }) =>
  request<{ ok: boolean; project: Project }>('/api/projects/' + id, { method: 'PATCH', body: JSON.stringify(payload) })

// 开一版新的：服务端复制当前画布，旧画布归档成 vN
export const startProjectVersion = (id: string) =>
  request<{ ok: boolean; project: Project; flow: { id: string; name: string } }>('/api/projects/' + id + '/versions', {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const deleteProject = (id: string) =>
  request<{ ok: boolean; removed: { id: string; detachedReviews: number } }>('/api/projects/' + id, { method: 'DELETE' })

// 作品页开画布：第一张画布用这条作品现在的脚本生成（不再绕模板库的套用接口）
export const openProjectCanvas = (id: string) =>
  request<{ ok: boolean; created: boolean; project: Project; flow: { id: string; name: string; nodes: number; updatedAt: string } }>(
    '/api/projects/' + id + '/canvas',
    { method: 'POST', body: JSON.stringify({}) },
  )

export type ScriptSaveResult = {
  ok: boolean
  project: Project
  script: ProjectScript | null
  canvas: { synced: boolean; flowId: string; reason: 'synced' | 'no-canvas' | 'canvas-missing' | 'hand-edited' | 'save-failed' | 'no-script' }
}

// 保存作品自己的脚本：服务端会把画布里自动生成的复刻提示词一起换掉
export const saveProjectScript = (
  id: string,
  payload: { hook: string; structure: Array<{ beat: string; voiceover: string; onScreen: string; startSec: number; endSec: number; purpose?: string }> },
) => request<ScriptSaveResult>('/api/projects/' + id + '/script', { method: 'PUT', body: JSON.stringify(payload) })

export const resetProjectScript = (id: string) =>
  request<{ ok: boolean; project: Project; script: ProjectScript | null; canvas: ScriptSaveResult['canvas'] }>(
    '/api/projects/' + id + '/script',
    { method: 'DELETE' },
  )
