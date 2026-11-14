import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 交付留痕：标记交付要记下「交的是哪一版、什么时候」。
// 这一组盯四件事：
//   1) 标记交付落一条记录，同版重复标记只更新时间；
//   2) 交付了 v1 再开 v2，v2 不能继续说「已交付」（胶囊、待办、交付稿三处一起翻案）；
//   3) 开新版 / 重新打开都不删交付记录，旧版「交过」这件事查得到；
//   4) 老数据没有交付记录时照旧：status=done 就是这一版交了，只是时间没记录。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-project-delivery-'))
process.env.DATA_DIR = dir

const at = (day, hour, minute = 0) =>
  '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':00.000Z'

/**
 * prj_new    v1 在做：用来走「标记交付 → 开新版」
 * prj_legacy v1 已交付、没有交付记录：老数据，读出来仍然算这一版交了（时间没记录）
 * prj_stale  v2 已标记交付，但交付记录只有 v1：v2 还没交，胶囊不能写已交付
 * prj_never  v1 在做：从没标记交付
 */
const projects = [
  { id: 'prj_new', ownerId: 'u_a', title: '新交付', templateId: '', flowId: 'flow_new', version: 1, versions: [], status: 'active', createdAt: at(10, 1), updatedAt: at(10, 1) },
  { id: 'prj_legacy', ownerId: 'u_a', title: '老记录', templateId: '', flowId: 'flow_legacy', version: 1, versions: [], status: 'done', createdAt: at(9, 1), updatedAt: at(11, 1) },
  {
    id: 'prj_stale', ownerId: 'u_a', title: '开新版', templateId: '', flowId: 'flow_stale2', version: 2,
    versions: [{ n: 1, flowId: 'flow_stale1', name: '开新版 v1', archivedAt: at(11, 3) }],
    status: 'done', deliveries: [{ version: 1, at: at(11, 4) }], createdAt: at(10, 2), updatedAt: at(12, 2),
  },
  { id: 'prj_never', ownerId: 'u_a', title: '没交过', templateId: '', flowId: 'flow_never', version: 1, versions: [], status: 'active', createdAt: at(10, 3), updatedAt: at(10, 3) },
]
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')

const reviews = [
  { id: 'rev_stale', ownerId: 'u_a', projectId: 'prj_stale', version: 2, createdAt: at(12, 1), result: { verdict: 'fail', summary: '不行', observations: [] }, source: { kind: 'url', label: 'x' } },
  { id: 'rev_legacy', ownerId: 'u_a', projectId: 'prj_legacy', version: 1, createdAt: at(11, 1), result: { verdict: 'pass', summary: '可以', observations: [] }, source: { kind: 'url', label: 'x' } },
  { id: 'rev_never', ownerId: 'u_a', projectId: 'prj_never', version: 1, createdAt: at(12, 0), result: { verdict: 'needs_review', summary: '看看', observations: [] }, source: { kind: 'url', label: 'x' } },
]
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify(reviews, null, 2), 'utf8')

const { getProject, listProjects, updateProject, archiveProjectVersion } = await import('../server/projects.mjs')
const { deliveryOf, deliveredCurrent, projectStatus } = await import('../server/project-status.mjs')
const { reviewQueue } = await import('../server/review-queue.mjs')
const { projectDeliverable } = await import('../server/project-deliverable.mjs')
const { publicProjectView } = await import('../server/project-share.mjs')

const me = { id: 'u_a' }
const NOW = new Date('2026-11-13T03:00:00.000Z')

/** 交付稿只需要这些字段：抬头、版本对照与交付小节读得到就行。 */
function deliverableOf(project, { versionCounts = {} } = {}) {
  return projectDeliverable(
    {
      project,
      template: null,
      flow: project.flowId ? { id: project.flowId, name: project.title, nodes: 3, updatedAt: project.updatedAt } : null,
      script: null,
      reviews: [],
      decisions: [],
      versions: (project.versions || []).map((entry) => ({
        ...entry,
        available: true,
        nodes: 2,
        scriptBeats: 0,
        scriptSnapshot: null,
        nodeList: null,
      })),
      versionCounts,
      runs: [],
      runTotal: 0,
      runCounts: {},
    },
    { now: NOW, tzOffsetMinutes: 480 },
  ).markdown
}

test('老数据：已标记交付但没有记录，仍然算这一版交了，时间如实写没记录', async () => {
  const project = await getProject('prj_legacy', me)
  assert.equal(project.status, 'done')
  assert.deepEqual(project.deliveries, [], '没有记录时读出来是空数组，不凭空造一条')
  assert.equal(deliveredCurrent(project), true)
  assert.equal(deliveryOf(project), null)
  assert.equal(projectStatus(project, { count: 1, lastVerdict: 'pass', lastAt: at(11, 1) }).text, '已交付')
  assert.match(deliverableOf(project), /- 交付：这一版已经交付（时间没记录，老记录）/)
})

test('交付了 v1 又开 v2：v2 还没交，胶囊、待办、交付稿一起翻案', async () => {
  const project = await getProject('prj_stale', me)
  assert.equal(project.status, 'done', '标记交付这个状态没被抹掉')
  assert.deepEqual(project.deliveries, [{ version: 1, at: at(11, 4) }], '交付记录照样读得到')
  assert.equal(deliveredCurrent(project), false, '交的是 v1，不是现在这一版')
  const status = projectStatus(project, { count: 1, lastVerdict: 'fail', lastAt: at(12, 1) })
  assert.equal(status.text, '评审 · 不通过', '胶囊退回当前版的评审结论，不再写已交付')
  assert.equal(status.tone, 'fail')

  const queue = await reviewQueue(me, { limit: 20 })
  assert.ok(queue.items.some((row) => row.projectId === 'prj_stale'), '这一版还没交、结论是不通过：它要回到待办')
  assert.ok(!queue.items.some((row) => row.projectId === 'prj_legacy'), '真的交出去的那条不进待办')

  const markdown = deliverableOf(project, { versionCounts: { '2': { count: 1, lastVerdict: 'fail', lastAt: at(12, 1) } } })
  assert.match(markdown, /- 状态：评审 · 不通过（当前第 2 版）/)
  assert.match(markdown, /- 交付：这一版还没交付 · 上一版 v1 于 2026-11-11 12:00 交付/)
  assert.match(markdown, /\| v1 · 已交付 \|/, '版本对照里要标出哪一版交过')
})

test('从没标记交付的写「还没交付过」，不写一个假的交付时间', async () => {
  const project = await getProject('prj_never', me)
  assert.equal(deliveryOf(project), null)
  assert.equal(deliveredCurrent(project), false)
  assert.match(deliverableOf(project), /- 交付：还没交付过/)
})

test('标记交付：记下版次与时间；同版重复标记只更新时间，不堆记录', async () => {
  const done = await updateProject('prj_new', { status: 'done' }, me)
  assert.equal(done.status, 'done')
  assert.equal(done.deliveries.length, 1)
  assert.equal(done.deliveries[0].version, 1)
  assert.ok(Number.isFinite(Date.parse(done.deliveries[0].at)), '交付时间是服务端现写的 ISO 时间')
  assert.equal(deliveredCurrent(done), true)
  assert.equal(projectStatus(done, { count: 0, lastVerdict: '', lastAt: '' }).text, '已交付')
  assert.match(deliverableOf(done), /- 交付：这一版已经交付 · v1 · /)

  const first = done.deliveries[0].at
  const again = await updateProject('prj_new', { status: 'done' }, me)
  assert.equal(again.deliveries.length, 1, '同一版再标记一次不该多出一条')
  assert.ok(Date.parse(again.deliveries[0].at) >= Date.parse(first))
})

test('重新打开 = 收回这一版的交付：记录撤掉，胶囊回到在做，不留一条假记录', async () => {
  const reopened = await updateProject('prj_new', { status: 'active' }, me)
  assert.equal(reopened.status, 'active')
  assert.deepEqual(reopened.deliveries, [], '这一版的交付是刚按的，撤销就撤干净')
  assert.equal(deliveredCurrent(reopened), false)
  assert.equal(projectStatus(reopened, { count: 0, lastVerdict: '', lastAt: '' }).text, '在做')

  // 撤销之后再交：记录重新落一条，不是「交过一次就再也撤不掉」
  const again = await updateProject('prj_new', { status: 'done' }, me)
  assert.deepEqual(again.deliveries.map((entry) => entry.version), [1])
  assert.equal(deliveredCurrent(again), true)
})

test('开新版：上一版的交付记录留下，作品回到在做', async () => {
  const next = await archiveProjectVersion('prj_new', { flowId: 'flow_new2', prevName: '新交付 v1' }, me)
  assert.equal(next.version, 2)
  assert.equal(next.status, 'active', '新版还没交，状态回到在做')
  assert.deepEqual(next.deliveries.map((entry) => entry.version), [1], 'v1 交过这件事查得到')
  assert.equal(deliveredCurrent(next), false)
  const queue = await reviewQueue(me, { limit: 20 })
  assert.ok(!queue.items.some((row) => row.projectId === 'prj_new'), '新版还没评过，不急着催')
})

test('老数据开新版：补一条「时间没记录」的交付记录，不把已交付状态带进新版', async () => {
  const next = await archiveProjectVersion('prj_legacy', { flowId: 'flow_legacy2', prevName: '老记录 v1' }, me)
  assert.equal(next.version, 2)
  assert.equal(next.status, 'active')
  assert.deepEqual(
    next.deliveries.map((entry) => ({ version: entry.version, at: entry.at })),
    [{ version: 1, at: '' }],
    '版次知道，时间只能如实写空',
  )
  // v0.9.85：收尾这一刻这一版评成什么样，跟着补的那条记录一起记下
  assert.equal(next.deliveries[0].review?.verdict, 'pass', '开新版给上一版收尾，也把当时的评审快照记下来')
  assert.equal(deliveredCurrent(next), false)
})

test('列表给卡片：每条作品带自己的交付记录，卡片胶囊才不会集体写已交付', async () => {
  const items = await listProjects(me)
  const stale = items.find((item) => item.id === 'prj_stale')
  const fresh = items.find((item) => item.id === 'prj_new')
  assert.deepEqual(stale.deliveries, [{ version: 1, at: at(11, 4) }])
  assert.deepEqual(fresh.deliveries.map((entry) => entry.version), [1])
})

test('只读分享页：交过 v1 又开 v2 的作品写「在做」，不写「已交付」', async () => {
  const stale = await getProject('prj_stale', me)
  const view = publicProjectView({ project: stale, template: null, script: null, reviews: { count: 1, lastVerdict: 'fail', lastAt: at(12, 1) }, runs: 0, token: 'tok_x' })
  assert.equal(view.project.status, 'active')

  const done = await getProject('prj_new', me)
  const reopened = await updateProject('prj_new', { status: 'done' }, me)
  const doneView = publicProjectView({ project: reopened, template: null, script: null, reviews: { count: 0, lastVerdict: '', lastAt: '' }, runs: 0, token: 'tok_x' })
  assert.equal(doneView.project.status, 'done', '这一版交出去了，分享页才写已交付')
  assert.ok(done.updatedAt)
})
