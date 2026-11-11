import { request } from './client'

export type GatewayTask = {
  id: string
  keyName: string
  model: string
  ageSec: number
}

export type GatewayCoverage = {
  model: string
  label: string
  capability: 'image' | 'video'
  ready: boolean
  coveredBy: 'model' | 'generic' | 'none'
  /** 靠改名接上的：这里写发给上游的真实模型名（如 SeeAPI 的 seedream-5.0-pro） */
  upstream?: string
  keys: { id: string; name: string; priority: number }[]
}

export type GatewayStatus = {
  configured: boolean
  tokenMasked: string
  baseUrl: string
  activeTasks: number
  recentTasks: GatewayTask[]
  endpoints: {
    images: string
    imagesAsync: string
    videoCreate: string
    videoPoll: string
    taskPoll: string
  }
  keys: { image: number; video: number }
  models: { image: string[]; video: string[] }
  coverage: GatewayCoverage[]
  checkedAt: string
}

export const getGatewayStatus = () => request<GatewayStatus>('/api/admin/gateway')
