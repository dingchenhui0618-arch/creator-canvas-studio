// 上游余额：后台「模型与上游」按渠道显示各家还剩多少钱，低于阈值标红。
//
// 口径与坑（2026-11-18 实测，别再走一遍弯路）：
//   - GeteAPI 是 New API 底座。**它的 sk 中转 Key 读不到余额**：
//     /v1/dashboard/billing/subscription 会返回 200，但 hard_limit_usd 是 100000000 这种占位值，
//     /v1/dashboard/billing/credit_grants 直接 404。要读真实余额只能用「账号访问令牌」打
//     /api/user/self，拿 quota 除以 /api/status 的 quota_per_unit（本站 500000）换成金额。
//   - SeeAPI / CGCM 没有余额接口（/v1/dashboard/*、/api/balance、/api/user/balance 全 404），
//     所以这条渠道只能手动登记，界面上必须标明「手动登记」，别让人以为是实时数。
//   - 访问令牌是凭证：接口只回「有没有、末四位」，明文只落在数据目录（0600）。
//
// 这里的函数不碰 HTTP 路由，方便单测；路由在 routes/admin.mjs。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'

export const balanceFile = () => path.join(config.dataDir, 'upstream-balance.json')

/** 低于这个数（与渠道同一货币）就标红。管理员可以按渠道改。 */
export const DEFAULT_THRESHOLD = 20
/** 余额缓存 10 分钟：上游余额不会秒级变化，不必每次开页面都打一次上游。 */
export const BALANCE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

export const BALANCE_CHANNELS = [
  {
    id: 'geteapi',
    label: '主通道 A',
    kind: 'newapi',
    baseUrl: 'https://www.geteapi.com',
    note: 'New API 底座：用账号访问令牌读 /api/user/self。中转 Key 读不到余额，面板里的硬限额是占位值。',
  },
  {
    id: 'seeapi',
    label: '主通道 B',
    kind: 'manual',
    baseUrl: 'https://api.cgcm-api.com',
    note: '上游没有余额接口（/v1/dashboard、/api/balance 全 404），只能按对账单手动登记。',
  },
]

const CHANNEL_BY_ID = new Map(BALANCE_CHANNELS.map((item) => [item.id, item]))

export function channelMeta(id) {
  return CHANNEL_BY_ID.get(String(id || '')) || null
}

/** quota（New API 的额度单位）→ 金额。quota_per_unit = 多少 quota 换 1 个货币单位。 */
export function quotaToAmount(quota, perUnit) {
  const value = Number(quota)
  const unit = Number(perUnit)
  if (!Number.isFinite(value) || !Number.isFinite(unit) || unit <= 0) return null
  return Math.round((value / unit) * 10000) / 10000
}

/**
 * 货币符号归一。GeteAPI 的 /api/status 里 custom_currency_symbol 回的是 '¤'（通用货币符），
 * 但本站配额按人民币计价（quota_per_unit = 500000，面板显示 ¥），所以 '¤' 与空串都按 ¥ 显示；
 * 上游真的给了别的符号就照用，不替它猜。
 */
export function currencySymbol(raw) {
  const value = String(raw || '').trim()
  if (!value || value === '¤') return '¥'
  return value.slice(0, 4)
}

/** 三态：low（低于阈值）/ ok / unknown（没核对过、没令牌或上游读失败）。 */
export function balanceState(amount, threshold) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return 'unknown'
  const limit = Number(threshold)
  if (!Number.isFinite(limit)) return 'ok'
  return Number(amount) < limit ? 'low' : 'ok'
}

/** 令牌只给末四位；空字符串表示没配。 */
export function maskToken(raw) {
  const value = String(raw || '')
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return '••••' + value.slice(-4)
}

function clampNumber(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function emptyChannel(id) {
  return { accessToken: '', newApiUser: '', threshold: DEFAULT_THRESHOLD, manualAmount: null, last: null, updatedAt: '', updatedBy: '' }
}

/** null / 空串都要当成「没有数」，不能经 Number() 变成 0——那会把「核对失败」显示成余额 0。 */
function toAmountOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeChannel(file, id) {
  const raw = file?.channels?.[id]
  if (!raw || typeof raw !== 'object') return emptyChannel(id)
  const amount = toAmountOrNull(raw.manualAmount)
  const last = raw.last && typeof raw.last === 'object'
    ? {
        amount: toAmountOrNull(raw.last.amount),
        used: toAmountOrNull(raw.last.used),
        currency: String(raw.last.currency || ''),
        source: raw.last.source === 'auto' ? 'auto' : 'manual',
        at: String(raw.last.at || ''),
        error: String(raw.last.error || ''),
      }
    : null
  return {
    accessToken: String(raw.accessToken || ''),
    newApiUser: String(raw.newApiUser || ''),
    threshold: clampNumber(raw.threshold, DEFAULT_THRESHOLD, 0, 1e7),
    manualAmount: amount !== null && amount >= 0 ? amount : null,
    last,
    updatedAt: String(raw.updatedAt || ''),
    updatedBy: String(raw.updatedBy || ''),
  }
}

export async function readBalanceFile() {
  try {
    const parsed = JSON.parse(await fsp.readFile(balanceFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { channels: {} }
    return { channels: parsed.channels && typeof parsed.channels === 'object' ? parsed.channels : {} }
  } catch {
    return { channels: {} }
  }
}

async function persist(file) {
  const target = balanceFile()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = target + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, target)
  await fsp.chmod(target, 0o600).catch(() => {})
}

/** 对外形状：令牌只回掩码与「有没有」，金额带状态。 */
export function channelView(id, channel) {
  const meta = channelMeta(id)
  const amount = channel.last && Number.isFinite(channel.last.amount) ? channel.last.amount : null
  return {
    id,
    label: meta?.label || id,
    kind: meta?.kind || 'manual',
    baseUrl: meta?.baseUrl || '',
    note: meta?.note || '',
    threshold: channel.threshold,
    amount,
    used: channel.last?.used ?? null,
    currency: channel.last?.currency || '',
    source: channel.last?.source || '',
    checkedAt: channel.last?.at || '',
    error: channel.last?.error || '',
    state: balanceState(amount, channel.threshold),
    hasToken: Boolean(channel.accessToken),
    tokenMask: maskToken(channel.accessToken),
    hasNewApiUser: Boolean(channel.newApiUser),
    manualAmount: channel.manualAmount,
    updatedAt: channel.updatedAt,
    updatedBy: channel.updatedBy,
  }
}

/**
 * 后台看到的余额表。
 * ensureFresh=true 时，有令牌且缓存超过 10 分钟的渠道顺手刷一次（失败只记错误，不抛）。
 */
export async function balanceView({ ensureFresh = false, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const file = await readBalanceFile()
  const channels = []
  for (const meta of BALANCE_CHANNELS) {
    const raw = normalizeChannel(file, meta.id)
    if (ensureFresh && meta.kind === 'newapi' && raw.accessToken) {
      const at = Date.parse(raw.last?.at || '') || 0
      if (!at || Date.now() - at > BALANCE_TTL_MS) {
        const result = await checkNewApiBalance(meta, raw, { timeoutMs })
        raw.last = result.last
      }
    }
    channels.push(channelView(meta.id, raw))
  }
  const low = channels.filter((item) => item.state === 'low').map((item) => item.id)
  return {
    ok: true,
    channels,
    low,
    checkedAt: new Date().toISOString(),
    ttlMs: BALANCE_TTL_MS,
    defaultThreshold: DEFAULT_THRESHOLD,
  }
}

/**
 * 读 GeteAPI（New API）真实余额。
 * 需要两样东西：访问令牌（控制台「设置 → 访问令牌」生成）与账号 id（New API 的用户接口要它做请求头）。
 */
export async function checkNewApiBalance(meta, channel, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const base = String(meta.baseUrl || '').replace(/\/+$/, '')
  const token = String(channel.accessToken || '')
  if (!token) {
    return { ok: false, error: '还没有访问令牌：在 GeteAPI 控制台生成后填进来', last: channel.last }
  }
  const headers = { Authorization: 'Bearer ' + token }
  if (channel.newApiUser) headers['New-Api-User'] = String(channel.newApiUser)
  try {
    const status = await fetchJson(base + '/api/status', { timeoutMs })
    const perUnit = Number(status?.data?.quota_per_unit) || 500000
    const currency = currencySymbol(status?.data?.custom_currency_symbol)
    const self = await fetchJson(base + '/api/user/self', { headers, timeoutMs })
    if (self?.success === false) throw new Error(String(self?.message || '账号接口没有返回成功'))
    const data = self?.data || {}
    if (data.quota === undefined) throw new Error('账号接口没有回额度字段')
    const amount = quotaToAmount(data.quota, perUnit)
    if (amount === null) throw new Error('额度换算失败：上游 quota_per_unit 不可用')
    const used = quotaToAmount(data.used_quota, perUnit)
    return {
      ok: true,
      last: {
        amount,
        used,
        currency,
        source: 'auto',
        at: new Date().toISOString(),
        error: '',
      },
      quotaPerUnit: perUnit,
    }
  } catch (error) {
    const message = describeError(error)
    return { ok: false, error: message, last: { ...(channel.last || {}), amount: null, used: null, source: 'auto', at: new Date().toISOString(), error: message } }
  }
}

/** 上游报错翻译成人话：401/403 多半是令牌不对或缺 New-Api-User 头。 */
export function describeError(error) {
  const status = Number(error?.status) || 0
  const text = String(error?.message || '请求失败')
  if (status === 401) return '访问令牌被上游拒绝（401）：令牌失效或少了 New-Api-User'
  if (status === 403) return '上游拒绝这次请求（403）：令牌权限不够'
  if (status === 404) return '上游没有这个接口（404）：站点版本可能不支持'
  return text.slice(0, 160)
}

async function fetchJson(url, { headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const message = parsed?.message || parsed?.error?.message || 'HTTP ' + response.status
    throw Object.assign(new Error(String(message)), { status: response.status })
  }
  return parsed
}

/** 保存一条渠道：令牌留空 = 沿用旧令牌；clearToken=true 才是清掉。 */
export async function saveBalanceChannel(id, input = {}, { by = '' } = {}) {
  const meta = channelMeta(id)
  if (!meta) return { ok: false, error: '不认识的渠道' }
  const file = await readBalanceFile()
  const next = normalizeChannel(file, id)
  const threshold = input.threshold === undefined ? next.threshold : Number(input.threshold)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1e7) return { ok: false, error: '阈值要填 0 到 1000 万之间的数字' }
  next.threshold = Math.round(threshold * 100) / 100

  if (input.manualAmount !== undefined) {
    if (input.manualAmount === null || input.manualAmount === '') {
      next.manualAmount = null
    } else {
      const amount = Number(input.manualAmount)
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e7) return { ok: false, error: '金额要填 0 到 1000 万之间的数字' }
      next.manualAmount = Math.round(amount * 100) / 100
      next.last = {
        amount: next.manualAmount,
        used: next.last?.used ?? null,
        currency: input.currency === undefined ? next.last?.currency || '' : String(input.currency || '').slice(0, 4),
        source: 'manual',
        at: new Date().toISOString(),
        error: '',
      }
    }
  }

  if (input.newApiUser !== undefined) {
    const value = String(input.newApiUser || '').trim()
    if (value && !/^\d{1,12}$/.test(value)) return { ok: false, error: 'New API 用户 ID 只能是数字' }
    next.newApiUser = value
  }

  let tokenKept = false
  if (input.clearToken) {
    next.accessToken = ''
    next.last = { ...(next.last || {}), amount: null, used: null, source: 'auto', at: new Date().toISOString(), error: '' }
  } else if (input.accessToken !== undefined && String(input.accessToken).trim()) {
    const token = String(input.accessToken).trim()
    if (token.length > 200) return { ok: false, error: '访问令牌过长' }
    next.accessToken = token
  } else if (next.accessToken) {
    tokenKept = true
  }

  next.updatedAt = new Date().toISOString()
  next.updatedBy = by
  file.channels = { ...(file.channels || {}), [id]: next }
  await persist(file)
  return { ok: true, channel: channelView(id, next), tokenKept, currency: next.last?.currency || '' }
}

/** 核对一条渠道：自动渠道真打上游，手动渠道只能提示去登记。 */
export async function checkBalanceChannel(id, { timeoutMs = FETCH_TIMEOUT_MS, by = '' } = {}) {
  const meta = channelMeta(id)
  if (!meta) return { ok: false, error: '不认识的渠道' }
  const file = await readBalanceFile()
  const raw = normalizeChannel(file, id)
  if (meta.kind !== 'newapi') {
    return { ok: false, error: '这条渠道没有余额接口，只能手动登记', channel: channelView(id, raw) }
  }
  const result = await checkNewApiBalance(meta, raw, { timeoutMs })
  raw.last = result.last || raw.last
  raw.updatedAt = new Date().toISOString()
  raw.updatedBy = by
  file.channels = { ...(file.channels || {}), [id]: raw }
  await persist(file)
  return { ok: result.ok, error: result.ok ? '' : result.error, channel: channelView(id, raw) }
}

/** 测试用：清掉余额文件。 */
export async function resetBalanceFile() {
  await fsp.rm(balanceFile(), { force: true })
}
