// 站点公示（v0.9.67）。这一组盯住四件事：
//   1) 没配就是没配：空目录解析出空串、source=none，页面据此不渲染空壳；
//   2) 环境变量仍然兜底，后台填了就覆盖它，清掉后台配置又回到环境变量；
//   3) 存进去的形状可信：空白折叠、信用代码转大写、坏邮箱与坏信用代码被拒、空表单不许保存；
//   4) 路由口径：后台能读能写能清，普通账号 403，写动作进审计。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-site-'))
process.env.VQ_KEY_SECRET = 'test-secret-site'

const siteInfo = await import('../server/site-info.mjs')
const auth = await import('../server/auth.mjs')
const { createAdminRouter } = await import('../server/routes/admin.mjs')
const { config } = await import('../server/config.mjs')
const { listAudit } = await import('../server/audit.mjs')

const admin = auth.createUser({ email: '[EMAIL:ADMIN1]', password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })
const user = auth.createUser({ email: '[EMAIL:USER1]', password: 'Passw0rd!demo', name: '普通账号', kind: 'user' })
const adminCookie = auth.sessionCookie(auth.createSession(admin, { userAgent: 'test', ip: '10.0.2.1' }).token).split(';')[0]
const userCookie = auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.2.2' }).token).split(';')[0]

// 环境变量在进程启动时就读走了，这里改配置对象：测的正是「后台没填时退回什么」
function useEnv({ icp = '', supportEmail = '' } = {}) {
  config.site.icp = icp
  config.site.supportEmail = supportEmail
}

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
const call = async (method, pathname, { body = null, cookie = '' } = {}) => {
  const res = mockRes()
  await router.handle(mockReq({ method, body, cookie }), res, new URL('http://127.0.0.1' + pathname), pathname)
  return { status: res.statusCode, json: (() => { try { return JSON.parse(res.body) } catch { return null } })() }
}

const FULL = {
  icp: '沪ICP备2026000000号-1',
  operator: '上海某某文化传媒有限公司',
  address: '上海市浦东新区某某路 1 号 2 楼',
  creditCode: '91310115ma1k4x8y2q',
  supportEmail: 'support@example.com',
  complaint: 'support@example.com 或 021-00000000',
}

test('空目录：六项都是空串，来源 none，缺三项必需信息', async () => {
  useEnv()
  const site = await siteInfo.resolveSiteInfo()
  assert.equal(site.source, 'none')
  assert.equal(site.icp, '')
  assert.equal(site.operator, '')
  assert.equal(site.complete, false)
  assert.deepEqual(site.missing, ['ICP 备案号', '运营主体全称', '客服邮箱'])
})

test('环境变量兜底：只配了备案号与客服邮箱，缺的是主体', async () => {
  useEnv({ icp: '京ICP备00000000号', supportEmail: 'help@example.com' })
  const site = await siteInfo.resolveSiteInfo()
  assert.equal(site.source, 'env')
  assert.equal(site.icp, '京ICP备00000000号')
  assert.equal(site.supportEmail, 'help@example.com')
  assert.deepEqual(site.missing, ['运营主体全称'])
})

test('保存：空白折叠、信用代码转大写、后台值覆盖环境变量', async () => {
  const saved = await siteInfo.saveSiteInfo({ ...FULL, operator: '  上海某某  文化传媒有限公司  ' }, { by: 'admin@vision.test' })
  assert.equal(saved.ok, true)
  const site = await siteInfo.resolveSiteInfo()
  assert.equal(site.source, 'admin')
  assert.equal(site.operator, '上海某某 文化传媒有限公司', '连续空白折成一个空格')
  assert.equal(site.creditCode, '91310115MA1K4X8Y2Q', '信用代码统一大写')
  assert.equal(site.icp, FULL.icp, '后台值优先于环境变量')
  assert.equal(site.complete, true)
  assert.deepEqual(site.missing, [])
})

test('落盘 0600，公开视图不带后台字段', async () => {
  if (process.platform !== 'win32') {
    const mode = fs.statSync(siteInfo.siteFile()).mode & 0o777
    assert.equal(mode, 0o600)
  }
  const publicView = await siteInfo.sitePublicView()
  assert.equal(publicView.complete, true)
  assert.equal('updatedBy' in publicView, false)
  assert.equal('source' in publicView, false)
})

test('校验：坏邮箱、17 位信用代码、全空表单都不许保存', async () => {
  const badMail = await siteInfo.saveSiteInfo({ ...FULL, supportEmail: 'not-an-email' })
  assert.equal(badMail.ok, false)
  assert.match(badMail.error, /客服邮箱/)
  const badCode = await siteInfo.saveSiteInfo({ ...FULL, creditCode: '91310115MA1K4X8Y2' })
  assert.equal(badCode.ok, false)
  assert.match(badCode.error, /18 位/)
  const empty = await siteInfo.saveSiteInfo({})
  assert.equal(empty.ok, false)
  assert.match(empty.error, /清空后台填写/)
})

test('清空后回到环境变量兜底', async () => {
  await siteInfo.clearSiteInfo()
  const site = await siteInfo.resolveSiteInfo()
  assert.equal(site.source, 'env')
  assert.equal(site.operator, '')
  assert.equal(site.icp, '京ICP备00000000号')
})

test('路由：普通账号 403，管理员可读可写可清，写动作进审计', async () => {
  const forbidden = await call('GET', '/api/admin/site', { cookie: userCookie })
  assert.equal(forbidden.status, 403)

  const list = await call('GET', '/api/admin/site', { cookie: adminCookie })
  assert.equal(list.status, 200)
  assert.equal(list.json.fields.length, 6)
  assert.equal(list.json.site.source, 'env')

  const bad = await call('PUT', '/api/admin/site', { cookie: adminCookie, body: { ...FULL, supportEmail: 'x' } })
  assert.equal(bad.status, 400)

  const saved = await call('PUT', '/api/admin/site', { cookie: adminCookie, body: FULL })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.site.source, 'admin')
  assert.equal(saved.json.site.complete, true)

  const audit = listAudit({ action: 'site.save', limit: 5 })
  assert.ok(audit.items.length >= 1, '保存写进审计')
  assert.deepEqual(audit.items[0].detail.filled.sort(), ['address', 'complaint', 'creditCode', 'icp', 'operator', 'supportEmail'])

  const cleared = await call('DELETE', '/api/admin/site', { cookie: adminCookie })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.site.source, 'env')
})
