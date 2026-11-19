import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LAYOUT_BAND_GAP,
  LAYOUT_COLUMN_GAP,
  LAYOUT_COLUMNS_PER_BAND,
  LAYOUT_ROW_GAP,
  autoLayout,
} from '../src/canvas/layout.ts'

function node(id) {
  return { id, type: 'input', position: { x: 0, y: 0 }, data: { kind: 'input', title: id, config: {} } }
}

function chain(count) {
  const nodes = Array.from({ length: count }, (_, index) => node('n' + (index + 1)))
  const edges = []
  for (let index = 1; index < count; index += 1) {
    edges.push({ id: 'e' + index, source: 'n' + index, target: 'n' + (index + 1) })
  }
  return { nodes, edges }
}

const byId = (nodes) => new Map(nodes.map((item) => [item.id, item.position]))

test('一排最多 3 列，第 4 步折到下一排', () => {
  const { nodes, edges } = chain(4)
  const laid = byId(autoLayout(nodes, edges))
  for (let index = 1; index <= 3; index += 1) {
    assert.equal(laid.get('n' + index).x, 44 + (index - 1) * LAYOUT_COLUMN_GAP)
    assert.equal(laid.get('n' + index).y, 210)
  }
  // 第 4 步回到第一列、落到下一排
  assert.equal(laid.get('n4').x, 44)
  assert.equal(laid.get('n4').y, 210 + LAYOUT_BAND_GAP)
})

test('6 步流程折成两排，横向宽度不再是一条长龙', () => {
  const { nodes, edges } = chain(6)
  const laid = byId(autoLayout(nodes, edges))
  const xs = [...new Set([...laid.values()].map((item) => item.x))].sort((a, b) => a - b)
  const ys = [...new Set([...laid.values()].map((item) => item.y))].sort((a, b) => a - b)
  assert.deepEqual(xs, [44, 44 + LAYOUT_COLUMN_GAP, 44 + LAYOUT_COLUMN_GAP * 2])
  assert.deepEqual(ys, [210, 210 + LAYOUT_BAND_GAP])
  // 最右一列 + 240 的卡片宽度 = 折行后的画布宽度上限：844px，比原来一行 1684px 窄了一半
  assert.ok(xs[xs.length - 1] + 240 < 900)
  assert.equal(xs.length, LAYOUT_COLUMNS_PER_BAND)
})

test('两排之间留出缩略图的高度，跑完贴图也不会压住上一排', () => {
  // 卡片跑完会贴一张最高 128px 的缩略图，卡片总高约 130 + 128 = 258px
  assert.ok(LAYOUT_BAND_GAP >= 264, '折行间距 ' + LAYOUT_BAND_GAP + ' 小于带缩略图的卡片高度')
})

test('同一列的多个节点纵向拉开一个行距，不重叠', () => {
  const nodes = [node('a'), node('b'), node('c')]
  const edges = [{ id: 'e1', source: 'a', target: 'b' }]
  const laid = byId(autoLayout(nodes, edges))
  // a、c 都在第一层：同一个桶里上下排开，差正好一个 rowGap
  const gap = Math.abs(laid.get('a').y - laid.get('c').y)
  assert.equal(gap, LAYOUT_ROW_GAP)
  assert.equal(laid.get('b').x, 44 + LAYOUT_COLUMN_GAP)
})

test('空工作流原样返回，不凭空造节点', () => {
  assert.deepEqual(autoLayout([], []), [])
})

test('没有连线的节点都落在第一列，不去编造先后顺序', () => {
  const nodes = [node('a'), node('b')]
  const laid = byId(autoLayout(nodes, []))
  assert.equal(laid.get('a').x, 44)
  assert.equal(laid.get('b').x, 44)
})

test('环不会把布局算死：仍返回同样数量的节点', () => {
  const nodes = [node('a'), node('b')]
  const edges = [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'a' },
  ]
  const laid = autoLayout(nodes, edges)
  assert.equal(laid.length, 2)
  assert.ok(laid.every((item) => Number.isFinite(item.position.x) && Number.isFinite(item.position.y)))
})
