import { request } from './client'

export type GatewayTask = {
  id: string
  kind: 'image' | 'video'
  keyName: string
  model: string
  /** running 还在跑；succeeded 出片了；failed / refunded / canceled 都是没出片 */
  status: string
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

/** 通道没通时缺的那一样：额度开关 / 服务令牌 / Key。顺序就是修的先后。 */
export type GatewayBlocker = 'open' | 'token' | 'keys'

export type GatewayStatus = {
  configured: boolean
  /** 平台额度开关（服务器 .env 的 VQ_GATEWAY_OPEN）：关着时生成一律 503，令牌对也没用 */
  userOpen: boolean
  readiness: { ready: boolean; missing: GatewayBlocker[] }
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
