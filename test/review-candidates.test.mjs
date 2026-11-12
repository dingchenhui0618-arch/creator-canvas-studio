import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 评审页从哪条作品开始（v0.9.37）。
// 盯四件事：这一版叫什么（没有第 0 版）、只算当前这一版的评审、胶囊与拍板跟其他地方同一句、
// 排序按最近改动且 limit 只截列表；外加账号隔离（归属仍由 listProjects 决定）。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-candidates-'))
process.env.DATA_DIR = dir

const pad = (value) => String(value).padStart(2, '0')
const at = (day, hour) => '2026-11-' + pad(day) + 'T' + pad(hour) + ':00:00.000Z'

function project(id, { version = 1, flowId = 'flow_' + id, status = 'active', updatedAt = at(1, 0), title = '作品 ' + id, deliveries = [] } = {}) {
  return { id, ownerId: 'u_a', title, templateId: '', flowId, version, versions: [], status, deliveries, createdAt: at(1, 0), updatedAt }
}

// reviewCandidateRow / reviewCandidates 收的是「按版本分组」的那一份计数（reviewCountsByProject 的值 .versions）
const countsOf = (versions) => versions

// ---------- 读盘那一版：归属与拍板都从现算来 ----------

fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([
  { id: 'prj_mine', ownerId: 'u_a', title: '我的作品', templateId: '', flowId: 'flow_mine', version: 2, versions: [], status: 'active', createdAt: at(1, 0), updatedAt: at(12, 0) },
  { id: 'prj_other', ownerId: 'u_b', title: '别人的作品', templateId: '', flowId: 'flow_other', version: 1, versions: [], status: 'active', createdAt: at(1, 0), updatedAt: at(12, 5) },
], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([
  { id: 'rev_1', ownerId: 'u_a', projectId: 'prj_mine', version: 2, intent: '第 2 版', source: { kind: 'url', label: 'x', imageUrl: 'https://example.com/a.jpg' }, result: { verdict: 'fail', summary: '不行', observations: [] }, createdAt: at(11, 9) },
], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'review-decisions.json'), JSON.stringify([
  { id: 'dec_1', projectId: 'prj_mine', version: 2, reviewAt: at(11, 9), verdict: 'fail', decision: 'reject', note: '先别发', at: at(11, 10), ownerId: 'u_a' },
], null, 2), 'utf8')

const { reviewCandidates, reviewCandidateRow, versionLabel, reviewCandidatesFor } = await import('../server/review-candidates.mjs')

test('读盘：只给我的作品，拍板现状算进胶囊', async () => {
  const mine = await reviewCandidatesFor({ id: 'u_a' })
  assert.deepEqual(mine.items.map((row) => row.projectId), ['prj_mine'], '别人的作品不进我的候选')
  assert.equal(mine.total, 1)
  const row = mine.items[0]
  assert.equal(row.versionLabel, '第 2 版')
  assert.equal(row.status.text, '评审 · 人工不通过')
  assert.equal(row.reviews.count, 1)

  const other = await reviewCandidatesFor({ id: 'u_b' })
  assert.deepEqual(other.items.map((row) => row.projectId), ['prj_other'])
})

test('这一版叫什么：没有第 0 版，没开画布就照实说', () => {
  assert.equal(versionLabel(0), '还没开画布')
  assert.equal(versionLabel(1), '第 1 版')
  assert.equal(versionLabel(3), '第 3 版')
  assert.equal(versionLabel('2'), '第 2 版', '接口里可能是字符串')
  assert.equal(versionLabel(-4), '还没开画布')
  assert.equal(versionLabel('abc'), '还没开画布')
})

test('只算当前这一版：上一版评过 5 次不算到 v2 头上', () => {
  const row = reviewCandidateRow(project('prj_a', { version: 2 }), countsOf({
    '1': { count: 5, lastVerdict: 'fail', lastAt: at(9, 8) },
    '2': { count: 2, lastVerdict: 'needs_review', lastAt: at(12, 10) },
  }))
  assert.equal(row.reviews.count, 2)
  assert.equal(row.reviews.lastVerdict, 'needs_review')
  assert.equal(row.reviews.lastAt, at(12, 10))
  assert.equal(row.status.text, '评审 · 需人工确认')
})

test('版本划分之前记在 0 上的评审折进 v1：老作品不显示成没评过', () => {
  const row = reviewCandidateRow(project('prj_legacy', { version: 1 }), countsOf({
    '0': { count: 3, lastVerdict: 'fail', lastAt: at(8, 7) },
  }))
  assert.equal(row.reviews.count, 3)
  assert.equal(row.status.text, '评审 · 不通过')
})

test('胶囊跟作品卡片同一句：待开画布 / 在做 / 需人工确认 / 已交付', () => {
  const noCanvas = reviewCandidateRow(project('prj_new', { version: 0, flowId: '' }), {})
  assert.equal(noCanvas.hasCanvas, false)
  assert.equal(noCanvas.versionLabel, '还没开画布')
  assert.equal(noCanvas.status.text, '待开画布')

  const fresh = reviewCandidateRow(project('prj_fresh'), {})
  assert.equal(fresh.status.text, '在做')

  const reviewed = reviewCandidateRow(project('prj_warn'), countsOf({ '1': { count: 1, lastVerdict: 'needs_review', lastAt: at(12, 9) } }))
  assert.deepEqual(reviewed.status, { text: '评审 · 需人工确认', tone: 'warn', verdict: 'needs_review' })

  const done = reviewCandidateRow(
    project('prj_done', { status: 'done', deliveries: [{ version: 1, at: at(12, 12) }] }),
    countsOf({ '1': { count: 1, lastVerdict: 'pass', lastAt: at(12, 11) } }),
  )
  assert.equal(done.delivered, true)
  assert.equal(done.status.text, '已交付')
})

test('人拍过板就写人的那一句，但只认那一次评审', () => {
  const versions = countsOf({ '1': { count: 1, lastVerdict: 'needs_review', lastAt: at(12, 10) } })
  const passed = reviewCandidateRow(project('prj_p'), versions, [
    { projectId: 'prj_p', version: 1, reviewAt: at(12, 10), decision: 'pass', at: at(12, 11), verdict: 'needs_review' },
  ])
  assert.equal(passed.status.text, '评审 · 人工通过')
  assert.equal(passed.status.tone, 'ok')

  // 同一版后来又评过一次：时间对不上，旧拍板不再管这一次
  const stale = reviewCandidateRow(project('prj_p'), versions, [
    { projectId: 'prj_p', version: 1, reviewAt: at(10, 9), decision: 'pass', at: at(10, 10), verdict: 'needs_review' },
  ])
  assert.equal(stale.status.text, '评审 · 需人工确认')
})

test('按最近改动倒序，同一时刻按 id：列表顺序不能一刷新就跳', () => {
  const projects = [
    project('prj_old', { updatedAt: at(9, 1) }),
    project('prj_new', { updatedAt: at(12, 1) }),
    project('prj_b', { updatedAt: at(11, 1) }),
    project('prj_a', { updatedAt: at(11, 1) }),
  ]
  const result = reviewCandidates(projects, {})
  assert.deepEqual(result.items.map((row) => row.projectId), ['prj_new', 'prj_a', 'prj_b', 'prj_old'])
  assert.equal(result.total, 4)
})

test('limit 只截列表，total 仍是全部；上限 12、非法值回默认', () => {
  const projects = Array.from({ length: 16 }, (_, index) => project('prj_' + pad(index + 1), { updatedAt: at(1, index % 24) }))
  const page = reviewCandidates(projects, {}, new Map(), { limit: 2 })
  assert.equal(page.items.length, 2)
  assert.equal(page.total, 16, '总数不跟着 limit 变，界面写「还有 N 条」用得上')
  assert.equal(reviewCandidates(projects, {}, new Map(), { limit: 99 }).items.length, 12, '上限 12')
  assert.equal(reviewCandidates(projects, {}, new Map(), { limit: 0 }).items.length, 4, '0 回默认 4 条')
  assert.equal(reviewCandidates(projects, {}, new Map(), { limit: 'abc' }).items.length, 4, '非法值回默认')
})

test('没开画布的条数单独算：界面据此写「其中 N 条还没开画布」', () => {
  const result = reviewCandidates([
    project('prj_1', { flowId: '' , version: 0 }),
    project('prj_2', { flowId: '' , version: 0 }),
    project('prj_3'),
  ], {})
  assert.equal(result.withoutCanvas, 2)
  assert.equal(result.total, 3)
})

test('一条作品都没有：空列表，不编一条占位作品', () => {
  const empty = reviewCandidates([], {}, new Map(), {})
  assert.deepEqual(empty.items, [])
  assert.equal(empty.total, 0)
  assert.equal(empty.withoutCanvas, 0)
})

