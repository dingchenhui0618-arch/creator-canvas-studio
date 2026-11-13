// 登录设备（v0.9.62）。这一组盯住五件事：
//   1) 只列本账号、只列未过期的会话，id 是派生值，不泄露 token / token_hash；
//   2) 能踢掉指定设备，踢完那枚 token 立刻失效；
//   3) 当前设备不能从列表里踢（退出当前设备走「退出登录」）；
//   4) 不能踢别的账号的会话；
//   5) 设备名 / IP / 到期天数的展示口径是纯函数，认不出来就说未知。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-sessions-'))
process.env.VQ_KEY_SECRET = 'test-secret-sessions'

const auth = await import('../server/auth.mjs')
const { createAuthRouter } = await import('../server/routes/auth.mjs')
const { parseUserAgent, deviceLabel, maskIp, daysLeft } = await import('../src/domain/device.ts')

const alice = auth.createUser({ email: '[EMAIL:ALICE1]', password: 'Passw0rd!demo', name: '设备用户', kind: 'user' })
const bob = auth.createUser({ email: '[EMAIL:BOB001]', password: 'Passw0rd!demo', name: '另一个账号', kind: 'user' })

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const first = auth.createSession(alice, { userAgent: CHROME_UA, ip: '139.196.123.28' })
const second = auth.createSession(alice, { userAgent: IPHONE_UA, ip: '10.0.0.9' })
const cookieOf = (token) => auth.sessionCookie(token).split(';')[0]

function mockReq({ method = 'GET', body = null, cookie = '', headers = {} } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = { ...(cookie ? { cookie } : {}), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body !== null) req.push(JSON.stringify(body))
  req.push(null)
  return req
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    write(chunk) {
      this.body += String(chunk)
      return true
    },
    end(chunk) {
      if (chunk) this.body += String(chunk)
      this.writableEnded = true
    },
  }
}

const call = async (router, req, pathname) => {
  const res = mockRes()
  await router.handle(req, res, new URL('http://127.0.0.1' + pathname), pathname)
  return res
}

test('只列本账号的会话，当前这一条标出来，id 是派生值', () => {
  const mine = auth.listLoginSessions(alice.id, first.token)
  assert.equal(mine.total, 2)
  assert.equal(mine.sessions.length, 2)
  assert.equal(mine.sessions.filter((item) => item.current).length, 1)
  assert.equal(mine.sessions.find((item) => item.current).id, mine.sessions.find((item) => item.userAgent === CHROME_UA).id)
  for (const item of mine.sessions) {
    assert.match(item.id, /^[0-9a-f]{16}$/)
    assert.equal('tokenHash' in item, false)
    assert.equal('token' in item, false)
  }
  // 别人的列表里看不到 alice 的会话
  assert.equal(auth.listLoginSessions(bob.id, '').total, 0)
})

test('踢掉指定设备后那枚 token 立刻失效，当前设备保持登录', () => {
  const other = auth.listLoginSessions(alice.id, first.token).sessions.find((item) => !item.current)
  const result = auth.revokeLoginSession(alice.id, other.id, first.token)
  assert.equal(result.ok, true)
  assert.equal(auth.userForToken(second.token), null, '被踢掉的设备必须马上失效')
  assert.ok(auth.userForToken(first.token), '当前设备不能被连带踢掉')
  assert.equal(auth.listLoginSessions(alice.id, first.token).total, 1)

  // 再踢一次同一条：已经不在列表里
  assert.equal(auth.revokeLoginSession(alice.id, other.id, first.token).code, 'NOT_FOUND')
})

test('当前设备不许从列表里踢；别人的会话也踢不到', () => {
  const currentId = auth.listLoginSessions(alice.id, first.token).sessions.find((item) => item.current).id
  assert.equal(auth.revokeLoginSession(alice.id, currentId, first.token).code, 'CURRENT')

  const bobSession = auth.createSession(bob, { userAgent: CHROME_UA, ip: '10.0.0.10' })
  const bobId = auth.listLoginSessions(bob.id, bobSession.token).sessions[0].id
  assert.equal(auth.revokeLoginSession(alice.id, bobId, first.token).code, 'NOT_FOUND')
  assert.ok(auth.userForToken(bobSession.token), '别人的会话不能被 alice 踢掉')
})

test('路由：未登录 401，读列表、踢设备、一键退出其它设备', async () => {
  const router = createAuthRouter()
  const third = auth.createSession(alice, { userAgent: IPHONE_UA, ip: '10.0.0.11' })

  const anonymous = await call(router, mockReq(), '/api/auth/sessions')
  assert.equal(anonymous.statusCode, 401)

  const listed = await call(router, mockReq({ cookie: cookieOf(first.token) }), '/api/auth/sessions')
  assert.equal(listed.statusCode, 200)
  const payload = JSON.parse(listed.body)
  assert.equal(payload.sessions.length, 2)
  assert.equal(payload.total, 2)
  assert.ok(payload.current)
  assert.equal(payload.sessions.filter((item) => item.current).length, 1)

  const target = payload.sessions.find((item) => !item.current)
  const revoked = await call(router, mockReq({ method: 'DELETE', cookie: cookieOf(first.token) }), '/api/auth/sessions/' + target.id)
  assert.equal(revoked.statusCode, 200)
  assert.equal(auth.userForToken(third.token), null)

  const currentId = payload.current
  const bad = await call(router, mockReq({ method: 'DELETE', cookie: cookieOf(first.token) }), '/api/auth/sessions/' + currentId)
  assert.equal(bad.statusCode, 400)
  assert.ok(auth.userForToken(first.token))

  const unknown = await call(router, mockReq({ method: 'DELETE', cookie: cookieOf(first.token) }), '/api/auth/sessions/0123456789abcdef')
  assert.equal(unknown.statusCode, 404)

  const fourth = auth.createSession(alice, { userAgent: CHROME_UA, ip: '10.0.0.12' })
  const others = await call(router, mockReq({ method: 'POST', cookie: cookieOf(first.token) }), '/api/auth/sessions/revoke-others')
  assert.equal(others.statusCode, 200)
  assert.equal(JSON.parse(others.body).signedOut, 1)
  assert.equal(auth.userForToken(fourth.token), null)
  assert.ok(auth.userForToken(first.token), '一键退出不踢当前设备')
})

test('老会话积了很多条时：只列最近 10 条，但总数说真话', () => {
  const carol = auth.createUser({ email: '[EMAIL:CAROL1]', password: 'Passw0rd!demo', name: '攒了很多设备', kind: 'user' })
  const current = auth.createSession(carol, { userAgent: CHROME_UA, ip: '10.1.0.1' })
  for (let index = 0; index < 13; index += 1) {
    auth.createSession(carol, { userAgent: IPHONE_UA, ip: '10.1.0.' + (index + 2) })
  }
  const listed = auth.listLoginSessions(carol.id, current.token)
  assert.equal(listed.total, 14, '总数不能只报列表里的条数')
  assert.equal(listed.sessions.length, 10)
  assert.equal(listed.sessions.filter((item) => item.current).length, 1)
})

test('设备名称、IP 与到期天数：认不出来就说未知', () => {
  assert.equal(deviceLabel(CHROME_UA), 'Windows · Chrome')
  assert.equal(deviceLabel(IPHONE_UA), 'iPhone · Safari')
  assert.equal(deviceLabel('curl/8.5.0'), '命令行 · curl')
  assert.equal(deviceLabel('node'), '命令行 · Node')
  assert.equal(deviceLabel('python-requests/2.34.2'), '命令行 · Python')
  assert.equal(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15').device, 'Mac')
  assert.equal(deviceLabel(''), '未知设备')

  assert.equal(maskIp('::1'), '本机')
  assert.equal(maskIp('127.0.0.1'), '本机')
  assert.equal(maskIp('139.196.123.28'), '139.196.123.*')
  assert.equal(maskIp('2408:8207:1234:5678::1'), '2408:8207:…')
  assert.equal(maskIp(''), '—')

  const day = 86400000
  assert.equal(daysLeft(1000 + day * 2, 1000), 2)
  assert.equal(daysLeft(1000 + 1, 1000), 1, '不到一天按一天算')
  assert.equal(daysLeft(1000, 2000), 0, '过期不显示负数')
})
