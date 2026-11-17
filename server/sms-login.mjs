// 手机号验证码登录：一次性码、默认 5 分钟、服务端只存哈希。
// 设计取舍与找回密码一致：
//   - 码是 bearer 凭证，接口只回「已发出」，库里存 sha256；
//   - 同一号码只留最新的一个码，重复发送一次后前一个立即作废；
//   - 一个码最多试 5 次，错满即作废，避免 6 位数字被在线爆破；
//   - 限流按「号码 + 来源」两把尺子：同一号码 60 秒才能再发、1 小时 5 条；同一来源 1 小时 10 条。
import crypto from 'node:crypto'
import { openDb } from './auth.mjs'

const DEFAULT_TTL_MINUTES = 5
const DEFAULT_CODE_LENGTH = 6
const MAX_ATTEMPTS = 5
const SEND_COOLDOWN_MS = 60 * 1000
const PHONE_LIMIT = 5
const IP_LIMIT = 10
const LIMIT_WINDOW_MS = 60 * 60 * 1000

let ready = false

function db() {
  const database = openDb()
  if (!ready) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS sms_codes (' +
        'id TEXT PRIMARY KEY, phone_hash TEXT NOT NULL, code_hash TEXT NOT NULL, ' +
        'user_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, ' +
        'attempts INTEGER NOT NULL DEFAULT 0, ip_hash TEXT);' +
        'CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes(phone_hash, created_at);',
    )
    ready = true
  }
  return database
}

const nowIso = () => new Date().toISOString()

export function hashCode(value) {
  return crypto.createHash('sha256').update('vq-sms|' + String(value || '')).digest('hex')
}

export function hashPhone(value) {
  return crypto.createHash('sha256').update('vq-sms-phone|' + String(value || '')).digest('hex')
}

export function hashSmsIp(ip) {
  return crypto.createHash('sha256').update('vq-sms-ip|' + String(ip || '')).digest('hex')
}

// 只清「早就过期」的行：最近的留一会儿，排查时能看出被刷过。
function prune() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  db().prepare('DELETE FROM sms_codes WHERE created_at < ?').run(cutoff)
}

/** 生成 4~8 位数字码，首位不为 0（避免被当成长整数丢掉前导零的误会）。 */
export function generateCode(length = DEFAULT_CODE_LENGTH) {
  const size = Math.min(8, Math.max(4, Math.trunc(Number(length) || DEFAULT_CODE_LENGTH)))
  let out = String(1 + crypto.randomInt(9))
  for (let index = 1; index < size; index += 1) out += String(crypto.randomInt(10))
  return out
}

/** 发一个新码：同一号码旧的未用码直接删掉，点两次「发送」只有最新那条能用。 */
export function issueSmsCode(phone, { userId = '', ip = '', ttlMinutes = DEFAULT_TTL_MINUTES, codeLength = DEFAULT_CODE_LENGTH } = {}) {
  const database = db()
  const phoneHash = hashPhone(phone)
  const code = generateCode(codeLength)
  const created = new Date()
  const expiresAt = new Date(created.getTime() + Math.max(1, Math.trunc(ttlMinutes)) * 60 * 1000)
  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare('DELETE FROM sms_codes WHERE phone_hash = ? AND used_at IS NULL').run(phoneHash)
    database
      .prepare('INSERT INTO sms_codes (id, phone_hash, code_hash, user_id, created_at, expires_at, used_at, attempts, ip_hash) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)')
      .run('sc_' + crypto.randomBytes(9).toString('base64url'), phoneHash, hashCode(code), String(userId || ''), created.toISOString(), expiresAt.toISOString(), ip ? hashSmsIp(ip) : '')
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // 事务已经没了，交给上层
    }
    throw error
  }
  prune()
  return { code, expiresAt: expiresAt.toISOString() }
}

/** 号码上还有没有可用的码（决定「发送」按钮能不能点、要不要提示冷却）。 */
export function pendingSmsCode(phone) {
  const row = db()
    .prepare('SELECT created_at, expires_at, attempts FROM sms_codes WHERE phone_hash = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(hashPhone(phone))
  if (!row) return { pending: false, expiresAt: '', attempts: 0 }
  return { pending: row.expires_at > nowIso(), expiresAt: row.expires_at, attempts: Number(row.attempts || 0) }
}

/**
 * 校验一个码。成功返回 userId（码里记的那个账号）；失败给 reason，页面据此说话。
 * 条件更新保证并发提交同一个码只有一次成功。
 */
export function verifySmsCode(phone, code) {
  const database = db()
  const phoneHash = hashPhone(phone)
  // 连「已用过」的行也读出来：用户重复提交同一枚码时，说「已经用过」比说「没有待验证的码」准确。
  const row = database
    .prepare('SELECT * FROM sms_codes WHERE phone_hash = ? ORDER BY created_at DESC LIMIT 1')
    .get(phoneHash)
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.used_at) return { ok: false, reason: 'used' }
  if (row.expires_at <= nowIso()) return { ok: false, reason: 'expired' }
  if (Number(row.attempts || 0) >= MAX_ATTEMPTS) return { ok: false, reason: 'too-many' }
  if (row.code_hash !== hashCode(code)) {
    const attempts = Number(row.attempts || 0) + 1
    database.prepare('UPDATE sms_codes SET attempts = ? WHERE id = ? AND used_at IS NULL').run(attempts, row.id)
    return { ok: false, reason: attempts >= MAX_ATTEMPTS ? 'too-many' : 'wrong', attempts, remaining: Math.max(0, MAX_ATTEMPTS - attempts) }
  }
  const at = nowIso()
  const result = database.prepare('UPDATE sms_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(at, row.id)
  if (!Number(result?.changes || 0)) return { ok: false, reason: 'used' }
  return { ok: true, userId: String(row.user_id || '') }
}

// 限流：进程内滑动窗口（单机部署够用，重启清零，不把刷短信成本变成永久状态）。
const windows = new Map()

function entry(key) {
  const hit = windows.get(key)
  if (!hit) return null
  if (Date.now() - hit.first > LIMIT_WINDOW_MS) {
    windows.delete(key)
    return null
  }
  return hit
}

function stamp(key, at = Date.now()) {
  const hit = entry(key)
  if (!hit) {
    windows.set(key, { first: at, count: 1, last: at })
    return
  }
  hit.count += 1
  hit.last = at
}

/** 发码前问一次：冷却中或超限就给出还要等多久（秒）。 */
export function sendSmsBlocked(phone, ip) {
  const phoneHash = hashPhone(phone)
  const hit = entry('phone|' + phoneHash)
  if (hit && Date.now() - hit.last < SEND_COOLDOWN_MS) {
    return { blocked: true, retryAfterSec: Math.ceil((SEND_COOLDOWN_MS - (Date.now() - hit.last)) / 1000), reason: 'cooldown' }
  }
  if (hit && hit.count >= PHONE_LIMIT) {
    return { blocked: true, retryAfterSec: Math.ceil((LIMIT_WINDOW_MS - (Date.now() - hit.first)) / 1000), reason: 'phone-limit' }
  }
  const ipHit = ip ? entry('ip|' + hashSmsIp(ip)) : null
  if (ipHit && ipHit.count >= IP_LIMIT) {
    return { blocked: true, retryAfterSec: Math.ceil((LIMIT_WINDOW_MS - (Date.now() - ipHit.first)) / 1000), reason: 'ip-limit' }
  }
  return { blocked: false, retryAfterSec: 0 }
}

export function recordSmsSend(phone, ip) {
  stamp('phone|' + hashPhone(phone))
  if (ip) stamp('ip|' + hashSmsIp(ip))
}

export function smsCooldownSec() {
  return Math.round(SEND_COOLDOWN_MS / 1000)
}

// 只给测试用：清掉进程内限流，避免用例之间互相影响
export function resetSmsRateLimits() {
  windows.clear()
}
