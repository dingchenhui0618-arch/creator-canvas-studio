import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

// 找回密码是「没有账号的人也能碰到」的一条链路，所以这组测试盯的是边界：
//   1) 没有邮件通道时如实不可用（登录页据此不摆死入口），配了才发信；
//   2) 「有没有这个账号」看不出来：无账号与有账号回同一句话；
//   3) token 一次性、会过期、申请新的会作废旧链接；
//   4) 改完口令注销这个账号的全部会话，旧口令立刻登不上；
//   5) 限流挡得住拿找回页当刷信机。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-reset-'))
process.env.DATA_DIR = dir

const auth = await import('../server/auth.mjs')
const mailConfig = await import('../server/mail-config.mjs')
const reset = await import('../server/password-reset.mjs')
const { createAuthRouter } = await import('../server/routes/auth.mjs')

const router = createAuthRouter()
const EMAIL = (user) => user + '@' + 'example.test'
const PASSWORD = 'Passw0rd!demo'

function fakeReq(method, body, { ip = '203.0.113.7', cookies = '' } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  const headers = { host: '127.0.0.1:8899', 'user-agent': 'vq-reset-test' }
  if (cookies) headers.cookie = cookies
  return Object.assign(stream, { method, headers, socket: { remoteAddress: ip } })
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    writeHead(status, headers) {
      this.statusCode = status
      Object.assign(this.headers, headers || {})
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk))
    },
    get body() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
    get json() {
      return this.body ? JSON.parse(this.body) : null
    },
  }
}

async function call(method, pathname, body, options) {
  const res = fakeRes()
  const pathOnly = pathname.split('?')[0]
  const allowed = await router.handle(fakeReq(method, body, options), res, new URL('http://127.0.0.1:8899' + pathname), pathOnly)
  assert.equal(allowed, true, pathname + ' 必须被 auth 路由接住')
  return res
}

/** 一个只收信、不认证的 SMTP：够验「真的发出了」与「链接里是什么」。 */
function fakeSmtp() {
  const capture = { messages: [], connections: 0 }
  const server = net.createServer((socket) => {
    capture.connections += 1
    socket.setEncoding('utf8')
    socket.write('220 reset.test ESMTP\r\n')
    let buffer = ''
    let inData = false
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          capture.messages.push(buffer.slice(0, end))
          buffer = buffer.slice(end + 5)
          inData = false
          socket.write('250 queued\r\n')
          continue
        }
        const lineEnd = buffer.indexOf('\r\n')
        if (lineEnd < 0) return
        const line = buffer.slice(0, lineEnd)
        buffer = buffer.slice(lineEnd + 2)
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO')) socket.write('250-reset.test\r\n250 SIZE 500000\r\n')
        else if (upper.startsWith('MAIL FROM')) socket.write('250 ok\r\n')
        else if (upper.startsWith('RCPT TO')) socket.write('250 ok\r\n')
        else if (upper === 'DATA') {
          inData = true
          socket.write('354 go ahead\r\n')
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n')
          socket.end()
        } else socket.write('250 ok\r\n')
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, capture, port: server.address().port })))
}

function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(resolve))
}

function decodeBody(raw) {
  const boundary = raw.match(/boundary="([^"]+)"/)
  const parts = boundary ? raw.split('--' + boundary[1]).slice(1) : [raw]
  for (const part of parts.reverse()) {
    const index = part.indexOf('\r\n\r\n')
    if (index < 0) continue
    const base64 = part.slice(index + 4).replace(/\r\n/g, '').replace(/--$/, '').trim()
    try {
      const text = Buffer.from(base64, 'base64').toString('utf8')
      if (text) return text
    } catch {
      // 这一段不是正文
    }
  }
  return ''
}

function tokenOf(raw) {
  if (!raw) return ''
  const body = decodeBody(raw)
  return (body.match(/[?&]token=([A-Za-z0-9_-]+)/) || [])[1] || ''
}

async function waitFor(check, timeoutMs = 4000) {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

// 每个用例一个独立账号：邮箱唯一，用例之间不共享口令状态
let userSeq = 0
function freshUser() {
  userSeq += 1
  return auth.createUser({
    email: EMAIL('owner' + userSeq),
    password: PASSWORD,
    name: '找回测试',
    terms: { version: 'test', at: new Date().toISOString() },
  })
}

async function configureMail(port) {
  const saved = await mailConfig.saveMail({
    host: '127.0.0.1',
    port,
    secure: false,
    // 测试用的接收端不说 STARTTLS：显式关掉，免得客户端升级握手失败
    starttls: false,
    user: '',
    pass: '',
    fromName: 'VisionQA',
    fromAddress: EMAIL('noreply'),
  })
  assert.equal(saved.ok, true, saved.error)
}

test('没配邮件通道时：配置开关是关的，申请也不发信', async () => {
  const user = freshUser()
  reset.resetRateLimits()
  const config = await call('GET', '/api/auth/config')
  assert.equal(config.json.passwordReset, false, '没配通道时登录页不该提供自助找回')

  const res = await call('POST', '/api/auth/password/forgot', { email: user.email })
  assert.equal(res.statusCode, 200)
  assert.match(res.json.message, /如果这个邮箱有账号/)
  assert.equal(reset.peekResetToken('any-token').valid, false)
})

test('登录页看不到账号是否存在：有账号、无账号回同一句话', async () => {
  const user = freshUser()
  reset.resetRateLimits()
  const known = await call('POST', '/api/auth/password/forgot', { email: user.email }, { ip: '198.51.100.1' })
  const unknown = await call('POST', '/api/auth/password/forgot', { email: EMAIL('ghost') }, { ip: '198.51.100.2' })
  assert.equal(known.statusCode, 200)
  assert.equal(unknown.statusCode, 200)
  assert.equal(known.json.message, unknown.json.message)
})

test('配好通道后发真邮件：链接带一次性 token，探活为可用', async () => {
  const user = freshUser()
  const smtp = await fakeSmtp()
  try {
    await configureMail(smtp.port)
    reset.resetRateLimits()
    const config = await call('GET', '/api/auth/config')
    assert.equal(config.json.passwordReset, true)

    const res = await call('POST', '/api/auth/password/forgot', { email: user.email }, { ip: '198.51.100.3' })
    assert.equal(res.statusCode, 200)
    const message = await waitFor(() => (smtp.capture.messages.length ? smtp.capture.messages[0] : null))
    assert.ok(message, '后台发信没到，等超时了')
    const decoded = decodeBody(message)
    assert.match(decoded, /#\/reset\?token=/)
    const token = tokenOf(message)
    assert.ok(token && token.length > 20, '链接里要有 token')

    const probe = await call('GET', '/api/auth/password/reset?token=' + encodeURIComponent(token))
    assert.equal(probe.json.valid, true)
    assert.ok(probe.json.expiresAt)
  } finally {
    await closeServer(smtp.server)
  }
})

test('改口令：弱口令被拒、成功后旧口令登不上、同一链接不能再用', async () => {
  const user = freshUser()
  const smtp = await fakeSmtp()
  try {
    await configureMail(smtp.port)
    reset.resetRateLimits()
    await call('POST', '/api/auth/password/forgot', { email: user.email }, { ip: '198.51.100.4' })
    const message = await waitFor(() => (smtp.capture.messages.length ? smtp.capture.messages[0] : null))
    const token = tokenOf(message)
    assert.ok(token)

    const weak = await call('POST', '/api/auth/password/reset', { token, password: 'short' })
    assert.equal(weak.statusCode, 400)
    assert.equal(weak.json.field, 'password')

    const done = await call('POST', '/api/auth/password/reset', { token, password: 'NewPassw0rd9' })
    assert.equal(done.statusCode, 200)
    assert.equal(done.json.ok, true)

    // 旧口令登不上，新口令能登
    const oldLogin = await call('POST', '/api/auth/login', { email: user.email, password: PASSWORD })
    assert.equal(oldLogin.statusCode, 401)
    const newLogin = await call('POST', '/api/auth/login', { email: user.email, password: 'NewPassw0rd9' })
    assert.equal(newLogin.statusCode, 200)

    // 同一枚 token 再用一次要被拒
    const reuse = await call('POST', '/api/auth/password/reset', { token, password: 'Another0ne9' })
    assert.equal(reuse.statusCode, 400)
    assert.match(reuse.json.error, /已经改过口令/)
  } finally {
    await closeServer(smtp.server)
  }
})

test('改完口令注销这个账号的全部会话（包括被劫持的那条）', async () => {
  const user = freshUser()
  const smtp = await fakeSmtp()
  try {
    await configureMail(smtp.port)
    reset.resetRateLimits()
    const login = await call('POST', '/api/auth/login', { email: user.email, password: PASSWORD })
    assert.equal(login.statusCode, 200)
    const cookie = String(login.headers['set-cookie'] || '')
    const pair = cookie.split(';')[0]
    assert.match(pair, /vq_session=/)

    const before = await call('GET', '/api/auth/me', undefined, { cookies: pair })
    assert.equal(before.statusCode, 200)

    await call('POST', '/api/auth/password/forgot', { email: user.email }, { ip: '198.51.100.5' })
    const message = await waitFor(() => (smtp.capture.messages.length ? smtp.capture.messages[0] : null))
    const token = tokenOf(message)
    const done = await call('POST', '/api/auth/password/reset', { token, password: 'AfterReset9' })
    assert.equal(done.statusCode, 200)

    const after = await call('GET', '/api/auth/me', undefined, { cookies: pair })
    assert.equal(after.statusCode, 401, '重置口令后旧会话必须失效')
  } finally {
    await closeServer(smtp.server)
  }
})

test('申请两次只留最新一封：旧链接作废', async () => {
  const user = freshUser()
  const smtp = await fakeSmtp()
  try {
    await configureMail(smtp.port)
    reset.resetRateLimits()
    await call('POST', '/api/auth/password/forgot', { email: user.email }, { ip: '198.51.100.6' })
    const first = await waitFor(() => (smtp.capture.messages.length >= 1 ? tokenOf(smtp.capture.messages[0]) : ''))
    await call('POST', '/api/auth/password/forgot', { email: user.email }, { ip: '198.51.100.6' })
    const second = await waitFor(() => (smtp.capture.messages.length >= 2 ? tokenOf(smtp.capture.messages[1]) : ''))
    assert.ok(first && second && first !== second)

    const stale = await call('GET', '/api/auth/password/reset?token=' + encodeURIComponent(first))
    assert.equal(stale.json.valid, false)
    const current = await call('GET', '/api/auth/password/reset?token=' + encodeURIComponent(second))
    assert.equal(current.json.valid, true)
  } finally {
    await closeServer(smtp.server)
  }
})

test('过期 token 不能改口令', async () => {
  const user = freshUser()
  const expired = reset.createResetToken(user.id, { ttlMinutes: 0 })
  const probe = reset.peekResetToken(expired.token)
  assert.equal(probe.valid, false)
  assert.equal(probe.reason, 'expired')
  const res = await call('POST', '/api/auth/password/reset', { token: expired.token, password: 'Whatever0ne9' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /过期/)
})

test('限流：同一邮箱一小时内第 4 次申请被挡住', async () => {
  const user = freshUser()
  // 没有邮件通道时申请照常回话（只是不发信）：限流和通道状态无关
  await mailConfig.clearMail()
  reset.resetRateLimits()
  const ip = '198.51.100.7'
  for (let index = 0; index < 3; index += 1) {
    const ok = await call('POST', '/api/auth/password/forgot', { email: user.email }, { ip })
    assert.equal(ok.statusCode, 200)
  }
  const blocked = await call('POST', '/api/auth/password/forgot', { email: user.email }, { ip })
  assert.equal(blocked.statusCode, 429)
  assert.match(blocked.json.error, /频繁/)
  assert.ok(blocked.headers['retry-after'])
  reset.resetRateLimits()
})
