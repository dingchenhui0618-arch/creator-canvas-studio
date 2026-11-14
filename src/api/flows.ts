import { request } from './client'
import type { FlowNodeKind, NodeConfig } from '../canvas/types'

// 与 server/flows.mjs 的字段保持一一对应；服务端会丢弃 status / ms 等运行态字段。

export type ApiFlowNode = {
  id: string
  type: FlowNodeKind
  position: { x: number; y: number }
  data: { kind: FlowNodeKind; title: string; description: string; config: NodeConfig }
}

export type ApiFlowEdge = {
  id: string
  source: string
  target: string
  sourceHandle: string | null
  targetHandle: string | null
}

export type ApiFlow = {
  id: string
  name: string
  description: string
  nodes: ApiFlowNode[]
  edges: ApiFlowEdge[]
  runCount: number
  lastRunId: string | null
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
  /**
   * 这块画布挂在哪条作品的第几版：画布页据此写「在帮《X》· 第 N 版」。
   * 空白画布（还没归作品的）是 null，页面什么也不写——不编一个「未命名作品」出来。
   */
  project?: RunProjectRef | null
}

export type FlowPayload = {
  name?: string
  description?: string
  nodes?: ApiFlowNode[]
  edges?: ApiFlowEdge[]
}

export type RunNodeResult = {
  id: string
  kind: FlowNodeKind
  title: string
  status: 'success' | 'error' | 'skipped' | 'unsupported'
  ms: number
  output: Record<string, unknown> | null
  error: string | null
  message: string | null
}

export type RunCredits = { cost: number; balance: number | null; refunded: boolean }

/**
 * 这条运行属于哪条作品的哪一版：服务端按画布指针现算，不带脚本与分享凭证。
 * 空白画布直接跑的运行没挂在任何作品上，就是 null。
 */
export type RunProjectRef = {
  id: string
  title: string
  version: number
  /** true = 这条运行跑的是归档的旧版画布 */
  archived: boolean
}

export type RunRecord = {
  id: string
  flowId: string
  flowName: string
  // interrupted = 进程重启 / 停机打断，已按账本退回积分
  status: 'success' | 'error' | 'running' | 'interrupted'
  startedAt: string
  finishedAt: string | null
  durationMs: number
  total: number
  nodes: RunNodeResult[]
  output: string
  error?: string | null
  /** 本次运行扣的积分；失败会退回，refunded=true */
  credits?: RunCredits | null
  /** 属于哪条作品的哪一版；没挂在作品上为 null / 缺省 */
  project?: RunProjectRef | null
}

export type RunList = { items: RunRecord[]; total: number; offset: number; limit: number }

export type RunQuery = {
  flowId?: string
  status?: '' | 'success' | 'error' | 'interrupted'
  q?: string
  limit?: number
  offset?: number
}

/**
 * 运行的排队位（v0.9.96）：名额满时服务端先收下这一单、排在整机的一条队里（与画布出图 / 评审同一条队）。
 * 票号是这次运行的凭据（页面自己生成），服务端只按它查名次——聚合数里看不到票号。
 */
export type RunQueueState = {
  ok: boolean
  kind: string
  /** 这一类每条最多等多久、最多几条同时排（0 = 这一档关掉了） */
  waitMs: number
  maxWaiting: number
  /** 整机现在几条在等、最久的那条等了多久（口径见 scope / countsScope） */
  waiting: number
  oldestWaitMs: number
  scope: 'lease' | 'process'
  countsScope: 'process'
  full: boolean
  /** 我这张票现在排第几；不在队里（还没登记 / 已排到 / 票不对）是 null */
  position: number | null
  ahead: number | null
  waitedMs: number
}

export const getRunQueue = (ticket: string) =>
  request<RunQueueState>('/api/runs/queue?ticket=' + encodeURIComponent(ticket))

export type RunEventMessage =
  // 排过队才有这一条（v0.9.96）：从第几位开始等、等了多久，运行结论据此写「排队 N 秒后开始」
  | { type: 'run-queue'; position: number; waitedMs: number }
  | { type: 'run-start'; run: { id: string; flowId: string; flowName: string; total: number } }
  | { type: 'node-start'; nodeId: string; index: number; total: number }
  | { type: 'node-end'; node: RunNodeResult; index: number; total: number }
  | { type: 'run-end'; run: RunRecord }
  | { type: 'run-error'; error: string; code?: string }

export async function listRuns(query: RunQuery = {}): Promise<RunList> {
  const params = new URLSearchParams()
  if (query.flowId) params.set('flowId', query.flowId)
  if (query.status) params.set('status', query.status)
  if (query.q) params.set('q', query.q)
  params.set('limit', String(query.limit ?? 20))
  params.set('offset', String(query.offset ?? 0))
  return request<RunList>('/api/runs?' + params.toString())
}

// 画布「另存为模板」：落到模板库的工作流条目，带 blueprint，之后能原样开回一张画布
export const saveFlowAsTemplate = (flowId: string, title?: string) =>
  request<{ ok: boolean; template: { id: string; title: string } }>('/api/templates', {
    method: 'POST',
    body: JSON.stringify({ from: 'flow', flowId, title }),
  })

// 同时发出的同一份列表请求只打一次：进画布时页头和画布视图会各要一次列表，
// 以前就是两条一模一样的 GET 并排飞出去。请求结束即释放，不做缓存，切回来仍拿最新数据。
let listInFlight: Promise<ApiFlow[]> | null = null

export function listFlows(): Promise<ApiFlow[]> {
  if (listInFlight) return listInFlight
  listInFlight = request<{ items: ApiFlow[]; total: number }>('/api/flows')
    .then((body) => body.items)
    .finally(() => {
      listInFlight = null
    })
  return listInFlight
}

export async function getFlow(id: string): Promise<ApiFlow> {
  return request<ApiFlow>('/api/flows/' + id)
}

export async function createFlow(payload: FlowPayload): Promise<ApiFlow> {
  return request<ApiFlow>('/api/flows', { method: 'POST', body: JSON.stringify(payload) })
}

export async function updateFlow(id: string, payload: FlowPayload): Promise<ApiFlow> {
  return request<ApiFlow>('/api/flows/' + id, { method: 'PATCH', body: JSON.stringify(payload) })
}

export async function deleteFlow(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/flows/' + id, { method: 'DELETE' })
}

/**
 * 流式运行：POST /api/flows/:id/run { stream: true }，服务端按 NDJSON 逐节点推送。
 * 这里直接用 fetch 读 body 流，request<T>() 只处理整段 JSON，不适用于流式响应。
 */
export async function runFlowStream(
  id: string,
  onEvent: (event: RunEventMessage) => void,
  /** 排队票号（v0.9.96）：页面自己生成，服务端按它认出「同一条」，不回写进响应 */
  ticket = '',
  /** 取消（v0.9.97）：abort 会把这条连接关掉，服务端据此退出排队——不占名额、不扣积分、不跑流程 */
  signal?: AbortSignal,
): Promise<RunRecord> {
  const response = await fetch('/api/flows/' + id + '/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ticket ? { 'X-VQ-Queue-Ticket': ticket } : {}),
    },
    body: JSON.stringify({ stream: true }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text()
    let message = 'HTTP ' + response.status
    try {
      const body = JSON.parse(text) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      if (text) message = text.slice(0, 200)
    }
    throw new Error(message)
  }
  if (!response.body) throw new Error('浏览器不支持流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalRun: RunRecord | null = null

  const consume = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const event = JSON.parse(trimmed) as RunEventMessage
    if (event.type === 'run-error') throw new Error(event.error || '运行失败')
    onEvent(event)
    if (event.type === 'run-end') finalRun = event.run
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      consume(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer)
  if (!finalRun) throw new Error('运行流意外中断，没有收到 run-end')
  return finalRun
}
