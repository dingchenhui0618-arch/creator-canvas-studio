import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 换掉的旧地址（v0.9.148）。
// v0.9.147 让发件人能把一条两次都没被打开过的地址换掉，那段话里写着「旧的那条已经打不开了」。
// 可收包人点回聊天记录里那条旧地址时，看到的却是「这条回执链接不在了」——
// 听起来像发件人收回了一份已经交出去的包。这一组盯的就是旧地址自己怎么说话：
//   1) 换地址时只留旧 token 的哈希前缀（打开记录同一套键），不留 token 本身；
//   2) 旧地址回 410 LINK_RETIRED，说清哪一天换的，不给作品、不给包、不给新地址；
//   3) 打开旧地址不算一次打开（打开的是一句说明，不是那份包）；
//   4) 作品页那个「换一条」与工作台换链接是同一件事，旧地址同样留记号；
//   5) 最多留 5 条：更早的旧地址回到「不在了」，不编一句它没记过的话。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-retired-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-retired'

const SHA = 'd4e5f6a7b8c9' + 'd'.repeat(52)
const ZIP = 'VisionQA-旧地址验收-第-2-版-v2-20261115.zip'
const pkg = { bytes: 272155, sha256: SHA, fileName: ZIP, savedAt: '2026-11-14T06:00:00.000Z' }
const TOKEN_OLD = 'aa11bb22cc33dd44'
const TOKEN_BUTTON = 'bb22cc33dd44ee55'
const TOKEN_QUIET = 'cc33dd44ee55ff66'
const TOKEN_CAP = 'dd44ee55ff660011'
const TOKEN_NEVER = 'ee55ff6600112233'

function project(id, title, delivery) {
  return {
    id,
    ownerId: 'u_a',
    title,
    flowId: 'flow_' + id,
    version: 2,
    versions: [],
    status: 'done',
    deliveries: [delivery],
    createdAt: '2026-11-13T05:00:00.000Z',
    updatedAt: '2026-11-14T06:00:00.000Z',
  }
}

const base = { version: 2, at: '2026-11-13T06:00:00.000Z', package: pkg }

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    // 工作台换链接的那一条
    project('prj_rot', '换过地址的那一条', {
      ...base,
      id: 'cd12cd12cd120011',
      receiptToken: TOKEN_OLD,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
      resends: [{ at: '2026-11-14T07:00:00.000Z' }, { at: '2026-11-15T07:00:00.000Z' }],
    }),
    // 作品页那个「换一条」：走的是另一条路，记号要一样留
    project('prj_button', '作品页换了一条', {
      ...base,
      id: 'cd12cd12cd120012',
      receiptToken: TOKEN_BUTTON,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
    }),
    // 已经在用、只取回不换：不该多出一条旧地址
    project('prj_quiet', '只是取回链接', {
      ...base,
      id: 'cd12cd12cd120013',
      receiptToken: TOKEN_QUIET,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
    }),
    // 换到超过五次：只留五条旧地址
    project('prj_cap', '换过很多次', {
      ...base,
      id: 'cd12cd12cd120014',
      receiptToken: TOKEN_CAP,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
    }),
    // 从没换过：它的地址照常能打开
    project('prj_never', '没换过地址', {
      ...base,
      id: 'cd12cd12cd120015',
      receiptToken: TOKEN_NEVER,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
    }),
  ]),
  'utf8',
)
fs.writeFileSync(path.join(DIR, 'reviews.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'templates.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'flows.json'), JSON.stringify([]), 'utf8')

const store = await import('../server/projects.mjs')
const { getReceiptVisits, visitKey } = await import('../server/receipt-visits.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
}

async function call(router, pathname, { method = 'GET' } = {}) {
  const url = new URL('http://localhost' + pathname)
  const res = fakeRes()
  const req = { method, headers: {} }
  await router.handle(req, res, url, url.pathname)
  return res
}

test('换地址时只留旧地址的记号：不是 token，猜不回一条能打开的地址', async () => {
  const issued = await store.saveDeliveryRelink('prj_rot', 'cd12cd12cd120011')
  const row = (await store.getProject('prj_rot')).deliveries[0]
  assert.equal(row.receiptToken, issued.token)
  assert.equal(row.retired.length, 1, '换掉的那一条留了一个记号')
  assert.equal(row.retired[0].key, visitKey(TOKEN_OLD), '记号与打开记录同一套键')
  assert.equal(row.retired[0].at, issued.at, '记号上写着什么时候换的')
  assert.match(row.retired[0].key, /^[0-9a-f]{16}$/)

  // 盘上那份记录里不能出现旧 token 本身：它已经打不开了，留着只是多一份能当凭证猜的字符串
  const raw = fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8')
  assert.equal(raw.includes(TOKEN_OLD), false, '旧 token 不落盘')

  // 按旧地址找得到那一次，按新地址与随便一串都找不到
  assert.deepEqual(await store.findRetiredReceiptLink(TOKEN_OLD), { at: issued.at })
  assert.equal(await store.findRetiredReceiptLink(issued.token), null)
  assert.equal(await store.findRetiredReceiptLink('0123456789abcdef'), null)
  assert.equal(await store.findRetiredReceiptLink('not-a-token'), null)
  assert.equal(await store.findRetiredReceiptLink(''), null)
})

test('旧地址打开：410 说清哪一天换的，不记一次打开，也不给包与作品', async () => {
  const router = createProjectsRouter()
  const rotated = (await store.getProject('prj_rot')).deliveries[0]

  const res = await call(router, '/api/receipts/' + TOKEN_OLD)
  assert.equal(res.status, 410, '它确实曾经在，现在永久不在了')
  const payload = JSON.parse(res.body)
  assert.equal(payload.code, 'LINK_RETIRED')
  assert.equal(payload.retiredAt, rotated.retired[0].at)
  assert.match(payload.error, /换成了新的一条/)
  assert.match(payload.error, /旧地址从那会儿起就打不开了/)
  // 日期交给页面按浏览器时区写：这一侧拿不到时区，按 UTC 写会写错一整天
  assert.doesNotMatch(payload.error, /\d{2}-\d{2}/, '这一句不带日期：' + payload.error)
  // 只回这一句：作品标题、包名、字节、哈希、新地址一概不给
  assert.deepEqual(Object.keys(payload).sort(), ['code', 'error', 'retiredAt'])
  assert.equal(res.body.includes(ZIP), false)
  assert.equal(res.body.includes(SHA), false)
  assert.equal(res.body.includes('换过地址的那一条'), false)
  assert.equal(res.body.includes(rotated.receiptToken), false, '旧地址不给新地址')

  // 打开一句说明不是打开那份包：这条地址的打开次数还是零
  assert.equal((await getReceiptVisits(TOKEN_OLD)).opens, 0)

  // 想在这条旧地址上贴收据，同样先知道他点错了地址
  const posted = await call(router, '/api/receipts/' + TOKEN_OLD, { method: 'POST' })
  assert.equal(posted.status, 410)
  assert.equal(JSON.parse(posted.body).code, 'LINK_RETIRED')

  // 没换过的地址与真正乱猜的地址：照旧 200 / 404，没人被这一条改动牵连
  const alive = await call(router, '/api/receipts/' + TOKEN_NEVER)
  assert.equal(alive.status, 200)
  const gone = await call(router, '/api/receipts/0123456789abcdef')
  assert.equal(gone.status, 404)
  assert.match(JSON.parse(gone.body).error, /不在了/)
})

test('作品页那个「换一条」也留记号：两条路换掉的地址说法一样', async () => {
  const rotated = await store.issueDeliveryReceiptToken('prj_button', 'cd12cd12cd120012', null, { rotate: true })
  assert.equal(rotated.rotated, true)
  assert.notEqual(rotated.token, TOKEN_BUTTON)
  const row = (await store.getProject('prj_button')).deliveries[0]
  assert.equal(row.retired.length, 1)
  assert.equal(row.retired[0].key, visitKey(TOKEN_BUTTON))

  const router = createProjectsRouter()
  const old = await call(router, '/api/receipts/' + TOKEN_BUTTON)
  assert.equal(old.status, 410)
  assert.equal(JSON.parse(old.body).code, 'LINK_RETIRED')

  // 只取回、不换的那条路：地址没变，也不该平白多出一条「旧地址」
  const kept = await store.issueDeliveryReceiptToken('prj_quiet', 'cd12cd12cd120013')
  assert.equal(kept.rotated, false)
  assert.equal(kept.token, TOKEN_QUIET)
  assert.equal((await store.getProject('prj_quiet')).deliveries[0].retired, undefined)
})

test('最多留五条旧地址：更早的回到「不在了」，不编一句它没记过的话', async () => {
  const seen = []
  for (let i = 0; i < 6; i += 1) {
    const before = (await store.getProject('prj_cap')).deliveries[0].receiptToken
    seen.push(before)
    await store.saveDeliveryRelink('prj_cap', 'cd12cd12cd120014')
  }
  const row = (await store.getProject('prj_cap')).deliveries[0]
  assert.equal(row.retired.length, 5, '最多五条，再多也改变不了什么')

  const router = createProjectsRouter()
  const first = await call(router, '/api/receipts/' + seen[0])
  assert.equal(first.status, 404, '被挤掉的旧地址只能说「不在了」')
  const last = await call(router, '/api/receipts/' + seen[seen.length - 1])
  assert.equal(last.status, 410)
  assert.equal(JSON.parse(last.body).code, 'LINK_RETIRED')
})
