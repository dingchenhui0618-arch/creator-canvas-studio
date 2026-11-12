import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 作品是「一条内容的主线对象」：它只保存引用（模板 / 画布 / 评审），不复制脚本分镜。
// 这一组测试盯住三条容易退化的行为：不复制内容、归属隔离、删作品后评审仍留为历史。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-projects-'))
process.env.DATA_DIR = dir

const parsed = {
  id: 'tpl_a',
  kind: 'replica',
  title: '咖啡 3 分钟',
  contentType: '美食教程',
  hook: '钩子',
  structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '一句话', onScreen: '', purpose: '抓住' }],
  storyboard: [{ shotNo: 1, startSec: 0, endSec: 3, camera: '近景', caption: '', visual: '', audio: '', purpose: '' }],
  analysis: { pacing: '快', viralPoints: [], reusableRules: [], targetAudience: '' },
  frames: [],
  cover: '',
  durationSec: 18,
  ownerId: 'u_a',
  createdAt: '2026-11-01T00:00:00.000Z',
}
const unparsed = { ...parsed, id: 'tpl_saved', kind: 'saved', title: '待解析', structure: [], storyboard: [], ownerId: 'u_a' }
const other = { ...parsed, id: 'tpl_b', kind: 'replica', title: '别人的模板', ownerId: 'u_b' }
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([parsed, unparsed, other], null, 2), 'utf8')

const p = await import('../server/projects.mjs')
const r = await import('../server/reviews.mjs')
const userA = { id: 'u_a', name: 'A' }
const userB = { id: 'u_b', name: 'B' }

let projectId = ''

test('建作品只存引用，不复制脚本与分镜', async () => {
  const project = await p.createProject({ title: parsed.title, templateId: parsed.id }, userA)
  projectId = project.id
  assert.equal(project.templateId, 'tpl_a')
  assert.equal(project.flowId, '')
  assert.equal(project.status, 'active')
  assert.ok(!('structure' in project), '作品不该自带一份脚本副本')
  assert.ok(!('storyboard' in project), '作品不该自带一份分镜副本')
  assert.equal(project.ownerId, 'u_a')
})

test('列表按最近改动排序，归属互相隔离', async () => {
  const older = await p.createProject({ templateId: 'tpl_a' }, userA)
  await p.updateProject(older.id, { title: '刚改过的' }, userA)
  const mine = await p.listProjects(userA)
  assert.equal(mine[0].id, older.id, '最近改过的作品排最前')
  assert.deepEqual((await p.listProjects(userB)).map((item) => item.id), [])
  assert.equal(await p.getProject(projectId, userB), null, '别人的作品读不到')
})

test('绑定画布与状态只动受管字段，非法状态不生效', async () => {
  const bound = await p.updateProject(projectId, { flowId: 'flow_1' }, userA)
  assert.equal(bound.flowId, 'flow_1')
  const done = await p.updateProject(projectId, { status: 'done' }, userA)
  assert.equal(done.status, 'done')
  const kept = await p.updateProject(projectId, { status: '删掉吧' }, userA)
  assert.equal(kept.status, 'done', '未知状态保持原值，不写进存储')
})

test('评审按 projectId 计数，并给出最近一次结论', async () => {
  await r.saveReview({ user: userA, projectId, intent: '第一评', result: { verdict: 'fail', summary: '', observations: [], ms: 1 } })
  await r.saveReview({ user: userA, projectId, intent: '第二评', result: { verdict: 'pass', summary: '', observations: [], ms: 1 } })
  await r.saveReview({ user: userA, intent: '不属于作品', result: { verdict: 'pass', summary: '', observations: [], ms: 1 } })
  const counts = await r.reviewCountsByProject(userA)
  assert.equal(counts[projectId].count, 2)
  assert.equal(counts[projectId].lastVerdict, 'pass')
  const scoped = await r.listReviews({ projectId, limit: 10 }, userA)
  assert.equal(scoped.total, 2)
  assert.ok(scoped.items.every((item) => item.projectId === projectId))
})

test('删作品后评审留为历史，不再挂在任何作品上', async () => {
  const removed = await p.deleteProject(projectId, userA)
  assert.equal(removed.id, projectId)
  const detached = await r.detachReviewsFromProject(projectId)
  assert.equal(detached, 2)
  const all = await r.listReviews({ limit: 10 }, userA)
  assert.ok(all.items.every((item) => !item.projectId))
  assert.equal(await p.getProject(projectId, userA), null)
  assert.equal(await p.deleteProject(projectId, userA), null, '删过的不能再删一次')
})

test('第一张画布把作品推进 v1，开一版新的归档旧画布、版本号递增', async () => {
  const project = await p.createProject({ title: '多版本', templateId: 'tpl_a' }, userA)
  assert.equal(project.version, 0, '还没开画布是 v0')
  const bound = await p.updateProject(project.id, { flowId: 'flow_a' }, userA)
  assert.equal(bound.version, 1, '绑上第一张画布就是 v1')

  // 改名、改状态都不该让版本号自己往上跳
  const renamed = await p.updateProject(project.id, { title: '多版本 · 折叠收纳' }, userA)
  assert.equal(renamed.version, 1)
  assert.equal(renamed.title, '多版本 · 折叠收纳')

  const next = await p.archiveProjectVersion(project.id, { flowId: 'flow_b', name: '折叠收纳 v2', prevName: '第一版画布' }, userA)
  assert.equal(next.version, 2)
  assert.equal(next.flowId, 'flow_b')
  assert.equal(next.versions.length, 1)
  assert.deepEqual(
    { n: next.versions[0].n, flowId: next.versions[0].flowId, name: next.versions[0].name },
    { n: 1, flowId: 'flow_a', name: '第一版画布' },
  )
  assert.ok(!('nodes' in next.versions[0]), '归档只存画布指针，不复制节点')

  // 老数据没有 version 字段：按「归档几版 + 当前一版」推出来，不会显示成 v0
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify([{ ...next, version: undefined, versions: [{ n: 1, flowId: 'flow_a', name: '第一版' }] }]),
    'utf8',
  )
  // 换一个模块实例读盘，确认老数据（没有 version 字段）也能推出 v2 而不是 v0
  const fresh = await import('../server/projects.mjs?legacy-read')
  const reloaded = await fresh.getProject(next.id, userA)
  assert.equal(reloaded.version, 2)
})

test('评审按版本记账，版本对照的计数互不串', async () => {
  const project = await p.createProject({ title: '对照', templateId: 'tpl_a' }, userA)
  await p.updateProject(project.id, { flowId: 'flow_x' }, userA)
  await r.saveReview({ user: userA, projectId: project.id, version: 1, result: { verdict: 'fail', summary: '', observations: [], ms: 1 } })
  await p.archiveProjectVersion(project.id, { flowId: 'flow_y', prevName: '第一版' }, userA)
  await r.saveReview({ user: userA, projectId: project.id, version: 2, result: { verdict: 'needs_review', summary: '', observations: [], ms: 1 } })

  const counts = await r.reviewSummaryByVersion(project.id, userA)
  assert.equal(counts['1'].count, 1)
  assert.equal(counts['1'].lastVerdict, 'fail')
  assert.equal(counts['2'].count, 1)
  assert.equal(counts['2'].lastVerdict, 'needs_review')

  const scoped = await r.listReviews({ projectId: project.id, limit: 10 }, userA)
  assert.deepEqual(scoped.items.map((item) => item.version).sort(), [1, 2], '每条评审都带版本号')
})

