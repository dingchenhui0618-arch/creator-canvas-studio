// 定价档位（v0.9.63）：价格是商务决定，代码只负责「能改、改完立刻生效」。
// 以前档位是 billing.mjs 里的一个常量空数组——想定价就得改代码、重新发版；
// 现在存 DATA_DIR/plans.json（0600），后台「计费」页增删改，设置页的充值卡按它渲染。
// 付款通道仍未接入：这里只定义「多少钱换多少积分」，下单仍然会明确失败，不伪造成功。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.mjs'

const file = path.join(config.dataDir, 'plans.json')
const MAX_PLANS = 40
let cache = null

function emptyStore() {
  return { plans: [] }
}

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    cache = parsed && Array.isArray(parsed.plans) ? parsed : emptyStore()
  } catch {
    cache = emptyStore()
  }
  return cache
}

function persist(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function normalize(row) {
  return {
    id: String(row.id || ''),
    name: String(row.name || ''),
    // 积分与价格都用整数存：积分按个，价格按分（避免 0.1 + 0.2 这类浮点误差）
    credits: Math.trunc(Number(row.credits) || 0),
    priceCents: Math.trunc(Number(row.priceCents) || 0),
    note: String(row.note || ''),
    enabled: row.enabled !== false,
    sort: Math.trunc(Number(row.sort) || 0),
    createdAt: String(row.createdAt || ''),
    updatedAt: String(row.updatedAt || ''),
    updatedBy: String(row.updatedBy || ''),
  }
}

function sortPlans(rows) {
  return [...rows].sort((a, b) => a.sort - b.sort || String(a.createdAt).localeCompare(String(b.createdAt)))
}

/** 列档位：onlyEnabled 给公开接口用，后台要看得见停用的。 */
export function listPlans({ onlyEnabled = false } = {}) {
  const rows = load().plans.map(normalize)
  return sortPlans(onlyEnabled ? rows.filter((item) => item.enabled) : rows)
}

export function planById(id) {
  const target = String(id || '')
  if (!target) return null
  return load().plans.map(normalize).find((item) => item.id === target) || null
}

/** 输入校验：都返回中文原因，界面直接显示，不做二次加工。 */
export function validatePlanInput(input = {}) {
  const name = String(input.name || '').trim()
  if (!name) return { ok: false, error: '档位名必填' }
  if (name.length > 40) return { ok: false, error: '档位名最多 40 个字' }
  const credits = Math.trunc(Number(input.credits))
  if (!Number.isFinite(credits) || credits < 1 || credits > 100000) return { ok: false, error: '积分数量要写 1–100000 的整数' }
  const priceCents = Math.trunc(Number(input.priceCents))
  // 上限 10 万元：超过这个数按「企业合同」单独谈，不放进自助档位
  if (!Number.isFinite(priceCents) || priceCents < 0 || priceCents > 10000000) return { ok: false, error: '价格要写 0–100000 元（最多两位小数）' }
  const note = String(input.note || '').trim()
  if (note.length > 120) return { ok: false, error: '备注最多 120 个字' }
  return { ok: true, name, credits, priceCents, note }
}

/** 新增或更新。id 有值就是更新（不存在则 404 语义，由调用方处理）。 */
export function savePlan(input = {}, by = '') {
  const checked = validatePlanInput(input)
  if (!checked.ok) return { ok: false, error: checked.error }
  const data = load()
  const now = new Date().toISOString()
  const id = String(input.id || '')
  if (id) {
    const row = data.plans.find((item) => item.id === id)
    if (!row) return { ok: false, code: 'NOT_FOUND', error: '这个档位不存在（可能已被删除）' }
    row.name = checked.name
    row.credits = checked.credits
    row.priceCents = checked.priceCents
    row.note = checked.note
    row.enabled = input.enabled !== false
    if (input.sort !== undefined && Number.isFinite(Number(input.sort))) row.sort = Math.trunc(Number(input.sort))
    row.updatedAt = now
    row.updatedBy = String(by || '')
    persist(data)
    return { ok: true, plan: normalize(row) }
  }
  if (data.plans.length >= MAX_PLANS) return { ok: false, error: '档位最多 ' + MAX_PLANS + ' 个，删掉不用的再加' }
  const maxSort = data.plans.reduce((max, item) => Math.max(max, Number(item.sort) || 0), 0)
  const next = {
    id: 'plan_' + crypto.randomBytes(4).toString('hex'),
    name: checked.name,
    credits: checked.credits,
    priceCents: checked.priceCents,
    note: checked.note,
    enabled: input.enabled !== false,
    sort: Number.isFinite(Number(input.sort)) ? Math.trunc(Number(input.sort)) : maxSort + 10,
    createdAt: now,
    updatedAt: now,
    updatedBy: String(by || ''),
  }
  data.plans.push(next)
  persist(data)
  return { ok: true, plan: normalize(next) }
}

export function deletePlan(id) {
  const data = load()
  const target = String(id || '')
  const index = data.plans.findIndex((item) => item.id === target)
  if (index < 0) return { ok: false, code: 'NOT_FOUND', error: '这个档位不存在（可能已被删除）' }
  const [removed] = data.plans.splice(index, 1)
  persist(data)
  return { ok: true, plan: normalize(removed) }
}

/** 公开接口的形状：价格折算成「元」，前端不用再猜单位。 */
export function publicPlans() {
  return listPlans({ onlyEnabled: true }).map((plan) => ({
    id: plan.id,
    name: plan.name,
    credits: plan.credits,
    price: plan.priceCents / 100,
    priceCents: plan.priceCents,
    note: plan.note,
  }))
}

/** 测试与运维用：把缓存扔掉，下一次读文件。 */
export function resetPlansCache() {
  cache = null
}
