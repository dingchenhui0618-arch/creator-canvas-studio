import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 还没有这份文件（ENOENT）= 空库：部署第一天、新装一套都是这个状态，
// 不能因此报「数据读不出来」。这一组确认缺失文件仍然正常起步，也不会被误判成损坏。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-store-missing-'))
process.env.DATA_DIR = dir

const templates = await import('../server/templates.mjs')
const projects = await import('../server/projects.mjs')
const flows = await import('../server/flows.mjs')

const me = { id: 'u_a', name: 'A', email: 'a@b.c' }

test('没有 templates.json：空库，不报错', async () => {
  assert.deepEqual(await templates.listTemplates({}, me), [])
  const stats = await templates.templateStats(me)
  assert.equal(stats.total, 0)
})

test('没有 projects.json：空库，新建第一条正常落盘', async () => {
  assert.deepEqual(await projects.listProjects(me), [])
  const created = await projects.createProject({ title: '第一条作品' }, me)
  assert.equal(created.title, '第一条作品')
  const list = await projects.listProjects(me)
  assert.deepEqual(list.map((item) => item.id), [created.id])
})

test('没有 flows.json / runs.json：空库，建一条工作流正常', async () => {
  assert.deepEqual(await flows.listFlows(me), [])
  const flow = await flows.createFlow({ name: '第一条工作流' }, me)
  assert.ok(flow && flow.id)
  assert.equal((await flows.listFlows(me)).length, 1)
})
// 其余用户数据存储同一条规矩（r267）：没有文件就是空库，第一条记录照常落盘。
const reviews = await import('../server/reviews.mjs')
const history = await import('../server/agent-history.mjs')
const search = await import('../server/search-history.mjs')
const acks = await import('../server/review-acks.mjs')
const decisions = await import('../server/review-decisions.mjs')
const reports = await import('../server/reports.mjs')
const feedback = await import('../server/feedback.mjs')
const clientErrors = await import('../server/client-errors.mjs')
const alerts = await import('../server/alerts.mjs')

test('没有评审 / 运行记录 / 检索 / 已看过 / 拍板：空列表，不报错', async () => {
  assert.equal((await reviews.listReviews({}, me)).total, 0)
  assert.equal((await history.listAgentRuns('ag_1')).total, 0)
  assert.deepEqual(await search.listSearchHistory(me), [])
  assert.deepEqual(await acks.listAcks(me), [])
  assert.deepEqual(await decisions.listDecisions(me), [])
})

test('没有举报 / 反馈 / 前端异常 / 告警：空列表，写第一条正常落盘', async () => {
  assert.deepEqual((await reports.listReports({})).items, [])
  const report = await reports.createReport({ target: { kind: 'template', id: 'tpl_1' }, detail: '这条模板是我拍的原创' })
  assert.equal(report.ok, true)
  assert.deepEqual((await feedback.listFeedback({})).items, [])
  const note = await feedback.createFeedback({ kind: 'problem', body: '作品页打不开', user: me })
  assert.equal(note.ok, true)
  assert.equal((await clientErrors.listClientErrors({})).total, 0)
  assert.deepEqual(await alerts.listAlerts({}), [])
  const alert = await alerts.recordAlert({ kind: 'test', title: '新装一条测试告警' })
  assert.ok(alert && alert.id)
  assert.equal((await alerts.listAlerts({})).length, 1)
  // 没有 alert-outbox.json 是正常的：没有外推通道就不该报错
  assert.deepEqual(await alerts.listOutbox({}), [])
})
