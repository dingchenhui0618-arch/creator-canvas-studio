// 智能体接入（r315 一期 1b）：配对码、vqc_ 令牌、收件箱长轮询、MCP、接入说明。
//
// 这一组钉住的是「令牌能做什么、不能做什么」：
//   - 只能碰自己那个房间；拿不到登录态（Bearer 打房间接口必须 401）；
//   - 令牌原文只在配对响应里出现一次，库里只有 sha256；
//   - 撤销/移出成员/同名接管之后，旧令牌立刻失效；
//   - 收件箱不回灌自己说的话，since=0 只给游标不倒历史。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-agent-'))
process.env.DATA_DIR = DATA_DIR
process.env.VQ_KEY_SECRET = 'test-secret-agent'
process.env.VQ_REQUIRE_AUTH = '1'

const auth = await import('../server/auth.mjs')
const rooms = await import('../server/rooms.mjs')
const access = await import('../server/agent-access.mjs')
const { createAgentRouter } = await import('../server/routes/agent.mjs')
const { createRoomsRouter } = await import('../server/routes/rooms.mjs')

const AT = String.fromCharCode(64)
const mail = (name) => name + AT + 'vq.test'
const PASS = 'Passw0rd!demo'

const alice = auth.createUser({ email: mail('agentalice'), password: PASS, name: '阿甲', kind: 'account' })
const bob = auth.createUser({ email: mail('agentbob'), password: PASS, name: '阿乙', kind: 'account' })
const cookieOf = (user) => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.0.3' }).token).split(';')[0]
const aliceCookie = cookieOf(alice)
const bobCookie = cookieOf(bob)

function mockReq({ method = 'GET', body = null, cookie = '', token = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (token) headers.authorization = 'Bearer ' + token
  req.headers = headers
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body !== null) req.push(JSON.stringify(body))
  req.push(null)
  return req
}

function mockRes() {
  const parts = []
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    parts,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    write(chunk) {
      if (chunk) parts.push(chunk)
      return true
    },
    end(chunk) {
      if (chunk) parts.push(chunk)
      this.writableEnded = true
    },
    body() {
      return Buffer.concat(parts.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(String(item))))).toString('utf8')
    },
    json() {
      const text = this.body()
      return text ? JSON.parse(text) : null
    },
  }
}

const agentRouter = createAgentRouter()
const roomsRouter = createRoomsRouter()

async function call({ router = agentRouter, method = 'GET', target, body = null, cookie = '', token = '' } = {}) {
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + target)
  const handled = await router.handle(mockReq({ method, body, cookie, token }), res, url, url.pathname)
  assert.equal(handled, true, '路由要认领自己的前缀：' + target)
  return res
}

async function pair({ code, name, provider = 'codex', reclaim = false }) {
  return call({ method: 'POST', target: '/api/agent/pair', body: { code, name, provider, reclaim } })
}

// 房间与配对码都走真实 HTTP 路由，不直接调函数——契约变了测试就该红
const created = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms', cookie: aliceCookie, body: { name: '接入测试房', topic: '1b' } })
const room = created.json().room
const codeRes = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + room.id + '/pair-code', cookie: aliceCookie })
const pairInfo = codeRes.json()
const CODE = pairInfo.code.code

const paired = await pair({ code: CODE, name: '我的 codex' })
const TOKEN = paired.json().token
const memberId = paired.json().member.id

test('配对码：8 位带连字符，只有房主能生成，重新生成旧码立刻失效', async () => {
  assert.equal(codeRes.statusCode, 201)
  assert.match(CODE, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
  assert.equal(pairInfo.code.max, 10)
  assert.ok(pairInfo.code.expiresAt - pairInfo.code.createdAt === 24 * 60 * 60 * 1000)
  const denied = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + room.id + '/pair-code', cookie: bobCookie })
  assert.equal(denied.statusCode, 403)
  // 换一张：旧码不能再换令牌
  const second = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + room.id + '/pair-code', cookie: aliceCookie })
  assert.notEqual(second.json().code.code, CODE)
  const stale = await pair({ code: CODE, name: '迟到的 codex' })
  assert.equal(stale.statusCode, 401)
  assert.equal(stale.json().code, 'PAIR_CODE')
  // 换回来给后面的用例用
  await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + room.id + '/pair-code', cookie: aliceCookie })
})

test('配对成功：令牌 vqc_ 开头只回一次，库里只存 sha256', async () => {
  assert.equal(paired.statusCode, 201, paired.body())
  assert.match(TOKEN, /^vqc_[A-Za-z0-9_-]{40,}$/)
  assert.equal(paired.json().member.name, '我的 codex')
  assert.equal(paired.json().member.kind, 'agent')
  assert.equal(paired.json().member.provider, 'codex')
  const rows = auth.openDb().prepare('SELECT * FROM agent_tokens').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].token_hash.length, 64)
  assert.ok(!rows[0].token_hash.includes(TOKEN))
  assert.notEqual(rows[0].token_hash, TOKEN)
  // 响应里没有任何「再查一次令牌」的通道
  const me = await call({ target: '/api/agent/me', token: TOKEN })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().token.connected, true)
  assert.equal(me.json().room.name, '接入测试房')
  assert.ok(!JSON.stringify(me.json()).includes(TOKEN))
})

test('没有令牌 / 令牌错：401 且带 WWW-Authenticate；令牌不能当登录态用', async () => {
  const anon = await call({ target: '/api/agent/me' })
  assert.equal(anon.statusCode, 401)
  assert.match(String(anon.headers['WWW-Authenticate'] || ''), /Bearer/)
  const wrong = await call({ target: '/api/agent/inbox?since=0', token: 'vqc_' + 'x'.repeat(43) })
  assert.equal(wrong.statusCode, 401)
  // 关键：房间接口只认 cookie，Bearer 令牌在这里等于没登录
  const asSession = await call({ router: roomsRouter, target: '/api/rooms', token: TOKEN })
  assert.equal(asSession.statusCode, 401)
})

test('令牌只能碰自己那个房间：收件箱、房间视图都锁在它自己的房间', async () => {
  const other = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms', cookie: aliceCookie, body: { name: '另一间房' } })
  assert.equal(other.statusCode, 201)
  const view = await call({ target: '/api/agent/room?limit=5', token: TOKEN })
  assert.equal(view.statusCode, 200)
  assert.equal(view.json().room.name, '接入测试房')
  assert.ok(!JSON.stringify(view.json()).includes('另一间房'))
  // 智能体成员看不到房主以外的账号
  const memberNames = view.json().members.map((item) => item.name)
  assert.ok(memberNames.includes('阿甲'))
  assert.deepEqual(memberNames.filter((name) => name === '阿乙'), [])
})

test('收件箱：since=0 只给游标，不回灌自己说的话，人说话才叫醒它', async () => {
  // 不带 since = 第一次来：只回游标，且不挂（否则 agent 一接入就把历史当新消息回一遍）
  const startFast = Date.now()
  const first = await call({ target: '/api/agent/inbox?wait=3', token: TOKEN })
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().idle, true)
  assert.equal(first.json().firstCall, true)
  assert.ok(Date.now() - startFast < 800, '第一次来不该挂住')

  // 先让房间里有一条人的消息，游标才不是 0
  rooms.appendMessage({ roomId: room.id, userId: alice.id, body: '开场：先定人群' })
  const cursor = (await call({ target: '/api/agent/inbox', token: TOKEN })).json().cursor
  assert.ok(cursor > 0)
  // 显式 since=0 是「从头开始」：刚建的空房间也要能拿到那一条
  const fromZero = await call({ target: '/api/agent/inbox?since=0&wait=0', token: TOKEN })
  assert.equal(fromZero.json().messages.length, 1)
  assert.equal(fromZero.json().firstCall, false)

  // 自己没有新消息：应当挂着等到超时，然后 idle
  const startedAt = Date.now()
  const idle = await call({ target: '/api/agent/inbox?since=' + cursor + '&wait=1', token: TOKEN })
  assert.equal(idle.json().idle, true)
  assert.ok(Date.now() - startedAt >= 900, '长轮询要真的等，不能立刻返回')

  // 人在房间里说话 → 收件箱立刻拿到（不等到 wait 结束）
  const waiting = call({ target: '/api/agent/inbox?since=' + cursor + '&wait=5', token: TOKEN })
  await new Promise((resolve) => setTimeout(resolve, 120))
  rooms.appendMessage({ roomId: room.id, userId: alice.id, body: '这条要投给通勤人群' })
  const woke = await waiting
  assert.equal(woke.json().idle, false)
  assert.equal(woke.json().messages.length, 1)
  assert.equal(woke.json().messages[0].body, '这条要投给通勤人群')
  assert.equal(woke.json().messages[0].senderKind, 'human')

  // 智能体自己发言：房间能看到，但不回灌自己的收件箱
  const before = (await call({ target: '/api/agent/room?limit=1', token: TOKEN })).json().lastSeq
  const said = await call({ method: 'POST', target: '/api/agent/messages', token: TOKEN, body: { body: '收到，我先看一遍素材', clientId: 'c1' } })
  assert.equal(said.statusCode, 201)
  const after = await call({ target: '/api/agent/inbox?since=' + before + '&wait=1', token: TOKEN })
  assert.equal(after.json().idle, true)
  // 幂等：同一个 clientId 再发一次只有一条
  const dup = await call({ method: 'POST', target: '/api/agent/messages', token: TOKEN, body: { body: '收到，我先看一遍素材', clientId: 'c1' } })
  assert.equal(dup.statusCode, 200)
  assert.equal(dup.json().duplicated, true)

  const detail = await call({ router: roomsRouter, target: '/api/rooms/' + room.id, cookie: aliceCookie })
  const agents = detail.json().room.agents
  const mine = agents.find((item) => item.id === memberId)
  assert.equal(mine.connected, true)
  const last = await call({ router: roomsRouter, target: '/api/rooms/' + room.id + '/messages?limit=5', cookie: aliceCookie })
  const agentMessage = last.json().items.find((item) => item.senderKind === 'agent')
  assert.equal(agentMessage.senderName, '我的 codex')
})

test('同一个令牌最多 2 条长轮询：第 3 条 429，不让人一条令牌开几百条连接', async () => {
  const cursor = (await call({ target: '/api/agent/inbox', token: TOKEN })).json().cursor
  const first = call({ target: '/api/agent/inbox?since=' + cursor + '&wait=1', token: TOKEN })
  const second = call({ target: '/api/agent/inbox?since=' + cursor + '&wait=1', token: TOKEN })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const third = await call({ target: '/api/agent/inbox?since=' + cursor + '&wait=1', token: TOKEN })
  assert.equal(third.statusCode, 429)
  assert.equal(third.json().code, 'AGENT_POLL_LIMIT')
  await Promise.all([first, second])
  // 释放之后又能挂
  const again = await call({ target: '/api/agent/inbox?since=' + cursor + '&wait=0', token: TOKEN })
  assert.equal(again.statusCode, 200)
})

test('同名重连：默认 409 并提示 reclaim，带 reclaim 接管后旧令牌立刻失效', async () => {
  const freshCode = (await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + room.id + '/pair-code', cookie: aliceCookie })).json().code.code
  const again = await pair({ code: freshCode, name: '我的 codex' })
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().code, 'MEMBER_EXISTS')
  assert.equal(again.json().reclaim, true)

  const reclaimed = await pair({ code: freshCode, name: '我的 codex', reclaim: true })
  assert.equal(reclaimed.statusCode, 201)
  const NEW_TOKEN = reclaimed.json().token
  assert.notEqual(NEW_TOKEN, TOKEN)
  assert.equal(reclaimed.json().member.id, memberId, '接管要复用同一个成员，不制造第二个分身')

  const oldOne = await call({ target: '/api/agent/me', token: TOKEN })
  assert.equal(oldOne.statusCode, 401)
  const fresh = await call({ target: '/api/agent/me', token: NEW_TOKEN })
  assert.equal(fresh.statusCode, 200)
  // 房间成员仍然只有一个叫这个名字的智能体
  const detail = await call({ router: roomsRouter, target: '/api/rooms/' + room.id, cookie: aliceCookie })
  assert.equal(detail.json().room.agents.filter((item) => item.name === '我的 codex').length, 1)
  TOKEN2 = NEW_TOKEN
})

let TOKEN2 = TOKEN

test('撤销令牌：自己删、被移出房间、房间解散，三种都立刻 401', async () => {
  const self = await call({ method: 'DELETE', target: '/api/agent/token', token: TOKEN2 })
  assert.equal(self.statusCode, 200)
  const dead = await call({ target: '/api/agent/me', token: TOKEN2 })
  assert.equal(dead.statusCode, 401)

  // 重新接一个，然后被移出房间
  const freshCode = (await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + room.id + '/pair-code', cookie: aliceCookie })).json().code.code
  const again = await pair({ code: freshCode, name: '临时接入', provider: 'claude' })
  const TEMP = again.json().token
  const ok = await call({ target: '/api/agent/me', token: TEMP })
  assert.equal(ok.statusCode, 200)
  const removed = await call({ router: roomsRouter, method: 'DELETE', target: '/api/rooms/' + room.id + '/members/' + again.json().member.id, cookie: aliceCookie })
  assert.equal(removed.statusCode, 200)
  const afterRemove = await call({ target: '/api/agent/me', token: TEMP })
  assert.equal(afterRemove.statusCode, 401)
})

test('一张码最多接 10 个智能体；房间成员上限 12 个', async () => {
  const fresh = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + room.id + '/pair-code', cookie: aliceCookie })
  const NEW_CODE = fresh.json().code.code
  // 房间现在有 1 人 + 1 个智能体，还能再加 11 个；码只让 10 个，所以先撞码的上限
  let success = 0
  let lastStatus = 0
  let lastCode = ''
  for (let i = 0; i < 11; i += 1) {
    const res = await pair({ code: NEW_CODE, name: '批量 ' + i })
    lastStatus = res.statusCode
    lastCode = res.json().code || ''
    if (res.statusCode === 201) success += 1
  }
  assert.equal(success, 10, '一张码只放 10 个令牌')
  assert.equal(lastStatus, 429)
  assert.equal(lastCode, 'PAIR_USED')
})

test('MCP：initialize / tools/list / tools/call 三件套，令牌错就 401', async () => {
  const fresh = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + room.id + '/pair-code', cookie: aliceCookie })
  const parsed = await pair({ code: fresh.json().code.code, name: 'MCP 客户端' })
  const MCP_TOKEN = parsed.json().token

  const init = await call({ method: 'POST', target: '/mcp', token: MCP_TOKEN, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } })
  assert.equal(init.statusCode, 200)
  assert.equal(init.json().result.serverInfo.name, 'visionchat')
  assert.equal(init.json().result.protocolVersion, '2025-06-18')
  assert.ok(init.json().result.capabilities.tools)

  const list = await call({ method: 'POST', target: '/mcp', token: MCP_TOKEN, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })
  const names = list.json().result.tools.map((item) => item.name)
  assert.deepEqual(names, ['visionchat_inbox', 'visionchat_send', 'visionchat_room'])

  const sent = await call({ method: 'POST', target: '/mcp', token: MCP_TOKEN, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'visionchat_send', arguments: { body: '我从 MCP 说话' } } } })
  assert.equal(sent.statusCode, 200)
  assert.match(sent.json().result.content[0].text, /"ok":true/)

  const inbox = await call({ method: 'POST', target: '/mcp', token: MCP_TOKEN, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'visionchat_inbox', arguments: { since: 1 } } } })
  assert.equal(inbox.statusCode, 200)
  const page = JSON.parse(inbox.json().result.content[0].text)
  assert.ok(Array.isArray(page.messages))

  const notification = await call({ method: 'POST', target: '/mcp', token: MCP_TOKEN, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })
  assert.equal(notification.statusCode, 202)

  const noToken = await call({ method: 'POST', target: '/mcp', body: { jsonrpc: '2.0', id: 5, method: 'tools/list' } })
  assert.equal(noToken.statusCode, 401)

  const unknown = await call({ method: 'POST', target: '/mcp', token: MCP_TOKEN, body: { jsonrpc: '2.0', id: 6, method: 'nope/nope' } })
  assert.equal(unknown.json().error.code, -32601)

  const get = await call({ method: 'GET', target: '/mcp', token: MCP_TOKEN })
  assert.equal(get.statusCode, 405)
})

test('接入说明：/visionchat.md 是给 agent 自己读的，不带任何用户数据', async () => {
  const res = await call({ target: '/visionchat.md' })
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['Content-Type'] || ''), /text\/markdown/)
  const text = res.body()
  assert.match(text, /\/api\/agent\/pair/)
  assert.match(text, /visionchat_inbox/)
  assert.ok(!text.includes(TOKEN))
  assert.ok(!text.includes(mail('agentalice')))
  assert.ok(!text.includes(room.id))
  // 令牌纪律要写在给 agent 的说明里
  assert.match(text, /0600|不要打印/)
  // since 的两种语义要写对：不传 = 只回游标；since=0 = 真的从头给
  // （2026-11-26 线上说明写反了，agent 照做会把几十条旧消息当新的回一遍）
  assert.match(text, /不传 since[^。]*只回/)
  assert.match(text, /since=0[^。]*从头/)
})

test('配对码过期：24 小时之后 410，不是「码不对」', async () => {
  const fresh = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + room.id + '/pair-code', cookie: aliceCookie })
  const CODE2 = fresh.json().code.code
  const normalized = access.normalizeCode(CODE2)
  auth.openDb().prepare('UPDATE pair_codes SET expires_at = ? WHERE code = ?').run(Date.now() - 1000, normalized)
  const expired = await pair({ code: CODE2, name: '过期的 codex' })
  assert.equal(expired.statusCode, 410)
  assert.equal(expired.json().code, 'PAIR_EXPIRED')
})

test('解散房间：配对码一起作废，码再也换不到令牌', async () => {
  // 单独开一间房：别把前面用例依赖的房间解散掉
  const doomed = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms', cookie: aliceCookie, body: { name: '要解散的房' } })
  const doomedRoom = doomed.json().room
  const issued = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + doomedRoom.id + '/pair-code', cookie: aliceCookie })
  const staleCode = issued.json().code.code

  const dropped = await call({ router: roomsRouter, method: 'DELETE', target: '/api/rooms/' + doomedRoom.id, cookie: aliceCookie })
  assert.equal(dropped.statusCode, 200, dropped.body())

  // 库里那张码必须是「已撤销」——不是只靠配对时再查房间是否解散兜着
  const rows = auth.openDb().prepare('SELECT * FROM pair_codes WHERE room_id = ?').all(doomedRoom.id)
  assert.ok(rows.length >= 1, '这条用例要有码可查')
  assert.ok(rows.every((row) => row.revoked_at), '房间解散了，码不该还写着未撤销')

  const late = await pair({ code: staleCode, name: '姗姗来迟' })
  assert.equal(late.statusCode, 401)
  assert.equal(late.json().code, 'PAIR_CODE')
  // 房间本身也接不进来了（解散是墓碑，接口回 404）
  const pairAgain = await call({ router: roomsRouter, method: 'POST', target: '/api/rooms/' + doomedRoom.id + '/pair-code', cookie: aliceCookie })
  assert.equal(pairAgain.statusCode, 404)
})

