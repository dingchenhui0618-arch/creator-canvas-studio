import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 运行 ↔ 作品：运行记录页要写「这条运行是哪条作品的第几版」，工作台要按作品名搜得到运行。
// 这一组盯：当前版与归档版都算这条作品的、没挂作品的写 null、同名画布不重复标题、
// 按作品名搜索能命中画布已改名的运行，且原有筛选（归属、状态、flowId）一个都没变。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-run-ownership-'))
process.env.DATA_DIR = dir

const project = (id, title, ownerId, { flowId = '', version = 0, versions = [], updatedAt = '2026-11-12T00:00:00.000Z' } = {}) => ({
  id,
  ownerId,
  title,
  templateId: '',
  flowId,
  version,
  versions,
  status: 'active',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt,
})

const projects = [
  // 两版：当前 flow_a2，归档 flow_a1
  project('prj_fold', '毛衣折叠收纳法', 'u_a', {
    flowId: 'flow_a2',
    version: 2,
    versions: [{ n: 1, flowId: 'flow_a1', name: '毛衣折叠收纳法', archivedAt: '2026-11-11T00:00:00.000Z' }],
    updatedAt: '2026-11-12T10:34:05.898Z',
  }),
  project('prj_open', '春季新品开箱', 'u_a', { flowId: 'flow_b1', version: 1, updatedAt: '2026-11-11T09:00:00.000Z' }),
  project('prj_other', '别人的作品', 'u_b', { flowId: 'flow_c1', version: 1, updatedAt: '2026-11-12T12:00:00.000Z' }),
]

const run = (id, flowId, flowName, ownerId = 'u_a', status = 'success') => ({
  id,
  flowId,
  flowName,
  ownerId,
  status,
  startedAt: '2026-11-12T10:30:00.000Z',
  finishedAt: '2026-11-12T10:30:42.000Z',
  durationMs: 42000,
  total: 8,
  nodes: [],
  output: '',
})

fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(
  path.join(dir, 'runs.json'),
  JSON.stringify(
    [
      run('run_a2', 'flow_a2', '毛衣折叠收纳法'),
      // 归档那一版的运行：画布被改过名，光看画布名认不出是哪条作品的
      run('run_a1', 'flow_a1', '未命名画布', 'u_a', 'error'),
      run('run_b1', 'flow_b1', '画布 3'),
      // 空白画布直接跑的：不属于任何作品
      run('run_x', 'flow_z', '空白画布'),
      // 别人的运行：我的列表里不该出现
      run('run_c1', 'flow_c1', '别人的画布', 'u_b'),
    ],
    null,
    2,
  ),
  'utf8',
)

const { projectsByFlow, runProjectRef, withRunProject, projectFlowsMatching } = await import('../server/run-ownership.mjs')
const { listRuns } = await import('../server/flows.mjs')

const me = { id: 'u_a' }

test('画布 → 作品：当前版与归档版都在索引里，带第几版与是否归档', () => {
  const byFlow = projectsByFlow(projects)
  assert.deepEqual(byFlow.get('flow_a2'), { id: 'prj_fold', title: '毛衣折叠收纳法', version: 2, archived: false })
  assert.deepEqual(byFlow.get('flow_a1'), { id: 'prj_fold', title: '毛衣折叠收纳法', version: 1, archived: true })
  assert.deepEqual(byFlow.get('flow_b1'), { id: 'prj_open', title: '春季新品开箱', version: 1, archived: false })
  assert.equal(byFlow.get('flow_z'), undefined, '没绑作品出来的画布不进索引')
  assert.deepEqual(Object.keys(byFlow.get('flow_a2') || {}).sort(), ['archived', 'id', 'title', 'version'], '不带脚本与凭证')
  assert.equal(projectsByFlow().size, 0, '没有作品时是空索引')
  assert.equal(runProjectRef(byFlow, 'flow_z'), null)
  assert.equal(runProjectRef(byFlow, ''), null)
})

test('同一张画布被两条作品绑着：当前版胜过归档版，都当前就按最近改动', () => {
  const shared = [
    project('prj_old', '老作品', 'u_a', { versions: [{ n: 1, flowId: 'flow_shared' }], updatedAt: '2026-11-12T12:00:00.000Z' }),
    project('prj_new', '新作品', 'u_a', { flowId: 'flow_shared', version: 2, updatedAt: '2026-11-01T00:00:00.000Z' }),
  ]
  assert.equal(projectsByFlow(shared).get('flow_shared').id, 'prj_new', '归档版不因为更新就更优先')

  const both = [
    project('prj_a', 'A', 'u_a', { flowId: 'flow_shared', version: 1, updatedAt: '2026-11-01T00:00:00.000Z' }),
    project('prj_b', 'B', 'u_a', { flowId: 'flow_shared', version: 1, updatedAt: '2026-11-10T00:00:00.000Z' }),
  ]
  assert.equal(projectsByFlow(both).get('flow_shared').id, 'prj_b', '同为当前版时按最近改动取')
})

test('逐条挂作品：加一个字段，别的字段与原数组都不动', () => {
  const byFlow = projectsByFlow(projects)
  const input = [run('run_a2', 'flow_a2', '毛衣折叠收纳法'), run('run_x', 'flow_z', '空白画布')]
  const out = withRunProject(input, byFlow)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0].project, { id: 'prj_fold', title: '毛衣折叠收纳法', version: 2, archived: false })
  assert.equal(out[1].project, null, '没挂作品的是 null，页面据此写「没挂在作品上」')
  assert.equal(out[0].durationMs, 42000, '原有字段一个不少')
  assert.equal('project' in input[0], false, '不改传进来的数组')
  assert.deepEqual(withRunProject(), [])
})

test('按作品名找画布：标题匹配的作品，当前版与归档版画布一起交回', () => {
  assert.deepEqual(projectFlowsMatching(projects, '毛衣'), ['flow_a2', 'flow_a1'])
  assert.deepEqual(projectFlowsMatching(projects, ' 春季 '), ['flow_b1'], '前后空格不算关键词')
  assert.deepEqual(projectFlowsMatching(projects, ''), [], '空关键词不扩大命中')
  assert.deepEqual(projectFlowsMatching(projects, '不存在的标题'), [])
  assert.deepEqual(projectFlowsMatching([project('prj_en', 'Sweater Fold', 'u_a', { flowId: 'flow_en' })], 'sweater'), ['flow_en'], '英文忽略大小写')
  assert.deepEqual(projectFlowsMatching(), [])
})

test('搜索按作品名命中：画布改名之后仍找得到，原有筛选不变', async () => {
  const hit = await listRuns({ q: '毛衣', flowIds: projectFlowsMatching(projects, '毛衣') }, me)
  assert.deepEqual(hit.items.map((item) => item.id).sort(), ['run_a1', 'run_a2'], '归档那一版画布改过名也命中')
  const withoutFallback = await listRuns({ q: '毛衣' }, me)
  assert.deepEqual(withoutFallback.items.map((item) => item.id), ['run_a2'], '没有补充命中集时只按画布名搜')

  const mine = await listRuns({ limit: 50 }, me)
  assert.deepEqual(mine.items.map((item) => item.id), ['run_a2', 'run_a1', 'run_b1', 'run_x'], '别人的运行不进我的列表')

  const failed = await listRuns({ status: 'error' }, me)
  assert.deepEqual(failed.items.map((item) => item.id), ['run_a1'], '状态筛选照旧')

  const oneFlow = await listRuns({ flowId: 'flow_b1' }, me)
  assert.deepEqual(oneFlow.items.map((item) => item.id), ['run_b1'], '按画布筛选照旧')
})
