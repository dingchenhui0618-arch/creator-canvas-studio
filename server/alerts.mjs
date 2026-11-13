// 可观测性：5xx / 上游失败 / 磁盘不足 三类告警，落在数据目录里，后台「系统」页看得到。
// 没有外部通道也能用：告警先进本站队列，配了通道再往外推，不靠人盯 journalctl。
// 设计取舍：
//   - 落盘而不是只存内存：进程被 systemd 重启后，出事的那条不能跟着消失；
//   - 同一条告警 30 分钟内只累加次数，不刷屏（一次上游抖动不该产生 200 条）；
//   - 磁盘检查用 statfs，不跑 df 子进程（省一行 shell，也不受容器里没有 df 影响）；
//   - 外推绝不阻塞请求：告警常由 5xx 处理器调用，等 5 秒算超时等于把故障放大一圈；
//   - 推失败不丢：进投递队列按 1 / 5 / 15 分钟重试，后台能看见待重试与已失败。
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.mjs'
import { resolveChannel, signBody } from './alert-channel.mjs'

const COOLDOWN_MS = 30 * 60 * 1000
const MAX_ALERTS = 200
const WATCH_MS = 5 * 60 * 1000
const OUTBOX_MAX = 100
const MAX_ATTEMPTS = 4
const SEND_TIMEOUT_MS = 5000
const DRAIN_MS = 30 * 1000
// 第一次立即发；失败后隔 1 / 5 / 15 分钟再试。接收端跟着一起挂是最常见的情况。
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]

const file = () => path.join(config.dataDir, 'alerts.json')
const outboxFile = () => path.join(config.dataDir, 'alert-outbox.json')

let cache = null
let writeChain = Promise.resolve()
let outbox = null
let outboxChain = Promise.resolve()
// 投递链：recordAlert 只往这里排队，绝不等它
let notifyChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fsp.readFile(file(), 'utf8'))
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  return cache
}

function persist(list) {
  cache = list
  const target = file()
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(config.dataDir, { recursive: true })
      const tmp = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
      await fsp.rename(tmp, target)
    })
    .catch(() => {})
  return writeChain
}

async function loadOutbox() {
  if (outbox) return outbox
  try {
    const parsed = JSON.parse(await fsp.readFile(outboxFile(), 'utf8'))
    outbox = {
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      sent: { count: Number(parsed?.sent?.count) || 0, lastAt: String(parsed?.sent?.lastAt || ''), lastStatus: Number(parsed?.sent?.lastStatus) || 0 },
    }
  } catch {
    outbox = { items: [], sent: { count: 0, lastAt: '', lastStatus: 0 } }
  }
  return outbox
}

function persistOutbox(next) {
  outbox = next
  const target = outboxFile()
  outboxChain = outboxChain
    .then(async () => {
      await fsp.mkdir(config.dataDir, { recursive: true })
      const tmp = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
      await fsp.rename(tmp, target)
    })
    .catch(() => {})
  return outboxChain
}

export const ALERT_KINDS = {
  'server-5xx': '服务端 5xx',
  'model-blocked': '模型上游失败（额度/凭证）',
  'disk-low': '磁盘剩余不足',
  test: '测试告警',
}

function alertText(alert) {
  return '[' + (ALERT_KINDS[alert.kind] || alert.kind) + '] ' + alert.title + (alert.detail ? ' · ' + alert.detail : '') + '（第 ' + alert.count + ' 次，' + alert.lastAt + '）'
}

// 发一条出去。返回 { channel:false } 表示现在没有通道，不算失败也不进队列。
async function sendText(text, alert) {
  const channel = await resolveChannel()
  if (!channel.url || !channel.enabled) return { channel: false, ok: false, status: 0 }
  const body = JSON.stringify({ text, alert: alert ? { id: alert.id, kind: alert.kind, level: alert.level, title: alert.title, detail: alert.detail, count: alert.count, lastAt: alert.lastAt } : null, source: 'visionqa' })
  const headers = { 'content-type': 'application/json', 'user-agent': 'VisionQA-alert/1' }
  if (channel.secret) headers['x-vq-signature'] = signBody(channel.secret, body)
  const startedAt = Date.now()
  try {
    const res = await fetch(channel.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
    const detail = res.ok ? '' : String(await res.text().catch(() => '')).slice(0, 160)
    return { channel: true, ok: res.ok, status: res.status, ms: Date.now() - startedAt, error: detail }
  } catch (error) {
    return { channel: true, ok: false, status: 0, ms: Date.now() - startedAt, error: String(error?.message || error).slice(0, 160) }
  }
}

async function pushOutbox(alert, text, result) {
  const box = await loadOutbox()
  const item = {
    id: 'odb_' + crypto.randomUUID().slice(0, 8),
    alertId: alert?.id || '',
    kind: alert?.kind || 'test',
    title: String(alert?.title || '未命名告警').slice(0, 160),
    text: String(text).slice(0, 600),
    attempts: 1,
    nextAt: new Date(Date.now() + RETRY_DELAYS_MS[0]).toISOString(),
    lastStatus: result.status,
    lastError: String(result.error || '').slice(0, 160),
    state: 'pending',
    createdAt: new Date().toISOString(),
  }
  const items = [item, ...box.items].slice(0, OUTBOX_MAX)
  await persistOutbox({ ...box, items })
  return item
}

// 一条告警的首次投递。永不让异常跑出去：告警自己失败不能再把错误处理打挂一次。
async function attempt(alert) {
  try {
    const text = alertText(alert)
    const result = await sendText(text, alert)
    if (!result.channel) return
    alert.notify = {
      at: new Date().toISOString(),
      ok: result.ok,
      status: result.status,
      ms: result.ms || 0,
      error: result.ok ? '' : String(result.error || '').slice(0, 160),
    }
    if (result.ok) {
      const box = await loadOutbox()
      await persistOutbox({ ...box, sent: { count: box.sent.count + 1, lastAt: alert.notify.at, lastStatus: result.status } })
    } else {
      await pushOutbox(alert, text, result)
    }
    await persist(await loadAll())
  } catch {
    // 落盘或网络之外的意外：只留日志，不影响调用方
    try {
      console.warn('[alert] 投递失败', alert?.id)
    } catch {}
  }
}

// 记一条告警。dedupeKey 相同且未确认、30 分钟内 → 累加次数，否则新开一条。
// 返回时告警已经落盘，外推才刚排上队——所以这里永远不会等网络。
export async function recordAlert({ kind = 'test', title, detail = '', level = 'error', dedupeKey = '' }) {
  try {
    const list = await loadAll()
    const now = Date.now()
    // 没给 dedupeKey 的（磁盘、测试这类全局事件）按 kind 合并，避免标题措辞一变就多一条
    const key = dedupeKey || kind
    const existing = list.find(
      (item) => !item.ackAt && (item.dedupeKey || item.kind) === key && now - Date.parse(item.lastAt) <= COOLDOWN_MS,
    )
    if (existing) {
      existing.count += 1
      existing.lastAt = new Date(now).toISOString()
      if (detail) existing.detail = String(detail).slice(0, 400)
      await persist(list)
      notifyChain = notifyChain.then(() => attempt(existing))
      return existing
    }
    const alert = {
      id: 'alt_' + crypto.randomUUID().slice(0, 8),
      kind,
      level,
      title: String(title || '未命名告警').slice(0, 160),
      detail: String(detail || '').slice(0, 400),
      dedupeKey: key.slice(0, 200),
      count: 1,
      firstAt: new Date(now).toISOString(),
      lastAt: new Date(now).toISOString(),
      ackAt: null,
      ackBy: '',
    }
    list.unshift(alert)
    if (list.length > MAX_ALERTS) list.splice(MAX_ALERTS)
    await persist(list)
    notifyChain = notifyChain.then(() => attempt(alert))
    return alert
  } catch {
    // 告警自己失败绝不能再往上抛：它被 5xx 处理器调用，抛出去会把错误处理再打挂一次
    return null
  }
}

// 等所有已排队的投递结束。测试与优雅退出用；业务代码不要 await 它。
export function flushAlertDeliveries() {
  return notifyChain.catch(() => {})
}

// 重试队列：把到期的再发一遍。force=true 无视时间，ids 只挑指定的几条（手动「重试」用）。
export async function drainOutbox({ force = false, now = Date.now(), ids = null } = {}) {
  const box = await loadOutbox()
  const wanted = Array.isArray(ids) ? new Set(ids) : null
  const due = box.items.filter(
    (item) => item.state !== 'dead' && (!wanted || wanted.has(item.id)) && (force || Date.parse(item.nextAt) <= now),
  )
  if (!due.length) return { checked: 0, sent: 0, failed: 0 }
  const items = [...box.items]
  let sent = 0
  let failed = 0
  let lastOkStatus = box.sent.lastStatus
  for (const item of due) {
    const result = await sendText(item.text, null)
    const index = items.findIndex((row) => row.id === item.id)
    if (index < 0) continue
    if (!result.channel) break
    if (result.ok) {
      items.splice(index, 1)
      sent += 1
      lastOkStatus = result.status || 200
      continue
    }
    failed += 1
    const attempts = Number(item.attempts || 0) + 1
    const dead = attempts >= MAX_ATTEMPTS
    items[index] = {
      ...item,
      attempts,
      state: dead ? 'dead' : 'pending',
      nextAt: dead ? item.nextAt : new Date(Date.now() + (RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])).toISOString(),
      lastStatus: result.status,
      lastError: String(result.error || '').slice(0, 160),
    }
  }
  const next = { items, sent: sent ? { count: box.sent.count + sent, lastAt: new Date().toISOString(), lastStatus: lastOkStatus } : box.sent }
  await persistOutbox(next)
  return { checked: due.length, sent, failed }
}

// 手动重试一条：次数清零、立刻到期。
export async function retryOutboxItem(id) {
  const box = await loadOutbox()
  const item = box.items.find((row) => row.id === id)
  if (!item) return null
  const items = box.items.map((row) => (row.id === id ? { ...row, attempts: 0, state: 'pending', lastError: '' } : row))
  await persistOutbox({ ...box, items })
  await drainOutbox({ force: true, ids: [id] })
  // 发出去了就从队列里消失；还留着说明这次又失败，把最新状态回给调用方
  return (await loadOutbox()).items.find((row) => row.id === id) || { ...item, state: 'sent' }
}

export async function listOutbox({ limit = 20 } = {}) {
  const box = await loadOutbox()
  return box.items.slice(0, Math.max(0, Math.min(OUTBOX_MAX, limit)))
}

export async function outboxStats() {
  const box = await loadOutbox()
  const pending = box.items.filter((item) => item.state !== 'dead')
  const dead = box.items.filter((item) => item.state === 'dead')
  const sorted = [...box.items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return {
    pending: pending.length,
    dead: dead.length,
    total: box.items.length,
    sentCount: box.sent.count,
    lastSentAt: box.sent.lastAt,
    lastSentStatus: box.sent.lastStatus,
    lastAttempt: sorted[0] ? { at: sorted[0].createdAt, status: sorted[0].lastStatus, attempts: sorted[0].attempts, error: sorted[0].lastError, state: sorted[0].state } : null,
  }
}

export async function listAlerts({ status = 'open', limit = 50 } = {}) {
  const list = await loadAll()
  const filtered = status === 'all' ? list : status === 'acked' ? list.filter((item) => item.ackAt) : list.filter((item) => !item.ackAt)
  return filtered.slice(0, Math.max(1, Math.min(200, limit)))
}

export async function alertCounts() {
  const list = await loadAll()
  const open = list.filter((item) => !item.ackAt)
  const byKind = {}
  for (const item of open) byKind[item.kind] = (byKind[item.kind] || 0) + 1
  return { open: open.length, total: list.length, byKind }
}

export async function ackAlert(id, by = '') {
  const list = await loadAll()
  const target = list.find((item) => item.id === id)
  if (!target) return null
  target.ackAt = new Date().toISOString()
  target.ackBy = String(by || '').slice(0, 120)
  await persist(list)
  return target
}

// 磁盘剩余：低于阈值才告警，避免「每天都有告警」变成没人看。
export async function checkDisk({ thresholdBytes } = {}) {
  const threshold = Number(thresholdBytes || config.alerts.diskFreeMb * 1024 * 1024)
  try {
    const info = await fsp.statfs(config.dataDir)
    const freeBytes = Number(info.bavail) * Number(info.bsize)
    const totalBytes = Number(info.blocks) * Number(info.bsize)
    const ok = freeBytes >= threshold
    if (!ok) {
      await recordAlert({
        kind: 'disk-low',
        level: 'warn',
        title: '数据盘剩余空间不足',
        detail: '剩余 ' + (freeBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB，低于阈值 ' + (threshold / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        dedupeKey: 'disk-low',
      })
    }
    return { ok, freeBytes, totalBytes, thresholdBytes: threshold }
  } catch (error) {
    return { ok: true, freeBytes: 0, totalBytes: 0, thresholdBytes: threshold, error: String(error?.message || error).slice(0, 200) }
  }
}

let timer = null
let drainTimer = null

export function startAlertWatch() {
  if (timer) return
  checkDisk().catch(() => {})
  timer = setInterval(() => {
    checkDisk().catch(() => {})
  }, WATCH_MS)
  // 不要让这个定时器把进程钉在后台（systemd 重启时才能干净退出）
  timer.unref?.()

  // 重启后先补一次：上次进程退出时没发出去的那几条，不能等下一次事故才想起
  drainOutbox().catch(() => {})
  drainTimer = setInterval(() => {
    drainOutbox().catch(() => {})
  }, DRAIN_MS)
  drainTimer.unref?.()
}
