// 智能体页两个窗口工具的接口契约：与 server/routes/media-gen.mjs 一一对应。
// 生成任务由服务端扣积分、落 data/media；前端只拿任务状态与鉴权下载地址。
import { request } from './client'

export type MediaKind = 'image' | 'video'
export type MediaTaskStatus = 'processing' | 'succeeded' | 'failed'
export type ImageRatio = '1:1' | '9:16' | '16:9'
// 出视频的比例：服务端强制要 aspect_ratio，不给就 400（2026-11-18 真调抓到的坑），所以前端必须显式给一个
export type VideoRatio = '9:16' | '16:9' | '1:1'
export type VideoDuration = 4 | 8
export type VideoResolution = '480p' | '720p'

export type MediaTaskFile = {
  mime: string
  bytes: number
}

export type MediaTask = {
  id: string
  kind: MediaKind
  status: MediaTaskStatus
  prompt: string
  model: string
  ratio: string
  size: string
  duration: number | null
  resolution: string
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

export const generateMediaImage = (input: { prompt: string; ratio: ImageRatio }) =>
  request<MediaTaskResponse>('/api/media/generate', {
    method: 'POST',
    body: JSON.stringify({ kind: 'image', ...input }),
  })

export const generateMediaVideo = (input: { prompt: string; ratio: VideoRatio; duration: VideoDuration; resolution: VideoResolution }) =>
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
