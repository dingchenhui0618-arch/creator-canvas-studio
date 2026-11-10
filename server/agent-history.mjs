// 智能体运行历史：每次对话（成功或失败）落一条，按智能体隔离，供「历史 → 运行记录」回看。
// 以前运行次数只累加一个数字，失败原因和产出都随页面关闭丢失；这里用 data/agent-runs.json
// 保存最近 300 条（单个智能体最多 60 条），写入方式与 reviews/templates 一致：临时文件 + rename。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'

const runsFile = path.join(config.dataDir, 'agent-runs.json')
const MAX_TOTAL = 300
const MAX_PER_AGENT = 60
const MAX_REPLY = 12000
const MAX_MESSAGE = 2000
const MAX_ERROR = 600

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fsp.readFile(runsFile, 'utf8'))
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  return cache
}

function enqueueWrite(task) {
  const next = writeChain.then(task, task)
  writeChain = next.catch(() => {})
  return next
}

async function persist(list) {
  cache = list
  await fsp.mkdir(config.dataDir, { recursive: true })
  const tmp = runsFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await fsp.rename(tmp, runsFile)
}

const clip = (value, max) => String(value ?? '').slice(0, max)

export async function recordAgentRun({
  agent,
  user = null,
  status = 'success',
  message = '',
  reply = '',
  error = '',
  model = '',
  outputType = '',
  latencyMs = 0,
  credits = null,
  tools = null,
  conversationId = '',
}) {
  const record = {
    id: 'ahr_' + randomUUID().slice(0, 8),
    agentId: agent?.id || '',
    agentName: agent?.name || '',
    ownerId: user?.id || agent?.ownerId || '',
    status: status === 'error' ? 'error' : 'success',
    conversationId: clip(conversationId, 80),
    message: clip(message, MAX_MESSAGE),
    reply: clip(reply, MAX_REPLY),
    error: clip(error, MAX_ERROR),
    model: clip(model, 80),
    outputType: clip(outputType, 20),
    latencyMs: Number.isFinite(Number(latencyMs)) ? Math.round(Number(latencyMs)) : 0,
    credits: credits
      ? { cost: Number(credits.cost) || 0, balance: credits.balance ?? null, refunded: Boolean(credits.refunded) }
      : null,
    tools: tools
      ? {
          used: Array.isArray(tools.used) ? tools.used.slice(0, 8) : [],
          skipped: Array.isArray(tools.skipped) ? tools.skipped.slice(0, 8) : [],
          artifacts: Array.isArray(tools.artifacts)
            ? tools.artifacts.slice(0, 4).map((item) => ({ name: item.name, type: item.type, bytes: item.bytes }))
            : [],
        }
      : null,
    createdAt: new Date().toISOString(),
  }
  await enqueueWrite(async () => {
    const list = await loadAll()
    const counts = new Map()
    const trimmed = [record, ...list]
      .filter((item) => {
        const key = item.agentId || ''
        const count = (counts.get(key) || 0) + 1
        counts.set(key, count)
        return count <= MAX_PER_AGENT
      })
      .slice(0, MAX_TOTAL)
    await persist(trimmed)
  })
  return record
}

export async function listAgentRuns(agentId, { limit = 20, offset = 0 } = {}) {
  const list = (await loadAll()).filter((item) => item.agentId === agentId)
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20))
  const safeOffset = Math.max(0, Number(offset) || 0)
  return {
    items: list.slice(safeOffset, safeOffset + safeLimit),
    total: list.length,
    offset: safeOffset,
    limit: safeLimit,
  }
}

export async function clearAgentRuns(agentId) {
  let removed = 0
  await enqueueWrite(async () => {
    const list = await loadAll()
    const next = list.filter((item) => item.agentId !== agentId)
    removed = list.length - next.length
    if (removed) await persist(next)
  })
  return removed
}
