// 真实账号体系：SQLite 用户库 + scrypt 口令 + 服务端会话（HttpOnly cookie）
// 说明：这是本地/单机部署用的最小实现，够上线起步用；不做邮件验证与找回密码。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.mjs'
import { sealSecret, openSecret } from './keyvault.mjs'
import { hashBackupCode } from './totp.mjs'

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
  // 注册留痕：同意的条款版本与时间（管理员开通的账号标 admin-created，不假称用户同意过）
  ensureColumn(db, 'users', 'terms_version', 'TEXT')
  ensureColumn(db, 'users', 'terms_accepted_at', 'TEXT')
  // 两步验证（TOTP）：secret 用 Key 池那把 AES-GCM 密钥封存后落库；
  // pending_* 是「扫了码、还没输入 6 位确认」的中间态，确认后才搬到正式列。
  ensureColumn(db, 'users', 'totp_secret', 'TEXT')
  ensureColumn(db, 'users', 'totp_enabled_at', 'TEXT')
  ensureColumn(db, 'users', 'totp_last_counter', 'INTEGER')
  ensureColumn(db, 'users', 'totp_backup', 'TEXT')
  ensureColumn(db, 'users', 'totp_pending_secret', 'TEXT')
  ensureColumn(db, 'users', 'totp_pending_backup', 'TEXT')
  ensureColumn(db, 'users', 'totp_pending_at', 'TEXT')
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
    // 只给「有没有开」：secret、备用码永远不出接口
    twoFactor: Boolean(row.totp_enabled_at),
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

// 后台账号管理：只允许改「是否在用」与角色，改动立即生效（停用后现有会话也会失效）
export function updateUserAccess(id, patch = {}) {
  const current = findUserById(id)
  if (!current) return null
  const active = patch.active === undefined ? Number(current.is_active) : patch.active ? 1 : 0
  const kind = patch.kind === undefined ? current.kind : String(patch.kind)
  openDb().prepare('UPDATE users SET is_active = ?, kind = ? WHERE id = ?').run(active, kind, id)
  if (!active) openDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
  return findUserById(id)
}

// 删除账号：登录、会话与积分流水一起删掉，避免残留一条登不进去、也发不了积分的幽灵账号。
// 模板 / 画布 / 运行记录不在这里删：它们可能已被别人引用过，误删比留一条「已删除账号」的历史更糟。
export function deleteUser(id) {
  const database = openDb()
  if (!findUserById(id)) return false
  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(String(id))
    database.prepare('DELETE FROM credit_ledger WHERE user_id = ?').run(String(id))
    database.prepare('DELETE FROM users WHERE id = ?').run(String(id))
    database.exec('COMMIT')
    return true
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

// 管理员数量：用于「别把最后一个管理员删掉」这类守卫。停用的管理员也算，避免把自己锁在门外。
export function countAdmins() {
  const row = openDb().prepare("SELECT COUNT(*) AS n FROM users WHERE kind = 'admin'").get()
  return Number(row?.n || 0)
}

export function createUser({ email, password, name, kind = 'account', terms = null }) {
  const normalized = String(email).trim().toLowerCase()
  const id = 'usr_' + crypto.randomBytes(9).toString('base64url')
  const displayName = (name || '').trim() || normalized.split('@')[0] || 'VisionQA 用户'
  const welcome = Math.max(0, Math.round(Number(config.credits.welcome) || 0))
  const createdAt = nowIso()
  // 自助注册必须带条款版本；管理员开通的账号没有「用户点击同意」这一步，如实标成 admin-created
  const termsVersion = terms?.version ? String(terms.version).slice(0, 40) : 'admin-created'
  const termsAcceptedAt = terms?.at || createdAt
  const database = openDb()
  // 初始额度也要记一条流水：否则新账号的余额是 100，账本却是空的，用户会以为积分来路不明
  database.exec('BEGIN IMMEDIATE')
  try {
    database
      .prepare(
        'INSERT INTO users (id, email, name, workspace, password_hash, kind, is_active, credits, created_at, terms_version, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
      )
      .run(id, normalized, displayName, '个人工作区', hashPassword(password), kind, welcome, createdAt, termsVersion, termsAcceptedAt)
    if (welcome > 0) {
      database
        .prepare('INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, ref, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('cl_' + crypto.randomBytes(8).toString('base64url'), id, welcome, welcome, 'welcome', '新账号初始额度', null, createdAt)
    }
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // 回滚失败说明事务已经不在了，交给上层处理
    }
    throw error
  }
  return findUserById(id)
}

// 自己改口令：先验当前口令，再写新哈希；所有其它设备上的会话一律注销。
export function setPassword(userId, password) {
  if (!findUserById(userId)) return null
  openDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId)
  return findUserById(userId)
}

export function changePassword(userId, currentPassword, nextPassword) {
  const row = findUserById(userId)
  if (!row) return { ok: false, code: 'NOT_FOUND' }
  if (!verifyPassword(currentPassword, row.password_hash)) return { ok: false, code: 'BAD_CURRENT' }
  setPassword(userId, nextPassword)
  return { ok: true }
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

// 改口令/重置口令后清掉其它会话，保留操作者当前这一条（keepToken 为空则全部清掉）。
export function destroyOtherSessions(userId, keepToken = '') {
  const database = openDb()
  const result = keepToken
    ? database.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(String(userId), crypto.createHash('sha256').update(String(keepToken)).digest('hex'))
    : database.prepare('DELETE FROM sessions WHERE user_id = ?').run(String(userId))
  return Number(result?.changes || 0)
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


// ---- 两步验证（TOTP）----
// 落库的只有密文与备用码哈希；明文 secret 只在「开启那一次」出现在响应里。
// 登录分两步：口令正确但开了 2FA 时只发一个 5 分钟有效、HMAC 签名的 challenge，
// 6 位码（或备用码）验过之后才真正建会话。

const CHALLENGE_TTL_MS = 5 * 60 * 1000
let challengeKeyCache = ''

function totpChallengeKey() {
  if (challengeKeyCache) return challengeKeyCache
  const file = path.join(config.dataDir, '.totp-challenge.key')
  try {
    const stored = fs.readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(stored)) {
      challengeKeyCache = stored
      return stored
    }
  } catch {
    // 第一次用：下面生成
  }
  challengeKeyCache = crypto.randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    fs.writeFileSync(file, challengeKeyCache, { mode: 0o600 })
  } catch {
    // 写不进去就只在本次进程里有效（重启后需要重新登录输入验证码），不影响安全
  }
  return challengeKeyCache
}

function sign(payload) {
  return crypto.createHmac('sha256', Buffer.from(totpChallengeKey(), 'hex')).update(payload).digest('base64url')
}

export function signTotpChallenge(userId, remember = false) {
  // remember 也签进去：第二步没法改「记住我」，否则等于让人挑会话时长
  const payload = Buffer.from(
    JSON.stringify({ u: userId, exp: Date.now() + CHALLENGE_TTL_MS, r: Boolean(remember) }),
  ).toString('base64url')
  return payload + '.' + sign(payload)
}

/** 校验 challenge：只回 userId 与 remember；过期或被改过一律 null。 */
export function readTotpChallenge(token) {
  const [payload, signature] = String(token || '').split('.')
  if (!payload || !signature) return null
  const expected = sign(payload)
  if (expected.length !== signature.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!data?.u || Date.now() > Number(data.exp || 0)) return null
    return { userId: String(data.u), remember: Boolean(data.r) }
  } catch {
    return null
  }
}

const parseBackup = (value) => {
  try {
    const list = JSON.parse(String(value || '[]'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 当前账号的 2FA 状态：只回布尔、时间与剩余备用码数量。 */
export function totpInfo(userId) {
  const row = findUserById(userId)
  if (!row) return null
  const backup = parseBackup(row.totp_backup)
  return {
    enabled: Boolean(row.totp_enabled_at),
    enabledAt: row.totp_enabled_at || '',
    backupCodesLeft: backup.filter((item) => item && !item.usedAt).length,
    pending: Boolean(row.totp_pending_secret),
  }
}

export function startTotpSetup(userId, { secret, backupCodes }) {
  const backup = backupCodes.map((code) => ({ hash: hashBackupCode(code), usedAt: null }))
  openDb()
    .prepare('UPDATE users SET totp_pending_secret = ?, totp_pending_backup = ?, totp_pending_at = ? WHERE id = ?')
    .run(sealSecret(secret), JSON.stringify(backup), nowIso(), userId)
}

export function pendingTotp(userId) {
  const row = findUserById(userId)
  if (!row?.totp_pending_secret) return null
  return { secret: openSecret(row.totp_pending_secret), backup: parseBackup(row.totp_pending_backup) }
}

/** 确认码验过之后才把 pending 搬成正式：这一步之前，2FA 对登录不生效。 */
export function activateTotp(userId) {
  const row = findUserById(userId)
  if (!row?.totp_pending_secret) return false
  openDb()
    .prepare(
      'UPDATE users SET totp_secret = ?, totp_backup = ?, totp_enabled_at = ?, totp_last_counter = 0, totp_pending_secret = NULL, totp_pending_backup = NULL, totp_pending_at = NULL WHERE id = ?',
    )
    .run(row.totp_pending_secret, row.totp_pending_backup || '[]', nowIso(), userId)
  return true
}

export function clearTotp(userId) {
  openDb()
    .prepare(
      'UPDATE users SET totp_secret = NULL, totp_backup = NULL, totp_enabled_at = NULL, totp_last_counter = NULL, totp_pending_secret = NULL, totp_pending_backup = NULL, totp_pending_at = NULL WHERE id = ?',
    )
    .run(userId)
}

/** 登录第二步要用：解密后的 secret、上次用过的步长、备用码。只在服务端内部使用。 */
export function totpMaterial(userId) {
  const row = findUserById(userId)
  if (!row?.totp_secret) return null
  return {
    secret: openSecret(row.totp_secret),
    lastCounter: Number(row.totp_last_counter || 0),
    backup: parseBackup(row.totp_backup),
  }
}

export function saveTotpCounter(userId, counter) {
  openDb().prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?').run(Number(counter) || 0, userId)
}

export function saveTotpBackup(userId, backup) {
  openDb().prepare('UPDATE users SET totp_backup = ? WHERE id = ?').run(JSON.stringify(backup || []), userId)
}

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
    .prepare('SELECT id, email, name, workspace, kind, is_active, credits, created_at, last_login_at, terms_version, terms_accepted_at FROM users ORDER BY created_at')
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
      termsVersion: row.terms_version || '',
      termsAcceptedAt: row.terms_accepted_at || '',
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
