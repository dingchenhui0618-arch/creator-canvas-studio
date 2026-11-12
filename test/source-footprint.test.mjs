import assert from 'node:assert/strict'
import test from 'node:test'

// 「同一条原片在库里留下了什么」：模板详情那块、发现页检索卡片的「库里已有」共用这一套认法。
// 这一组盯：认原片靠平台 id 而不是链接、同源模板与作品只算一条、官方示例不冒充自己带回来的。

const { sourceIdentity, originFootprint, libraryMarks, LIBRARY_MARK_MAX, SIBLING_LIMIT, ORIGIN_WORK_LIMIT } =
  await import('../server/source-footprint.mjs')

const url = 'https://www.douyin.com/video/7412000000000000001'
const template = (patch = {}) => ({
  id: 'tpl_a',
  kind: 'replica',
  platform: 'douyin',
  platformLabel: '抖音',
  sourceId: '7412000000000000001',
  sourceUrl: url,
  title: '三套通勤配色',
  reuseCount: 0,
  createdAt: '2026-11-10T09:00:00.000Z',
  ...patch,
})
const project = (patch = {}) => ({
  id: 'prj_a',
  title: '三套通勤配色 · 我的版本',
  templateId: 'tpl_a',
  version: 2,
  status: 'active',
  updatedAt: '2026-11-13T06:00:00.000Z',
  ...patch,
})
const entry = (patch = {}) => ({ id: '7412000000000000001', platform: 'douyin', url, ...patch })

test('认原片靠平台 + 平台 id：链接加了分享参数、末尾斜杠或 # 也还是同一条', () => {
  const base = sourceIdentity({ platform: 'douyin', sourceId: '7412', sourceUrl: url })
  const noisy = sourceIdentity({ platform: 'douyin', sourceId: '7412', sourceUrl: url + '/?from=share#top' })
  assert.equal(base.key, 'douyin:7412')
  assert.equal(noisy.key, base.key)
})

test('没有平台 id 时退回规范化链接（与发现页「库里的原片」同一规则）', () => {
  const a = sourceIdentity({ platform: 'xiaohongshu', sourceUrl: 'https://x.cn/note/9#c' })
  const b = sourceIdentity({ platform: 'xiaohongshu', sourceUrl: 'https://x.cn/note/9/' })
  assert.equal(a.key, 'url:https://x.cn/note/9')
  assert.equal(a.key, b.key)
})

test('画布 / 智能体 / 作品沉淀出来的模板没有原片：identity 为 null，两处都不出现', () => {
  assert.equal(sourceIdentity({ platform: 'douyin', sourceId: '', sourceUrl: '' }), null)
  assert.equal(sourceIdentity({ id: 'tpl_flow', platform: '', sourceId: '', sourceUrl: '' }), null)
  assert.equal(originFootprint([template({ id: 'tpl_flow', kind: 'flow', sourceId: '', sourceUrl: '' })], [], { id: 'tpl_flow', platform: '', sourceId: '', sourceUrl: '' }), null)
})

test('模板详情：同源的改编版算进「存成几条模板」，目标自己不算同源', () => {
  const adapted = template({ id: 'tpl_b', kind: 'adapted', title: '三套通勤配色（我的）', createdAt: '2026-11-12T09:00:00.000Z' })
  const other = template({ id: 'tpl_c', sourceId: '9999', sourceUrl: 'https://www.douyin.com/video/9999' })
  const view = originFootprint([template(), adapted, other], [], template())
  assert.equal(view.templateCount, 2)
  assert.equal(view.siblingTotal, 1)
  assert.equal(view.siblings.length, 1)
  assert.equal(view.siblings[0].id, 'tpl_b')
  assert.equal(view.templateId, 'tpl_a')
})

test('同一条原片的两条模板被同一条作品用着：作品只算一条', () => {
  const adapted = template({ id: 'tpl_b', kind: 'adapted' })
  const view = originFootprint([template(), adapted], [
    project({ id: 'prj_a', templateId: 'tpl_a' }),
    project({ id: 'prj_a', templateId: 'tpl_b', updatedAt: '2026-11-13T08:00:00.000Z' }),
  ], template())
  assert.equal(view.workCount, 1)
  assert.equal(view.works.length, 1)
  assert.equal(view.works[0].updatedAt, '2026-11-13T08:00:00.000Z', '同一条作品取最近改动的那次')
})

test('作品按最近改动倒序、最多列 4 条，总数照实给', () => {
  const projects = Array.from({ length: 6 }, (_, index) =>
    project({ id: 'prj_' + index, updatedAt: '2026-11-0' + (index + 1) + 'T00:00:00.000Z' }),
  )
  const view = originFootprint([template()], projects, template())
  assert.equal(view.workCount, 6)
  assert.equal(view.works.length, ORIGIN_WORK_LIMIT)
  assert.deepEqual(view.works.map((item) => item.id), ['prj_5', 'prj_4', 'prj_3', 'prj_2'])
})

test('整组都是官方示例才标 shared；只要有一条自己的就不算官方', () => {
  const shared = originFootprint([template({ id: 'tpl_a', shared: true })], [], template({ shared: true }))
  assert.equal(shared.shared, true)
  const mixed = originFootprint(
    [template({ id: 'tpl_a', shared: true }), template({ id: 'tpl_b', kind: 'adapted', shared: false })],
    [],
    template({ shared: true }),
  )
  assert.equal(mixed.shared, false)
})

test('套用过几次是组内计数器之和；最近变动取模板与作品的更大者', () => {
  const adapted = template({ id: 'tpl_b', kind: 'adapted', reuseCount: 2, createdAt: '2026-11-12T00:00:00.000Z' })
  const view = originFootprint([template({ reuseCount: 3 }), adapted], [project({ updatedAt: '2026-11-13T06:00:00.000Z' })], template({ reuseCount: 3 }))
  assert.equal(view.applied, 5)
  assert.equal(view.lastAt, '2026-11-13T06:00:00.000Z')
})

test('检索卡片上的「库里已有」：只回命中的条目，没在库里的不编一条', () => {
  const marks = libraryMarks([template()], [project()], [
    entry(),
    entry({ id: '7000000000000000000', url: 'https://www.douyin.com/video/7000000000000000000' }),
    entry({ id: '', platform: 'douyin', url: '' }),
  ])
  assert.equal(marks.total, 3)
  assert.equal(marks.matched, 1)
  assert.equal(marks.items.length, 1)
  const mark = marks.items[0]
  assert.equal(mark.id, '7412000000000000001')
  assert.equal(mark.templateId, 'tpl_a')
  assert.equal(mark.workCount, 1)
  assert.equal(mark.project.id, 'prj_a')
  assert.equal(mark.project.version, 2)
})

test('命中的那条优先自己的、有作品的，不先把官方的推给用户', () => {
  const official = template({ id: 'tpl_shared', shared: true, createdAt: '2026-11-13T00:00:00.000Z' })
  const mine = template({ id: 'tpl_mine', shared: false, createdAt: '2026-11-11T00:00:00.000Z' })
  const noWork = libraryMarks([official, mine], [], [entry()])
  assert.equal(noWork.items[0].templateId, 'tpl_mine')
  const withWork = libraryMarks([official, template({ id: 'tpl_work' })], [project({ templateId: 'tpl_work' })], [entry()])
  assert.equal(withWork.items[0].templateId, 'tpl_work')
  assert.equal(withWork.items[0].source, '', 'source 没给就不编一个来源')
})

test('一次最多查 50 条：一页 24 条，翻两页也够', () => {
  const entries = Array.from({ length: 60 }, (_, index) => entry({ id: 'id' + index }))
  const marks = libraryMarks([template()], [], entries)
  assert.equal(LIBRARY_MARK_MAX, 50)
  assert.equal(marks.total, 50)
  assert.equal(marks.matched, 0)
})

test('同源模板多到超过上限时只列 6 条，总数照实给', () => {
  const many = [template()]
  for (let index = 0; index < SIBLING_LIMIT + 2; index += 1) {
    many.push(template({ id: 'tpl_s' + index, kind: 'adapted', createdAt: '2026-11-12T0' + (index % 10) + ':00:00.000Z' }))
  }
  const view = originFootprint(many, [], template())
  assert.equal(view.templateCount, SIBLING_LIMIT + 3)
  assert.equal(view.siblings.length, SIBLING_LIMIT)
  assert.equal(view.siblingTotal, SIBLING_LIMIT + 2)
})

test('详情里的作品行已经算过 delivered：照它，不拿 status 再猜一遍', () => {
  const view = originFootprint([template()], [
    project({ status: 'done', delivered: false, version: 2 }),
  ], template())
  assert.equal(view.works[0].delivered, false)
  const fresh = originFootprint([template()], [project({ status: 'done', version: 2 })], template())
  assert.equal(fresh.works[0].delivered, true, '没有 delivered 字段时按 status + 版本自己算')
})

test('删掉的模板不进统计：库里看不见的不能算「已有」', () => {
  const trashed = template({ id: 'tpl_trash', deletedAt: '2026-11-12T00:00:00.000Z' })
  const marks = libraryMarks([trashed], [], [entry()])
  assert.equal(marks.matched, 0)
  const view = originFootprint([template(), trashed], [], template())
  assert.equal(view.templateCount, 1)
})
