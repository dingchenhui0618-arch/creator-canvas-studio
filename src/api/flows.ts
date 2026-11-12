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
  status: 'success' | 'error' | 'running'
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
  status?: '' | 'success' | 'error'
  q?: string
  limit?: number
  offset?: number
}

export type RunEventMessage =
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
): Promise<RunRecord> {
  const response = await fetch('/api/flows/' + id + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stream: true }),
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
