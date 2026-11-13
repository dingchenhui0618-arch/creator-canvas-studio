// 应用内反馈：用户遇到问题、想要什么能力，直接在界面里写，落 data/feedback.json，管理员在后台「反馈」里处理。
// 为什么不用「客服邮箱」：邮箱还在等配置（A7），而登录进不来的人最需要一条求助路径。
// 设计取舍：
//   - 落盘而不是只进内存：反馈的价值在「有人回头处理」，重启不能把它丢了；
//   - 允许匿名提交（登录失败恰恰是最常见的问题），但匿名必须留联系方式，否则处理完也没法回；
//   - 同一账号 / 同一 IP 十分钟内提交一模一样的文字只算一条，双击和网络重试不刷队列；
//   - 管理员回复写在条目里，登录用户下次打开设置页就能看到处理结果；
//   - 队列封顶 1000 条，超出丢最旧的，不让一个公开接口把数据目录写满。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'

const CAP = 1000
const DEDUPE_MS = 10 * 60 * 1000

export const FEEDBACK_KINDS = {
  problem: '功能问题',
  idea: '改进建议',
  other: '其他',
}

export const FEEDBACK_STATUS = {
  new: '待处理',
  reading: '处理中',
  done: '已处理',
}

const KIND_KEYS = new Set(Object.keys(FEEDBACK_KINDS))
const STATUS_KEYS = new Set(Object.keys(FEEDBACK_STATUS))

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(config.dataDir, 'feedback.json'), 'utf8'))
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
    const file = path.join(config.dataDir, 'feedback.json')
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  })
}

const clean = (value, max) =>
  String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max)

export async function createFeedback({ kind = 'other', body = '', contact = '', page = '', user = null, ip = '', ua = '' } = {}) {
  const text = clean(body, 2000)
  if (text.length < 5) return { ok: false, code: 'BODY_TOO_SHORT' }
  const contactText = clean(contact, 120)
  if (!user && contactText.length < 5) return { ok: false, code: 'CONTACT_REQUIRED' }
  const list = await loadAll()
  const now = Date.now()
  const same = list.find(
    (item) =>
      item.body === text &&
      now - Date.parse(item.createdAt) < DEDUPE_MS &&
      (user?.id ? item.userId === user.id : item.ip === ip),
  )
  if (same) return { ok: true, item: same, duplicate: true }
  const at = new Date().toISOString()
  const entry = {
    id: 'fb_' + randomUUID().slice(0, 8),
    kind: KIND_KEYS.has(kind) ? kind : 'other',
    body: text,
    contact: contactText || String(user?.email || ''),
    page: clean(page, 200),
    status: 'new',
    reply: '',
    userId: user?.id || '',
    userEmail: String(user?.email || ''),
    ip: clean(ip, 60),
    ua: clean(ua, 200),
    createdAt: at,
    updatedAt: at,
    resolvedAt: '',
    handledBy: '',
  }
  await persist([entry, ...list].slice(0, CAP))
  return { ok: true, item: entry, duplicate: false }
}

export async function listFeedback({ status = 'new', limit = 50 } = {}) {
  const list = await loadAll()
  const filtered = status === 'all' ? list : list.filter((item) => item.status === status)
  const sorted = [...filtered].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return {
    items: sorted.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))),
    total: list.length,
    counts: await feedbackCounts(),
    kinds: FEEDBACK_KINDS,
    statuses: FEEDBACK_STATUS,
  }
}

export async function listMyFeedback(userId, limit = 10) {
  if (!userId) return []
  const list = await loadAll()
  return list
    .filter((item) => item.userId === userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 10)))
}

export async function updateFeedback(id, { status = '', reply = null, by = '' } = {}) {
  const list = await loadAll()
  const index = list.findIndex((item) => item.id === id)
  if (index < 0) return { ok: false, code: 'NOT_FOUND' }
  if (status && !STATUS_KEYS.has(status)) return { ok: false, code: 'BAD_STATUS' }
  const current = list[index]
  const nextStatus = status || current.status
  const at = new Date().toISOString()
  const next = [...list]
  next[index] = {
    ...current,
    status: nextStatus,
    reply: reply === null ? current.reply : clean(reply, 800),
    updatedAt: at,
    resolvedAt: nextStatus === 'done' ? at : '',
    handledBy: clean(by, 120) || current.handledBy,
  }
  await persist(next)
  return { ok: true, item: next[index] }
}

export async function feedbackCounts() {
  const list = await loadAll()
  return {
    new: list.filter((item) => item.status === 'new').length,
    reading: list.filter((item) => item.status === 'reading').length,
    done: list.filter((item) => item.status === 'done').length,
    total: list.length,
  }
}
