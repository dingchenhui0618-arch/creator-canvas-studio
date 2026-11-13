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
    // 评审发生在作品的第几版：多版本对照靠这一个数分组，老记录没有就是 0
    version: Math.max(0, Math.round(Number(item.version) || 0)),
    ms: item.result?.ms || 0,
    model: item.result?.model || '',
    credits: item.credits || null,
    ownerId: item.ownerId || '',
    createdAt: item.createdAt,
  }
}

export async function saveReview({ user = null, source = {}, intent = '', result = null, credits = null, projectId = '', version = 0 }) {
  const record = {
    id: 'rev_' + randomUUID().slice(0, 8),
    ownerId: user?.id || '',
    // 作品关联是可选的：从作品页发起的评审才带上，普通评审留空
    projectId: clip(projectId, 40),
    version: Math.max(0, Math.round(Number(version) || 0)),
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

// 结论只有三种；老记录没有结论的算「未记录」，筛选「全部」时也包含它们
const VERDICTS = new Set(['pass', 'needs_review', 'fail'])

function verdictOf(item) {
  const verdict = item.result?.verdict
  return VERDICTS.has(verdict) ? verdict : 'none'
}

function countVerdicts(items) {
  const counts = { pass: 0, needs_review: 0, fail: 0, none: 0 }
  for (const item of items) counts[verdictOf(item)] += 1
  return counts
}

function countProjects(items) {
  const counts = new Map()
  for (const item of items) if (item.projectId) counts.set(item.projectId, (counts.get(item.projectId) || 0) + 1)
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
}

/**
 * 评审历史：一页一页翻，筛选与翻页都在服务端做（最多 200 条，但正文几十 KB，不能整包发给前端）。
 * 筛选口径：
 *   verdict   只留某一种结论；
 *   projectId 只留记在某条作品下的；
 *   orphan    只留没记入作品的（作品被删、或普通首帧评审）。
 * facets 是筛选面板上的数字：结论的计数按当前作品筛选算，作品的计数按当前结论筛选算——
 * 换一个筛选后，另一个筛选上的数字仍然对着真实结果。
 */
export async function listReviews({ limit = 20, offset = 0, verdict = '', projectId = '', orphan = false } = {}, user = null) {
  const list = (await loadAll()).filter((item) => canAccess(item, user))
  const byVerdict = (item) => (verdict ? item.result?.verdict === verdict : true)
  const byProject = (item) => (projectId ? item.projectId === projectId : orphan ? !item.projectId : true)
  // 写入顺序就是新的在前，但按时间再排一次：历史列表的顺序不该取决于盘上数组怎么排
  const filtered = list
    .filter((item) => byVerdict(item) && byProject(item))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  const count = Math.min(50, Math.max(1, Number(limit) || 20))
  const skip = Math.max(0, Math.round(Number(offset) || 0))
  return {
    items: filtered.slice(skip, skip + count).map(toSummary),
    total: filtered.length,
    offset: skip,
    limit: count,
    facets: {
      verdicts: countVerdicts(list.filter(byProject)),
      projects: countProjects(list.filter(byVerdict)),
      orphans: list.filter((item) => byVerdict(item) && !item.projectId).length,
    },
  }
}

/**
 * 每个作品的评审概况：列表页要显示「已评审 / 结论」，但评审正文有几十 KB，
 * 不能为了计数把整包都发给前端。这里只在服务端扫一遍算计数。
 */
export async function reviewCountsByProject(user = null) {
  const list = (await loadAll()).filter((item) => canAccess(item, user) && item.projectId)
  const counts = {}
  for (const item of list) {
    const entry = counts[item.projectId] || (counts[item.projectId] = { count: 0, credits: 0, lastVerdict: '', lastAt: '', versions: {} })
    entry.count += 1
    // 评审记录里自己记着这次扣了多少积分：作品花费直接从这里加，不再回账本里猜
    entry.credits += Math.max(0, Number(item.credits?.cost) || 0)
    if (String(item.createdAt) > entry.lastAt) {
      entry.lastAt = String(item.createdAt)
      entry.lastVerdict = item.result?.verdict || ''
    }
    // 列表上的状态胶囊只看当前这一版：新版刚开出来时不能因为上一版评过就显示「已评审」
    const key = String(Math.max(0, Math.round(Number(item.version) || 0)))
    const bucket = entry.versions[key] || (entry.versions[key] = { count: 0, lastVerdict: '', lastAt: '' })
    bucket.count += 1
    if (String(item.createdAt) > bucket.lastAt) {
      bucket.lastAt = String(item.createdAt)
      bucket.lastVerdict = item.result?.verdict || ''
    }
  }
  return counts
}

/**
 * 一条作品上的评审花费（v0.9.65）：次数、积分合计与最近一次时间。
 * 只认记着 projectId 的评审——普通首帧评审不属于任何作品，不硬塞进来。
 */
export async function reviewSpend(projectId, user = null) {
  const empty = { count: 0, credits: 0, lastAt: '' }
  if (!projectId) return empty
  const list = (await loadAll()).filter((item) => canAccess(item, user) && item.projectId === String(projectId))
  const out = { ...empty }
  for (const item of list) {
    out.count += 1
    out.credits += Math.max(0, Number(item.credits?.cost) || 0)
    if (String(item.createdAt) > out.lastAt) out.lastAt = String(item.createdAt)
  }
  return out
}

/** 一条作品内按版本分组：作品页的「版本对照」要显示每一版评过几次、最后结论。 */
export async function reviewSummaryByVersion(projectId, user = null) {
  if (!projectId) return {}
  const list = (await loadAll()).filter((item) => canAccess(item, user) && item.projectId === projectId)
  const counts = {}
  for (const item of list) {
    const key = String(Math.max(0, Math.round(Number(item.version) || 0)))
    const entry = counts[key] || (counts[key] = { count: 0, lastVerdict: '', lastAt: '' })
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
