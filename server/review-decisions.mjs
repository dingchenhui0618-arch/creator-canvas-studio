// 人工复核：评审给了意见，人看过证据后拍板「这一版能发 / 不能发」。
//
// 与「已看过」的区别：已看过只是把待办挪开，结论一个字不改；
// 拍板是人的结论，它会盖过模型结论出现在状态胶囊、下一步与交付稿 / 评审对照纸上——
// 纸是给剪辑、制片、甲方看的，谁拍的板必须写在纸上。
//
// 记在「哪条作品、哪一次评审」上（reviewAt 是那次评审的 createdAt）：
// 同一版又评出新结论、或者开了新版，时间对不上，拍板自动失效、这条会回到待办。
// 不改评审记录本身（模型写了什么还是什么），人拍板是结论之上的一层。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { canAccess } from './owner.mjs'

const decisionsFile = path.join(config.dataDir, 'review-decisions.json')
// 一个账号最多留 200 条：一条拍板对应一次评审，攒不到那么多还留着
const MAX_DECISIONS = 200

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fsp.readFile(decisionsFile, 'utf8'))
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
  const tmp = decisionsFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await fsp.rename(tmp, decisionsFile)
}

const clip = (value, max) => String(value ?? '').slice(0, max)

export const DECISION_KINDS = ['pass', 'reject']

function normalize(item) {
  return {
    id: item.id,
    projectId: item.projectId,
    // 拍板的是作品的第几版、哪一次评审（按评审时间认）
    version: Math.max(0, Math.round(Number(item.version) || 0)),
    reviewAt: String(item.reviewAt || ''),
    // 那次评审模型给的结论：纸与胶囊都要能写「模型说不通过，人拍板通过」
    verdict: ['pass', 'needs_review', 'fail'].includes(item.verdict) ? item.verdict : '',
    decision: DECISION_KINDS.includes(item.decision) ? item.decision : '',
    note: clip(item.note, 80),
    at: item.at,
    ownerId: item.ownerId || '',
  }
}

/** 这个账号拍板过哪些（不含别的账号的）。 */
export async function listDecisions(user = null) {
  const list = await loadAll()
  return list.filter((item) => canAccess(item, user)).map(normalize)
}

/**
 * 拍板一次。同一次评审只留一条：改主意就再拍一次（后一条盖前一条），保留在历史里的是最新的那次判断。
 * 一次评审一条，不覆盖同一作品别的版本上的拍板——交付稿要按版次写清哪一版谁拍过板。
 */
export async function saveDecision({ projectId, version = 0, reviewAt = '', verdict = '', decision = '', note = '' } = {}, user = null) {
  if (!projectId) throw new Error('要说清是哪条作品')
  if (!DECISION_KINDS.includes(decision)) throw new Error('拍板只有「通过」和「不通过」两种')
  const ownerId = user?.id || ''
  const record = normalize({
    id: 'dec_' + randomUUID().slice(0, 8),
    projectId: clip(projectId, 40),
    version,
    reviewAt,
    verdict,
    decision,
    note,
    at: new Date().toISOString(),
    ownerId,
  })
  await enqueueWrite(async () => {
    const list = await loadAll()
    // 同一条作品、同一次评审只留一条：改主意是覆盖，不是堆积
    const rest = list.filter((item) => !((item.ownerId || '') === ownerId && item.projectId === record.projectId && item.reviewAt === record.reviewAt))
    await persist([record, ...rest].slice(0, MAX_DECISIONS))
  })
  return record
}

/** 撤销：把这条作品的拍板全撤掉（按版次各自失效，不猜人想撤哪一版）。返回撤销了几条。 */
export async function clearDecisions(projectId, user = null) {
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

/** 作品删掉后，拍板记录一起清掉：留着只会让读的人多一次对不上的查找。 */
export async function dropDecisionsForProject(projectId) {
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
export async function deleteDecisionsByOwner(ownerId) {
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
