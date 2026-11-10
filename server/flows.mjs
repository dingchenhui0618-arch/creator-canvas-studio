import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { canAccess } from './owner.mjs'
import { callTextModel } from './llm.mjs'
import { reviewVisual } from './review.mjs'
import { listTemplates, templateStats } from './templates.mjs'
import { publicError } from './public-error.mjs'

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
        model: config.vision.model,
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
        model: trimText(source.model, 80) || base.model,
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

export async function listRuns({ flowId = '', status = '', q = '', limit = 20, offset = 0 } = {}, user = null) {
  const list = (await loadRuns()).filter((run) => canAccess(run, user))
  const keyword = String(q || '').trim()
  let filtered = list
  if (flowId) filtered = filtered.filter((run) => run.flowId === flowId)
  // 运行状态只有 success / error 两种落库值，running 只在流式过程中出现
  if (status === 'success' || status === 'error') filtered = filtered.filter((run) => run.status === status)
  if (keyword) filtered = filtered.filter((run) => run.flowName.includes(keyword) || run.id.includes(keyword) || String(run.error || '').includes(keyword))
  const count = Math.min(50, Math.max(1, Number(limit) || 20))
  const start = Math.min(filtered.length, Math.max(0, Math.round(Number(offset) || 0)))
  return { items: filtered.slice(start, start + count), total: filtered.length, offset: start, limit: count }
}

export async function getRun(id, user = null) {
  const list = await loadRuns()
  return list.find((run) => run.id === id && canAccess(run, user)) || null
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
    maxTokens: 1200,
    models: [cfg.model, ...config.vision.fallbacks].filter(Boolean),
    log: (message) => console.log('[flows] ' + message),
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

async function runReview(node) {
  const cfg = node.data.config
  const profile = REVIEW_PROFILES.find((item) => item.id === cfg.profile) || REVIEW_PROFILES[0]
  const media = await loadReviewMedia(cfg.image)
  // 复用 server/review.mjs：优先 VisionQA 插件服务，不可用再走本地模型，并如实标注 provider
  const result = await reviewVisual({ ...media, intent: profile.intent, log: (message) => console.log('[flows] ' + message) })
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
      return { status: 'success', output: await runReview(node) }
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

async function saveRun(run) {
  await enqueueWrite(async () => {
    const list = await loadRuns()
    await persistRuns([run, ...list].slice(0, MAX_RUNS))
  })
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

/**
 * 按拓扑序执行整张画布。
 * onEvent 用于流式输出：run-start / node-start / node-end / run-end / run-error。
 */
export async function runFlow(flow, { onEvent, credits = null } = {}) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {}
  const order = topoSort(flow.nodes, flow.edges)
  const nodesById = new Map(flow.nodes.map((node) => [node.id, node]))
  const incoming = new Map(flow.nodes.map((node) => [node.id, []]))
  const outgoing = new Map(flow.nodes.map((node) => [node.id, []]))
  for (const edge of flow.edges) {
    incoming.get(edge.target)?.push(edge)
    outgoing.get(edge.source)?.push(edge)
  }

  const startedAt = Date.now()
  const run = {
    id: 'run_' + randomUUID().slice(0, 8),
    flowId: flow.id,
    flowName: flow.name,
    status: 'running',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationMs: 0,
    total: order.length,
    nodes: [],
    output: '',
    ownerId: flow.ownerId || '',
    // 本次运行实际扣了多少积分；失败会由路由层退回，refunded 在结束时标真
    credits: credits ? { cost: Math.round(Number(credits.cost) || 0), refunded: false } : null,
  }
  emit({ type: 'run-start', run: { id: run.id, flowId: run.flowId, flowName: run.flowName, total: order.length } })

  const results = new Map()
  const edgeActive = new Map()
  let errorCount = 0

  for (let index = 0; index < order.length; index += 1) {
    const node = nodesById.get(order[index])
    if (!node) continue
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
    const nodeStartedAt = Date.now()
    let result
    try {
      const ctx = collectContext(activeIn, results, nodesById)
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

  run.status = errorCount > 0 ? 'error' : 'success'
  if (run.credits) run.credits.refunded = run.status === 'error'
  run.finishedAt = new Date().toISOString()
  run.durationMs = Date.now() - startedAt
  const outputResults = run.nodes.filter((item) => item.kind === 'output' && item.output)
  const lastWithText = [...run.nodes].reverse().find((item) => item.output && typeof item.output.text === 'string' && item.output.text)
  run.output = outputResults.length
    ? clip(outputResults.map((item) => item.output.text).filter(Boolean).join('\n\n'))
    : clip(lastWithText?.output?.text || '')
  run.error = errorCount > 0 ? run.nodes.filter((item) => item.status === 'error').map((item) => item.title + '：' + item.error).join('；') : null

  await saveRun(run)
  await touchFlowRun(flow.id, run)
  emit({ type: 'run-end', run })
  return run
}
