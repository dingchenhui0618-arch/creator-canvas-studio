import assert from 'node:assert/strict'
import test from 'node:test'

// 发现页开场的「库里的原片」：库里有哪些原片、存成了哪条模板、有没有开成作品。
// 这一组盯：没有链接就不算原片、同一条原片只占一行、官方示例照实标、互动数不编 0。

const { takenOrigins, originRow, originKey, ORIGIN_MAX } = await import('../server/taken-origins.mjs')

const docUrl = 'https://www.iesdouyin.com/share/video/7300000000000000001'
const template = (patch = {}) => ({
  id: 'tpl_a',
  kind: 'replica',
  platform: 'douyin',
  title: '15 秒早餐教程',
  author: '小厨房日记',
  sourceUrl: docUrl,
  shared: false,
  stats: { plays: 0, likes: 8600, comments: 120, shares: 40, collects: 3200 },
  createdAt: '2026-11-11T10:20:00.000Z',
  ...patch,
})

const project = (patch = {}) => ({
  id: 'prj_a',
  title: '15 秒早餐教程 · 照着爆款做',
  templateId: 'tpl_a',
  version: 2,
  updatedAt: '2026-11-13T06:30:00.000Z',
  ...patch,
})

test('有原片链接的模板就是一行原片：平台、作者、互动数一起带出来', () => {
  const view = takenOrigins([template()], [])
  assert.equal(view.total, 1)
  assert.equal(view.withProject, 0)
  assert.equal(view.official, 0)
  assert.equal(view.lastAt, '2026-11-11T10:20:00.000Z')
  const row = view.items[0]
  assert.equal(row.templateId, 'tpl_a')
  assert.equal(row.title, '15 秒早餐教程')
  assert.equal(row.platformLabel, '抖音')
  assert.equal(row.author, '小厨房日记')
  assert.deepEqual(row.stats, { plays: 0, likes: 8600, comments: 120, shares: 40, collects: 3200 })
  assert.equal(row.project, null, '没开成作品的写 null，不编一条作品')
  assert.equal(row.works, 0)
  assert.equal(row.templates, 1)
})

test('没有原片链接的模板不进这块（画布 / 智能体 / 作品沉淀本来就没有原片）', () => {
  const view = takenOrigins([
    template({ id: 'tpl_canvas', sourceUrl: '', kind: 'flow' }),
    template({ id: 'tpl_agent', sourceUrl: '   ', kind: 'agent' }),
    template({ id: 'tpl_hash', sourceUrl: '#not-a-url' }),
    template({ id: 'tpl_ok' }),
  ], [])
  assert.equal(view.total, 1)
  assert.equal(view.items[0].templateId, 'tpl_ok')
})

test('删掉的模板不算：库里看不见的，不能还在这里占一行', () => {
  const view = takenOrigins([template({ deletedAt: '2026-11-12T00:00:00.000Z' }), template({ id: 'tpl_b', sourceUrl: 'https://www.iesdouyin.com/share/video/7300000000000000002', createdAt: '2026-11-10T00:00:00.000Z' })], [])
  assert.equal(view.total, 1)
  assert.equal(view.items[0].templateId, 'tpl_b')
})

test('同一条原片存成两条模板只算一条原片：入口给有作品的那条，作品按 id 去重', () => {
  const view = takenOrigins([
    template({ id: 'tpl_old', createdAt: '2026-11-10T00:00:00.000Z' }),
    template({ id: 'tpl_new', kind: 'adapted', createdAt: '2026-11-12T00:00:00.000Z' }),
  ], [
    project({ id: 'prj_x', templateId: 'tpl_old', title: '用旧模板开的', updatedAt: '2026-11-12T01:00:00.000Z' }),
    project({ id: 'prj_y', templateId: 'tpl_new', title: '用改编版开的', updatedAt: '2026-11-13T01:00:00.000Z' }),
  ])
  assert.equal(view.total, 1, '同一条原片只占一行')
  const row = view.items[0]
  assert.equal(row.templates, 2)
  assert.equal(row.works, 2)
  assert.equal(row.templateId, 'tpl_new', '有作品的模板优先当入口')
  assert.equal(row.project.id, 'prj_y', '作品取最近改过的那条')
})

test('已经开成作品的排前面：这块先回答「哪条已经在做」，不是「最近收了什么」', () => {
  const view = takenOrigins([
    template({ id: 'tpl_new', sourceUrl: 'https://www.iesdouyin.com/share/video/2', createdAt: '2026-11-12T10:00:00.000Z' }),
    template({ id: 'tpl_working', sourceUrl: 'https://www.iesdouyin.com/share/video/1', createdAt: '2026-11-01T10:00:00.000Z' }),
  ], [project({ templateId: 'tpl_working' })])
  assert.equal(view.items[0].templateId, 'tpl_working')
  assert.equal(view.lastAt, '2026-11-12T10:00:00.000Z')
})

test('官方示例照实标出来，不冒充「你带回来的」', () => {
  const view = takenOrigins([
    template({ id: 'tpl_seed', shared: true }),
    template({ id: 'tpl_mine', sourceUrl: 'https://www.iesdouyin.com/share/video/7300000000000000002', createdAt: '2026-11-09T00:00:00.000Z' }),
  ], [])
  assert.equal(view.official, 1)
  assert.equal(view.total, 2)
  assert.equal(view.items.find((row) => row.templateId === 'tpl_seed').official, true)
  assert.equal(view.items.find((row) => row.templateId === 'tpl_mine').official, false)
})

test('按收进来的先后倒序、上限只截先列出来的那几条，计数永远是全量', () => {
  const list = [
    template({ id: 'tpl_1', sourceUrl: 'https://www.iesdouyin.com/share/video/1', createdAt: '2026-11-09T00:00:00.000Z' }),
    template({ id: 'tpl_2', sourceUrl: 'https://www.iesdouyin.com/share/video/2', createdAt: '2026-11-11T12:00:00.000Z' }),
    template({ id: 'tpl_3', sourceUrl: 'https://www.iesdouyin.com/share/video/3', createdAt: '2026-11-10T00:00:00.000Z' }),
  ]
  const view = takenOrigins(list, [], { limit: 2 })
  assert.equal(view.total, 3)
  assert.deepEqual(view.items.map((row) => row.templateId), ['tpl_2', 'tpl_3'])
  assert.equal(view.lastAt, '2026-11-11T12:00:00.000Z', '最近一条按全量算，不受「有作品的排前面」影响')
  assert.equal(takenOrigins(list, [], { limit: 0 }).items.length, 3, '传 0 按默认 4 条处理，不返回空列表')
  assert.equal(takenOrigins(Array.from({ length: 30 }, (_, index) => template({
    id: 'tpl_' + index,
    sourceUrl: 'https://www.iesdouyin.com/share/video/' + index,
    createdAt: '2026-11-' + String(10 + (index % 3)).padStart(2, '0') + 'T00:00:00.000Z',
  })), [], { limit: 999 }).items.length, ORIGIN_MAX)
})

test('原片键只去掉 # 片段与末尾斜杠，别把不同视频当成同一条', () => {
  assert.equal(originKey({ sourceUrl: docUrl + '/#comments' }), docUrl)
  assert.equal(originKey({ sourceUrl: '  ' + docUrl + '///  ' }), docUrl)
  assert.equal(originKey({ sourceUrl: '' }), '')
  assert.notEqual(originKey({ sourceUrl: 'https://www.iesdouyin.com/share/video/1' }), originKey({ sourceUrl: 'https://www.iesdouyin.com/share/video/2' }))
})

test('互动数只认正数：一件都没有就是 null，别拿一排 0 冒充原片数据', () => {
  assert.equal(originRow([template({ stats: {} })]).stats, null)
  assert.equal(originRow([template({ stats: { likes: -3, comments: 'abc' } })]).stats, null)
  assert.deepEqual(originRow([template({ stats: { likes: '12', collects: 3.6 } })]).stats, {
    plays: 0, likes: 12, comments: 0, shares: 0, collects: 4,
  })
  assert.equal(originRow([template({ platform: 'bilibili' })]).platformLabel, '', '认不出的平台不冒充抖音小红书')
  assert.deepEqual(takenOrigins([], []), { total: 0, withProject: 0, pending: 0, works: 0, official: 0, lastAt: '', items: [] })
})
