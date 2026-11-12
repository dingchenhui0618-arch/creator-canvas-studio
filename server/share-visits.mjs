// 分享链接的打开记录：只回答「这条链接被打开过几次、最近一次什么时候、从哪类客户端」。
//
// 三条边界，都是为了不让它变成监控：
// 1. 不存 token 本身，只存 SHA-256 的前 16 位——记录文件被看到也拿不到能打开作品的链接；
// 2. 不存 IP、不存原始 UA，只留「微信 / 手机或平板 / 电脑 / 未知」这一类；
// 3. 60 秒内的连续打开算一次：分享页一刷新就会再请求一次数据，不设窗口会刷出假次数。
//
// 记的是「打开分享页」这件事，不是「谁看的」：没有账号就没有身份，界面文案不许说成人数。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { config } from './config.mjs'

const visitsFile = path.join(config.dataDir, 'share-visits.json')
// 这条记录是给人看的，不是审计日志：只留最近打开过的 200 条链接
const MAX_ENTRIES = 200
// 同一条链接多少毫秒内的再次打开不重复计数
export const OPEN_DEDUPE_MS = 60_000

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fsp.readFile(visitsFile, 'utf8'))
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    cache = {}
  }
  return cache
}

// 整文件读改写：写盘串成一条队列，避免两个请求共用一个 .tmp 互相 rename 掉对方。
function enqueueWrite(task) {
  const next = writeChain.then(task, task)
  writeChain = next.catch(() => {})
  return next
}

async function persist(data) {
  cache = data
  return enqueueWrite(async () => {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const tmp = visitsFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fsp.rename(tmp, visitsFile)
  })
}

/** 记录键：token 的哈希前缀。太短的 token 不是有效分享链接，不记。 */
export function visitKey(token) {
  if (typeof token !== 'string' || token.length < 16) return ''
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

/** 客户端分类：只分四类，够回答「甲方是微信里点的还是电脑上看的」。 */
export function clientKind(userAgent) {
  const ua = String(userAgent || '')
  if (!ua.trim()) return 'other'
  if (/MicroMessenger|WeChat/i.test(ua)) return 'wechat'
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return 'mobile'
  if (/Windows|Macintosh|Mac OS X|Linux|CrOS/i.test(ua)) return 'desktop'
  return 'other'
}

export const EMPTY_VISITS = { opens: 0, firstAt: '', lastAt: '', lastClient: '' }

function entryView(entry) {
  if (!entry) return { ...EMPTY_VISITS }
  return {
    opens: Math.max(0, Math.round(Number(entry.opens) || 0)),
    firstAt: String(entry.firstAt || ''),
    lastAt: String(entry.lastAt || ''),
    lastClient: String(entry.lastClient || ''),
  }
}

// 超出上限时按最近一次打开的时间留新的：没人再打开的旧链接先被忘掉。
function prune(all) {
  const keys = Object.keys(all)
  if (keys.length <= MAX_ENTRIES) return all
  const kept = keys
    .sort((a, b) => String(all[b]?.lastAt || '').localeCompare(String(all[a]?.lastAt || '')))
    .slice(0, MAX_ENTRIES)
  const next = {}
  for (const key of kept.sort()) next[key] = all[key]
  return next
}

/**
 * 记一次分享页打开。返回这条链接的最新统计。
 * nowMs 只为测试注入；生产走真实时间。
 */
export async function recordShareOpen(token, userAgent, nowMs = Date.now()) {
  const key = visitKey(token)
  if (!key) return { ...EMPTY_VISITS }
  const all = await loadAll()
  const iso = new Date(nowMs).toISOString()
  const kind = clientKind(userAgent)
  const entry = all[key] || { opens: 0, firstAt: iso, lastAt: '', lastClient: '' }
  // 窗口对着「上一次真正计数的那一次」算，不是对着 lastAt：
  // 否则每隔几十秒刷新一次的人会让窗口一直往后滑，一晚上都只算一次。
  const countedAt = Date.parse(entry.countedAt || entry.lastAt)
  const counted = !Number.isFinite(countedAt) || nowMs - countedAt >= OPEN_DEDUPE_MS
  if (counted) {
    entry.opens = Math.max(0, Math.round(Number(entry.opens) || 0)) + 1
    entry.countedAt = iso
    if (!entry.firstAt) entry.firstAt = iso
  }
  entry.lastAt = iso
  entry.lastClient = kind
  all[key] = entry
  await persist(counted ? prune(all) : all)
  return entryView(entry)
}

/**
 * 按记录键读。停用分享时 token 就被清掉了，历史链接只剩这个哈希前缀：
 * 作品页回看「那一轮被打开过几次」只能走这里。
 */
export async function getShareVisitsByKey(key) {
  if (typeof key !== 'string' || !/^[0-9a-f]{16}$/.test(key)) return { ...EMPTY_VISITS }
  const all = await loadAll()
  return entryView(all[key])
}

/** 作品页的分享面板读这条：没开过分享、或者没人打开过，都返回全零。 */
export async function getShareVisits(token) {
  return getShareVisitsByKey(visitKey(token))
}

/** 停掉分享时不清记录：链接虽然失效了，但「它被打开过几次」是发生过的事。 */
export const SHARE_VISIT_LIMIT = MAX_ENTRIES