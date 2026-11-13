import assert from 'node:assert/strict'
import test from 'node:test'

// 「这条原片/这条模板，下一步往哪走」（v0.9.39）：已经开过作品就进作品，没开就照它开一条，
// 还没解析就指向解析。发现页「库里的原片」那一行与检索卡片上的第二格读的是同一句。

const { canStartProject, originEntry, originPending } = await import('../server/origin-entry.mjs')
const { takenOrigins } = await import('../server/taken-origins.mjs')
const { libraryMarks } = await import('../server/source-footprint.mjs')

const docUrl = 'https://www.iesdouyin.com/share/video/7300000000000000009'
const template = (patch = {}) => ({
  id: 'tpl_a',
  kind: 'replica',
  platform: 'douyin',
  platformLabel: '抖音',
  title: '15 秒早餐教程',
  sourceId: '7300000000000000009',
  sourceUrl: docUrl,
  shared: false,
  structure: [{ beat: '开头', voiceover: '三分钟搞定的早餐' }],
  storyboard: [{ index: 1, frame: '锅里' }],
  createdAt: '2026-11-11T10:20:00.000Z',
  ...patch,
})
const project = (patch = {}) => ({
  id: 'prj_a',
  title: '15 秒早餐教程 · 我的版本',
  templateId: 'tpl_a',
  version: 2,
  updatedAt: '2026-11-13T06:30:00.000Z',
  ...patch,
})

test('没有模板 id 就不给按钮：不指向一个不存在的东西', () => {
  assert.equal(originEntry({}), null)
  assert.equal(originEntry({ template: null, templateId: '' }), null)
})

test('已解析的模板、还没开作品：下一步是「开成作品」，hint 里带模板名', () => {
  const entry = originEntry({ template: template(), templateId: 'tpl_a', project: null })
  assert.equal(entry.kind, 'create-work')
  assert.equal(entry.label, '开成作品')
  assert.equal(entry.projectId, '')
  assert.match(entry.hint, /15 秒早餐教程/)
  assert.match(entry.hint, /脚本与分镜跟着走/)
})

test('只有分镜、没有段落也算已解析：能开成作品', () => {
  assert.equal(canStartProject(template({ structure: [] })), true)
  assert.equal(originEntry({ template: template({ structure: [] }), templateId: 'tpl_a' }).kind, 'create-work')
})

test('只存了原链接（kind: saved）的不能开作品：给「还没解析」，并指向去解析', () => {
  const saved = template({ kind: 'saved', structure: [], storyboard: [] })
  assert.equal(canStartProject(saved), false)
  const entry = originEntry({ template: saved, templateId: 'tpl_a' })
  assert.equal(entry.kind, 'blocked')
  assert.equal(entry.label, '还没解析')
  assert.match(entry.hint, /去解析这条/)
  // 与 POST /api/projects 的 400 是同一个判断：脚本和分镜都没有就是不能开
  assert.equal(canStartProject(template({ structure: [], storyboard: [] })), false)
  assert.equal(canStartProject(null), false)
})

test('已经开过作品：下一步是那条作品，不是再开一条', () => {
  const entry = originEntry({ template: template(), templateId: 'tpl_a', project: project() })
  assert.equal(entry.kind, 'open-work')
  assert.equal(entry.label, '作品 · 第 2 版')
  assert.equal(entry.projectId, 'prj_a')
  assert.match(entry.hint, /第 2 版/)
})

test('照模板开了作品、还没开画布：写「作品 · 还没开画布」，不写「第 0 版」', () => {
  const entry = originEntry({ template: template(), templateId: 'tpl_a', project: project({ version: 0 }) })
  assert.equal(entry.kind, 'open-work')
  assert.equal(entry.label, '作品 · 还没开画布')
  assert.doesNotMatch(entry.label, /第 0 版/)
})

test('官方示例的 hint 说清「官方那条不动」，不冒充是你自己的', () => {
  const entry = originEntry({ template: template({ shared: true }), templateId: 'tpl_a', project: null, official: true })
  assert.match(entry.hint, /官方示例/)
  assert.match(entry.hint, /官方那条不动/)
})

test('没开成作品的有几条按全部原片算，不是只算列出来的那几行', () => {
  const rows = [template({ id: 'tpl_1', sourceUrl: 'https://a/1' }), template({ id: 'tpl_2', sourceUrl: 'https://a/2' }), template({ id: 'tpl_3', sourceUrl: 'https://a/3' }), template({ id: 'tpl_4', sourceUrl: 'https://a/4' })]
  const view = takenOrigins(rows, [project({ templateId: 'tpl_2' })], { limit: 2 })
  assert.equal(view.total, 4)
  assert.equal(view.withProject, 1)
  assert.equal(view.pending, 3)
  assert.equal(view.items.length, 2)
  assert.equal(originPending([{ templateId: 'tpl_1', project: null }, { templateId: 'tpl_2', project: { id: 'prj_a' } }, { templateId: 'tpl_3', project: null }]), 2)
  assert.equal(originPending([]), 0)
})

test('「库里的原片」每一行都带着下一步，官方示例照实标', () => {
  const view = takenOrigins([template({ shared: true })], [])
  const row = view.items[0]
  assert.equal(row.entry.kind, 'create-work')
  assert.equal(row.entry.label, '开成作品')
  assert.match(row.entry.hint, /官方示例/)
})

test('检索卡片上的第二格与「库里的原片」那一行是同一句（同一个口径，不各写一份）', () => {
  const templates = [template(), template({ id: 'tpl_other', sourceUrl: 'https://a/other', sourceId: 'other' })]
  const marks = libraryMarks(templates, [project()], [{ id: '7300000000000000009', platform: 'douyin', url: docUrl }])
  const view = takenOrigins(templates, [project()])
  const row = view.items.find((item) => item.templateId === 'tpl_a')
  assert.equal(marks.matched, 1)
  assert.deepEqual(marks.items[0].entry, row.entry)
  assert.equal(marks.items[0].project.version, 2)
})

test('只存了链接的模板在卡片上也如实说「还没解析」，不假装能开作品', () => {
  const saved = template({ kind: 'saved', structure: [], storyboard: [] })
  const marks = libraryMarks([saved], [], [{ id: '7300000000000000009', platform: 'douyin', url: docUrl }])
  assert.equal(marks.items[0].entry.kind, 'blocked')
})
