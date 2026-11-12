import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 评审历史「查看全部」：最多 200 条记录，一页 20 条往下翻，按结论 / 作品筛选。
// 这一组盯服务端口径：翻页不重不漏、筛选只回对应记录、筛选面板上的数字
// 是「换一个筛选后仍然对着真实结果」的交叉计数、结果集按账号隔离。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-page-'))
process.env.DATA_DIR = dir

const at = (index) => '2026-11-12T' + String(23 - index).padStart(2, '0') + ':00:00.000Z'

/**
 * 23 条，其中 rev_22 属于另一个账号：
 *   prj_fold 6 条（3 通过 / 2 需人工确认 / 1 不通过）
 *   prj_open 4 条（2 通过 / 1 需人工确认 / 1 不通过）
 *   没记入作品 12 条（7 通过 / 3 需人工确认 / 2 不通过）
 * 合计：通过 12、需人工确认 6、不通过 4。
 */
function seed() {
  const rows = []
  const push = (index, projectId, verdict) => {
    rows.push({
      id: 'rev_' + String(index).padStart(2, '0'),
      ownerId: 'u_a',
      projectId,
      version: projectId ? 2 : 0,
      intent: '第 ' + index + ' 条',
      source: { kind: 'url', label: '第 ' + index + ' 条', imageUrl: 'https://example.com/' + index + '.jpg' },
      result: { verdict, summary: '结论 ' + index, observations: [] },
      createdAt: at(index),
    })
  }
  push(0, 'prj_fold', 'pass')
  push(1, 'prj_fold', 'pass')
  push(2, 'prj_fold', 'pass')
  push(3, 'prj_fold', 'needs_review')
  push(4, 'prj_fold', 'needs_review')
  push(5, 'prj_fold', 'fail')
  push(6, 'prj_open', 'pass')
  push(7, 'prj_open', 'pass')
  push(8, 'prj_open', 'needs_review')
  push(9, 'prj_open', 'fail')
  for (let index = 10; index <= 16; index += 1) push(index, '', 'pass')
  for (let index = 17; index <= 19; index += 1) push(index, '', 'needs_review')
  for (let index = 20; index <= 21; index += 1) push(index, '', 'fail')
  // 故意把最后一条的日期拨到最早：列表顺序要看记录的时间，不看盘上数组怎么排
  rows[rows.length - 1].createdAt = '2025-01-01T00:00:00.000Z'
  rows.push({
    id: 'rev_22',
    ownerId: 'u_b',
    projectId: '',
    version: 0,
    intent: '别人的评审',
    source: { kind: 'url', label: '别人的评审', imageUrl: 'https://example.com/22.jpg' },
    result: { verdict: 'pass', summary: '', observations: [] },
    createdAt: at(22),
  })
  return rows
}

fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify(seed(), null, 2), 'utf8')

const { listReviews } = await import('../server/reviews.mjs')
const me = { id: 'u_a' }

test('翻页不重不漏：第一页 20 条、第二页剩下 2 条，总数 22（别人的那条不算）', async () => {
  const first = await listReviews({ limit: 20, offset: 0 }, me)
  const second = await listReviews({ limit: 20, offset: first.items.length }, me)
  assert.equal(first.items.length, 20)
  assert.equal(second.items.length, 2)
  assert.equal(first.total, 22)
  assert.equal(first.offset, 0)
  assert.equal(second.offset, 20)
  const ids = [...first.items, ...second.items].map((item) => item.id)
  assert.equal(new Set(ids).size, 22, '两页之间不许重复')
  assert.equal(ids.length, first.total, '两页加起来正好等于总数')
  assert.equal(ids.includes('rev_22'), false, '别人的评审不进我的历史')
  const beyond = await listReviews({ limit: 20, offset: 40 }, me)
  assert.deepEqual(beyond.items, [], '翻过头是空的')
  assert.equal(beyond.total, 22, '但总数还在，界面据此停止「再看 N 条」')
})

test('按时间倒序：盘上排在中间的旧记录，列表里落到最后', async () => {
  const first = await listReviews({ limit: 20, offset: 0 }, me)
  const second = await listReviews({ limit: 20, offset: 20 }, me)
  const all = [...first.items, ...second.items]
  assert.equal(all.length, 22)
  assert.equal(all[all.length - 1].id, 'rev_21', '2025 年那一条必须排在最后，而不是文件里的位置')
  const times = all.map((item) => item.createdAt)
  assert.deepEqual(times, [...times].sort().reverse(), '整页按时间从新到旧')
})

test('按结论筛选：只回那一种，面板数字按当前作品筛选算', async () => {
  const passes = await listReviews({ limit: 20, verdict: 'pass' }, me)
  assert.equal(passes.total, 12)
  assert.ok(passes.items.every((item) => item.verdict === 'pass'))
  assert.deepEqual(passes.facets.verdicts, { pass: 12, needs_review: 6, fail: 4, none: 0 })
  assert.equal(passes.facets.projects.find((entry) => entry.id === 'prj_fold').count, 3, '通过口径下这条作品有 3 条')
  assert.equal(passes.facets.projects.find((entry) => entry.id === 'prj_open').count, 2)
  assert.equal(passes.facets.orphans, 7)
})

test('按作品筛选：结论计数只算这条作品下的，作品下拉仍列出别的作品', async () => {
  const scoped = await listReviews({ limit: 20, projectId: 'prj_fold' }, me)
  assert.equal(scoped.total, 6)
  assert.ok(scoped.items.every((item) => item.projectId === 'prj_fold'))
  assert.deepEqual(scoped.facets.verdicts, { pass: 3, needs_review: 2, fail: 1, none: 0 })
  assert.equal(scoped.facets.projects.length, 2, '作品下拉不受当前作品筛选影响，换一条作品还翻得动')
  assert.equal(scoped.facets.orphans, 12, '没记入作品的数量也在，随时能切过去')
  const open = await listReviews({ limit: 20, projectId: 'prj_open' }, me)
  assert.equal(open.total, 4)
  assert.deepEqual(open.facets.verdicts, { pass: 2, needs_review: 1, fail: 1, none: 0 })
})

test('只看没记入作品的：orphan 只回没挂作品的，能与结论一起筛', async () => {
  const orphans = await listReviews({ limit: 20, orphan: true }, me)
  assert.equal(orphans.total, 12)
  assert.ok(orphans.items.every((item) => !item.projectId))
  assert.equal(orphans.total, orphans.facets.orphans)
  assert.deepEqual(orphans.facets.verdicts, { pass: 7, needs_review: 3, fail: 2, none: 0 })
  const combined = await listReviews({ limit: 20, orphan: true, verdict: 'fail' }, me)
  assert.equal(combined.total, 2)
  assert.ok(combined.items.every((item) => !item.projectId && item.verdict === 'fail'))
  assert.deepEqual(combined.facets.projects.map((entry) => entry.count), [1, 1], '作品计数只受结论筛选影响')
})

test('一页最多 50 条：limit 传大了也只给 50，负数偏移当 0', async () => {
  const capped = await listReviews({ limit: 999 }, me)
  assert.equal(capped.limit, 50)
  assert.equal(capped.items.length, 22, '不足 50 条时给全部')
  const negative = await listReviews({ limit: 5, offset: -10 }, me)
  assert.equal(negative.offset, 0)
  assert.equal(negative.items.length, 5)
})

test('面板数字永远对得上真实结果：两边加起来都等于总数', async () => {
  const page = await listReviews({ limit: 1 }, me)
  const counts = page.facets.verdicts
  assert.equal(counts.pass + counts.needs_review + counts.fail + counts.none, 22)
  assert.equal(page.facets.projects.reduce((sum, entry) => sum + entry.count, 0) + page.facets.orphans, 22)
  assert.equal(counts.none, 0, '这一批记录都有结论')
})
