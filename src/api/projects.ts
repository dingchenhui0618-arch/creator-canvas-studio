import { request } from './client'
import type { Project, ProjectDetail, ProjectSummary } from '../domain/project'

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
