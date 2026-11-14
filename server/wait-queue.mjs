// 排队位进共享目录（v0.9.93）：一台机器上的两个实例排的是同一条队。
//
// v0.9.80 起画布出图名额满时会先排一会儿；v0.9.83 把「几条在等」升级成「谁、排第几」。
// 但那条队一直活在本进程的 Map 里：生产机上 visionqa（8799）与 visionqa-internal（8800）
// 各排各的——「最多 8 条同时排」实际是每进程 8 条，两个实例叠起来 16 条；
// 画布上那句「我排第几」也只在一个实例内部成立，后台看到的排队数是随手落到的那个进程的。
//
// 而名额（heavy-lease）本来就是整机一份。排队位和名额口径不一致，就会出两种怪事：
//   1) 名额是整机的、排队位是进程的：另一个实例的 4 条在等，这边看到的却是 0 条；
//   2) 8 张一批在 8799 排着，8800 上单独一张却可能在空位一出现时先抢到（它压根不知道有人在等）。
//
// 做法：排队位就是共享目录里的一组文件（和租约同一个目录、同一把跨进程锁），
// 一个 waiter = 一个文件，内容只有 kind / pid / 入场时间 —— 不放票号，也不放任务内容。
//
// 四条边界，都是刻意的：
//   1) 票号只以 sha256 前 16 位出现在文件名里：目录是全机器可读的，票号是「查自己排第几」的凭据，
//      不能以明文落在那里；
//   2) 进程被 SIGKILL 掉的 waiter 靠 pid 已经不在立刻清掉；活着的靠心跳（mtime）续命，
//      4 秒没动静的当泄漏清掉——所以「头名死在半路」不会把整条队堵住；
//   3) 只用共享目录做「数一下 + 登记」和读；心跳只 utimes 一个文件，不抢锁——
//      排队每 350 毫秒一次，抢锁会让闸门变成串行;
//   4) 目录不可用时退回进程内的那份 Map（和 v0.9.83 一样），并把 scope 如实报成 process。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LEASE_LOCK_MISS, leaseDirPath, pidAlive, withLeaseDirLock } from './heavy-lease.mjs'

const SUBDIR = 'waiters'
// 文件名：<票号哈希16>-<pid>-<入场时间36>.wait。哈希放最前面，按票号找一条就不用解析 JSON。
const NAME_RE = /^([a-f0-9]{16})-(\d+)-([a-z0-9]+)\.wait$/
const DEFAULT_STALE_MS = 4000

// 共享目录用不了时的那份（v0.9.83 的行为）：只在本进程内排队
const localWaiters = new Map()
let localSeq = 0

const stats = {
  joined: 0,
  left: 0,
  prunedDead: 0,
  prunedStale: 0,
  parseFail: 0,
  lockMiss: 0,
  dirFail: 0,
  fallback: 0,
  lastError: '',
}

/** 心跳过期时间：等待循环每 350 毫秒摸一次，4 秒是留了十倍余量的「这条已经不在等了」。 */
export function waitStaleMs() {
  const raw = Math.round(Number(process.env.VQ_QUEUE_STALE_MS))
  if (!Number.isFinite(raw) || raw === 0) return DEFAULT_STALE_MS
  return Math.min(60000, Math.max(800, raw))
}

function hashTicket(ticket) {
  return crypto.createHash('sha256').update(String(ticket)).digest('hex').slice(0, 16)
}

/** 排序键：先入场时间，再进程号，最后票号哈希——同一毫秒进来的两条也有确定的先后。 */
function orderOf(entry) {
  return { enteredAt: entry.enteredAt, tie: entry.tie, hash: entry.hash }
}

function compareOrder(a, b) {
  if (a.enteredAt !== b.enteredAt) return a.enteredAt - b.enteredAt
  if (a.tie !== b.tie) return a.tie - b.tie
  return String(a.hash).localeCompare(String(b.hash))
}

function waitersDir(base) {
  return path.join(base, SUBDIR)
}

function ensureWaitersDir(base) {
  const dir = waitersDir(base)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 })
    try {
      fs.chmodSync(dir, 0o777)
    } catch {
      // 不是自己的目录：跟着现有权限走，能不能写由后面的 create 说话
    }
    return dir
  } catch (error) {
    stats.dirFail += 1
    stats.lastError = '排队位目录不可用：' + String((error && (error.code || error.message)) || error)
    return ''
  }
}

function removeFile(file) {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * 列出某一类的 waiter（顺手清掉死了的 / 心跳停了的）。
 * 不加锁：删文件是幂等的，两个进程同时清同一条也只是 ENOENT。
 */
function listWaiters(base, kind, now = Date.now()) {
  const dir = ensureWaitersDir(base)
  if (!dir) return null
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    stats.dirFail += 1
    stats.lastError = '排队位目录读不了'
    return null
  }
  const stale = waitStaleMs()
  const out = []
  for (const name of names) {
    const matched = NAME_RE.exec(name)
    if (!matched) continue
    const file = path.join(dir, name)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    let data
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      if (removeFile(file)) stats.parseFail += 1
      continue
    }
    const pid = Number(data && data.pid)
    if (!pidAlive(pid)) {
      // 进程没了：这一条不会再有下文，名额与名次都该立刻放出来
      if (removeFile(file)) stats.prunedDead += 1
      continue
    }
    if (now - stat.mtimeMs > stale) {
      // 进程还在，但已经几秒没摸过心跳：它的等待循环不在了（长同步任务 / 卡死），不能让它堵住头名
      if (removeFile(file)) stats.prunedStale += 1
      continue
    }
    const entryKind = String((data && data.kind) || '')
    if (!entryKind) {
      if (removeFile(file)) stats.parseFail += 1
      continue
    }
    if (entryKind !== kind) continue
    out.push({
      hash: matched[1],
      pid,
      tie: pid,
      enteredAt: Number(data && data.enteredAt) || stat.mtimeMs,
      host: String((data && data.host) || ''),
      file,
    })
  }
  return out
}

function localList(kind) {
  const list = localWaiters.get(kind) || []
  // 本进程的条目不会有 pid 死掉的问题（进程死了这条也就不存在了），只用心跳时间兜底
  const now = Date.now()
  return list.filter((entry) => now - entry.touchedAt <= waitStaleMs())
}

function sortedWithPositions(entries) {
  const sorted = [...entries].sort((a, b) => compareOrder(orderOf(a), orderOf(b)))
  const now = Date.now()
  return sorted.map((entry, index) => ({
    position: index + 1,
    waitedMs: Math.max(0, now - entry.enteredAt),
    entry,
  }))
}

/** 读一眼这条队：几条在等、最久的等了多久、各排第几（不含票号）。 */
export function waitQueueSnapshot(kind) {
  const shared = process.env.VQ_HEAVY_LEASE === '0' ? null : listWaiters(leaseDirPath(), kind)
  if (shared) {
    const rows = sortedWithPositions(shared)
    return {
      scope: 'lease',
      waiting: rows.length,
      oldestWaitMs: rows.length ? rows[0].waitedMs : 0,
      queue: rows.map((row) => ({ position: row.position, waitedMs: row.waitedMs })),
      entries: rows,
    }
  }
  const rows = sortedWithPositions(localList(kind))
  return {
    scope: 'process',
    waiting: rows.length,
    oldestWaitMs: rows.length ? rows[0].waitedMs : 0,
    queue: rows.map((row) => ({ position: row.position, waitedMs: row.waitedMs })),
    entries: rows,
  }
}

/**
 * 登记进排队位（v0.9.93）。
 * maxWaiting > 0 时在**同一把锁里**数完再登记：两个实例同时「看到第 8 条」就会各放一条进来，
 * 那正是排队位该挡住的事。同一个票号重复进来（客户端重试）返回原来那一条，不重复占位。
 * ok=false 只有一种原因：排队位已经满了。
 */
export function joinWaitQueue(kind, ticket, options = {}) {
  const maxWaiting = Math.max(0, Math.round(Number(options.maxWaiting) || 0))
  const id = String(ticket || '')
  const hash = hashTicket(id)
  const sharedDir = process.env.VQ_HEAVY_LEASE === '0' ? '' : leaseDirPath()
  const shared = sharedDir ? withLeaseDirLock(({ dir }) => {
    const base = dir
    const list = listWaiters(base, kind)
    if (!list) return LEASE_LOCK_MISS
    const existing = list.find((entry) => entry.hash === hash)
    if (existing) return { ok: true, entry: existing, waiting: list.length, dir: base }
    if (maxWaiting > 0 && list.length >= maxWaiting) return { ok: false, full: true, waiting: list.length, dir: base }
    const target = ensureWaitersDir(base)
    if (!target) return LEASE_LOCK_MISS
    const enteredAt = Date.now()
    const name = hash + '-' + process.pid + '-' + enteredAt.toString(36) + '.wait'
    const file = path.join(target, name)
    const body = JSON.stringify({ kind, pid: process.pid, enteredAt, host: os.hostname(), v: 1 })
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o666 })
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        stats.lastError = '排队位写入失败：' + String((error && (error.code || error.message)) || error)
        return LEASE_LOCK_MISS
      }
    }
    return {
      ok: true,
      dir: base,
      waiting: list.length + 1,
      entry: { hash, pid: process.pid, tie: process.pid, enteredAt, host: os.hostname(), file },
    }
  }) : LEASE_LOCK_MISS
  if (shared === LEASE_LOCK_MISS) {
    stats.fallback += 1
    const list = localList(kind)
    const existing = list.find((entry) => entry.hash === hash)
    if (existing) {
      return { ok: true, scope: 'process', entry: existing, order: orderOf(existing), waiting: list.length, position: 1 }
    }
    if (maxWaiting > 0 && list.length >= maxWaiting) {
      return { ok: false, scope: 'process', full: true, waiting: list.length }
    }
    localSeq += 1
    const entry = { hash, pid: process.pid, tie: localSeq, enteredAt: Date.now(), host: os.hostname(), touchedAt: Date.now(), file: '' }
    localWaiters.set(kind, [...list, entry])
    stats.joined += 1
    const rows = sortedWithPositions(localList(kind))
    const mine = rows.findIndex((row) => row.entry.hash === hash)
    return { ok: true, scope: 'process', entry, order: orderOf(entry), waiting: rows.length, position: mine + 1 }
  }
  if (!shared.ok) {
    return { ok: false, scope: 'lease', full: true, waiting: shared.waiting }
  }
  stats.joined += 1
  const rows = sortedWithPositions(listWaiters(shared.dir, kind) || [])
  const mine = rows.findIndex((row) => row.entry.hash === hash)
  return {
    ok: true,
    scope: 'lease',
    entry: shared.entry,
    order: orderOf(shared.entry),
    waiting: rows.length || shared.waiting,
    position: mine >= 0 ? mine + 1 : shared.waiting,
  }
}

/** 从排队位划掉这一张：排到 / 等超时 / 客户端断开都走这里，漏一条就是漏一个名额。 */
export function leaveWaitQueue(kind, ticket) {
  const hash = hashTicket(ticket)
  const local = localList(kind).filter((entry) => entry.hash !== hash)
  if (local.length) localWaiters.set(kind, local)
  else localWaiters.delete(kind)
  const base = process.env.VQ_HEAVY_LEASE === '0' ? '' : leaseDirPath()
  if (!base) return false
  const dir = waitersDir(base)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return false
  }
  let removed = false
  for (const name of names) {
    const matched = NAME_RE.exec(name)
    if (!matched || matched[1] !== hash) continue
    if (removeFile(path.join(dir, name))) removed = true
  }
  if (removed) stats.left += 1
  return removed
}

/** 心跳：等待循环每一轮摸一下，4 秒没动静的会被当成泄漏清掉。 */
export function heartbeatWaitQueue(kind, ticket) {
  const hash = hashTicket(ticket)
  const now = Date.now()
  const list = localWaiters.get(kind) || []
  for (const entry of list) {
    if (entry.hash === hash) entry.touchedAt = now
  }
  const base = process.env.VQ_HEAVY_LEASE === '0' ? '' : leaseDirPath()
  if (!base) return false
  const dir = waitersDir(base)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return false
  }
  let seen = false
  for (const name of names) {
    const matched = NAME_RE.exec(name)
    if (!matched || matched[1] !== hash) continue
    seen = true
    try {
      fs.utimesSync(path.join(dir, name), new Date(now), new Date(now))
    } catch {
      // 刚好被清掉了：下一次列表会如实反映
    }
  }
  return seen || list.some((entry) => entry.hash === hash)
}

/** 我前面还有几条（按整机的入场顺序）：0 = 现在轮到我试名额。 */
export function waitQueueAhead(kind, order) {
  if (!order) return 0
  const snapshot = waitQueueSnapshot(kind)
  let ahead = 0
  for (const row of snapshot.entries) {
    if (compareOrder(orderOf(row.entry), order) < 0) ahead += 1
  }
  return ahead
}

/** 我问的那张票现在排第几；不在队里（已排到 / 从没进来 / 票不存在）就回 null。 */
export function waitQueuePosition(kind, ticket) {
  const id = String(ticket || '').trim()
  if (!id) return null
  const hash = hashTicket(id)
  const snapshot = waitQueueSnapshot(kind)
  const index = snapshot.entries.findIndex((row) => row.entry.hash === hash)
  if (index < 0) return null
  const row = snapshot.entries[index]
  return { position: row.position, ahead: index, waiting: snapshot.waiting, waitedMs: row.waitedMs }
}

/** 共享目录这一层现在的问题（后台排障看，不给用户）。 */
export function waitQueueStatus() {
  let shared = null
  try {
    const base = leaseDirPath()
    const dir = waitersDir(base)
    const names = fs.readdirSync(dir)
    shared = {
      dir,
      files: names.filter((name) => NAME_RE.test(name)).length,
      other: names.filter((name) => !NAME_RE.test(name)).length,
      staleMs: waitStaleMs(),
    }
  } catch (error) {
    shared = { dir: '', error: String((error && (error.code || error.message)) || error) }
  }
  return { enabled: process.env.VQ_HEAVY_LEASE !== '0', shared, stats: { ...stats } }
}

/** 测试用：清掉进程内那份与计数。 */
export function resetWaitQueueState() {
  localWaiters.clear()
  localSeq = 0
  for (const key of Object.keys(stats)) {
    if (key === 'lastError') stats[key] = ''
    else stats[key] = 0
  }
}
