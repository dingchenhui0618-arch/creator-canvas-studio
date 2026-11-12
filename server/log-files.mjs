import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'

// 服务端日志落盘 + 保留策略。
//
// 以前日志只往 stdout 走（systemd 收进 journald），能看但不归我们管：
// 谁想按「最近 14 天的访问日志」查一次都得 ssh 上去 journalctl；journal 也没有项目自己的口径。
// 这里补一层自己的日志文件：
//   data/logs/access-YYYY-MM-DD.log   每请求一行 JSON（健康检查与静态资源不记）
//   data/logs/error-YYYY-MM-DD.log    5xx、进程级异常、上游失败
//   data/logs/app-YYYY-MM-DD.log      启动、迁移、告警外推这类事件
// 按天轮转；超过保留天数（默认 14 天）或总量超过上限（默认 200MB）就从最旧的开始删。
// 写盘走一条队列，避免并发 append 争同一个文件；清理每小时最多跑一次，不拖慢请求。

const KINDS = new Set(['access', 'error', 'app'])
const NAME = /^(access|error|app)-(\d{4})-(\d{2})-(\d{2})\.log$/
const DAY_MS = 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

let queue = Promise.resolve()
let lastPrune = 0

const pad = (value) => String(value).padStart(2, '0')

export function dayKey(date = new Date()) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

export function logFilePath(kind, date = new Date()) {
  return path.join(config.logs.dir, kind + '-' + dayKey(date) + '.log')
}

export function appendLog(kind, payload) {
  if (!KINDS.has(kind)) return
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const file = logFilePath(kind)
  queue = queue
    .then(async () => {
      await fsp.mkdir(config.logs.dir, { recursive: true })
      await fsp.appendFile(file, text + '\n', 'utf8')
    })
    .catch(() => {})
  maybePrune()
}

/** 测试与关停时用：等队列里最后一次写盘落完。 */
export function flushLogs() {
  return queue
}

function maybePrune() {
  const now = Date.now()
  if (now - lastPrune < PRUNE_INTERVAL_MS) return
  lastPrune = now
  void pruneLogs().catch(() => {})
}

async function readEntries() {
  let names = []
  try {
    names = await fsp.readdir(config.logs.dir)
  } catch {
    return []
  }
  const entries = []
  for (const name of names) {
    const match = NAME.exec(name)
    if (!match) continue
    const [, kind, year, month, day] = match
    const file = path.join(config.logs.dir, name)
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile()) continue
      entries.push({
        name,
        kind,
        day: year + '-' + month + '-' + day,
        at: new Date(Number(year), Number(month) - 1, Number(day)).getTime(),
        bytes: stat.size,
        mtime: stat.mtime.toISOString(),
      })
    } catch {
      // 刚好被删掉的文件跳过
    }
  }
  entries.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
  return entries
}

/** 到期的先按天数删，再按总量上限从最旧的删。返回删了哪些、省了多少。 */
export async function pruneLogs({
  retentionDays = config.logs.retentionDays,
  maxTotalMb = config.logs.maxTotalMb,
} = {}) {
  const entries = await readEntries()
  const cutoff = Date.now() - Math.max(1, retentionDays) * DAY_MS
  const removed = []
  let bytesFreed = 0
  let kept = []

  for (const entry of entries) {
    // 当天 00:00 起算，正好保留 N 个自然日
    if (entry.at < cutoff) {
      try {
        await fsp.unlink(path.join(config.logs.dir, entry.name))
        removed.push(entry.name)
        bytesFreed += entry.bytes
      } catch {
        kept.push(entry)
      }
      continue
    }
    kept.push(entry)
  }

  // 上限是「MB」但允许小数：测试与临时环境会把它调到很小，别偷偷抬回 1MB
  const maxBytes = Math.max(1, Math.round(maxTotalMb * 1024 * 1024))
  let total = kept.reduce((sum, entry) => sum + entry.bytes, 0)
  while (total > maxBytes && kept.length > 1) {
    const oldest = kept.shift()
    try {
      await fsp.unlink(path.join(config.logs.dir, oldest.name))
      removed.push(oldest.name)
      bytesFreed += oldest.bytes
      total -= oldest.bytes
    } catch {
      break
    }
  }

  return { removed, bytesFreed, kept: kept.length }
}

export async function listLogs({ limit = 60 } = {}) {
  const entries = await readEntries()
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const newest = entries[entries.length - 1] || null
  const oldest = entries[0] || null
  return {
    dir: config.logs.dir,
    retentionDays: config.logs.retentionDays,
    maxTotalMb: config.logs.maxTotalMb,
    totalFiles: entries.length,
    totalBytes,
    oldestDay: oldest ? oldest.day : '',
    newestDay: newest ? newest.day : '',
    files: [...entries].reverse().slice(0, Math.max(1, Math.min(200, Number(limit) || 60))),
  }
}

/** 进程启动时先清一次：停机久了也不会把过期日志一直留着。 */
export async function startLogRetention() {
  return pruneLogs().catch(() => ({ removed: [], bytesFreed: 0, kept: 0 }))
}
