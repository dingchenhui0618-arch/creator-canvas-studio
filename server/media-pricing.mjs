// 上游真实成本 → 平台积分价：只在这里算，快捷创作与无限画布都读它。
//
// 口径（2026-11-23 用户定）：
//   扣费 = 上游成本 × (1 + 加价 10%) × 每元积分（默认 1 元 = 10 积分）。
//   例：上游一次花 5 元 → 5 × 1.1 = 5.5 元 → 5.5 × 10 = 55 积分。
// 取整只向上（Math.ceil）：宁可少赚不到 1 个积分，也不让卖出去的价比上游成本还低。
//
// 为什么不把价钱写在模型表里：上游会调价、会加新 Key、会换更便宜的通道。
// 价钱一律由「这条通道的单价 + 这一处公式」算出来，改价改这张表或 config.billing，
// 不用去界面或画布里找写死的数字。
import { config } from './config.mjs'

const MARKUP = (() => {
  const raw = Number(config.billing?.markup)
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.1
})()

const POINTS_PER_CNY = (() => {
  const raw = Number(config.credits?.pointsPerCny)
  return Number.isFinite(raw) && raw > 0 ? raw : 10
})()

const USD_CNY = (() => {
  const raw = Number(config.billing?.usdCny)
  return Number.isFinite(raw) && raw > 0 ? raw : 7.2
})()

// 图片：GeteAPI 按次报价（美元）。2.6 系最便宜（$0.028），2.5 / 2 是 $0.048。
export const IMAGE_COST_USD = {
  'gpt-image-2.6': 0.028,
  'gpt-image-2.5': 0.048,
  'gpt-image-2': 0.048,
}

// 视频：SeeAPI 按秒报价（元），按清晰度分档。
export const VIDEO_COST_CNY_PER_SEC = {
  'seedance-2.0-fast': { '480p': 0.28614, '720p': 0.61538, '1080p': 1.2714 },
  'seedance-2.0': { '480p': 0.35574, '720p': 0.76507, '1080p': 1.72 },
}

export function imageCostCny(model) {
  const usd = IMAGE_COST_USD[String(model || '').trim()]
  if (!Number.isFinite(usd) || usd <= 0) return null
  return usd * USD_CNY
}

export function videoCostCny(model, seconds, resolution) {
  const table = VIDEO_COST_CNY_PER_SEC[String(model || '').trim()]
  if (!table) return null
  const perSec = table[String(resolution || '').trim()] ?? table['720p']
  const secs = Number(seconds)
  if (!Number.isFinite(perSec) || perSec <= 0) return null
  if (!Number.isFinite(secs) || secs <= 0) return null
  return perSec * secs
}

/** 成本（元）→ 积分：加价后按每元积分折算，向上取整，最少 1 个积分。 */
export function creditsFromCost(costCny) {
  const cost = Number(costCny)
  if (!Number.isFinite(cost) || cost <= 0) return 0
  return Math.max(1, Math.ceil(cost * (1 + MARKUP) * POINTS_PER_CNY))
}

export function imageCredits(model) {
  return creditsFromCost(imageCostCny(model))
}

export function videoCredits(model, seconds, resolution) {
  return creditsFromCost(videoCostCny(model, seconds, resolution))
}

/**
 * 视频每个「时长 × 清晰度」各要多少积分：界面照这张表显示，不用自己乘。
 * key 形如 "8|720p"。
 */
export function videoPriceTable(model, durations = [], resolutions = []) {
  const table = {}
  for (const duration of durations) {
    for (const resolution of resolutions) {
      table[duration + '|' + resolution] = videoCredits(model, duration, resolution)
    }
  }
  return table
}

/** 给界面/后台的一句口径说明，别让人猜价钱是怎么来的。 */
export function pricingRuleText() {
  return '按上游成本加价 ' + Math.round(MARKUP * 100) + '%，1 元 = ' + POINTS_PER_CNY + ' 积分，向上取整'
}

export const PRICING_META = { markup: MARKUP, pointsPerCny: POINTS_PER_CNY, usdCny: USD_CNY }
