// 真实账号体系：SQLite 用户库 + scrypt 口令 + 服务端会话（HttpOnly cookie）
// 说明：这是本地/单机部署用的最小实现，够上线起步用；不做邮件验证与找回密码。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.mjs'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64

let db = null

export function openDb() {
  if (db) return db
  const file = config.auth.dbFile
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT '个人工作区',
      password_hash TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'account',
      is_active INTEGER NOT NULL DEFAULT 1,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      user_agent TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    -- 积分流水：余额在 users.credits，流水是账本；两边同一个事务里改，余额永远等于流水求和
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT,
      meta TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_ledger(user_id, created_at);
  `)
  ensureColumn(db, 'users', 'credits', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'users', 'kind', "TEXT NOT NULL DEFAULT 'account'")
  seedFirstAccount()
  ensureAnAdmin()
  pruneSessions()
  return db
}

// 老库没有新列时补上（SQLite 没有 ADD COLUMN IF NOT EXISTS）
function ensureColumn(database, table, column, definition) {
  const columns = database.prepare('PRAGMA table_info(' + table + ')').all()
  if (columns.some((item) => item.name === column)) return
  database.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition)
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(password.normalize('NFKC'), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('hex'), key.toString('hex')].join('$')
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltHex, keyHex] = String(stored).split('$')
    if (scheme !== 'scrypt') return false
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(keyHex, 'hex')
    const actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) })
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    workspace: row.workspace,
    kind: row.kind,
    credits: Number(row.credits || 0),
  }
}

function nowIso() {
  return new Date().toISOString()
}

export function findUserByEmail(email) {
  return openDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase()) || null
}

export function findUserById(id) {
  return openDb().prepare('SELECT * FROM users WHERE id = ?').get(String(id)) || null
}

export function createUser({ email, password, name, kind = 'account' }) {
  const normalized = String(email).trim().toLowerCase()
  const id = 'usr_' + crypto.randomBytes(9).toString('base64url')
  const displayName = (name || '').trim() || normalized.split('@')[0] || 'VisionQA 用户'
  openDb()
    .prepare('INSERT INTO users (id, email, name, workspace, password_hash, kind, is_active, credits, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .run(id, normalized, displayName, '个人工作区', hashPassword(password), kind, config.credits.welcome, nowIso())
  return findUserById(id)
}

export function createSession(user, { userAgent = '', ip = '', remember = false } = {}) {
  const token = crypto.randomBytes(32).toString('base64url')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const days = remember ? config.auth.rememberDays : config.auth.sessionDays
  const expiresAt = Date.now() + days * 24 * 3600 * 1000
  openDb()
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tokenHash, user.id, nowIso(), expiresAt, String(userAgent).slice(0, 200), String(ip).slice(0, 64))
  openDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id)
  return { token, expiresAt }
}

export function userForToken(token) {
  if (!token) return null
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex')
  const row = openDb()
    .prepare('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .get(tokenHash)
  if (!row) return null
  if (Number(row.expires_at) < Date.now()) {
    openDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return null
  }
  if (!row.is_active) return null
  return row
}

export function destroySession(token) {
  if (!token) return
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex')
  openDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
}

export function pruneSessions() {
  openDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
}

// ---- cookie ----
export function parseCookies(req) {
  const raw = req.headers?.cookie || ''
  const out = {}
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 1) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

export function sessionCookie(token, maxAgeSeconds) {
  const attrs = [
    config.auth.cookieName + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (maxAgeSeconds) attrs.push('Max-Age=' + Math.floor(maxAgeSeconds))
  if (config.auth.secureCookies) attrs.push('Secure')
  return attrs.join('; ')
}

export function clearCookie() {
  const attrs = [config.auth.cookieName + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (config.auth.secureCookies) attrs.push('Secure')
  return attrs.join('; ')
}

export function currentUser(req) {
  return userForToken(parseCookies(req)[config.auth.cookieName])
}

export { publicUser }

// ---- 登录失败限流（进程内滑动窗口，够单机用） ----
const attempts = new Map()
const WINDOW_MS = 10 * 60 * 1000
const MAX_FAILS = 8

export function tooManyAttempts(key) {
  const entry = attempts.get(key)
  if (!entry) return false
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(key)
    return false
  }
  return entry.count >= MAX_FAILS
}

export function recordFailure(key) {
  const entry = attempts.get(key)
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    attempts.set(key, { first: Date.now(), count: 1 })
    return
  }
  entry.count += 1
}

export function clearFailures(key) {
  attempts.delete(key)
}

export function clientIp(req) {
  // 只信反代补的那一跳：X-Real-IP 由 nginx 用 $remote_addr 覆写；XFF 取最后一段，
  // 因为客户端自己带的 X-Forwarded-For 会被拼在前面（取第一段等于让攻击者随便换 IP 绕登录限流）。
  const real = String(req.headers?.['x-real-ip'] || '').trim()
  if (real) return real
  const chain = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return chain.length ? chain[chain.length - 1] : req.socket?.remoteAddress || 'unknown'
}

// ---- 管理员 ----
// 默认只有 kind='admin' 或 VQ_ADMIN_EMAILS 里的账号能看全部数据、发放积分。
export function isAdmin(user) {
  if (!user) return false
  if (user.kind === 'admin') return true
  return config.auth.adminEmails.includes(String(user.email || '').toLowerCase())
}

// 单账号部署（绝大多数自建实例）不该还要手工改库才能发积分：
// 库里一个管理员都没有时，把部署引导账号（或最早的那个账号）提升为管理员。
export function ensureAnAdmin() {
  try {
    const admins = openDb().prepare("SELECT id FROM users WHERE kind = 'admin'").all()
    if (admins.length) return
    const seeded = config.auth.seedEmail ? findUserByEmail(config.auth.seedEmail) : null
    const target = seeded || openDb().prepare('SELECT id, email FROM users ORDER BY created_at LIMIT 1').get()
    if (!target) return
    openDb().prepare("UPDATE users SET kind = 'admin' WHERE id = ?").run(target.id)
    console.log('[auth] 库里没有管理员，已把 ' + (target.email || target.id) + ' 提升为管理员')
  } catch (error) {
    console.error('[auth] 管理员自检失败：' + (error?.message || error))
  }
}

// 管理台用：真实账号列表（含余额），不返回口令哈希
export function listUsers() {
  return openDb()
    .prepare('SELECT id, email, name, workspace, kind, is_active, credits, created_at, last_login_at FROM users ORDER BY created_at')
    .all()
    .map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      workspace: row.workspace,
      kind: row.kind,
      active: Boolean(row.is_active),
      credits: Number(row.credits || 0),
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    }))
}

// ---- 首个账号：库里没有账号时按 VQ_SEED_* 建一个账号（此时它就是管理员） ----
// 它只是「部署后能登录」的引导账号，不是演示入口：kind 是 account，界面上也没有任何地方
// 会把它标成演示账号，更不会把口令发给访客。
export function seedFirstAccount() {
  if (!config.auth.seedAccount || !config.auth.seedEmail) return
  const email = config.auth.seedEmail
  if (findUserByEmail(email)) return
  const anyUser = openDb().prepare('SELECT COUNT(*) AS n FROM users').get()
  const kind = Number(anyUser?.n || 0) === 0 ? 'admin' : 'account'
  createUser({ email, password: config.auth.seedPassword, name: config.auth.seedName, kind })
}
