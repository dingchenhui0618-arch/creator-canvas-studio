// 智能体页两个窗口工具的接口契约：与 server/routes/media-gen.mjs 一一对应。
// 生成任务由服务端扣积分、落 data/media；前端只拿任务状态与鉴权下载地址。
import { request } from './client'

export type MediaKind = 'image' | 'video'
export type MediaTaskStatus = 'processing' | 'succeeded' | 'failed'
export type ImageRatio = '1:1' | '9:16' | '16:9'
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

export const generateMediaVideo = (input: { prompt: string; duration: VideoDuration; resolution: VideoResolution }) =>
  request<MediaTaskResponse>('/api/media/generate', {
    method: 'POST',
    body: JSON.stringify({ kind: 'video', ...input }),
  })

export const getMediaTask = (id: string) =>
  request<MediaTaskResponse>('/api/media/tasks/' + encodeURIComponent(id))
