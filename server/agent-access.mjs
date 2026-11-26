// 智能体接入：配对码 + vqc_ 令牌（r315 一期 1b）。
//
// 三件事在这里定死，别处不许再各写一套：
//   1. 配对码：8 位（XXXX-XXXX），24 小时、最多换 10 个令牌、同房间重新生成旧码即失效；
//   2. 令牌：只在配对上返回一次，库里只存 sha256，能单条撤销，撤销/成员被移出即刻失效；
//   3. 令牌是「说话权」：只认自己那个房间与成员，拿不到 vq_session，碰不到 /api/admin、
//      也调不了扣费工具——那条闸门在 1c/1d 的工具层，这里连入口都不给。
//
// 为什么表不放在 rooms.mjs 里：rooms.mjs 要反过来在「移出成员」时撤销令牌（单向依赖），
// 两边各开一次 openDb() 是同一个句柄，不新增数据库文件。
import crypto from 'node:crypto'
import { openDb } from './auth.mjs'
import { ROOM_LIMITS } from './rooms.mjs'

// 配对码字母表去掉容易看错的 0/O/1/I，抄的是「隔着屏幕念一遍」的常识。
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
// 24 小时 / 最多 10 个 / 8 位：与 rooms.mjs 的 ROOM_LIMITS 分开写，避免两个模块在
// 加载期互相读常量（rooms 会在移出成员时反过来调本模块）。数字只在这里出现一次。
export const PAIR = {
  ttlMs: 24 * 60 * 60 * 1000,
  maxUses: 10,
  length: CODE_LENGTH,
}

export const AGENT_LIMITS = {
  tokenPrefix: 'vqc_',
  nameLength: 40,
  providerLength: 40,
  // 长轮询上限 25 秒：比 nginx 的 300 秒空闲超时远得多，也不会让一条连接攥太久
  maxWaitMs: 25000,
  defaultWaitMs: 25000,
  inboxPage: 50,
}

let ready = false

function db() {
  const handle = openDb()
  if (!ready) {
    ensureSchema(handle)
    ready = true
  }
  return handle
}

function ensureSchema(handle) {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS pair_codes (
      code TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      last_inbox_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pair_codes_room ON pair_codes(room_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_member ON agent_tokens(member_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_room ON agent_tokens(room_id, revoked_at);
  `)
}

const now = () => Date.now()
const id = (prefix) => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 16)

function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code }, extra || {})
}

function clipped(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max)
}

// ── 配对码 ────────────────────────────────────────────────────────────────

function randomCode() {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  return out
}

/** 用户念/贴进来的形态都收：大小写、空格、连字符都不计较。 */
export function normalizeCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (raw.length !== CODE_LENGTH) return ''
  for (const char of raw) if (!CODE_ALPHABET.includes(char)) return ''
  return raw
}

export function formatCode(code) {
  return code.slice(0, 4) + '-' + code.slice(4)
}

function roomRow(handle, roomId) {
  return handle.prepare('SELECT * FROM rooms WHERE id = ?').get(String(roomId)) || null
}

// 配对码只给房主：能生成码的人等于能把新智能体放进房间，和「加智能体」是同一种权限。
function requireOwner(handle, roomId, userId) {
  const room = roomRow(handle, roomId)
  if (!room || room.dissolved_at) throw httpError(404, 'ROOM_NOT_FOUND', '这个房间不在了')
  if (room.owner_id !== userId) throw httpError(403, 'ROOM_OWNER', '只有房主能接入智能体')
  return room
}

function activeCodeRow(handle, roomId) {
  const row = handle
    .prepare('SELECT * FROM pair_codes WHERE room_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(String(roomId))
  if (!row) return null
  if (Number(row.expires_at) <= now()) return null
  if (Number(row.used_count) >= PAIR.maxUses) return null
  return row
}

export function publicPairCode(row) {
  if (!row) return null
  return {
    code: formatCode(row.code),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    used: Number(row.used_count),
    max: PAIR.maxUses,
  }
}

/** 生成新码：同一房间同时只有一张有效，旧码立即作废（一次一换）。 */
export function createPairCode({ roomId, userId }) {
  const handle = db()
  requireOwner(handle, roomId, userId)
  const at = now()
  handle.exec('BEGIN IMMEDIATE')
  try {
    handle.prepare('UPDATE pair_codes SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL').run(at, String(roomId))
    // 撞码概率极低（32^8），撞上了重摇，不把「码不存在」当成功
    let code = ''
    for (let i = 0; i < 8; i += 1) {
      code = randomCode()
      const exists = handle.prepare('SELECT 1 FROM pair_codes WHERE code = ?').get(code)
      if (!exists) break
      code = ''
    }
    if (!code) throw httpError(500, 'PAIR_CODE', '没能生成配对码，请重试')
    handle
      .prepare('INSERT INTO pair_codes (code, room_id, user_id, created_at, expires_at, used_count) VALUES (?, ?, ?, ?, ?, 0)')
      .run(code, String(roomId), String(userId), at, at + PAIR.ttlMs)
    const row = handle.prepare('SELECT * FROM pair_codes WHERE code = ?').get(code)
    handle.exec('COMMIT')
    return publicPairCode(row)
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
}

export function currentPairCode({ roomId, userId }) {
  const handle = db()
  requireOwner(handle, roomId, userId)
  return publicPairCode(activeCodeRow(handle, roomId))
}

export function revokePairCode({ roomId, userId }) {
  const handle = db()
  requireOwner(handle, roomId, userId)
  handle.prepare('UPDATE pair_codes SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL').run(now(), String(roomId))
  return { ok: true }
}

// ── 令牌 ──────────────────────────────────────────────────────────────────

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex')
}

function newToken() {
  const raw = AGENT_LIMITS.tokenPrefix + crypto.randomBytes(32).toString('base64url')
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, AGENT_LIMITS.tokenPrefix.length + 6) }
}

function memberRow(handle, memberId) {
  return handle.prepare('SELECT * FROM room_members WHERE id = ?').get(String(memberId)) || null
}

function publicMemberOf(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    role: row.role || '',
    provider: row.provider || '',
    agentId: row.agent_id || '',
  }
}

/**
 * 配对：码 + 名字 → 一个令牌（只此一次）。
 * 同名重连默认 409 MEMBER_EXISTS（附 reclaim: true），带 reclaim 才接管并让旧令牌立刻失效。
 */
export function pairWithCode({ code, name, provider = '', reclaim = false }) {
  const handle = db()
  const normalized = normalizeCode(code)
  if (!normalized) throw httpError(400, 'PAIR_CODE_FORMAT', '配对码是 8 位，形如 7KQ2-LMZ9')
  const label = clipped(name, AGENT_LIMITS.nameLength)
  if (label.length < 2) throw httpError(400, 'PAIR_NAME', '给这个智能体起个名字（至少 2 个字）')
  const at = now()

  handle.exec('BEGIN IMMEDIATE')
  try {
    const pair = handle.prepare('SELECT * FROM pair_codes WHERE code = ?').get(normalized)
    if (!pair || pair.revoked_at) throw httpError(401, 'PAIR_CODE', '配对码不对，或者已经被换掉了，让主人在房间里重新生成')
    if (Number(pair.expires_at) <= at) throw httpError(410, 'PAIR_EXPIRED', '配对码过期了（24 小时有效），让主人在房间里重新生成')
    if (Number(pair.used_count) >= PAIR.maxUses) throw httpError(429, 'PAIR_USED', '这张码已经接了 ' + PAIR.maxUses + ' 个智能体，让主人重新生成')

    const room = roomRow(handle, pair.room_id)
    if (!room || room.dissolved_at) throw httpError(410, 'ROOM_NOT_FOUND', '房间已经被解散了')

    const cleanProvider = clipped(provider, AGENT_LIMITS.providerLength) || 'connector'
    const existing = handle
      .prepare("SELECT * FROM room_members WHERE room_id = ? AND kind = 'agent' AND name = ? AND removed_at IS NULL")
      .get(String(pair.room_id), label)

    let member = existing
    if (existing && !reclaim) {
      throw httpError(409, 'MEMBER_EXISTS', '这个房间里已经有一个叫「' + label + '」的智能体', {
        member: publicMemberOf(existing),
        reclaim: true,
      })
    }
    if (!existing) {
      const count = Number(
        handle
          .prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND kind = 'agent' AND removed_at IS NULL")
          .get(String(pair.room_id)).n || 0,
      )
      if (count >= ROOM_LIMITS.agentsPerRoom) {
        throw httpError(400, 'ROOM_MEMBERS', '一个房间最多 ' + ROOM_LIMITS.agentsPerRoom + ' 个智能体')
      }
      const memberId = id('mb_')
      // 连接器成员没有 agent_id（不是平台智能体），provider 记它是从哪来的
      handle
        .prepare("INSERT INTO room_members (id, room_id, kind, name, role, provider, joined_at) VALUES (?, ?, 'agent', ?, '', ?, ?)")
        .run(memberId, String(pair.room_id), label, cleanProvider, at)
      member = memberRow(handle, memberId)
    } else {
      handle.prepare('UPDATE room_members SET provider = ? WHERE id = ?').run(cleanProvider, existing.id)
      member = memberRow(handle, existing.id)
    }

    // 接管或重配：同一成员旧的令牌一律作废，避免「换机器后两个分身同时说话」
    handle.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(at, member.id)
    const token = newToken()
    const tokenId = id('tk_')
    handle
      .prepare('INSERT INTO agent_tokens (id, room_id, member_id, user_id, token_hash, prefix, provider, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(tokenId, String(pair.room_id), member.id, String(pair.user_id), token.hash, token.prefix, cleanProvider, at, at)
    handle.prepare('UPDATE pair_codes SET used_count = used_count + 1 WHERE code = ?').run(normalized)
    handle.exec('COMMIT')

    return {
      token: token.raw,
      tokenId,
      member: { ...publicMemberOf(member), provider: cleanProvider },
      room: { id: room.id, name: room.name },
      reclaim: Boolean(existing),
    }
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
}

function bearerOf(req) {
  const header = String((req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '')
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

/** 从请求里取令牌原文（MCP 与 /api/agent/* 都走这一条）。 */
export function tokenFromRequest(req) {
  return bearerOf(req) || String((req && req.headers && req.headers['x-vqc-token']) || '').trim()
}

const seenWrites = new Map()

/**
 * 认证：查哈希 → 令牌没撤销 → 成员还在 → 房间没解散。
 * 任何一步不成立都按 401 处理：不告诉调用方「是码错了还是成员被移了」。
 */
export function authenticate(rawToken) {
  const raw = String(rawToken || '').trim()
  if (!raw || !raw.startsWith(AGENT_LIMITS.tokenPrefix)) {
    throw httpError(401, 'TOKEN_REQUIRED', '需要一个 vqc_ 开头的智能体令牌')
  }
  const handle = db()
  const row = handle.prepare('SELECT * FROM agent_tokens WHERE token_hash = ?').get(hashToken(raw))
  if (!row || row.revoked_at) throw httpError(401, 'TOKEN_INVALID', '令牌无效或已撤销，请让主人在房间里重新接入')
  const member = memberRow(handle, row.member_id)
  if (!member || member.removed_at) throw httpError(401, 'TOKEN_INVALID', '这个成员已经不在房间里了')
  const room = roomRow(handle, row.room_id)
  if (!room || room.dissolved_at) throw httpError(401, 'TOKEN_INVALID', '房间已经不在了')
  const at = now()
  // 每 30 秒最多回写一次「最后在线」：长轮询 25 秒一轮，不能每一轮都写盘
  const last = seenWrites.get(row.id) || 0
  if (at - last > 30000) {
    seenWrites.set(row.id, at)
    try {
      handle.prepare('UPDATE agent_tokens SET last_seen_at = ? WHERE id = ?').run(at, row.id)
    } catch {
      /* 在线时间写不进去不影响这一轮 */
    }
  }
  return { token: row, member, room }
}

export function publicTokenState(row) {
  return {
    id: row.id,
    prefix: row.prefix,
    provider: row.provider || '',
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at || 0),
    connected: !row.revoked_at,
  }
}

/** 房间成员列表要显示「谁接进来了、最后一次见到是什么时候」。 */
export function tokenStateForRoom(roomId) {
  const handle = db()
  const rows = handle
    .prepare('SELECT * FROM agent_tokens WHERE room_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
    .all(String(roomId))
  const map = new Map()
  for (const row of rows) {
    const current = map.get(row.member_id)
    if (!current || Number(row.last_seen_at || 0) > Number(current.lastSeenAt || 0)) {
      map.set(row.member_id, { connected: true, lastSeenAt: Number(row.last_seen_at || 0), prefix: row.prefix, provider: row.provider || '' })
    }
  }
  return map
}

export function tokensForMember(memberId) {
  const handle = db()
  return handle
    .prepare('SELECT * FROM agent_tokens WHERE member_id = ? ORDER BY created_at DESC')
    .all(String(memberId))
    .map(publicTokenState)
}

/** 移出成员 / 解散房间 / 换绑时用：撤销这个成员名下所有活令牌。 */
export function revokeTokensForMember(memberId) {
  const handle = db()
  handle.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(now(), String(memberId))
  return { ok: true }
}

export function revokeTokensForRoom(roomId) {
  const handle = db()
  handle.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL').run(now(), String(roomId))
  handle.prepare('UPDATE pair_codes SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL').run(now(), String(roomId))
  return { ok: true }
}

export function revokeSelf(tokenRow) {
  const handle = db()
  handle.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE id = ?').run(now(), tokenRow.id)
  return { ok: true }
}

// ── 收件箱 ────────────────────────────────────────────────────────────────

function publicMessage(row) {
  let mentions = []
  try {
    const value = JSON.parse(row.mentions_json || '[]')
    if (Array.isArray(value)) mentions = value
  } catch {
    mentions = []
  }
  return {
    id: row.id,
    seq: Number(row.seq),
    senderMemberId: row.sender_member_id || '',
    senderKind: row.sender_kind,
    senderName: row.sender_name,
    body: row.body,
    mentions,
    createdAt: Number(row.created_at),
  }
}

export function roomLastSeq(roomId) {
  const handle = db()
  const row = handle.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM room_messages WHERE room_id = ?').get(String(roomId))
  return Number(row?.m || 0)
}

/**
 * 收件箱：只看得到别人说的话（自己发的不回灌，否则连接器会自问自答）。
 *
 * since **不传** = 第一次来：只回一个游标，不把历史倒给刚接入的智能体（它不该回 50 条旧消息）。
 * since=0 是显式的「从头开始」，会真的把 seq>0 的消息给你——连接器用它处理刚建的空房间。
 */
export function pendingMessages({ roomId, memberId, since = null, limit = AGENT_LIMITS.inboxPage }) {
  const handle = db()
  const size = Math.min(AGENT_LIMITS.inboxPage, Math.max(1, Number(limit) || AGENT_LIMITS.inboxPage))
  const cursor = roomLastSeq(roomId)
  if (since === null || since === undefined || since === '') return { messages: [], cursor, idle: true, firstCall: true }
  const base = Math.max(0, Number(since) || 0)
  const rows = handle
    .prepare('SELECT * FROM room_messages WHERE room_id = ? AND seq > ? AND (sender_member_id IS NULL OR sender_member_id <> ?) ORDER BY seq ASC LIMIT ?')
    .all(String(roomId), base, String(memberId), size)
  return { messages: rows.map(publicMessage), cursor, idle: rows.length === 0, firstCall: false }
}

/** 智能体视角的房间：房间信息 + 成员（含是否在线）+ 最近若干条消息。 */
export function roomView({ roomId, memberId, limit = 20 }) {
  const handle = db()
  const room = roomRow(handle, roomId)
  if (!room) throw httpError(404, 'ROOM_NOT_FOUND', '房间不在了')
  const rows = handle
    .prepare('SELECT * FROM room_members WHERE room_id = ? AND removed_at IS NULL ORDER BY kind DESC, joined_at ASC')
    .all(String(roomId))
  const tokens = tokenStateForRoom(roomId)
  const lastSeq = roomLastSeq(roomId)
  const read = handle.prepare('SELECT last_seq FROM room_reads WHERE room_id = ? AND member_id = ?').get(String(roomId), String(memberId))
  const size = Math.min(AGENT_LIMITS.inboxPage, Math.max(1, Number(limit) || 20))
  const messages = handle
    .prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?')
    .all(String(roomId), size)
    .reverse()
    .map(publicMessage)
  return {
    room: {
      id: room.id,
      name: room.name,
      topic: room.topic || '',
      approvalMode: room.approval_mode,
      createdAt: Number(room.created_at),
    },
    members: rows.map((row) => {
      const state = tokens.get(row.id) || null
      return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        role: row.role || '',
        provider: row.provider || '',
        connected: Boolean(state && state.connected),
        lastSeenAt: state ? Number(state.lastSeenAt || 0) : 0,
        isMe: row.id === memberId,
      }
    }),
    lastSeq,
    lastReadSeq: Number(read?.last_seq || 0),
    messages,
  }
}

export function markInboxSeen(tokenId) {
  const handle = db()
  try {
    handle.prepare('UPDATE agent_tokens SET last_inbox_at = ? WHERE id = ?').run(now(), tokenId)
  } catch {
    /* 只是统计口径 */
  }
}

