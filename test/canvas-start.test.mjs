// 工作流页空状态的起手清单（r249 / v0.9.232）。
// 测的是「挑哪几条、写什么字」：这块以前是三颗点了就跳走的按钮（而且因为浮层
// pointer-events: none 根本点不动），现在改成把手上的作品与模板直接摊开。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  START_PROJECT_LIMIT,
  START_TEMPLATE_LIMIT,
  canvasStartAction,
  canvasStartMeta,
  canvasStartPlan,
  templateNodeCount,
} from '../src/domain/canvas-start.ts'

function project(id, extra = {}) {
  return {
    id,
    title: '作品 ' + id,
    templateId: '',
    flowId: '',
    version: 0,
    versions: [],
    status: 'active',
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...extra,
  }
}

function template(id, extra = {}) {
  return {
    id,
    kind: 'flow',
    title: '模板 ' + id,
    flowNodes: [{ title: '输入', kind: 'input' }, { title: '出图', kind: 'image' }],
    createdAt: '2026-11-18T00:00:00.000Z',
    ...extra,
  }
}

const ids = (list) => list.map((item) => item.id)

test('还没开过工作流的作品排前面：那是真能在原地开出一条新流程的', () => {
  const plan = canvasStartPlan([
    project('opened', { version: 2, flowId: 'flow_old', updatedAt: '2026-11-19T09:00:00.000Z' }),
    project('fresh-old', { version: 0, updatedAt: '2026-11-17T09:00:00.000Z' }),
    project('fresh-new', { version: 0, updatedAt: '2026-11-18T09:00:00.000Z' }),
  ], [])
  assert.deepEqual(ids(plan.projects), ['fresh-new', 'fresh-old'])
  assert.equal(plan.projects[0].version, 0)
  assert.equal(plan.projects[0].flowId, '')
})

test('当前正打开的那条工作流不列：点了等于原地不动', () => {
  const plan = canvasStartPlan([
    project('current', { version: 1, flowId: 'flow_now' }),
    project('other', { version: 1, flowId: 'flow_other' }),
  ], [], { currentFlowId: 'flow_now' })
  assert.deepEqual(ids(plan.projects), ['other'])
})

test('只列自己的作品：公共示例作品（ownerId 空串）与别人的都不列，点了也绑不上', () => {
  const plan = canvasStartPlan([
    project('mine', { ownerId: 'usr_me' }),
    project('public', { ownerId: '' }),
    project('other', { ownerId: 'usr_other' }),
  ], [], { ownerId: 'usr_me' })
  assert.deepEqual(ids(plan.projects), ['mine'])
})

test('两样都没有的作品不列：既没开过工作流、版本又不是 0 的只算老数据', () => {
  const plan = canvasStartPlan([project('ghost', { version: 3, flowId: '' })], [])
  assert.deepEqual(plan.projects, [])
  assert.equal(plan.total, 0)
})

test('套出来还是空画布的模板不列，来自工作流的三节点模板才列', () => {
  const plan = canvasStartPlan([], [
    template('empty', { flowNodes: [], blueprint: { nodes: [], edges: [] } }),
    template('from-bp', { flowNodes: [], blueprint: { nodes: [{}, {}, {}], edges: [] } }),
    template('saved-radar', { kind: 'saved' }),
  ])
  assert.deepEqual(ids(plan.templates), ['from-bp'])
  assert.equal(plan.templates[0].nodes, 3)
})

test('两组各留两条：浮层是画布上的一块，堆多了会把画布整片盖住', () => {
  const projects = ['a', 'b', 'c', 'd', 'e'].map((id) => project(id, { updatedAt: '2026-11-18T0' + '0:00:00.000Z' }))
  const templates = ['t1', 't2', 't3'].map((id) => template(id))
  const plan = canvasStartPlan(projects, templates)
  assert.equal(START_PROJECT_LIMIT, 2)
  assert.equal(START_TEMPLATE_LIMIT, 2)
  assert.equal(plan.projects.length, 2)
  assert.equal(plan.templates.length, 2)
  assert.equal(plan.total, 4)
})

test('什么都没读到（接口失败 / 空账号）给空清单，不编内容', () => {
  for (const [projects, templates] of [[null, null], [undefined, []], [[], undefined]]) {
    const plan = canvasStartPlan(projects, templates)
    assert.equal(plan.total, 0)
    assert.deepEqual(plan.projects, [])
    assert.deepEqual(plan.templates, [])
  }
})

test('行上的说明与动作写清「它会开什么」，不写「点我」', () => {
  const fresh = { source: 'project', id: 'p1', title: '毛衣折叠', ownerId: 'usr_me', version: 0, flowId: '', updatedAt: '' }
  const opened = { source: 'project', id: 'p2', title: '咖啡角', ownerId: 'usr_me', version: 1, flowId: 'flow_x', updatedAt: '' }
  const fromFlow = { source: 'template', id: 't1', title: '三步出片', nodes: 4, updatedAt: '' }
  assert.equal(canvasStartMeta(fresh), '还没开过工作流')
  assert.equal(canvasStartAction(fresh), '按它的脚本开一条')
  assert.equal(canvasStartMeta(opened), '已经有工作流')
  assert.equal(canvasStartAction(opened), '打开那条')
  assert.equal(canvasStartMeta(fromFlow), '来自工作流 · 4 个节点')
  assert.equal(canvasStartAction(fromFlow), '套用成新工作流')
})

test('模板节点数优先看 flowNodes 摘要，老数据退回 blueprint', () => {
  assert.equal(templateNodeCount(template('a', { flowNodes: [{}, {}] })), 2)
  assert.equal(templateNodeCount(template('b', { flowNodes: [], blueprint: { nodes: [{}, {}, {}, {}], edges: [] } })), 4)
  assert.equal(templateNodeCount(template('c', { flowNodes: [], blueprint: null })), 0)
})
