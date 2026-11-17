import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

// 手机号验证码登录盯的是边界：
//   1) 没配通道时登录页不摆死入口（config.sms.login=false），发码接口 503；
//   2) 码一次性、会过期、试错 5 次作废；
//   3) 「这个号码有没有账号」看不出来：无账号也回同一句话，只是不发码；
//   4) 同一号码 60 秒才能再发，挡住拿登录页当刷短信机；
//   5) 开了两步验证的账号，短信码只替代口令，不代替第二因子。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-smslogin-'))
process.env.DATA_DIR = dir

const auth = await import('../server/auth.mjs')
const smsConfig = await import('../server/sms-config.mjs')
const smsSend = await import('../server/sms-send.mjs')
const smsLogin = await import('../server/sms-login.mjs')
const { createAuthRouter } = await import('../server/routes/auth.mjs')

const router = createAuthRouter()
const AT = String.fromCharCode(64)
const PHONE = '138' + '0000' + '1001'
const OTHER = '139' + '0000' + '1002'
const UNKNOWN = '137' + '0000' + '9999'
const PASSWORD = 'Passw0rd!demo'

function fakeReq(method, body, { ip = '203.0.113.9', cookies = '' } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  const headers = { host: '127.0.0.1:8899', 'user-agent': 'vq-sms-test' }
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
  const allowed = await router.handle(fakeReq(method, body, options), res, new URL('http://127.0.0.1:8899' + pathname), pathname.split('?')[0])
  assert.equal(allowed, true, pathname + ' 必须被 auth 路由接住')
  return res
}

async function lastCode(phone) {
  const outbox = await smsSend.readFakeOutbox()
  const hit = outbox.filter((item) => item.phone === phone).pop()
  return hit ? hit.code : ''
}

const user = auth.createUser({ email: 'mark' + AT + 'example.test', password: PASSWORD, name: 'mark', loginName: PHONE })
// 第二个账号：验证「同一通道、不同号码各自发码」互不串号
auth.createUser({ email: 'zhang' + AT + 'example.test', password: PASSWORD, name: 'zhang', loginName: OTHER })

test.beforeEach(async () => {
  smsLogin.resetSmsRateLimits()
  await smsConfig.saveSms({ provider: 'fake', ttlMinutes: 5, codeLength: 6 }, {})
  const file = path.join(dir, 'sms-outbox.json')
  fs.rmSync(file, { force: true })
})

test('配了 fake 通道后登录页能看到验证码入口，发码进假收件箱', async () => {
  const config = await call('GET', '/api/auth/config')
  assert.equal(config.json.sms.login, true)
  assert.equal(config.json.sms.codeLength, 6)
  assert.equal(config.json.sms.ttlMinutes, 5)
  assert.equal(config.json.sms.cooldownSec, 60)

  const sent = await call('POST', '/api/auth/sms/send', { phone: PHONE })
  assert.equal(sent.statusCode, 200, sent.body)
  assert.equal(sent.json.sent, true)
  const code = await lastCode(PHONE)
  assert.match(code, /^[0-9]{6}$/)
  assert.equal(sent.body.includes(code), false, '接口响应里不能回显验证码')
})

test('码换会话：同一枚码只能用一次', async () => {
  await call('POST', '/api/auth/sms/send', { phone: PHONE })
  const code = await lastCode(PHONE)
  const ok = await call('POST', '/api/auth/sms/login', { phone: PHONE, code })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json.user.id, user.id)
  assert.ok(String(ok.headers['set-cookie'] || '').includes('vq_session='), '登录成功必须下发会话 cookie')

  const again = await call('POST', '/api/auth/sms/login', { phone: PHONE, code })
  assert.equal(again.statusCode, 401)
  assert.match(again.json.error, /用过|重新发送/)
})

test('错码给剩余次数，试满 5 次这枚码作废', async () => {
  await call('POST', '/api/auth/sms/send', { phone: PHONE })
  for (let index = 1; index <= 5; index += 1) {
    const bad = await call('POST', '/api/auth/sms/login', { phone: PHONE, code: '000000' })
    assert.equal(bad.statusCode, 401)
    if (index < 5) assert.match(bad.json.error, new RegExp('还可以试 ' + (5 - index) + ' 次'))
  }
  const real = await lastCode(PHONE)
  const after = await call('POST', '/api/auth/sms/login', { phone: PHONE, code: real })
  assert.equal(after.statusCode, 401, '试满 5 次后连正确的码也不收')
  assert.match(after.json.error, /试错次数太多|重新发送/)
})

test('码会过期', async () => {
  await call('POST', '/api/auth/sms/send', { phone: PHONE })
  const code = await lastCode(PHONE)
  const database = auth.openDb()
  database.prepare('UPDATE sms_codes SET expires_at = ? WHERE phone_hash = ?').run('2000-01-01T00:00:00.000Z', smsLogin.hashPhone(PHONE))
  const res = await call('POST', '/api/auth/sms/login', { phone: PHONE, code })
  assert.equal(res.statusCode, 401)
  assert.match(res.json.error, /过期/)
})

test('没账号的号码：回同一句话、不发码（不当账号探针）', async () => {
  const res = await call('POST', '/api/auth/sms/send', { phone: UNKNOWN })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.sent, true)
  assert.equal(await lastCode(UNKNOWN), '', '不存在的号码不该真的发出码')
})

test('同一号码 60 秒内只能发一条', async () => {
  const first = await call('POST', '/api/auth/sms/send', { phone: OTHER })
  assert.equal(first.statusCode, 200)
  const second = await call('POST', '/api/auth/sms/send', { phone: OTHER })
  assert.equal(second.statusCode, 429)
  assert.match(second.json.error, /再试/)
})

test('格式不对的号码当场拒，不占额度', async () => {
  const res = await call('POST', '/api/auth/sms/send', { phone: '12345' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /手机号/)
  const login = await call('POST', '/api/auth/sms/login', { phone: PHONE, code: 'abc' })
  assert.equal(login.statusCode, 400)
})

test('没有通道时：登录页不给入口，发码 503', async () => {
  await smsConfig.clearSms()
  const config = await call('GET', '/api/auth/config')
  assert.equal(config.json.sms.login, false)
  const res = await call('POST', '/api/auth/sms/send', { phone: PHONE })
  assert.equal(res.statusCode, 503)
  assert.match(res.json.error, /还没开通/)
})

test('开了两步验证：短信码只换到 challenge，不直接给会话', async () => {
  const challengeUser = auth.createUser({ email: 'totp' + AT + 'example.test', password: PASSWORD, name: 'totp', loginName: '136' + '0000' + '3003' })
  const totp = await import('../server/totp.mjs')
  const secret = totp.generateSecret()
  auth.startTotpSetup(challengeUser.id, { secret, backupCodes: totp.generateBackupCodes() })
  assert.equal(auth.activateTotp(challengeUser.id), true)
  await call('POST', '/api/auth/sms/send', { phone: '136' + '0000' + '3003' })
  const code = await lastCode('136' + '0000' + '3003')
  const res = await call('POST', '/api/auth/sms/login', { phone: '136' + '0000' + '3003', code })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.twoFactorRequired, true)
  assert.ok(res.json.challenge)
  assert.equal(res.headers['set-cookie'], undefined, '这一步不该下发 cookie')
})

test('码的生成：长度可控、首位不是 0', () => {
  for (const length of [4, 6, 8]) {
    for (let index = 0; index < 20; index += 1) {
      const code = smsLogin.generateCode(length)
      assert.equal(code.length, length)
      assert.match(code, /^[1-9][0-9]*$/)
    }
  }
  assert.equal(smsLogin.generateCode(99).length, 8, '超范围按 8 位截断')
  assert.equal(smsLogin.generateCode(1).length, 4, '少于 4 位按 4 位兜底')
})
