import { request } from './client'

// 后台「模型与上游」：服务端已经把两套计价口径折算成统一文本，前端只负责展示，
// 不再做汇率或倍率计算——否则同一个模型在两张页面上会算出两个价。
export type ModelCatalogPriceKind = 'token' | 'call' | 'second' | 'image' | 'unknown'

export type ModelCatalogPrice = {
  kind: ModelCatalogPriceKind
  currency: 'USD' | 'CNY' | ''
  /** 主价格：token 为输入 USD/1M，call 为每次，second 为每秒，image 为每张；未知为 null */
  value: number | null
  /** 给人看的完整价目，阶梯价会并排列出 */
  text: string
  /** 口径说明：分组倍率、按哪一档折算、参考图/参考视频怎么算 */
  note: string
}

export type ModelCatalogOffer = {
  platform: 'geteapi' | 'seeapi'
  platformLabel: string
  price: ModelCatalogPrice
  connected: boolean
}

export type ModelRouteRole = 'primary' | 'reference' | 'other'

export type ModelCatalogRow = {
  model: string
  capability: 'image' | 'video' | 'text' | 'unknown'
  offers: ModelCatalogOffer[]
  routable: boolean
  /** 统一路由下这一行的身份：主路由在用 / 仅参考 / 能力对不上 */
  route: ModelRouteRole
}

/** 一条能力唯一在用的那条路由（服务端 model-routes.mjs 是唯一真源）。 */
export type ModelRouteRow = {
  capability: 'text' | 'vision' | 'image' | 'video'
  label: string
  platform: string
  platformLabel: string
  model: string
  source: 'config' | 'fixed'
  usedBy: string[]
  note: string
  inCatalog: boolean
  price: ModelCatalogPrice | null
  referenceCount: number
}

export type ModelRouteSummary = {
  routes: ModelRouteRow[]
  referenceCount: number
  primaryCount: number
}

export type ModelCatalogPlatform = {
  id: 'geteapi' | 'seeapi'
  label: string
  baseUrl: string
  connected: boolean
  modelCount: number
  note: string
}

export type ModelCatalogResponse = {
  ok: boolean
  fetchedAt: string
  platforms: ModelCatalogPlatform[]
  /** 统一路由：每条能力一条主路由，其余都降为仅参考 */
  routes: ModelRouteSummary
  rows: ModelCatalogRow[]
  notes: string[]
}

/** 手动刷新绕开服务端 10 分钟缓存；普通进入沿用缓存。 */
export function getModelCatalog(force = false): Promise<ModelCatalogResponse> {
  return request<ModelCatalogResponse>('/api/admin/model-catalog' + (force ? '?force=1&t=' + Date.now() : ''))
}
