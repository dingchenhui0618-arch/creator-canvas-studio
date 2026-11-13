// 邀请码：内测开号不再需要管理员在线。
// 设计取舍：
//   - 码本身就是凭证（bearer），所以只在签发那一次返回明文，列表里也照原样给管理员看（管理员本来就能开号）；
//   - 占用是「条件更新」而不是「先读后写」：同一枚 1 次码被两个请求同时提交时，只有一个能把 used 从 0 改成 1；
//   - 状态由 used / expires_at / revoked_at 三个事实推导，不额外存一个会和事实不一致的 status 列；
//   - 反滥用只做同一来源 24 小时限开 N 个号（默认 3），不引入手机号 / 图形验证码这类更重的前置。
import crypto from 'node:crypto'
import { openDb } from './auth.mjs'
import { config } from './config.mjs'

// 去掉容易看混的 0/O/1/I，码可以在电话里念、也能手抄
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE_BODY = 8
const CODE_PREFIX = 'VQ'

let ready = false

function db() {
  const database = openDb()
  if (!ready) {
    ensureSchema(database)
    ready = true
  }
  return database
}

function ensureSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL DEFAULT '',
      max_uses INTEGER NOT NULL DEFAULT 1,
      used INTEGER NOT NULL DEFAULT 0,
      credits INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invites_created ON invites(created_at);
    -- 每一笔占用单独留痕：谁用的、什么时候、来自哪个来源（IP 只存哈希）
    CREATE TABLE IF NOT EXISTS invite_uses (
      id TEXT PRIMARY KEY,
      invite_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      email TEXT,
      ip_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invite_uses_invite ON invite_uses(invite_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_invite_uses_ip ON invite_uses(ip_hash, created_at);
  `)
}

const nowIso = () => new Date().toISOString()

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

// 用户粘贴常带空格、小写、缺前缀；统一成 VQ-XXXX-XXXX 再查库。
export function normalizeInviteCode(value) {
  const raw = String(value || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
  if (!raw) return ''
  const body = raw.startsWith(CODE_PREFIX) ? raw.slice(CODE_PREFIX.length) : raw
  if (body.length !== CODE_BODY) return ''
  for (const char of body) if (!ALPHABET.includes(char)) return ''
  return CODE_PREFIX + '-' + body.slice(0, 4) + '-' + body.slice(4)
}

/** 生成一枚新码；同库极小概率撞码时重试，重试耗尽就抛错（不静默返回空码）。 */
function randomCode(database) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = crypto.randomBytes(CODE_BODY)
    let body = ''
    for (let index = 0; index < CODE_BODY; index += 1) body += ALPHABET[bytes[index] % ALPHABET.length]
    const code = CODE_PREFIX + '-' + body.slice(0, 4) + '-' + body.slice(4)
    if (!database.prepare('SELECT 1 FROM invites WHERE code = ?').get(code)) return code
  }
  throw new Error('邀请码生成失败，请重试')
}

/** 派生状态：撤销 > 用完 > 过期 > 可用。顺序有意义：撤销永远优先。 */
export function inviteStatus(row, at = Date.now()) {
  if (!row) return 'missing'
  if (row.revoked_at) return 'revoked'
  if (Number(row.used) >= Number(row.max_uses)) return 'used'
  if (row.expires_at && Date.parse(row.expires_at) <= at) return 'expired'
  return 'active'
}

function shape(row, extra = {}) {
  if (!row) return null
  const status = inviteStatus(row)
  return {
    id: row.id,
    code: row.code,
    createdBy: row.created_by,
    maxUses: Number(row.max_uses),
    used: Number(row.used),
    remaining: Math.max(0, Number(row.max_uses) - Number(row.used)),
    credits: Number(row.credits),
    note: row.note || '',
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    createdAt: row.created_at,
    status,
    ...extra,
  }
}

export function createInvite({ createdBy = '', maxUses, days, credits, note = '' } = {}) {
  const database = db()
  const uses = clampInt(maxUses ?? config.invites.defaultUses, 1, 200, 1)
  const span = clampInt(days ?? config.invites.defaultDays, 1, 365, 7)
  const credit = clampInt(credits ?? config.invites.defaultCredits, 0, 100000, 0)
  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + span * 24 * 3600 * 1000).toISOString()
  const id = 'inv_' + crypto.randomBytes(9).toString('base64url')
  database
    .prepare(
      'INSERT INTO invites (id, code, created_by, max_uses, used, credits, note, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, ?)',
    )
    .run(id, randomCode(database), String(createdBy).slice(0, 190), uses, credit, String(note || '').slice(0, 200), expiresAt, createdAt.toISOString())
  return getInvite(id)
}

export function getInvite(id) {
  return shape(db().prepare('SELECT * FROM invites WHERE id = ?').get(String(id)))
}

export function findInviteByCode(code) {
  const canonical = normalizeInviteCode(code)
  if (!canonical) return null
  return shape(db().prepare('SELECT * FROM invites WHERE code = ?').get(canonical))
}

/** 公开校验：只回状态、剩余次数与赠送额度；不存在的码与格式错误都算 invalid。 */
export function inviteState(code) {
  const canonical = normalizeInviteCode(code)
  if (!canonical) return { valid: false, reason: 'invalid', status: 'invalid' }
  const invite = findInviteByCode(canonical)
  if (!invite) return { valid: false, reason: 'invalid', status: 'missing' }
  return {
    valid: invite.status === 'active',
    reason: invite.status,
    status: invite.status,
    credits: invite.credits,
    remaining: invite.remaining,
    expiresAt: invite.expiresAt,
  }
}

/** 管理员列表：带上最近的使用记录（谁、何时、来源哈希前 8 位），方便排查一码多传。 */
export function listInvites({ limit = 100 } = {}) {
  const database = db()
  const rows = database.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT ?').all(clampInt(limit, 1, 500, 100))
  const useStmt = database.prepare('SELECT email, ip_hash, created_at FROM invite_uses WHERE invite_id = ? ORDER BY created_at DESC LIMIT 5')
  return rows.map((row) =>
    shape(row, {
      uses: useStmt.all(row.id).map((use) => ({
        email: use.email || '',
        ip: use.ip_hash ? String(use.ip_hash).slice(0, 8) : '',
        createdAt: use.created_at,
      })),
    }),
  )
}

export function inviteSummary() {
  const items = listInvites({ limit: 500 })
  return {
    items,
    total: items.length,
    active: items.filter((item) => item.status === 'active').length,
    used: items.filter((item) => item.status === 'used').length,
    revoked: items.filter((item) => item.status === 'revoked').length,
    expired: items.filter((item) => item.status === 'expired').length,
    limits: { maxPerIp: config.invites.maxPerIp, windowHours: config.invites.ipWindowHours },
  }
}

export function revokeInvite(id) {
  const database = db()
  const result = database
    .prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(nowIso(), String(id))
  return { ok: Number(result?.changes || 0) > 0, invite: getInvite(id) }
}

/**
 * 占用一次：只在「没撤销、没用完、没过期」时把 used +1。
 * 条件写在 UPDATE 的 WHERE 里，两个并发请求只有一个能拿到 changes=1。
 */
export function claimInvite(inviteId, { userId = '', email = '', ip = '' } = {}) {
  const database = db()
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = database
      .prepare(
        'UPDATE invites SET used = used + 1 WHERE id = ? AND revoked_at IS NULL AND used < max_uses AND (expires_at IS NULL OR expires_at > ?)',
      )
      .run(String(inviteId), nowIso())
    if (!Number(result?.changes || 0)) {
      database.exec('ROLLBACK')
      return { ok: false, reason: 'unavailable', invite: getInvite(inviteId) }
    }
    database
      .prepare('INSERT INTO invite_uses (id, invite_id, user_id, email, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('iu_' + crypto.randomBytes(8).toString('base64url'), String(inviteId), String(userId), String(email || '').slice(0, 190), ip ? hashIp(ip) : '', nowIso())
    database.exec('COMMIT')
    return { ok: true, invite: getInvite(inviteId) }
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // 事务已经不在了，交给上层报错
    }
    throw error
  }
}

// 来源只留在限流用的哈希里：IP 是个人信息，没必要明文躺在账号库里。
export function hashIp(ip) {
  return crypto.createHash('sha256').update('vq-invite|' + String(ip || '')).digest('hex')
}

/** 同一来源在窗口内已经用邀请码开了几个号。 */
export function signupCountForIp(ip, hours = config.invites.ipWindowHours) {
  if (!ip) return 0
  const cutoff = new Date(Date.now() - Math.max(1, Number(hours) || 24) * 3600 * 1000).toISOString()
  const row = db().prepare('SELECT COUNT(*) AS n FROM invite_uses WHERE ip_hash = ? AND created_at > ?').get(hashIp(ip), cutoff)
  return Number(row?.n || 0)
}

// 公开校验接口的尝试限流（进程内滑动窗口，单机部署够用）：
// 不让别人拿注册页当邀请码扫描器。
const attempts = new Map()
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000
const ATTEMPT_MAX = 20

export function tooManyInviteAttempts(key) {
  const entry = attempts.get(key)
  if (!entry) return false
  if (Date.now() - entry.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(key)
    return false
  }
  return entry.count >= ATTEMPT_MAX
}

export function recordInviteAttempt(key) {
  const entry = attempts.get(key)
  if (!entry || Date.now() - entry.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { first: Date.now(), count: 1 })
    return
  }
  entry.count += 1
}

export function clearInviteAttempts(key) {
  attempts.delete(key)
}
