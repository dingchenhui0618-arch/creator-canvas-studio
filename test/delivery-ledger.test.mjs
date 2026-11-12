import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 交付流水（v0.9.32）：工作台要把「我交出去过什么」摊成一条线。
// 这一组盯四条口径：
//   1. 一次交付一行，新的在前；时间没记下的排最后，并且如实标 atKnown=false；
//   2. 「交的是不是当前版」与「这条作品现在还在不在交付状态」是两个事实，各说各的；
//   3. 一行上的结论是那一版的结论，不是作品现在的结论；
//   4. 总数、作品数、最近一次时间按全部记录算，翻页不重不漏。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-ledger-'))
process.env.DATA_DIR = dir

const at = (day, hour) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'

// 三条交付过的作品 + 一条没交过的 + 一条只交了当前版的
const projects = [
  // 交过 v1、v2，之后开了 v3：两条记录都还在，但都不是当前版了
  {
    id: 'prj_a',
    ownerId: 'u_a',
    title: '毛衣折叠收纳法',
    templateId: 'tpl_a',
    flowId: 'flow_3',
    version: 3,
    versions: [],
    status: 'done',
    deliveries: [
      { version: 1, at: at(3, 9) },
      { version: 2, at: at(9, 18) },
    ],
    createdAt: at(1, 0),
    updatedAt: at(9, 18),
  },
  // 交的就是当前这一版：current 与 deliveredNow 同时成立
  {
    id: 'prj_b',
    ownerId: 'u_a',
    title: '办公室午休垫',
    templateId: 'tpl_b',
    flowId: 'flow_b',
    version: 2,
    versions: [],
    status: 'done',
    deliveries: [{ version: 2, at: at(7, 12) }],
    createdAt: at(2, 0),
    updatedAt: at(7, 12),
  },
  // 老记录：交付时间没记下（开新版时补的那一条），排最后
  {
    id: 'prj_c',
    ownerId: 'u_a',
    title: '桌面收纳盒',
    templateId: '',
    flowId: 'flow_c',
    version: 1,
    versions: [],
    status: 'done',
    deliveries: [{ version: 1, at: '' }],
    createdAt: at(2, 1),
    updatedAt: at(2, 1),
  },
  // 从没交过：一行都不该有
  {
    id: 'prj_d',
    ownerId: 'u_a',
    title: '还没交的那条',
    templateId: '',
    flowId: '',
    version: 0,
    versions: [],
    status: 'active',
    createdAt: at(4, 0),
    updatedAt: at(4, 0),
  },
  // 坏记录：版次是 0 或缺失的跳过，宁可少一行也不编一版出来
  {
    id: 'prj_e',
    ownerId: 'u_a',
    title: '坏记录的那条',
    templateId: '',
    flowId: '',
    version: 1,
    versions: [],
    status: 'active',
    deliveries: [{ version: 0, at: at(5, 0) }, { version: null }, null],
    createdAt: at(5, 0),
    updatedAt: at(5, 0),
  },
]

const counts = {
  prj_a: {
    count: 3,
    lastVerdict: 'pass',
    lastAt: at(9, 18),
    versions: {
      '1': { count: 1, lastVerdict: 'needs_review', lastAt: at(3, 10) },
      '2': { count: 2, lastVerdict: 'pass', lastAt: at(9, 17) },
    },
  },
  prj_b: { count: 1, lastVerdict: 'pass', lastAt: at(7, 13), versions: { '2': { count: 1, lastVerdict: 'pass', lastAt: at(7, 13) } } },
}

const ledgerModule = () => import('../server/delivery-ledger.mjs')

test('一次交付一行、新的在前，时间没记下的排最后并标出来', async () => {
  const { ledgerRows } = await ledgerModule()
  const rows = ledgerRows({ projects, counts })
  assert.equal(rows.length, 4, '四条真交付记录，坏记录与没交过的不算')
  assert.deepEqual(rows.map((row) => row.projectId + '@v' + row.version), ['prj_a@v2', 'prj_b@v2', 'prj_a@v1', 'prj_c@v1'])
  assert.equal(rows[0].at, at(9, 18))
  assert.equal(rows[0].atKnown, true)
  assert.equal(rows[3].at, '')
  assert.equal(rows[3].atKnown, false, '时间没记下就如实说没记下')
})

test('当前版与还在交付状态是两个事实：开过新版的旧交付不能被说成现状', async () => {
  const { ledgerRows } = await ledgerModule()
  const rows = ledgerRows({ projects, counts })
  const old = rows.find((row) => row.projectId === 'prj_a')
  assert.equal(old.current, false, '交的是 v2，作品已经到 v3')
  assert.equal(old.currentVersion, 3)
  assert.equal(old.deliveredNow, false, 'status 还是 done，但交的不是当前版，不能算「已交付」')
  const live = rows.find((row) => row.projectId === 'prj_b')
  assert.equal(live.current, true)
  assert.equal(live.deliveredNow, true)
})

test('一行上的结论是那一版的结论，不是作品现在的结论', async () => {
  const { ledgerRows } = await ledgerModule()
  const rows = ledgerRows({ projects, counts })
  const v1 = rows.find((row) => row.projectId === 'prj_a' && row.version === 1)
  const v2 = rows.find((row) => row.projectId === 'prj_a' && row.version === 2)
  assert.equal(v1.verdict, 'needs_review', 'v1 当时是需人工确认')
  assert.equal(v1.reviews, 1)
  assert.equal(v2.verdict, 'pass')
  assert.equal(v2.reviews, 2)
  // 没有评审计数的那一行不编结论
  const noReview = rows.find((row) => row.projectId === 'prj_c')
  assert.equal(noReview.verdict, '')
  assert.equal(noReview.reviews, 0)
})

test('数字按全部记录算：翻页不重复不漏，也不会因为只取一页就变小', async () => {
  const { deliveryLedger, LEDGER_MAX_PAGE } = await ledgerModule()
  const all = deliveryLedger({ projects, counts })
  assert.equal(all.total, 4)
  assert.equal(all.projects, 3, '三条作品，不是四条记录')
  assert.equal(all.currentTotal, 2, 'prj_b 与 prj_c 交的还是当前版')
  assert.equal(all.lastAt, at(9, 18))
  assert.equal(all.items.length, 4)
  assert.equal(all.hasMore, false)

  const first = deliveryLedger({ projects, counts }, { offset: 0, limit: 2 })
  const second = deliveryLedger({ projects, counts }, { offset: 2, limit: 2 })
  assert.deepEqual(first.items.map((row) => row.projectId), ['prj_a', 'prj_b'])
  assert.deepEqual(second.items.map((row) => row.projectId), ['prj_a', 'prj_c'])
  assert.equal(first.total, second.total, '翻页不换总数')
  assert.equal(first.hasMore, true)
  assert.equal(second.hasMore, false)
  assert.equal(new Set([...first.items, ...second.items].map((row) => row.projectId + row.version)).size, 4, '两页拼起来不重不漏')

  const beyond = deliveryLedger({ projects, counts }, { offset: 99 })
  assert.equal(beyond.items.length, 0)
  assert.equal(beyond.total, 4, '越界是空的一页，总数照旧')
  assert.equal(beyond.hasMore, false)

  const tooBig = deliveryLedger({ projects, counts }, { limit: 999 })
  assert.equal(tooBig.items.length, 4)
  assert.ok(LEDGER_MAX_PAGE >= 4)
})

test('一条交付记录都没有：空流水而不是假的 0 条作品', async () => {
  const { deliveryLedger } = await ledgerModule()
  const empty = deliveryLedger({ projects: [], counts: {} })
  assert.deepEqual(empty.items, [])
  assert.equal(empty.total, 0)
  assert.equal(empty.projects, 0)
  assert.equal(empty.currentTotal, 0)
  assert.equal(empty.lastAt, '')
  const noDeliveries = deliveryLedger({ projects: [projects[3]], counts })
  assert.equal(noDeliveries.total, 0, '没交过的作品不进流水')
})

test('接口：GET /api/deliveries 给流水，方法不对 405', async () => {
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([
    {
      id: 'rv_1',
      ownerId: 'u_a',
      projectId: 'prj_b',
      version: 2,
      createdAt: at(7, 13),
      source: {},
      result: { verdict: 'pass' },
    },
  ], null, 2), 'utf8')

  const { createDeliveriesRouter } = await import('../server/routes/deliveries.mjs')
  const router = createDeliveriesRouter()
  const call = async (method, pathname) => {
    const res = {
      status: 0,
      body: '',
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers || {}
      },
      setHeader(key, value) {
        this.headers[key] = value
      },
      end(chunk) {
        this.body = String(chunk ?? '')
      },
      write(chunk) {
        this.body += String(chunk ?? '')
        return true
      },
      writableEnded: false,
    }
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() {} }
    const url = new URL('http://localhost' + pathname)
    await router.handle(req, res, url, url.pathname)
    return { status: res.status, body: JSON.parse(res.body || '{}') }
  }

  const got = await call('GET', '/api/deliveries')
  assert.equal(got.status, 200)
  assert.equal(got.body.total, 4)
  assert.equal(got.body.projects, 3)
  assert.equal(got.body.items[0].projectId, 'prj_a')
  assert.equal(got.body.items[0].version, 2)
  // 评审计数从评审库里现算：prj_b 那一版的是 pass
  assert.equal(got.body.items.find((row) => row.projectId === 'prj_b').verdict, 'pass')

  const page = await call('GET', '/api/deliveries?offset=2&limit=1')
  assert.equal(page.status, 200)
  assert.equal(page.body.items.length, 1)
  assert.equal(page.body.items[0].projectId, 'prj_a')
  assert.equal(page.body.total, 4)

  const wrong = await call('POST', '/api/deliveries')
  assert.equal(wrong.status, 405)
})
