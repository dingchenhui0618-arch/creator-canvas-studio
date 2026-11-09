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

function openDb() {
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
  `)
  seedFirstAccount()
  pruneSessions()
  return db
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

export function createUser({ email, password, name }) {
  const normalized = String(email).trim().toLowerCase()
  const id = 'usr_' + crypto.randomBytes(9).toString('base64url')
  const displayName = (name || '').trim() || normalized.split('@')[0] || 'VisionQA 用户'
  openDb()
    .prepare('INSERT INTO users (id, email, name, workspace, password_hash, kind, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run(id, normalized, displayName, '个人工作区', hashPassword(password), 'account', nowIso())
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
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  return forwarded || req.socket?.remoteAddress || 'unknown'
}

// ---- 首个账号：库里没有账号时按 VQ_SEED_* 建一个普通账号 ----
// 它只是「部署后能登录」的引导账号，不是演示入口：kind 是 account，界面上也没有任何地方
// 会把它标成演示账号，更不会把口令发给访客。
export function seedFirstAccount() {
  if (!config.auth.seedAccount || !config.auth.seedEmail) return
  const email = config.auth.seedEmail
  if (findUserByEmail(email)) return
  createUser({ email, password: config.auth.seedPassword, name: config.auth.seedName })
}
