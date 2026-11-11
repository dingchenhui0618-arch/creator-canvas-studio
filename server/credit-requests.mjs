// 额度申请：用户积分不够时在设置页提交一条申请，管理员在后台看到并一键发放。
// 为什么不直接接支付：定价还没定（见 docs/launch-gap-audit-2026-11-11.md P0-2），
// 所以先把「用完就死」这条路走通——用户有出口，管理员有队列，账本上每笔都留痕。
// 文件很小（一次申请一条），读多写少；写用临时文件 + rename，避免半截 JSON。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.mjs'

const file = path.join(config.dataDir, 'credit-requests.json')
let cache = null

function emptyStore() {
  return { requests: [] }
}

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    cache = parsed && Array.isArray(parsed.requests) ? parsed : emptyStore()
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
    userId: String(row.userId || ''),
    email: String(row.email || ''),
    name: String(row.name || ''),
    amount: Number(row.amount) || 0,
    reason: String(row.reason || ''),
    status: row.status === 'granted' || row.status === 'ignored' ? row.status : 'pending',
    createdAt: String(row.createdAt || ''),
    resolvedAt: row.resolvedAt ? String(row.resolvedAt) : null,
    resolvedBy: row.resolvedBy ? String(row.resolvedBy) : null,
    grantedAmount: row.grantedAmount === undefined ? null : Number(row.grantedAmount) || 0,
  }
}

export function listRequests({ status = '', limit = 200 } = {}) {
  const rows = load().requests.map(normalize)
  const filtered = status ? rows.filter((item) => item.status === status) : rows
  return filtered
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)))
}

export function pendingRequestOf(userId) {
  const id = String(userId || '')
  if (!id) return null
  return listRequests({ status: 'pending' }).find((item) => item.userId === id) || null
}

// 同一账号同时只留一条待处理申请：重复提交返回那条已有的，不制造一堆重复项。
export function createRequest({ user, amount, reason = '' }) {
  const existing = pendingRequestOf(user.id)
  if (existing) return { request: existing, created: false }
  const next = {
    id: 'cr_' + crypto.randomBytes(8).toString('base64url'),
    userId: String(user.id),
    email: String(user.email || ''),
    name: String(user.name || ''),
    amount: Math.max(1, Math.min(10000, Math.trunc(Number(amount) || 0) || 100)),
    reason: String(reason || '').trim().slice(0, 120),
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
  const data = load()
  data.requests.push(next)
  // 只保留最近 500 条，避免文件无限长
  if (data.requests.length > 500) data.requests = data.requests.slice(-500)
  persist(data)
  return { request: normalize(next), created: true }
}

export function resolveRequest(id, { status, by, grantedAmount = null } = {}) {
  const data = load()
  const row = data.requests.find((item) => item.id === String(id))
  if (!row) return null
  if (row.status !== 'pending') return normalize(row)
  row.status = status === 'ignored' ? 'ignored' : 'granted'
  row.resolvedAt = new Date().toISOString()
  row.resolvedBy = String(by || '')
  row.grantedAmount = grantedAmount === null ? null : Math.trunc(Number(grantedAmount) || 0)
  persist(data)
  return normalize(row)
}
