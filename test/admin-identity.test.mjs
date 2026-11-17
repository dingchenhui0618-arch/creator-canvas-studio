// 后台改账号身份（v0.9.174）。这一组盯住五件事：
//   1) 邮箱、登录手机号、显示名都能改，改完立刻按新身份认人（登录查询用的是同一张表）；
//   2) 校验全在服务端：邮箱格式、占位邮箱、重名、登录名长度都拒绝，并给中文原因；
//   3) 清空登录手机号只在账号有真实邮箱时允许——否则这个账号再也登不进来；
//   4) 写之前把校验做完：任何一项失败都不留半截改动；
//   5) 每次改身份都进操作日志（user.identity），看得见改了哪几项。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-identity-'))
process.env.VQ_KEY_SECRET = 'test-secret-identity'

const auth = await import('../server/auth.mjs')
const { createAdminRouter } = await import('../server/routes/admin.mjs')
const { listAudit } = await import('../server/audit.mjs')

// 邮箱在源码里用拼接写：避免任何真实地址出现在仓库里，也避免被脱敏规则改写
const at = String.fromCharCode(64)
const PLACEHOLDER = 'login.visionqa.local'
const mail = (name, domain = 'vq.test') => name + at + domain

const admin = auth.createUser({ email: mail('boss'), password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })
const worker = auth.createUser({
  email: mail('worker1'),
  password: 'Passw0rd!demo',
  name: '被测账号',
  kind: 'account',
  loginName: 'worker01',
})
const neighbour = auth.createUser({
  email: mail('worker2'),
  password: 'Passw0rd!demo',
  name: '隔壁账号',
  kind: 'account',
  loginName: 'worker02',
})
// 只有占位邮箱、靠登录名登录的账号：清空登录名就等于把人锁在门外
const placeholderOnly = auth.createUser({
  email: mail('probe9', PLACEHOLDER),
  password: 'Passw0rd!demo',
  name: '占位邮箱账号',
  kind: 'account',
  loginName: 'probe09',
})

const adminCookie = auth.sessionCookie(auth.createSession(admin, { userAgent: 'test', ip: '10.0.0.1' }).token).split(';')[0]
const workerCookie = auth.sessionCookie(auth.createSession(worker, { userAgent: 'test', ip: '10.0.0.2' }).token).split(';')[0]

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

const router = createAdminRouter()

async function patch(id, body, { cookie = adminCookie } = {}) {
  const res = mockRes()
  const pathname = '/api/admin/users/' + id
  await router.handle(mockReq({ method: 'PATCH', body, cookie }), res, new URL('http://127.0.0.1' + pathname), pathname)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

test('补真实邮箱：接口回新邮箱，按邮箱能找到同一个账号', async () => {
  const next = mail('worker1.real')
  const result = await patch(worker.id, { email: next })
  assert.equal(result.status, 200)
  assert.equal(result.json.user.email, next)
  assert.equal(result.json.user.username, 'worker01', '改邮箱不动登录手机号')
  assert.equal(auth.findUserByEmail(next)?.id, worker.id)
  assert.equal(auth.findUserByLogin('worker01')?.id, worker.id, '登录手机号照旧可用')
})

test('登录手机号能改：旧号立刻失效，新号能找到账号', async () => {
  const result = await patch(worker.id, { username: 'worker01b' })
  assert.equal(result.status, 200)
  assert.equal(result.json.user.username, 'worker01b')
  assert.equal(auth.findUserByLoginName('worker01'), null, '旧号不再指向这个账号')
  assert.equal(auth.findUserByLogin('worker01b')?.id, worker.id)
})

test('校验在服务端：格式、占位邮箱、重名、长度都被拒，且不留半截改动', async () => {
  const before = auth.findUserById(worker.id)
  const bad = await patch(worker.id, { email: 'not-an-email' })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.field, 'email')

  const placeholder = await patch(worker.id, { email: mail('someone', PLACEHOLDER) })
  assert.equal(placeholder.status, 400)
  assert.match(placeholder.json.error, /占位邮箱/)

  const dupEmail = await patch(worker.id, { email: neighbour.email })
  assert.equal(dupEmail.status, 409)
  assert.equal(dupEmail.json.field, 'email')

  const dupLogin = await patch(worker.id, { username: 'worker02' })
  assert.equal(dupLogin.status, 409)
  assert.equal(dupLogin.json.field, 'username')

  const shortLogin = await patch(worker.id, { username: 'ab' })
  assert.equal(shortLogin.status, 400)
  assert.match(shortLogin.json.error, /4-32/)

  // 同一请求里一半合法一半不合法：一个字都没写进去
  const mixed = await patch(worker.id, { name: '新名字', username: 'ab' })
  assert.equal(mixed.status, 400)
  const after = auth.findUserById(worker.id)
  assert.equal(after.name, before.name, '显示名不该被改')
  assert.equal(after.login_name, before.login_name)
  assert.equal(after.email, before.email)
})

test('清空登录手机号：有真实邮箱可以（以后只能用邮箱登录），只有占位邮箱的不行', async () => {
  const cleared = await patch(worker.id, { username: '' })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.user.username, '')
  assert.equal(auth.findUserByLogin(auth.findUserById(worker.id).email)?.id, worker.id)

  const risky = await patch(placeholderOnly.id, { username: '' })
  assert.equal(risky.status, 400)
  assert.match(risky.json.error, /没法登录/)
  assert.equal(auth.findUserById(placeholderOnly.id).login_name, 'probe09', '拒绝了就一个字段都不动')
})

test('改显示名：空值表示不改；改完列表里能读到新名字', async () => {
  const renamed = await patch(worker.id, { name: '孙工人' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.json.user.name, '孙工人')

  const blank = await patch(worker.id, { name: '   ' })
  assert.equal(blank.status, 200)
  assert.equal(blank.json.user.name, '孙工人', '空显示名不会把名字抹成空')

  const listed = auth.listUsers().find((item) => item.id === worker.id)
  assert.equal(listed.name, '孙工人')
})

test('权限与留痕：普通账号改不了别人；每次改动都写一条 user.identity', async () => {
  const denied = await patch(neighbour.id, { name: '被改名' }, { cookie: workerCookie })
  assert.equal(denied.status, 403)
  assert.notEqual(auth.findUserById(neighbour.id).name, '被改名')

  // 前面的成功改动各留一条：至少 4 条（补邮箱、改手机号、清空手机号、改名字）
  const rows = listAudit({ action: 'user.identity', limit: 50 }).items || []
  assert.ok(rows.length >= 4, '改身份要进操作日志，实际 ' + rows.length + ' 条')
  const first = rows[rows.length - 1]
  assert.match(String(first.detail && first.detail.fields), /邮箱/, '日志要写清改了哪一项')
})

test('空补丁不改任何东西：既不报错也不留日志', async () => {
  const rows = (listAudit({ action: 'user.identity', limit: 50 }).items || []).length
  const result = await patch(neighbour.id, {})
  assert.equal(result.status, 200)
  assert.equal(result.json.user.username, 'worker02')
  const after = (listAudit({ action: 'user.identity', limit: 50 }).items || []).length
  assert.equal(after, rows, '没有实际改动就不该多出一条日志')
})
