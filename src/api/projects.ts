import { request } from './client'
import type { Project, ProjectDetail, ProjectScript, ProjectShare, ProjectSummary, SharedProject } from '../domain/project'

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

// 作品级只读分享：发给没有账号的人看脚本与分镜；停止后旧链接立即失效
export const enableProjectShare = (id: string) =>
  request<{ ok: boolean; token: string; createdAt: string; share: ProjectShare }>('/api/projects/' + id + '/share', {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const disableProjectShare = (id: string) =>
  request<{ ok: boolean; share: null }>('/api/projects/' + id + '/share', { method: 'DELETE' })

// 分享页读公开视图：token 在地址里，不需要登录态
export const getSharedProject = (token: string) =>
  request<SharedProject & { ok: boolean }>('/api/share/project/' + encodeURIComponent(token))

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

/**
 * 交付稿：把这条作品压成一份 Markdown 附件（脚本、分镜、评审结论、版本、运行）。
 * 走 fetch 而不是 <a href>：要把导出人所在的时区带上（稿子里的时间是本地时间），
 * 也要读出服务端定下的文件名。只读接口，不扣积分。
 */
export async function downloadProjectDeliverable(id: string): Promise<{ name: string; bytes: number }> {
  // getTimezoneOffset 是「UTC 减本地」的分钟数，取反才是东经为正
  const tz = String(-new Date().getTimezoneOffset())
  const response = await fetch('/api/projects/' + encodeURIComponent(id) + '/deliverable?tz=' + encodeURIComponent(tz), {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const text = await response.text()
    let message = '交付稿没导出成功（HTTP ' + response.status + '）'
    try {
      const body = JSON.parse(text) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // 非 JSON 错误体就用默认文案
    }
    throw new Error(message)
  }
  const disposition = response.headers.get('content-disposition') || ''
  // 中文文件名在 filename*=UTF-8''… 里，老服务端只有 filename="…" 时退回它
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  const plain = disposition.match(/filename="([^"]+)"/)
  const name = utf8 ? decodeURIComponent(utf8[1]) : plain?.[1] || 'visionqa-deliverable.md'
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { name, bytes: blob.size }
}
