import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 换掉的那条旧地址还被点着（v0.9.149）。
// v0.9.148 让旧地址自己会说「已经换成新的了」，但发件人看不见这件事：
// 换完之后新地址的打开次数从零算起，「0 次打开」既可能是没送到，也可能是送到了没理。
// 旧的这条还在被点，就是前一种。这一组盯的是：
//   1) 点旧地址记一次（次数 + 最近一次），只记这件事，不记是谁；
//   2) 五秒内连着来算一次：刷新与预取不该被数成三次；
//   3) 那一屏不把次数说给收包人看，也不把点一下算成打开那份包；
//   4) 工作台那一行拿得到次数，没被点过的仍是 null；
//   5) 再换一条之后，上一条旧地址的次数不丢；不是记过的地址不凭空建一条。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-retired-hit-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-retired-hit'

const SHA = 'e5f6a7b8c9d0' + 'e'.repeat(52)
const ZIP = 'VisionQA-旧地址还被点-第-2-版-v2-20261115.zip'
const pkg = { bytes: 271003, sha256: SHA, fileName: ZIP, savedAt: '2026-11-14T06:00:00.000Z' }
const TOKEN_OLD = 'ab12cd34ef56ab78'
const TOKEN_PLAIN = 'cd34ef56ab78cd90'
const TOKEN_NEVER = 'ef56ab78cd90ef12'

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
    // 换掉一条地址、然后有人点回去的那一条
    project('prj_hit', '换掉之后还有人点旧地址', {
      ...base,
      id: 'ab12ab12ab120011',
      receiptToken: TOKEN_OLD,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
      resends: [{ at: '2026-11-14T07:00:00.000Z' }, { at: '2026-11-15T07:00:00.000Z' }],
    }),
    // 从没换过：它没有旧地址，也就没有这一项
    project('prj_plain', '没换过地址的那一条', {
      ...base,
      id: 'ab12ab12ab120012',
      receiptToken: TOKEN_PLAIN,
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
const { ledgerRows } = await import('../server/delivery-ledger.mjs')
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

let rotatedAt = ''

test('换掉之后有人点旧地址：记一次，只记次数与时间', async () => {
  const issued = await store.saveDeliveryRelink('prj_hit', 'ab12ab12ab120011')
  rotatedAt = issued.at
  const before = await store.findRetiredReceiptLink(TOKEN_OLD)
  assert.equal(before.hits, 0, '还没人点过：零次')

  const router = createProjectsRouter()
  const res = await call(router, '/api/receipts/' + TOKEN_OLD)
  assert.equal(res.status, 410, '旧地址照旧 410：' + res.status)

  const after = await store.findRetiredReceiptLink(TOKEN_OLD)
  assert.equal(after.hits, 1, '点一次记一次：' + JSON.stringify(after))
  assert.equal(after.at, rotatedAt, '换掉的时间没被这一下改掉')
  assert.ok(Number.isFinite(Date.parse(after.lastAt)), '最近一次是能读的时间：' + after.lastAt)

  const row = (await store.getProject('prj_hit')).deliveries[0]
  assert.equal(row.retired[0].key, visitKey(TOKEN_OLD), '记号仍是打开记录那一套键')
  assert.equal(row.retired[0].hits, 1, '次数写进那一条旧地址的记号里')
  assert.equal(row.retired[0].lastAt, after.lastAt)

  // 旧 token 本身仍然不落盘：多记的只是次数，不是凭证
  const raw = fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8')
  assert.equal(raw.includes(TOKEN_OLD), false, '旧 token 不落盘')
  assert.equal(raw.includes(visitKey(TOKEN_OLD)), true, '记号在盘上')
})

test('五秒内连着点算一次：刷新与预取不该被数成三次', async () => {
  const first = await store.findRetiredReceiptLink(TOKEN_OLD)
  const now = Date.parse(first.lastAt)

  // 同一屏里两个请求挨着来（页面一刷新就会再取一次数据）：不记
  const again = await store.noteRetiredReceiptLinkHit(TOKEN_OLD, now + 800)
  assert.equal(again.recorded, false, '五秒内不再记')
  assert.equal(again.hits, 1, '次数不变：' + JSON.stringify(again))
  assert.equal((await store.findRetiredReceiptLink(TOKEN_OLD)).hits, 1)

  // 过了五秒才是一次新的点击
  const later = await store.noteRetiredReceiptLinkHit(TOKEN_OLD, now + 6000)
  assert.equal(later.recorded, true, '过了五秒算新的一次')
  assert.equal(later.hits, 2, '第二次：' + JSON.stringify(later))
  assert.equal(later.lastAt, new Date(now + 6000).toISOString(), '最近一次跟着走')
  assert.equal(later.at, rotatedAt, '换掉的时间一直没变')
})

test('那一屏不把次数说给收包人：410 仍是三句话，点一下也不算打开', async () => {
  const router = createProjectsRouter()
  const res = await call(router, '/api/receipts/' + TOKEN_OLD)
  assert.equal(res.status, 410)
  const payload = JSON.parse(res.body)
  assert.deepEqual(Object.keys(payload).sort(), ['code', 'error', 'retiredAt'], '只回这三项，不多一个数')
  assert.equal(payload.code, 'LINK_RETIRED')
  assert.equal(res.body.includes('次'), false, '不把次数写给他看：' + res.body)
  assert.equal(res.body.includes(TOKEN_PLAIN), false)

  // 打开一句说明不是打开那份包（与 v0.9.148 同一口径）
  assert.equal((await getReceiptVisits(TOKEN_OLD)).opens, 0)

  // 在旧地址上贴收据同样只说这一句
  const posted = await call(router, '/api/receipts/' + TOKEN_OLD, { method: 'POST' })
  assert.equal(posted.status, 410)
  assert.equal(JSON.parse(posted.body).code, 'LINK_RETIRED')
})

test('工作台那一行拿得到次数：没被点过的仍是 null', async () => {
  const hit = ledgerRows({ projects: [await store.getProject('prj_hit')] })[0]
  assert.ok(hit.retiredHits, '有人点过旧地址的那一行该带上这个信号：' + JSON.stringify(hit.retiredHits))
  assert.equal(hit.retiredHits.count, 2, '两次：' + JSON.stringify(hit.retiredHits))
  assert.ok(Number.isFinite(Date.parse(hit.retiredHits.at)), '最近一次能读：' + hit.retiredHits.at)
  // 这一句只是解释「他手上还是旧的」：打开次数、换没换过、能不能再发都不受影响
  assert.equal(hit.visits.opens, 0, '点旧地址不是打开新地址')
  assert.equal(hit.relink.count, 1)
  assert.equal(hit.resendable, true, '新地址还没被打开过：仍可再发一次')
  assert.equal(hit.relinkable, false, '刚换过、重发次数清零：不该马上再换一条')

  const plain = ledgerRows({ projects: [await store.getProject('prj_plain')] })[0]
  assert.equal(plain.retiredHits, null, '没换过地址的那条没有这一项')
})

test('再换一条之后，上一条旧地址的次数不丢；不是记过的地址不凭空建一条', async () => {
  const before = (await store.getProject('prj_hit')).deliveries[0]
  const current = before.receiptToken
  await store.saveDeliveryRelink('prj_hit', 'ab12ab12ab120011')
  const after = (await store.getProject('prj_hit')).deliveries[0]
  assert.equal(after.retired.length, 2, '两条旧地址都在')
  const kept = after.retired.find((item) => item.key === visitKey(TOKEN_OLD))
  assert.equal(kept.hits, 2, '上一条旧地址的次数没被新的一次换链清零：' + JSON.stringify(kept))
  assert.equal(after.retired.some((item) => item.key === visitKey(current)), true, '刚换掉的那条也留了记号')

  // 从没记过的地址：不记、不建，照旧 404
  assert.equal(await store.noteRetiredReceiptLinkHit(TOKEN_NEVER, Date.now()), null)
  assert.equal(await store.noteRetiredReceiptLinkHit('not-a-token', Date.now()), null)
  const router = createProjectsRouter()
  const gone = await call(router, '/api/receipts/' + TOKEN_NEVER)
  assert.equal(gone.status, 404, '没发过的地址还是「不在了」')
  const row = (await store.getProject('prj_hit')).deliveries[0]
  assert.equal(row.retired.length, 2, '乱猜的地址没有凭空多出一条记号')
})
