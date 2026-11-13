// 用量与成本台账：把「平台到底花了多少」记成真数字，而不是拍脑袋写一句「成本可控」。
//
// 三条硬约束：
//   1. 计量失败绝不能弄坏业务：recordUsage 内部吞掉所有异常，只打一条服务端日志；
//   2. 上游没回 usage 就不编数字：token 记 0 并标 tokensKnown=false，页面按「未知」展示；
//   3. 单价是管理员填的估算口径，不是账单：没填就只统计用量，页面明说「未定价」。
//
// 为什么单独一层而不是塞进 credits：积分是对用户的虚拟计费倍率（2 积分一次检索），
// 与上游真实成本没有换算关系；两者混在一起，定价时永远算不清一次复刻真花了多少钱。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.mjs'
import { openDb } from './auth.mjs'

// 能力口径固定成这几个词：页面按它分组，不随调用方措辞变化
export const USAGE_KINDS = ['text', 'vision', 'judge', 'image', 'video', 'search', 'replicate', 'run']

const KIND_LABEL = {
  text: '文本模型',
  vision: '视觉模型',
  judge: '判断模型',
  image: '出图',
  video: '出视频',
  search: '检索',
  replicate: '复刻',
  run: '画布运行',
}

const TOKEN_KINDS = new Set(['text', 'vision', 'judge'])
const MAX_PRICE = 1_000_000
const PRICE_KEYS = ['inPerMillion', 'outPerMillion', 'imagePerShot', 'videoPerSecond', 'searchPerCall', 'replicatePerCall', 'runPerCall', 'judgePerCall']

let schemaReady = false

function db() {
  const handle = openDb()
  if (!schemaReady) {
    handle.exec(
      'CREATE TABLE IF NOT EXISTS usage_events (' +
        'id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL DEFAULT \'\', ' +
        'source TEXT NOT NULL DEFAULT \'live\', project_id TEXT NOT NULL DEFAULT \'\', ref TEXT NOT NULL DEFAULT \'\', ' +
        'ok INTEGER NOT NULL DEFAULT 1, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, ' +
        'units REAL NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT \'\', tokens_known INTEGER NOT NULL DEFAULT 1, detail TEXT)',
    )
    handle.exec('CREATE INDEX IF NOT EXISTS usage_events_at ON usage_events(at)')
    handle.exec('CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    schemaReady = true
  }
  return handle
}

function nowIso() {
  return new Date().toISOString()
}

function unitForKind(kind) {
  if (TOKEN_KINDS.has(kind)) return 'token'
  if (kind === 'image') return 'image'
  if (kind === 'video') return 'second'
  return 'call'
}

/**
 * 记一次真实计量。永远不抛错：调用方是业务主链路，计量挂了不该让评审 / 生成失败。
 * units 按能力解释：出图是张数、出视频是秒数、模型调用是 token（拿不到时为 0 次记 1 条）。
 */
export function recordUsage(event = {}) {
  try {
    const kind = USAGE_KINDS.includes(String(event.kind)) ? String(event.kind) : 'text'
    const tokensIn = Math.max(0, Math.round(Number(event.tokensIn) || 0))
    const tokensOut = Math.max(0, Math.round(Number(event.tokensOut) || 0))
    const givenUnits = Number(event.units)
    const okFlag = event.ok === false ? 0 : 1
    // 失败事件不记「张数 / 秒数」：上游可能计费也可能退款，没有依据就不折成钱，
    // 只在页面上体现「失败了几次」，避免把失败当成成功成本。
    const units = TOKEN_KINDS.has(kind)
      ? Math.max(0, tokensIn + tokensOut)
      : Number.isFinite(givenUnits) && givenUnits > 0
        ? Math.round(givenUnits * 1000) / 1000
        : okFlag
          ? 1
          : 0
    const at = Number.isFinite(Number(event.at)) && Number(event.at) > 0 ? Math.round(Number(event.at)) : Date.now()
    db()
      .prepare(
        'INSERT INTO usage_events (id, at, kind, model, source, project_id, ref, ok, tokens_in, tokens_out, units, unit, tokens_known, detail) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'ue_' + crypto.randomBytes(9).toString('base64url'),
        at,
        kind,
        String(event.model || '').slice(0, 120),
        String(event.source || 'live').slice(0, 24),
        String(event.projectId || '').slice(0, 64),
        String(event.ref || '').slice(0, 120),
        okFlag,
        tokensIn,
        tokensOut,
        units,
        unitForKind(kind),
        event.tokensKnown === false ? 0 : 1,
        String(event.detail || '').slice(0, 200),
      )
    return true
  } catch (error) {
    console.error('[usage] 计量写入失败（不影响业务）：' + String(error && error.message ? error.message : error))
    return false
  }
}

// ---- 单价：管理员在后台填，存在数据目录，0600，读多写少 ----

function pricesFile() {
  return path.join(config.dataDir, 'usage-prices.json')
}

const ZERO_PRICES = () => {
  const out = {}
  for (const key of PRICE_KEYS) out[key] = 0
  return out
}

function cleanPrice(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return 0
  return Math.min(MAX_PRICE, Math.round(num * 10000) / 10000)
}

export function usagePrices() {
  let stored = {}
  let meta = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(pricesFile(), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      meta = parsed
      if (parsed.prices && typeof parsed.prices === 'object') stored = parsed.prices
    }
  } catch {
    stored = {}
  }
  const prices = ZERO_PRICES()
  for (const key of PRICE_KEYS) if (stored[key] !== undefined) prices[key] = cleanPrice(stored[key])
  const priced = PRICE_KEYS.some((key) => prices[key] > 0)
  return {
    prices,
    currency: 'CNY',
    priced,
    updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : '',
    updatedBy: typeof meta.updatedBy === 'string' ? meta.updatedBy : '',
    note: '每单位人民币估价：token 按百万 token 计，出图按张、出视频按秒、其余按次。填了才会折算金额。',
  }
}

export function saveUsagePrices(patch = {}, { by = '' } = {}) {
  const current = usagePrices()
  const next = { ...current.prices }
  const given = patch && typeof patch === 'object' ? patch : {}
  for (const key of PRICE_KEYS) {
    if (given[key] === undefined || given[key] === '') continue
    const num = Number(given[key])
    if (!Number.isFinite(num) || num < 0 || num > MAX_PRICE) {
      return { ok: false, error: '单价必须是 0 到 ' + MAX_PRICE + ' 之间的数字：' + key }
    }
    next[key] = cleanPrice(num)
  }
  const payload = { prices: next, currency: 'CNY', updatedAt: nowIso(), updatedBy: String(by || '').slice(0, 80) }
  try {
    fs.mkdirSync(path.dirname(pricesFile()), { recursive: true })
    const tmp = pricesFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, pricesFile())
  } catch (error) {
    return { ok: false, error: '保存失败：' + String(error && error.message ? error.message : error) }
  }
  return { ok: true, ...usagePrices(), prices: next }
}

// 估算金额用「毫元」整数存：浮点数累加在页面上会出现 0.30000000000000004 这种数字
function estimateMilli(event, prices) {
  const kind = event.kind
  // 失败事件不折算：没有依据说明上游到底扣了多少
  if (Number(event.ok) === 0) return 0
  if (TOKEN_KINDS.has(kind) && kind !== 'judge') {
    const inCost = (Number(event.tokens_in) / 1_000_000) * Number(prices.inPerMillion || 0)
    const outCost = (Number(event.tokens_out) / 1_000_000) * Number(prices.outPerMillion || 0)
    return Math.round((inCost + outCost) * 1000)
  }
  if (kind === 'judge') return Math.round(Number(prices.judgePerCall || 0) * 1000)
  if (kind === 'image') return Math.round(Number(event.units) * Number(prices.imagePerShot || 0) * 1000)
  if (kind === 'video') return Math.round(Number(event.units) * Number(prices.videoPerSecond || 0) * 1000)
  if (kind === 'search') return Math.round(Number(prices.searchPerCall || 0) * 1000)
  if (kind === 'replicate') return Math.round(Number(prices.replicatePerCall || 0) * 1000)
  if (kind === 'run') return Math.round(Number(prices.runPerCall || 0) * 1000)
  return 0
}

// ---- 历史回填：计量上线前发生过的调用，按积分流水补成「次数」 ----
// 只补次数，不补 token 与张数（那时没记），标 source=backfill，页面单独说明，
// 折算金额时排除：否则会给一段没有依据的金额。

const LEDGER_KIND_MAP = { search: 'search', replicate: 'replicate', review: 'vision', chat: 'text', flow_run: 'run' }

function metaGet(key) {
  const row = db().prepare('SELECT value FROM usage_meta WHERE key = ?').get(String(key))
  return row ? String(row.value) : ''
}

function metaSet(key, value) {
  db().prepare('INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(key), String(value))
}

function backfillOnce() {
  if (metaGet('backfilled')) return 0
  let inserted = 0
  try {
    const ledger = db()
      .prepare('SELECT kind, created_at FROM credit_ledger WHERE delta < 0 AND kind NOT LIKE ? ORDER BY created_at DESC LIMIT 5000')
      .all('%-refund')
    const insert = db().prepare(
      'INSERT INTO usage_events (id, at, kind, model, source, project_id, ref, ok, tokens_in, tokens_out, units, unit, tokens_known, detail) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const row of ledger) {
      const kind = LEDGER_KIND_MAP[String(row.kind)] || ''
      if (!kind) continue
      const at = Date.parse(String(row.created_at))
      insert.run(
        'ue_' + crypto.randomBytes(9).toString('base64url'),
        Number.isFinite(at) && at > 0 ? at : Date.now(),
        kind,
        '',
        'backfill',
        '',
        '',
        1,
        0,
        0,
        1,
        unitForKind(kind),
        0,
        '按积分流水回填，只有次数',
      )
      inserted += 1
    }
    metaSet('backfilled', JSON.stringify({ at: nowIso(), count: inserted }))
  } catch (error) {
    console.error('[usage] 历史回填失败（不影响新计量）：' + String(error && error.message ? error.message : error))
  }
  return inserted
}

function backfillInfo() {
  const raw = metaGet('backfilled')
  if (!raw) return { count: 0, at: '' }
  try {
    const parsed = JSON.parse(raw)
    return { count: Number(parsed.count) || 0, at: String(parsed.at || '') }
  } catch {
    return { count: 0, at: '' }
  }
}

function dayKey(ms) {
  // 按服务器日期（UTC）归档：页面明确写 UTC，避免和本地时区的「今天」对不上却看不出来
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * 汇总窗口内的用量：总览、按能力、按模型、按天。所有数字都来自 usage_events 一条条事件，
 * 没有估算出来的调用次数。
 */
export function usageSummary({ days = 14, now = Date.now() } = {}) {
  backfillOnce()
  const span = Math.max(1, Math.min(90, Math.round(Number(days) || 14)))
  const to = Number(now)
  const from = to - span * 24 * 3600 * 1000
  const priceView = usagePrices()
  let rows = []
  try {
    rows = db().prepare('SELECT * FROM usage_events WHERE at >= ? ORDER BY at DESC').all(from)
  } catch (error) {
    console.error('[usage] 读取计量失败：' + String(error && error.message ? error.message : error))
    rows = []
  }

  // measuredCalls：真有用量（live 且成功）的条数。按次算账（v0.9.81）要拿它当分母：
  // 回填条目只有次数、没有 token 与张数，把它算进分母会把「一次成本」摊薄成假的。
  const totals = { calls: 0, okCalls: 0, measuredCalls: 0, failedCalls: 0, tokensIn: 0, tokensOut: 0, images: 0, videoSeconds: 0, estCostMilli: 0 }
  const byKind = new Map()
  const byModel = new Map()
  const byDay = new Map()
  for (let index = 0; index < span; index += 1) byDay.set(dayKey(to - index * 24 * 3600 * 1000), { day: '', calls: 0, tokens: 0, images: 0, videoSeconds: 0, estCostMilli: 0 })

  for (const row of rows) {
    totals.calls += 1
    if (Number(row.ok) === 1) totals.okCalls += 1
    else totals.failedCalls += 1
    if (row.source === 'live' && Number(row.ok) === 1) totals.measuredCalls += 1
    totals.tokensIn += Number(row.tokens_in) || 0
    totals.tokensOut += Number(row.tokens_out) || 0
    if (row.kind === 'image') totals.images += Number(row.units) || 0
    if (row.kind === 'video') totals.videoSeconds += Number(row.units) || 0
    // 回填条目没有依据折算金额：只算真实计量
    const cost = row.source === 'live' ? estimateMilli(row, priceView.prices) : 0
    totals.estCostMilli += cost

    const kindRow = byKind.get(row.kind) || { kind: row.kind, label: KIND_LABEL[row.kind] || row.kind, calls: 0, okCalls: 0, measuredCalls: 0, failedCalls: 0, tokensIn: 0, tokensOut: 0, units: 0, unit: unitForKind(row.kind), estCostMilli: 0 }
    kindRow.calls += 1
    if (Number(row.ok) !== 1) kindRow.failedCalls += 1
    if (row.source === 'live' && Number(row.ok) === 1) {
      kindRow.okCalls += 1
      kindRow.measuredCalls += 1
    }
    kindRow.tokensIn += Number(row.tokens_in) || 0
    kindRow.tokensOut += Number(row.tokens_out) || 0
    kindRow.units += Number(row.units) || 0
    kindRow.estCostMilli += cost
    byKind.set(row.kind, kindRow)

    const modelName = row.model || '未标注模型'
    const modelRow = byModel.get(modelName) || { model: modelName, calls: 0, tokensIn: 0, tokensOut: 0, estCostMilli: 0 }
    modelRow.calls += 1
    modelRow.tokensIn += Number(row.tokens_in) || 0
    modelRow.tokensOut += Number(row.tokens_out) || 0
    modelRow.estCostMilli += cost
    byModel.set(modelName, modelRow)

    const key = dayKey(Number(row.at))
    const dayRow = byDay.get(key) || { day: key, calls: 0, tokens: 0, images: 0, videoSeconds: 0, estCostMilli: 0 }
    dayRow.calls += 1
    dayRow.tokens += (Number(row.tokens_in) || 0) + (Number(row.tokens_out) || 0)
    if (row.kind === 'image') dayRow.images += Number(row.units) || 0
    if (row.kind === 'video') dayRow.videoSeconds += Number(row.units) || 0
    dayRow.estCostMilli += cost
    byDay.set(key, dayRow)
  }

  const kindOrder = USAGE_KINDS.slice()
  const sortedKinds = [...byKind.values()].sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind))

  return {
    ok: true,
    days: span,
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    prices: priceView.prices,
    priced: priceView.priced,
    priceNote: priceView.note,
    currency: priceView.currency,
    priceUpdatedAt: priceView.updatedAt,
    priceUpdatedBy: priceView.updatedBy,
    totals,
    byKind: sortedKinds,
    byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut)).slice(0, 8),
    byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((entry) => ({ ...entry[1], day: entry[0] })),
    backfill: backfillInfo(),
    recent: usageEvents({ limit: 12 }),
    kinds: USAGE_KINDS.map((kind) => ({ kind, label: KIND_LABEL[kind] })),
  }
}

/** 最近事件：排查「这条成本是哪来的」用，最多 50 条。 */
export function usageEvents({ limit = 20 } = {}) {
  const count = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)))
  try {
    const rows = db().prepare('SELECT * FROM usage_events ORDER BY at DESC LIMIT ?').all(count)
    return rows.map((row) => ({
      id: row.id,
      at: new Date(Number(row.at)).toISOString(),
      kind: row.kind,
      label: KIND_LABEL[row.kind] || row.kind,
      model: row.model || '',
      source: row.source,
      projectId: row.project_id || '',
      ok: Number(row.ok) === 1,
      ref: row.ref || '',
      tokensIn: Number(row.tokens_in) || 0,
      tokensOut: Number(row.tokens_out) || 0,
      units: Number(row.units) || 0,
      unit: row.unit || unitForKind(row.kind),
      tokensKnown: Number(row.tokens_known) === 1,
      detail: row.detail || '',
    }))
  } catch {
    return []
  }
}

// 测试用：清空这张表（只在临时数据目录的用例里调用）
export function resetUsageMeter() {
  try {
    db().exec('DELETE FROM usage_events')
    db().exec('DELETE FROM usage_meta')
  } catch {
    // 空表也算清空成功
  }
}
