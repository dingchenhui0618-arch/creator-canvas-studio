import { request } from './client'
import type {
  Project,
  ProjectBucket,
  ProjectDetail,
  ProjectFlowBrief,
  ProjectListFacets,
  ProjectScript,
  ProjectShare,
  ProjectSummary,
  ShareSummaryRow,
  SharedProject,
} from '../domain/project'

export type ProjectListFilter = { q?: string; state?: ProjectBucket }

export type ProjectListResult = {
  ok: boolean
  items: ProjectSummary[]
  /** 账号下看得见的作品总数，不受筛选影响 */
  total: number
  /** 筛出来几条 */
  shown: number
  facets: ProjectListFacets
  /** 归一后的关键字（小写、空格收成一个），界面用它判断「有没有在筛」 */
  query: string
  state: ProjectBucket
}

// 不带参数就是原来的全部列表：筛选可省，接口向后兼容
export const listProjects = (filter: ProjectListFilter = {}) => {
  const params = new URLSearchParams()
  const keyword = (filter.q || '').trim()
  if (keyword) params.set('q', keyword)
  if (filter.state && filter.state !== 'all') params.set('state', filter.state)
  const query = params.toString()
  return request<ProjectListResult>('/api/projects' + (query ? '?' + query : ''))
}

// 工作台的「分享出去的链接」：跨作品汇总，一条作品一行，不带 token 与记录键
export const listShares = () => request<{ items: ShareSummaryRow[]; total: number; opens: number }>('/api/shares')

export const getProject = (id: string) => request<ProjectDetail>('/api/projects/' + id)

// 建作品有两条起点：一条模板（脚本与分镜先有），或者一块已经跑过的画布（v0.9.29）。
// 从画布建的作品没有模板，脚本在作品页现写，画布已经在了所以一出生就是 v1。
export const createProject = (payload: { templateId?: string; flowId?: string; title?: string }) =>
  request<{ ok: boolean; project: Project; flow?: ProjectFlowBrief | null; runs?: { count: number } }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

// 把一块画布归到这条作品上：一接上，这块画布跑过的运行也一起归过来（运行只认 flowId，不复制记录）
export const adoptProjectCanvas = (id: string, flowId: string) =>
  request<{
    ok: boolean
    /** false = 这块画布本来就归这条作品，什么都没改 */
    changed: boolean
    project: Project
    flow: ProjectFlowBrief | null
    runs: { count: number }
  }>('/api/projects/' + id + '/canvas', { method: 'PUT', body: JSON.stringify({ flowId }) })

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

export type ProjectTemplateSaveResult = {
  ok: boolean
  template: {
    id: string
    title: string
    kind: string
    /** 'project' = 从作品沉淀的（模板库里写「来自作品」） */
    origin: string
    adaptedFrom: string
    projectId: string
    projectTitle: string
    projectVersion: number
    beats: number
    shots: number
    scriptSource: string
  }
  /** 这一版的脚本还是模板那份：界面要先把「存出来几乎一样」说出来 */
  sameAsTemplate: boolean
}

// 作品「存成模板」：把这一版做完的脚本 + 沿用绑定模板的分镜沉淀回模板库。
// 只写模板库，不改作品、不改模板、不开版本；不调模型、不扣积分。
export const saveProjectAsTemplate = (id: string, payload: { title?: string } = {}) =>
  request<ProjectTemplateSaveResult>('/api/projects/' + id + '/template', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

// getTimezoneOffset 是「UTC 减本地」的分钟数，取反才是东经为正
const tzOffset = () => String(-new Date().getTimezoneOffset())

/**
 * 有个地址要下载：读出服务端定下的文件名再落盘。
 * 交付稿与交付包走同一段逻辑——两边的错误文案、文件名解析不该各写一份。
 */
async function downloadFrom(endpoint: string, fallbackName: string): Promise<{ name: string; bytes: number }> {
  const response = await fetch(endpoint, { credentials: 'same-origin' })
  if (!response.ok) {
    const text = await response.text()
    let message = '导出没有成功（HTTP ' + response.status + '）'
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
  const name = utf8 ? decodeURIComponent(utf8[1]) : plain?.[1] || fallbackName
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

/**
 * 交付稿：把这条作品压成一份 Markdown 附件（脚本、分镜、评审结论、版本、运行）。
 * 走后端再落盘：要把导出人所在的时区带上（稿子里的时间是本地时间），也要读出服务端定下的文件名。
 * 只读接口，不扣积分。
 */
export const downloadProjectDeliverable = (id: string) =>
  downloadFrom('/api/projects/' + encodeURIComponent(id) + '/deliverable?tz=' + encodeURIComponent(tzOffset()), 'visionqa-deliverable.md')

/**
 * 交付包：交付稿 + 现场页 + 原片帧图打成一个 zip。
 * 发给不在系统里的人（剪辑、拍摄、甲方）：解压就能看，不用登录也不用联网。
 */
export const downloadProjectDeliverableZip = (id: string) =>
  downloadFrom(
    '/api/projects/' + encodeURIComponent(id) + '/deliverable.zip?tz=' + encodeURIComponent(tzOffset()),
    'visionqa-deliverable.zip',
  )

/**
 * 交付稿的 A4 打印版地址：新标签里打开一张排好版的纸，打印（存 PDF）交给浏览器。
 * 走服务端出的 HTML 而不是前端排版：纸的样式只写一处，也不会把整页应用壳带进打印结果。
 * 时区同理，跟着地址走，纸上的时间就是导出人本地的时间。
 */
export function deliverablePrintUrl(id: string): string {
  return '/print/projects/' + encodeURIComponent(id) + '/deliverable?tz=' + encodeURIComponent(tzOffset())
}

/**
 * 现场页地址：同一张纸只留脚本 + 分镜（带原片帧图），编导拿去现场用。
 * 与交付包里的「现场页.html」是同一份渲染，只是帧图改成走登录态。
 */
export function setSheetUrl(id: string): string {
  return '/print/projects/' + encodeURIComponent(id) + '/deliverable?only=script&tz=' + encodeURIComponent(tzOffset())
}

/**
 * 评审对照纸地址：评审把每条问题框在当时的画面上，编号对到右边的问题列表。
 * 与交付包里的「评审对照页.html」是同一份渲染，只是画面改成走登录态。
 */
export function reviewSheetUrl(id: string): string {
  return '/print/projects/' + encodeURIComponent(id) + '/review?tz=' + encodeURIComponent(tzOffset())
}

/**
 * 分享页里的评审对照纸：不用登录，凭证就是分享链接里的 token。
 * 画面走带 token 的帧图接口（分享页拿不到要登录的 /media/frames），纸的其余部分与作品页那份同一份渲染。
 */
export function sharedReviewSheetUrl(token: string): string {
  return '/print/share/project/' + encodeURIComponent(token) + '/review?tz=' + encodeURIComponent(tzOffset())
}
