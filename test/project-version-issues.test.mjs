import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 改一版到底有没有变好（v0.9.84）：把「问题数」按严重度逐版算出来。
// 这一组测试盯住四件容易退化的事：
//   1) 数字从评审结果现算，老记录没记 severity 时不写成 0；
//   2) 同一版重评两次不把问题相加（取最近一次）；
//   3) 前后两版都记了严重度才比较，且只比阻塞 / 主要 / 次要；
//   4) 版本划分之前的评审（version 0）折进 v1，与服务端同一套口径。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-issues-'))
process.env.DATA_DIR = dir

const r = await import('../server/reviews.mjs')
const status = await import('../server/project-status.mjs')
const domain = await import('../src/domain/project.ts')
const reviewDomain = await import('../src/domain/review.ts')

const user = { id: 'u_a', name: 'A' }
const obs = (severity) => ({ id: 'o_' + severity + '_' + Math.random().toString(36).slice(2, 6), dimension: '字幕', severity, statement: '一行太长', confidence: 0.8 })
const issuesOf = (counts) => ({ blocker: 0, major: 0, minor: 0, info: 0, ...counts })

test('严重度计数：认得出的才数，认不出的不计入 counted', () => {
  const counted = r.severityCounts({ observations: [obs('blocker'), obs('major'), obs('major'), obs('minor')] })
  assert.deepEqual(counted, { blocker: 1, major: 2, minor: 1, info: 0, counted: 4, observations: 4 })
  // 老记录没有 severity：observations 里有一条，但一条都数不出来
  const legacy = r.severityCounts({ observations: [{ dimension: '字幕', statement: '老记录没有严重度' }] })
  assert.equal(legacy.counted, 0)
  assert.equal(legacy.observations, 1)
  assert.equal(legacy.blocker, 0)
  // 没评审结果 / observations 不是数组：给零，不抛
  assert.equal(r.severityCounts(null).counted, 0)
  assert.equal(r.severityCounts({ observations: 'x' }).observations, 0)
})

test('评审摘要带问题数：列表不用再拉一次详情', async () => {
  const saved = await r.saveReview({
    user,
    intent: '第一版',
    result: { verdict: 'fail', summary: '', observations: [obs('blocker'), obs('blocker'), obs('minor')], ms: 1 },
  })
  const page = await r.listReviews({ limit: 5 }, user)
  const hit = page.items.find((item) => item.id === saved.id)
  assert.equal(hit.observations, 3)
  assert.deepEqual(hit.issues, { blocker: 2, major: 0, minor: 1, info: 0, counted: 3, observations: 3 })
  // 摘要里的问题数不足以反推出问题本身：不夹带 observations 正文
  assert.ok(!('result' in hit))
})

test('同一版重评两次：问题数取最近一次，不相加', async () => {
  const project = { id: 'prj_issues' }
  await r.saveReview({ user, projectId: project.id, version: 2, intent: '先评', result: { verdict: 'fail', summary: '', observations: [obs('blocker'), obs('blocker'), obs('major')], ms: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await r.saveReview({ user, projectId: project.id, version: 2, intent: '改完再评', result: { verdict: 'needs_review', summary: '', observations: [obs('major')], ms: 1 } })
  const counts = await r.reviewSummaryByVersion(project.id, user)
  assert.equal(counts['2'].count, 2)
  assert.equal(counts['2'].lastVerdict, 'needs_review')
  assert.equal(counts['2'].issues.major, 1)
  assert.equal(counts['2'].issues.blocker, 0, '这一版最后评出来已经没有阻塞，不能把上一评的 2 个加起来')
  assert.equal(counts['2'].issues.observations, 1)
})

test('版本划分之前的老评审（version 0）折进 v1，问题数跟着最近一次走', async () => {
  const project = { id: 'prj_legacy_issues' }
  await r.saveReview({ user, projectId: project.id, version: 0, intent: '老记录', result: { verdict: 'fail', summary: '', observations: [obs('blocker')], ms: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await r.saveReview({ user, projectId: project.id, version: 1, intent: '新版', result: { verdict: 'pass', summary: '', observations: [obs('minor')], ms: 1 } })
  const counts = await r.reviewSummaryByVersion(project.id, user)
  const merged = status.reviewsForVersion(counts, 1)
  assert.equal(merged.count, 2)
  assert.equal(merged.lastVerdict, 'pass')
  assert.equal(merged.issues.minor, 1)
  assert.equal(merged.issues.blocker, 0)
  // 客户端拼装同一份统计，口径必须一致
  const clientMerged = domain.reviewsForVersion(counts, 1)
  assert.deepEqual(clientMerged, merged)
})

test('没有评审的版本：issues 是 null，不冒充 0 个阻塞', () => {
  assert.equal(status.reviewsForVersion({}, 3).issues, null)
  assert.equal(domain.reviewsForVersion({}, 3).issues, null)
})

test('只比较前后两版：阻塞优先，其次主要，最后次要', () => {
  const prev = issuesOf({ blocker: 2, major: 1, minor: 1, counted: 4, observations: 4 })
  const better = reviewDomain.issueCompare(prev, issuesOf({ blocker: 1, major: 3, minor: 4, counted: 8, observations: 8 }))
  assert.deepEqual(better, { level: 'blocker', delta: -1, tone: 'better' }, '阻塞少了就说阻塞，不拿主要变多在后面扯平')
  const worse = reviewDomain.issueCompare(prev, issuesOf({ blocker: 2, major: 3, minor: 1, counted: 6, observations: 6 }))
  assert.deepEqual(worse, { level: 'major', delta: 2, tone: 'worse' })
  assert.equal(reviewDomain.issueCompare(prev, issuesOf({ blocker: 2, major: 1, minor: 1, counted: 4, observations: 4 })), null, '持平不编一句话')
  // 信息级不参与比较
  assert.equal(reviewDomain.issueCompare(issuesOf({ blocker: 1, counted: 1, observations: 1 }), issuesOf({ blocker: 1, info: 3, counted: 4, observations: 4 })), null)
  // 任何一边没记严重度就不比
  assert.equal(reviewDomain.issueCompare(issuesOf({ counted: 0, observations: 2 }), issuesOf({ blocker: 1, counted: 1, observations: 1 })), null)
  assert.equal(reviewDomain.issueCompare(null, issuesOf({ blocker: 1, counted: 1, observations: 1 })), null)
})

test('问题数写成一行：只列非零项，从重到轻；没记严重度回空串', () => {
  assert.equal(reviewDomain.issueLine(issuesOf({ blocker: 1, major: 2, minor: 1, counted: 4, observations: 4 })), '1 阻塞 · 2 主要 · 1 次要')
  assert.equal(reviewDomain.issueLine(issuesOf({ info: 2, counted: 2, observations: 2 })), '2 信息')
  assert.equal(reviewDomain.issueLine(issuesOf({ counted: 0, observations: 3 })), '')
  assert.equal(reviewDomain.issueLine(null), '')
})

test('「另有几条没记严重度」：老记录与半新记录都算得出来', () => {
  assert.equal(reviewDomain.issueGap(issuesOf({ blocker: 1, counted: 1, observations: 4 })), 3)
  assert.equal(reviewDomain.issueGap(issuesOf({ counted: 0, observations: 2 })), 2)
  assert.equal(reviewDomain.issueGap(issuesOf({ blocker: 1, counted: 1, observations: 1 })), 0)
  assert.equal(reviewDomain.issueGap(null), 0)
})

test('评审结果现数一遍：与服务端存的数字同一个口径', () => {
  const counted = reviewDomain.issueCountsOf([obs('blocker'), obs('major'), { statement: '没记严重度' }, { severity: 'blockers' }])
  assert.deepEqual(counted, { blocker: 1, major: 1, minor: 0, info: 0, counted: 2, observations: 4 })
  assert.equal(reviewDomain.issueGap(counted), 2, '拼错或没记的那两条都要算进「没记严重度」')
})
