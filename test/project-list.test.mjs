import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROJECT_STATES,
  projectBucket,
  projectListQuery,
  projectSearchText,
  projectSearchTokens,
} from '../server/project-list.mjs'

// 作品列表的找法：关键字（标题 / 模板名）+ 状态（在做 / 已交付）。
// 这一组盯住四件容易退化的事：搜得到、分面数字是真的、交付口径跟胶囊一致、坏输入不炸。

const project = (id, title, patch = {}) => ({
  id,
  title,
  status: 'active',
  version: 1,
  flowId: 'flow_' + id,
  deliveries: [],
  template: { title: title + ' · 模板' },
  ...patch,
})

// 一条交付了 v2、又开了 v3 的作品：当前这一版还没交，不能算已交付
const stale = project('prj_stale', '毛衣折叠收纳法', {
  status: 'done',
  version: 3,
  deliveries: [{ version: 2, at: '2026-11-12T18:03:00.000Z' }],
})
// 老数据：done 但没有交付记录，照旧算这一版交了
const legacy = project('prj_legacy', '旧版交付记录', {
  status: 'done',
  version: 1,
  deliveries: undefined,
})
const active = project('prj_active', '咖啡三分钟', { template: { title: '咖啡店探店模板' } })
const fresh = project('prj_fresh', 'iPhone 15 开箱', { template: { title: '数码开箱结构' } })
const all = [active, fresh, stale, legacy]

const ids = (result) => result.items.map((item) => item.id)

test('没有关键字与状态：全部返回，分面相加等于总数', () => {
  const result = projectListQuery(all)
  assert.equal(result.total, 4)
  assert.equal(result.shown, 4)
  assert.deepEqual(result.facets, { all: 4, active: 3, delivered: 1 })
  assert.equal(result.query, '')
  assert.equal(result.state, 'all')
  assert.deepEqual(ids(result), ['prj_active', 'prj_fresh', 'prj_stale', 'prj_legacy'])
})

test('搜作品标题：大小写不敏感', () => {
  assert.deepEqual(ids(projectListQuery(all, { q: 'IPHONE' })), ['prj_fresh'])
  assert.deepEqual(ids(projectListQuery(all, { q: 'iphone 15' })), ['prj_fresh'])
})

test('搜模板名：卡片上写着模板名，就该搜得到', () => {
  assert.deepEqual(ids(projectListQuery(all, { q: '探店' })), ['prj_active'])
  assert.equal(projectSearchText(active).includes('咖啡店探店模板'), true)
})

test('空格分词是都要命中，不是任一命中', () => {
  assert.deepEqual(ids(projectListQuery(all, { q: '毛衣 折叠' })), ['prj_stale'])
  assert.deepEqual(ids(projectListQuery(all, { q: '毛衣 咖啡' })), [])
})

test('只有空格的关键字等于没筛；全角空格也认', () => {
  assert.equal(projectListQuery(all, { q: '   ' }).shown, 4)
  assert.deepEqual(projectSearchTokens('毛衣　折叠'), ['毛衣', '折叠'])
  assert.deepEqual(ids(projectListQuery(all, { q: '毛衣　收纳' })), ['prj_stale'])
})

test('已交付筛选：只看当前这一版，老数据 done 没记录照旧算交了', () => {
  const result = projectListQuery(all, { state: 'delivered' })
  assert.deepEqual(ids(result), ['prj_legacy'])
  // 交付了 v2 又开 v3 的那条在「在做」里，而不是已交付
  assert.deepEqual(ids(projectListQuery(all, { state: 'active' })), ['prj_active', 'prj_fresh', 'prj_stale'])
  assert.equal(projectBucket(stale), 'active')
  assert.equal(projectBucket(legacy), 'delivered')
})

test('状态筛选不改变总数与分面：分面按关键字算', () => {
  const filtered = projectListQuery(all, { state: 'delivered' })
  assert.equal(filtered.total, 4)
  assert.equal(filtered.shown, 1)
  assert.deepEqual(filtered.facets, { all: 4, active: 3, delivered: 1 })
  const keyword = projectListQuery(all, { q: '咖啡', state: 'delivered' })
  assert.equal(keyword.total, 4)
  assert.equal(keyword.shown, 0)
  assert.deepEqual(keyword.facets, { all: 1, active: 1, delivered: 0 })
})

test('认不出的状态退回全部并回显 all，不报错也不空列表', () => {
  for (const bad of ['', 'archived', 'DONE', '0', null]) {
    const result = projectListQuery(all, { state: bad })
    assert.equal(result.state, 'all')
    assert.equal(result.shown, 4)
  }
  assert.deepEqual(PROJECT_STATES, ['all', 'active', 'delivered'])
})

test('关键字归一：多空格收成一个、回显小写', () => {
  const result = projectListQuery(all, { q: '  咖啡    三分钟 ' })
  assert.equal(result.query, '咖啡 三分钟')
  assert.deepEqual(ids(result), ['prj_active'])
})

test('关键字最多取前 5 个词，多贴的整段文案不参与', () => {
  const tokens = projectSearchTokens('a b c d e f g')
  assert.deepEqual(tokens, ['a', 'b', 'c', 'd', 'e'])
  const result = projectListQuery(all, { q: '咖啡 三分钟 咖啡店 探店 模板 不存在' })
  // 第 6 个词「不存在」被截掉，前 5 个词都能命中
  assert.deepEqual(ids(result), ['prj_active'])
})

test('不改传进来的数组与作品对象', () => {
  const before = JSON.stringify(all)
  const result = projectListQuery(all, { q: '咖啡', state: 'delivered' })
  assert.equal(JSON.stringify(all), before)
  assert.notEqual(result.items, all)
})
