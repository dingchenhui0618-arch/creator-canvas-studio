import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
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
    total: Number(run.total) || 0,
    failed: (Array.isArray(run.nodes) ? run.nodes : []).filter((node) => node.status === 'error').length,
    error: run.error || '',
    credits: run.credits ? { cost: Number(run.credits.cost) || 0, refunded: Boolean(run.credits.refunded) } : null,
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
    if (run.credits && !run.credits.refunded) {
      creditsByFlow[run.flowId] = (creditsByFlow[run.flowId] || 0) + Math.max(0, Number(run.credits.cost) || 0)
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
    ? await runReviewIsolated(job, { log: writeLog })
    : await reviewVisual({ ...job, log: writeLog })
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
  await enqueueWrite(async () => {
    const list = await loadRuns()
    await persistRuns([run, ...list.filter((item) => item.id !== run.id)].slice(0, MAX_RUNS))
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

/** 一次运行的 id 在扣积分之前就要定下来：账本 ref 与运行记录用同一个 id，
 *  这样重启恢复能按账本净额退，而不用猜「这条扣费是哪次运行」。 */
export function newRunId() {
  return 'run_' + randomUUID().slice(0, 8)
}

/** 运行刚建出来、还没执行任何节点时的模样（落盘用的初始态）。
 *  queued = 这一单还在整机队里等名额：还没开始跑、也还没扣积分，运行记录该如实写「排队中」，
 *  不能先写成 running 让运行记录页把它当失败（v0.9.98）。 */
function blankRun(flow, id, cost = 0, { queued = false } = {}) {
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
    credits: amount > 0 ? { cost: amount, refunded: false } : null,
  }
}

/** 扣积分之前先把运行记录落一笔：扣完马上断电也留得下这条单，恢复时按账本退。 */
export async function startFlowRun(flow, runId, { cost = 0, queued = false } = {}) {
  const run = blankRun(flow, String(runId || '') || newRunId(), cost, { queued })
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

/** 按账本净额退这次运行还欠的积分：重复调用算出 0，不会多退。 */
export function refundRunCredits(run) {
  if (!run || !run.ownerId || !run.id) return 0
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
export async function runFlow(flow, { onEvent, credits = null, runId = '' } = {}) {
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
    id: String(runId || '') || newRunId(),
    flowId: flow.id,
    flowName: flow.name,
    status: 'running',
    // runFlow 会用这个对象覆盖同 id 的占位记录：实例归属必须跟着写回去
    ownerInstance: currentInstanceId(),
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
  // 先落盘再执行：以前只在结束时写运行记录，进程被杀就什么也不剩，
  // 已扣的积分在账本里也永远对不上是哪次运行。
  activeRuns.set(run.id, run)
  await saveRun(run)
  emit({ type: 'run-start', run: { id: run.id, flowId: run.flowId, flowName: run.flowName, total: order.length } })

  const results = new Map()
  const edgeActive = new Map()
  let errorCount = 0

  for (let index = 0; index < order.length; index += 1) {
    // 停机收尾已经把这次运行标成中断并退了钱：后面的节点不再执行，别再产生上游费用
    if (run.aborted) break
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
      const ctx = { ...collectContext(activeIn, results, nodesById), ownerId: flow.ownerId || '', runId: run.id }
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

  if (run.aborted) {
    run.status = 'interrupted'
    run.error = run.error || '服务重启，运行中断；' + (run.ownerId ? '已扣积分已退回，重新运行即可。' : '重新运行即可。')
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
  // 失败与中断都按账本净额退回：路由、重启恢复、停机收尾三条路径谁先跑都只退一次
  if (run.status !== 'success') refundRunCredits(run)
  await saveRun(run)
  await touchFlowRun(flow.id, run)
  activeRuns.delete(run.id)
  emit({ type: 'run-end', run })
  return run
}

// ---------- 中断与恢复 ----------
// 发一次版就是一次重启：以前运行记录只在跑完才写、退款靠内存里的回调，重启后
// 已扣的积分没人退、这次运行也查不到。现在运行一开始就落盘，重启 / 停机按账本净额退。

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
