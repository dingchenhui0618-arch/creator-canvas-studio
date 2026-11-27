// VisionChat 房间 API 客户端：与 server/routes/rooms.mjs 一一对应（r315，一期 1a）。
//
// 房间是「登录后的一群人 + 一堆智能体」，所以这里每个函数都要登录态 cookie，
// 不需要额外传 token；SSE 也是一条同源 GET，浏览器自己带 cookie。
import { request } from './client'

export type RoomRules = {
  mentionReply: boolean
  allSpeakers: boolean
  maxSpeakers: number
  maxDepth: number
  /** 平台智能体要不要自动接话（r317）：关掉之后只有被 @ 的才回。 */
  platformReply: boolean
}

/** 平台智能体能用的工具：1c 只开 templates.list，其余登记但关着（见 server/agent-tools.mjs）。 */
export type AgentTool = {
  id: string
  label: string
  mode: 'read' | 'write'
  params: string
  hint: string
  enabled: boolean
  reason: string
}

export type ApprovalMode = 'readonly' | 'approve'

export type RoomMember = {
  id: string
  kind: 'human' | 'agent'
  name: string
  role: string
  provider: string
  agentId: string
  userId: string
  joinedAt: number
  /** 智能体是不是接进来了（有活的 vqc_ 令牌）；平台智能体永远 false */
  connected?: boolean
  lastSeenAt?: number
  tokenPrefix?: string
}

/** 配对码：房主把它交给自己的 AI 助手，对方自己换令牌进房间（r315 1b）。 */
export type RoomPairCode = {
  code: string
  createdAt: number
  expiresAt: number
  used: number
  max: number
}

export type RoomPairLimits = {
  ttlMs: number
  maxUses: number
  length: number
}

export type RoomSummary = {
  id: string
  name: string
  topic: string
  ownerId: string
  rules: RoomRules
  approvalMode: ApprovalMode
  memberId: string
  unread: number
  lastSeq: number
  preview: string
  previewFrom: string
  lastAt: number
  createdAt: number
  isOwner: boolean
}

export type RoomDetail = {
  id: string
  name: string
  topic: string
  ownerId: string
  rules: RoomRules
  approvalMode: ApprovalMode
  createdAt: number
  isOwner: boolean
  memberId: string
  lastReadSeq: number
  lastSeq: number
  messageCount: number
  agents: RoomMember[]
  members: RoomMember[]
  /** GET /api/rooms/:id 单独带出来，不在 room 里面 */
  tools?: AgentTool[]
}

export type RoomMessage = {
  id: string
  seq: number
  senderMemberId: string
  senderKind: 'human' | 'agent' | 'system'
  senderName: string
  body: string
  mentions: string[]
  replyTo: string
  /** error：这一轮没答上来（平台智能体会把原因写在正文里，积分已退回） */
  state: 'ok' | 'failed' | 'tool' | 'error'
  createdAt: number
}

export type RoomLimits = {
  name: number
  topic: number
  message: number
  roomsPerUser: number
  agentsPerRoom: number
  pageSize: number
  maxPage: number
  connections: number
}

export const listRooms = () => request<{ ok: boolean; items: RoomSummary[]; limits: RoomLimits }>('/api/rooms')

export const createRoom = (input: { name: string; topic?: string }) =>
  request<{ ok: boolean; room: RoomDetail }>('/api/rooms', { method: 'POST', body: JSON.stringify(input) })

export const getRoom = (id: string) => request<{ ok: boolean; room: RoomDetail; tools: AgentTool[] }>('/api/rooms/' + id)

export const updateRoom = (id: string, patch: { name?: string; topic?: string; approvalMode?: ApprovalMode; rules?: Partial<RoomRules> }) =>
  request<{ ok: boolean; room: RoomDetail }>('/api/rooms/' + id, { method: 'PATCH', body: JSON.stringify(patch) })

export const dissolveRoom = (id: string) => request<{ ok: boolean }>('/api/rooms/' + id, { method: 'DELETE' })

export const addRoomAgent = (id: string, agentId: string) =>
  request<{ ok: boolean; room: RoomDetail }>('/api/rooms/' + id + '/members', { method: 'POST', body: JSON.stringify({ agentId }) })

/** 接入一个智能体：生成/换取这张房间专属的配对码（24 小时、最多 10 个）。 */
export const createRoomPairCode = (id: string) =>
  request<{ ok: boolean; code: RoomPairCode; pair: RoomPairLimits }>('/api/rooms/' + id + '/pair-code', { method: 'POST' })

/** 已经有一张有效的就把它拿回来（刷新页面不至于丢码）。 */
export const getRoomPairCode = (id: string) =>
  request<{ ok: boolean; code: RoomPairCode | null; pair: RoomPairLimits }>('/api/rooms/' + id + '/pair-code')

export const revokeRoomPairCode = (id: string) =>
  request<{ ok: boolean; code: null; pair: RoomPairLimits }>('/api/rooms/' + id + '/pair-code', { method: 'DELETE' })

export const removeRoomMember = (id: string, memberId: string) =>
  request<{ ok: boolean; room: RoomDetail }>('/api/rooms/' + id + '/members/' + memberId, { method: 'DELETE' })

export function listRoomMessages(id: string, params: { since?: number; before?: number; limit?: number } = {}) {
  const query = new URLSearchParams()
  if (params.since) query.set('since', String(params.since))
  if (params.before) query.set('before', String(params.before))
  if (params.limit) query.set('limit', String(params.limit))
  const suffix = query.toString()
  return request<{ ok: boolean; items: RoomMessage[]; memberId: string; hasMore: boolean; oldestSeq: number }>(
    '/api/rooms/' + id + '/messages' + (suffix ? '?' + suffix : ''),
  )
}

export const sendRoomMessage = (id: string, input: { body: string; mentions?: string[]; replyTo?: string; clientId?: string }) =>
  request<{ ok: boolean; message: RoomMessage; duplicated: boolean }>('/api/rooms/' + id + '/messages', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const markRoomRead = (id: string, seq: number) =>
  request<{ ok: boolean; lastSeq: number }>('/api/rooms/' + id + '/read', { method: 'POST', body: JSON.stringify({ seq }) })

/** SSE 地址：浏览器自带 cookie，重连由 EventSource 按服务端的 retry 自己处理。 */
export const roomStreamUrl = (id: string, since: number) =>
  '/api/rooms/' + id + '/stream' + (since > 0 ? '?since=' + since : '')

/** 一条消息的时间：今天只给时分，昨天加「昨天」，更早给月日。 */
export function roomTimeLabel(ms: number, now = Date.now()): string {
  if (!ms) return ''
  const date = new Date(ms)
  const same = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const clock = pad(date.getHours()) + ':' + pad(date.getMinutes())
  if (date.toDateString() === same.toDateString()) return clock
  const yesterday = new Date(now - 86400000)
  if (date.toDateString() === yesterday.toDateString()) return '昨天 ' + clock
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + clock
}

/** 房间列表右侧那行相对时间：刚发的说「刚刚」，一小时内说几分钟前。 */
export function roomAgoLabel(ms: number, now = Date.now()): string {
  if (!ms) return ''
  const diff = Math.max(0, now - ms)
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
  return roomTimeLabel(ms, now)
}
