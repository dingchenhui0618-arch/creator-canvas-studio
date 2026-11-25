// VisionChat 房间接口（r315，一期 1a：房间骨架 + 消息 + SSE）。
//
// 鉴权口径与 /api/chat 一致：先 currentUser，不是成员一律 403、房间不在 404。
// 这里没有「智能体专用接口」——1a 只有人的消息；智能体的令牌与工具在 1b/1c 才进来。
import { readBody, sendJson } from './_shared.mjs'
import { currentUser, clientIp } from '../auth.mjs'
import { listAgents } from '../agents.mjs'
import {
  ROOM_LIMITS,
  addAgentMember,
  appendMessage,
  createRoom,
  dissolveRoom,
  getRoom,
  listMessages,
  listRooms,
  markRead,
  removeMember,
  requireRoom,
  subscribeRoom,
  updateRoom,
} from '../rooms.mjs'

const PREFIX = '/api/rooms'
const ROOM_ONE = /^\/api\/rooms\/([A-Za-z0-9_]{6,40})$/
const ROOM_SUB = /^\/api\/rooms\/([A-Za-z0-9_]{6,40})\/(messages|stream|read|members)$/
const ROOM_MEMBER = /^\/api\/rooms\/([A-Za-z0-9_]{6,40})\/members\/([A-Za-z0-9_]{6,40})$/

// 一个账号最多 2 条 SSE：多标签页够用，再多只是拿内存换「不刷新」。
const streams = new Map()

function fail(res, error) {
  const status = Number(error?.status) || 500
  const code = error?.code || 'ROOM_ERROR'
  const message = status >= 500 ? '房间服务出了点问题，稍后再试' : String(error?.message || '请求没成功')
  sendJson(res, status, { ok: false, code, error: message })
}

function guard(res, user) {
  if (user) return true
  sendJson(res, 401, { ok: false, code: 'LOGIN_REQUIRED', error: '请先登录' })
  return false
}

export function createRoomsRouter() {
  return {
    prefix: PREFIX,
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith(PREFIX)) return false
      const user = currentUser(req)
      if (!guard(res, user)) return true

      try {
        // ── 列表与新建 ────────────────────────────────────────────────────
        if (pathname === '/api/rooms' || pathname === '/api/rooms/') {
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, items: listRooms(user.id), limits: ROOM_LIMITS })
            return true
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            const room = createRoom({ userId: user.id, name: body?.name, topic: body?.topic || '', rules: body?.rules || null, memberName: user.name || user.email || '我' })
            sendJson(res, 201, { ok: true, room })
            return true
          }
          sendJson(res, 405, { ok: false, code: 'ROOM_METHOD', error: '这个接口不支持 ' + req.method })
          return true
        }

        // ── 单个成员（先匹配，避免被下面的通用规则吃掉） ───────────────────
        const memberMatched = pathname.match(ROOM_MEMBER)
        if (memberMatched) {
          if (req.method !== 'DELETE') {
            sendJson(res, 405, { ok: false, code: 'ROOM_METHOD', error: '这个接口不支持 ' + req.method })
            return true
          }
          removeMember({ roomId: memberMatched[1], userId: user.id, memberId: memberMatched[2] })
          sendJson(res, 200, { ok: true, room: getRoom(memberMatched[1], user.id) })
          return true
        }

        // ── 房间下的四类子路径 ────────────────────────────────────────────
        const sub = pathname.match(ROOM_SUB)
        if (sub) {
          const roomId = sub[1]
          const action = sub[2]
          if (action === 'messages') {
            if (req.method === 'GET') {
              const since = Number(url.searchParams.get('since') || 0)
              const before = Number(url.searchParams.get('before') || 0)
              const limit = Number(url.searchParams.get('limit') || ROOM_LIMITS.pageSize)
              const page = listMessages({ roomId, userId: user.id, since, before, limit })
              sendJson(res, 200, { ok: true, ...page })
              return true
            }
            if (req.method === 'POST') {
              const body = await readBody(req)
              const result = appendMessage({
                roomId,
                userId: user.id,
                body: body?.body,
                mentions: body?.mentions,
                replyTo: body?.replyTo,
                clientId: body?.clientId,
              })
              sendJson(res, result.duplicated ? 200 : 201, { ok: true, ...result })
              return true
            }
            sendJson(res, 405, { ok: false, code: 'ROOM_METHOD', error: '这个接口不支持 ' + req.method })
            return true
          }
          if (action === 'read') {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, code: 'ROOM_METHOD', error: '这个接口不支持 ' + req.method })
              return true
            }
            const body = await readBody(req)
            const result = markRead({ roomId, userId: user.id, seq: body?.seq })
            sendJson(res, 200, { ok: true, ...result })
            return true
          }
          if (action === 'members') {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, code: 'ROOM_METHOD', error: '这个接口不支持 ' + req.method })
              return true
            }
            const body = await readBody(req)
            // 先判房主再看智能体：不是房主就不该知道「这个 agentId 存不存在」
            const { room } = requireRoom(roomId, user.id)
            if (room.owner_id !== user.id) {
              sendJson(res, 403, { ok: false, code: 'ROOM_OWNER', error: '只有房主能往房间里加智能体' })
              return true
            }
            const agentId = String(body?.agentId || '').trim()
            if (!agentId) {
              sendJson(res, 400, { ok: false, code: 'ROOM_AGENT', error: '要选一个智能体' })
              return true
            }
            // 只能加自己看得见的智能体：listAgents 已经按归属过滤过
            const mine = await listAgents({}, user)
            const agent = mine.find((item) => item.id === agentId)
            if (!agent) {
              sendJson(res, 404, { ok: false, code: 'AGENT_NOT_FOUND', error: '这个智能体不在你的列表里' })
              return true
            }
            addAgentMember({ roomId, userId: user.id, agent })
            sendJson(res, 200, { ok: true, room: getRoom(roomId, user.id) })
            return true
          }
          if (action === 'stream') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, code: 'ROOM_METHOD', error: '这个接口不支持 ' + req.method })
              return true
            }
            return openStream({ req, res, url, user, roomId })
          }
        }

        // ── 房间本身 ──────────────────────────────────────────────────────
        const one = pathname.match(ROOM_ONE)
        if (one) {
          const roomId = one[1]
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, room: getRoom(roomId, user.id) })
            return true
          }
          if (req.method === 'PATCH') {
            const body = await readBody(req)
            const room = updateRoom({ roomId, userId: user.id, patch: body || {} })
            sendJson(res, 200, { ok: true, room })
            return true
          }
          if (req.method === 'DELETE') {
            dissolveRoom({ roomId, userId: user.id })
            sendJson(res, 200, { ok: true })
            return true
          }
          sendJson(res, 405, { ok: false, code: 'ROOM_METHOD', error: '这个接口不支持 ' + req.method })
          return true
        }

        sendJson(res, 404, { ok: false, code: 'ROOM_NOT_FOUND', error: '没有这个房间' })
        return true
      } catch (error) {
        if (error?.status) {
          fail(res, error)
          return true
        }
        // 读请求体超限之类：与其它路由一样交给上层统一兜底
        throw error
      }
    },
  }
}

// SSE：先补洞（?since=），再收活消息；15 秒一次心跳穿过 nginx 的 300 秒空闲超时。
function openStream({ req, res, url, user, roomId }) {
  // 成员校验走同一条：不是成员不许订阅，否则等于隔着一根长连接读别人的房间。
  requireRoom(roomId, user.id)
  const current = streams.get(user.id) || 0
  if (current >= ROOM_LIMITS.connections) {
    sendJson(res, 429, { ok: false, code: 'ROOM_STREAM_LIMIT', error: '最多同时开 ' + ROOM_LIMITS.connections + ' 个房间窗口，关掉一个再试' })
    return true
  }
  streams.set(user.id, current + 1)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 3000\n\n')
  // ready 里带真实的最大 seq：客户端用它校验「我手里的历史是不是最新的」
  const lastSeq = getRoom(roomId, user.id).lastSeq
  write(res, 'ready', { roomId, lastSeq, ip: clientIp(req) })

  const since = Number(url.searchParams.get('since') || 0)
  if (since > 0) {
    const page = listMessages({ roomId, userId: user.id, since, limit: ROOM_LIMITS.maxPage })
    for (const message of page.items) write(res, 'message', message)
  }

  const unsubscribe = subscribeRoom(roomId, (event) => {
    if (event.type === 'message') write(res, 'message', event.message)
  })
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      /* 下面 close 会收尾 */
    }
  }, 15000)
  // 心跳不能把进程钉住：测试和优雅退出都靠这一句
  heartbeat.unref?.()

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    const left = (streams.get(user.id) || 1) - 1
    if (left > 0) streams.set(user.id, left)
    else streams.delete(user.id)
  }
  req.on('close', cleanup)
  req.on('aborted', cleanup)
  // 有的宿主（测试里的假 res）没有事件接口：有才挂，没挂也不影响补洞与订阅
  res.on?.('close', cleanup)
  return true
}

function write(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
  } catch {
    /* 客户端已经断开：清理交给 close 事件 */
  }
}
