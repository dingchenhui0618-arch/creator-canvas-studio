import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 队列的找法（v0.9.25）：时间范围按「那次评审的时间」算、关键字只搜作品标题。
// 这一组盯六条：范围边界、关键字分词（空格 AND、大小写不敏感）、计数与筛选同源、
// 筛出来的数与全量分开、看过的 / 拍过板的交代不跟着筛选变、主卡那一条（lead）也不跟着变。
// 日期都按「几天前」现算：范围是跟当前时间比的，写死某一天会随系统时钟一起过期。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-queue-filter-'))
process.env.DATA_DIR = dir

const DAY = 24 * 60 * 60 * 1000
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()

function project(id, ownerId, title) {
  return { id, ownerId, title, templateId: '', flowId: 'flow_' + id, version: 1, versions: [], status: 'active', createdAt: ago(60), updatedAt: ago(60) }
}

/**
 * prj_new    2 天前评出不通过        → 7 天内、30 天内、全部都在
 * prj_mid    12 天前评出需人工确认   → 30 天内 / 全部
 * prj_old    40 天前评出不通过       → 只有「全部」（标题带英文，验大小写）
 * prj_seen   3 天前评出、已看过      → 不进待办，但 seenTotal 照旧交代
 * prj_done   5 天前评出、已拍板通过  → 不进待办，decidedTotal 照旧交代
 * prj_other  u_b 的作品              → 不进我的队列
 */
// 时间只算一次：「已看过 / 拍过板」记的是那次评审的 createdAt，两边各自 ago() 会差几毫秒，
// 版次对得上、时间对不上，便利贴就会失效——这是口径本身的要求，不是容差能糊过去的。
const T = {
  new: ago(2),
  mid: ago(12),
  old: ago(40),
  seen: ago(3),
  done: ago(5),
  other: ago(1),
}

const reviews = [
  { id: 'rev_new', projectId: 'prj_new', title: '春季新品开箱', verdict: 'fail', at: T.new },
  { id: 'rev_mid', projectId: 'prj_mid', title: '春季毛衣折叠', verdict: 'needs_review', at: T.mid },
  { id: 'rev_old', projectId: 'prj_old', title: 'Coffee 咖啡机开箱', verdict: 'fail', at: T.old },
  { id: 'rev_seen', projectId: 'prj_seen', title: '夏季通勤穿搭', verdict: 'fail', at: T.seen },
  { id: 'rev_done', projectId: 'prj_done', title: '秋季露营布置', verdict: 'fail', at: T.done },
  { id: 'rev_other', projectId: 'prj_other', title: '春季别人的作品', verdict: 'fail', at: T.other },
]

fs.writeFileSync(
  path.join(dir, 'projects.json'),
  JSON.stringify(
    [
      project('prj_new', 'u_a', '春季新品开箱'),
      project('prj_mid', 'u_a', '春季毛衣折叠'),
      project('prj_old', 'u_a', 'Coffee 咖啡机开箱'),
      project('prj_seen', 'u_a', '夏季通勤穿搭'),
      project('prj_done', 'u_a', '秋季露营布置'),
      project('prj_other', 'u_b', '春季别人的作品'),
    ],
    null,
    2,
  ),
  'utf8',
)
fs.writeFileSync(
  path.join(dir, 'reviews.json'),
  JSON.stringify(
    reviews.map((item) => ({
      id: item.id,
      ownerId: item.projectId === 'prj_other' ? 'u_b' : 'u_a',
      projectId: item.projectId,
      version: 1,
      intent: '第 1 次评审',
      source: { kind: 'url', label: item.title, imageUrl: 'https://example.com/' + item.id + '.jpg' },
      result: { verdict: item.verdict, summary: '结论 ' + item.verdict, observations: [] },
      createdAt: item.at,
    })),
    null,
    2,
  ),
  'utf8',
)
// 看过的是「哪一版、哪一次评审」：时间对上才算数（v0.9.20）
fs.writeFileSync(
  path.join(dir, 'review-acks.json'),
  JSON.stringify([{ id: 'ack_seen', projectId: 'prj_seen', version: 1, reviewAt: T.seen, verdict: 'fail', at: ago(1), ownerId: 'u_a' }], null, 2),
  'utf8',
)
// 拍板同理：按那次评审的时间认（v0.9.21）
fs.writeFileSync(
  path.join(dir, 'review-decisions.json'),
  JSON.stringify(
    [{ id: 'dec_done', projectId: 'prj_done', version: 1, reviewAt: T.done, verdict: 'fail', decision: 'pass', note: '', at: ago(1), ownerId: 'u_a' }],
    null,
    2,
  ),
  'utf8',
)
fs.writeFileSync(path.join(dir, 'templates.json'), '[]', 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), '[]', 'utf8')

const { reviewQueue, queueRangeSince } = await import('../server/review-queue.mjs')
const me = { id: 'u_a' }

test('不传筛选就是原来的队列：三条待办按评审时间倒序，范围与关键字都是空的', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  assert.deepEqual(queue.items.map((row) => row.projectId), ['prj_new', 'prj_mid', 'prj_old'])
  assert.equal(queue.total, 3)
  assert.equal(queue.allTotal, 3)
  assert.equal(queue.range, 'all')
  assert.equal(queue.query, '')
  assert.deepEqual(queue.facets, { all: 3, '7d': 1, '30d': 2 })
})

test('时间范围按那次评审的时间算：7 天 / 30 天 / 全部，边界不靠猜', async () => {
  const week = await reviewQueue(me, { limit: 20, range: '7d' })
  assert.deepEqual(week.items.map((row) => row.projectId), ['prj_new'], '12 天前、40 天前的都不在 7 天内')
  assert.equal(week.total, 1)
  assert.equal(week.allTotal, 3, '全量不跟着范围变')
  assert.deepEqual(week.facets, { all: 3, '7d': 1, '30d': 2 }, '换一个范围，另一排数字仍然是真的')

  const month = await reviewQueue(me, { limit: 20, range: '30d' })
  assert.deepEqual(month.items.map((row) => row.projectId), ['prj_new', 'prj_mid'])
  assert.equal(month.total, 2)

  const all = await reviewQueue(me, { limit: 20, range: 'all' })
  assert.equal(all.items.length, 3)

  const bad = await reviewQueue(me, { limit: 20, range: '90d' })
  assert.equal(bad.range, 'all', '认不出的范围退回全部，不报错、不空列表')
  assert.equal(bad.items.length, 3)

  // 范围的下限就是「今天往前 N 天」：这个函数是全站唯一的算法
  const since = queueRangeSince('7d', Date.parse('2026-11-13T00:00:00.000Z'))
  assert.equal(since, '2026-11-06T00:00:00.000Z')
  assert.equal(queueRangeSince('all'), '', '全部不设下限')
})

test('关键字只搜作品标题：空格是「都要命中」，大小写不敏感，搜不到就明说没有', async () => {
  const spring = await reviewQueue(me, { limit: 20, q: '春季' })
  assert.deepEqual(spring.items.map((row) => row.projectId), ['prj_new', 'prj_mid'])
  assert.equal(spring.total, 2)
  assert.equal(spring.allTotal, 3, '搜不到的那条仍然算在全量里')
  assert.deepEqual(spring.facets, { all: 2, '7d': 1, '30d': 2 }, '计数按关键字算、不按当前范围算')

  const both = await reviewQueue(me, { limit: 20, q: '春季 折叠' })
  assert.deepEqual(both.items.map((row) => row.projectId), ['prj_mid'], '两个词都要命中')

  const upper = await reviewQueue(me, { limit: 20, q: 'COFFEE' })
  assert.deepEqual(upper.items.map((row) => row.projectId), ['prj_old'], '大小写不敏感')

  const none = await reviewQueue(me, { limit: 20, q: '没有这个作品' })
  assert.deepEqual(none.items, [])
  assert.equal(none.total, 0)
  assert.equal(none.allTotal, 3)
  assert.deepEqual(none.facets, { all: 0, '7d': 0, '30d': 0 })
})

test('关键字与范围叠着用：先筛词再筛时间，两个数各说各的', async () => {
  const queue = await reviewQueue(me, { limit: 20, q: '春季', range: '7d' })
  assert.deepEqual(queue.items.map((row) => row.projectId), ['prj_new'])
  assert.equal(queue.total, 1, '筛出来的数')
  assert.equal(queue.allTotal, 3, '不带任何筛选的全量')
  assert.deepEqual(queue.facets, { all: 2, '7d': 1, '30d': 2 })
})

test('筛空的时候仍然交代全量，并把最新那一条（lead）留着给主卡', async () => {
  // 40 天前评的：按「30 天内」筛是空的，但它确实还在待办里
  const queue = await reviewQueue(me, { limit: 20, q: '咖啡', range: '30d' })
  assert.deepEqual(queue.items, [])
  assert.equal(queue.total, 0)
  assert.equal(queue.allTotal, 3, '筛空了也不说「没有等你改的」')
  assert.equal(queue.lead.projectId, 'prj_new', '主卡读的是不带筛选的最新一条')

  // 不带筛选时 lead 就是队列第一条
  const plain = await reviewQueue(me, { limit: 20 })
  assert.equal(plain.lead.projectId, plain.items[0].projectId)
})

test('看过的、拍过板的交代不跟着筛选变：它们不是待办，别被筛没了', async () => {
  const queue = await reviewQueue(me, { limit: 20, q: '通勤' })
  assert.deepEqual(queue.items, [], '看过的不是待办，搜出来也没有')
  assert.equal(queue.seenTotal, 1, '但「已看过 1 条」照旧交代')
  assert.equal(queue.decidedTotal, 1, '拍过板的也照旧')
})

test('接口认 range 与 q：limit 只截列表，total 与 allTotal 都不跟着 limit 变', async () => {
  const { createReviewRouter } = await import('../server/routes/review.mjs')
  const router = createReviewRouter()
  const call = async (query) => {
    const res = {
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status
      },
      end(chunk) {
        this.body = String(chunk ?? '')
      },
    }
    const url = new URL('http://localhost/api/reviews/queue' + query)
    await router.handle({ method: 'GET', headers: {} }, res, url, url.pathname)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  const page = await call('?limit=1&range=7d&q=' + encodeURIComponent('春季'))
  assert.equal(page.status, 200)
  assert.equal(page.body.range, '7d')
  assert.equal(page.body.query, '春季')
  // 这个请求没带会话，接口按「看得见全部」算（管理员视角）：比 u_a 多一条别人的作品。
  // 这里只验参数透传与 limit 只截列表；账号隔离在上面的用例里验。
  assert.equal(page.body.items.length, 1, 'limit 只截列表')
  assert.equal(page.body.total, 2, '筛出 2 条：7 天内、标题带「春季」')
  assert.equal(page.body.allTotal, 4, '不带筛选的全量')
  assert.deepEqual(page.body.facets, { all: 3, '7d': 2, '30d': 3 })
  assert.equal(page.body.lead.projectId, 'prj_other')
})
