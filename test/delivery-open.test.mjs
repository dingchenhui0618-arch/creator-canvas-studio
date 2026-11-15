import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 回执链接被打开过没有（v0.9.145）：一份包发出去几天没回音，要分清两件事——
// 「他根本没点开这条链接」（先把链接再发一次）和「他点开了，收据还没贴回来」（催他验）。
// 这一组盯五件事：
//   1) 记的是「这条地址被打开过几次」，不知道就什么都不说，绝不写成「还没被打开」；
//   2) 一分钟内刷新算一次，记录文件里没有能打开作品的 token；
//   3) 链接发出时间落在档案里，换一条链接从头开始记；
//   4) 工作台那一行、清单顶上那句、作品页那一行读同一份事实；
//   5) 收包人那一侧（公开接口）一个字都不提被统计。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-open-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-open'

const SHA = 'c970584a7ffd' + 'a'.repeat(52)
const ZIP = 'VisionQA-打开记录验收-第-2-版-v2-20261115.zip'
const pkg = { bytes: 272155, sha256: SHA, fileName: ZIP, savedAt: '2026-11-14T06:00:00.000Z' }
const TOKEN_SEEN = '0123456789abcdef'
const TOKEN_NONE = 'fedcba9876543210'
const TOKEN_OLD = '0011223344556677'
const TOKEN_PLAIN = '9988776655443322'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'

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
    createdAt: '2026-11-14T05:00:00.000Z',
    updatedAt: '2026-11-14T06:00:00.000Z',
  }
}

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    // 链接发出去之后被打开过两次、收据还没贴回来
    project('prj_seen', '打开过的链接', {
      version: 2,
      at: '2026-11-14T06:00:00.000Z',
      id: 'aaaaaaaaaaaaaaaa',
      package: pkg,
      receiptToken: TOKEN_SEEN,
      receiptLinkAt: '2026-11-14T06:00:00.000Z',
    }),
    // 链接发出去还没被打开过
    project('prj_none', '没人点开的链接', {
      version: 2,
      at: '2026-11-13T06:00:00.000Z',
      id: 'bbbbbbbbbbbbbbbb',
      package: pkg,
      receiptToken: TOKEN_NONE,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
    }),
    // 升级前发的链接：那时候还没开始记，不能说「还没被打开」
    project('prj_plain', '升级前的链接', {
      version: 2,
      at: '2026-11-12T06:00:00.000Z',
      id: 'dddddddddddddddd',
      package: pkg,
      receiptToken: TOKEN_PLAIN,
    }),
    // 补发出时间、换一条链接都用这一条（上面那条留着不动，好核对「不知道就不说」）
    project('prj_old', '老链接', {
      version: 2,
      at: '2026-11-10T06:00:00.000Z',
      id: 'cccccccccccccccc',
      package: pkg,
      receiptToken: TOKEN_OLD,
    }),
    // 没有封存包：读出来连 token 都不该有
    project('prj_legacy', '没有包的老记录', {
      version: 1,
      at: '2026-11-09T06:00:00.000Z',
      receiptToken: '1111111111111111',
    }),
  ]),
  'utf8',
)
fs.writeFileSync(path.join(DIR, 'reviews.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'templates.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'flows.json'), JSON.stringify([]), 'utf8')

const domain = await import('../src/domain/delivery-open.ts')
const ledgerModule = await import('../server/delivery-ledger.mjs')
const store = await import('../server/projects.mjs')
const visits = await import('../server/receipt-visits.mjs')
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

async function call(router, pathname, { method = 'GET', userAgent = '' } = {}) {
  const url = new URL('http://localhost' + pathname)
  const res = fakeRes()
  const req = { method, headers: userAgent ? { 'user-agent': userAgent } : {} }
  await router.handle(req, res, url, url.pathname)
  return res
}

// 时间按本地时区写：这一层读的就是本地时间，测试跟着本机时区走，换一台机器也照样对
function localIso(y, m, d, h, mi) {
  return new Date(y, m - 1, d, h, mi, 0, 0).toISOString()
}

test('打开次数读成人话：不知道就什么都不说', () => {
  const seen = { opens: 2, firstAt: localIso(2026, 11, 14, 7, 0), lastAt: localIso(2026, 11, 15, 8, 42) }
  assert.equal(domain.deliveryOpenCount(seen), 2)
  assert.equal(domain.deliveryOpenShort(seen), '链接打开 2 次')
  assert.equal(domain.deliveryOpenShort({ opens: 0, firstAt: '', lastAt: '' }), '链接还没打开')
  assert.equal(domain.deliveryOpenDetail(seen), '回执链接打开过 2 次 · 最近 11-15 08:42')
  assert.equal(domain.deliveryOpenDetail({ opens: 0, firstAt: '', lastAt: '' }), '回执链接发出后还没被打开过')
  assert.match(domain.deliveryOpenHint(seen), /^回执链接打开过 2 次，最近 11-15 08:42：链接是送到了/)
  assert.match(domain.deliveryOpenHint({ opens: 0, firstAt: '', lastAt: '' }), /可能没送到，先把链接再发他一次$/)
  // 不知道（升级前发的链接 / 根本没有链接）：一句都不说，不编「还没被打开」
  for (const unknown of [null, undefined]) {
    assert.equal(domain.deliveryOpenShort(unknown), '')
    assert.equal(domain.deliveryOpenDetail(unknown), '')
    assert.equal(domain.deliveryOpenHint(unknown), '')
  }
  // 次数是坏的（负数、小数、字符串）：按 0 算，不把半个数字写上去
  assert.equal(domain.deliveryOpenCount({ opens: -3, firstAt: '', lastAt: '' }), 0)
  assert.equal(domain.deliveryOpenCount({ opens: 2.4, firstAt: '', lastAt: '' }), 2)
  assert.equal(domain.deliveryOpenCount({ opens: 'x', firstAt: '', lastAt: '' }), 0)
  // 最近一次时间读不出来：只说次数，不编一个时间
  assert.equal(domain.deliveryOpenDetail({ opens: 1, firstAt: '', lastAt: '' }), '回执链接打开过 1 次')
  assert.equal(domain.deliveryUnopenedText(1), '其中 1 次回执链接还没被打开过：可能没送到，先再发一次。')
  assert.equal(domain.deliveryUnopenedText(0), '')
})

test('打开一次记一次：一分钟内刷新不算新的，记录文件里没有原始 token', async () => {
  const t0 = Date.parse('2026-11-15T09:00:00.000Z')
  const first = await visits.recordReceiptOpen(TOKEN_SEEN, IPHONE, t0)
  assert.equal(first.opens, 1)
  assert.equal(first.firstAt, '2026-11-15T09:00:00.000Z')
  const refreshed = await visits.recordReceiptOpen(TOKEN_SEEN, IPHONE, t0 + 30_000)
  assert.equal(refreshed.opens, 1, '30 秒后的刷新不该多算一次')
  assert.equal(refreshed.lastAt, '2026-11-15T09:00:30.000Z', '最近一次要跟着往前推')
  const later = await visits.recordReceiptOpen(TOKEN_SEEN, IPHONE, t0 + visits.OPEN_DEDUPE_MS + 1)
  assert.equal(later.opens, 2)

  const raw = fs.readFileSync(path.join(DIR, 'receipt-visits.json'), 'utf8')
  assert.ok(!raw.includes(TOKEN_SEEN), '记录文件里不该出现原始 token')
  assert.ok(raw.includes(visits.visitKey(TOKEN_SEEN)), '记的是哈希前缀')
  // 坏 token 不记：太短的字符串不是一条能打开的地址
  assert.equal((await visits.recordReceiptOpen('short', IPHONE, t0)).opens, 0)
  // 没打开过的是全零，不是 null
  assert.deepEqual(await visits.getReceiptVisits(TOKEN_NONE), { opens: 0, firstAt: '', lastAt: '', lastClient: '' })
})

test('链接发出时间落在档案里：换一条从头开始记，老链接补一次发出时间', async () => {
  const issued = await store.issueDeliveryReceiptToken('prj_old', 'cccccccccccccccc')
  assert.equal(issued.token, TOKEN_OLD, '在用的那一枚还回去，不把已经发出去的地址作废')
  const project = await store.getProject('prj_old')
  const row = project.deliveries.find((entry) => entry.id === 'cccccccccccccccc')
  assert.match(row.receiptLinkAt, /^\d{4}-\d{2}-\d{2}T/, '升级前的链接现在补上发出时间，从此开始记打开次数')
  assert.equal(row.package.bytes, 272155, '补时间不改包')

  // 换一条：新 token 是从这一刻开始记的，旧 token 的打开记录留在自己的键下
  const rotated = await store.issueDeliveryReceiptToken('prj_old', 'cccccccccccccccc', null, { rotate: true })
  assert.notEqual(rotated.token, TOKEN_OLD)
  assert.ok(rotated.delivery.receiptLinkAt)
  const afterRotate = (await store.getProject('prj_old')).deliveries[0]
  assert.equal(afterRotate.receiptToken, rotated.token)
  assert.equal(await visits.getReceiptVisits(rotated.token).then((v) => v.opens), 0, '新链接还没被打开过')
  assert.equal((await visits.getReceiptVisits(TOKEN_OLD)).opens, 0, '旧链接的记录还在，只是没人打开过')
  assert.equal(await store.findReceiptLink(TOKEN_OLD), null, '旧地址已经打不开了')

  // 没有包的记录：发不出链接，也就没有发出时间
  assert.equal(await store.issueDeliveryReceiptToken('prj_legacy', 'aaaaaaaaaaaaaaaa'), null)
})

test('收包人打开链接记一次：公开视图不提统计，档案里的包与时间不动', async () => {
  const projectsRouter = createProjectsRouter()
  const before = await store.getProject('prj_none')
  const opened = await call(projectsRouter, '/api/receipts/' + TOKEN_NONE, { userAgent: IPHONE })
  assert.equal(opened.status, 200)
  assert.match(opened.body, /没人点开的链接/)
  assert.doesNotMatch(opened.body, /opens|visits|firstAt|lastClient|receipt-visits/)

  const seen = await visits.getReceiptVisits(TOKEN_NONE)
  assert.equal(seen.opens, 1)
  assert.equal(seen.lastClient, 'mobile')
  // 同一分钟刷新不算新的
  await call(projectsRouter, '/api/receipts/' + TOKEN_NONE, { userAgent: IPHONE })
  assert.equal((await visits.getReceiptVisits(TOKEN_NONE)).opens, 1)

  // 档案里的包、交付时间一个字不动；打开记录不写进 projects.json
  const after = await store.getProject('prj_none')
  assert.deepEqual(after.deliveries[0].package, before.deliveries[0].package)
  assert.equal(after.deliveries[0].at, before.deliveries[0].at)
  assert.equal(after.deliveries[0].visits, undefined, '打开次数不进 projects.json')
  const rawProjects = fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8')
  assert.doesNotMatch(rawProjects, /opens/)

  // 坏 token：404，也不记
  const bad = await call(projectsRouter, '/api/receipts/0123456789abcdee', { userAgent: IPHONE })
  assert.equal(bad.status, 404)

  // 作品详情：只给「发链接时已经开始记」的那几条打开情况
  const detail = await call(projectsRouter, '/api/projects/prj_none')
  assert.equal(detail.status, 200)
  const payload = JSON.parse(detail.body)
  assert.equal(payload.project.deliveries[0].visits.opens, 1)
  const plain = JSON.parse((await call(projectsRouter, '/api/projects/prj_plain')).body)
  assert.equal(plain.project.deliveries[0].visits, undefined, '升级前发的链接不说「还没被打开」')
  assert.equal(plain.project.deliveries[0].receiptToken, TOKEN_PLAIN, '链接本身还在，只是不知道有没有人点开过')

  // 列表接口不带打开记录
  const list = await call(projectsRouter, '/api/projects')
  assert.doesNotMatch(list.body, /visits/)
})

test('工作台那一行：知道打开过就说几次，不知道就不说；顶上那句只数不知道的', async () => {
  const projects = await store.listProjects(null)
  const seen = await visits.getReceiptVisits(TOKEN_SEEN)
  const none = await visits.getReceiptVisits(TOKEN_NONE)
  const map = {
    'prj_seen:aaaaaaaaaaaaaaaa': seen,
    'prj_none:bbbbbbbbbbbbbbbb': none,
  }
  const ledger = ledgerModule.deliveryLedger(
    { projects, visits: map },
    { offset: 0, limit: 20, now: Date.parse('2026-11-16T00:00:00.000Z') },
  )
  const rows = Object.fromEntries(ledger.items.map((row) => [row.projectId, row]))
  assert.equal(rows.prj_seen.visits.opens, 2)
  assert.equal(domain.deliveryOpenShort(rows.prj_seen.visits), '链接打开 2 次')
  assert.equal(rows.prj_none.visits.opens, 1, '上面那一组已经点开过一次')
  assert.equal(rows.prj_plain.visits, null, '升级前发的链接：不知道，不说')
  assert.equal(domain.deliveryOpenShort(rows.prj_plain.visits), '', '不知道就一句都不写')

  // 还没收到回执的有四条，其中「一次都没被打开」的是哪几条要数得准
  const fresh = ledgerModule.deliveryLedger(
    {
      projects,
      visits: {
        'prj_seen:aaaaaaaaaaaaaaaa': { opens: 0, firstAt: '', lastAt: '' },
        'prj_none:bbbbbbbbbbbbbbbb': { opens: 0, firstAt: '', lastAt: '' },
        'prj_old:cccccccccccccccc': { opens: 0, firstAt: '', lastAt: '' },
      },
    },
    { offset: 0, limit: 20, now: Date.parse('2026-11-16T00:00:00.000Z') },
  )
  assert.equal(fresh.receipts.sealed, 4, '只有四条封了包')
  assert.equal(fresh.receipts.pending, 4)
  assert.equal(fresh.receipts.pendingUnopened, 3, '三条打开次数是 0；升级前那条不知道，不算进来')
  assert.equal(
    fresh.receipts.sealed,
    fresh.receipts.matched + fresh.receipts.mismatched + fresh.receipts.unclear + fresh.receipts.pending,
    'pendingUnopened 是 pending 的子集，不是第五种结论',
  )
  assert.equal(domain.deliveryUnopenedText(fresh.receipts.pendingUnopened), '其中 3 次回执链接还没被打开过：可能没送到，先再发一次。')

  // 收据回来之后就不再算「还没回来」，也不再挂 unanswered 的 count
  const answered = ledgerModule.deliveryLedger(
    {
      projects: projects.map((entry) =>
        entry.id === 'prj_seen'
          ? { ...entry, deliveries: [{ ...entry.deliveries[0], receipt: { at: '2026-11-15T10:00:00.000Z', state: 'match' } }] }
          : entry,
      ),
      visits: map,
    },
    { offset: 0, limit: 20, now: Date.parse('2026-11-16T00:00:00.000Z') },
  )
  const answeredRow = answered.items.find((row) => row.projectId === 'prj_seen')
  assert.equal(answeredRow.visits.opens, 2, '回执回来了，打开过几次仍然照实写')
  assert.equal(answered.receipts.pending, 3)
  assert.equal(answered.receipts.pendingUnopened, 1, '收到回执的那一份不再算「还没回来」，也不再算没被打开')
})

test('工作台的交付接口把这些数算给它：/api/deliveries 不带 token、只带次数', async () => {
  const router = createDeliveriesRouter()
  const res = await call(router, '/api/deliveries')
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  const row = payload.items.find((item) => item.projectId === 'prj_none')
  assert.equal(row.visits.opens, 1)
  assert.equal(row.visits.lastClient, undefined, '只给次数与首末时间，不给客户端分类')
  assert.equal(res.body.includes(TOKEN_NONE), false, '接口不给 token')
  assert.equal(typeof payload.receipts.pendingUnopened, 'number')
})
