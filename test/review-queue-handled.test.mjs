import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 工作台上「已看过 / 你拍板过」那两行点开之后的那份清单（v0.9.28）。
// 这一组盯四件事：清单是整份而不是「最近 10 条」、看过的按看过时间倒序、
// 拍过板那行的胶囊写人的结论、清单只在第一页带（翻页不重发）。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-queue-handled-'))
process.env.DATA_DIR = dir

const base = Date.parse('2026-11-10T08:00:00.000Z')
const stamp = (minutes) => new Date(base + minutes * 60 * 1000).toISOString()

function project(id, ownerId = 'u_a') {
  return { id, ownerId, title: '作品 ' + id, templateId: '', flowId: 'flow_' + id, version: 1, versions: [], status: 'active', createdAt: stamp(0), updatedAt: stamp(0) }
}

// 12 条看过的 + 3 条拍过板的 + 2 条还在待办 + 1 条「别人看过」的（对我不算看过）
const seenIds = Array.from({ length: 12 }, (_, index) => 'prj_s' + String(index + 1).padStart(2, '0'))
const decidedIds = ['prj_d1', 'prj_d2', 'prj_d3']
const pendingIds = ['prj_p1', 'prj_p2']
const otherAckId = 'prj_s13'

const projects = [...seenIds, ...decidedIds, ...pendingIds, otherAckId].map((id) => project(id))
// 别人的作品不进我的队列
projects.push(project('prj_other', 'u_b'))
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')

let seq = 0
function review(projectId, verdict, createdAt, ownerId = 'u_a') {
  seq += 1
  return {
    id: 'rev_h' + String(seq).padStart(2, '0'),
    ownerId,
    projectId,
    version: 1,
    intent: '第 ' + seq + ' 次评审',
    source: { kind: 'url', label: '第 ' + seq + ' 次', imageUrl: 'https://example.com/' + seq + '.jpg' },
    result: { verdict, summary: '结论 ' + verdict, observations: [] },
    createdAt,
  }
}

const reviews = []
const acks = []
const decisions = []
const reviewAt = new Map()

seenIds.forEach((id, index) => {
  const at = stamp(index)
  reviews.push(review(id, 'needs_review', at))
  reviewAt.set(id, at)
  // 看过的时刻跟着往后走：倒序之后 prj_s12 应该在第一条
  acks.push({ id: 'ack_' + id, projectId: id, version: 1, reviewAt: at, verdict: 'needs_review', at: stamp(60 + index), ownerId: 'u_a' })
})
decidedIds.forEach((id, index) => {
  const at = stamp(10 + index)
  reviews.push(review(id, 'fail', at))
  reviewAt.set(id, at)
  decisions.push({
    id: 'dec_' + id,
    projectId: id,
    version: 1,
    reviewAt: at,
    verdict: 'fail',
    decision: index === 1 ? 'reject' : 'pass',
    note: index === 2 ? '这一处字幕改完就发' : '',
    at: stamp(80 + index),
    ownerId: 'u_a',
  })
})
pendingIds.forEach((id, index) => {
  const at = stamp(20 + index)
  reviews.push(review(id, 'fail', at))
  reviewAt.set(id, at)
})
// 别人看过同一条作品：his 便利贴不算我「已看过」，它照旧等在队列里
{
  const at = stamp(30)
  reviews.push(review(otherAckId, 'needs_review', at))
  acks.push({ id: 'ack_' + otherAckId, projectId: otherAckId, version: 1, reviewAt: at, verdict: 'needs_review', at: stamp(90), ownerId: 'u_b' })
}
reviews.push(review('prj_other', 'fail', stamp(40), 'u_b'))

fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify(reviews, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'review-acks.json'), JSON.stringify(acks, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'review-decisions.json'), JSON.stringify(decisions, null, 2), 'utf8')

const { reviewQueue } = await import('../server/review-queue.mjs')
const me = { id: 'u_a' }

test('看过的与拍过板的都整份给：12 条就是 12 行，不砍到 10 条', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  assert.equal(queue.seenTotal, 12)
  assert.equal(queue.seen.length, 12, '点开「看这 12 条」就得有 12 行，少一条就是假话')
  assert.equal(queue.decidedTotal, 3)
  assert.equal(queue.decided.length, 3)
  // 待办只剩真没处理的：别人的「已看过」不算我看过
  assert.equal(queue.total, 3)
  assert.deepEqual(new Set(queue.items.map((row) => row.projectId)), new Set([...pendingIds, otherAckId]))
})

test('看过的按看过时间倒序：最近看过的排第一行', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  const times = queue.seen.map((row) => row.seenAt)
  assert.deepEqual(times, [...times].sort().reverse())
  assert.equal(queue.seen[0].projectId, 'prj_s12')
  // 每一行都带着版次、评过几次与那次的结论：清单里能看出「看的是哪一版」
  assert.equal(queue.seen[0].version, 1)
  assert.equal(queue.seen[0].count, 1)
  assert.equal(queue.seen[0].verdict, 'needs_review')
  assert.equal(queue.seen[0].status.text, '评审 · 需人工确认')
})

test('拍过板那一行的胶囊写人的结论，模型的原结论仍留着', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  const reject = queue.decided.find((row) => row.projectId === 'prj_d2')
  assert.equal(reject.status.text, '评审 · 人工不通过')
  assert.equal(reject.status.tone, 'fail')
  assert.equal(reject.verdict, 'fail', '模型写的不通过还在，谁说的分得清')
  assert.equal(reject.decision, 'reject')
  const pass = queue.decided.find((row) => row.projectId === 'prj_d1')
  assert.equal(pass.status.text, '评审 · 人工通过')
  assert.equal(pass.status.tone, 'ok')
  const noted = queue.decided.find((row) => row.projectId === 'prj_d3')
  assert.equal(noted.note, '这一处字幕改完就发', '拍板时写的那句话跟着行回来')
  assert.ok(noted.decidedAt, '拍板时间在行上')
})

test('清单只在第一页带：翻页重发一遍没有意义', async () => {
  const first = await reviewQueue(me, { limit: 1, offset: 0 })
  assert.equal(first.seen.length, 12)
  assert.equal(first.decided.length, 3)
  const second = await reviewQueue(me, { limit: 1, offset: 1 })
  assert.deepEqual(second.seen, [])
  assert.deepEqual(second.decided, [])
  // 数字照旧：翻页时界面仍写得出「已看过 12 条」
  assert.equal(second.seenTotal, 12)
  assert.equal(second.decidedTotal, 3)
})

test('/api/reviews/queue 翻页时不重发清单', async () => {
  const { createReviewRouter } = await import('../server/routes/review.mjs')
  const router = createReviewRouter()
  const call = async (query) => {
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
    const url = new URL('http://localhost/api/reviews/queue?' + query)
    await router.handle({ method: 'GET', headers: {} }, res, url, url.pathname)
    assert.equal(res.status, 200)
    return JSON.parse(res.body)
  }
  const first = await call('limit=2')
  assert.equal(first.seen.length, 13, '没有登录态时看得见全部：u_a 的 12 条 + u_b 的 1 条')
  const second = await call('limit=2&offset=2')
  assert.deepEqual(second.seen, [])
  assert.equal(second.seenTotal, 13)
})
