// 自助找回密码：一次性 token、30 分钟有效、服务端只存哈希。
// 设计取舍：
//   - token 是 bearer 凭证，链接里只放原文一次，库里存 sha256；
//   - 「有没有这个账号」不能从响应里看出来：无账号、没配邮件通道、发信失败都回同一句话；
//   - 每次申请作废旧 token（同一账号只留最新一条），点两遍邮件只有最新那封能用；
//   - 限流按「邮箱 + 来源」两把尺子，够挡住拿找回页当刷信机的情况，不引入图形验证码。
import crypto from 'node:crypto'
import { openDb } from './auth.mjs'

const DEFAULT_TTL_MINUTES = 30
const MIN_TTL_MINUTES = 5
const MAX_TTL_MINUTES = 120
const EMAIL_LIMIT = 3
const IP_LIMIT = 10
const LIMIT_WINDOW_MS = 60 * 60 * 1000

let ready = false

function db() {
  const database = openDb()
  if (!ready) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS password_resets (' +
        'id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, ' +
        'created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, ip_hash TEXT);' +
        'CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, created_at);',
    )
    ready = true
  }
  return database
}

const nowIso = () => new Date().toISOString()

export function resetTtlMinutes() {
  const raw = Number(process.env.VQ_RESET_TTL_MINUTES || DEFAULT_TTL_MINUTES)
  if (!Number.isFinite(raw)) return DEFAULT_TTL_MINUTES
  return Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.trunc(raw)))
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

export function hashIp(ip) {
  return crypto.createHash('sha256').update('vq-reset|' + String(ip || '')).digest('hex')
}

// 只清「早就过期」的行：最近的记录留一会儿，排查时能看出被刷过。
function prune() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  db().prepare('DELETE FROM password_resets WHERE created_at < ?').run(cutoff)
}

/**
 * 生成一枚重置 token。同一账号旧的未用 token 直接删掉——
 * 申请两次时只有最新那封邮件能点，避免两封链接同时有效、各改一次口令。
 */
export function createResetToken(userId, { ip = '', ttlMinutes = resetTtlMinutes() } = {}) {
  const database = db()
  const token = crypto.randomBytes(32).toString('base64url')
  const created = new Date()
  const expiresAt = new Date(created.getTime() + ttlMinutes * 60 * 1000)
  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(String(userId))
    database
      .prepare('INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at, ip_hash) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run('pr_' + crypto.randomBytes(9).toString('base64url'), String(userId), hashToken(token), created.toISOString(), expiresAt.toISOString(), ip ? hashIp(ip) : '')
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
  return { token, expiresAt: expiresAt.toISOString(), ttlMinutes }
}

/** 重置页打开时先问一句：这枚 token 还能用吗（不消费）。 */
export function peekResetToken(token) {
  const value = String(token || '').trim()
  if (!value) return { valid: false, reason: 'missing' }
  const row = db().prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hashToken(value))
  if (!row) return { valid: false, reason: 'unknown' }
  if (row.used_at) return { valid: false, reason: 'used', usedAt: row.used_at }
  if (row.expires_at <= nowIso()) return { valid: false, reason: 'expired', expiresAt: row.expires_at }
  return { valid: true, expiresAt: row.expires_at }
}

/**
 * 消费一枚 token：条件更新保证同一个链接并发点两次也只有一次成功。
 * 返回 { ok, userId } 或 { ok:false, reason }。
 */
export function consumeResetToken(token) {
  const value = String(token || '').trim()
  if (!value) return { ok: false, reason: 'missing' }
  const database = db()
  const hash = hashToken(value)
  const at = nowIso()
  const result = database.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').run(at, hash, at)
  if (!Number(result?.changes || 0)) {
    const probe = peekResetToken(value)
    return { ok: false, reason: probe.reason || 'unknown' }
  }
  const row = database.prepare('SELECT user_id FROM password_resets WHERE token_hash = ?').get(hash)
  return { ok: true, userId: String(row?.user_id || '') }
}

// 限流：进程内滑动窗口。单机部署够用，重启后清零（不把刷信成本变成永久状态）。
const windows = new Map()

function overLimit(kind, key, max) {
  const entry = windows.get(kind + '|' + key)
  if (!entry) return 0
  const elapsed = Date.now() - entry.first
  if (elapsed > LIMIT_WINDOW_MS) {
    windows.delete(kind + '|' + key)
    return 0
  }
  if (entry.count < max) return 0
  return Math.ceil((LIMIT_WINDOW_MS - elapsed) / 1000)
}

/** 申请前问一次：同一邮箱 1 小时 3 次、同一来源 1 小时 10 次。被限时返回还要等几秒。 */
export function resetRequestBlocked(email, ip) {
  const byEmail = overLimit('email', hashToken(String(email || '').toLowerCase()), EMAIL_LIMIT)
  if (byEmail) return { blocked: true, retryAfterSec: byEmail }
  const byIp = ip ? overLimit('ip', hashIp(ip), IP_LIMIT) : 0
  if (byIp) return { blocked: true, retryAfterSec: byIp }
  return { blocked: false, retryAfterSec: 0 }
}

export function recordResetRequest(email, ip) {
  const stamp = (kind, key) => {
    const entry = windows.get(kind + '|' + key)
    if (!entry || Date.now() - entry.first > LIMIT_WINDOW_MS) {
      windows.set(kind + '|' + key, { first: Date.now(), count: 1 })
      return
    }
    entry.count += 1
  }
  stamp('email', hashToken(String(email || '').toLowerCase()))
  if (ip) stamp('ip', hashIp(ip))
}

// 只给测试用：清掉进程内限流，避免用例之间互相影响
export function resetRateLimits() {
  windows.clear()
}

/**
 * 找回密码邮件：纯文本 + 一份克制的 HTML（近白底、单按钮、不引外部图片）。
 * 两段内容都写清楚「不是你点的就忽略」，用户不用去猜这封信能不能不管。
 */
export function buildResetMail({ link, ttlMinutes = resetTtlMinutes(), email = '', siteName = 'VisionQA', supportEmail = '' }) {
  const minutes = Math.max(1, Math.trunc(ttlMinutes))
  const subject = '重置 ' + siteName + ' 口令（' + minutes + ' 分钟内有效）'
  const text = [
    '有人申请重置这个账号（' + (email || '你的账号') + '）在 ' + siteName + ' 的口令。',
    '',
    '点下面的链接设置新口令：',
    link,
    '',
    '链接 ' + minutes + ' 分钟内有效，只能用一次。',
    '如果不是你点的，忽略这封邮件即可；你的口令不会变。',
    '',
    '没有申请过、却反复收到这类邮件，可以直接回复' + (supportEmail ? ' ' + supportEmail : '本邮件') + '。',
  ].join('\n')
  const safety = supportEmail ? '反复收到可以联系 ' + escapeHtml(supportEmail) + '。' : ''
  const html = [
    '<div style="margin:0;padding:32px 16px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,sans-serif;color:#18181b;">',
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;">',
    '<p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#71717a;">' + siteName + '</p>',
    '<h1 style="margin:0 0 16px;font-size:20px;font-weight:600;line-height:1.35;">重置你的口令</h1>',
    '<p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#3f3f46;">有人申请重置 <strong style="color:#18181b;">' + escapeHtml(email || '你的账号') + '</strong> 在 ' + siteName + ' 的口令。点下面的按钮设置新口令，链接 ' + minutes + ' 分钟内有效，只能用一次。</p>',
    '<p style="margin:0 0 24px;"><a href="' + escapeHtml(link) + '" style="display:inline-block;background:#18181b;color:#fafafa;text-decoration:none;font-size:14px;font-weight:500;padding:12px 20px;border-radius:8px;">设置新口令</a></p>',
    '<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#71717a;">按钮点不开就把这段地址粘到浏览器：</p>',
    '<p style="margin:0 0 24px;font-size:12px;line-height:1.6;word-break:break-all;color:#3f3f46;">' + escapeHtml(link) + '</p>',
    '<hr style="border:none;border-top:1px solid #e4e4e7;margin:0 0 16px;" />',
    '<p style="margin:0;font-size:12px;line-height:1.6;color:#71717a;">不是你点的就忽略这封邮件，口令不会变。' + safety + '</p>',
    '</div>',
    '</div>',
  ].join('')
  return { subject, text, html }
}

function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(value || '').replace(/[&<>"']/g, (char) => map[char])
}
