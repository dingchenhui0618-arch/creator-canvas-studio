import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 交付时评审快照（v0.9.85）：交付记录写的是「交的时候评审怎么说」。
// 以前工作台「交出去的」每一行都拿这一版**最近一次**评审当交时结论——交付之后再评一次，
// 那一行就跟着变：历史被改写。这一组盯住五件事：
//   1) 标记交付当场把结论与问题数存进这条交付记录；
//   2) 交付之后重评，记录不变（重评只影响这一版现在的状态）；
//   3) 三种状态分得清：记下了 / 当时还没评过（null）/ 升级前的老记录（没有字段）；
//   4) 开新版给上一版收尾时，也把那一刻的评审记下；
//   5) 盘上被手改坏的快照不会让数字变成 NaN 或垃圾。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-review-'))
process.env.DATA_DIR = dir

const at = (day, hour) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'
const obs = (severity) => ({ dimension: '字幕', severity, statement: '一行太长', confidence: 0.8 })
const result = (verdict, observations = []) => ({ verdict, summary: '看这里', observations })

const projects = [
  // 标记交付走一遍：v1 评过一次（需人工确认，1 阻塞 1 主要）
  { id: 'prj_mark', ownerId: 'u_a', title: '标记交付', templateId: '', flowId: 'flow_mark', version: 1, versions: [], status: 'active', createdAt: at(10, 1), updatedAt: at(10, 1) },
  // 版本划分之前的老记录（version 0 折进 v1）
  { id: 'prj_fold', ownerId: 'u_a', title: '老评审', templateId: '', flowId: 'flow_fold', version: 1, versions: [], status: 'active', createdAt: at(10, 1), updatedAt: at(10, 1) },
  // 老交付记录：有版次与时间，没有 review 字段
  { id: 'prj_legacy', ownerId: 'u_a', title: '老交付', templateId: '', flowId: 'flow_legacy', version: 1, versions: [], status: 'done', deliveries: [{ version: 1, at: at(9, 1) }], createdAt: at(9, 0), updatedAt: at(9, 1) },
  // 当时查过：一版都没评过 → review: null
  { id: 'prj_gap', ownerId: 'u_a', title: '交时没评过', templateId: '', flowId: 'flow_gap', version: 1, versions: [], status: 'done', deliveries: [{ version: 1, at: at(10, 3), review: null }], createdAt: at(10, 2), updatedAt: at(10, 3) },
  // 收尾要开新版：v1 已交付、没有交付记录，评审是 pass
  { id: 'prj_arch', ownerId: 'u_a', title: '收尾开新版', templateId: '', flowId: 'flow_arch1', version: 1, versions: [], status: 'done', createdAt: at(10, 4), updatedAt: at(10, 4) },
  // 盘上被手改坏：verdict 认不出、issues 不是数字、review 不是对象
  {
    id: 'prj_dirty', ownerId: 'u_a', title: '坏快照', templateId: '', flowId: 'flow_dirty', version: 1, versions: [], status: 'done',
    deliveries: [
      { version: 1, at: at(10, 5), review: { verdict: 'maybe', at: 7, issues: { blocker: '3', major: -2, minor: 'x' } } },
      { version: 2, at: '', review: 'oops' },
      { version: 3, at: '', review: 42 },
    ],
    createdAt: at(10, 4), updatedAt: at(10, 5),
  },
]
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')

const reviews = [
  { id: 'rev_mark', ownerId: 'u_a', projectId: 'prj_mark', version: 1, createdAt: at(10, 2), result: result('needs_review', [obs('blocker'), obs('major')]), source: {} },
  { id: 'rev_fold', ownerId: 'u_a', projectId: 'prj_fold', version: 0, createdAt: at(10, 2), result: result('pass', []), source: {} },
  { id: 'rev_arch', ownerId: 'u_a', projectId: 'prj_arch', version: 1, createdAt: at(10, 4), result: result('pass', [obs('minor')]), source: {} },
]
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify(reviews, null, 2), 'utf8')

const { getProject, listProjects, updateProject, archiveProjectVersion } = await import('../server/projects.mjs')
const { saveReview } = await import('../server/reviews.mjs')
const { ledgerRows } = await import('../server/delivery-ledger.mjs')
const { projectDeliverable } = await import('../server/project-deliverable.mjs')
const { deliveryReviewText } = await import('../src/domain/review.ts')

const me = { id: 'u_a' }
const NOW = new Date('2026-11-14T03:00:00.000Z')
const issues = (counts = {}) => ({ blocker: 0, major: 0, minor: 0, info: 0, counted: 0, observations: 0, ...counts })

/** 交付稿只要这些字段：交付小节读的是 deliveries 与版本对照。 */
function deliverableOf(project) {
  return projectDeliverable(
    {
      project,
      template: null,
      flow: project.flowId ? { id: project.flowId, name: project.title, nodes: 3, updatedAt: project.updatedAt } : null,
      script: null,
      reviews: [],
      decisions: [],
      versions: (project.versions || []).map((entry) => ({ ...entry, available: true, nodes: 2, scriptBeats: 0, scriptSnapshot: null, nodeList: null })),
      versionCounts: {},
      runs: [],
      runTotal: 0,
      runCounts: {},
    },
    { now: NOW, tzOffsetMinutes: 480 },
  ).markdown
}

test('标记交付：把当时的结论与问题数存进这条交付记录', async () => {
  const done = await updateProject('prj_mark', { status: 'done' }, me)
  assert.equal(done.status, 'done')
  assert.equal(done.deliveries.length, 1)
  const [entry] = done.deliveries
  assert.equal(entry.version, 1)
  assert.ok(Number.isFinite(Date.parse(entry.at)), '交付时间是服务端现写的')
  assert.deepEqual(entry.review, { verdict: 'needs_review', at: at(10, 2), issues: issues({ blocker: 1, major: 1, counted: 2, observations: 2 }) })
  assert.match(deliverableOf(done), /- 交时评审：需人工确认 · 1 个阻断 · 1 个重要/)
  assert.match(deliverableOf(done), /- 交付记录：v1 · .* · 交时评审 需人工确认/)
})

test('交付之后再重评：交付记录不变，只有这一版现在的结论变', async () => {
  await saveReview({ user: me, projectId: 'prj_mark', version: 1, result: result('pass', []), source: {} })
  const reread = await getProject('prj_mark', me)
  assert.equal(reread.deliveries[0].review.verdict, 'needs_review', '交时的结论是当初的事实，重评不改历史')
  assert.equal(reread.deliveries[0].review.issues.blocker, 1)

  // 同一版重新标记一次交付：这时才按新的评审写一份新快照（人明确又交了一次）
  const again = await updateProject('prj_mark', { status: 'done' }, me)
  assert.equal(again.deliveries.length, 1, '同一版不堆记录')
  assert.equal(again.deliveries[0].review.verdict, 'pass')
  assert.equal(again.deliveries[0].review.issues.counted, 0)
})

test('版本划分之前的老评审（version 0）折进 v1：交时快照用的是同一套口径', async () => {
  const done = await updateProject('prj_fold', { status: 'done' }, me)
  assert.equal(done.deliveries[0].review?.verdict, 'pass')
  assert.equal(done.deliveries[0].review?.at, at(10, 2))
})

test('当时还没评过：review 是 null，不是「没记」也不是 0 个阻塞', async () => {
  const gap = await getProject('prj_gap', me)
  assert.equal(gap.deliveries[0].review, null)
  assert.equal(deliveryReviewText(gap.deliveries[0].review), '还没评过')
  assert.match(deliverableOf(gap), /- 交时评审：还没评过/)
})

test('升级前的老记录：没有 review 字段，界面写「没记」，不拿这一版最近一评冒充', async () => {
  const legacy = await getProject('prj_legacy', me)
  assert.equal('review' in legacy.deliveries[0], false, '老记录读出来仍然没有这个字段')
  assert.equal(deliveryReviewText(legacy.deliveries[0].review), '没记（升级前的交付记录）')
  assert.match(deliverableOf(legacy), /- 交时评审：没记（升级前的交付记录）/)
})

test('开新版给上一版收尾：补的那条记录也带上那一刻的评审', async () => {
  const next = await archiveProjectVersion('prj_arch', { flowId: 'flow_arch2', prevName: '收尾开新版 v1' }, me)
  assert.equal(next.version, 2)
  assert.equal(next.deliveries[0].version, 1)
  assert.equal(next.deliveries[0].at, '', '补的记录没有交付时间')
  assert.deepEqual(next.deliveries[0].review, { verdict: 'pass', at: at(10, 4), issues: issues({ minor: 1, counted: 1, observations: 1 }) })
})

test('交付流水：一行写交时快照，不被这一版的评审计数覆盖', async () => {
  const items = await listProjects(me)
  // 故意给一个与快照不同的「这一版最近一评」：流水不能跟着它走
  const counts = {
    prj_mark: { versions: { '1': { count: 2, lastVerdict: 'pass', lastAt: at(11, 2) } } },
    prj_legacy: { versions: { '1': { count: 1, lastVerdict: 'fail', lastAt: at(9, 2) } } },
  }
  const rows = ledgerRows({ projects: items, counts })
  const mark = rows.find((row) => row.projectId === 'prj_mark')
  assert.equal(mark.review.verdict, 'pass', '快照是重新标记那一次写的 pass')
  assert.equal(mark.reviews, 2, '这一版评过几次照旧是版本级事实')
  const legacy = rows.find((row) => row.projectId === 'prj_legacy')
  assert.equal(legacy.review, undefined, '老记录没有快照：界面只能写「没记」')
  assert.equal(legacy.verdict, 'fail', '这一版最近一评仍然给出来，但不冒充交时')
  const gap = rows.find((row) => row.projectId === 'prj_gap')
  assert.equal(gap.review, null)
})

test('盘上被手改坏的快照：认不出的结论写空、问题数不进负数与 NaN', async () => {
  const dirty = await getProject('prj_dirty', me)
  assert.deepEqual(dirty.deliveries[0].review.issues, issues({ blocker: 3 }), '字符串数字认，负数与乱码归零')
  assert.equal(dirty.deliveries[0].review.verdict, '', '认不出的结论不硬翻成一句人话')
  assert.equal(dirty.deliveries[0].review.at, '', '时间不是字符串就写空')
  assert.equal(dirty.deliveries[1].review, null, 'review 不是对象就退回 null（当时没记下结论）')
  assert.equal(dirty.deliveries[2].review, null)
})

test('三种状态的说法各是各的：记下了 / 还没评过 / 没记', () => {
  assert.equal(deliveryReviewText({ verdict: 'fail', at: at(10, 2), issues: issues({ blocker: 2, counted: 2, observations: 3 }) }), '不通过 · 2 阻塞 · 另有 1 条没记严重度')
  assert.equal(deliveryReviewText({ verdict: '', at: '', issues: issues() }), '未记结论')
  assert.equal(deliveryReviewText(null), '还没评过')
  assert.equal(deliveryReviewText(undefined), '没记（升级前的交付记录）')
})
