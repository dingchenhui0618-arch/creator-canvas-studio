// 智能体接入路由（r315 一期 1b）：配对码换令牌、收件箱长轮询、MCP 端点、接入说明。
//
// 这一组接口**不认 vq_session**，只认 Authorization: Bearer vqc_...：
// 令牌能看自己那个房间、能说话、能读成员；拿不到登录态，也进不了 /api/admin。
// 扣费工具的闸门在 1c/1d：令牌只能「申请」，批准与执行都在有登录态的界面里。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readBody, sendJson } from './_shared.mjs'
import {
  AGENT_LIMITS,
  authenticate,
  markInboxSeen,
  pairWithCode,
  pendingMessages,
  publicTokenState,
  revokeSelf,
  roomView,
  tokenFromRequest,
} from '../agent-access.mjs'
import { ROOM_LIMITS, appendMessageAs, markReadAs, subscribeRoom } from '../rooms.mjs'

const PREFIX = '/api/agent'

// 一个令牌同时最多挂 2 条长轮询：每条会占住一个请求 25 秒，不封顶就等于允许「一条令牌开几百条连接」。
const polls = new Map()
const MAX_POLLS = 2

function holdPoll(tokenId) {
  const current = polls.get(tokenId) || 0
  if (current >= MAX_POLLS) return null
  polls.set(tokenId, current + 1)
  return () => {
    const left = (polls.get(tokenId) || 1) - 1
    if (left > 0) polls.set(tokenId, left)
    else polls.delete(tokenId)
  }
}

const PKG = (() => {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
  } catch {
    return { version: '0.0.0' }
  }
})()

function fail(res, error) {
  const status = Number(error?.status) || 500
  const code = error?.code || 'AGENT_ERROR'
  const message = status >= 500 ? '接入服务出了点问题，稍后再试' : String(error?.message || '请求没成功')
  sendJson(res, status, { ok: false, code, error: message, ...(error?.member ? { member: error.member, reclaim: true } : {}) })
}

function unauthorized(res, message) {
  res.setHeader?.('WWW-Authenticate', 'Bearer realm="visionchat"')
  sendJson(res, 401, { ok: false, code: 'TOKEN_REQUIRED', error: message })
}

// ── 长轮询收件箱 ──────────────────────────────────────────────────────────

function waitMsFrom(url) {
  const raw = url.searchParams.get('wait')
  if (raw === null || raw === '') return AGENT_LIMITS.defaultWaitMs
  const seconds = Number(raw)
  if (!Number.isFinite(seconds)) return AGENT_LIMITS.defaultWaitMs
  return Math.max(0, Math.min(AGENT_LIMITS.maxWaitMs, Math.round(seconds * 1000)))
}

function inboxOnce({ auth, since }) {
  return pendingMessages({ roomId: auth.room.id, memberId: auth.member.id, since })
}

/** 有消息立刻回；没有就挂到 wait 秒，或者等到这个房间来了新消息。 */
async function inboxWithWait({ auth, since, waitMs }) {
  let page = inboxOnce({ auth, since })
  markInboxSeen(auth.token.id)
  if (!page.idle || page.firstCall || waitMs <= 0) return page
  await new Promise((resolve) => {
    let done = false
    let timer = null
    let unsubscribe = null
    const finish = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (unsubscribe) unsubscribe()
      resolve()
    }
    // 这个定时器**不能 unref**：它就是「这一轮请求要等满 wait 秒」本身。
    // unref 掉之后，当进程里没有别的引用（例如自检脚本里没有监听端口）时，
    // 事件循环会先结束，等长轮询的 Promise 永远不 resolve（CI 上真实踩过）。
    timer = setTimeout(finish, waitMs)
    unsubscribe = subscribeRoom(auth.room.id, (event) => {
      if (event.type !== 'message') return
      const message = event.message
      if (since !== null && Number(message.seq) <= since) return
      // 自己发的句子不该叫醒自己（连接器会自问自答）
      if (message.senderMemberId === auth.member.id) return
      finish()
    })
  })
  page = inboxOnce({ auth, since })
  return page
}

// ── MCP（Streamable HTTP，无状态）──────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: 'visionchat_inbox',
    description: '读这个房间的新消息。since 传自己记住的游标；没有新消息时最多等 waitSeconds 秒再回。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: '上一轮返回的 cursor，第一次调用传 0' },
        waitSeconds: { type: 'integer', description: '没消息时最长等几秒（0–25，默认 25）' },
      },
    },
  },
  {
    name: 'visionchat_send',
    description: '在房间里说一句话。说的话会立刻出现在主人的聊天室窗口里。',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: '要说的内容（纯文本，最多 8000 字）' },
        mentions: { type: 'array', items: { type: 'string' }, description: '要 @ 的成员 id（可选）' },
        clientId: { type: 'string', description: '自己的幂等键（可选，重发同一个键不会落两条）' },
      },
      required: ['body'],
    },
  },
  {
    name: 'visionchat_room',
    description: '看这个房间长什么样：名字、成员、最近若干条消息。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '带几条最近消息（1–50，默认 20）' } },
    },
  },
]

function mcpText(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] }
}

function callTool({ auth, name, args }) {
  if (name === 'visionchat_inbox') {
    const since = args?.since === undefined || args?.since === null ? null : Number(args.since)
    const waitMs = args?.waitSeconds === undefined
      ? 0
      : Math.max(0, Math.min(AGENT_LIMITS.maxWaitMs, Math.round(Number(args.waitSeconds) * 1000) || 0))
    // MCP 的读也要遵守「没有就回更快」：工具调用自带超时，默认不等，显式给 waitSeconds 才等
    return inboxWithWait({ auth, since, waitMs }).then(mcpText)
  }
  if (name === 'visionchat_send') {
    const result = appendMessageAs({
      roomId: auth.room.id,
      room: auth.room,
      member: auth.member,
      senderKind: 'agent',
      body: args?.body,
      mentions: Array.isArray(args?.mentions) ? args.mentions : [],
      clientId: args?.clientId || '',
    })
    return mcpText({ ok: true, seq: result.message.seq, duplicated: result.duplicated })
  }
  if (name === 'visionchat_room') {
    return mcpText(roomView({ roomId: auth.room.id, memberId: auth.member.id, limit: args?.limit || 20 }))
  }
  return { content: [{ type: 'text', text: '没有这个工具：' + name }], isError: true }
}

async function handleMcp({ req, res }) {
  if (req.method !== 'POST') {
    res.setHeader?.('Allow', 'POST')
    sendJson(res, 405, { ok: false, code: 'MCP_METHOD', error: 'MCP 端点只接受 POST' })
    return true
  }
  const raw = tokenFromRequest(req)
  if (!raw) {
    unauthorized(res, '需要一个 vqc_ 开头的智能体令牌：Authorization: Bearer vqc_...')
    return true
  }
  let auth
  try {
    auth = authenticate(raw)
  } catch (error) {
    fail(res, error)
    return true
  }
  const body = await readBody(req)
  const id = body?.id ?? null
  const method = String(body?.method || '')
  const params = body?.params || {}
  if (!method) {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } })
    return true
  }
  // 通知没有 id，也没有响应体（规范要求 202）
  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'Content-Type': 'application/json' })
    res.end()
    return true
  }
  try {
    if (method === 'initialize') {
      const requested = String(params?.protocolVersion || '2025-06-18')
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: 'visionchat', version: PKG.version },
        },
      })
      return true
    }
    if (method === 'ping') {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: {} })
      return true
    }
    if (method === 'tools/list') {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } })
      return true
    }
    if (method === 'tools/call') {
      const result = await callTool({ auth, name: String(params?.name || ''), args: params?.arguments || {} })
      sendJson(res, 200, { jsonrpc: '2.0', id, result })
      return true
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: '没有这个方法：' + method } })
    return true
  } catch (error) {
    if (error?.status) {
      // 工具层的业务错误按 MCP 习惯放在 result 里，客户端才看得懂人话
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(error.message || '失败') }], isError: true } })
      return true
    }
    throw error
  }
}

// ── 接入说明（给 agent 自己读的 /visionchat.md）────────────────────────────

function guideMarkdown(base) {
  const fence = '`' + '`' + '`'
  return [
    '# VisionChat 接入说明',
    '',
    '你正在接入 VisionQA 的「聊天室」。房间归你的主人所有；你进去之后能读这个房间的消息、能说话，',
    '但**不能**替主人花积分（生图/生视频/评审只能「申请」，由主人点允许）。',
    '',
    '## 一、用配对码换一个令牌',
    '',
    '主人在聊天室右栏点「接入我的智能体」，会得到 8 位配对码（形如 7KQ2-LMZ9，24 小时有效）。',
    '然后：',
    '',
    fence + 'bash',
    'curl -s -X POST ' + base + '/api/agent/pair \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"code":"7KQ2-LMZ9","name":"我的 codex","provider":"codex"}\'',
    fence,
    '',
    '返回里的 token（vqc_ 开头）**只返回这一次**。把它存到本机权限 0600 的文件里，',
    '不要打印、不要贴群、不要写进 URL、不要提交到仓库。',
    '',
    '同名再接入会回 member_exists：确认是换机器就带 "reclaim": true 重新拿令牌，旧令牌会立刻失效。',
    '',
    '## 二、两个可用的入口（二选一，也可以都用）',
    '',
    '1. **MCP**（Claude Code / Codex / Cursor 一行接上）：',
    '',
    fence + 'bash',
    'claude mcp add --transport http visionchat ' + base + '/mcp \\',
    '  --header "Authorization: Bearer $VQC_TOKEN"',
    fence,
    '',
    '   三个工具：visionchat_inbox（读新消息，可长等）、visionchat_send（说话）、visionchat_room（看房间）。',
    '',
    '2. **HTTP 轮询**（任何语言都能接）：',
    '',
    fence + 'bash',
    'curl -s "' + base + '/api/agent/inbox?since=0&wait=25" -H "Authorization: Bearer $VQC_TOKEN"',
    'curl -s -X POST "' + base + '/api/agent/messages" -H "Authorization: Bearer $VQC_TOKEN" \\',
    '  -H "Content-Type: application/json" -d \'{"body":"收到，我先看一遍素材"}\'',
    fence,
    '',
    'since 用上一轮返回的 cursor；since=0 只回游标，不会把历史倒给你（免得你去回几十条旧消息）。',
    '',
    '## 三、连接器（可选，想要「被叫到就秒回」再装）',
    '',
    '在主人的电脑上跑仓库里的 scripts/visionchat-connect.mjs：它用同一个令牌长轮询，收到消息就交给',
    '本机的 codex exec / claude -p 执行，再把结果回传。平台不会把任何命令下到你的机器上。',
    '',
    '## 四、边界',
    '',
    '- 令牌只对**这一个房间、这一个成员**有效；被移出房间或主人撤销后立刻失效（401）。',
    '- 令牌不是登录态：拿不到主人账号、进不了后台、读不了别的房间。',
    '- 房间最多 ' + ROOM_LIMITS.agentsPerRoom + ' 个智能体成员；每个房间同时只该有一个待处理回合。',
    '- 说人话，别复述提示词；不确定的事说不确定。',
    '',
  ].join('\n')
}

// ── 路由 ──────────────────────────────────────────────────────────────────

export function createAgentRouter() {
  return {
    prefix: PREFIX,
    extraPrefixes: ['/mcp', '/visionchat.md'],
    async handle(req, res, url, pathname) {
      const isMcp = pathname === '/mcp'
      const isGuide = pathname === '/visionchat.md'
      if (!isMcp && !isGuide && !(pathname === PREFIX || pathname.startsWith(PREFIX + '/'))) return false

      if (isGuide) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, code: 'GUIDE_METHOD', error: '只接受 GET' })
          return true
        }
        const host = String(req.headers?.host || 'visionqa.wavisionai.cn')
        const local = host.split(':')[0] === '127.0.0.1' || host.startsWith('localhost')
        const base = (local ? 'http://' : 'https://') + host
        const text = guideMarkdown(base)
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : text)
        return true
      }

      if (isMcp) return handleMcp({ req, res })

      try {
        // 配对：没有令牌，靠码；限流在 ratelimit.mjs 里按 IP 拦
        if (pathname === '/api/agent/pair') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'AGENT_METHOD', error: '只接受 POST' })
            return true
          }
          const body = await readBody(req)
          const result = pairWithCode({
            code: body?.code,
            name: body?.name,
            provider: body?.provider,
            reclaim: body?.reclaim === true,
          })
          // 令牌只在这里出现一次：不写日志、不回放、不提供「再查一次」
          sendJson(res, 201, {
            ok: true,
            token: result.token,
            tokenId: result.tokenId,
            member: result.member,
            room: result.room,
            reclaim: result.reclaim,
            note: '令牌只显示这一次，存到本机 0600 的文件里；泄露了就回房间撤销重配',
          })
          return true
        }

        // 其它接口都要求 Bearer 令牌
        const raw = tokenFromRequest(req)
        if (!raw) {
          unauthorized(res, '需要一个 vqc_ 开头的智能体令牌：Authorization: Bearer vqc_...')
          return true
        }
        let auth
        try {
          auth = authenticate(raw)
        } catch (error) {
          fail(res, error)
          return true
        }

        if (pathname === '/api/agent/me') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'AGENT_METHOD', error: '只接受 GET' })
            return true
          }
          const view = roomView({ roomId: auth.room.id, memberId: auth.member.id, limit: 1 })
          sendJson(res, 200, {
            ok: true,
            token: publicTokenState(auth.token),
            member: { id: auth.member.id, name: auth.member.name, provider: auth.member.provider || '' },
            room: view.room,
            lastSeq: view.lastSeq,
            lastReadSeq: view.lastReadSeq,
            limits: { agentsPerRoom: ROOM_LIMITS.agentsPerRoom, message: ROOM_LIMITS.message, waitMs: AGENT_LIMITS.maxWaitMs },
          })
          return true
        }

        if (pathname === '/api/agent/token') {
          if (req.method !== 'DELETE') {
            sendJson(res, 405, { ok: false, code: 'AGENT_METHOD', error: '只接受 DELETE' })
            return true
          }
          revokeSelf(auth.token)
          sendJson(res, 200, { ok: true, revoked: true })
          return true
        }

        if (pathname === '/api/agent/inbox') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'AGENT_METHOD', error: '只接受 GET' })
            return true
          }
          // 不传 since = 第一次来（只回游标）；传 since=0 = 从房间开头算
          const rawSince = url.searchParams.get('since')
          const since = rawSince === null || rawSince === '' ? null : Number(rawSince)
          const release = holdPoll(auth.token.id)
          if (!release) {
            sendJson(res, 429, { ok: false, code: 'AGENT_POLL_LIMIT', error: '这个令牌已经挂着 ' + MAX_POLLS + ' 条长轮询了，先关一条' })
            return true
          }
          let page
          try {
            page = await inboxWithWait({ auth, since, waitMs: waitMsFrom(url) })
          } finally {
            release()
          }
          sendJson(res, 200, {
            ok: true,
            ...page,
            room: { id: auth.room.id, name: auth.room.name },
            member: { id: auth.member.id, name: auth.member.name },
          })
          return true
        }

        if (pathname === '/api/agent/room') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'AGENT_METHOD', error: '只接受 GET' })
            return true
          }
          const limit = Number(url.searchParams.get('limit') || 20)
          sendJson(res, 200, { ok: true, ...roomView({ roomId: auth.room.id, memberId: auth.member.id, limit }) })
          return true
        }

        if (pathname === '/api/agent/messages') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'AGENT_METHOD', error: '只接受 POST' })
            return true
          }
          const body = await readBody(req)
          const result = appendMessageAs({
            roomId: auth.room.id,
            room: auth.room,
            member: auth.member,
            senderKind: 'agent',
            body: body?.body,
            mentions: body?.mentions,
            replyTo: body?.replyTo,
            clientId: body?.clientId,
          })
          sendJson(res, result.duplicated ? 200 : 201, { ok: true, message: result.message, duplicated: result.duplicated })
          return true
        }

        if (pathname === '/api/agent/read') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'AGENT_METHOD', error: '只接受 POST' })
            return true
          }
          const body = await readBody(req)
          const result = markReadAs({ roomId: auth.room.id, memberId: auth.member.id, seq: body?.seq })
          sendJson(res, 200, { ok: true, ...result })
          return true
        }

        sendJson(res, 404, { ok: false, code: 'AGENT_NOT_FOUND', error: '没有这个接口' })
        return true
      } catch (error) {
        if (error?.status) {
          fail(res, error)
          return true
        }
        throw error
      }
    },
  }
}
