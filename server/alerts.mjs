// 可观测性：5xx / 上游失败 / 磁盘不足 三类告警，落在数据目录里，后台「系统」页看得到。
// 没有外部通道也能用：告警先进本站队列（可选 webhook 推送），不靠人盯 journalctl。
// 设计取舍：
//   - 落盘而不是只存内存：进程被 systemd 重启后，出事的那条不能跟着消失；
//   - 同一条告警 30 分钟内只累加次数，不刷屏（一次上游抖动不该产生 200 条）；
//   - 磁盘检查用 statfs，不跑 df 子进程（省一行 shell，也不受容器里没有 df 影响）。
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.mjs'

const COOLDOWN_MS = 30 * 60 * 1000
const MAX_ALERTS = 200
const WATCH_MS = 5 * 60 * 1000

const file = () => path.join(config.dataDir, 'alerts.json')

let cache = null
let writeChain = Promise.resolve()

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
  writeChain = writeChain.then(async () => {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const tmp = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    await fsp.rename(tmp, target)
  }).catch(() => {})
  return writeChain
}

export const ALERT_KINDS = {
  'server-5xx': '服务端 5xx',
  'model-blocked': '模型上游失败（额度/凭证）',
  'disk-low': '磁盘剩余不足',
  test: '测试告警',
}

async function dispatch(alert) {
  const webhook = config.alerts.webhook
  if (!webhook) return { channel: 'none' }
  const text = '[' + (ALERT_KINDS[alert.kind] || alert.kind) + '] ' + alert.title + (alert.detail ? ' · ' + alert.detail : '') + '（第 ' + alert.count + ' 次，' + alert.lastAt + '）'
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, alert }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    alert.notify = { at: new Date().toISOString(), ok: res.ok, status: res.status }
    return alert.notify
  } catch (error) {
    alert.notify = { at: new Date().toISOString(), ok: false, status: 0, error: String(error?.message || error).slice(0, 160) }
    return alert.notify
  }
}

// 记一条告警。dedupeKey 相同且未确认、30 分钟内 → 累加次数，否则新开一条。
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
      await dispatch(existing)
      await persist(list)
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
    await dispatch(alert)
    list.unshift(alert)
    if (list.length > MAX_ALERTS) list.splice(MAX_ALERTS)
    await persist(list)
    return alert
  } catch {
    // 告警自己失败绝不能再往上抛：它被 5xx 处理器调用，抛出去会把错误处理再打挂一次
    return null
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

export function startAlertWatch() {
  if (timer) return
  checkDisk().catch(() => {})
  timer = setInterval(() => {
    checkDisk().catch(() => {})
  }, WATCH_MS)
  // 不要让这个定时器把进程钉在后台（systemd 重启时才能干净退出）
  timer.unref?.()
}
