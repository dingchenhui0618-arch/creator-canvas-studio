// 视觉评审历史：把每次成功的评审连同结论、像素锚点、来源与耗时落库。
// 以前结论只活在页面内存里，刷新即失；这里用 data/reviews.json 存最近 200 条，按账号隔离。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { canAccess } from './owner.mjs'

const reviewsFile = path.join(config.dataDir, 'reviews.json')
const MAX_REVIEWS = 200

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fsp.readFile(reviewsFile, 'utf8'))
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
  const tmp = reviewsFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await fsp.rename(tmp, reviewsFile)
}

function clip(value, max) {
  return String(value ?? '').slice(0, max)
}

// 列表只回摘要，观测点与修复建议留在详情里
function toSummary(item) {
  return {
    id: item.id,
    intent: item.intent,
    verdict: item.result?.verdict || '',
    summary: item.result?.summary || '',
    observations: Array.isArray(item.result?.observations) ? item.result.observations.length : 0,
    source: item.source || {},
    ms: item.result?.ms || 0,
    model: item.result?.model || '',
    credits: item.credits || null,
    ownerId: item.ownerId || '',
    createdAt: item.createdAt,
  }
}

export async function saveReview({ user = null, source = {}, intent = '', result = null, credits = null }) {
  const record = {
    id: 'rev_' + randomUUID().slice(0, 8),
    ownerId: user?.id || '',
    intent: clip(intent, 120),
    source: {
      kind: source.kind || 'unknown',
      label: clip(source.label || '', 200),
      media: clip(source.media || '', 300),
      imageUrl: clip(source.imageUrl || '', 500),
    },
    credits: credits ? { cost: credits.cost ?? 0, balance: credits.balance ?? null } : null,
    result,
    createdAt: new Date().toISOString(),
  }
  await enqueueWrite(async () => {
    const list = await loadAll()
    await persist([record, ...list].slice(0, MAX_REVIEWS))
  })
  return record
}

export async function listReviews({ limit = 20, verdict = '' } = {}, user = null) {
  const list = (await loadAll()).filter((item) => canAccess(item, user))
  const filtered = verdict ? list.filter((item) => item.result?.verdict === verdict) : list
  const count = Math.min(50, Math.max(1, Number(limit) || 20))
  return { items: filtered.slice(0, count).map(toSummary), total: filtered.length }
}

export async function getReview(id, user = null) {
  const list = await loadAll()
  return list.find((item) => item.id === id && canAccess(item, user)) || null
}

// 启动迁移：升级前没有归属的评审记录认领给管理员（与模板/智能体同一套规则）
export async function adoptUnowned(ownerId) {
  if (!ownerId) return 0
  const list = await loadAll()
  const pending = list.filter((item) => !item.ownerId)
  if (!pending.length) return 0
  for (const item of pending) item.ownerId = ownerId
  await persist(list)
  return pending.length
}
