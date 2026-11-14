import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { canAccess } from './owner.mjs'
import { callTextModel } from './llm.mjs'
import { reviewVisual } from './review.mjs'
import { reviewIsolateConfig, runReviewIsolated } from './isolate.mjs'
import { listTemplates, templateStats } from './templates.mjs'
import { publicError } from './public-error.mjs'
import { preferenceModel } from './preferences.mjs'
import { outstandingCharge, refund } from './credits.mjs'
import { currentInstanceId, liveInstanceIds } from './instances.mjs'

// 画布流程：存储（data/flows.json）+ 运行记录（data/runs.json）+ 拓扑执行引擎。
// 原子写范式与 server/templates.mjs 一致：先写 .tmp，再 rename 覆盖。

export const NODE_KINDS = ['input', 'llm', 'kb', 'tool', 'condition', 'output', 'review']

export const TOOLS = [
  { id: 'templates.stats', label: '模板库统计', detail: '读取模板库总数与内容类型分布' },
  { id: 'templates.search', label: '模板检索', detail: '按上游文本作为关键词检索模板库' },
  { id: 'clock', label: '当前时间', detail: '返回服务端 ISO 时间，用于验证链路' },
]

export const REVIEW_PROFILES = [
  { id: 'brand', label: '品牌一致性', intent: '评审这张画面是否符合品牌一致性与内容调性' },
  { id: 'composition', label: '构图与主体', intent: '评审这张画面的构图、主体与裁切' },
  { id: 'copy', label: '文案与卖点', intent: '评审画面里的文字、卖点表达与可读性' },
  { id: 'a11y', label: '可读性与无障碍', intent: '评审对比度、字号与无障碍可读性' },
]

const flowsFile = path.join(config.dataDir, 'flows.json')
const runsFile = path.join(config.dataDir, 'runs.json')
// 画布快照单独放：运行记录列表只要结果，不要把几十张画的配置一起发给页面。
// 一次运行一个文件，读详情时才带上；清运行记录时一起清。
const runGraphsDir = path.join(config.dataDir, 'run-graphs')
const MAX_RUNS = 60
const MAX_TEXT = 4000

const DEFAULT_TITLES = {
  input: '新的输入',
  llm: '大模型调用',
  kb: '知识库检索',
  tool: '工具调用',
  condition: '条件分支',
  output: '流程输出',
  review: '视觉评审',
}

function defaultConfig(kind) {
  switch (kind) {
    case 'input':
      return { text: '' }
    case 'llm':
      return {
        // 留空 = 跟随账号偏好 / 平台默认；不要把平台模型名写死进流程数据
        model: '',
        temperature: 0.4,
        systemPrompt: '你是 VisionQA 的内容与视觉编导。基于用户提供的素材和知识库上下文，给出具体、可执行的创作建议，不要空泛。',
      }
    case 'kb':
      return { keyword: '', contentType: '', limit: 3 }
    case 'tool':
      return { toolName: 'templates.stats' }
    case 'condition':
      return { expression: 'length(upstream) >= 20' }
    case 'output':
      return { format: 'markdown' }
    case 'review':
      return { profile: 'brand', image: '' }
    default:
      return {}
  }
}

let flowCache = null
let runCache = null
let writeChain = Promise.resolve()
// 正在进程里跑的运行：停机时按这张表标中断 + 退款；跑完就从表里摘掉。
const activeRuns = new Map()

/** 串行化所有写盘操作，避免并发请求互相覆盖。 */
function enqueueWrite(task) {
  const next = writeChain.then(task, task)
  writeChain = next.catch(() => {})
  return next
}

function clip(value, max = MAX_TEXT) {
  return String(value ?? '').slice(0, max)
}

function trimText(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num * 100) / 100))
}

function normalizeKind(value) {
  return NODE_KINDS.includes(value) ? value : 'input'
}

function normalizeConfig(kind, raw) {
  const base = defaultConfig(kind)
  const source = raw && typeof raw === 'object' ? raw : {}
  switch (kind) {
    case 'input':
      return { text: clip(source.text ?? base.text, 8000) }
    case 'llm':
      return {
        model: trimText(source.model, 80),
        temperature: clampNumber(source.temperature, 0, 2, base.temperature),
        systemPrompt: clip(source.systemPrompt ?? base.systemPrompt, 4000),
      }
    case 'kb':
      return {
        keyword: trimText(source.keyword, 120),
        contentType: trimText(source.contentType, 40),
        limit: Math.round(clampNumber(source.limit, 1, 8, base.limit)),
      }
    case 'tool':
      return { toolName: TOOLS.some((tool) => tool.id === source.toolName) ? source.toolName : base.toolName }
    case 'condition':
      return { expression: trimText(source.expression, 200) || base.expression }
    case 'output':
      return { format: source.format === 'text' ? 'text' : 'markdown' }
    case 'review':
      return {
        profile: REVIEW_PROFILES.some((item) => item.id === source.profile) ? source.profile : base.profile,
        image: trimText(source.image, 300),
      }
    default:
      return {}
  }
}

function normalizeNode(raw, index) {
  const kind = normalizeKind(raw?.type || raw?.data?.kind)
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : {}
  const x = Number(raw?.position?.x)
  const y = Number(raw?.position?.y)
  return {
    id: trimText(raw?.id, 64) || 'node-' + (index + 1),
    type: kind,
    position: {
      x: Number.isFinite(x) ? Math.round(x) : 0,
      y: Number.isFinite(y) ? Math.round(y) : 0,
    },
    data: {
      kind,
      title: trimText(data.title, 80) || DEFAULT_TITLES[kind],
      description: trimText(data.description, 240),
      config: normalizeConfig(kind, data.config),
    },
  }
}

function normalizeEdges(rawEdges, nodes) {
  const known = new Set(nodes.map((node) => node.id))
  const usedTargets = new Set()
  const edges = []
  for (const raw of Array.isArray(rawEdges) ? rawEdges : []) {
    const source = trimText(raw?.source, 64)
    const target = trimText(raw?.target, 64)
    if (!known.has(source) || !known.has(target) || source === target) continue
    const sourceHandle = raw?.sourceHandle ? trimText(raw.sourceHandle, 32) : null
    const targetHandle = raw?.targetHandle ? trimText(raw.targetHandle, 32) : null
    const targetKey = target + '::' + (targetHandle || 'in')
    // 每个输入端口只允许一根入线
    if (usedTargets.has(targetKey)) continue
    usedTargets.add(targetKey)
    edges.push({
      id: trimText(raw?.id, 64) || 'e-' + source + '-' + target + '-' + edges.length,
      source,
      target,
      sourceHandle,
      targetHandle,
    })
  }
  return edges
}

async function loadFlows() {
  if (flowCache) return flowCache
  try {
    const parsed = JSON.parse(await fsp.readFile(flowsFile, 'utf8'))
    flowCache = Array.isArray(parsed) ? parsed : []
  } catch {
    flowCache = []
  }
  return flowCache
}

async function persistFlows(list) {
  flowCache = list
  await fsp.mkdir(config.dataDir, { recursive: true })
  const tmp = flowsFile + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await fsp.rename(tmp, flowsFile)
}

async function loadRuns() {
  if (runCache) return runCache
  try {
    const parsed = JSON.parse(await fsp.readFile(runsFile, 'utf8'))
    runCache = Array.isArray(parsed) ? parsed : []
  } catch {
    runCache = []
  }
  return runCache
}

async function persistRuns(list) {
  runCache = list
  await fsp.mkdir(config.dataDir, { recursive: true })
  const tmp = runsFile + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await fsp.rename(tmp, runsFile)
}

// ---------- 运行画布快照 ----------

/** 快照文件名只认运行 id 里的安全字符，绝不把 URL 里的内容直接拼成路径。 */
function runGraphFile(runId) {
  const safe = String(runId || '').replace(/[^\w-]/g, '_')
  return path.join(runGraphsDir, safe + '.json')
}

/**
 * 一次运行开始时的画布快照：位置、标题、参数、连线都留在里面。
 * 运行记录本身只记节点结果（v0.9.106 之前连位置都没有），所以「回看」只能看现在的画布；
 * 从这一版起，新运行把当时那张画布也留下，旧运行仍按「取当前画布」如实回退。
 */
export function runGraphSnapshot(flow) {
  const nodes = (Array.isArray(flow?.nodes) ? flow.nodes : []).slice(0, 60).map(normalizeNode)
  return {
    capturedAt: new Date().toISOString(),
    flowRevision: flowRevisionOf(flow),
    nodes,
    edges: normalizeEdges(flow?.edges, nodes),
  }
}

/** 先写快照再写运行记录：写失败只退化为「没有快照」，不能因为留档失败把运行本身弄挂。 */
export async function saveRunGraph(runId, flow) {
  const id = String(runId || '')
  if (!id) return null
  const snapshot = runGraphSnapshot(flow)
  await fsp.mkdir(runGraphsDir, { recursive: true })
  const file = runGraphFile(id)
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(snapshot), 'utf8')
  await fsp.rename(tmp, file)
  return snapshot
}

/** 读一次运行的画布快照；没有 / 损坏 / 旧格式都返回 null，页面据此回退到当前画布。 */
export async function loadRunGraph(runId) {
  const id = String(runId || '')
  if (!id) return null
  try {
    const parsed = JSON.parse(await fsp.readFile(runGraphFile(id), 'utf8'))
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 这次运行有没有留下画布快照：作品页对「画布已删除」的运行要据此决定
 * 还开不开「查看运行」。只 stat 文件，不读整张画布，列表里查 20 条也不重。
 */
export async function hasRunGraph(runId) {
  const id = String(runId || '')
  if (!id) return false
  try {
    await fsp.access(runGraphFile(id))
    return true
  } catch {
    return false
  }
}

async function deleteRunGraphs(runIds = []) {
  for (const id of runIds) {
    try {
      await fsp.unlink(runGraphFile(id))
    } catch {
      // 没有快照或已经删过：清理不能影响运行记录本身
    }
  }
}

// ---------- 流程 CRUD ----------

export async function listFlows(user = null) {
  const list = (await loadFlows()).filter((item) => canAccess(item, user))
  return [...list].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export async function getFlow(id, user = null) {
  const list = await loadFlows()
  return list.find((item) => item.id === id && canAccess(item, user)) || null
}

export async function createFlow(input = {}, user = null) {
  const nodes = (Array.isArray(input.nodes) ? input.nodes : []).slice(0, 60).map(normalizeNode)
  const seen = new Set()
  const uniqueNodes = nodes.filter((node) => {
    if (seen.has(node.id)) return false
    seen.add(node.id)
    return true
  })
  const now = new Date().toISOString()
  const flow = {
    id: 'flow_' + randomUUID().slice(0, 8),
    name: trimText(input.name, 60) || '未命名流程',
    description: trimText(input.description, 240),
    nodes: uniqueNodes,
    edges: normalizeEdges(input.edges, uniqueNodes),
    runCount: 0,
    lastRunId: null,
    lastRunAt: null,
    ownerId: user?.id || '',
    createdAt: now,
    updatedAt: now,
  }
  await enqueueWrite(async () => {
    const list = await loadFlows()
    await persistFlows([flow, ...list])
  })
  return flow
}

export async function updateFlow(id, patch = {}) {
  let updated = null
  await enqueueWrite(async () => {
    const list = await loadFlows()
    const index = list.findIndex((item) => item.id === id)
    if (index < 0) return
    const current = list[index]
    const next = { ...current }
    if (patch.name !== undefined) next.name = trimText(patch.name, 60) || current.name
    if (patch.description !== undefined) next.description = trimText(patch.description, 240)
    if (Array.isArray(patch.nodes)) {
      const nodes = patch.nodes.slice(0, 60).map(normalizeNode)
      const seen = new Set()
      next.nodes = nodes.filter((node) => {
        if (seen.has(node.id)) return false
        seen.add(node.id)
        return true
      })
    }
    if (Array.isArray(patch.edges)) next.edges = normalizeEdges(patch.edges, next.nodes)
    next.updatedAt = new Date().toISOString()
    const copy = [...list]
    copy[index] = next
    await persistFlows(copy)
    updated = next
  })
  return updated
}

export async function deleteFlow(id) {
  let removed = false
  await enqueueWrite(async () => {
    const list = await loadFlows()
    const next = list.filter((item) => item.id !== id)
    if (next.length === list.length) return
    await persistFlows(next)
    removed = true
  })
  return removed
}

// ---------- 运行记录 ----------

// flowIds 是关键词的补充命中集：运行只记画布名，搜作品名得由调用方先把这几块画布交进来
// （server/run-ownership.mjs 的 projectFlowsMatching）。它只扩大命中，不改变别的筛选。
export async function listRuns({ flowId = '', status = '', q = '', ownerId = '', flowIds = [], limit = 20, offset = 0 } = {}, user = null) {
  const list = (await loadRuns()).filter((run) => canAccess(run, user))
  const keyword = String(q || '').trim()
  let filtered = list
  if (flowId) filtered = filtered.filter((run) => run.flowId === flowId)
  // __none__ 是后台「未归属」筛选：积分制之前或本地演示产生的记录没有 ownerId
  if (ownerId === '__none__') filtered = filtered.filter((run) => !run.ownerId)
  else if (ownerId) filtered = filtered.filter((run) => (run.ownerId || '') === ownerId)
  // 落库终态：success / error / interrupted（进程重启或停机打断，钱已按账本退回）
  if (status === 'success' || status === 'error' || status === 'interrupted') filtered = filtered.filter((run) => run.status === status)
  const extraFlows = new Set((Array.isArray(flowIds) ? flowIds : []).filter(Boolean).map(String))
  if (keyword) {
    filtered = filtered.filter(
      (run) =>
        run.flowName.includes(keyword) ||
        run.id.includes(keyword) ||
        String(run.error || '').includes(keyword) ||
        extraFlows.has(run.flowId),
    )
  }
  const count = Math.min(50, Math.max(1, Number(limit) || 20))
  const start = Math.min(filtered.length, Math.max(0, Math.round(Number(offset) || 0)))
  return { items: filtered.slice(start, start + count), total: filtered.length, offset: start, limit: count }
}

export async function getRun(id, user = null) {
  const list = await loadRuns()
  return list.find((run) => run.id === id && canAccess(run, user)) || null
}

/**
 * 同一条画布上还能拿来对照的运行（v0.9.111）：排除自己，也排除还在跑 / 排队的。
 * 不走 /api/runs 的 50 条分页：对照的是正在看的那条，它可能已经排到历史窗口末端。
 * 不分「更早」和「更晚」——默认仍取更早的一条，但用户可以在弹窗里点名任意一条，
 * 最早那条运行也能回头挑之后的一次来看。列表按开始时间倒序，最近的在前。
 */
export async function compareOptionsOf(run, user = null) {
  if (!run) return { items: [], total: 0 }
  const peers = (await loadRuns())
    .filter((item) => canAccess(item, user))
    .filter((item) => item.flowId === run.flowId && item.id !== run.id)
    .filter((item) => item.status !== 'running' && item.status !== 'queued')
  peers.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
  return { items: peers, total: peers.length }
}

/**
 * 一行运行记录的摘要：作品页运行归集用它，不带 nodes 的逐节点输出（一次运行的 output 可能很大）。
 * 失败原因、耗时、节点数、扣了多少积分都留着——归集要回答的是「这条作品跑过几次、成没成」。
 */
export function runSummary(run) {
  return {
    id: run.id,
    flowId: run.flowId,
    flowName: run.flowName,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || '',
    durationMs: Number(run.durationMs) || 0,
    // 排队等了多少毫秒（0 = 没排过队）：作品页与运行详情用同一个数说「等 + 跑」
    queuedMs: Number(run.queuedMs) || 0,
    total: Number(run.total) || 0,
    startedNodes: Number(run.startedNodes) || 0,
    finishedNodes: Number(run.finishedNodes) || 0,
    // 续跑（v0.9.102）：这条是接着哪条跑、复用了几个已经跑完的节点、本次按几个节点计费
    resumeOf: run.resumeOf || null,
    reusedNodes: Number(run.reusedNodes) || 0,
    billTotal: Number(run.billTotal) || 0,
    billFinished: Number(run.billFinished) || 0,
    // 有已跑完的节点、也还有没跑的，才给「继续跑」入口；0 节点中断（重启）不能续
    resumable: canResumeRun(run),
    canceled: Boolean(run.canceled),
    failed: (Array.isArray(run.nodes) ? run.nodes : []).filter((node) => node.status === 'error').length,
    error: run.error || '',
    credits: run.credits ? {
      cost: Number(run.credits.cost) || 0,
      refunded: Boolean(run.credits.refunded),
      // 主动停止是按已开始节点结算的：页面要能说清「扣了多少、退了多少」，不能只写一个已退
      ...(run.credits.settled ? {
        kept: Number(run.credits.kept) || 0,
        refundedAmount: Number(run.credits.refundedAmount) || 0,
      } : {}),
    } : null,
  }
}

/**
 * 一个作品的运行归集：当前版与归档版的所有画布一起取，按开始时间倒序。
 * 以前运行记录只按 flowId 筛，开一版新的之后旧版的运行就再也找不回来了；
 * 这里把作品名下所有版本画布的运行合成一条时间线，byFlow 再给版本对照提供每版跑了几次。
 */
export async function listRunsByFlows(flowIds = [], { limit = 20, all = false } = {}, user = null) {
  const wanted = new Set((Array.isArray(flowIds) ? flowIds : []).filter(Boolean))
  if (!wanted.size) return { items: [], total: 0, byFlow: {}, creditsByFlow: {} }
  const list = (await loadRuns()).filter((run) => wanted.has(run.flowId) && canAccess(run, user))
  list.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  const count = Math.min(50, Math.max(1, Number(limit) || 20))
  const byFlow = {}
  // 这条作品上真正花掉的积分（v0.9.65）：退款的那几次不算——失败了钱已经回去了，
  // 再把它算进「花了多少」等于把退回来的钱又花一遍。
  const creditsByFlow = {}
  for (const run of list) {
    byFlow[run.flowId] = (byFlow[run.flowId] || 0) + 1
    if (run.credits) {
      // 失败全额退 = 没花；主动停止按已开始节点结算 = 只算留下的那一部分（v0.9.101）
      const spent = run.credits.settled
        ? Math.max(0, Number(run.credits.kept) || 0)
        : (run.credits.refunded ? 0 : Math.max(0, Number(run.credits.cost) || 0))
      if (spent > 0) creditsByFlow[run.flowId] = (creditsByFlow[run.flowId] || 0) + spent
    }
  }
  // all：花费明细要每一笔（作品页的运行归集只取前 20 条摘要），页面摘要仍按 limit 封顶
  return { items: (all ? list : list.slice(0, count)).map(runSummary), total: list.length, byFlow, creditsByFlow }
}

// ---------- 拓扑与执行 ----------

function topoSort(nodes, edges) {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of edges) {
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1)
    outgoing.get(edge.source)?.push(edge)
  }
  const queue = nodes.filter((node) => (indegree.get(node.id) || 0) === 0).map((node) => node.id)
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const edge of outgoing.get(id) || []) {
      const left = (indegree.get(edge.target) || 0) - 1
      indegree.set(edge.target, left)
      if (left === 0) queue.push(edge.target)
    }
  }
  if (order.length !== nodes.length) {
    const error = new Error('流程里有环，无法按拓扑序执行；请断开形成环路的连线')
    error.code = 'FLOW_CYCLE'
    throw error
  }
  return order
}

/**
 * 画布内容的执行指纹：只算节点 id / 类型 / 配置和连线，不算位置。
 * 续跑要复用上次的节点输出；如果用户在这中间改了提示词、换了模型或改了连线，
 * 旧输出就不再属于这张画布，宁可拒绝复用，也不能把过期结果接着往下跑。
 */
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map((item) => stableJson(item)).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * 逐节点的内容指纹（v0.9.103）：节点自己的配置 + 所有上游节点的指纹 + 入线。
 * 只改下游节点时，上游节点仍然能复用；改提示词、换模型、改连线会沿着依赖链
 * 让这个节点和它的下游一起失效。位置、标题、描述不算内容——挪一下画布不该白跑。
 * 算法和 flowRevisionOf 分开：整图指纹继续用于诊断，局部复用看这张逐节点表。
 */
export function nodeRevisionsOf(flow) {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
  const edges = Array.isArray(flow?.edges) ? flow.edges : []
  const order = topoSort(nodes, edges)
  const incoming = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of edges) incoming.get(edge.target)?.push(edge)
  const revisions = new Map()
  for (const id of order) {
    const node = nodes.find((item) => item.id === id)
    if (!node) continue
    const parents = (incoming.get(id) || [])
      .map((edge) => ({
        source: String(edge.source || ''),
        sourceHandle: String(edge.sourceHandle || ''),
        targetHandle: String(edge.targetHandle || ''),
        revision: revisions.get(edge.source) || '',
      }))
      .sort((a, b) => (a.source + '\u0000' + a.sourceHandle + '\u0000' + a.targetHandle).localeCompare(b.source + '\u0000' + b.sourceHandle + '\u0000' + b.targetHandle))
    revisions.set(id, createHash('sha256').update(stableJson({
      id: String(node.id || ''),
      type: String(node.type || node.data?.kind || ''),
      config: node.data?.config && typeof node.data.config === 'object' ? node.data.config : {},
      incoming: parents,
    })).digest('hex').slice(0, 16))
  }
  return Object.fromEntries(revisions)
}

export function flowRevisionOf(flow) {
  const nodes = (Array.isArray(flow?.nodes) ? flow.nodes : [])
    .map((node) => ({
      id: String(node.id || ''),
      type: String(node.type || node.data?.kind || ''),
      config: node.data?.config && typeof node.data.config === 'object' ? node.data.config : {},
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const edges = (Array.isArray(flow?.edges) ? flow.edges : [])
    .map((edge) => ({
      source: String(edge.source || ''),
      target: String(edge.target || ''),
      sourceHandle: edge.sourceHandle || '',
      targetHandle: edge.targetHandle || '',
    }))
    .sort((a, b) => (a.source + '\u0000' + a.target + '\u0000' + a.sourceHandle + '\u0000' + a.targetHandle).localeCompare(b.source + '\u0000' + b.target + '\u0000' + b.sourceHandle + '\u0000' + b.targetHandle))
  return createHash('sha256').update(JSON.stringify({ nodes, edges })).digest('hex').slice(0, 16)
}

/** 这次运行已经真正付掉的积分：主动停止按结算数，失败 / 重启全额退是 0。 */
export function spentOfRun(run) {
  if (!run || !run.ownerId) return 0
  if (run.credits?.settled === true) {
    // 老记录可能只有 refundedAmount：按「原价减已退」还原，不能把已经退掉的又当成已付
    if (run.credits.kept !== undefined) return Math.max(0, Number(run.credits.kept) || 0)
    return Math.max(0, (Number(run.credits.cost) || 0) - (Number(run.credits.refundedAmount) || 0))
  }
  if (run.credits?.refunded) return 0
  return Math.max(0, Number(run.credits?.cost) || 0)
}

/** 续跑还要补多少积分：上次原价减去已经留下的部分，绝不按二次全价收。 */
export function resumeCostOf(run, price = 0) {
  if (!run || !run.ownerId) return 0
  const cost = Math.max(0, Number(run.credits?.cost) || Number(price) || 0)
  if (!cost) return 0
  // 主动停止已经按「跑完节点」结过账：补的正好是账本里还没付的那部分。
  // 失败 / 重启是全额退：按剩下节点占全图的比例收，不按整张画布再收一遍。
  if (run.credits?.settled === true) return Math.max(0, cost - spentOfRun(run))
  const total = Math.max(1, Number(run.total) || 1)
  const done = (Array.isArray(run.nodes) ? run.nodes : [])
    .filter((node) => node.status === 'success' || node.status === 'unsupported').length
  const left = Math.max(0, Math.min(total, total - done))
  return left > 0 ? Math.min(cost, Math.ceil((cost * left) / total)) : 0
}

/** 这条运行值不值得给「继续跑」：必须已经结束、至少跑完一个节点、还有没跑完的节点。 */
export function canResumeRun(run) {
  if (!run || (run.status !== 'error' && run.status !== 'interrupted')) return false
  const nodes = Array.isArray(run.nodes) ? run.nodes : []
  const done = nodes.filter((node) => node.status === 'success' || node.status === 'unsupported').length
  return done > 0 && done < (Number(run.total) || 0)
}

/**
 * 从上次运行里挑出可以原样复用的节点结果（v0.9.103 起按节点逐个判断）：
 *   - 只复用 success / unsupported，失败节点和它下游要重跑；
 *   - 节点自己的配置或任何上游变了，这个节点就不能复用；没改的上游仍然复用；
 *   - 条件节点的分支结果也一起带回来，否则续跑会把已经走过的分支再走错；
 *   - 只认当前画布里还存在的节点，画布删了节点就自然不复用。
 * 返回的 results / edgeActive 直接喂给 runFlow，省掉已经花过钱的那几步。
 */
export function resumeSeedFor(run, flow) {
  const nodesById = new Map((Array.isArray(flow?.nodes) ? flow.nodes : []).map((node) => [node.id, node]))
  const currentRevisions = nodeRevisionsOf(flow)
  const priorRevisions = run?.nodeRevisions && typeof run.nodeRevisions === 'object' ? run.nodeRevisions : null
  const hasPriorRevisions = Boolean(priorRevisions && Object.keys(priorRevisions).length)
  // 老运行只有整图指纹：画布没改就照旧整批复用，改了就没有可证明没变的节点。
  const wholeMatches = !run?.flowRevision || run.flowRevision === flowRevisionOf(flow)
  const results = new Map()
  let staleCount = 0
  for (const item of Array.isArray(run?.nodes) ? run.nodes : []) {
    if (!item) continue
    if (item.status !== 'success' && item.status !== 'unsupported') continue
    if (!nodesById.has(item.id)) {
      staleCount += 1
      continue
    }
    const same = hasPriorRevisions
      ? priorRevisions[item.id] === currentRevisions[item.id]
      : wholeMatches
    if (!same || !currentRevisions[item.id]) {
      staleCount += 1
      continue
    }
    const node = nodesById.get(item.id)
    results.set(item.id, {
      id: item.id,
      kind: node.type,
      title: node.data?.title || item.title || item.id,
      status: item.status,
      ms: 0,
      output: item.output ?? null,
      error: null,
      message: '上次已经跑完，内容没变，这次直接复用',
      reused: true,
    })
  }
  const edgeActive = new Map()
  for (const edge of Array.isArray(flow?.edges) ? flow.edges : []) {
    const source = results.get(edge.source)
    if (!source) continue
    const sourceNode = nodesById.get(edge.source)
    let active = source.status === 'success' || source.status === 'unsupported'
    const branch = source.output && typeof source.output.branch === 'string' ? source.output.branch : null
    if (active && sourceNode?.type === 'condition') {
      active = (branch || 'false') === (edge.sourceHandle || 'true')
    }
    edgeActive.set(edge.id, active)
  }
  return { results, edgeActive, reusedCount: results.size, staleCount }
}

/**
 * 续跑预检（v0.9.103）：页面在点「继续运行」之前先问一次，别拿整条旧记录的总数
 * 当成还能复用几个。返回的 seed 只在服务端使用，路由不会把它序列化给页面。
 */
export function resumePlanFor(run, flow, price = 0) {
  const seed = resumeSeedFor(run, flow)
  const total = Array.isArray(flow?.nodes) ? flow.nodes.length : 0
  const rerun = Math.max(0, total - seed.reusedCount)
  let reason = ''
  if (!canResumeRun(run)) reason = '这条运行没有可复用的已跑节点：重新运行会用最新画布从头跑'
  else if (!seed.reusedCount) reason = '画布改动后没有能原样复用的节点：重新运行会用最新画布从头跑'
  else if (!rerun) reason = '画布里的节点都已经跑过了，没有还要补的'
  const resumable = Boolean(canResumeRun(run) && seed.reusedCount > 0 && rerun > 0)
  return {
    runId: run?.id || '',
    flowId: flow?.id || '',
    total,
    reused: seed.reusedCount,
    rerun,
    stale: seed.staleCount,
    cost: resumable ? resumeCostOf(run, price) : 0,
    resumable,
    reason,
    seed,
  }
}

function resolveValue(token, ctx) {
  const key = String(token ?? '').trim()
  const quoted = key.match(/^["']([\s\S]*)["']$/)
  if (quoted) return quoted[1]
  if (/^-?\d+(\.\d+)?$/.test(key)) return Number(key)
  if (key === 'upstream' || key === 'text') return ctx.text
  if (key === 'input') return ctx.inputText
  throw new Error('未知变量：' + key + '（可用：upstream / input / 字符串字面量）')
}

/** 简单条件语法：contains(a, b) / equals(a, b) / startsWith(a, b) / length(upstream) >= 20 */
export function evaluateCondition(expression, ctx) {
  const expr = String(expression || '').trim()
  if (!expr) throw new Error('条件表达式为空')
  const fn = expr.match(/^(contains|equals|startsWith)\s*\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/i)
  let passed
  if (fn) {
    const name = fn[1].toLowerCase()
    const left = String(resolveValue(fn[2], ctx) ?? '')
    const right = String(resolveValue(fn[3], ctx) ?? '')
    if (name === 'contains') passed = left.includes(right)
    else if (name === 'equals') passed = left === right
    else passed = left.startsWith(right)
  } else {
    const cmp = expr.match(/^(?:length\s*\(\s*([a-zA-Z]+)\s*\)|([a-zA-Z]+))\s*(>=|<=|==|!=|>|<)\s*(.+)$/)
    if (!cmp) {
      throw new Error('条件表达式无法解析；示例：contains(upstream, "杯") 或 length(upstream) >= 20')
    }
    const value = cmp[1]
      ? String(resolveValue(cmp[1], ctx) ?? '').length
      : Number(resolveValue(cmp[2], ctx))
    const right = Number(String(cmp[4]).trim().replace(/^["']|["']$/g, ''))
    if (!Number.isFinite(right)) throw new Error('条件表达式右侧必须是数字')
    if (cmp[3] === '>=') passed = value >= right
    else if (cmp[3] === '<=') passed = value <= right
    else if (cmp[3] === '>') passed = value > right
    else if (cmp[3] === '<') passed = value < right
    else if (cmp[3] === '==') passed = value === right
    else passed = value !== right
  }
  return {
    passed,
    branch: passed ? 'true' : 'false',
    expression: expr,
    text: passed ? '条件命中（true 分支）' : '条件未命中（false 分支）',
  }
}

function collectContext(incomingEdges, results, nodesById) {
  const values = []
  const promptParts = []
  const contextParts = []
  for (const edge of incomingEdges) {
    const sourceResult = results.get(edge.source)
    if (!sourceResult || !sourceResult.output) continue
    const text = typeof sourceResult.output.text === 'string' ? sourceResult.output.text : ''
    const node = nodesById.get(edge.source)
    values.push({ nodeId: edge.source, title: node?.data?.title || edge.source, kind: node?.type || 'unknown', text })
    if (!text) continue
    const handle = edge.targetHandle || 'in'
    if (handle === 'prompt') promptParts.push(text)
    else if (handle === 'context') contextParts.push(text)
    else promptParts.push(text)
  }
  return {
    values,
    prompt: promptParts.join('\n\n'),
    context: contextParts.join('\n\n'),
    text: values.map((item) => item.text).filter(Boolean).join('\n\n'),
    inputText: values[0]?.text ?? '',
  }
}

async function runLlm(node, ctx) {
  const cfg = node.data.config
  const system = trimText(cfg.systemPrompt, 4000)
  const parts = []
  if (ctx.prompt) parts.push(ctx.prompt)
  if (ctx.context) parts.push('知识库 / 工具上下文：\n' + ctx.context)
  const userText = parts.join('\n\n') || '（没有上游输入）'
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: userText })
  // 复用 server/llm.mjs：同一套重试 + 降级链（首选节点配置的模型，再走全局 fallbacks）
  const result = await callTextModel(messages, {
    temperature: Number(cfg.temperature),
    // 1200 对「写一整条脚本」太紧：推理型模型把预算花在思考上，正文会被截断（2026-11-12 生产实测两条运行都挂在这里）。
    // 生产日志里 3000 / 4800 仍被截断，先把起点抬到 6000（truncation 时 llm.mjs 会放宽到 8000），
    // max_tokens 只是上限，实际按生成量计费，抬高它不会让正常调用变贵。
    maxTokens: 6000,
    // 节点没选模型时用画布主人的账号级首选模型；再后面才是全局降级链
    models: [cfg.model, ctx.ownerId ? preferenceModel(ctx.ownerId) : '', ...config.vision.fallbacks].filter(Boolean),
    log: (message) => console.log('[flows] ' + message),
    // 计量挂在「这次运行」上：同一张画布跑十遍，后台能看出十遍各花了多少 token
    meter: { ref: ctx.runId || '', projectId: ctx.projectId || '' },
    // 用户点「停止」时，正在等的这次上游调用要立刻中止，而不是等它自己超时（v0.9.101）
    signal: ctx.signal || undefined,
  })
  return { text: clip(result.text), model: result.model, temperature: cfg.temperature }
}

const MEDIA_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

async function loadReviewMedia(reference) {
  const raw = trimText(reference, 300)
  if (!raw) throw new Error('review 节点没有配置评审图片：在检查器里填写 data/ 下的帧路径（如 frames/tpl_xxx/frame-01.jpg）或图片 URL')
  if (/^https?:\/\//i.test(raw)) return { imageUrl: raw }
  const dataRoot = path.resolve(config.dataDir)
  const relative = raw.replace(/^\/+/, '').replace(/^data[\\/]/, '')
  const absolute = path.resolve(dataRoot, relative)
  if (absolute !== dataRoot && !absolute.startsWith(dataRoot + path.sep)) throw new Error('评审图片路径越界：' + raw)
  const bytes = await fsp.readFile(absolute)
  return { imageBytes: bytes, mime: MEDIA_MIME[path.extname(absolute).toLowerCase()] || 'image/jpeg' }
}

async function runReview(node, ctx = {}) {
  const cfg = node.data.config
  const profile = REVIEW_PROFILES.find((item) => item.id === cfg.profile) || REVIEW_PROFILES[0]
  const media = await loadReviewMedia(cfg.image)
  // 复用 server/review.mjs：优先 VisionQA 插件服务，不可用再走本地模型，并如实标注 provider。
  // 画布运行里的评审同样吃内存，和 /api/review 一样放进独立 worker（v0.9.77）。
  const job = { ...media, intent: profile.intent, ref: ctx.runId || '' }
  const writeLog = (message) => console.log('[flows] ' + message)
  const result = reviewIsolateConfig().enabled
    ? await runReviewIsolated(job, { log: writeLog, signal: ctx.signal })
    : await reviewVisual({ ...job, log: writeLog, signal: ctx.signal })
  const observations = Array.isArray(result.observations) ? result.observations : []
  const blockers = observations.filter((item) => item.severity === 'blocker').length
  const verdictLabel = { pass: '通过', needs_review: '待确认', fail: '有问题' }[result.verdict] || result.verdict
  const lines = [verdictLabel + '（' + result.verdict + '）· ' + result.summary]
  for (const item of observations.slice(0, 3)) lines.push('- [' + item.severity + '] ' + item.statement)
  return {
    verdict: result.verdict,
    summary: result.summary,
    profile: profile.id,
    provider: result.provider,
    mode: result.mode,
    note: result.note,
    observationCount: observations.length,
    blockerCount: blockers,
    fixes: (result.fixes || []).slice(0, 5),
    text: clip(lines.join('\n')),
  }
}

async function runKb(node, ctx) {
  const cfg = node.data.config
  const keyword = trimText(cfg.keyword, 120) || trimText(ctx.text, 60)
  const items = (await listTemplates({ q: keyword, contentType: cfg.contentType })).slice(0, cfg.limit || 3)
  const rows = items.map((item) => ({
    id: item.id,
    title: item.title,
    contentType: item.contentType,
    platform: item.platform,
    hook: item.hook,
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : [],
    reusableRules: Array.isArray(item.analysis?.reusableRules) ? item.analysis.reusableRules.slice(0, 2) : [],
  }))
  const text = rows.length
    ? rows
        .map((row, index) => {
          const rules = row.reusableRules.length ? '｜可复用：' + row.reusableRules.join('；') : ''
          return index + 1 + '. 《' + row.title + '》(' + row.contentType + ') 钩子：' + row.hook + rules
        })
        .join('\n')
    : '模板库没有匹配项（关键词：' + (keyword || '空') + '）'
  return { count: rows.length, filters: { keyword, contentType: cfg.contentType || '全部', limit: cfg.limit }, items: rows, text }
}

async function runTool(node, ctx) {
  const toolName = node.data.config.toolName
  if (toolName === 'templates.stats') {
    const stats = await templateStats()
    return { toolName, result: stats, text: '模板库共 ' + stats.total + ' 条；' + Object.entries(stats.byType).map(([key, value]) => key + ' ' + value).join('，') }
  }
  if (toolName === 'templates.search') {
    const keyword = trimText(ctx.text, 60) || trimText(node.data.config.keyword, 60)
    const found = (await listTemplates({ q: keyword })).slice(0, 5)
    return { toolName, keyword, result: found.map((item) => ({ id: item.id, title: item.title, contentType: item.contentType })), text: found.length ? found.map((item) => '《' + item.title + '》').join('、') : '没有检索到模板' }
  }
  if (toolName === 'clock') {
    const now = new Date().toISOString()
    return { toolName, result: { now }, text: now }
  }
  throw new Error('未知工具：' + toolName)
}

function runOutput(ctx) {
  const parts = ctx.values.filter((item) => item.text)
  const text = parts.length
    ? parts.map((item) => '### ' + item.title + '\n' + item.text).join('\n\n')
    : '（上游没有可汇总的文本输出）'
  return { text: clip(text), sources: ctx.values.map((item) => ({ nodeId: item.nodeId, title: item.title, kind: item.kind })) }
}

async function executeNode(node, ctx) {
  switch (node.type) {
    case 'input':
      return { status: 'success', output: { text: node.data.config.text || '' } }
    case 'llm':
      return { status: 'success', output: await runLlm(node, ctx) }
    case 'kb':
      return { status: 'success', output: await runKb(node, ctx) }
    case 'tool':
      return { status: 'success', output: await runTool(node, ctx) }
    case 'condition':
      return { status: 'success', output: evaluateCondition(node.data.config.expression, ctx) }
    case 'output':
      return { status: 'success', output: runOutput(ctx) }
    case 'review':
      return { status: 'success', output: await runReview(node, ctx) }
    default:
      throw new Error('未知节点类型：' + node.type)
  }
}

function clipOutput(output) {
  if (!output || typeof output !== 'object') return output ?? null
  const copy = { ...output }
  if (typeof copy.text === 'string') copy.text = clip(copy.text)
  if (Array.isArray(copy.items)) copy.items = copy.items.slice(0, 8)
  return copy
}

// 启动迁移：老流程没有归属，认领给管理员
export async function adoptUnownedFlows(ownerId) {
  if (!ownerId) return 0
  let adopted = 0
  await enqueueWrite(async () => {
    const list = await loadFlows()
    const pending = list.filter((item) => !item.ownerId)
    if (!pending.length) return
    for (const item of pending) item.ownerId = ownerId
    adopted = pending.length
    await persistFlows(list)
  })
  return adopted
}

// 同一条运行会写两次（开始时落一笔、结束时落终态），所以按 id 覆盖而不是直接往前插：
// 否则一次运行在列表里会出现两条，一条永远挂在 running 上。
async function saveRun(run) {
  let dropped = []
  await enqueueWrite(async () => {
    const list = await loadRuns()
    const merged = [run, ...list.filter((item) => item.id !== run.id)]
    dropped = merged.slice(MAX_RUNS).map((item) => item.id)
    await persistRuns(merged.slice(0, MAX_RUNS))
  })
  // 记录被挤出历史窗口，它的画布快照也不该继续占盘
  if (dropped.length) await deleteRunGraphs(dropped)
}

async function touchFlowRun(flowId, run) {
  await enqueueWrite(async () => {
    const list = await loadFlows()
    const index = list.findIndex((item) => item.id === flowId)
    if (index < 0) return
    const next = [...list]
    next[index] = {
      ...next[index],
      runCount: (next[index].runCount || 0) + 1,
      lastRunId: run.id,
      lastRunAt: run.finishedAt,
    }
    await persistFlows(next)
  })
}

/** 一次运行的 id 在扣积分之前就要定下来：账本 ref 与运行记录用同一个 id，
 *  这样重启恢复能按账本净额退，而不用猜「这条扣费是哪次运行」。 */
export function newRunId() {
  return 'run_' + randomUUID().slice(0, 8)
}

/** 运行刚建出来、还没执行任何节点时的模样（落盘用的初始态）。
 *  queued = 这一单还在整机队里等名额：还没开始跑、也还没扣积分，运行记录该如实写「排队中」，
 *  不能先写成 running 让运行记录页把它当失败（v0.9.98）。 */
function blankRun(flow, id, cost = 0, { queued = false, resumeOf = '', reusedNodes = 0, billTotal = 0, flowRevision = '' } = {}) {
  const amount = Math.max(0, Math.round(Number(cost) || 0))
  const now = new Date().toISOString()
  return {
    id,
    flowId: flow.id,
    flowName: flow.name,
    status: queued ? 'queued' : 'running',
    // 这条记录归哪个实例执行：两份实例共用 DATA_DIR，启动恢复只收自己人的单
    ownerInstance: currentInstanceId(),
    // 排队单从哪一刻开始等：页面按它算「排队 12s」，翻成 running 之后不再变
    queuedAt: queued ? now : null,
    startedAt: now,
    finishedAt: null,
    durationMs: 0,
    total: 0,
    nodes: [],
    output: '',
    ownerId: flow.ownerId || '',
    // 续跑：这条记录接着哪条跑、复用几个节点、本次按几个节点计费、跑的是哪一版画布
    resumeOf: resumeOf || null,
    reusedNodes: Math.max(0, Math.round(Number(reusedNodes) || 0)),
    billTotal: Math.max(0, Math.round(Number(billTotal) || 0)),
    billFinished: 0,
    flowRevision: flowRevision || '',
    credits: amount > 0 ? { cost: amount, refunded: false } : null,
  }
}

/** 扣积分之前先把运行记录落一笔：扣完马上断电也留得下这条单，恢复时按账本退。 */
export async function startFlowRun(flow, runId, { cost = 0, queued = false, resumeOf = '', reusedNodes = 0, billTotal = 0, flowRevision = '' } = {}) {
  const run = blankRun(flow, String(runId || '') || newRunId(), cost, { queued, resumeOf, reusedNodes, billTotal, flowRevision })
  await saveRun(run)
  return run
}

/**
 * 排到名额、钱也扣成功了：记录从「排队中」翻成「运行中」。
 * 为什么不等 runFlow 自己落盘再说：扣费已经发生，万一进程在这两步之间被杀，
 * 启动恢复只能按记录状态判断——记录还写着 queued 就会被当成「没花过钱」清掉，账就对不上了。
 * 反复调用无副作用：已经是 running 的记录原样返回，不会把开始时间往后推。
 */
export async function markRunStarted(runId) {
  const id = String(runId || '')
  if (!id) return null
  return enqueueWrite(async () => {
    const list = await loadRuns()
    const index = list.findIndex((item) => item.id === id)
    if (index < 0) return null
    if (list[index].status !== 'queued') return list[index]
    const startedAt = new Date().toISOString()
    const queuedAt = Date.parse(String(list[index].queuedAt || ''))
    const next = {
      ...list[index],
      status: 'running',
      startedAt,
      queuedMs: Number.isFinite(queuedAt) ? Math.max(0, Date.parse(startedAt) - queuedAt) : 0,
    }
    const copy = [...list]
    copy[index] = next
    await persistRuns(copy)
    return next
  })
}

/** 只给「记录建了、钱还没扣成功」这一刻用：撤掉占位记录，不留一条永远 running 的空单。 */
export async function dropRunRecord(runId) {
  const id = String(runId || '')
  if (!id) return false
  const list = await loadRuns()
  const next = list.filter((item) => item.id !== id)
  if (next.length === list.length) return false
  await persistRuns(next)
  await deleteRunGraphs([id])
  return true
}

/** 运行还没真正跑起来就抛错（例如有环）：占位记录标成失败，并按账本退款。 */
export async function abandonRun(runId, reason = '运行失败') {
  const id = String(runId || '')
  if (!id) return 0
  const list = await loadRuns()
  const run = list.find((item) => item.id === id)
  if (!run) return 0
  if (run.status === 'running' || run.status === 'queued') {
    run.status = 'error'
    run.finishedAt = new Date().toISOString()
    run.error = String(reason || '运行失败').slice(0, 500)
  }
  refundRunCredits(run)
  await persistRuns(list)
  return 1
}

/**
 * 用户主动停止（v0.9.101）：按「已经跑完的节点」结算，没跑完的部分退回。
 * 为什么不是全额退：模型调用已经发生、上游可能已经计费；为什么不是不退：
 * 停下来的用户没有拿到结果，剩下的节点一分钱都不该收。
 * 只有结算成功才写 settled=true；写失败就留给收尾那条路径全额退，宁可多退用户，不少退。
 */
export function settleCanceledRun(run) {
  if (!run || !run.ownerId || !run.id) return 0
  const cost = Math.max(0, Math.round(Number(run.credits?.cost) || 0))
  // 续跑只按「这次要跑的节点」结算：复用的节点上次已经付过钱，不能再算进分母。
  // 老记录没有 billTotal / billFinished，回落到 total / finishedNodes，口径不变。
  const total = Math.max(1, Number(run.billTotal) || Number(run.total) || 1)
  const completed = Math.max(0, Math.min(total, Number(run.billFinished ?? run.finishedNodes) || 0))
  // 向上取整：只要动过一个节点，就至少留下 1 积分；一个节点都没跑完则一分不留
  const kept = completed > 0 ? Math.min(cost, Math.ceil((cost * completed) / total)) : 0
  let owed = 0
  try {
    owed = outstandingCharge(run.ownerId, 'flow_run', run.id)
  } catch (error) {
    console.error('[flows] 核对停止运行的账本失败：' + String(error && error.message ? error.message : error))
    return 0
  }
  const back = Math.max(0, owed - kept)
  try {
    if (back > 0) refund(run.ownerId, 'flow_run', { ref: run.id, amount: back })
    run.credits = {
      ...(run.credits || {}),
      cost,
      kept,
      refunded: back > 0,
      refundedAmount: back,
      settled: true,
    }
    return back
  } catch (error) {
    console.error('[flows] 停止运行的退款失败（应退 ' + back + ' 积分）：' + String(error && error.message ? error.message : error))
    return 0
  }
}

/** 按账本净额退这次运行还欠的积分：重复调用算出 0，不会多退。 */
export function refundRunCredits(run) {
  if (!run || !run.ownerId || !run.id) return 0
  // 停止运行已经按「已跑节点」结过账：收尾时不能再把剩下的钱退一遍
  if (run.credits?.settled === true) return 0
  let owed = 0
  try {
    owed = outstandingCharge(run.ownerId, 'flow_run', run.id)
  } catch (error) {
    console.error('[flows] 核对运行账本失败：' + String(error && error.message ? error.message : error))
    return 0
  }
  if (owed <= 0) return 0
  try {
    refund(run.ownerId, 'flow_run', { ref: run.id, amount: owed })
    run.credits = { ...(run.credits || {}), cost: Math.max(Number(run.credits?.cost) || 0, owed), refunded: true }
    return owed
  } catch (error) {
    console.error('[flows] 运行积分退回失败（' + owed + ' 积分）：' + String(error && error.message ? error.message : error))
    return 0
  }
}

/**
 * 按拓扑序执行整张画布。
 * onEvent 用于流式输出：run-start / node-start / node-end / run-end / run-error。
 */
export async function runFlow(flow, { onEvent, credits = null, runId = '', resume = null } = {}) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {}
  const order = topoSort(flow.nodes, flow.edges)
  // 续跑：resume.results / edgeActive 是上次运行留下的真结果（见 resumeSeedFor）。
  // 这里不重新调用上游，直接把结果放回上下文；计费分母只算这次还要跑的节点。
  const resumeResults = resume?.results instanceof Map ? resume.results : new Map()
  const resumeEdges = resume?.edgeActive instanceof Map ? resume.edgeActive : new Map()
  const resumedCount = resumeResults.size
  const billTotal = Math.max(0, order.length - resumedCount)
  const nodesById = new Map(flow.nodes.map((node) => [node.id, node]))
  const incoming = new Map(flow.nodes.map((node) => [node.id, []]))
  const outgoing = new Map(flow.nodes.map((node) => [node.id, []]))
  for (const edge of flow.edges) {
    incoming.get(edge.target)?.push(edge)
    outgoing.get(edge.source)?.push(edge)
  }

  const startedAt = Date.now()
  const id = String(runId || '') || newRunId()
  // 用户停止的通道：控制器挂在 run 上，但做成不可枚举——运行记录要原样落盘，
  // 不能把一个 AbortController 写进 JSON。停止请求按 runId 找到它并 abort。
  const stopController = new AbortController()
  // runFlow 会用这个对象覆盖同 id 的占位记录：占位记录上的字段必须跟着写回去。
  // 排队时长是 markRunStarted 算好的真数（v0.9.100）；这里漏接的话，排队单跑完就再也
  // 说不清「一共等了多久」——页面只剩节点耗时，用户会以为一次 50 秒的等待只花了 7 秒。
  const placeholder = runId ? (await loadRuns()).find((item) => item.id === id) : null
  const reusedNodes = order
    .filter((nodeId) => resumeResults.has(nodeId))
    .map((nodeId) => resumeResults.get(nodeId))
  const run = {
    id,
    flowId: flow.id,
    flowName: flow.name,
    status: 'running',
    // runFlow 会用这个对象覆盖同 id 的占位记录：实例归属必须跟着写回去
    ownerInstance: currentInstanceId(),
    // 排队从哪一刻开始、等了多久：只有占位记录上有，终态也要留着
    queuedAt: placeholder?.queuedAt || null,
    queuedMs: Math.max(0, Math.round(Number(placeholder?.queuedMs) || 0)),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationMs: 0,
    total: order.length,
    // 已经开始 / 已经跑完的节点数：停止时按「跑完的节点」结算。
    // 正在跑的那个节点不算钱：它的结果用户没拿到，停下来的这次运行不该为它收费。
    startedNodes: 0,
    finishedNodes: resumedCount,
    // 续跑：复用了几个上次已跑完的节点；本次计费只看 billTotal / billFinished
    resumeOf: resume?.of || placeholder?.resumeOf || null,
    reusedNodes: resumedCount,
    billTotal,
    billFinished: 0,
    flowRevision: flowRevisionOf(flow),
    // 逐节点内容指纹：续跑时用来判断哪些旧结果还能原样复用（v0.9.103）
    nodeRevisions: nodeRevisionsOf(flow),
    nodes: reusedNodes,
    output: '',
    ownerId: flow.ownerId || '',
    // 本次运行实际扣了多少积分；失败会由路由层退回，refunded 在结束时标真
    credits: credits ? { cost: Math.round(Number(credits.cost) || 0), refunded: false } : null,
  }
  Object.defineProperty(run, '__stopController', { value: stopController, enumerable: false, configurable: true })
  // 先留画布快照、再落运行记录，最后才执行：快照对应的是这次真正要跑的那张图。
  // 留档失败只退化为「没有快照」，不能因为回看资料写不进去就不跑流程。
  try {
    await saveRunGraph(run.id, flow)
  } catch (error) {
    console.error('[flows] 运行画布快照写入失败（回看将退回当前画布）：' + String(error && error.message ? error.message : error))
  }
  // 先落盘再执行：以前只在结束时写运行记录，进程被杀就什么也不剩，
  // 已扣的积分在账本里也永远对不上是哪次运行。
  activeRuns.set(run.id, run)
  await saveRun(run)
  emit({
    type: 'run-start',
    run: {
      id: run.id,
      flowId: run.flowId,
      flowName: run.flowName,
      total: order.length,
      resumeOf: run.resumeOf,
      reusedNodes: resumedCount,
    },
  })

  const results = new Map(resumeResults)
  const edgeActive = new Map(resumeEdges)
  let errorCount = 0
  let startedNodes = 0

  // 复用的节点也要让页面看见：它们不重新跑，但结果、耗时归属和「上次已跑过」都要写清楚。
  // 先推 run-start 再补 node-end，页面的运行抽屉按顺序就能排出来。
  for (let index = 0; index < order.length; index += 1) {
    const reused = resumeResults.get(order[index])
    if (reused) emit({ type: 'node-end', node: reused, index, total: order.length })
  }

  for (let index = 0; index < order.length; index += 1) {
    // 停机收尾已经把这次运行标成中断并退了钱：后面的节点不再执行，别再产生上游费用
    if (run.aborted) break
    const node = nodesById.get(order[index])
    if (!node) continue
    // 上次已经跑完的节点直接跳过：结果已在 results / edgeActive 里，不再调上游也不重复计费
    if (resumeResults.has(node.id)) continue
    const inEdges = incoming.get(node.id) || []
    const activeIn = inEdges.filter((edge) => edgeActive.get(edge.id) === true)
    const entry = inEdges.length === 0

    if (!entry && activeIn.length === 0) {
      const skipped = {
        id: node.id,
        kind: node.type,
        title: node.data.title,
        status: 'skipped',
        ms: 0,
        output: null,
        error: null,
        message: '上游未执行或条件分支未命中',
      }
      results.set(node.id, skipped)
      run.nodes.push(skipped)
      for (const edge of outgoing.get(node.id) || []) edgeActive.set(edge.id, false)
      emit({ type: 'node-end', node: skipped, index, total: order.length })
      continue
    }

    emit({ type: 'node-start', nodeId: node.id, index, total: order.length })
    startedNodes += 1
    run.startedNodes = startedNodes
    const nodeStartedAt = Date.now()
    let result
    try {
      const ctx = {
        ...collectContext(activeIn, results, nodesById),
        ownerId: flow.ownerId || '',
        runId: run.id,
        signal: stopController.signal,
      }
      const executed = await executeNode(node, ctx)
      result = {
        id: node.id,
        kind: node.type,
        title: node.data.title,
        status: executed.status || 'success',
        ms: Date.now() - nodeStartedAt,
        output: clipOutput(executed.output),
        error: null,
        message: null,
      }
    } catch (error) {
      // 用户停止导致的中止不是「这个节点失败」：不留一条假错误，直接进入中断收尾
      if (run.aborted) break
      result = {
        id: node.id,
        kind: node.type,
        title: node.data.title,
        status: 'error',
        ms: Date.now() - nodeStartedAt,
        output: null,
        // 这里会原样显示在画布、运行记录和后台审计里：只放产品语言
        error: clip(publicError(error, '这个节点执行失败，请稍后重试'), 500),
        message: null,
      }
      errorCount += 1
    }
    results.set(node.id, result)
    run.nodes.push(result)
    run.finishedNodes = (Number(run.finishedNodes) || 0) + 1
    // 只把这次真正跑完的节点算进「本次该付的钱」；复用的节点上次已经付过
    run.billFinished = (Number(run.billFinished) || 0) + 1

    const executedOk = result.status === 'success' || result.status === 'unsupported'
    const branch = result.output && typeof result.output.branch === 'string' ? result.output.branch : null
    for (const edge of outgoing.get(node.id) || []) {
      let active = executedOk
      if (active && node.type === 'condition') {
        active = (branch || 'false') === (edge.sourceHandle || 'true')
      }
      edgeActive.set(edge.id, active)
    }
    emit({ type: 'node-end', node: result, index, total: order.length })
  }

  // 停止请求可能刚好落在最后一个节点跑完之后：所有节点都有结果了就不该再记「中断」，
  // 否则用户会看到一条已经跑完却写着 STOPPED、还留了全部钱的记录（v0.9.102）。
  const allNodesHandled = run.nodes.length >= order.length
  if (run.aborted && !allNodesHandled) {
    run.status = 'interrupted'
    if (run.stopReason === 'user' || run.stopReason === 'disconnect') {
      run.canceled = true
      const who = run.stopReason === 'disconnect' ? '页面已经断开，这次运行停了' : '你停止了这次运行'
      const bill = run.credits
        ? '跑完的节点按比例计费，没跑完的部分已经退回。'
        : '这次运行不计费。'
      run.error = who + '；' + bill + '可以接着跑没跑完的节点，也可以重新运行。'
    } else {
      // 服务重启 / 停机：没有用户主动停止，仍按全额退（已有路径）
      run.error = run.error || '服务重启，运行中断；' + (run.ownerId ? '已扣积分已退回，重新运行即可。' : '重新运行即可。')
    }
  } else {
    run.status = errorCount > 0 ? 'error' : 'success'
  }
  run.finishedAt = new Date().toISOString()
  run.durationMs = Date.now() - startedAt
  const outputResults = run.nodes.filter((item) => item.kind === 'output' && item.output)
  const lastWithText = [...run.nodes].reverse().find((item) => item.output && typeof item.output.text === 'string' && item.output.text)
  run.output = outputResults.length
    ? clip(outputResults.map((item) => item.output.text).filter(Boolean).join('\n\n'))
    : clip(lastWithText?.output?.text || '')
  if (run.status === 'error') {
    run.error = errorCount > 0 ? run.nodes.filter((item) => item.status === 'error').map((item) => item.title + '：' + item.error).join('；') : null
  }
  // 失败与中断都按账本净额退回：路由、重启恢复、停机收尾三条路径谁先跑都只退一次。
  // 用户主动停止走「按已开始节点结算」；结算失败才回落到全额退，宁可多退用户。
  if (run.status !== 'success') {
    if (run.canceled) {
      settleCanceledRun(run)
      if (run.credits?.settled !== true) refundRunCredits(run)
    } else {
      refundRunCredits(run)
    }
  }
  // 页面据此决定要不要给「继续跑」：已跑完一部分、还有没跑的，才值得复用。
  run.resumable = canResumeRun(run)
  await saveRun(run)
  await touchFlowRun(flow.id, run)
  activeRuns.delete(run.id)
  emit({ type: 'run-end', run })
  return run
}

// ---------- 中断与恢复 ----------
// 发一次版就是一次重启：以前运行记录只在跑完才写、退款靠内存里的回调，重启后
// 已扣的积分没人退、这次运行也查不到。现在运行一开始就落盘，重启 / 停机按账本净额退。

/** 用户点「停止运行」：只认这个进程里正在跑的那条；中止信号会让当前上游调用立刻返回。
 *  返回 ok 后运行还会走完收尾（写终态、按已开始节点结算），页面从流里拿到 run-end。 */
export function requestRunStop(runId, { reason = 'user' } = {}) {
  const id = String(runId || '')
  const run = activeRuns.get(id)
  if (!run) return { ok: false, code: 'RUN_NOT_ACTIVE', message: '这条运行已经结束，或者不在这个实例上' }
  if (run.status !== 'running') return { ok: false, code: 'RUN_NOT_ACTIVE', message: '这条运行已经不在运行中' }
  if (run.aborted) return { ok: true, id, status: run.status, already: true }
  run.stopReason = reason === 'disconnect' ? 'disconnect' : 'user'
  run.aborted = true
  try { run.__stopController?.abort() } catch { /* 已经中止 */ }
  return { ok: true, id, status: run.status }
}

/** 启动恢复：上次进程没跑完的运行标成中断并按账本退款；重复启动不会多退。
 *  排队中的单还没有开始跑、也没有扣钱（扣费在排到之后），恢复时直接撤掉——留着会是一条
 *  永远「排队中」的记录，页面会以为还有一条运行在等名额。
 *
 *  但「上次进程」不一定是自己的进程：两个生产实例共用 DATA_DIR，重启 8799 时
 *  8800 可能正在跑一条。所以只收「没有实例归属（升级前的旧记录）」或「主人已经死了」的单；
 *  主人还活着（心跳新 + 进程在 + 同一次开机）的记录原样留着，记在 skipped 里。 */
export async function recoverInterruptedRuns() {
  let recovered = 0
  let refunded = 0
  let dropped = 0
  let skipped = 0
  const self = currentInstanceId()
  const liveElsewhere = await liveInstanceIds()
  const list = await loadRuns()
  const kept = []
  let changed = false
  for (const run of list) {
    const owner = String(run.ownerInstance || '')
    if ((run.status === 'running' || run.status === 'queued') && owner && owner !== self && liveElsewhere.has(owner)) {
      skipped += 1
      kept.push(run)
      continue
    }
    if (run.status === 'queued') {
      // 钱不可能已经扣过，但按账本净额再核一遍：真扣了（极端时序）就退回，再撤记录
      if (refundRunCredits(run) > 0) refunded += 1
      dropped += 1
      changed = true
      continue
    }
    if (run.status !== 'running') {
      kept.push(run)
      continue
    }
    run.status = 'interrupted'
    run.finishedAt = new Date().toISOString()
    const started = Date.parse(String(run.startedAt || ''))
    run.durationMs = Number.isFinite(started) ? Math.max(0, Date.now() - started) : Number(run.durationMs) || 0
    run.error = '服务重启，运行中断（进程已退出）；' + (run.ownerId ? '已扣积分已退回，重新运行即可。' : '重新运行即可。')
    if (refundRunCredits(run) > 0) refunded += 1
    recovered += 1
    changed = true
    kept.push(run)
  }
  if (changed) await persistRuns(kept)
  return { recovered, refunded, dropped, skipped }
}

/** 停机收尾：给正在跑的运行标中断 + 退款，再让调用方关服务。重复调用无副作用。 */
export async function interruptRunningRuns(reason = '服务停止') {
  const running = [...activeRuns.values()].filter((run) => run.status === 'running')
  if (!running.length) return 0
  for (const run of running) {
    run.aborted = true
    try { run.__stopController?.abort() } catch { /* 已经中止 */ }
    run.status = 'interrupted'
    run.finishedAt = new Date().toISOString()
    const started = Date.parse(String(run.startedAt || ''))
    run.durationMs = Number.isFinite(started) ? Math.max(0, Date.now() - started) : Number(run.durationMs) || 0
    run.error = reason + '，运行中断；' + (run.ownerId ? '已扣积分已退回，重新运行即可。' : '重新运行即可。')
    refundRunCredits(run)
  }
  await enqueueWrite(async () => {
    const list = await loadRuns()
    const byId = new Map(running.map((run) => [run.id, run]))
    await persistRuns(list.map((run) => byId.get(run.id) || run))
  })
  return running.length
}
