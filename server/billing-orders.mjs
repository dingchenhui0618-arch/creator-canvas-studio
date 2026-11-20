// 充值订单（v0.9.162）：只记「谁、哪一档、多少积分、什么时候」，最多留 300 条。
// 不记支付凭据、不记卡号：商户号还没下来，这一层只兑现「内测直充」的那一笔。
// 真正的钱在 credit_ledger 里（kind = recharge），订单只是给人看的凭据。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.mjs'
import { writeFileAtomicSync } from './atomic-write.mjs'

const file = path.join(config.dataDir, 'billing-orders.json')
const MAX_ORDERS = 300
let cache = null

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    cache = parsed && Array.isArray(parsed.orders) ? parsed : { orders: [] }
  } catch {
    cache = { orders: [] }
  }
  return cache
}

function persist(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeFileAtomicSync(file, JSON.stringify(data, null, 2))
}

function normalize(row) {
  return {
    id: String(row.id || ''),
    userId: String(row.userId || ''),
    planId: String(row.planId || ''),
    planName: String(row.planName || ''),
    credits: Math.trunc(Number(row.credits) || 0),
    priceCents: Math.trunc(Number(row.priceCents) || 0),
    /** internal = 内测直充（没有支付渠道）；manual = 管理员确认收款后发放 */
    channel: row.channel === 'manual' ? 'manual' : 'internal',
    status: row.status === 'pending' ? 'pending' : 'paid',
    createdAt: String(row.createdAt || ''),
  }
}

/** 落一条订单；超过上限就先扔掉最老的（订单量远小于流水，够看）。 */
export function addOrder({ userId, plan, channel = 'internal', status = 'paid' }) {
  const data = load()
  const order = normalize({
    id: 'ord_' + crypto.randomBytes(6).toString('hex'),
    userId,
    planId: plan.id,
    planName: plan.name,
    credits: plan.credits,
    priceCents: plan.priceCents,
    channel,
    status,
    createdAt: new Date().toISOString(),
  })
  data.orders.push(order)
  if (data.orders.length > MAX_ORDERS) data.orders = data.orders.slice(-MAX_ORDERS)
  persist(data)
  return order
}

/** 只列自己的（后台要看全部时传 userId = ''）。 */
export function listOrders({ userId = '', limit = 20 } = {}) {
  const rows = load().orders.map(normalize)
  const mine = userId ? rows.filter((item) => item.userId === userId) : rows
  return mine.slice(-Math.max(1, Math.min(MAX_ORDERS, Number(limit) || 20))).reverse()
}

export function orderCount(userId = '') {
  const rows = load().orders
  return userId ? rows.filter((item) => String(item.userId) === String(userId)).length : rows.length
}

/** 测试与运维用：把缓存扔掉，下一次读文件。 */
export function resetOrdersCache() {
  cache = null
}
