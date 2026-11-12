import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'

// 侵权 / 不当内容举报：分享页与公共模板都能报，不要求登录（被侵权的人不一定有账号）。
// 落 data/reports.json，最多 500 条；同一 IP 对同一条模板 10 分钟内只算一次，
// 避免有人写脚本刷队列。管理员在后台「举报处理」里看队列、驳回或下架。

const CAP = 500
const DEDUPE_MS = 10 * 60 * 1000

export const REPORT_CATEGORIES = {
  copyright: '版权 / 搬运',
  portrait: '肖像 / 隐私',
  abuse: '不当内容',
  other: '其他',
}

const CATEGORY_KEYS = new Set(Object.keys(REPORT_CATEGORIES))

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(config.dataDir, 'reports.json'), 'utf8'))
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
  return enqueueWrite(async () => {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const file = path.join(config.dataDir, 'reports.json')
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  })
}

const clean = (value, max) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

export async function createReport({ target = {}, category = 'other', detail = '', contact = '', user = null, ip = '' }) {
  const kind = ['template', 'share'].includes(target.kind) ? target.kind : 'template'
  const targetId = clean(target.id, 60)
  const text = clean(detail, 1000)
  if (!targetId) return { ok: false, code: 'NO_TARGET' }
  if (text.length < 5) return { ok: false, code: 'DETAIL_TOO_SHORT' }
  const at = new Date().toISOString()
  const entry = {
    id: 'rep_' + randomUUID().slice(0, 8),
    at,
    lastAt: at,
    count: 1,
    status: 'open',
    category: CATEGORY_KEYS.has(category) ? category : 'other',
    detail: text,
    contact: clean(contact, 120),
    target: {
      kind,
      id: targetId,
      title: clean(target.title, 160),
      url: clean(target.url, 400),
    },
    userId: user?.id || '',
    ip: clean(ip, 60),
    resolvedAt: '',
    resolvedBy: '',
    resolution: '',
    note: '',
  }
  const list = await loadAll()
  const now = Date.now()
  // 匿名举报按 IP 去重；登录用户按账号去重
  const same = list.find(
    (item) =>
      item.status === 'open' &&
      item.target.id === entry.target.id &&
      (user?.id ? item.userId === user.id : item.ip === entry.ip) &&
      now - Date.parse(item.lastAt) < DEDUPE_MS,
  )
  if (same) {
    const next = list.map((item) => (item === same ? { ...item, count: item.count + 1, lastAt: at } : item))
    await persist(next)
    return { ok: true, report: next.find((item) => item.id === same.id), duplicate: true }
  }
  const next = [entry, ...list].slice(0, CAP)
  await persist(next)
  return { ok: true, report: entry, duplicate: false }
}

export async function listReports({ status = 'open', limit = 50 } = {}) {
  const list = await loadAll()
  const filtered = status === 'all' ? list : list.filter((item) => item.status === status)
  const sorted = [...filtered].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
  const open = list.filter((item) => item.status === 'open').length
  return {
    items: sorted.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))),
    total: list.length,
    open,
    categories: REPORT_CATEGORIES,
  }
}

export async function resolveReport(id, { action = 'dismiss', note = '', by = '' } = {}) {
  const list = await loadAll()
  const index = list.findIndex((item) => item.id === id)
  if (index < 0) return null
  const next = [...list]
  next[index] = {
    ...next[index],
    status: action === 'takedown' ? 'takedown' : 'dismissed',
    resolution: action,
    note: clean(note, 500),
    resolvedAt: new Date().toISOString(),
    resolvedBy: clean(by, 120),
  }
  await persist(next)
  return next[index]
}

export async function reportCounts() {
  const list = await loadAll()
  return {
    open: list.filter((item) => item.status === 'open').length,
    dismissed: list.filter((item) => item.status === 'dismissed').length,
    takedown: list.filter((item) => item.status === 'takedown').length,
    total: list.length,
  }
}
