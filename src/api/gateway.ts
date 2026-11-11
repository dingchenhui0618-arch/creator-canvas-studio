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
  capability: 'image'
  ready: boolean
  coveredBy: 'model' | 'generic' | 'none'
  keys: { id: string; name: string; priority: number }[]
}

export type GatewayStatus = {
  configured: boolean
  tokenMasked: string
  baseUrl: string
  activeTasks: number
  recentTasks: GatewayTask[]
  endpoints: { images: string; videoCreate: string; videoPoll: string }
  keys: { image: number; video: number }
  models: { image: string[]; video: string[] }
  coverage: GatewayCoverage[]
  checkedAt: string
}

export const getGatewayStatus = () => request<GatewayStatus>('/api/admin/gateway')
