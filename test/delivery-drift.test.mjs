import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 交付之后的漂移（v0.9.86）：交出去那一刻这一版评成 X，后来又被评成 Y。
// 上一版（v0.9.85）把「交时结论」存成了快照，这一版回答的是「后来变没变」——
// 两句都要在：交时照写当初，后面补一句后来变了什么，谁都不改写谁。
// 这一组盯住五件事：
//   1) 规则只在两边都记着认得出的结论时开口，且只比前三档（信息级不算问题）；
//   2) 客户端与服务端两份实现给出同一个答案（同一组用例对照）；
//   3) 交时没评过（null）、升级前没记（没有字段）都不写成「之后又评成」；
//   4) 同一版重新标记交付会写新快照，漂移自己消失；
//   5) 交付流水、交付稿、页面文案把「交时」与「后来」两句都写出来。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-drift-'))
process.env.DATA_DIR = dir

const at = (day, hour) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'
const obs = (severity) => ({ dimension: '字幕', severity, statement: '一行太长', confidence: 0.8 })
const result = (verdict, observations = []) => ({ verdict, summary: '看这里', observations })
const issues = (counts = {}) => ({ blocker: 0, major: 0, minor: 0, info: 0, counted: 0, observations: 0, ...counts })
const snap = (verdict, extra = {}) => ({ verdict, at: at(1, 1), issues: issues(), ...extra })

const mk = (id, extra = {}) => ({
  id, ownerId: 'u_a', title: id, templateId: '', flowId: 'flow_' + id,
  version: 1, versions: [], status: 'active', createdAt: at(1, 1), updatedAt: at(1, 1), ...extra,
})

const projects = [
  mk('prj_worse'),      // 交时通过，之后评成不通过
  mk('prj_better'),     // 交时不通过，之后评成通过
  mk('prj_issues'),     // 交时通过（1 阻塞），之后通过（2 阻塞）
  mk('prj_gap'),        // 交时一版都没评过，之后评了
  // 老交付记录：有版次与时间，没有 review 字段
  mk('prj_legacy', { status: 'done', deliveries: [{ version: 1, at: at(3, 1) }] }),
  // 盘上被手改坏：认不出的结论、负的问题数
  mk('prj_dirty', { status: 'done', deliveries: [{ version: 1, at: at(3, 2), review: { verdict: 'maybe', at: 9, issues: { blocker: -2 } } }] }),
  mk('prj_resnap'),     // 交时通过，之后不通过，再交付一次
]
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')

const first = [
  { id: 'rev_w1', ownerId: 'u_a', projectId: 'prj_worse', version: 1, createdAt: at(1, 2), result: result('pass', []), source: {} },
  { id: 'rev_b1', ownerId: 'u_a', projectId: 'prj_better', version: 1, createdAt: at(1, 3), result: result('fail', [obs('blocker')]), source: {} },
  { id: 'rev_i1', ownerId: 'u_a', projectId: 'prj_issues', version: 1, createdAt: at(1, 4), result: result('pass', [obs('blocker')]), source: {} },
  { id: 'rev_l1', ownerId: 'u_a', projectId: 'prj_legacy', version: 1, createdAt: at(1, 5), result: result('pass', []), source: {} },
  { id: 'rev_d1', ownerId: 'u_a', projectId: 'prj_dirty', version: 1, createdAt: at(1, 6), result: result('pass', []), source: {} },
  { id: 'rev_r1', ownerId: 'u_a', projectId: 'prj_resnap', version: 1, createdAt: at(1, 7), result: result('pass', []), source: {} },
]
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify(first, null, 2), 'utf8')

const { updateProject, getProject, listProjects } = await import('../server/projects.mjs')
const { saveReview, reviewSummaryByVersion, reviewCountsByProject } = await import('../server/reviews.mjs')
const { deliveryDrift: driftOnServer } = await import('../server/project-status.mjs')
const { ledgerRows, deliveryLedger } = await import('../server/delivery-ledger.mjs')
const { projectDeliverable } = await import('../server/project-deliverable.mjs')
const client = await import('../src/domain/review.ts')

const me = { id: 'u_a' }
const NOW = new Date('2026-11-14T03:00:00.000Z')

// 先各自交出去一次（快照写的是当时的结论），再让其中几条被重评
for (const id of ['prj_worse', 'prj_better', 'prj_issues', 'prj_gap', 'prj_resnap']) {
  await updateProject(id, { status: 'done' }, me)
}
await saveReview({ user: me, projectId: 'prj_worse', version: 1, result: result('fail', [obs('blocker')]), source: {} })
await saveReview({ user: me, projectId: 'prj_better', version: 1, result: result('pass', []), source: {} })
await saveReview({ user: me, projectId: 'prj_issues', version: 1, result: result('pass', [obs('blocker'), obs('blocker')]), source: {} })
await saveReview({ user: me, projectId: 'prj_gap', version: 1, result: result('fail', []), source: {} })
await saveReview({ user: me, projectId: 'prj_resnap', version: 1, result: result('fail', []), source: {} })

/** 交付流水按版本读的计数：与作品页同一份（reviewSummaryByVersion 的口径）。 */
async function ledgerCounts() {
  const counts = {}
  for (const project of projects) counts[project.id] = { versions: await reviewSummaryByVersion(project.id, me) }
  return counts
}

/** 交付稿：只喂交付小节与版本表要的字段。 */
function deliverableOf(project, versionCounts = {}) {
  return projectDeliverable(
    {
      project,
      template: null,
      flow: { id: project.flowId, name: project.title, nodes: 3, updatedAt: project.updatedAt },
      script: null,
      reviews: [],
      decisions: [],
      versions: (project.versions || []).map((entry) => ({ ...entry, available: true, nodes: 2, scriptBeats: 0, scriptSnapshot: null, nodeList: null })),
      versionCounts,
      runs: [],
      runTotal: 0,
      runCounts: {},
    },
    { now: NOW, tzOffsetMinutes: 480 },
  ).markdown
}

test('规则：结论变了才算结论漂移，变差与变好分开说', () => {
  const worse = driftOnServer(snap('pass'), { verdict: 'fail', issues: null })
  assert.deepEqual(worse, { kind: 'verdict', from: 'pass', verdict: 'fail', issues: null, tone: 'worse' })
  const better = driftOnServer(snap('fail'), { verdict: 'pass', issues: null })
  assert.equal(better?.tone, 'better')
  assert.equal(driftOnServer(snap('pass'), { verdict: 'pass', issues: null }), null, '结论没变、问题数也没变：不开口')
  assert.equal(driftOnServer(snap('needs_review'), { verdict: 'needs_review', issues: issues() }), null)
})

test('规则：结论没变、问题数变了也算；信息级不参与比较', () => {
  const up = driftOnServer(snap('pass', { issues: issues({ blocker: 1, counted: 1 }) }), { verdict: 'pass', issues: issues({ blocker: 2, counted: 2 }) })
  assert.equal(up?.kind, 'issues')
  assert.equal(up?.tone, 'worse')
  const down = driftOnServer(snap('pass', { issues: issues({ major: 2, counted: 2 }) }), { verdict: 'pass', issues: issues({ major: 1, counted: 1 }) })
  assert.equal(down?.tone, 'better')
  // 只多了一条信息级：不算问题（与版本对照同一套比法）
  assert.equal(driftOnServer(snap('pass'), { verdict: 'pass', issues: issues({ info: 3, counted: 3 }) }), null)
})

test('规则：老数据、坏数据、交时没评过——一律不编「变了」', () => {
  assert.equal(driftOnServer(null, { verdict: 'fail', issues: null }), null, '交的时候还没评过，比不了')
  assert.equal(driftOnServer(undefined, { verdict: 'fail', issues: null }), null, '升级前的老记录没有快照')
  assert.equal(driftOnServer(snap('maybe'), { verdict: 'fail', issues: null }), null, '认不出的结论不硬比')
  assert.equal(driftOnServer(snap('pass'), { verdict: '', issues: null }), null, '这一版没有认得出的结论')
  // 盘上写坏的负数按 0 算：0 与 0 相等，不报漂移
  assert.equal(driftOnServer(snap('pass', { issues: issues({ blocker: -2 }) }), { verdict: 'pass', issues: issues() }), null)
})

test('客户端与服务端两份实现：同一组用例给出同一个答案', () => {
  const cases = [
    ['结论变差', snap('pass'), { verdict: 'fail', issues: issues({ blocker: 1, counted: 1 }) }],
    ['结论变好', snap('fail'), { verdict: 'pass', issues: null }],
    ['结论没变', snap('pass'), { verdict: 'pass', issues: issues() }],
    ['问题变多', snap('pass', { issues: issues({ major: 1, counted: 1 }) }), { verdict: 'pass', issues: issues({ major: 3, counted: 3 }) }],
    ['问题变少', snap('needs_review', { issues: issues({ blocker: 2, counted: 2 }) }), { verdict: 'needs_review', issues: issues({ blocker: 1, counted: 1 }) }],
    ['只有信息级', snap('pass'), { verdict: 'pass', issues: issues({ info: 2, counted: 2 }) }],
    ['快照为 null', null, { verdict: 'fail', issues: null }],
    ['最近一评没结论', snap('pass'), { verdict: '', issues: null }],
    ['快照结论认不出', snap('oops'), { verdict: 'fail', issues: null }],
  ]
  for (const [name, snapshot, latest] of cases) {
    assert.deepEqual(client.deliveryDrift(snapshot, latest), driftOnServer(snapshot, latest), name)
  }
})

test('页面文案：两种漂移各一句话，没漂移回空串', () => {
  assert.equal(
    client.deliveryDriftText(driftOnServer(snap('pass'), { verdict: 'fail', issues: null })),
    '之后又评成「不通过」',
  )
  assert.equal(
    client.deliveryDriftText(driftOnServer(snap('pass', { issues: issues({ blocker: 1, counted: 1 }) }), { verdict: 'pass', issues: issues({ blocker: 2, counted: 2 }) })),
    '之后又评过一次（2 阻塞）',
  )
  assert.equal(client.deliveryDriftText(null), '')
})

test('交付记录本身不被重评改写：交时仍是当初那句', async () => {
  const project = await getProject('prj_worse', me)
  assert.equal(project.deliveries[0].review.verdict, 'pass', '交时快照照旧')
  const bucket = await reviewSummaryByVersion('prj_worse', me)
  assert.equal(bucket['1'].lastVerdict, 'fail', '这一版现在是另一句结论')
  assert.equal(driftOnServer(project.deliveries[0].review, { verdict: bucket['1'].lastVerdict, issues: bucket['1'].issues })?.tone, 'worse')
})

test('交付流水：每行带这一版最近一评的问题数，漂移条数按交付记录数', async () => {
  const rows = ledgerRows({ projects: await listProjects(me), counts: await ledgerCounts() })
  const worse = rows.find((row) => row.projectId === 'prj_worse')
  assert.equal(worse.verdict, 'fail', '最近一评的结论')
  assert.equal(worse.issues?.blocker, 1, '最近一评的问题数（不是交时那份）')
  assert.equal(worse.review.verdict, 'pass', '交时快照仍在')

  // 接口这条路用的是 reviewCountsByProject：这一份也必须带 issues，否则线上流水算不出「问题数变了」
  const apiCounts = await reviewCountsByProject(me)
  assert.equal(apiCounts.prj_issues.versions['1'].issues?.blocker, 2, '接口计数带这一版最近一评的问题数')

  const ledger = deliveryLedger({ projects: await listProjects(me), counts: await ledgerCounts() })
  assert.equal(ledger.total, 7, '七条交付记录')
  // prj_worse / prj_better / prj_issues / prj_resnap 交出去之后都被重评成了别的结论（此时还没重新交付）
  assert.equal(ledger.drifted, 4)
  const gap = ledger.items.find((row) => row.projectId === 'prj_gap')
  assert.equal(gap.review, null, '交的时候没评过')
  assert.equal(driftOnServer(gap.review, { verdict: gap.verdict, issues: gap.issues }), null)
})

test('交付稿：交时评审照写当初，后面补一句后来变了什么', async () => {
  const worse = await getProject('prj_worse', me)
  const markdown = deliverableOf(worse, await reviewSummaryByVersion('prj_worse', me))
  assert.match(markdown, /- 交时评审：通过 · 之后又评成「不通过」/)
  assert.match(markdown, /- 交付记录：v1 · .* · 交时评审 通过 · 之后又评成「不通过」/)
})

test('交付稿：结论没变但问题数变了，纸上写清现在几条（用这份稿自己的严重度写法）', async () => {
  const project = await getProject('prj_issues', me)
  const markdown = deliverableOf(project, await reviewSummaryByVersion('prj_issues', me))
  assert.match(markdown, /· 之后又评过一次（2 个阻断）/)
})

test('交付稿：归档那一版也会写漂移（开新版之后旧交付仍然对得上）', () => {
  const project = {
    ...mk('prj_arch', {
      version: 2,
      status: 'active',
      deliveries: [{ version: 1, at: at(2, 1), review: { verdict: 'pass', at: at(1, 1), issues: issues() } }],
      versions: [{ n: 1, name: '第一版', archivedAt: at(3, 1) }],
    }),
  }
  const counts = { '1': { count: 2, lastVerdict: 'fail', lastAt: at(3, 2), issues: issues({ major: 1, counted: 1 }) } }
  const markdown = deliverableOf(project, counts)
  assert.match(markdown, /- 交付：.* · 交时评审 通过 · 之后又评成「不通过」/)
})

test('交时没评过、升级前没记：不写成「之后又评成」', async () => {
  const gap = await getProject('prj_gap', me)
  const gapMarkdown = deliverableOf(gap, await reviewSummaryByVersion('prj_gap', me))
  assert.match(gapMarkdown, /- 交时评审：还没评过/)
  assert.doesNotMatch(gapMarkdown, /之后又评成/)

  const legacy = await getProject('prj_legacy', me)
  const legacyMarkdown = deliverableOf(legacy, await reviewSummaryByVersion('prj_legacy', me))
  assert.match(legacyMarkdown, /- 交时评审：没记（升级前的交付记录）/)
  assert.doesNotMatch(legacyMarkdown, /之后又评成/)

  // 盘上写坏的快照也不开口
  const dirty = await getProject('prj_dirty', me)
  const dirtyMarkdown = deliverableOf(dirty, await reviewSummaryByVersion('prj_dirty', me))
  assert.doesNotMatch(dirtyMarkdown, /之后又评成/)
})

test('同一版重新标记交付：写一份新快照，漂移自己消失', async () => {
  const before = await getProject('prj_resnap', me)
  const bucketBefore = await reviewSummaryByVersion('prj_resnap', me)
  assert.equal(driftOnServer(before.deliveries[0].review, { verdict: bucketBefore['1'].lastVerdict, issues: bucketBefore['1'].issues })?.tone, 'worse')

  const again = await updateProject('prj_resnap', { status: 'done' }, me)
  const bucketAfter = await reviewSummaryByVersion('prj_resnap', me)
  assert.equal(again.deliveries.length, 1, '同一版不堆记录')
  assert.equal(again.deliveries[0].review.verdict, 'fail', '新快照按当时的最近一评写')
  assert.equal(driftOnServer(again.deliveries[0].review, { verdict: bucketAfter['1'].lastVerdict, issues: bucketAfter['1'].issues }), null)
})
