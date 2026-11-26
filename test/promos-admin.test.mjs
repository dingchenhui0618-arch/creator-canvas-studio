// 运营位搬到服务端之后（r320）。这一组盯住五件事：
//   1) 校验是硬的：位置 / 页面白名单、字数上限、日期、id 唯一、每位置条数上限，错误要带第几条；
//   2) 没存过就是「没存过」：resolvePromos 回默认内容、source=default，存过才 source=admin；
//   3) 文件读不出来不许当成空的：先在后台看见原因，直接保存会被拦（409），要显式覆盖；
//   4) internal 的条目不给普通账号（在服务端过滤，不是把开关交给前端）；
//   5) 路由口径：普通账号 403，保存 / 恢复默认都进审计。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-promos-admin-'))
process.env.VQ_KEY_SECRET = 'test-secret-promos-admin'

const promos = await import('../server/promos.mjs')
const auth = await import('../server/auth.mjs')
const { createAdminRouter } = await import('../server/routes/admin.mjs')
const { listAudit } = await import('../server/audit.mjs')

const admin = auth.createUser({ email: '[EMAIL:V0P7YI]', password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })
const user = auth.createUser({ email: '[EMAIL:1ZWGYT]', password: 'Passw0rd!demo', name: '普通账号', kind: 'user' })
const adminCookie = auth.sessionCookie(auth.createSession(admin, { userAgent: 'test', ip: '10.0.3.1' }).token).split(';')[0]
const userCookie = auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.3.2' }).token).split(';')[0]

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

const one = {
  id: 'demo-tip',
  placement: 'overview',
  kicker: '新功能',
  title: '一条测试运营位',
  body: '这里只写一句能给用户带来什么。',
  cta: '去看看',
  page: 'radar',
  weight: 5,
}

test('校验：位置、页面必须在白名单里，错误要带第几条', () => {
  assert.equal(promos.validatePromos([{ ...one, placement: 'somewhere' }]).ok, false)
  assert.match(promos.validatePromos([{ ...one, placement: 'somewhere' }]).error, /^第 1 条：位置只能是/)
  assert.equal(promos.validatePromos([{ ...one, page: 'nowhere' }]).ok, false)
  assert.match(promos.validatePromos([{ ...one, page: 'nowhere' }]).error, /跳转的页面不认识/)
  assert.equal(promos.validatePromos([one, { ...one, title: '第二条' }]).ok, false)
  assert.match(promos.validatePromos([one, { ...one }]).error, /第 2 条：标识 demo-tip 重复了/)
  assert.equal(promos.validatePromos('不是数组').ok, false)
})

test('校验：字数上限就是界面上限，超了报错不静默截断', () => {
  const long = { ...one, body: '一'.repeat(promos.PROMO_LIMITS.body + 1) }
  const checked = promos.validatePromos([long])
  assert.equal(checked.ok, false, '超长必须报错，不能悄悄截断')
  assert.match(checked.error, /^第 1 条：一句话说明最多 80 个字（现在 81 个）$/)
  assert.equal(promos.validatePromos([{ ...one, title: '   ' }]).ok, false)
  assert.equal(promos.validatePromos([{ ...one, kicker: '一'.repeat(promos.PROMO_LIMITS.kicker + 1) }]).ok, false)
})

test('校验：日期格式与先后、权重范围、空白折叠', () => {
  assert.equal(promos.validatePromos([{ ...one, from: '2026-11-26', until: '2026-11-20' }]).ok, false)
  assert.match(promos.validatePromos([{ ...one, from: '2026-11-26', until: '2026-11-20' }]).error, /截止日期比起始日期还早/)
  assert.equal(promos.validatePromos([{ ...one, from: '2026/11/26' }]).ok, false)
  const checked = promos.validatePromos([{ ...one, title: '  多   空格  折叠  ', weight: 99999 }])
  assert.equal(checked.ok, true)
  assert.equal(checked.items[0].title, '多 空格 折叠')
  assert.equal(checked.items[0].weight, 999)
})

test('校验：一个位置最多 5 条、总共最多 12 条', () => {
  const many = Array.from({ length: promos.PROMO_LIMITS.perPlacement + 1 }, (_, index) => ({
    ...one,
    id: 'tip-' + index,
  }))
  assert.equal(promos.validatePromos(many).ok, false)
  assert.match(promos.validatePromos(many).error, /工作台最多 5 条/)
  assert.equal(promos.validatePromos([...many.slice(1), { ...one, id: 'x', placement: 'templates' }]).ok, true)
})

test('没存过：回默认内容，source=default；存过：source=admin，清掉又回默认', async () => {
  const fresh = await promos.resolvePromos()
  assert.equal(fresh.source, 'default')
  assert.equal(fresh.items.length, promos.DEFAULT_PROMOS.length)
  assert.equal(await promos.readPromoStore(), null)

  const saved = await promos.savePromos([one], { by: '[EMAIL:V0P7YI]' })
  assert.equal(saved.ok, true)
  const stored = await promos.resolvePromos()
  assert.equal(stored.source, 'admin')
  assert.deepEqual(stored.items.map((item) => item.id), ['demo-tip'])
  assert.equal(stored.updatedBy, '[EMAIL:V0P7YI]')

  await promos.clearPromos()
  const cleared = await promos.resolvePromos()
  assert.equal(cleared.source, 'default')
  assert.equal(await promos.readPromoStore(), null)
})

test('文件坏了：页面照常显示默认内容并带上原因，直接保存被拦，显式覆盖才写进去', async () => {
  const target = promos.promosFile()
  fs.writeFileSync(target, '{这不是 JSON')
  const view = await promos.resolvePromos()
  assert.equal(view.source, 'error')
  assert.ok(view.error.includes('运营位'))
  assert.equal(view.items.length, promos.DEFAULT_PROMOS.length)

  const blocked = await promos.savePromos([one], { by: '[EMAIL:V0P7YI]' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.conflict, true)

  const forced = await promos.savePromos([one], { by: '[EMAIL:V0P7YI]', force: true })
  assert.equal(forced.ok, true)
  assert.equal((await promos.resolvePromos()).source, 'admin')
  await promos.clearPromos()
})

test('internal 的条目按请求者身份过滤，普通账号拿不到', async () => {
  const items = [
    { ...one, id: 'public-tip' },
    { ...one, id: 'internal-tip', internal: true },
  ]
  assert.deepEqual(promos.publicPromos(items, false).map((item) => item.id), ['public-tip'])
  assert.deepEqual(promos.publicPromos(items, true).map((item) => item.id), ['public-tip', 'internal-tip'])
})

test('路由：普通账号 403，管理员能读能写能恢复默认，动作进审计', async () => {
  const forbidden = await call('GET', '/api/admin/promos', { cookie: userCookie })
  assert.equal(forbidden.status, 403)
  assert.equal((await call('PUT', '/api/admin/promos', { cookie: userCookie, body: { promos: [] } })).status, 403)

  const list = await call('GET', '/api/admin/promos', { cookie: adminCookie })
  assert.equal(list.status, 200)
  assert.equal(list.json.source, 'default')
  assert.deepEqual(list.json.placements.map((item) => item.value), promos.PROMO_PLACEMENTS)
  assert.deepEqual(list.json.pages, promos.PROMO_PAGES)
  assert.equal(list.json.limits.total, promos.PROMO_LIMITS.total)

  const bad = await call('PUT', '/api/admin/promos', { cookie: adminCookie, body: { promos: [{ ...one, id: 'BAD ID' }] } })
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /^第 1 条：/)

  const saved = await call('PUT', '/api/admin/promos', { cookie: adminCookie, body: { promos: [one] } })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.source, 'admin')
  assert.equal(saved.json.promos[0].id, 'demo-tip')

  const readBack = await call('GET', '/api/admin/promos', { cookie: adminCookie })
  assert.equal(readBack.json.source, 'admin')
  assert.equal(readBack.json.promos.length, 1)

  const cleared = await call('DELETE', '/api/admin/promos', { cookie: adminCookie })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.source, 'default')
  assert.equal(cleared.json.promos.length, promos.DEFAULT_PROMOS.length)

  const actions = listAudit({ limit: 20 }).items.map((item) => item.action)
  assert.ok(actions.includes('promo.save'), '保存要进审计')
  assert.ok(actions.includes('promo.clear'), '恢复默认要进审计')
})

test('路由：文件坏了时保存回 409 并带 conflict，带 force 才落盘', async () => {
  fs.writeFileSync(promos.promosFile(), '{坏文件')
  const blocked = await call('PUT', '/api/admin/promos', { cookie: adminCookie, body: { promos: [one] } })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.json.conflict, true)
  const forced = await call('PUT', '/api/admin/promos', { cookie: adminCookie, body: { promos: [one], force: true } })
  assert.equal(forced.status, 200)
  await promos.clearPromos()
})
