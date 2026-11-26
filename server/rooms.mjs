// VisionChat 房间的存储层（r315，一期 1a）。
//
// 为什么不复用 chat-store：快捷创作是「一个账号一个目录、一条会话一个文件」，
// 房间需要连续 seq、成员外键、未读游标与分页查询，文件形做不到原子追加。
// 表落在已有的 auth.db 里（server/auth.mjs 的 openDb），跟账号、积分共用同一个
// 进程与同一个备份口径，不新增第二个数据库文件。
import crypto from 'node:crypto'
import { openDb } from './auth.mjs'
// 反向依赖：移出成员/解散房间要撤销令牌，成员列表要显示「谁接进来了」。
// agent-access 只在调用期读 ROOM_LIMITS，加载期不读，所以这个环是安全的。
import { revokeTokensForMember, revokeTokensForRoom, tokenStateForRoom } from './agent-access.mjs'

// 写死的上限：房间名 40 字、一条消息 8000 字、一人最多 20 个房间、一个房间最多 12 个智能体成员。
// 数字都取「正常用不到、脚本会先撞上」的位置，不另开配置项。
export const ROOM_LIMITS = {
  name: 40,
  topic: 200,
  message: 8000,
  roomsPerUser: 20,
  agentsPerRoom: 12,
  pageSize: 100,
  maxPage: 200,
  connections: 2,
}

const DEFAULT_RULES = { mentionReply: true, allSpeakers: false, maxSpeakers: 2, maxDepth: 1 }

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
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL,
      rules_json TEXT NOT NULL DEFAULT '{}',
      approval_mode TEXT NOT NULL DEFAULT 'readonly',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      dissolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS room_members (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      user_id TEXT,
      agent_id TEXT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      token_id TEXT,
      joined_at INTEGER NOT NULL,
      removed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS room_messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      sender_member_id TEXT,
      sender_kind TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions_json TEXT NOT NULL DEFAULT '[]',
      reply_to TEXT,
      state TEXT NOT NULL DEFAULT 'ok',
      client_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_reads (
      room_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, member_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_seq ON room_messages(room_id, seq);
    CREATE INDEX IF NOT EXISTS idx_room_messages_recent ON room_messages(room_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id, removed_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_agent ON room_members(room_id, agent_id) WHERE agent_id IS NOT NULL AND removed_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_user ON room_members(room_id, user_id) WHERE user_id IS NOT NULL AND removed_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_client ON room_messages(room_id, client_id) WHERE client_id IS NOT NULL;
  `)
}

const now = () => Date.now()
const id = (prefix) => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 16)

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

export function roomError(status, code, message) {
  return httpError(status, code, message)
}

function clipped(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max)
}

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

function normalizeRules(input) {
  const rules = { ...DEFAULT_RULES, ...(input && typeof input === 'object' ? input : {}) }
  return {
    mentionReply: rules.mentionReply !== false,
    allSpeakers: rules.allSpeakers === true,
    // 一轮最多引出几个智能体回合：默认 2，区间 1–4，因为每个回合都是真扣费
    maxSpeakers: Math.min(4, Math.max(1, Number(rules.maxSpeakers) || DEFAULT_RULES.maxSpeakers)),
    maxDepth: Math.min(2, Math.max(1, Number(rules.maxDepth) || DEFAULT_RULES.maxDepth)),
  }
}

const APPROVAL_MODES = ['readonly', 'approve']

function publicMember(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    role: row.role || '',
    provider: row.provider || '',
    agentId: row.agent_id || '',
    userId: row.user_id || '',
    joinedAt: Number(row.joined_at),
  }
}

// 成员 + 接入状态：connected / lastSeenAt / tokenPrefix（平台智能体没有令牌，全空）
function withToken(row, tokens) {
  const state = tokens.get(row.id) || null
  return {
    ...publicMember(row),
    connected: Boolean(state && state.connected),
    lastSeenAt: state ? Number(state.lastSeenAt || 0) : 0,
    tokenPrefix: state ? state.prefix : '',
    provider: row.provider || (state ? state.provider : '') || '',
  }
}

function publicMessage(row) {
  return {
    id: row.id,
    seq: Number(row.seq),
    senderMemberId: row.sender_member_id || '',
    senderKind: row.sender_kind,
    senderName: row.sender_name,
    body: row.body,
    mentions: parseJson(row.mentions_json, []),
    replyTo: row.reply_to || '',
    state: row.state,
    createdAt: Number(row.created_at),
  }
}

// 每个房间的错误说法都一样：没登录 401 在路由层，不是成员 403，房间不在 404。
function roomRow(handle, roomId) {
  return handle.prepare('SELECT * FROM rooms WHERE id = ?').get(String(roomId)) || null
}

function humanMember(handle, roomId, userId) {
  return handle
    .prepare("SELECT * FROM room_members WHERE room_id = ? AND kind = 'human' AND user_id = ? AND removed_at IS NULL")
    .get(String(roomId), String(userId)) || null
}

/** 取房间并校验成员身份。不是成员一律 403，房间不在 404。 */
export function requireRoom(roomId, userId) {
  const handle = db()
  const room = roomRow(handle, roomId)
  if (!room || room.dissolved_at) throw httpError(404, 'ROOM_NOT_FOUND', '这个房间不在了')
  const member = humanMember(handle, roomId, userId)
  if (!member) throw httpError(403, 'ROOM_FORBIDDEN', '你不在这个房间里')
  return { room, member }
}

function memberCount(handle, roomId) {
  const row = handle
    .prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND kind = ? AND removed_at IS NULL')
    .get(String(roomId), 'agent')
  return Number(row?.n || 0)
}

export function listRooms(userId) {
  const handle = db()
  const rows = handle
    .prepare(
      `SELECT r.*, m.id AS member_id, COALESCE(rd.last_seq, 0) AS last_seq,
        (SELECT COUNT(*) FROM room_messages x
           WHERE x.room_id = r.id AND x.seq > COALESCE(rd.last_seq, 0) AND x.sender_member_id <> m.id) AS unread,
        (SELECT body FROM room_messages y WHERE y.room_id = r.id ORDER BY y.seq DESC LIMIT 1) AS last_body,
        (SELECT sender_name FROM room_messages z WHERE z.room_id = r.id ORDER BY z.seq DESC LIMIT 1) AS last_sender,
        (SELECT created_at FROM room_messages w WHERE w.room_id = r.id ORDER BY w.seq DESC LIMIT 1) AS last_at,
        (SELECT MAX(seq) FROM room_messages v WHERE v.room_id = r.id) AS last_seq_total
       FROM rooms r
       JOIN room_members m ON m.room_id = r.id AND m.kind = 'human' AND m.user_id = ? AND m.removed_at IS NULL
       LEFT JOIN room_reads rd ON rd.room_id = r.id AND rd.member_id = m.id
       WHERE r.dissolved_at IS NULL
       ORDER BY COALESCE(last_at, r.created_at) DESC`,
    )
    .all(String(userId))
  return rows.map((row) => {
    const lastAt = Number(row.last_at || 0)
    return {
      id: row.id,
      name: row.name,
      topic: row.topic || '',
      ownerId: row.owner_id,
      rules: normalizeRules(parseJson(row.rules_json, {})),
      approvalMode: row.approval_mode,
      memberId: row.member_id,
      unread: Number(row.unread || 0),
      lastSeq: Number(row.last_seq_total || 0),
      preview: row.last_body ? String(row.last_body).slice(0, 120) : '',
      previewFrom: row.last_sender || '',
      lastAt: lastAt || Number(row.created_at),
      createdAt: Number(row.created_at),
      isOwner: row.owner_id === userId,
    }
  })
}

export function createRoom({ userId, name, topic = '', rules = null, memberName = '' }) {
  const handle = db()
  const count = handle
    .prepare("SELECT COUNT(*) AS n FROM rooms r JOIN room_members m ON m.room_id = r.id AND m.kind = 'human' AND m.user_id = ? AND m.removed_at IS NULL WHERE r.dissolved_at IS NULL")
    .get(String(userId))
  if (Number(count?.n || 0) >= ROOM_LIMITS.roomsPerUser) {
    throw httpError(400, 'ROOM_LIMIT', '最多 ' + ROOM_LIMITS.roomsPerUser + ' 个房间，先解散一个不用的')
  }
  const label = clipped(name, ROOM_LIMITS.name)
  if (!label) throw httpError(400, 'ROOM_NAME', '给房间起个名字')
  const roomId = id('rm_')
  const memberId = id('mb_')
  const at = now()
  handle.exec('BEGIN IMMEDIATE')
  try {
    handle
      .prepare('INSERT INTO rooms (id, name, topic, owner_id, rules_json, approval_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(roomId, label, clipped(topic, ROOM_LIMITS.topic), String(userId), JSON.stringify(normalizeRules(rules)), 'readonly', at, at)
    handle
      .prepare("INSERT INTO room_members (id, room_id, kind, user_id, name, role, provider, joined_at) VALUES (?, ?, 'human', ?, ?, ?, '', ?)")
      // 成员名是「人」的名字，不是房间名：建房时如果没传就退回房间名（老调用点不至于报错）
      .run(memberId, roomId, String(userId), clipped(memberName || name, ROOM_LIMITS.name), '房主', at)
    handle.exec('COMMIT')
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
  return getRoom(roomId, userId)
}

export function getRoom(roomId, userId) {
  const handle = db()
  const { room } = requireRoom(roomId, userId)
  const members = handle
    .prepare('SELECT * FROM room_members WHERE room_id = ? AND removed_at IS NULL ORDER BY kind DESC, joined_at ASC')
    .all(String(roomId))
  const myMember = humanMember(handle, roomId, userId)
  const read = handle.prepare('SELECT last_seq FROM room_reads WHERE room_id = ? AND member_id = ?').get(String(roomId), myMember.id)
  const stats = handle
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS last FROM room_messages WHERE room_id = ?')
    .get(String(roomId))
  // 「接入状态」跟着令牌走：没有活令牌的成员是平台智能体或已被撤销的连接器
  const tokens = tokenStateForRoom(roomId)
  return {
    id: room.id,
    name: room.name,
    topic: room.topic || '',
    ownerId: room.owner_id,
    rules: normalizeRules(parseJson(room.rules_json, {})),
    approvalMode: room.approval_mode,
    createdAt: Number(room.created_at),
    isOwner: room.owner_id === userId,
    memberId: myMember.id,
    lastReadSeq: Number(read?.last_seq || 0),
    lastSeq: Number(stats?.last || 0),
    messageCount: Number(stats?.n || 0),
    agents: members.filter((row) => row.kind === 'agent').map((row) => withToken(row, tokens)),
    members: members.map((row) => (row.kind === 'agent' ? withToken(row, tokens) : publicMember(row))),
  }
}

export function updateRoom({ roomId, userId, patch = {} }) {
  const handle = db()
  const { room } = requireRoom(roomId, userId)
  if (room.owner_id !== userId) throw httpError(403, 'ROOM_OWNER', '只有房主能改房间设置')
  const fields = []
  const values = []
  if (patch.name !== undefined) {
    const label = clipped(patch.name, ROOM_LIMITS.name)
    if (!label) throw httpError(400, 'ROOM_NAME', '房间名不能是空的')
    fields.push('name = ?')
    values.push(label)
  }
  if (patch.topic !== undefined) {
    fields.push('topic = ?')
    values.push(clipped(patch.topic, ROOM_LIMITS.topic))
  }
  if (patch.rules !== undefined) {
    fields.push('rules_json = ?')
    values.push(JSON.stringify(normalizeRules(patch.rules)))
  }
  if (patch.approvalMode !== undefined) {
    if (!APPROVAL_MODES.includes(patch.approvalMode)) {
      throw httpError(400, 'ROOM_MODE', '只支持 readonly 与 approve 两种授权档位')
    }
    fields.push('approval_mode = ?')
    values.push(patch.approvalMode)
  }
  if (!fields.length) return getRoom(roomId, userId)
  fields.push('updated_at = ?')
  values.push(now(), String(roomId))
  handle.prepare('UPDATE rooms SET ' + fields.join(', ') + ' WHERE id = ?').run(...values)
  return getRoom(roomId, userId)
}

export function dissolveRoom({ roomId, userId }) {
  const handle = db()
  const { room } = requireRoom(roomId, userId)
  if (room.owner_id !== userId) throw httpError(403, 'ROOM_OWNER', '只有房主能解散房间')
  // 墓碑：不物理删，历史与审计都还在，列表不再返回
  handle.prepare('UPDATE rooms SET dissolved_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), String(roomId))
  // 解散就把这间房子的钥匙全部作废，不留「房间没了但令牌还能读」的缝
  revokeTokensForRoom(roomId)
  return { ok: true }
}

export function addAgentMember({ roomId, userId, agent }) {
  const handle = db()
  const { room } = requireRoom(roomId, userId)
  if (room.owner_id !== userId) throw httpError(403, 'ROOM_OWNER', '只有房主能往房间里加智能体')
  if (memberCount(handle, roomId) >= ROOM_LIMITS.agentsPerRoom) {
    throw httpError(400, 'ROOM_MEMBERS', '一个房间最多 ' + ROOM_LIMITS.agentsPerRoom + ' 个智能体')
  }
  const existing = handle
    .prepare('SELECT * FROM room_members WHERE room_id = ? AND agent_id = ? AND removed_at IS NULL')
    .get(String(roomId), String(agent.id))
  if (existing) return publicMember(existing)
  const memberId = id('mb_')
  handle
    .prepare("INSERT INTO room_members (id, room_id, kind, agent_id, name, role, provider, joined_at) VALUES (?, ?, 'agent', ?, ?, ?, ?, ?)")
    .run(memberId, String(roomId), String(agent.id), clipped(agent.name, ROOM_LIMITS.name), clipped(agent.role, 120), 'platform', now())
  return publicMember(handle.prepare('SELECT * FROM room_members WHERE id = ?').get(memberId))
}

export function removeMember({ roomId, userId, memberId }) {
  const handle = db()
  const { room } = requireRoom(roomId, userId)
  if (room.owner_id !== userId) throw httpError(403, 'ROOM_OWNER', '只有房主能移除成员')
  const row = handle.prepare('SELECT * FROM room_members WHERE id = ? AND room_id = ?').get(String(memberId), String(roomId))
  if (!row || row.removed_at) throw httpError(404, 'ROOM_MEMBER', '这个成员不在房间里')
  if (row.kind === 'human' && row.user_id === room.owner_id) throw httpError(400, 'ROOM_MEMBER', '房主不能把自己移出房间')
  handle.prepare('UPDATE room_members SET removed_at = ? WHERE id = ?').run(now(), row.id)
  // 移出成员 = 立刻断掉它的令牌：authenticate 也会看 removed_at，这里是第二道（也顺手清掉钥匙）
  revokeTokensForMember(row.id)
  return { ok: true }
}

/** 消息：since 用于补洞（只取大于它的），before 用于往上翻，两者不同时用。 */
export function listMessages({ roomId, userId, since = 0, before = 0, limit = ROOM_LIMITS.pageSize }) {
  const handle = db()
  const { member } = requireRoom(roomId, userId)
  const size = Math.min(ROOM_LIMITS.maxPage, Math.max(1, Number(limit) || ROOM_LIMITS.pageSize))
  let rows
  if (since > 0) {
    rows = handle
      .prepare('SELECT * FROM room_messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(String(roomId), Number(since), size)
  } else if (before > 0) {
    rows = handle
      .prepare('SELECT * FROM room_messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(String(roomId), Number(before), size)
      .reverse()
  } else {
    rows = handle
      .prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?')
      .all(String(roomId), size)
      .reverse()
  }
  const first = rows.length ? Number(rows[0].seq) : 0
  return {
    items: rows.map(publicMessage),
    memberId: member.id,
    hasMore: first > 1,
    oldestSeq: first,
  }
}

// SSE 订阅表：单进程，进程内广播就够了。
const listeners = new Map()

export function subscribeRoom(roomId, fn) {
  const key = String(roomId)
  if (!listeners.has(key)) listeners.set(key, new Set())
  listeners.get(key).add(fn)
  return () => {
    const set = listeners.get(key)
    if (!set) return
    set.delete(fn)
    if (!set.size) listeners.delete(key)
  }
}

function broadcast(roomId, event) {
  const set = listeners.get(String(roomId))
  if (!set) return
  for (const fn of [...set]) {
    try {
      fn(event)
    } catch {
      /* 一个订阅者写失败不影响别人；它的清理在路由层 */
    }
  }
}

// 人和智能体走同一个插入路径：seq 单点分配、clientId 幂等、@ 只认活成员、
// 写进房间就广播给 SSE 订阅者。senderKind 只影响署名与「自己发的不回灌收件箱」。
function insertMessage({ roomId, room, sender, senderKind, body, mentions = [], replyTo = '', clientId = '' }) {
  const handle = db()
  const text = clipped(body, ROOM_LIMITS.message)
  if (!text) throw httpError(400, 'ROOM_EMPTY', '说点什么再发')
  const cleanClient = clipped(clientId, 64)
  if (cleanClient) {
    const dup = handle.prepare('SELECT * FROM room_messages WHERE room_id = ? AND client_id = ?').get(String(roomId), cleanClient)
    if (dup) return { message: publicMessage(dup), duplicated: true }
  }
  const ids = Array.isArray(mentions) ? mentions.map((value) => String(value)).filter(Boolean).slice(0, 12) : []
  const allowed = ids.length
    ? handle
        .prepare('SELECT id FROM room_members WHERE room_id = ? AND removed_at IS NULL AND id IN (' + ids.map(() => '?').join(', ') + ')')
        .all(String(roomId), ...ids)
        .map((row) => row.id)
    : []
  const at = now()
  const messageId = id('ms_')
  let seq = 0
  handle.exec('BEGIN IMMEDIATE')
  try {
    seq = Number(handle.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM room_messages WHERE room_id = ?').get(String(roomId)).m) + 1
    handle
      .prepare('INSERT INTO room_messages (id, room_id, seq, sender_member_id, sender_kind, sender_name, body, mentions_json, reply_to, state, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(messageId, String(roomId), seq, sender.id, senderKind, sender.name, text, JSON.stringify(allowed), clipped(replyTo, 40), 'ok', cleanClient || null, at)
    handle
      .prepare('INSERT INTO room_reads (room_id, member_id, last_seq) VALUES (?, ?, ?) ON CONFLICT(room_id, member_id) DO UPDATE SET last_seq = excluded.last_seq')
      .run(String(roomId), sender.id, seq)
    handle.exec('COMMIT')
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
  const row = handle.prepare('SELECT * FROM room_messages WHERE id = ?').get(messageId)
  const message = publicMessage(row)
  broadcast(roomId, { type: 'message', message, ownerId: room.owner_id })
  return { message, duplicated: false }
}

/** 人发消息：先验房间成员身份。 */
export function appendMessage({ roomId, userId, body, mentions = [], replyTo = '', clientId = '' }) {
  const { room, member } = requireRoom(roomId, userId)
  return insertMessage({ roomId, room, sender: member, senderKind: 'human', body, mentions, replyTo, clientId })
}

/** 智能体发消息：身份来自 vqc_ 令牌，守卫在 agent-access.authenticate 里已经验过。 */
export function appendMessageAs({ roomId, room, member, senderKind = 'agent', body, mentions = [], replyTo = '', clientId = '' }) {
  return insertMessage({ roomId, room, sender: member, senderKind, body, mentions, replyTo, clientId })
}

export function markReadAs({ roomId, memberId, seq }) {
  const handle = db()
  const target = Math.max(0, Number(seq) || 0)
  handle
    .prepare('INSERT INTO room_reads (room_id, member_id, last_seq) VALUES (?, ?, ?) ON CONFLICT(room_id, member_id) DO UPDATE SET last_seq = MAX(room_reads.last_seq, excluded.last_seq)')
    .run(String(roomId), String(memberId), target)
  return { ok: true, lastSeq: target }
}

export function markRead({ roomId, userId, seq }) {
  const { member } = requireRoom(roomId, userId)
  return markReadAs({ roomId, memberId: member.id, seq })
}
