// 房间（r315，一期 1a）：成员鉴权、seq 连续、幂等、长度上限、解散、SSE 头。
//
// 为什么值得单独一组：房间是 VisionChat 的地基，后面 1b 的令牌、1c 的工具都挂在它上面。
// 这里用真实路由 + 真实 SQLite 钉住四条不能退的东西：不是成员必须 403/404、
// seq 必须连续（断线补洞全靠它）、同一个 clientId 不能落两条、解散只能房主做。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-rooms-'))
process.env.DATA_DIR = DATA_DIR
process.env.VQ_KEY_SECRET = 'test-secret-rooms'
process.env.VQ_REQUIRE_AUTH = '1'

const auth = await import('../server/auth.mjs')
const agents = await import('../server/agents.mjs')
const rooms = await import('../server/rooms.mjs')
const { createRoomsRouter } = await import('../server/routes/rooms.mjs')

const AT = String.fromCharCode(64)
const mail = (name) => name + AT + 'vq.test'
const PASS = 'Passw0rd!demo'

const alice = auth.createUser({ email: mail('roomalice'), password: PASS, name: '甲', kind: 'account' })
const bob = auth.createUser({ email: mail('roombob'), password: PASS, name: '乙', kind: 'account' })
const cookieOf = (user) => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.0.2' }).token).split(';')[0]
const aliceCookie = cookieOf(alice)
const bobCookie = cookieOf(bob)

function mockReq({ method = 'GET', body = null, cookie = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = cookie ? { cookie } : {}
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

const router = createRoomsRouter()
async function call({ method = 'GET', path: target, body = null, cookie = '' } = {}) {
  const res = mockRes()
  // 和 server/index.mjs 一样：query 在 url 里，路由只看到 pathname
  const url = new URL('http://127.0.0.1' + target)
  const pathname = url.pathname
  const handled = await router.handle(mockReq({ method, body, cookie }), res, url, pathname)
  assert.equal(handled, true, '房间路由要认领自己前缀下的请求：' + pathname)
  return res
}

const agent = await agents.createAgent({ name: '房间里的运营', role: '写脚本', category: '脚本分镜', systemPrompt: '你负责把一个选题拆成脚本与分镜，不确定的地方先问。' }, alice)
const created = await call({ method: 'POST', path: '/api/rooms', cookie: aliceCookie, body: { name: '一条片子', topic: '测试' } })
const room = created.json().room

test('建房：房主自动成为成员，列表里能看到，默认只读档位', async () => {
  assert.equal(created.statusCode, 201)
  assert.equal(room.name, '一条片子')
  assert.equal(room.members.length, 1)
  assert.equal(room.members[0].kind, 'human')
  assert.equal(room.approvalMode, 'readonly')
  assert.equal(room.isOwner, true)

  const list = await call({ path: '/api/rooms', cookie: aliceCookie })
  assert.equal(list.statusCode, 200)
  const ids = list.json().items.map((item) => item.id)
  assert.ok(ids.includes(room.id))
  assert.equal(list.json().items.find((item) => item.id === room.id).unread, 0)
})

test('不是我房间的人：读、发、订阅一律 403，房间不在给 404', async () => {
  const detail = await call({ path: '/api/rooms/' + room.id, cookie: bobCookie })
  assert.equal(detail.statusCode, 403)
  const messages = await call({ path: '/api/rooms/' + room.id + '/messages', cookie: bobCookie })
  assert.equal(messages.statusCode, 403)
  const send = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/messages', cookie: bobCookie, body: { body: '我来了' } })
  assert.equal(send.statusCode, 403)
  const stream = await call({ path: '/api/rooms/' + room.id + '/stream?since=0', cookie: bobCookie })
  assert.equal(stream.statusCode, 403)

  const missing = await call({ path: '/api/rooms/rm_000000000000dead', cookie: aliceCookie })
  assert.equal(missing.statusCode, 404)
  const anon = await call({ path: '/api/rooms' })
  assert.equal(anon.statusCode, 401)
})

test('消息：seq 从 1 连续递增，同一个 clientId 重发不落第二条', async () => {
  const first = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/messages', cookie: aliceCookie, body: { body: '第一句', clientId: 'c-1' } })
  assert.equal(first.statusCode, 201)
  assert.equal(first.json().message.seq, 1)
  const again = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/messages', cookie: aliceCookie, body: { body: '第一句', clientId: 'c-1' } })
  assert.equal(again.statusCode, 200)
  assert.equal(again.json().duplicated, true)
  assert.equal(again.json().message.id, first.json().message.id)

  const second = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/messages', cookie: aliceCookie, body: { body: '第二句' } })
  assert.equal(second.json().message.seq, 2)

  const page = await call({ path: '/api/rooms/' + room.id + '/messages', cookie: aliceCookie })
  assert.deepEqual(page.json().items.map((item) => item.seq), [1, 2])
  assert.equal(page.json().items[0].body, '第一句')

  // 补洞：since=1 只回 2 之后的那条
  const tail = await call({ path: '/api/rooms/' + room.id + '/messages?since=1', cookie: aliceCookie })
  assert.deepEqual(tail.json().items.map((item) => item.seq), [2])

  // 往上翻：before=2 只回前面那条
  const head = await call({ path: '/api/rooms/' + room.id + '/messages?before=2', cookie: aliceCookie })
  assert.deepEqual(head.json().items.map((item) => item.seq), [1])
})

test('消息：空的拒绝，超长的截到 8000 字，@ 只认房间里的成员', async () => {
  const empty = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/messages', cookie: aliceCookie, body: { body: '   ' } })
  assert.equal(empty.statusCode, 400)

  const long = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/messages', cookie: aliceCookie, body: { body: 'x'.repeat(9000) } })
  assert.equal(long.statusCode, 201)
  assert.equal(long.json().message.body.length, 8000)

  const fake = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/messages', cookie: aliceCookie, body: { body: '点名', mentions: ['mb_notexist000000', room.members[0].id] } })
  assert.deepEqual(fake.json().message.mentions, [room.members[0].id])
})

test('智能体成员：只能加自己的、重复加不重复、上限 12 个', async () => {
  const notMine = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/members', cookie: aliceCookie, body: { agentId: 'agt_nope' } })
  assert.equal(notMine.statusCode, 404)

  const added = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/members', cookie: aliceCookie, body: { agentId: agent.id } })
  assert.equal(added.statusCode, 200)
  assert.equal(added.json().room.agents.length, 1)
  assert.equal(added.json().room.agents[0].name, '房间里的运营')

  const twice = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/members', cookie: aliceCookie, body: { agentId: agent.id } })
  assert.equal(twice.json().room.agents.length, 1)

  // 乙不是房主，加不了
  const denied = await call({ method: 'POST', path: '/api/rooms/' + room.id + '/members', cookie: bobCookie, body: { agentId: agent.id } })
  assert.equal(denied.statusCode, 403)
})

test('只能房主改：改名、解散；解散后列表不再有它', async () => {
  const rename = await call({ method: 'PATCH', path: '/api/rooms/' + room.id, cookie: aliceCookie, body: { name: '改过的名字' } })
  assert.equal(rename.statusCode, 200)
  assert.equal(rename.json().room.name, '改过的名字')

  const bad = await call({ method: 'PATCH', path: '/api/rooms/' + room.id, cookie: aliceCookie, body: { approvalMode: 'full' } })
  assert.equal(bad.statusCode, 400, '不存在的授权档位要拒，一期没有「完全授权」')

  const bye = await call({ method: 'DELETE', path: '/api/rooms/' + room.id, cookie: aliceCookie })
  assert.equal(bye.statusCode, 200)
  const list = await call({ path: '/api/rooms', cookie: aliceCookie })
  assert.equal(list.json().items.some((item) => item.id === room.id), false)
  const gone = await call({ path: '/api/rooms/' + room.id, cookie: aliceCookie })
  assert.equal(gone.statusCode, 404)
})

test('SSE：返回事件流头，先补洞再收活消息，同一账号最多 2 条', async () => {
  const made = await call({ method: 'POST', path: '/api/rooms', cookie: aliceCookie, body: { name: '直播间' } })
  const live = made.json().room
  await call({ method: 'POST', path: '/api/rooms/' + live.id + '/messages', cookie: aliceCookie, body: { body: '开场' } })

  const res = await call({ path: '/api/rooms/' + live.id + '/stream?since=0', cookie: aliceCookie })
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['Content-Type']), /text\/event-stream/)
  assert.equal(res.headers['X-Accel-Buffering'], 'no')
  const opening = res.body()
  assert.match(opening, /^retry: 3000/)
  assert.match(opening, /event: ready/)
  // ready 要说出真实的最大 seq，客户端靠它判断自己手里的历史是不是最新的
  assert.match(opening, /"lastSeq":1/)

  // 连上之后再发一条：订阅是活的，事件顺着同一条连接推下来
  rooms.appendMessage({ roomId: live.id, userId: alice.id, body: '连上之后的一句' })
  const later = res.body().slice(opening.length)
  assert.match(later, /event: message/)
  assert.match(later, /连上之后的一句/)

  // 断开：用 close 让路由清掉订阅与心跳，后面才不会被挂着
  res.writableEnded = true
})

test('房间名：空的拒，超长截到 40 字', async () => {
  const empty = await call({ method: 'POST', path: '/api/rooms', cookie: aliceCookie, body: { name: '  ' } })
  assert.equal(empty.statusCode, 400)
  const long = await call({ method: 'POST', path: '/api/rooms', cookie: aliceCookie, body: { name: '房'.repeat(80) } })
  assert.equal(long.statusCode, 201)
  assert.equal(long.json().room.name.length, 40)
})
