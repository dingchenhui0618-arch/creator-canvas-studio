import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 换一条新链接（v0.9.147）。
// v0.9.146 让那一行在「又发过两次还是没人打开」时说得出口「换个方式，或者换一条新链接」，
// 这一组盯的是那个动作本身：
//   1) 换的是地址，不是包：旧 token 立刻打不开，新 token 打开次数与重发次数从零算起；
//   2) 换过几次单独记，并折进「换掉之前那条发过几次」——两个数一起才说得清试过几条地址；
//   3) 已经贴过回执的不换，这里已经问到了；被打开过的不换，对方可能正看着那条；
//   4) 不知道打开过没有（升级前发的链接）不给换，与重发同一条边界。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-relink-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-relink'

const SHA = 'c1d2e3f4a5b6' + 'c'.repeat(52)
const ZIP = 'VisionQA-换链接验收-第-2-版-v2-20261115.zip'
const pkg = { bytes: 272155, sha256: SHA, fileName: ZIP, savedAt: '2026-11-14T06:00:00.000Z' }
const TOKEN_STUCK = 'aa11bb22cc33dd44'
const TOKEN_CAP = 'ee55ff66aa77bb88'
const TOKEN_ENDPOINT = '1234abcd5678ef90'
const TOKEN_OPENED = 'a0b1c2d3e4f50607'
const TOKEN_DONE = 'f0e1d2c3b4a59687'
const TOKEN_RELINKED = '0a1b2c3d4e5f6071'
const TOKEN_LEGACY = '9182736455aa4b3c'

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
    // 又发过两次还是没被打开：换链接的就是它
    project('prj_stuck', '又发过两次还没打开', {
      ...base,
      id: 'ab12ab12ab120011',
      receiptToken: TOKEN_STUCK,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
      resends: [{ at: '2026-11-14T07:00:00.000Z' }, { at: '2026-11-15T07:00:00.000Z' }],
    }),
    // 换到第五次之后再多换几次：只留五条
    project('prj_cap', '换过很多次', {
      ...base,
      id: 'ab12ab12ab120012',
      receiptToken: TOKEN_CAP,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
      resends: [{ at: '2026-11-14T07:00:00.000Z' }],
    }),
    // 端点：换一枚新 token，旧地址立刻 404
    project('prj_endpoint', '换链接端点', {
      ...base,
      id: 'ab12ab12ab120013',
      receiptToken: TOKEN_ENDPOINT,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
      resends: [{ at: '2026-11-14T07:00:00.000Z' }, { at: '2026-11-15T07:00:00.000Z' }],
    }),
    // 链接被打开过：不给换（对方可能正看着那条）
    project('prj_opened', '打开过的链接', {
      ...base,
      id: 'ab12ab12ab120014',
      receiptToken: TOKEN_OPENED,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
    }),
    // 已经贴过回执：不用再换
    project('prj_done', '已经贴过回执', {
      version: 2,
      at: '2026-11-12T06:00:00.000Z',
      id: 'ab12ab12ab120015',
      package: pkg,
      receiptToken: TOKEN_DONE,
      receiptLinkAt: '2026-11-12T06:00:00.000Z',
      receipt: { state: 'match', at: '2026-11-13T09:00:00.000Z', via: 'link' },
    }),
    // 还没有回执链接：没有可换的
    project('prj_nolink', '还没有回执链接', { ...base, id: 'ab12ab12ab120016' }),
    // 已经换过一条：工作台与档案读它
    project('prj_relinked', '换过一条新地址', {
      ...base,
      id: 'ab12ab12ab120017',
      receiptToken: TOKEN_RELINKED,
      receiptLinkAt: '2026-11-15T07:00:00.000Z',
      relinks: [{ at: '2026-11-15T07:00:00.000Z', resends: 2 }],
    }),
    // 升级前发的链接：不知道有没有人打开过，不换
    project('prj_legacy', '升级前的链接', {
      ...base,
      id: 'ab12ab12ab120018',
      receiptToken: TOKEN_LEGACY,
    }),
  ]),
  'utf8',
)
fs.writeFileSync(path.join(DIR, 'reviews.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'templates.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'flows.json'), JSON.stringify([]), 'utf8')

const domain = await import('../src/domain/delivery-relink.ts')
const ledgerModule = await import('../server/delivery-ledger.mjs')
const store = await import('../server/projects.mjs')
const { recordReceiptOpen } = await import('../server/receipt-visits.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')
const { createDeliveriesRouter } = await import('../server/routes/deliveries.mjs')

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

const ZERO = { opens: 0, firstAt: '', lastAt: '' }

test('换过几次怎么说：档案里带上「换掉之前那条发过几次」', () => {
  assert.equal(domain.deliveryRelinkText(null), '')
  assert.equal(domain.deliveryRelinkText({ count: 0 }), '')
  assert.equal(domain.deliveryRelinkText({ count: 1 }), '换过 1 次链接')
  assert.equal(domain.deliveryRelinkText({ count: 'x' }), '', '坏数字不写半个上去')

  // 没换过时 title 也要能说：「这条地址发过两次都没被打开，换一条新的」
  assert.equal(domain.deliveryRelinkHint(null), '')
  assert.match(domain.deliveryRelinkHint({ count: 0, resends: 0 }), /^$/)
  assert.match(domain.deliveryRelinkHint({ count: 0, resends: 2 }), /换一条新地址（旧的那条立刻打不开）$/)
  assert.match(domain.deliveryRelinkHint({ count: 2 }), /别再换地址了，先问他一句，或者换个收件人$/)

  assert.equal(domain.deliveryRelinkDetail(null), '')
  assert.equal(domain.deliveryRelinkDetail({ count: 1, resends: 2 }), '换过 1 次链接（上一条发过 2 次没打开）')
  assert.equal(domain.deliveryRelinkDetail({ count: 1, resends: 0 }), '换过 1 次链接')

  assert.equal(domain.deliveryRelinkedText(0), '')
  assert.equal(domain.deliveryRelinkedText(2), '其中 2 次连换过的地址也没人打开：问题可能不在链接上，先问他一句，或者换个收件人。')

  // 档案那一句：打开情况 + 换过几次 + 又发过几次，缺哪件就只说其余
  assert.equal(
    domain.deliveryArchiveLine(ZERO, null, { count: 1, resends: 2 }),
    '回执链接发出后还没被打开过 · 换过 1 次链接（上一条发过 2 次没打开）',
  )
  assert.equal(domain.deliveryArchiveLine(null, { count: 1 }, { count: 1, resends: 0 }), '又发过 1 次 · 换过 1 次链接')
  assert.equal(domain.deliveryArchiveLine(null, null, null), '', '什么都不知道就一个字都不写')

  // 档案里那串时间：空项不算一次
  assert.equal(domain.deliveryRelinkBrief(undefined), null)
  assert.equal(domain.deliveryRelinkBrief([]), null)
  assert.deepEqual(
    domain.deliveryRelinkBrief([
      { at: '2026-11-14T07:00:00.000Z', resends: 1 },
      { at: '2026-11-15T07:00:00.000Z', resends: 3 },
      { at: '' },
    ]),
    { count: 2, at: '2026-11-15T07:00:00.000Z', resends: 3 },
  )
})

test('换过链接的那段话：说清这是新地址、旧的那条打不开了', () => {
  const link = 'https://visionqa.example.com/#/receipt/' + TOKEN_RELINKED
  const text = domain.deliveryRelinkMessage({
    title: '又发过两次还没打开',
    version: 2,
    fileName: ZIP,
    bytes: 272155,
    at: '2026-11-13T06:00:00.000Z',
    link,
  })
  assert.match(text, /^又发过两次还没打开 第 v2 版那份包（VisionQA-换链接验收-第-2-版-v2-20261115.zip，272,155 B）我 11-13 发你的/)
  assert.match(text, /那条回执链接你那边一直没打开过，我换了一条新的/)
  assert.ok(text.includes(link), '新地址要原样带上')
  assert.match(text, /这一条和之前那条不是同一个地址，旧的那条已经打不开了/)
  assert.match(text, /要是这一条也打不开，跟我说一声，我换一种方式发给你。$/)
  // 只说记录里的事实：不说「你打不开」、不道歉、不承诺换包
  assert.doesNotMatch(text, /你打不开|抱歉|对不起|赔偿|重发一份新的包/)
  // 没有链接时退化成「把收据发我」，不编一条空地址
  const plain = domain.deliveryRelinkMessage({ title: 'X', version: 1, link: '' })
  assert.match(plain, /^X 第 v1 版那份包我上次发你的，那条回执链接你那边一直没打开过。/)
  assert.doesNotMatch(plain, /#\/receipt\//)
})

test('换链接记在档案里：旧 token 立刻打不开，重发次数清零，换掉之前那条发过几次折进去', async () => {
  const issued = await store.saveDeliveryRelink('prj_stuck', 'ab12ab12ab120011')
  assert.match(issued.token, /^[0-9a-f]{16}$/)
  assert.notEqual(issued.token, TOKEN_STUCK, '换的是地址')
  assert.equal(issued.resendsBefore, 2, '换掉之前那条发过两次')
  assert.equal(issued.count, 1)

  const row = (await store.getProject('prj_stuck')).deliveries[0]
  assert.equal(row.receiptToken, issued.token)
  assert.equal(row.receiptLinkAt, issued.at, '新地址从这一刻开始记打开次数')
  assert.equal(row.resends, undefined, '重发次数指的是旧地址，换了就清零')
  assert.equal(row.relinks.length, 1)
  assert.equal(row.relinks[0].resends, 2)
  assert.equal(row.package.bytes, 272155, '只换地址，包一个字都不动')
  assert.equal(row.package.sha256, SHA)

  // 旧地址立刻不认，新地址认得出来：换完的东西真的是一枚能用的地址
  assert.equal(await store.findReceiptLink(TOKEN_STUCK), null, '旧的这条已经打不开了')
  const found = await store.findReceiptLink(issued.token)
  assert.equal(found?.project?.id, 'prj_stuck')

  // 再多换几次：只留五条；每次都把上一条发过几次记下来
  for (let i = 0; i < 6; i += 1) await store.saveDeliveryRelink('prj_cap', 'ab12ab12ab120012')
  const capped = (await store.getProject('prj_cap')).deliveries[0]
  assert.equal(capped.relinks.length, 5, '最多留五次，再多也改变不了什么')

  // 三种「换不了」照实退回
  assert.equal((await store.saveDeliveryRelink('prj_done', 'ab12ab12ab120015')).already, true, '已经贴过回执的不再换')
  assert.equal((await store.saveDeliveryRelink('prj_nolink', 'ab12ab12ab120016')).missingLink, true, '还没有链接就没得换')
  assert.equal(await store.saveDeliveryRelink('prj_missing', 'ab12ab12ab120011'), null)
  assert.equal(await store.saveDeliveryRelink('prj_stuck', 'ab12ab12ab129999'), null, '没有封存包的不给换')
})

test('换链接端点：换一枚新 token，旧地址 404，已经贴过回执的 409', async () => {
  const router = createProjectsRouter()
  const ok = await call(router, '/api/projects/prj_endpoint/delivery-packages/ab12ab12ab120013/relink', { method: 'POST' })
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.resendsBefore, 2)
  assert.equal(payload.count, 1)
  assert.match(payload.token, /^[0-9a-f]{16}$/)
  assert.notEqual(payload.token, TOKEN_ENDPOINT)

  // 换完：旧地址打不开，新地址能打开
  const old = await call(router, '/api/receipts/' + TOKEN_ENDPOINT)
  assert.equal(old.status, 404)
  const fresh = await call(router, '/api/receipts/' + payload.token)
  assert.equal(fresh.status, 200)

  const get = await call(router, '/api/projects/prj_endpoint/delivery-packages/ab12ab12ab120013/relink')
  assert.equal(get.status, 405)

  const done = await call(router, '/api/projects/prj_done/delivery-packages/ab12ab12ab120015/relink', { method: 'POST' })
  assert.equal(done.status, 409)
  assert.equal(JSON.parse(done.body).code, 'RECEIPT_ALREADY')

  const nolink = await call(router, '/api/projects/prj_nolink/delivery-packages/ab12ab12ab120016/relink', { method: 'POST' })
  assert.equal(nolink.status, 409)
  assert.equal(JSON.parse(nolink.body).code, 'NO_RECEIPT_LINK')

  const missing = await call(router, '/api/projects/prj_endpoint/delivery-packages/ab12ab12ab129999/relink', { method: 'POST' })
  assert.equal(missing.status, 404)
})

test('被打开过的地址不给换：对方可能正看着它', async () => {
  // 收包人真的点开过一次（这个记录与回执、与重发都分开存）
  await recordReceiptOpen(TOKEN_OPENED, 'Mozilla/5.0 (Windows NT 10.0)', Date.now())
  const router = createProjectsRouter()
  const res = await call(router, '/api/projects/prj_opened/delivery-packages/ab12ab12ab120014/relink', { method: 'POST' })
  assert.equal(res.status, 409)
  const payload = JSON.parse(res.body)
  assert.equal(payload.code, 'LINK_OPENED')
  assert.match(payload.error, /打开过 1 次/)
  assert.match(payload.error, /别换地址/)
  // 没有真的换掉：档案里还是那条地址
  const row = (await store.getProject('prj_opened')).deliveries[0]
  assert.equal(row.receiptToken, TOKEN_OPENED)
})

test('工作台那一行：又发过两次才给「换一条新链接」，换过的照实记下来', () => {
  const projects = [
    project('p_stuck', '又发过两次', {
      ...base,
      id: 'cd34cd34cd340011',
      receiptToken: TOKEN_STUCK,
      receiptLinkAt: base.at,
      resends: [{ at: '2026-11-14T07:00:00.000Z' }, { at: '2026-11-15T07:00:00.000Z' }],
    }),
    project('p_cold', '还没重发过', { ...base, id: 'cd34cd34cd340012', receiptToken: TOKEN_CAP, receiptLinkAt: base.at }),
    project('p_opened', '打开过', { ...base, id: 'cd34cd34cd340013', receiptToken: TOKEN_ENDPOINT, receiptLinkAt: base.at }),
    project('p_unknown', '升级前的链接', { ...base, id: 'cd34cd34cd340014', receiptToken: TOKEN_LEGACY }),
    project('p_relinked', '已经换过一条', {
      ...base,
      id: 'cd34cd34cd340015',
      receiptToken: TOKEN_RELINKED,
      receiptLinkAt: base.at,
      relinks: [{ at: '2026-11-15T07:00:00.000Z', resends: 2 }],
    }),
  ]
  const now = Date.parse('2026-11-16T00:00:00.000Z')
  const seen = {
    'p_stuck:cd34cd34cd340011': ZERO,
    'p_cold:cd34cd34cd340012': ZERO,
    'p_opened:cd34cd34cd340013': { opens: 3, firstAt: '2026-11-14T07:00:00.000Z', lastAt: '2026-11-15T07:00:00.000Z' },
    'p_unknown:cd34cd34cd340014': ZERO,
    'p_relinked:cd34cd34cd340015': ZERO,
  }
  const ledger = ledgerModule.deliveryLedger({ projects, visits: seen }, { offset: 0, limit: 20, now })
  const rows = Object.fromEntries(ledger.items.map((row) => [row.projectId, row]))

  assert.equal(rows.p_stuck.relinkable, true, '又发过两次还没打开：该换一条新地址')
  assert.equal(rows.p_stuck.relink, null, '还没换过')
  assert.equal(rows.p_cold.relinkable, false, '只发过一次：先再发一次，别急着换')
  assert.equal(rows.p_cold.resendable, true)
  assert.equal(rows.p_opened.relinkable, false, '打开过了：地址是好的，换掉只会更糟')
  assert.equal(rows.p_unknown.relinkable, false, '不知道有没有人打开过：不换')
  assert.equal(rows.p_relinked.relinkable, false, '已经换过一条新地址：先把它发出去')
  assert.equal(rows.p_relinked.resendable, true, '换了地址之后又可以「再发一次」了')
  assert.equal(rows.p_relinked.relink.count, 1)
  assert.equal(rows.p_relinked.relink.resends, 2)
  assert.equal(domain.deliveryRelinkDetail(rows.p_relinked.relink), '换过 1 次链接（上一条发过 2 次没打开）')

  // 顶上的数：换过新地址、新地址也没人打开的有几条
  assert.equal(ledger.receipts.pendingRelinked, 1)
  assert.ok(ledger.receipts.pendingRelinked <= ledger.receipts.pendingUnopened, 'pendingRelinked 也是子集')
  assert.equal(
    ledger.receipts.sealed,
    ledger.receipts.matched + ledger.receipts.mismatched + ledger.receipts.unclear + ledger.receipts.pending,
    '加上 pendingRelinked 之后 sealed 仍然对得上',
  )
})

test('接口把这些数交给工作台：给换过几次，不给 token', async () => {
  const router = createDeliveriesRouter()
  const res = await call(router, '/api/deliveries')
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  const row = payload.items.find((item) => item.projectId === 'prj_relinked')
  assert.equal(row.relink.count, 1)
  assert.equal(row.relink.resends, 2)
  assert.equal(row.relinkable, false, '已经换过一条、还没发出去：按钮先回到「再发一次」')
  assert.equal(row.resendable, true)
  assert.equal(res.body.includes(TOKEN_RELINKED), false, '接口不给 token')
  assert.equal(typeof payload.receipts.pendingRelinked, 'number')
})
