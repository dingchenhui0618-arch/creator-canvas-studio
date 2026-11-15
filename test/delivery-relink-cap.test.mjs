import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 换到头了（v0.9.150）。
// r157 起工具一路在文案里劝「别再换地址了」，可按钮一直还在给换——换到第三次也一样。
// 这一组盯的是那句劝变成真的：
//   1) 换过两次之后，服务端两条路都不再换（relink 与作品页那条「换一条」），且一个字节都不改；
//   2) 没到上限的那条照旧能换：上限是两次，不是一次；
//   3) 工作台那一行到上限就不给换、也不给再发，状态单独说「地址换到头了」；
//   4) 打开过的就算换过两次也不算「换到头」（问题不在送没送到）；
//   5) 行上那句话与「问他一句」那段话：只写记录里的事实，不编次数。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-relink-cap-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-relink-cap'

const SHA = 'f6a7b8c9d0e1' + 'f'.repeat(52)
const ZIP = 'VisionQA-换到头了-第-3-版-v3-20261115.zip'
const pkg = { bytes: 271777, sha256: SHA, fileName: ZIP, savedAt: '2026-11-14T06:00:00.000Z' }
const ID_CAPPED = 'ab12ab12ab121001'
const ID_ONCE = 'ab12ab12ab121002'
const ID_OPENED = 'ab12ab12ab121003'
const ID_FRESH = 'ab12ab12ab121004'
const TOKEN_CAPPED = 'a1b2c3d4e5f60718'
const TOKEN_ONCE = 'b2c3d4e5f6071829'
const TOKEN_OPENED = '9999aaaabbbbcccc'
const TOKEN_FRESH = 'ddddeeeeffff0000'
const TOKEN_LEGACY = 'ec0a1b2c3d4e5f60'

function project(id, title, delivery) {
  return {
    id,
    ownerId: 'u_a',
    title,
    flowId: 'flow_' + id,
    version: 3,
    versions: [],
    status: 'done',
    deliveries: [delivery],
    createdAt: '2026-11-12T05:00:00.000Z',
    updatedAt: '2026-11-14T06:00:00.000Z',
  }
}

const base = { version: 3, at: '2026-11-11T06:00:00.000Z', package: pkg }
const TWO_RELINKS = [
  { at: '2026-11-13T07:00:00.000Z', resends: 2 },
  { at: '2026-11-14T07:00:00.000Z', resends: 2 },
]
const RETIRED = [
  { key: 'aaaabbbbccccdddd', at: '2026-11-13T07:00:00.000Z' },
  { key: 'eeeeffff00001111', at: '2026-11-14T07:00:00.000Z' },
]
const TWO_RESENDS = [{ at: '2026-11-14T08:00:00.000Z' }, { at: '2026-11-15T08:00:00.000Z' }]

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    // 已经换过两次、两条地址都没被打开：不再给换
    project('prj_capped', '换过两次地址都没打开', {
      ...base,
      id: ID_CAPPED,
      receiptToken: TOKEN_CAPPED,
      receiptLinkAt: base.at,
      resends: TWO_RESENDS,
      relinks: TWO_RELINKS,
      retired: RETIRED,
    }),
    // 只换过一次：照旧能换（上限是两次）
    project('prj_once', '只换过一次', {
      ...base,
      id: ID_ONCE,
      receiptToken: TOKEN_ONCE,
      receiptLinkAt: base.at,
      resends: TWO_RESENDS,
      relinks: [TWO_RELINKS[0]],
      retired: [RETIRED[0]],
    }),
    // 换过两次，但对方打开过：问题不在送没送到，不算换到头
    project('prj_opened', '换过两次、打开过', {
      ...base,
      id: ID_OPENED,
      receiptToken: TOKEN_OPENED,
      receiptLinkAt: base.at,
      resends: TWO_RESENDS,
      relinks: TWO_RELINKS,
      retired: RETIRED,
    }),
    // 换过两次、但新地址还没重发过：仍然算换到头（换地址这件事到头了）
    project('prj_fresh', '换过两次还没重发', {
      ...base,
      id: ID_FRESH,
      receiptToken: TOKEN_FRESH,
      receiptLinkAt: base.at,
      relinks: TWO_RELINKS,
      retired: RETIRED,
    }),
    // 升级前换过很多次的老记录：读的时候仍然只留最近 5 条（上限收在 5 条，不是 2 条——
    // 2 条是「给不给换」的规矩，5 条是「一条记录能有多长」的防线）
    project('prj_legacy', '老记录换过六次', {
      ...base,
      id: 'ab12ab12ab121005',
      receiptToken: TOKEN_LEGACY,
      receiptLinkAt: base.at,
      relinks: [
        { at: '2026-11-09T07:00:00.000Z', resends: 1 },
        { at: '2026-11-10T07:00:00.000Z', resends: 1 },
        { at: '2026-11-11T07:00:00.000Z', resends: 1 },
        { at: '2026-11-12T07:00:00.000Z', resends: 1 },
        { at: '2026-11-13T07:00:00.000Z', resends: 1 },
        { at: '2026-11-14T07:00:00.000Z', resends: 1 },
      ],
      retired: [
        { key: 'a000000000000001', at: '2026-11-09T07:00:00.000Z' },
        { key: 'a000000000000002', at: '2026-11-10T07:00:00.000Z' },
        { key: 'a000000000000003', at: '2026-11-11T07:00:00.000Z' },
        { key: 'a000000000000004', at: '2026-11-12T07:00:00.000Z' },
        { key: 'a000000000000005', at: '2026-11-13T07:00:00.000Z' },
        { key: 'a000000000000006', at: '2026-11-14T07:00:00.000Z' },
      ],
    }),
  ]),
  'utf8',
)
fs.writeFileSync(path.join(DIR, 'reviews.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'templates.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'flows.json'), JSON.stringify([]), 'utf8')

const store = await import('../server/projects.mjs')
const { ledgerRows } = await import('../server/delivery-ledger.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')
const relinkDomain = await import('../src/domain/delivery-relink.ts')
const askDomain = await import('../src/domain/delivery-ask.ts')

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

// 这两个端点会读 JSON 请求体：假 req 要能被 for await 读到，否则读体会抛
function fakeReq(method = 'GET', body = null) {
  const text = body ? JSON.stringify(body) : ''
  return {
    method,
    headers: text ? { 'content-length': String(Buffer.byteLength(text)) } : {},
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text, 'utf8')
    },
  }
}

async function call(router, pathname, { method = 'GET', body = null } = {}) {
  const url = new URL('http://localhost' + pathname)
  const res = fakeRes()
  await router.handle(fakeReq(method, body), res, url, url.pathname)
  return res
}

function readRaw() {
  return fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8')
}

test('换到第三次：服务端不再换，一个字节都不改', async () => {
  const before = readRaw()
  const capped = await store.saveDeliveryRelink('prj_capped', ID_CAPPED)
  assert.equal(capped.capped, true, '已经换过两次：不该再换')
  assert.equal(capped.count, 2)
  assert.equal(readRaw(), before, '被拦住时不该写盘')
  const row = (await store.getProject('prj_capped')).deliveries[0]
  assert.equal(row.receiptToken, TOKEN_CAPPED, '地址没被换掉')
  assert.equal(row.relinks.length, 2, '换过几次也没被改写')
  assert.equal(row.retired.length, 2, '旧地址的记号没被动')
})

test('换链接端点：第三次回 409 LINK_ROTATE_LIMIT，正文里没有 token', async () => {
  const router = createProjectsRouter()
  const res = await call(router, '/api/projects/prj_capped/delivery-packages/' + ID_CAPPED + '/relink', { method: 'POST' })
  assert.equal(res.status, 409, '不是 500、也不是又换了一条：' + res.status)
  const payload = JSON.parse(res.body)
  assert.equal(payload.code, 'LINK_ROTATE_LIMIT')
  assert.match(payload.error, /换过 2 次地址都没被打开/, '说清换过几次：' + payload.error)
  assert.match(payload.error, /先问他一句，或者换个收件人/, '说清下一步：' + payload.error)
  assert.equal(res.body.includes(TOKEN_CAPPED), false, '409 里不给地址')
})

test('作品页那条「换一条」也守同一条上限：两条路说法一致', async () => {
  const capped = await store.issueDeliveryReceiptToken('prj_capped', ID_CAPPED, null, { rotate: true })
  assert.equal(capped.capped, true, '这条路也不该再换')
  const router = createProjectsRouter()
  const blocked = await call(router, '/api/projects/prj_capped/delivery-packages/' + ID_CAPPED + '/receipt-link', {
    method: 'POST',
    body: { rotate: true },
  })
  assert.equal(blocked.status, 409)
  assert.equal(JSON.parse(blocked.body).code, 'LINK_ROTATE_LIMIT')
  // 不换的时候照旧把现在这枚还回来：「问他一句」就是靠它拼出地址
  const kept = await call(router, '/api/projects/prj_capped/delivery-packages/' + ID_CAPPED + '/receipt-link', {
    method: 'POST',
    body: { rotate: false },
  })
  assert.equal(kept.status, 200)
  const keptPayload = JSON.parse(kept.body)
  assert.equal(keptPayload.token, TOKEN_CAPPED)
  assert.equal(keptPayload.rotated, false)
})

test('上限是两次、不是一次：没到上限的那条照旧能换，换完就到头', async () => {
  const router = createProjectsRouter()
  const ok = await call(router, '/api/projects/prj_once/delivery-packages/' + ID_ONCE + '/relink', { method: 'POST' })
  assert.equal(ok.status, 200, '只换过一次：该给换')
  const payload = JSON.parse(ok.body)
  assert.equal(payload.count, 2)
  assert.match(payload.token, /^[0-9a-f]{16}$/)
  const row = (await store.getProject('prj_once')).deliveries[0]
  assert.notEqual(row.receiptToken, TOKEN_ONCE)
  const again = await call(router, '/api/projects/prj_once/delivery-packages/' + ID_ONCE + '/relink', { method: 'POST' })
  assert.equal(again.status, 409, '第二次换完就到头了：' + again.status)
  assert.equal(JSON.parse(again.body).code, 'LINK_ROTATE_LIMIT')
})

test('工作台那一行：到上限就不给换、也不给再发，状态写「地址换到头了」', async () => {
  const projects = await Promise.all(['prj_capped', 'prj_opened', 'prj_fresh'].map((id) => store.getProject(id)))
  const visits = {
    ['prj_capped:' + ID_CAPPED]: { opens: 0, firstAt: '', lastAt: '' },
    ['prj_opened:' + ID_OPENED]: { opens: 3, firstAt: '2026-11-12T07:00:00.000Z', lastAt: '2026-11-13T07:00:00.000Z' },
    ['prj_fresh:' + ID_FRESH]: { opens: 0, firstAt: '', lastAt: '' },
  }
  const rows = Object.fromEntries(ledgerRows({ projects, visits }).map((row) => [row.projectId, row]))
  assert.equal(rows.prj_capped.relinkable, false, '换到头了：不再给换')
  assert.equal(rows.prj_capped.relinkCapped, true, '状态单独说一声，好解释按钮为什么没了')
  assert.equal(rows.prj_capped.resendable, false, '同一条消息再发一遍也到头了')
  assert.equal(rows.prj_capped.remindable, true, '还能复制一段话自己发')
  assert.equal(rows.prj_capped.relink.count, 2)

  // 打开过的：地址是好的，问题不在送没送到——不算「换到头」
  assert.equal(rows.prj_opened.relinkCapped, false)
  assert.equal(rows.prj_opened.relinkable, false)

  // 换过两次但还没重发过：仍然算换到头（换地址这件事到头了）
  assert.equal(rows.prj_fresh.relinkCapped, true)
  assert.equal(rows.prj_fresh.relinkable, false)
})

test('老记录读得进去：换过六次的那条只留最近五条，仍然算换到头', async () => {
  const row = (await store.getProject('prj_legacy')).deliveries[0]
  assert.equal(row.relinks.length, 5, '记录长度上限仍是五条')
  assert.equal(row.retired.length, 5, '旧地址最多五条')
  assert.equal(row.relinks[0].at, '2026-11-10T07:00:00.000Z', '留的是最近五条')
  const ledger = ledgerRows({ projects: [await store.getProject('prj_legacy')] })[0]
  assert.equal(ledger.relink.count, 5, '界面照实说换过五次')
  assert.equal(ledger.relinkCapped, true, '早就过头了：同样不给换')
  assert.equal(ledger.relinkable, false)
})

test('行上那句话与 title：说清到头，不给数字上的承诺', () => {
  assert.equal(relinkDomain.deliveryRelinkCappedText(null), '')
  assert.equal(relinkDomain.deliveryRelinkCappedText({ count: 1 }), '')
  assert.equal(relinkDomain.deliveryRelinkCappedText({ count: 2 }), '地址换到头了')
  assert.equal(relinkDomain.deliveryRelinkCappedText({ count: 3 }), '地址换到头了')
  assert.equal(relinkDomain.RELINK_LIMIT, 2)
  const hint = relinkDomain.deliveryRelinkHint({ count: 2 })
  assert.match(hint, /换到头了/, 'title 要说清为什么没按钮了：' + hint)
  assert.match(hint, /先问他一句，或者换个收件人$/)
})

test('问他一句那段话：只写记录里的事实，带上现在这条地址', () => {
  const link = 'https://visionqa.example/#/receipt/0123456789abcdef'
  const text = askDomain.deliveryAskMessage({
    title: '毛衣折叠收纳法',
    version: 3,
    fileName: 'VisionQA-毛衣折叠收纳法-第-3-版-v3.zip',
    bytes: 271777,
    at: '2026-11-11T06:00:00.000Z',
    link,
  })
  assert.match(text, /^毛衣折叠收纳法 第 v3 版那份包（/, '开头说清是哪一份：' + text.slice(0, 60))
  assert.match(text, /271,777 B/, '带上字节数')
  assert.match(text, /我 11-11 发你的/)
  assert.match(text, /一次都没打开过/, '这一个是数出来的：' + text)
  assert.match(text, /是不是没收到/)
  assert.ok(text.includes(link), '带上现在这条地址')
  assert.match(text, /跟我说一声，我换个方式发/, '留一句退路')
  // 不编数字：不写「换了 2 次」「第三次」这类要用户去核对的账
  assert.doesNotMatch(text, /第三次|换了 \d+ 次|\d+ 次都没收到/)
  // 没有地址时也能说成一句（退化成「把收据发我」）
  const plain = askDomain.deliveryAskMessage({ title: 'X', version: 1, link: '' })
  assert.match(plain, /把收据发我就行/)
  assert.doesNotMatch(plain, /现在这条地址/)
})
