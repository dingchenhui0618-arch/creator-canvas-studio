// 素材来源与下架通道（v0.9.82）：公开只读，不登录也能取。
// 只回计数与平台分布——标题、作者与原链接要登录进模板库才看得到。
import { request } from './client'

export type SourcePlatformRow = { key: string; label: string; count: number }

export type SourcesSummary = {
  ok: boolean
  at: string
  public: {
    total: number
    platforms: SourcePlatformRow[]
    withSourceUrl: number
    withAuthor: number
    withCover: number
    parsed: number
    linkOnly: number
    addedFrom: string
    addedTo: string
  }
  takedown: { handled: number }
}

export function getSourcesSummary(): Promise<SourcesSummary> {
  return request<SourcesSummary>('/api/sources/summary')
}
