import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 模板 ↔ 作品 的用量：模板库卡片要「几条作品在用」，模板详情要「是哪几条」。
// 这一组盯：只算自己能看的作品、最近的排前面、删掉作品会回落、没有模板的作品不进分组。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-template-usage-'))
process.env.DATA_DIR = dir

const project = (id, templateId, ownerId, updatedAt) => ({
  id,
  ownerId,
  title: '作品 ' + id,
  templateId,
  flowId: '',
  version: templateId === 'tpl_b' ? 2 : 1,
  versions: [],
  status: 'active',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt,
})

fs.writeFileSync(
  path.join(dir, 'projects.json'),
  JSON.stringify(
    [
      project('prj_a1', 'tpl_a', 'u_a', '2026-11-12T10:00:00.000Z'),
      project('prj_a2', 'tpl_a', 'u_a', '2026-11-10T10:00:00.000Z'),
      project('prj_b1', 'tpl_b', 'u_a', '2026-11-11T10:00:00.000Z'),
      // 模板早就删了：作品还在，但没有模板可以算进来
      project('prj_orphan', '', 'u_a', '2026-11-09T10:00:00.000Z'),
      // 别人的作品：不该出现在我的模板用量里
      project('prj_other', 'tpl_a', 'u_b', '2026-11-12T12:00:00.000Z'),
    ],
    null,
    2,
  ),
  'utf8',
)
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')

const { projectsByTemplate, withProjectCount, totalProjectCount, templateProjectRef, templateWorksView, TEMPLATE_PROJECT_LIMIT } = await import('../server/template-usage.mjs')
const { deleteProject } = await import('../server/projects.mjs')

const me = { id: 'u_a' }

test('按模板分组：只算自己能看的作品，最近的排前面', async () => {
  const byTemplate = await projectsByTemplate(me)
  const a = byTemplate.get('tpl_a')
  assert.equal(a.length, 2, '别人的作品不算进来')
  assert.deepEqual(a.map((entry) => entry.id), ['prj_a1', 'prj_a2'], '最近改过的排前面')
  assert.equal(byTemplate.get('tpl_b').length, 1)
  assert.equal(byTemplate.get('tpl_c'), undefined, '没人用的模板不进分组')
  const flat = JSON.stringify([...byTemplate.values()])
  assert.ok(!flat.includes('prj_orphan'), '没有模板的作品不进分组')
  assert.ok(!flat.includes('prj_other'), '别人的作品不进分组')
})

test('一行作品带够认得出的字段，不带脚本与凭证', async () => {
  const byTemplate = await projectsByTemplate(me)
  const [first] = byTemplate.get('tpl_b')
  assert.deepEqual(Object.keys(first).sort(), ['id', 'status', 'title', 'updatedAt', 'version'])
  assert.equal(first.version, 2)
  assert.equal(first.title, '作品 prj_b1')
  assert.equal(first.status, 'active')
})

test('卡片上的计数：模板库每项挂 projectCount，没被用过写 0', async () => {
  const byTemplate = await projectsByTemplate(me)
  const items = withProjectCount([{ id: 'tpl_a' }, { id: 'tpl_b' }, { id: 'tpl_c' }], byTemplate)
  assert.deepEqual(items.map((item) => item.projectCount), [2, 1, 0])
  assert.equal(totalProjectCount(byTemplate), 3)
})

test('删掉作品，用量跟着回落（不像 reuseCount 只增不减）', async () => {
  const removed = await deleteProject('prj_a2', me)
  assert.ok(removed)
  const byTemplate = await projectsByTemplate(me)
  assert.equal(byTemplate.get('tpl_a').length, 1)
  assert.equal(totalProjectCount(byTemplate), 2)
})

test('没登录（公共视图）时按全部作品算；单条 ref 只挑认出要的字段', async () => {
  // prj_a2 上一条已经删掉，所以这里是 prj_a1 + prj_other 两条
  const all = await projectsByTemplate(null)
  assert.equal(all.get('tpl_a').length, 2, '未登录不按归属过滤')
  assert.deepEqual(templateProjectRef({ id: 'prj_x', title: '标题', status: 'done', version: 3, updatedAt: 'now', script: {}, ownerId: 'u' }), {
    id: 'prj_x',
    title: '标题',
    status: 'done',
    version: 3,
    updatedAt: 'now',
  })
})

test('模板详情最多列 8 条，总数单独给（超出的页面写「还有 N 条」）', async () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    templateProjectRef({ id: 'prj_' + index, title: '作品 ' + index, status: 'active', version: 1, updatedAt: '2026-11-0' + (index % 9) + 'T00:00:00.000Z' }),
  )
  const view = templateWorksView(many)
  assert.equal(TEMPLATE_PROJECT_LIMIT, 8)
  assert.equal(view.projectCount, 10, '总数按全部算')
  assert.equal(view.projects.length, 8, '列出来的最多 8 条')
  assert.equal(view.projects[0].id, 'prj_0')
  assert.deepEqual(templateWorksView([]), { projectCount: 0, projects: [] })
  assert.deepEqual(templateWorksView(), { projectCount: 0, projects: [] })
})
