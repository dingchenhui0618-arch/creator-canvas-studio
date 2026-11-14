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
  ownerId?: string
  /** 公共模板：所有账号可见；后台可一键设为公共或收回 */
  shared?: boolean
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
  // 哪个实例执行的：两份实例共用 DATA_DIR，排查「重启误伤」时先看这一列
  ownerInstance?: string
  status: string
  startedAt: string
  finishedAt?: string | null
  durationMs: number
  /** 排队等了多久（v0.9.100）：0 / 缺省 = 没排过队 */
  queuedMs?: number
  total: number
  startedNodes?: number
  canceled?: boolean
  nodes?: RunNode[]
  error?: string | null
  credits?: { cost: number; balance: number | null; refunded: boolean; kept?: number; refundedAmount?: number } | null
}

export type RunsResponse = {
  items: RunItem[]
  total: number
  offset?: number
  limit?: number
}

export type InstanceItem = {
  id: string
  pid: number
  host: string
  startedAt: string
  beatAt: string
  ageMs: number | null
  state: 'alive' | 'stale' | 'dead' | 'restarted' | 'bad'
  alive: boolean
  self: boolean
}

export type InstancesResponse = {
  self: string
  beatMs: number
  ttlMs: number
  heartbeatError: string
  items: InstanceItem[]
}

export type AuditItem = {
  id: string
  at: string
  actorId: string
  actorEmail: string
  action: string
  actionLabel: string
  targetType: string
  targetId: string
  targetLabel: string
  detail: unknown
  ip: string
  traceId: string
}

export type AuditResponse = {
  items: AuditItem[]
  total: number
  limit: number
  offset: number
  actions: { value: string; label: string }[]
}

export type VersionInfo = {
  version: string
  name: string
  startedAt: string
  // B9：登录后才有；运行时 Node 版本与支持范围，版本不匹配时后台能直接看出来
  runtime?: { node: string; min: string; level: 'supported' | 'untested' | 'too-old' | 'invalid'; supported: boolean }
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
