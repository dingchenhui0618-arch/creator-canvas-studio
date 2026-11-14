import test from 'node:test'
import assert from 'node:assert/strict'

// 作品状态胶囊：一句话说明这条作品走到哪一步。
// 这一组盯住「评过不等于过了」——有结论时胶囊直接写结论，只有没有结论的老记录才退回「已评审」。

const { projectStatus, reviewsForVersion } = await import('../server/project-status.mjs')

// v0.9.84 起版本统计多带一份按严重度的问题数：没有评审结果时是 null，不是 0
const reviews = (count, verdict = '', lastAt = '2026-11-12T10:00:00.000Z', issues = null) => ({ count, lastVerdict: verdict, lastAt, issues })
const project = (extra = {}) => ({ id: 'prj_a', status: 'active', flowId: 'flow_a', version: 1, ...extra })

test('没画布说待开画布，有画布没评审说在做', () => {
  assert.equal(projectStatus(project({ flowId: '' }), reviews(0)).text, '待开画布')
  assert.equal(projectStatus(project({ flowId: '' }), reviews(0)).tone, 'idle')
  assert.equal(projectStatus(project(), reviews(0)).text, '在做')
  assert.equal(projectStatus(project(), reviews(0)).tone, 'live')
})

test('三种结论各写各的，语气跟着变', () => {
  assert.deepEqual(projectStatus(project(), reviews(2, 'pass')), { text: '评审 · 通过', tone: 'ok', verdict: 'pass' })
  assert.deepEqual(projectStatus(project(), reviews(3, 'needs_review')), { text: '评审 · 需人工确认', tone: 'warn', verdict: 'needs_review' })
  assert.deepEqual(projectStatus(project(), reviews(1, 'fail')), { text: '评审 · 不通过', tone: 'fail', verdict: 'fail' })
})

test('没有结论的老记录只说评过，不假装给了结论', () => {
  const status = projectStatus(project(), reviews(1, ''))
  assert.equal(status.text, '已评审')
  assert.equal(status.verdict, '', '没有结论时不留一个假的结论值')
})

test('已交付压过评审结论：标签与状态说同一件事', () => {
  const status = projectStatus(project({ status: 'done' }), reviews(2, 'fail'))
  assert.equal(status.text, '已交付')
  assert.equal(status.tone, 'done')
})

test('某一版的评审：版本划分之前记在 0 上的折进 v1，各版本互不串', () => {
  const counts = { '0': reviews(2, 'pass', '2026-11-10T00:00:00.000Z'), '1': reviews(1, 'fail', '2026-11-11T00:00:00.000Z'), '2': reviews(1, 'needs_review', '2026-11-12T00:00:00.000Z') }
  assert.deepEqual(reviewsForVersion(counts, 2), reviews(1, 'needs_review', '2026-11-12T00:00:00.000Z'))
  const v1 = reviewsForVersion(counts, 1)
  assert.equal(v1.count, 3, 'v1 把记在 0 上的两次也算进来')
  assert.equal(v1.lastVerdict, 'fail', '最后一次结论取时间更晚的那条')
  // 问题数跟着「最近一次」走：折进 v1 时不能把两版（0 与 1）的问题相加
  const withIssues = {
    ...counts,
    2: reviews(1, 'needs_review', '2026-11-12T00:00:00.000Z', { blocker: 2, major: 1, minor: 0, info: 0, counted: 3, observations: 3 }),
  }
  assert.equal(reviewsForVersion(withIssues, 2).issues.blocker, 2)
  assert.deepEqual(reviewsForVersion({}, 1), { count: 0, lastVerdict: '', lastAt: '', issues: null }, '一版都没评过时给出空计数，不是 undefined')
})
