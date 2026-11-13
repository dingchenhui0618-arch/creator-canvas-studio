// 证据锚点编号（v0.9.75）：图上框的序号必须与右侧问题行一致，且不能跳号。
// 这一条是纯函数，单测盯住四个边界：无证据不占图、序号跟着列表位置走、0/NaN 框被丢掉、序号补零。
import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorNumber, reviewAnchorMarks } from '../src/domain/review-anchors.ts'

const box = (x, y, w, h) => ({ x, y, w, h })

test('序号跟列表位置走：中间那条没证据，后面的编号也不跳', () => {
  const marks = reviewAnchorMarks([
    { id: 'obs-1', severity: 'minor', statement: '无证据', evidence: null },
    { id: 'obs-2', severity: 'major', statement: '按钮压字', evidence: box(0.1, 0.2, 0.3, 0.1) },
    { id: 'obs-3', severity: 'blocker', statement: '标题被裁', evidence: box(0, 0, 0.5, 0.05) },
  ])
  assert.deepEqual(marks.map((mark) => mark.index), [2, 3])
  assert.deepEqual(marks.map((mark) => mark.id), ['obs-2', 'obs-3'])
  assert.equal(marks[0].statement, '按钮压字')
  assert.equal(marks[1].severity, 'blocker')
})

test('宽高都是 0 的框不画；只缺一边（细线）照旧保留', () => {
  const marks = reviewAnchorMarks([
    { id: 'obs-1', evidence: box(0.2, 0.2, 0, 0) },
    { id: 'obs-2', evidence: box(0.2, 0.2, 0, 0.01) },
    { id: 'obs-3', evidence: box(Number.NaN, Number.NaN, Number.NaN, Number.NaN) },
    { id: 'obs-4', evidence: box('0.1', '0.1', '0.2', '0.2') },
  ])
  assert.deepEqual(marks.map((mark) => mark.id), ['obs-2', 'obs-4'])
  assert.deepEqual(marks[1].evidence, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 })
  assert.equal(marks[0].severity, 'minor', '没写严重度时按次要')
})

test('缺 id 的条目跳过，空输入不炸', () => {
  assert.deepEqual(reviewAnchorMarks(null), [])
  assert.deepEqual(reviewAnchorMarks(undefined), [])
  assert.deepEqual(reviewAnchorMarks([]), [])
  assert.deepEqual(reviewAnchorMarks([{ evidence: box(0.1, 0.1, 0.1, 0.1) }]), [])
})

test('序号统一两位，负数与空值落在 00', () => {
  assert.equal(anchorNumber(1), '01')
  assert.equal(anchorNumber(9), '09')
  assert.equal(anchorNumber(10), '10')
  assert.equal(anchorNumber(0), '00')
  assert.equal(anchorNumber(-3), '00')
  assert.equal(anchorNumber(Number.NaN), '00')
})
