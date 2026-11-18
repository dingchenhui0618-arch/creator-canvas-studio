// 对话预设页两个窗口工具的接口契约：与 server/routes/media-gen.mjs 一一对应。
// 生成任务由服务端扣积分、落 data/media；前端只拿任务状态与鉴权下载地址。
import { request } from './client'

export type MediaKind = 'image' | 'video'
export type MediaTaskStatus = 'processing' | 'succeeded' | 'failed'
// 比例 / 时长 / 分辨率不再是写死的联合类型：能选什么是服务端 media-models 定的，
// 前端照 /api/media/models 画控件，避免「界面能点、服务端不认」的两套标准。
export type ImageRatio = string
export type VideoRatio = string
export type VideoDuration = number
export type VideoResolution = string

export type MediaAsset = {
  id: string
  kind: 'image' | 'video'
  name: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  duration: number | null
  createdAt: string
  previewUrl: string
}

export type MediaMode = {
  id: string
  label: string
  hint: string
  minRefs: number
  maxRefs: number
  imageRefs: number
  videoRefs: number
}

export type MediaModel = {
  id: string
  kind: MediaKind
  label: string
  platform: string
  // 这条链路真调过没有：false 的要在界面上照实标「未真调」，别装作验过
  verified: boolean
  referenceVerified: boolean
  modes: MediaMode[]
  ratios: string[]
  durations: number[]
  resolutions: string[]
  credits: number
}

export type MediaModelList = {
  ok: boolean
  image: MediaModel[]
  video: MediaModel[]
  defaults: { image: string; video: string }
  limits: { imageRefs: number; videoRefs: number }
}

export type MediaTaskFile = {
  mime: string
  bytes: number
}

export type MediaTaskAsset = {
  id: string
  kind: 'image' | 'video'
  name: string
  bytes: number
  width: number | null
  height: number | null
  duration: number | null
}

export type MediaTask = {
  id: string
  kind: MediaKind
  status: MediaTaskStatus
  prompt: string
  model: string
  mode: string
  ratio: string
  size: string
  duration: number | null
  resolution: string
  assets: MediaTaskAsset[]
  progress: number | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  error: string
  file: MediaTaskFile | null
  downloadUrl: string
  credits: {
    cost: number
    balance: number | null
    refunded: boolean
    refundedAt: string | null
  }
}

export type MediaTaskResponse = {
  ok: boolean
  task: MediaTask
  warning?: string
}

export type MediaGenerateInput = {
  prompt: string
  model: string
  mode: string
  ratio: string
  // 参考素材 id（先 POST /api/media/assets 传上来，再在这里引用）
  assets?: string[]
  duration?: number
  resolution?: string
}

export const generateMediaImage = (input: MediaGenerateInput) =>
  request<MediaTaskResponse>('/api/media/generate', {
    method: 'POST',
    body: JSON.stringify({ kind: 'image', ...input }),
  })

export const generateMediaVideo = (input: MediaGenerateInput) =>
  request<MediaTaskResponse>('/api/media/generate', {
    method: 'POST',
    body: JSON.stringify({ kind: 'video', ...input }),
  })

export type MediaTaskListResponse = {
  ok: boolean
  kind: string
  tasks: MediaTask[]
  // 还有更早的能翻；capped 时说明服务端只往回扫了有限的元数据，别假装翻到底了
  hasMore: boolean
  capped: boolean
}

// 「最近生成」：只回当前账号自己的任务，服务端按时间倒序；kind 用来分窗口（生图 / 生视频）。
// before 传上一页最后一条的任务号，就能往回翻更早的（按位置取，不按时间比，同毫秒的多条也不会漏）。
export const listMediaTasks = (kind: MediaKind, limit = 6, before = '') =>
  request<MediaTaskListResponse>(
    '/api/media/tasks?kind=' + kind + '&limit=' + limit + (before ? '&before=' + encodeURIComponent(before) : ''),
  )

export const getMediaTask = (id: string) =>
  request<MediaTaskResponse>('/api/media/tasks/' + encodeURIComponent(id))

// 生成模型与规格：界面的模型 / 方式 / 比例 / 时长 / 清晰度全照这张表画
export const listMediaModels = () => request<MediaModelList>('/api/media/models')

export type MediaAssetListResponse = {
  ok: boolean
  assets: MediaAsset[]
  usage: { files: number; bytes: number; maxFiles: number; maxTotalBytes: number }
  limits: { imageBytes: number; videoBytes: number }
}

export const listMediaAssets = (limit = 30) =>
  request<MediaAssetListResponse>('/api/media/assets?limit=' + limit)

// 参考素材走原始字节上传：不是 JSON。8 MB 的图 base64 之后就是 11 MB，超过 JSON 请求体上限，
// 而且把文件当字符串过一遍内存纯属浪费。宽高 / 时长由浏览器读出来再带过来。
export const uploadMediaAsset = (input: {
  file: File
  width?: number | null
  height?: number | null
  duration?: number | null
}) => {
  const params = new URLSearchParams()
  params.set('name', input.file.name || '参考素材')
  if (input.width) params.set('width', String(Math.round(input.width)))
  if (input.height) params.set('height', String(Math.round(input.height)))
  if (input.duration) params.set('duration', String(Math.round(input.duration * 10) / 10))
  return request<{ ok: boolean; asset: MediaAsset }>('/api/media/assets?' + params.toString(), {
    method: 'POST',
    body: input.file,
    headers: { 'Content-Type': input.file.type || 'application/octet-stream' },
  })
}

export const deleteMediaAsset = (id: string) =>
  request<{ ok: boolean }>('/api/media/assets/' + encodeURIComponent(id), { method: 'DELETE' })
