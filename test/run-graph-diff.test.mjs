// 回看运行时的「与当前画布比」（v0.9.108）。这一组盯住四件事：
//   1) 只挪位置 / 只改标题 / 改参数要分开数，不能混成一句「改过」；
//   2) 运行之后新增 / 删除的节点要能说清名字；
//   3) 连线增减单独算，节点删掉时两端连线也算减少；
//   4) 两边一样时 summary 为空、same 为真，页面自己写「一致」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffRunGraph } from '../src/domain/run-diff.ts'

const node = (id, over = {}) => ({
  id,
  type: 'llm',
  position: { x: 0, y: 0 },
  data: { kind: 'llm', title: id, description: '', config: { prompt: '写一段' } },
  ...over,
})

const edge = (id, source, target) => ({ id, source, target, sourceHandle: null, targetHandle: null })

const graph = (nodes, edges = []) => ({ nodes, edges })

test('两边完全一样：same=true，summary 为空', () => {
  const diff = diffRunGraph(
    graph([node('a'), node('b')], [edge('e1', 'a', 'b')]),
    graph([node('a'), node('b')], [edge('e1', 'a', 'b')]),
  )
  assert.equal(diff?.same, true)
  assert.equal(diff?.summary, '')
  assert.equal(diff?.snapshotNodes, 2)
  assert.equal(diff?.currentNodes, 2)
})

test('只挪位置不算参数改动：位置单独数，参数为 0', () => {
  const diff = diffRunGraph(
    graph([node('a')]),
    graph([node('a', { position: { x: 80, y: 120 } })]),
  )
  assert.equal(diff?.same, false)
  assert.equal(diff?.moved.length, 1)
  assert.equal(diff?.changed.length, 0)
  assert.match(diff?.summary || '', /位置 1/)
  assert.doesNotMatch(diff?.summary || '', /参数/)
})

test('只改标题：标题单独数，位置与参数都不动', () => {
  const diff = diffRunGraph(
    graph([node('a')]),
    graph([node('a', { data: { kind: 'llm', title: '新标题', description: '', config: { prompt: '写一段' } } })]),
  )
  assert.equal(diff?.retitled.length, 1)
  assert.equal(diff?.changed.length, 0)
  assert.equal(diff?.moved.length, 0)
  assert.match(diff?.summary || '', /标题 1/)
})

test('改参数：标题不变也算参数改动；摘要里有参数数', () => {
  const diff = diffRunGraph(
    graph([node('a')]),
    graph([node('a', { data: { kind: 'llm', title: 'a', description: '', config: { prompt: '只写两段' } } })]),
  )
  assert.equal(diff?.changed.length, 1)
  assert.equal(diff?.changed[0].title, 'a')
  assert.equal(diff?.summary, '参数 1')
})

test('新增与删除：标题取各自那边的名字，连线随节点一起增减', () => {
  const diff = diffRunGraph(
    graph([node('old'), node('keep')], [edge('e1', 'old', 'keep')]),
    graph([node('keep'), node('new')], [edge('e2', 'keep', 'new')]),
  )
  assert.deepEqual(diff?.removed.map((item) => item.title), ['old'])
  assert.deepEqual(diff?.added.map((item) => item.title), ['new'])
  assert.equal(diff?.edgesAdded, 1)
  assert.equal(diff?.edgesRemoved, 1)
  assert.match(diff?.summary || '', /新增 1/)
  assert.match(diff?.summary || '', /删除 1/)
  assert.match(diff?.summary || '', /连线 \+1/)
  assert.match(diff?.summary || '', /连线 -1/)
})

test('快照缺失或当前画布为空：返回 null，页面不编差异', () => {
  assert.equal(diffRunGraph(null, graph([])), null)
  assert.equal(diffRunGraph(graph([]), null), null)
})
