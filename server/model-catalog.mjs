// 模型与上游目录：把两个上游平台的模型、平台来源与上游单价对齐到同一张表。
//
// 设计要点：
// 1. 两个平台的价目口径完全不同：GeteAPI 是 New API 的倍率表（USD），SeeAPI 是
//    credit_units（1,000,000 = ¥1）。这里只在服务端折算成统一的「$ / ¥ + 单位」文本，
//    浏览器拿不到任何 Key 明文、密文或上游请求头。
// 2. 上游目录缓存 10 分钟；但「哪把 Key 能用、某个模型能不能路由」每次请求都重新看池子，
//    管理员刚加完 Key 不需要等缓存过期。
// 3. 价格是上游标价，不替平台加价，也不把阶梯价压成一个假装精确的数字：
//    有阶梯就在 note 里写清按哪一档折算。
import { keyMaterial, listKeys } from './keyvault.mjs'

export const CATALOG_TTL_MS = 10 * 60 * 1000
const GETE_PRICING_URL = 'https://www.geteapi.com/api/pricing'
const GETE_MODELS_URL = 'https://www.geteapi.com/v1/models'
const SEEAPI_MODELS_URL = 'https://api.cgcm-api.com/v1/models'
const CREDIT_UNITS_PER_CNY = 1_000_000
const FETCH_TIMEOUT_MS = 12_000

const PLATFORM_META = {
  geteapi: { id: 'geteapi', label: 'GeteAPI', baseUrl: 'https://www.geteapi.com' },
  seeapi: { id: 'seeapi', label: 'SeeAPI / CGCM', baseUrl: 'https://api.cgcm-api.com' },
}

const PLATFORM_ORDER = ['geteapi', 'seeapi']
const CAPABILITY_RANK = { video: 3, image: 2, text: 1, unknown: 0 }

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function trimZeros(text) {
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

/** 价格文本统一到最多 5 位有效小数：0.048 不写成 0.048000，0.35574 不被抹成 0.3557。 */
export function formatPriceNumber(value) {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  let digits = 2
  if (abs > 0 && abs < 0.01) digits = 6
  else if (abs < 1) digits = 5
  return trimZeros(value.toFixed(digits))
}

function usd(value) {
  return '$' + formatPriceNumber(value)
}

function cny(value) {
  return '¥' + formatPriceNumber(value)
}

function unknownPrice(note, currency = '') {
  return { kind: 'unknown', currency, value: null, text: '未标价', note }
}

/**
 * GeteAPI（New API）倍率 → USD。
 * quota_type 0：输入 USD/1M = model_ratio × group_ratio × 2，输出 = 输入 × completion_ratio。
 * quota_type 1：model_price USD/次 × group_ratio。
 * group_ratio 取 auto_groups[0]（当前默认 default = 0.8）。
 */
export function getePrice(item, options = {}) {
  const group = String(options.group || 'default')
  const groupRatio = Number.isFinite(Number(options.groupRatio)) ? Number(options.groupRatio) : 0.8
  if (!item) return unknownPrice('上游没有给出这条模型的价格')
  const quotaType = Number(item.quota_type)
  const modelRatio = Number(item.model_ratio)
  const completionRatio = Number(item.completion_ratio)
  const modelPrice = Number(item.model_price)
  const groupNote = '分组 ' + group + ' ×' + formatPriceNumber(groupRatio)

  if (quotaType === 1) {
    const value = modelPrice * groupRatio
    if (!Number.isFinite(value) || value <= 0) return unknownPrice('按次计费，但上游 model_price 为 0', 'USD')
    return {
      kind: 'call',
      currency: 'USD',
      value: round(value),
      text: usd(value) + ' / 次',
      note: groupNote + ' · 按次',
    }
  }

  if (quotaType === 0) {
    const input = modelRatio * groupRatio * 2
    if (!Number.isFinite(input) || input <= 0) return unknownPrice('按 token 计费，但上游 model_ratio 为 0', 'USD')
    const completion = Number.isFinite(completionRatio) && completionRatio > 0 ? completionRatio : 1
    const output = input * completion
    const tierNote = item.billing_mode === 'tiered_expr' ? ' · 阶梯表达式计费，按基准倍率估算' : ''
    return {
      kind: 'token',
      currency: 'USD',
      value: round(input),
      text: '输入 ' + usd(input) + ' / 1M · 输出 ' + usd(output) + ' / 1M',
      note: groupNote + ' · 补全 ' + formatPriceNumber(completion) + '×' + tierNote,
    }
  }

  return unknownPrice('上游 quota_type 不是 0 或 1，暂不折算', 'USD')
}

/** GeteAPI 的 /v1/models 不带 modality，只能按模型名归类；归类不确定时宁可写 unknown。 */
export function inferGeteCapability(name) {
  const value = String(name || '').toLowerCase()
  if (/image|dall-e|flux|midjourney|seedream|nano-banana/.test(value)) return 'image'
  if (/video|veo|kling|seedance|wan2|happyhorse|sora|minimax-h3|grok-video/.test(value)) return 'video'
  if (/audio|realtime|tts|whisper/.test(value)) return 'text'
  if (/gpt-|claude|gemini|deepseek|qwen|glm|codex|o[1-9]/.test(value)) return 'text'
  return 'unknown'
}

function retailOf(value) {
  if (Number.isFinite(Number(value))) return Number(value)
  if (value && Number.isFinite(Number(value.special))) return Number(value.special)
  if (value && Number.isFinite(Number(value.retail))) return Number(value.retail)
  if (value && Number.isFinite(Number(value.default))) return Number(value.default)
  return NaN
}

/** 整段价保留 6 位小数：Seedance 这类 4 秒档总价 1.42296 不能被格式化抹成 1.42。 */
function exactNumber(value) {
  if (!Number.isFinite(value)) return '—'
  return trimZeros(value.toFixed(6))
}

function cnyExact(value) {
  return '¥' + exactNumber(value)
}

function naturalRank(label) {
  const text = String(label)
  const match = text.match(/^(\d+(?:\.\d+)?)/)
  if (!match) return Number.POSITIVE_INFINITY
  const value = Number(match[1])
  return /k$/i.test(text) ? value * 1000 : value
}

function sortedEntries(object) {
  return Object.entries(object || {}).sort(([a], [b]) => {
    const rank = naturalRank(a) - naturalRank(b)
    if (Number.isFinite(rank) && rank !== 0) return rank
    return String(a).localeCompare(String(b), 'en')
  })
}

function groupByCny(entries) {
  const groups = []
  for (const [label, value] of entries) {
    const price = retailOf(value)
    if (!Number.isFinite(price) || price < 0) continue
    const y = price / CREDIT_UNITS_PER_CNY
    const found = groups.find((group) => Math.abs(group.value - y) < 1e-9)
    if (found) found.labels.push(label)
    else groups.push({ value: y, labels: [label] })
  }
  return groups
}

function referenceNote(rule) {
  const map = rule?.reference_total_per_second_by_resolution
  if (!map) return ''
  const parts = []
  for (const [resolution, raw] of sortedEntries(map)) {
    const numerator = retailOf(raw?.numerator)
    const denominator = Number(raw?.denominator) || 1
    if (Number.isFinite(numerator)) {
      parts.push(resolution + ' ' + cny(numerator / denominator / CREDIT_UNITS_PER_CNY) + ' / 秒')
    }
  }
  return parts.length ? '参考视频另计：' + parts.join(' · ') : ''
}

/**
 * SeeAPI / CGCM 的 pricing_rule → CNY。
 * credit_units 按 1,000,000 = ¥1 折算；四种阶梯各自保留「按次 / 按秒 / 按张」的原始口径。
 */
export function seeapiPrice(rule) {
  if (!rule || typeof rule !== 'object') return unknownPrice('上游没有给出 pricing_rule', 'CNY')
  if (rule.currency && rule.currency !== 'credits') {
    return unknownPrice('上游计价币种是 ' + rule.currency + '，暂不折算', '')
  }

  const type = String(rule.type || '')

  if (type === 'fixed_per_call_tier') {
    const value = retailOf(rule.prices) / CREDIT_UNITS_PER_CNY
    if (!Number.isFinite(value) || value < 0) return unknownPrice('按次计费，但上游没有给出价格', 'CNY')
    return { kind: 'call', currency: 'CNY', value: round(value), text: cny(value) + ' / 次', note: '按次固定价' }
  }

  if (type === 'fixed_by_size_and_reference_count_tier') {
    const groups = groupByCny(sortedEntries(rule.prices))
    if (!groups.length) return unknownPrice('按尺寸计费，但上游没有给出尺寸价', 'CNY')
    const text = groups
      .map((group) => cny(group.value) + ' / 张（' + group.labels.join(' / ') + '）')
      .join(' · ')
    const value = Math.min(...groups.map((group) => group.value))
    const included = Number(rule.included_reference_count)
    const extra = retailOf(rule.additional_reference_prices)
    const note =
      '按尺寸' +
      (Number.isFinite(included) && included > 0 ? ' · 含 ' + included + ' 张参考图' : '') +
      (Number.isFinite(extra) ? ' · 每加一张 ' + cny(extra / CREDIT_UNITS_PER_CNY) : '')
    return { kind: 'image', currency: 'CNY', value: round(value), text, note }
  }

  if (type === 'fixed_by_duration_resolution_tier') {
    const durations = sortedEntries(rule.prices)
    if (!durations.length) return unknownPrice('按视频时长计费，但上游没有给出时长价', 'CNY')
    const [durationLabel, resolutionMap] = durations[0]
    const seconds = Number(durationLabel) || 1
    const groups = sortedEntries(resolutionMap).map(([resolution, raw]) => {
      const total = retailOf(raw) / CREDIT_UNITS_PER_CNY
      return { resolution, total, each: total / seconds }
    })
    const valid = groups.filter((group) => Number.isFinite(group.each) && group.each >= 0)
    if (!valid.length) return unknownPrice('按视频时长计费，但价格不是有效数字', 'CNY')
    const text = valid
      .map(
        (group) =>
          cny(group.each) +
          ' / 秒（' +
          group.resolution +
          '，' +
          seconds +
          ' 秒档，整段 ' +
          cnyExact(group.total) +
          '）',
      )
      .join(' · ')
    const lastDuration = durations[durations.length - 1][0]
    const range =
      String(lastDuration) === String(seconds)
        ? seconds + ' 秒档'
        : seconds + '–' + lastDuration + ' 秒'
    return {
      kind: 'second',
      currency: 'CNY',
      value: round(Math.min(...valid.map((group) => group.each))),
      text,
      note: '按 ' + range + ' × 分辨率阶梯，表内按 ' + seconds + ' 秒档折算',
    }
  }

  if (type === 'output_and_reference_video_duration_resolution_tier') {
    const groups = sortedEntries(rule.output_per_second_by_resolution)
      .map(([resolution, raw]) => ({ resolution, each: retailOf(raw) / CREDIT_UNITS_PER_CNY }))
      .filter((group) => Number.isFinite(group.each) && group.each >= 0)
    if (!groups.length) return unknownPrice('按秒计费，但上游没有给出每秒价', 'CNY')
    const text = groups.map((group) => cny(group.each) + ' / 秒（' + group.resolution + '）').join(' · ')
    const extra = referenceNote(rule)
    return {
      kind: 'second',
      currency: 'CNY',
      value: round(Math.min(...groups.map((group) => group.each))),
      text,
      note: '输出视频按秒计费' + (extra ? ' · ' + extra : ''),
    }
  }

  if (type === 'conditional_reference_video') {
    const base = seeapiPrice(rule.base_pricing_rule)
    if (base.kind === 'unknown') return base
    return {
      ...base,
      note: (base.note ? base.note + ' · ' : '') + '带参考视频另按 token 计费，未折算',
    }
  }

  return unknownPrice('上游规则 ' + (type || '未知') + ' 暂未折算', 'CNY')
}

export function seeapiCapability(model) {
  const modality = String(model?.modality || '').toLowerCase()
  if (modality === 'image' || modality === 'video' || modality === 'text') return modality
  return inferGeteCapability(model?.code || model?.id || '')
}

/**
 * 按模型名（忽略大小写）合并；同一平台只留一条 offer，优先保留有价格的。
 * 排序固定：先按能力（视频 / 图片 / 文本 / 未知），同能力按模型名。
 */
export function mergeCatalog(entries, isRoutable = () => false) {
  const groups = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const model = String(entry?.model || '').trim()
    if (!model) continue
    const key = model.toLowerCase()
    const capability = String(entry?.capability || 'unknown')
    let group = groups.get(key)
    if (!group) {
      group = { model, capability, offers: new Map() }
      groups.set(key, group)
    }
    if ((CAPABILITY_RANK[capability] || 0) > (CAPABILITY_RANK[group.capability] || 0)) {
      group.capability = capability
    }
    const offer = entry?.offer
    if (!offer || !offer.platform) continue
    const previous = group.offers.get(offer.platform)
    if (!previous || (previous.price?.kind === 'unknown' && offer.price?.kind !== 'unknown')) {
      group.offers.set(offer.platform, offer)
    }
  }

  const rows = []
  for (const group of groups.values()) {
    const offers = PLATFORM_ORDER.map((platform) => group.offers.get(platform)).filter(Boolean)
    if (!offers.length) continue
    rows.push({
      model: group.model,
      capability: group.capability,
      offers,
      routable: Boolean(isRoutable(group.model, group.capability)),
    })
  }
  rows.sort((a, b) => {
    const rank = (CAPABILITY_RANK[b.capability] || 0) - (CAPABILITY_RANK[a.capability] || 0)
    if (rank !== 0) return rank
    return a.model.localeCompare(b.model, 'en')
  })
  return rows
}

function poolKeyFor(platform) {
  const items = listKeys().items
  const found = items.find((key) => {
    if (!key.enabled) return false
    const haystack = String(key.provider || '') + ' ' + String(key.baseUrl || '')
    if (platform === 'geteapi') return /geteapi/i.test(haystack)
    return key.provider === 'cgcm' || /cgcm|seeapi/i.test(haystack)
  })
  if (!found) return null
  return { item: found, material: keyMaterial(found.id) }
}

function routability(keys) {
  const usable = keys.filter((key) => key.enabled && Array.isArray(key.models) && key.models.length)
  return (model, capability) => {
    if (!capability || capability === 'unknown') return false
    const target = String(model || '').toLowerCase()
    return usable.some(
      (key) =>
        Array.isArray(key.capabilities) &&
        key.capabilities.includes(capability) &&
        key.models.some((name) => String(name).toLowerCase() === target),
    )
  }
}

async function fetchJson(url, token) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {}
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { status: response.status })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('上游返回的不是 JSON')
  }
}

function statusNote(error) {
  return error?.status ? 'HTTP ' + error.status : String(error?.message || '请求失败').slice(0, 80)
}

let rawCache = null
let inflight = null

async function refreshRaw() {
  if (inflight) return inflight
  inflight = (async () => {
    const geteKey = poolKeyFor('geteapi')
    const seeKey = poolKeyFor('seeapi')
    const notes = []

    const getePricingPromise = fetchJson(GETE_PRICING_URL)
      .then((data) => data)
      .catch((error) => {
        notes.push('GeteAPI 公开价目表读取失败（' + statusNote(error) + '），价格显示为未标价。')
        return null
      })

    let geteModelsPromise = Promise.resolve(null)
    if (geteKey?.material?.apiKey) {
      geteModelsPromise = fetchJson(GETE_MODELS_URL, geteKey.material.apiKey)
        .then((data) => data)
        .catch((error) => {
          notes.push('GeteAPI /v1/models 读取失败（' + statusNote(error) + '），模型清单用公开价目表补全。')
          return null
        })
    }

    const seeModelsPromise = fetchJson(SEEAPI_MODELS_URL, seeKey?.material?.apiKey || '')
      .then((data) => data)
      .catch((error) => {
        notes.push('SeeAPI /v1/models 读取失败（' + statusNote(error) + '）。')
        return null
      })

    const [getePricing, geteModels, seeapiModels] = await Promise.all([
      getePricingPromise,
      geteModelsPromise,
      seeModelsPromise,
    ])

    const group = String(getePricing?.auto_groups?.[0] || 'default')
    const groupRatio = Number(getePricing?.group_ratio?.[group])
    const ratio = Number.isFinite(groupRatio) ? groupRatio : 0.8
    if (getePricing) {
      notes.push('GeteAPI 价格按 auto_groups[0] = ' + group + '（×' + formatPriceNumber(ratio) + '）折算。')
    }
    if (seeapiModels) {
      notes.push('SeeAPI 的 credit_units 按 1,000,000 = ¥1 折算。')
    }

    return {
      at: Date.now(),
      getePricing,
      geteModels,
      seeapiModels,
      group,
      groupRatio: ratio,
      notes,
    }
  })()
  try {
    rawCache = await inflight
    return rawCache
  } finally {
    inflight = null
  }
}

function buildCatalog(raw, keys) {
  const entries = []
  const geteConnected = keys.some(
    (key) => key.enabled && /geteapi/i.test(String(key.provider || '') + ' ' + String(key.baseUrl || '')),
  )
  const seeConnected = keys.some(
    (key) =>
      key.enabled &&
      (key.provider === 'cgcm' || /cgcm|seeapi/i.test(String(key.provider || '') + ' ' + String(key.baseUrl || ''))),
  )

  const pricingByName = new Map()
  for (const item of Array.isArray(raw.getePricing?.data) ? raw.getePricing.data : []) {
    const name = String(item?.model_name || '').trim()
    if (name) pricingByName.set(name.toLowerCase(), item)
  }

  const geteNames = new Set()
  for (const item of Array.isArray(raw.geteModels?.data) ? raw.geteModels.data : []) {
    const name = (typeof item === 'string' ? item : String(item?.id || item?.model_name || '')).trim()
    if (name) geteNames.add(name)
  }
  for (const name of pricingByName.values()) geteNames.add(name.model_name)

  for (const model of geteNames) {
    const pricing = pricingByName.get(String(model).toLowerCase())
    entries.push({
      model,
      capability: inferGeteCapability(model),
      offer: {
        platform: 'geteapi',
        platformLabel: PLATFORM_META.geteapi.label,
        price: pricing
          ? getePrice(pricing, { group: raw.group, groupRatio: raw.groupRatio })
          : unknownPrice('模型出现在 /v1/models，但公开价目表里没有它', 'USD'),
        connected: geteConnected,
      },
    })
  }

  for (const model of Array.isArray(raw.seeapiModels?.data) ? raw.seeapiModels.data : []) {
    const name = String(model?.code || model?.id || '').trim()
    if (!name) continue
    entries.push({
      model: name,
      capability: seeapiCapability(model),
      offer: {
        platform: 'seeapi',
        platformLabel: PLATFORM_META.seeapi.label,
        price: seeapiPrice(model?.pricing_rule),
        connected: seeConnected,
      },
    })
  }

  const rows = mergeCatalog(entries, routability(keys))
  const geteNote = geteConnected
    ? raw.geteModels
      ? '已连接；模型清单同时参考公开价目表与 /v1/models。'
      : '池里有 Key，但缓存里没有 /v1/models 结果；点「刷新」重试。'
    : raw.getePricing
      ? '当前没有启用中的 Key；模型清单来自公开价目表或最近一次抓取。'
      : '当前没有启用中的 Key，且公开价目表也没取到。'
  const seeNote = seeConnected
    ? raw.seeapiModels
      ? '已连接；价格按 1,000,000 credit_units = ¥1 折算。'
      : '池里有 Key，但缓存里没有 /v1/models 结果；点「刷新」重试。'
    : raw.seeapiModels
      ? '当前没有启用中的 Key；/v1/models 可匿名读取。'
      : '当前没有启用中的 Key，匿名读取也失败了。'

  const platforms = PLATFORM_ORDER.map((id) => ({
    ...PLATFORM_META[id],
    connected: id === 'geteapi' ? geteConnected : seeConnected,
    modelCount: rows.reduce(
      (count, row) => count + (row.offers.some((offer) => offer.platform === id) ? 1 : 0),
      0,
    ),
    note: id === 'geteapi' ? geteNote : seeNote,
  }))

  const notes = [...raw.notes]
  if (!geteConnected) {
    notes.push('池里没有启用中的 GeteAPI Key：/v1/models 未请求，模型清单来自公开价目表或最近一次抓取。')
  } else if (!raw.geteModels) {
    notes.push('池里有 GeteAPI Key，但缓存里没有 /v1/models 结果；点「刷新」重试。')
  }
  if (!seeConnected) {
    notes.push(
      raw.seeapiModels
        ? '池里没有启用中的 SeeAPI Key：/v1/models 以匿名方式读取。'
        : '池里没有启用中的 SeeAPI Key，匿名读取也失败了。',
    )
  } else if (!raw.seeapiModels) {
    notes.push('池里有 SeeAPI Key，但缓存里没有 /v1/models 结果；点「刷新」重试。')
  }
  if (rows.length && !rows.some((row) => row.routable)) {
    notes.push('池里没有 Key 同时声明这些模型与能力，接入状态全部为「仅参考」。')
  }
  if (!rows.length) notes.push('两个上游都没有返回可用模型。')

  return {
    ok: rows.length > 0,
    fetchedAt: new Date(raw.at).toISOString(),
    platforms,
    rows,
    notes,
  }
}

/**
 * 后台模型目录。缓存的是「上游原始数据」，connected / routable 每次按当前 Key 池现算。
 * force=true 时忽略 10 分钟缓存（后台手动刷新用）。
 */
export async function getModelCatalog(force = false) {
  let raw = rawCache
  if (!raw || force || Date.now() - raw.at > CATALOG_TTL_MS) {
    raw = await refreshRaw()
  }
  return buildCatalog(raw, listKeys().items)
}

/** 测试与排障用：清掉上游缓存，下一次重新抓。 */
export function clearModelCatalogCache() {
  rawCache = null
}
