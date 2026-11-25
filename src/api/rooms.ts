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
  state: 'ok' | 'failed' | 'tool'
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

export const getRoom = (id: string) => request<{ ok: boolean; room: RoomDetail }>('/api/rooms/' + id)

export const updateRoom = (id: string, patch: { name?: string; topic?: string; approvalMode?: ApprovalMode; rules?: Partial<RoomRules> }) =>
  request<{ ok: boolean; room: RoomDetail }>('/api/rooms/' + id, { method: 'PATCH', body: JSON.stringify(patch) })

export const dissolveRoom = (id: string) => request<{ ok: boolean }>('/api/rooms/' + id, { method: 'DELETE' })

export const addRoomAgent = (id: string, agentId: string) =>
  request<{ ok: boolean; room: RoomDetail }>('/api/rooms/' + id + '/members', { method: 'POST', body: JSON.stringify({ agentId }) })

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
