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
    projectId: item.projectId || '',
    ms: item.result?.ms || 0,
    model: item.result?.model || '',
    credits: item.credits || null,
    ownerId: item.ownerId || '',
    createdAt: item.createdAt,
  }
}

export async function saveReview({ user = null, source = {}, intent = '', result = null, credits = null, projectId = '' }) {
  const record = {
    id: 'rev_' + randomUUID().slice(0, 8),
    ownerId: user?.id || '',
    // 作品关联是可选的：从作品页发起的评审才带上，普通评审留空
    projectId: clip(projectId, 40),
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

export async function listReviews({ limit = 20, verdict = '', projectId = '' } = {}, user = null) {
  const list = (await loadAll()).filter((item) => canAccess(item, user))
  const filtered = list
    .filter((item) => (verdict ? item.result?.verdict === verdict : true))
    .filter((item) => (projectId ? item.projectId === projectId : true))
  const count = Math.min(50, Math.max(1, Number(limit) || 20))
  return { items: filtered.slice(0, count).map(toSummary), total: filtered.length }
}

/**
 * 每个作品的评审概况：列表页要显示「已评审 / 结论」，但评审正文有几十 KB，
 * 不能为了计数把整包都发给前端。这里只在服务端扫一遍算计数。
 */
export async function reviewCountsByProject(user = null) {
  const list = (await loadAll()).filter((item) => canAccess(item, user) && item.projectId)
  const counts = {}
  for (const item of list) {
    const entry = counts[item.projectId] || (counts[item.projectId] = { count: 0, lastVerdict: '', lastAt: '' })
    entry.count += 1
    if (String(item.createdAt) > entry.lastAt) {
      entry.lastAt = String(item.createdAt)
      entry.lastVerdict = item.result?.verdict || ''
    }
  }
  return counts
}

/** 作品被删掉后，旧评审保留为历史，但不再挂在任何作品上。 */
export async function detachReviewsFromProject(projectId) {
  if (!projectId) return 0
  const list = await loadAll()
  const hit = list.filter((item) => item.projectId === projectId)
  if (!hit.length) return 0
  for (const item of hit) delete item.projectId
  await persist(list)
  return hit.length
}

/** 注销账号时用：删掉这个人名下的评审记录。 */
export async function deleteReviewsByOwner(ownerId) {
  if (!ownerId) return 0
  const list = await loadAll()
  const mine = list.filter((item) => item.ownerId === ownerId)
  if (!mine.length) return 0
  await persist(list.filter((item) => item.ownerId !== ownerId))
  return mine.length
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
