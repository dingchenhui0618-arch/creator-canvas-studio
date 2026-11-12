// 「已看过」：评审给了意见，人看过了、这一版先不改。
//
// 它不改评审结论，也不改作品状态——胶囊上仍然是「评审 · 需人工确认」。
// 它只做一件事：把这条从「评审等你看的」待办里拿掉，并且可以撤销。
//
// 记在这一版、这一次评审上（version + reviewAt）：同一版又评出新结论、或者开了新版，
// 时间对不上，它会自动回到待办——「看过」不是「改过」。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { canAccess } from './owner.mjs'

const acksFile = path.join(config.dataDir, 'review-acks.json')
// 一个账号最多记 200 条：这是待办上的便利贴，不是账本
const MAX_ACKS = 200

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fsp.readFile(acksFile, 'utf8'))
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
  const tmp = acksFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await fsp.rename(tmp, acksFile)
}

function clip(value, max) {
  return String(value ?? '').slice(0, max)
}

function normalize(item) {
  return {
    id: item.id,
    projectId: item.projectId,
    // 看过的是作品的第几版、哪一次评审（按评审时间认）：两者都对上才算「这条看过了」
    version: Math.max(0, Math.round(Number(item.version) || 0)),
    reviewAt: String(item.reviewAt || ''),
    verdict: ['pass', 'needs_review', 'fail'].includes(item.verdict) ? item.verdict : '',
    at: item.at,
    ownerId: item.ownerId || '',
  }
}

/**
 * 这条作品「当前这一版、这一次评审」有没有被看过。
 * 版次与评审时间都对上才算：同一版又评出新结论、或者开了新版，便利贴自动作废。
 * 作品页要在原地显示「已看过 / 撤销」，读的就是这一处，不另算一遍。
 */
export function ackFor(acks, { projectId = '', version = 0, reviewAt = '' } = {}) {
  if (!projectId) return null
  const stamp = String(reviewAt || '')
  // 没有评审时间就等于这一版还没评过：便利贴无从对上，不能拿空串去匹配
  if (!stamp) return null
  const n = Math.max(0, Math.round(Number(version) || 0))
  const hit = (Array.isArray(acks) ? acks : []).find(
    (item) =>
      item.projectId === projectId &&
      Math.max(0, Math.round(Number(item.version) || 0)) === n &&
      String(item.reviewAt || '') === stamp,
  )
  if (!hit) return null
  return { version: n, reviewAt: stamp, at: String(hit.at || '') }
}

/** 这个账号看过哪些（不含别的账号的）。 */
export async function listAcks(user = null) {
  const list = await loadAll()
  return list.filter((item) => canAccess(item, user)).map(normalize)
}

/**
 * 记一条「已看过」。一条作品只留最新一条：看过之后又看一次，时间是新的。
 * 返回记下的那条（含 at，界面用它写「刚看过」）。
 */
export async function ackReview({ projectId, version = 0, reviewAt = '', verdict = '' } = {}, user = null) {
  if (!projectId) throw new Error('要说清是哪条作品')
  const ownerId = user?.id || ''
  const record = normalize({
    id: 'ack_' + randomUUID().slice(0, 8),
    projectId: clip(projectId, 40),
    version,
    reviewAt,
    verdict,
    at: new Date().toISOString(),
    ownerId,
  })
  await enqueueWrite(async () => {
    const list = await loadAll()
    const rest = list.filter((item) => !((item.ownerId || '') === ownerId && item.projectId === record.projectId))
    await persist([record, ...rest].slice(0, MAX_ACKS))
  })
  return record
}

/** 撤销：把它从「已看过」里拿掉，它回到待办。返回撤销了几条。 */
export async function unackReview(projectId, user = null) {
  if (!projectId) return 0
  const ownerId = user?.id || ''
  let removed = 0
  await enqueueWrite(async () => {
    const list = await loadAll()
    const keep = list.filter((item) => !(item.projectId === projectId && (item.ownerId || '') === ownerId))
    removed = list.length - keep.length
    if (removed) await persist(keep)
  })
  return removed
}

/** 作品删掉后，便利贴也一起撕掉：留着只会让读的人多一次对不上的查找。 */
export async function dropAcksForProject(projectId) {
  if (!projectId) return 0
  let removed = 0
  await enqueueWrite(async () => {
    const list = await loadAll()
    const keep = list.filter((item) => item.projectId !== projectId)
    removed = list.length - keep.length
    if (removed) await persist(keep)
  })
  return removed
}

/** 注销账号时用。 */
export async function deleteAcksByOwner(ownerId) {
  if (!ownerId) return 0
  let removed = 0
  await enqueueWrite(async () => {
    const list = await loadAll()
    const keep = list.filter((item) => (item.ownerId || '') !== ownerId)
    removed = list.length - keep.length
    if (removed) await persist(keep)
  })
  return removed
}
