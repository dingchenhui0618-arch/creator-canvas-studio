import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 评审队列：哪几条作品还等着人动手。
// 这一组盯五条口径：只收需人工确认 / 不通过、只看当前这一版、版本划分之前的评审折进 v1、
// 已交付的不再催、按评审时间倒序；外加账号隔离与「/api/reviews/queue 不被当成评审 id」。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-queue-'))
process.env.DATA_DIR = dir

const at = (day, hour) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'

function project(id, ownerId, version, { status = 'active', flowId = 'flow_' + id } = {}) {
  return { id, ownerId, title: '作品 ' + id, templateId: '', flowId, version, versions: [], status, createdAt: at(1, 0), updatedAt: at(1, 0) }
}

/**
 * prj_fold   v2：上一版不通过，当前版需人工确认 → 进队列，记在 v2
 * prj_spring v1：当前版不通过 → 进队列
 * prj_pass   v1：当前版通过 → 不进队列（不需要动手了）
 * prj_legacy v1：只有版本划分之前记在 0 上的评审，需人工确认 → 折进 v1 进队列
 * prj_newver v2：新版还没评过，上一版有意见 → 不进队列（意见属于上一版）
 * prj_none   v1：没评过 → 不进队列
 * prj_done   v1：已交付且结论是不通过 → 不进队列（交出去了就不再催）
 * prj_other  u_b 的作品：不进我的队列
 */
const projects = [
  project('prj_fold', 'u_a', 2),
  project('prj_spring', 'u_a', 1),
  project('prj_pass', 'u_a', 1),
  project('prj_legacy', 'u_a', 1),
  project('prj_newver', 'u_a', 2),
  project('prj_none', 'u_a', 1),
  project('prj_done', 'u_a', 1, { status: 'done' }),
  project('prj_other', 'u_b', 1),
]
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')

let seq = 0
function review(projectId, version, verdict, createdAt, ownerId = 'u_a') {
  seq += 1
  return {
    id: 'rev_q' + String(seq).padStart(2, '0'),
    ownerId,
    projectId,
    version,
    intent: '第 ' + seq + ' 次评审',
    source: { kind: 'url', label: '第 ' + seq + ' 次', imageUrl: 'https://example.com/' + seq + '.jpg' },
    result: { verdict, summary: '结论 ' + verdict, observations: [] },
    createdAt,
  }
}

fs.writeFileSync(
  path.join(dir, 'reviews.json'),
  JSON.stringify(
    [
      review('prj_fold', 1, 'fail', at(10, 9)),
      review('prj_fold', 2, 'needs_review', at(12, 10)),
      review('prj_spring', 1, 'fail', at(11, 8)),
      review('prj_pass', 1, 'pass', at(12, 11)),
      review('prj_legacy', 0, 'needs_review', at(9, 7)),
      review('prj_newver', 1, 'fail', at(8, 6)),
      review('prj_done', 1, 'fail', at(12, 12)),
      review('prj_other', 1, 'fail', at(12, 13), 'u_b'),
      // 没挂作品的评审不进队列：它没有「哪条作品要改」这件事
      review('', 0, 'fail', at(12, 14)),
    ],
    null,
    2,
  ),
  'utf8',
)
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')

const { reviewQueue } = await import('../server/review-queue.mjs')
const me = { id: 'u_a' }

test('只收需人工确认与不通过：通过的不催、没评过的不进、已交付的不再催', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  assert.deepEqual(queue.items.map((row) => row.projectId), ['prj_fold', 'prj_spring', 'prj_legacy'])
  assert.equal(queue.total, 3)
  assert.equal(queue.items.some((row) => row.projectId === 'prj_pass'), false, '通过的不需要动手')
  assert.equal(queue.items.some((row) => row.projectId === 'prj_none'), false, '没评过的连意见都还没有')
  assert.equal(queue.items.some((row) => row.projectId === 'prj_done'), false, '交付了就不再催')
  assert.equal(queue.items.some((row) => row.projectId === 'prj_newver'), false, '意见记在上一版，不该按当前版排队')
})

test('按那次评审的时间倒序：刚评出意见的最该先看', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  const times = queue.items.map((row) => row.at)
  assert.deepEqual(times, [...times].sort().reverse())
  assert.equal(queue.items[0].projectId, 'prj_fold')
  assert.equal(queue.items[0].at, at(12, 10))
})

test('只看当前这一版：v2 有意见就报 v2，不拿 v1 的旧结论冒充', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  const fold = queue.items.find((row) => row.projectId === 'prj_fold')
  assert.equal(fold.version, 2)
  assert.equal(fold.verdict, 'needs_review', 'v1 那次不通过不算到 v2 头上')
  assert.equal(fold.count, 1, '计的是这一版评过几次')
})

test('版本划分之前记在 0 上的评审折进 v1', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  const legacy = queue.items.find((row) => row.projectId === 'prj_legacy')
  assert.ok(legacy, '老作品不该显示成没评过')
  assert.equal(legacy.version, 1)
  assert.equal(legacy.verdict, 'needs_review')
})

test('队列行带状态胶囊：文案就是作品卡片上那一句', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  const fold = queue.items.find((row) => row.projectId === 'prj_fold')
  assert.deepEqual(fold.status, { text: '评审 · 需人工确认', tone: 'warn', verdict: 'needs_review' })
  const spring = queue.items.find((row) => row.projectId === 'prj_spring')
  assert.equal(spring.status.text, '评审 · 不通过')
  assert.equal(spring.status.tone, 'fail')
})

test('一页几条与总数分开：limit 只截列表，total 仍是全部', async () => {
  const page = await reviewQueue(me, { limit: 2 })
  assert.equal(page.items.length, 2)
  assert.equal(page.total, 3, '总数不跟着 limit 变，界面据此写「再看 N 条」')
  assert.equal((await reviewQueue(me, { limit: 999 })).items.length, 3)
  assert.equal((await reviewQueue(me, { limit: 'abc' })).items.length, 3, '非法 limit 回默认值，不炸')
})

test('账号隔离：别人的作品不进我的队列', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  assert.equal(queue.items.some((row) => row.projectId === 'prj_other'), false)
  const other = await reviewQueue({ id: 'u_b' }, { limit: 20 })
  assert.deepEqual(other.items.map((row) => row.projectId), ['prj_other'])
})

test('/api/reviews/queue 不会被当成一条评审 id', async () => {
  const { createReviewRouter } = await import('../server/routes/review.mjs')
  const router = createReviewRouter()
  const res = {
    status: 0,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
  const url = new URL('http://localhost/api/reviews/queue')
  await router.handle({ method: 'GET', headers: {} }, res, url, url.pathname)
  assert.equal(res.status, 200, '排到 /api/reviews 列表之后、评审 id 之前')
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.items))
  assert.equal(typeof body.total, 'number')
})
