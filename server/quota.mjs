// 每月额度（v0.9.64）：按账号限制一个自然月能消耗多少积分。
//
// 为什么要有这一层：积分余额只管「还有没有钱」，管不了「一个月最多花多少」。
// 一个账号被脚本刷、或者一个演示账号被多人共用，余额会在几小时内见底；
// 事后从流水里看得出来，但钱已经花在上游了。配额在扣费之前拦一道，超了就是 429，
// 不扣积分、也不调用上游。
//
// 三个刻意的决定：
//   1. 默认 0 = 不限：额度数字是商务决定，没定之前不偷偷替用户设上限；
//   2. 上限可在后台按账号单独覆盖：内测期给某人放宽，不用改全局；
//   3. 口径只看积分流水：本月消耗 = 本月扣费 - 本月退款，管理员扣减不算消耗，
//      赠送的积分也不算「花掉了」——用户看到的就是「这个月花了多少」。
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { findUserById, listUsers, openDb } from './auth.mjs'

const file = path.join(config.dataDir, 'quota.json')
const MAX_LIMIT = 1_000_000
let cache = null

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    cache = parsed && typeof parsed === 'object' ? parsed : { monthlyLimit: 0, overrides: {} }
  } catch {
    cache = { monthlyLimit: 0, overrides: {} }
  }
  if (!cache.overrides || typeof cache.overrides !== 'object') cache.overrides = {}
  return cache
}

function persist(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  cache = data
}

function cleanLimit(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const int = Math.trunc(num)
  if (int !== num) return null
  if (int < 0 || int > MAX_LIMIT) return null
  return int
}

/** 自然月按 UTC 算：和后台「成本」页的日口径一致，页面会写明 UTC，避免和本地「这个月」对不上。 */
export function monthWindow(now = Date.now()) {
  const date = new Date(now)
  const from = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  const to = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  return {
    month: new Date(from).toISOString().slice(0, 7),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  }
}

/** 本月消耗：扣费绝对值减本月退款，不把管理员扣减和赠送算成消耗。 */
export function monthlySpend(userId, now = Date.now()) {
  if (!userId) return 0
  const { from } = monthWindow(now)
  const row = openDb()
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN delta < 0 AND kind <> 'deduct' THEN -delta ELSE 0 END), 0) AS charged, " +
        "COALESCE(SUM(CASE WHEN delta > 0 AND kind LIKE '%-refund' THEN delta ELSE 0 END), 0) AS refunded " +
        'FROM credit_ledger WHERE user_id = ? AND created_at >= ?',
    )
    .get(String(userId), from)
  return Math.max(0, Number(row?.charged || 0) - Number(row?.refunded || 0))
}

function spendByUser(now = Date.now()) {
  const { from } = monthWindow(now)
  const rows = openDb()
    .prepare(
      "SELECT user_id, SUM(CASE WHEN delta < 0 AND kind <> 'deduct' THEN -delta ELSE 0 END) - " +
        "SUM(CASE WHEN delta > 0 AND kind LIKE '%-refund' THEN delta ELSE 0 END) AS spent " +
        'FROM credit_ledger WHERE created_at >= ? GROUP BY user_id',
    )
    .all(from)
  const out = new Map()
  for (const row of rows) out.set(String(row.user_id), Math.max(0, Number(row.spent || 0)))
  return out
}

export function quotaConfig() {
  const data = load()
  return {
    monthlyLimit: cleanLimit(data.monthlyLimit) || 0,
    overrides: { ...data.overrides },
    updatedAt: String(data.updatedAt || ''),
    updatedBy: String(data.updatedBy || ''),
  }
}

/**
 * 一个账号的额度视图。limit 为 0 表示不限；remaining 为 -1 也只在「不限」时出现，
 * 前端据此显示「未设上限」，而不是编一个假数字。
 */
export function quotaOf(userId, now = Date.now()) {
  const window = monthWindow(now)
  const data = quotaConfig()
  const hasOverride = Boolean(userId) && Object.prototype.hasOwnProperty.call(data.overrides, String(userId))
  // 只对真正存在的覆盖值做清洗：没有覆盖时 cleanLimit(null) 会得到 0，
  // 那会被误读成「这个账号不限」，把默认额度整个吞掉。
  const current = hasOverride ? cleanLimit(data.overrides[String(userId)]) : null
  const limit = current === null ? data.monthlyLimit : current
  const unlimited = !(limit > 0)
  const used = monthlySpend(userId, now)
  return {
    limit: unlimited ? 0 : limit,
    used,
    remaining: unlimited ? -1 : Math.max(0, limit - used),
    unlimited,
    overridden: current !== null,
    // overridden 只看「有没有一个有效覆盖值」：手改坏的值按默认额度算，不假装有覆盖
    month: window.month,
    resetAt: window.to,
    defaultLimit: data.monthlyLimit,
    updatedAt: data.updatedAt,
    updatedBy: data.updatedBy,
  }
}

function quotaMessage(view, cost) {
  const resetDay = String(view.resetAt || '').slice(0, 10)
  return (
    '本月额度用完了：每月上限 ' + view.limit + ' 积分，已用 ' + view.used + ' 积分，这次需要 ' + cost + ' 积分。' +
    '额度每月 1 日（UTC）重置，下次是 ' + resetDay + '；管理员可以在后台「计费 → 每月额度」给这个账号单独提额。'
  )
}

/** 扣费前的闸门：超了就整单不做，不扣积分、不调上游。cost <= 0 的调用（免费）不受限。 */
export function checkQuota(userId, cost, now = Date.now()) {
  const view = quotaOf(userId, now)
  const price = Math.max(0, Math.round(Number(cost) || 0))
  if (view.unlimited || price <= 0) return { ok: true, ...view }
  if (view.used + price <= view.limit) return { ok: true, ...view }
  return { ok: false, code: 'MONTHLY_QUOTA', cost: price, message: quotaMessage(view, price), ...view }
}

/** 路由层把 checkQuota 的拒绝原样写成 429：状态码与字段都由这里定，五处调用点不用各写一份。 */
export function quotaRefusal(paid) {
  return {
    status: 429,
    body: {
      error: paid.message,
      code: 'MONTHLY_QUOTA',
      limit: paid.limit,
      used: paid.used,
      remaining: paid.remaining,
      cost: paid.cost,
      month: paid.month,
      resetAt: paid.resetAt,
    },
  }
}

// ---- 后台维护 ----

export function saveQuota(patch = {}, by = '') {
  if (patch.monthlyLimit === undefined) return { ok: false, error: '缺少每月额度（0 表示不限）' }
  const limit = cleanLimit(patch.monthlyLimit)
  if (limit === null) return { ok: false, error: '每月额度要写 0–' + MAX_LIMIT + ' 的整数（0 表示不限）' }
  const data = load()
  data.monthlyLimit = limit
  data.updatedAt = new Date().toISOString()
  data.updatedBy = String(by || '')
  persist({ ...data, overrides: { ...data.overrides } })
  return { ok: true, ...quotaConfig() }
}

export function setQuotaOverride(userId, limit, by = '') {
  const target = String(userId || '')
  if (!target) return { ok: false, code: 'NOT_FOUND', error: '没有这个账号' }
  if (!findUserById(target)) return { ok: false, code: 'NOT_FOUND', error: '这个账号不存在（可能已被删除）' }
  const value = cleanLimit(limit)
  if (value === null) return { ok: false, error: '单独额度要写 0–' + MAX_LIMIT + ' 的整数（0 表示不限）' }
  const data = load()
  data.overrides = { ...data.overrides, [target]: value }
  data.updatedAt = new Date().toISOString()
  data.updatedBy = String(by || '')
  persist(data)
  return { ok: true, ...quotaOf(target) }
}

export function clearQuotaOverride(userId) {
  const target = String(userId || '')
  const data = load()
  if (!Object.prototype.hasOwnProperty.call(data.overrides, target)) {
    return { ok: false, code: 'NOT_FOUND', error: '这个账号没有单独额度（走的是默认额度）' }
  }
  const overrides = { ...data.overrides }
  delete overrides[target]
  data.overrides = overrides
  data.updatedAt = new Date().toISOString()
  persist(data)
  return { ok: true, ...quotaOf(target) }
}

/**
 * 后台视图：默认额度 + 「本月花过钱或单独设过额度」的账号。
 * 一屏就能看出「谁在用、用了多少、上限是多少」，不用再点进每个账号。
 */
export function quotaOverview() {
  const window = monthWindow()
  const data = quotaConfig()
  const spent = spendByUser()
  const rows = listUsers()
    .map((user) => {
      const override = Object.prototype.hasOwnProperty.call(data.overrides, user.id) ? data.overrides[user.id] : null
      const limit = override === null ? data.monthlyLimit : override
      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        kind: user.kind,
        active: user.active,
        credits: user.credits,
        used: spent.get(user.id) || 0,
        override,
        limit,
        unlimited: !(limit > 0),
      }
    })
    .filter((row) => row.used > 0 || row.override !== null)
    .sort((a, b) => b.used - a.used || String(a.email).localeCompare(String(b.email)))
    .slice(0, 50)
  return {
    monthlyLimit: data.monthlyLimit,
    updatedAt: data.updatedAt,
    updatedBy: data.updatedBy,
    month: window.month,
    resetAt: window.to,
    overrideCount: Object.keys(data.overrides).length,
    rows,
  }
}

/** 测试用：扔掉缓存，下一次读文件。 */
export function resetQuotaCache() {
  cache = null
}
