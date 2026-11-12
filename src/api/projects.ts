import { request } from './client'
import type { Project, ProjectDetail, ProjectSummary } from '../domain/project'

export const listProjects = () => request<{ ok: boolean; items: ProjectSummary[]; total: number }>('/api/projects')

export const getProject = (id: string) => request<ProjectDetail>('/api/projects/' + id)

export const createProject = (payload: { templateId: string; title?: string }) =>
  request<{ ok: boolean; project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(payload) })

export const updateProject = (id: string, payload: { title?: string; flowId?: string; status?: 'active' | 'done' }) =>
  request<{ ok: boolean; project: Project }>('/api/projects/' + id, { method: 'PATCH', body: JSON.stringify(payload) })

export const deleteProject = (id: string) =>
  request<{ ok: boolean; removed: { id: string; detachedReviews: number } }>('/api/projects/' + id, { method: 'DELETE' })
