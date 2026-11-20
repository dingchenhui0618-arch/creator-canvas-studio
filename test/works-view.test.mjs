// 作品流的筛选记忆与运行状态文案（r266）。
// 两件事都在 src/domain/works-view.ts：存坏的值不能污染界面，不认识的状态不能被猜成「已停止」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readWorksFilter, readWorksQuery, runStatusLabel, workDetailLabel, WORKS_QUERY_MAX, writeWorksFilter, writeWorksQuery } from '../src/domain/works-view.ts'

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    size: () => map.size,
    raw: () => Object.fromEntries(map),
  }
}

test('没存过筛选时是「全部」', () => {
  assert.equal(readWorksFilter(memoryStorage()), 'all')
})

test('存过的筛选取回来还是它', () => {
  for (const kind of ['image', 'video', 'run', 'canvas']) {
    const storage = memoryStorage()
    writeWorksFilter(storage, kind)
    assert.equal(readWorksFilter(storage), kind)
  }
})

test('选回「全部」时把键删掉，不留下一个写着 all 的旧值', () => {
  const storage = memoryStorage()
  writeWorksFilter(storage, 'run')
  writeWorksFilter(storage, 'all')
  assert.equal(storage.size(), 0)
  assert.equal(readWorksFilter(storage), 'all')
})

test('存进去的值不认识（旧版本 / 手改）就退回「全部」，不崩', () => {
  assert.equal(readWorksFilter(memoryStorage({ 'vq.works.filter.v2': 'video2' })), 'all')
  assert.equal(readWorksFilter(memoryStorage({ 'vq.works.filter.v2': '../etc' })), 'all')
})

test('浏览器不给用 sessionStorage 时读出「全部」，写入不抛错', () => {
  const broken = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  assert.equal(readWorksFilter(broken), 'all')
  assert.doesNotThrow(() => writeWorksFilter(broken, 'video'))
  assert.equal(readWorksFilter(null), 'all')
  assert.doesNotThrow(() => writeWorksFilter(null, 'video'))
})

test('搜作品的关键词跟着会话走：存了能取回，首尾空白去掉', () => {
  const storage = memoryStorage()
  writeWorksQuery(storage, '  咖啡  ')
  assert.equal(readWorksQuery(storage), '咖啡')
})

test('关键词清空时把键删掉，不在会话里留一个空字符串', () => {
  const storage = memoryStorage()
  writeWorksQuery(storage, '猫')
  writeWorksQuery(storage, '   ')
  assert.equal(storage.size(), 0)
  assert.equal(readWorksQuery(storage), '')
})

test('关键词存太长时截到上限；读回手改的脏值也不超过上限', () => {
  const storage = memoryStorage()
  writeWorksQuery(storage, '猫'.repeat(WORKS_QUERY_MAX + 20))
  assert.equal(readWorksQuery(storage).length, WORKS_QUERY_MAX)
  assert.equal(readWorksQuery(memoryStorage({ 'vq.works.query.v1': '狗'.repeat(200) })).length, WORKS_QUERY_MAX)
})

test('浏览器不给用 sessionStorage 时关键词读成空，写入不抛错', () => {
  const broken = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  assert.equal(readWorksQuery(broken), '')
  assert.doesNotThrow(() => writeWorksQuery(broken, '猫'))
  assert.equal(readWorksQuery(null), '')
  assert.doesNotThrow(() => writeWorksQuery(null, '猫'))
})

test('运行状态说人话：四种终态各有说法，不认识的不猜', () => {
  assert.equal(runStatusLabel('success'), '跑完了')
  assert.equal(runStatusLabel('error'), '失败')
  assert.equal(runStatusLabel('interrupted'), '已停止')
  assert.equal(runStatusLabel('running'), '还在跑')
  assert.equal(runStatusLabel('queued'), '排队中')
  assert.equal(runStatusLabel(''), '')
  assert.equal(runStatusLabel(undefined), '')
  assert.equal(runStatusLabel('weird'), '')
})
test('「去出处」那条按钮写明去哪儿：运行 / 画布 / 画布里出的图，别的没有', () => {
  assert.equal(workDetailLabel({ kind: 'run' }), '打开这次运行')
  assert.equal(workDetailLabel({ kind: 'canvas' }), '打开画布')
  // 画布里生成的那张图：kind 是 image，但带着 canvasId——回它所在的画布
  assert.equal(workDetailLabel({ kind: 'image', canvasId: 'cv_1' }), '打开画布')
  assert.equal(workDetailLabel({ kind: 'image' }), '')
  assert.equal(workDetailLabel({ kind: 'video' }), '')
  assert.equal(workDetailLabel({}), '')
})
