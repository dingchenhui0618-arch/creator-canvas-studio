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
  assert.equal(next.basedOn, 0, '普通开版接着上一版，没有底座')
  assert.equal(next.versions[0].basedOn, 0)
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

test('开新版时把这一版的脚本存进归档：历史版本当时说了什么还能查', async () => {
  const project = await p.createProject({ title: '快照', templateId: 'tpl_a' }, userA)
  await p.updateProject(project.id, { flowId: 'flow_s1' }, userA)
  const snapshot = {
    hook: '旧钩子',
    structure: [{ beat: '开场', voiceover: '第一版的一句', startSec: 0, endSec: 3, expectedSec: 2.9 }],
    source: 'template',
    updatedAt: '2026-11-12T04:00:00.000Z',
  }
  const archived = await p.archiveProjectVersion(project.id, { flowId: 'flow_s2', prevName: '第一版', script: snapshot }, userA)
  const entry = archived.versions[0]
  assert.equal(entry.script.hook, '旧钩子')
  assert.equal(entry.script.structure[0].voiceover, '第一版的一句')
  assert.equal(entry.script.source, 'template', '当时跟随模板也要记下来')

  // 落盘再读：快照跟作品一起存住，而不仅仅活在内存里
  const fresh = await import('../server/projects.mjs?snapshot-read')
  const reloaded = await fresh.getProject(project.id, userA)
  assert.equal(reloaded.versions[0].script.structure[0].voiceover, '第一版的一句')
  assert.equal(reloaded.versions[0].script.structure[0].expectedSec, 2.9)

  // 没传快照的归档版本记成空，而不是凭空编一份出来
  const later = await p.archiveProjectVersion(project.id, { flowId: 'flow_s3', prevName: '第二版' }, userA)
  assert.equal(later.versions[1].script, null)
})


test('以旧版为底开新版：新一版的脚本换回旧版快照，当前版归档保留自己的话', async () => {
  const project = await p.createProject({ title: '回退', templateId: 'tpl_a' }, userA)
  await p.updateProject(project.id, { flowId: 'flow_r1' }, userA)
  const A = {
    hook: '第一版的钩子',
    structure: [{ beat: '开场', voiceover: '第一版的一句', startSec: 0, endSec: 3 }],
    source: 'project',
    updatedAt: '2026-11-14T10:00:00.000Z',
  }
  const B = {
    hook: '第二版的钩子',
    structure: [{ beat: '开场', voiceover: '第二版改过的一句', startSec: 0, endSec: 3 }],
    source: 'project',
    updatedAt: '2026-11-14T11:00:00.000Z',
  }
  await p.saveProjectScript(project.id, A)
  await p.archiveProjectVersion(project.id, { flowId: 'flow_r2', prevName: '第一版', script: A }, userA)
  await p.saveProjectScript(project.id, B)
  const rebased = await p.archiveProjectVersion(project.id, {
    flowId: 'flow_r3',
    prevName: '第二版',
    script: B,
    nextScript: A,
    basedOn: 1,
  }, userA)
  assert.equal(rebased.version, 3)
  assert.equal(rebased.basedOn, 1, '新一版要记住是从 v1 回来的')
  assert.equal(rebased.flowId, 'flow_r3')
  assert.equal(rebased.script.hook, '第一版的钩子', '新一版脚本要回到旧版快照')
  assert.equal(rebased.versions[0].script.hook, '第一版的钩子', 'v1 的快照不能动')
  assert.equal(rebased.versions[1].script.hook, '第二版的钩子', 'v2 归档的是它自己的脚本')
  assert.equal(rebased.versions[1].basedOn, 0, 'v2 不是回退来的，没有底座')

  // v3 归档时，来源要跟着它一起归档；新开的 v4 不再继承 v3 的底座
  const later = await p.archiveProjectVersion(project.id, { flowId: 'flow_r4', prevName: '第三版' }, userA)
  assert.equal(later.version, 4)
  assert.equal(later.basedOn, 0, '普通开版不继承底座')
  assert.equal(later.versions[2].basedOn, 1, 'v3 归档后仍然是从 v1 回来的')
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


test('运行归集：作品名下各版画布的运行合成一条线，按时间倒序且互不越权', async () => {
  const flows = await import('../server/flows.mjs')
  // 直属运行存储的形态：一次运行一条，带 flowId / status / 节点结果 / ownerId
  fs.writeFileSync(
    path.join(dir, 'runs.json'),
    JSON.stringify([
      { id: 'run_a1', flowId: 'flow_a', flowName: 'A v1', status: 'success', startedAt: '2026-11-01T10:00:00.000Z', durationMs: 1200, total: 3, nodes: [{ status: 'success' }], output: 'x', error: null, ownerId: 'u_a' },
      { id: 'run_b2', flowId: 'flow_b', flowName: 'B v2', status: 'error', startedAt: '2026-11-02T10:00:00.000Z', durationMs: 4200, total: 3, nodes: [{ status: 'success' }, { status: 'error' }], output: '', error: '节点失败', ownerId: 'u_a' },
      { id: 'run_other', flowId: 'flow_a', flowName: 'A v1', status: 'success', startedAt: '2026-11-03T10:00:00.000Z', durationMs: 900, total: 3, nodes: [], ownerId: 'u_b' },
      { id: 'run_unrelated', flowId: 'flow_z', flowName: 'Z', status: 'success', startedAt: '2026-11-04T10:00:00.000Z', durationMs: 900, total: 1, nodes: [], ownerId: 'u_a' },
    ]),
    'utf8',
  )
  const result = await flows.listRunsByFlows(['flow_a', 'flow_b'], { limit: 1 }, userA)
  assert.equal(result.total, 2, '别人跑的和别的画布都不该进来')
  assert.deepEqual(result.byFlow, { flow_a: 1, flow_b: 1 }, '按画布分组；当前版的运行不会串到归档版')
  assert.equal(result.items.length, 1, 'limit 只限制返回条数，total 仍是作品全量')
  assert.deepEqual((await flows.listRunsByFlows(['flow_a'], {}, userB)).items.map((run) => run.id), ['run_other'], '换一个账号只看得到自己的运行')

  const all = await flows.listRunsByFlows(['flow_a', 'flow_b'], { limit: 10 }, userA)
  assert.deepEqual(all.items.map((run) => run.id), ['run_b2', 'run_a1'], '按开始时间倒序，跨版本合成一条线')
  assert.equal(all.items[0].failed, 1)
  assert.equal(all.items[0].error, '节点失败')
  assert.ok(!('nodes' in all.items[0]), '摘要不带逐节点输出')
  assert.equal((await flows.listRunsByFlows([], {}, userA)).total, 0, '没有画布就没有运行')
})
