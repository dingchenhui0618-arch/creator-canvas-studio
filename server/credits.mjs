// 积分账：检索 / 一键复刻 / 视觉评审 / 智能体对话都按次扣积分。
// 设计取舍：
//   - 余额存在 users.credits，流水存在 credit_ledger，两者在同一个事务里改，余额永远等于流水求和
//   - 扣费发生在调上游之前（先扣后调），失败退款；这样并发刷接口不会出现「先跑完再扣、扣的时候没余额」
//   - 没有登录态（本地演示）不扣费也不记账，避免离线开发被积分挡住
//   - 单价来自环境变量（VQ_CREDIT_*），改价不用改代码；金额/档位/支付通道仍然没有接，充值只留占位
import crypto from 'node:crypto'
import { config } from './config.mjs'
import { openDb as getDb } from './auth.mjs'

const nowIso = () => new Date().toISOString()

export function priceOf(kind) {
  const price = Number(config.credits.prices[kind])
  return Number.isFinite(price) && price > 0 ? Math.round(price) : 0
}

export function creditSummary() {
  return {
    unit: config.credits.unit,
    welcome: config.credits.welcome,
    prices: { ...config.credits.prices },
    concurrency: { ...config.credits.concurrency },
  }
}

export function balanceOf(userId) {
  if (!userId) return null
  const row = getDb().prepare('SELECT credits FROM users WHERE id = ?').get(String(userId))
  if (!row) return 0
  return Number(row.credits || 0)
}

function writeLedger(db, { userId, delta, balanceAfter, kind, ref, meta }) {
  db.prepare(
    'INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, ref, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'cl_' + crypto.randomBytes(8).toString('base64url'),
    userId,
    delta,
    balanceAfter,
    kind,
    String(ref || '').slice(0, 200),
    meta ? JSON.stringify(meta).slice(0, 2000) : null,
    nowIso(),
  )
}

// 扣费：返回 { ok, balance, cost } 或 { ok:false, code:'CREDIT_INSUFFICIENT', balance, cost, needed }
export function charge(userId, kind, { ref = '', amount = null } = {}) {
  if (!userId) return { ok: true, anonymous: true, balance: null, cost: 0 }
  const cost = amount === null ? priceOf(kind) : Math.round(Number(amount) || 0)
  if (cost <= 0) return { ok: true, balance: balanceOf(userId), cost: 0 }
  const db = getDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare('SELECT credits FROM users WHERE id = ?').get(String(userId))
    if (!row) {
      db.exec('ROLLBACK')
      return { ok: false, code: 'CREDIT_NO_USER', balance: 0, cost, needed: cost }
    }
    const balance = Number(row.credits || 0)
    if (balance < cost) {
      db.exec('ROLLBACK')
      return { ok: false, code: 'CREDIT_INSUFFICIENT', balance, cost, needed: cost - balance }
    }
    const after = balance - cost
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(after, String(userId))
    writeLedger(db, { userId: String(userId), delta: -cost, balanceAfter: after, kind, ref })
    db.exec('COMMIT')
    return { ok: true, balance: after, cost }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败说明事务已经不在了，交给上层记日志
    }
    throw error
  }
}

// 退款：上游失败、参数不合法、任务没跑起来都要把积分还回去，否则等于「失败也收费」
export function refund(userId, kind, { ref = '', amount = null } = {}) {
  if (!userId) return { ok: true, anonymous: true, balance: null, cost: 0 }
  const amountBack = amount === null ? priceOf(kind) : Math.round(Number(amount) || 0)
  if (amountBack <= 0) return { ok: true, balance: balanceOf(userId), cost: 0 }
  const db = getDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare('SELECT credits FROM users WHERE id = ?').get(String(userId))
    const balance = Number(row?.credits || 0)
    const after = balance + amountBack
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(after, String(userId))
    writeLedger(db, { userId: String(userId), delta: amountBack, balanceAfter: after, kind: kind + '-refund', ref })
    db.exec('COMMIT')
    return { ok: true, balance: after, cost: amountBack }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 同上
    }
    throw error
  }
}

// 管理员发放 / 扣减（负数），余额不会被扣成负数
export function grant(userId, amount, { note = '', operator = '' } = {}) {
  const delta = Math.trunc(Number(amount) || 0)
  if (!delta) throw new Error('发放数量不能为 0')
  const db = getDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare('SELECT credits FROM users WHERE id = ?').get(String(userId))
    if (!row) {
      db.exec('ROLLBACK')
      throw new Error('账号不存在：' + userId)
    }
    const balance = Number(row.credits || 0)
    if (balance + delta < 0) {
      db.exec('ROLLBACK')
      throw new Error('余额不足：当前 ' + balance + ' 积分，最多扣 ' + balance)
    }
    const after = balance + delta
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(after, String(userId))
    writeLedger(db, {
      userId: String(userId),
      delta,
      balanceAfter: after,
      kind: delta > 0 ? 'grant' : 'deduct',
      ref: [note, operator ? '操作人 ' + operator : ''].filter(Boolean).join(' · '),
    })
    db.exec('COMMIT')
    return { ok: true, balance: after, delta }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 同上
    }
    throw error
  }
}

// 老账号（积分制上线前就存在）余额是 0 且没有任何流水：给一次初始额度，
// 否则升级后管理员连一次检索都发不出去。只跑一次，有流水的账号不会被重复发。
export function ensureWelcomeCredits() {
  const db = getDb()
  let granted = 0
  const rows = db.prepare('SELECT id, credits FROM users').all()
  for (const row of rows) {
    if (Number(row.credits || 0) !== 0) continue
    const used = db.prepare('SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ?').get(row.id)
    if (Number(used?.n || 0) > 0) continue
    const amount = config.credits.welcome
    if (!amount) continue
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(amount, row.id)
    writeLedger(db, { userId: row.id, delta: amount, balanceAfter: amount, kind: 'welcome', ref: '积分制上线初始额度' })
    granted += 1
  }
  return granted
}

export function ledgerOf(userId, limit = 20) {
  if (!userId) return []
  const rows = getDb()
    .prepare('SELECT id, delta, balance_after, kind, ref, created_at FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(String(userId), Math.max(1, Math.min(200, Number(limit) || 20)))
  return rows.map((row) => ({
    id: row.id,
    delta: Number(row.delta),
    balance: Number(row.balance_after),
    kind: row.kind,
    ref: row.ref || '',
    createdAt: row.created_at,
  }))
}

// 一次请求的完整视角：余额 + 单价 + 最近流水
export function creditsFor(user, limit = 20) {
  return {
    ok: true,
    unit: config.credits.unit,
    balance: balanceOf(user?.id),
    prices: { ...config.credits.prices },
    concurrency: { ...config.credits.concurrency },
    ledger: ledgerOf(user?.id, limit),
    billingEnabled: false,
  }
}
