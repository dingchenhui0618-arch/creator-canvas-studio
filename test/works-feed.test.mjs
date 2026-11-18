import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeWorks } from '../server/works-feed.mjs'

const media = (id, at) => ({ id: 'media:' + id, kind: 'image', at, title: id, source: '快捷创作' })
const run = (id, at) => ({ id: 'run:' + id, kind: 'run', at, title: id, source: '工作流' })
const canvas = (id, at) => ({ id: 'canvas:' + id, kind: 'canvas', at, title: id, source: '无限画布' })

test('三种来源按时间倒序，最新一条在最前', () => {
  const page = mergeWorks({ media: [media('a', 100)], runs: [run('b', 300)], canvases: [canvas('c', 200)] })
  assert.deepEqual(page.items.map((item) => item.id), ['run:b', 'canvas:c', 'media:a'])
  assert.equal(page.total, 3)
  assert.equal(page.cursor, null)
})

test('同一个时间点按 id 倒序，不会因为排序不稳定而抖动', () => {
  const page = mergeWorks({ media: [media('a', 100), media('b', 100)] })
  assert.deepEqual(page.items.map((item) => item.id), ['media:b', 'media:a'])
})

test('kind 只留对应来源，total 按筛选后的算', () => {
  const page = mergeWorks({ media: [media('a', 100)], runs: [run('b', 200)], canvases: [canvas('c', 300)], kind: 'run' })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].id, 'run:b')
  assert.equal(page.total, 1)
})

test('游标翻页不重不漏，同一毫秒也能翻', () => {
  const rows = [media('a', 100), media('b', 100), media('c', 50)]
  const first = mergeWorks({ media: rows, limit: 2 })
  assert.deepEqual(first.items.map((item) => item.id), ['media:b', 'media:a'])
  assert.equal(first.cursor, '100:media:a')
  const second = mergeWorks({ media: rows, limit: 2, before: first.cursor })
  assert.deepEqual(second.items.map((item) => item.id), ['media:c'])
  assert.equal(second.cursor, null)
})

test('游标那条不在列表里时报 WORKS_CURSOR，不猜位置', () => {
  assert.equal(mergeWorks({ media: [media('a', 100)], before: '999:media:zzz' }).error, 'WORKS_CURSOR')
})

test('不认识的筛选条件报 WORKS_KIND', () => {
  assert.equal(mergeWorks({ kind: 'video2' }).error, 'WORKS_KIND')
})

test('limit 有上限，传 999 也只回 48 条', () => {
  const rows = Array.from({ length: 60 }, (_, index) => media('m' + index, 1000 - index))
  assert.equal(mergeWorks({ media: rows, limit: 999 }).items.length, 48)
})
