import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 用户数据存储读不出来时不许当空库（r267，接 r265 的模板库 / 作品库 / 工作流 / 运行记录）。
// 这一组覆盖剩下的「整份读、改一条、整份写回」的存储：评审历史、智能体运行记录、检索历史、
// 已看过、人工拍板、举报、反馈、前端异常、告警及其外推队列。
// 盯三件事：读要报错；报错期间写要停手（文件一个字节都不动）；文件坏了不能半条写回。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-store-corrupt-user-'))
process.env.DATA_DIR = dir

const names = [
  'reviews.json',
  'agent-runs.json',
  'search-history.json',
  'review-acks.json',
  'review-decisions.json',
  'reports.json',
  'feedback.json',
  'client-errors.json',
  'alerts.json',
  'alert-outbox.json',
]
for (const name of names) fs.writeFileSync(path.join(dir, name), '{ "broken": ', 'utf8')
const before = Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]))

const reviews = await import('../server/reviews.mjs')
const history = await import('../server/agent-history.mjs')
const search = await import('../server/search-history.mjs')
const acks = await import('../server/review-acks.mjs')
const decisions = await import('../server/review-decisions.mjs')
const reports = await import('../server/reports.mjs')
const feedback = await import('../server/feedback.mjs')
const clientErrors = await import('../server/client-errors.mjs')
const alerts = await import('../server/alerts.mjs')

const me = { id: 'u_a', name: 'A', email: 'a@b.c' }
const isStoreError = (error) => error?.code === 'STORE_UNREADABLE' && /数据读不出来/.test(error.message)
const untouched = (name) => assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), before[name], name + ' 被改写了')

test('评审历史读不出来：列历史报错，存评审被拒', async () => {
  await assert.rejects(() => reviews.listReviews({}, me), isStoreError)
  await assert.rejects(() => reviews.saveReview({ user: me, result: { verdict: 'pass' } }), isStoreError)
  untouched('reviews.json')
})

test('智能体运行记录读不出来：列记录报错，记一条被拒', async () => {
  await assert.rejects(() => history.listAgentRuns('ag_1'), isStoreError)
  await assert.rejects(() => history.recordAgentRun({ agent: { id: 'ag_1' }, message: '你好' }), isStoreError)
  untouched('agent-runs.json')
})

test('检索历史读不出来：列历史报错，记检索被拒', async () => {
  await assert.rejects(() => search.listSearchHistory(me), isStoreError)
  await assert.rejects(() => search.recordSearch({ user: me, keyword: '露营' }), isStoreError)
  untouched('search-history.json')
})

test('已看过与人工拍板读不出来：读报错，写被拒', async () => {
  await assert.rejects(() => acks.listAcks(me), isStoreError)
  await assert.rejects(() => acks.ackReview({ projectId: 'prj_1', version: 1, reviewAt: '2026-11-19T00:00:00.000Z' }, me), isStoreError)
  untouched('review-acks.json')
  await assert.rejects(() => decisions.listDecisions(me), isStoreError)
  await assert.rejects(
    () => decisions.saveDecision({ projectId: 'prj_1', version: 1, reviewAt: '2026-11-19T00:00:00.000Z', decision: 'pass' }, me),
    isStoreError,
  )
  untouched('review-decisions.json')
})

test('举报、反馈、前端异常读不出来：读报错，写被拒', async () => {
  await assert.rejects(() => reports.listReports({}), isStoreError)
  await assert.rejects(() => reports.createReport({ target: { kind: 'template', id: 'tpl_1' }, detail: '这条模板是我拍的原创' }), isStoreError)
  untouched('reports.json')
  await assert.rejects(() => feedback.listFeedback({}), isStoreError)
  await assert.rejects(() => feedback.createFeedback({ kind: 'problem', body: '打不开作品页', user: me }), isStoreError)
  untouched('feedback.json')
  await assert.rejects(() => clientErrors.listClientErrors({}), isStoreError)
  await assert.rejects(() => clientErrors.recordClientError({ payload: { message: 'TypeError', page: '#/projects' } }), isStoreError)
  untouched('client-errors.json')
})

test('告警读不出来：后台读告警报错，记一条不落盘', async () => {
  await assert.rejects(() => alerts.listAlerts({}), isStoreError)
  assert.equal(await alerts.recordAlert({ kind: 'test', title: '测试告警' }), null)
  untouched('alerts.json')
})

test('外推队列读不出来：读队列报错，不拿空队列覆盖', async () => {
  await assert.rejects(() => alerts.listOutbox({}), isStoreError)
  untouched('alert-outbox.json')
})
