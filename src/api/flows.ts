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
  /** 续跑时这个节点没有重新执行：结果来自上一次运行（v0.9.102） */
  reused?: boolean
}

export type RunCredits = {
  cost: number
  balance: number | null
  refunded: boolean
  /** 主动停止时按已开始节点留下的部分（v0.9.101）；全额退 / 没结算时缺省 */
  kept?: number
  refundedAmount?: number
  /** true = 按已跑节点结过账，收尾时不会再全额退（v0.9.101） */
  settled?: boolean
}

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

/**
 * 一次运行开始时的画布快照（v0.9.107）：位置、标题、参数、连线都在里面。
 * 只有单条运行详情会带；旧运行没有这一项，页面必须如实退回「取当前画布」。
 */
export type RunGraphSnapshot = {
  capturedAt: string
  flowRevision: string
  nodes: ApiFlowNode[]
  edges: ApiFlowEdge[]
}

export type RunRecord = {
  id: string
  flowId: string
  flowName: string
  // queued = 还在整机队里等名额（没开始跑、没扣积分）；interrupted = 进程重启 / 停机打断，已按账本退回积分
  status: 'success' | 'error' | 'running' | 'queued' | 'interrupted'
  startedAt: string
  /** 排队单从哪一刻开始等（v0.9.98）；没排过队的是 null / 缺省 */
  queuedAt?: string | null
  /** 排队一共等了多久（v0.9.100）：0 / 缺省 = 没排过队；终态记录也保留 */
  queuedMs?: number
  finishedAt: string | null
  durationMs: number
  total: number
  /** 已经开始的节点数：主动停止时按它结算（v0.9.101） */
  startedNodes?: number
  /** 已经跑完的节点数；续跑时包含上次复用过来的节点（v0.9.102） */
  finishedNodes?: number
  /** 续跑：这条运行接着哪条跑 */
  resumeOf?: string | null
  /** 续跑：这次直接复用了几个上次已经跑完的节点 */
  reusedNodes?: number
  /** 续跑：本次按几个节点计费（不含复用节点） */
  billTotal?: number
  billFinished?: number
  /** 有已跑完的节点、也还有没跑的，才给「继续跑」入口 */
  resumable?: boolean
  /** 上次运行时这张画布的整图内容指纹（诊断用；局部复用看 nodeRevisions） */
  flowRevision?: string
  /** 上次运行时每个节点的内容指纹：续跑时只复用指纹没变的节点（v0.9.103） */
  nodeRevisions?: Record<string, string>
  /** true = 用户停止 / 页面断开导致的中断，不是服务重启 */
  canceled?: boolean
  nodes: RunNodeResult[]
  output: string
  error?: string | null
  /** 本次运行扣的积分；失败会退回，refunded=true */
  credits?: RunCredits | null
  /** 属于哪条作品的哪一版；没挂在作品上为 null / 缺省 */
  project?: RunProjectRef | null
  /** 这次运行开始时的画布快照；只有详情接口带，旧运行时缺省 */
  graph?: RunGraphSnapshot | null
}

/** 续跑预检（v0.9.103）：只读，不扣费。页面按它显示还能复用几个、改过几个、补多少。 */
export type RunResumePlan = {
  ok: boolean
  runId: string
  flowId: string
  /** 当前画布一共几个节点 */
  total: number
  /** 内容没变、可以直接复用的旧结果 */
  reused: number
  /** 这次还要执行的节点（改过的、新增的、没跑完的） */
  rerun: number
  /** 上次跑完了、但因为自己或上游改过而失效的节点 */
  stale: number
  /** 这次续跑要补多少积分 */
  cost: number
  resumable: boolean
  reason: string
}

/**
 * 运行对照（v0.9.110）：同一条画布的两条运行摆在一起。
 * 服务端只返回逐节点指纹与短预览；完整输出仍在单条运行详情里。
 */
export type RunCompareSide = {
  id: string
  status: RunRecord['status']
  canceled: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  queuedMs: number
  total: number
  finished: number
  failed: number
  /** 实际花掉的积分（退回来的不算） */
  cost: number
  refunded: boolean
}

export type RunCompareNodeSide = {
  status: RunNodeResult['status']
  ms: number
  error: string
  /** 首段预览，最多 180 字；完整内容去单条运行详情看 */
  preview: string
}

export type RunCompareNode = {
  id: string
  kind: FlowNodeKind
  title: string
  current: RunCompareNodeSide | null
  previous: RunCompareNodeSide | null
  /** 这条运行才有的节点 */
  added: boolean
  /** 上一条有、这条已经没有的节点 */
  removed: boolean
  statusChanged: boolean
  outputChanged: boolean
  /** 节点自己的参数、上游参数或入线变了（指纹变了） */
  revisionChanged: boolean
  msDelta: number | null
}

type RunCompareBase = {
  ok: true
  flowId: string
  flowName: string
  current: RunCompareSide
  /** 同一条画布上还能拿来对照的运行（不含自己，不含还在跑 / 排队的） */
  options: RunCompareSide[]
  optionsTotal: number
  /** 候选超过 20 条时只返回最近 20 条 */
  optionsTruncated: boolean
}

export type RunCompare = RunCompareBase &
  (
    | {
        comparable: false
        reason: string
      }
    | {
        comparable: true
        previous: RunCompareSide
        graph: { changed: boolean; unknown: boolean; currentRevision: string; previousRevision: string }
        nodes: RunCompareNode[]
        totals: {
          added: number
          removed: number
          statusChanged: number
          outputChanged: number
          revisionChanged: number
          unchanged: number
          changed: number
          durationDelta: number
          costDelta: number
          failedDelta: number
        }
      }
  )

/** 默认和同一条画布更早的那条比；传 withId 才点名另一条。 */
export const getRunCompare = (id: string, withId = '') =>
  request<RunCompare>(
    '/api/runs/' + encodeURIComponent(id) + '/compare' + (withId ? '?with=' + encodeURIComponent(withId) : ''),
  )

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

/** 续跑预检：只问不跑。画布改过之后，页面据此说清「哪几个还能复用」。 */
export const getRunResumePlan = (flowId: string, runId: string) =>
  request<RunResumePlan>('/api/flows/' + flowId + '/resume-plan?runId=' + encodeURIComponent(runId))

export type RunEventMessage =
  // 排过队才有这一条（v0.9.96）：从第几位开始等、等了多久，运行结论据此写「排队 N 秒后开始」
  | { type: 'run-queue'; position: number; waitedMs: number }
  | { type: 'run-start'; run: { id: string; flowId: string; flowName: string; total: number; resumeOf?: string | null; reusedNodes?: number } }
  | { type: 'node-start'; nodeId: string; index: number; total: number }
  | { type: 'node-end'; node: RunNodeResult; index: number; total: number }
  | { type: 'run-end'; run: RunRecord }
  | { type: 'run-error'; error: string; code?: string }

/** 停止一条已经开跑的运行（v0.9.101）：服务端中止当前上游，再按已开始节点结算。 */
export const stopRun = (id: string) =>
  request<{ ok: boolean; id: string; status: string }>('/api/runs/' + id + '/stop', { method: 'POST' })

/** 单条运行：从运行记录页点「继续运行」时，画布按地址里的 runId 把这条记录放回抽屉。 */
export async function getRun(id: string): Promise<RunRecord> {
  return request<RunRecord>('/api/runs/' + encodeURIComponent(id))
}

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
  /** 续跑（v0.9.102）：接着这条运行跑，只补没跑完的节点，只付没付过的那部分 */
  resumeOf = '',
): Promise<RunRecord> {
  const response = await fetch('/api/flows/' + id + '/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ticket ? { 'X-VQ-Queue-Ticket': ticket } : {}),
    },
    body: JSON.stringify({ stream: true, ...(resumeOf ? { resumeOf } : {}) }),
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
