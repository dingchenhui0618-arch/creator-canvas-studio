import { useCallback, useEffect, useState } from 'react'
import { request } from '../../api/client'

export type Health = {
  ok: boolean
  redfox: boolean
  vision: boolean
  visionModel: string
  llm?: boolean
  llmModel?: string
  templates: number
}

export type TemplateItem = {
  id: string
  title: string
  contentType: string
  kind?: string
  platformLabel?: string
  tags?: string[]
  sourceUrl?: string
  durationSec: number
  createdAt: string
  thumb?: string
  cover?: string
  storyboard?: unknown[]
}

export type TemplatesResponse = {
  items: TemplateItem[]
  total?: number
}

export type RunNode = {
  id: string
  kind: string
  title: string
  status: string
  ms: number
  output?: unknown
  error?: string | null
  message?: string | null
}

export type RunItem = {
  id: string
  flowId: string
  flowName: string
  ownerId?: string
  status: string
  startedAt: string
  finishedAt?: string | null
  durationMs: number
  total: number
  nodes?: RunNode[]
  error?: string | null
  credits?: { cost: number; balance: number | null; refunded: boolean } | null
}

export type RunsResponse = {
  items: RunItem[]
  total: number
  offset?: number
  limit?: number
}

export type VersionInfo = {
  version: string
  name: string
  startedAt: string
}

export type BdcPort = {
  url: string
  embedUrl?: string
  up: boolean
  status: number
  error?: string
}

export type BdcStatus = {
  deployed: boolean
  web: BdcPort
  admin: BdcPort
  api: BdcPort
}

export type ApiState<T> = {
  data: T | null
  error: string
  loading: boolean
  reload: () => void
}

/** 只读请求：组件挂载或手动重试时拉取，失败保留错误信息给页面展示。 */
export function useApi<T>(path: string): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const next = await request<T>(path)
        if (!cancelled) setData(next)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '请求失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [path, revision])

  return { data, error, loading, reload }
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

export function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

export function formatSeconds(sec?: number): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '—'
  const minutes = Math.floor(sec / 60)
  const seconds = Math.round(sec % 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
