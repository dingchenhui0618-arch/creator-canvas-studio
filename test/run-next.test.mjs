// 跑完之后往哪走（r250 / v0.9.233）。
// 测的是「跑完那一刻，抽屉底栏给哪几个出口、写什么字」：以前这一屏只有逐节点结果，
// 用户不知道该点哪里；现在底栏直接写着下一步，所以这些字与出口顺序都要被钉住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { runNextActionLabel, runNextPlan } from '../src/domain/run-next.ts'

function node(status, extra = {}) {
  return { id: 'n_' + status + Math.random().toString(36).slice(2, 6), kind: 'text', title: '节点', status, ms: 10, output: null, error: null, message: null, ...extra }
}

function record(extra = {}) {
  return {
    id: 'run_1',
    flowId: 'flow_1',
    flowName: '一条工作流',
    status: 'success',
    startedAt: '2026-11-19T00:00:00.000Z',
    finishedAt: '2026-11-19T00:00:10.000Z',
    durationMs: 10000,
    total: 3,
    nodes: [],
    output: '',
    ...extra,
  }
}

const project = { id: 'prj_1', title: '毛衣折叠收纳法', version: 2, archived: false }

test('还在跑、还在排队、还没有结论：不给这一块，别拿占位冒充「接下来」', () => {
  const nodes = [node('success')]
  assert.equal(runNextPlan({ record: record(), nodes, running: true }), null)
  assert.equal(runNextPlan({ record: record({ status: 'running' }), nodes }), null)
  assert.equal(runNextPlan({ record: record({ status: 'queued' }), nodes }), null)
  assert.equal(runNextPlan({ record: null, nodes }), null)
})

test('跑成功又挂在作品上：送去评审排第一，存成模板与打开作品跟在后面', () => {
  const plan = runNextPlan({
    record: record({ project, spentTotal: 15 }),
    nodes: [node('success'), node('success'), node('success')],
  })
  assert.equal(plan.tone, 'done')
  assert.equal(plan.title, '这次跑完了')
  assert.deepEqual(plan.actions, ['review', 'saveTemplate', 'openProject'])
  assert.match(plan.copy, /全部 3 个节点跑完了/)
  assert.match(plan.copy, /花 15 积分/)
  assert.match(plan.copy, /《毛衣折叠收纳法》第 2 版下/)
})

test('作品还没编过版（version 0）：不写「第 0 版」', () => {
  const plan = runNextPlan({
    record: record({ project: { ...project, version: 0 } }),
    nodes: [node('success'), node('success'), node('success')],
  })
  assert.doesNotMatch(plan.copy, /第 0 版/)
  assert.match(plan.copy, /《毛衣折叠收纳法》下/)
})

test('跑成功但没挂作品：不编一条作品出来，只留「存成模板」并说清原因', () => {
  const plan = runNextPlan({ record: record({ spentTotal: 0 }), nodes: [node('success'), node('success'), node('success')] })
  assert.deepEqual(plan.actions, ['saveTemplate'])
  assert.match(plan.copy, /还没挂到作品上/)
  assert.match(plan.copy, /存成模板/)
  assert.doesNotMatch(plan.copy, /花 0 积分/) // 没花钱就不写这一句
})

test('跑的是归档的旧版：不拉去评审，只留存模板与打开作品', () => {
  const plan = runNextPlan({
    record: record({ project: { ...project, archived: true } }),
    nodes: [node('success'), node('success'), node('success')],
  })
  assert.deepEqual(plan.actions, ['saveTemplate', 'openProject'])
})

test('自己停下：不说「没跑完」，说清几个留了结果、几个没跑', () => {
  const plan = runNextPlan({
    record: record({ status: 'interrupted', canceled: true, total: 4, credits: { cost: 4, balance: 100, refunded: false, kept: 2, settled: true } }),
    nodes: [node('success'), node('success')],
  })
  assert.equal(plan.tone, 'stopped')
  assert.equal(plan.title, '你停下了这次运行')
  assert.match(plan.copy, /2 个节点留下结果，2 个没跑/)
})

test('一个节点都没跑完就停下：不写「0 个节点留下结果」，并说积分退没退', () => {
  const plan = runNextPlan({
    record: record({ status: 'interrupted', canceled: true, credits: { cost: 4, balance: 100, refunded: true } }),
    nodes: [],
  })
  assert.match(plan.copy, /一个节点都没跑完，积分已退回/)
})

test('有节点失败：数写清，续跑可用时指一句「不用从头」', () => {
  const plan = runNextPlan({
    record: record({ status: 'error', resumable: true, availableToResume: true, credits: { cost: 4, balance: 100, refunded: true } }),
    nodes: [node('success'), node('success'), node('error')],
  })
  assert.equal(plan.tone, 'partial')
  assert.equal(plan.title, '这次没跑完')
  assert.match(plan.copy, /2\/3 个节点跑完，1 个失败/)
  assert.match(plan.copy, /接着跑，不用从头/)
})

test('失败且没有可续跑的节点：退回积分要写在后面，不能只说失败', () => {
  const plan = runNextPlan({
    record: record({ status: 'error', credits: { cost: 4, balance: 100, refunded: true } }),
    nodes: [node('error'), node('error'), node('error')],
  })
  assert.match(plan.copy, /没有节点跑完/)
  assert.match(plan.copy, /积分已退回/)
})

test('进程打断（不是用户停的）走「被中断」，别写成用户自己按了停止', () => {
  const plan = runNextPlan({ record: record({ status: 'interrupted', total: 3 }), nodes: [node('success')] })
  assert.equal(plan.title, '这次被中断了')
  assert.match(plan.copy, /1\/3 个节点跑完/)
})

test('抽屉停在别的工作流的旧运行上：不提「存成模板」，否则存下去是另一条', () => {
  const plan = runNextPlan({
    record: record({ flowId: 'flow_other', project, spentTotal: 5 }),
    nodes: [node('success'), node('success'), node('success')],
    flowId: 'flow_now',
  })
  assert.deepEqual(plan.actions, ['review', 'openProject'])
})

test('花费优先取 spentTotal，缺省时把出图与出视频那两笔补上', () => {
  const plan = runNextPlan({
    record: record({ project, credits: { cost: 2, balance: 10, refunded: false }, imageCredits: 5, videoCredits: 15 }),
    nodes: [node('success'), node('success'), node('success')],
  })
  assert.match(plan.copy, /花 22 积分/)
})

test('一条空工作流的运行没有可说的下一步', () => {
  assert.equal(runNextPlan({ record: record({ total: 0 }), nodes: [] }), null)
})

test('按钮上的字自己说得清结果', () => {
  assert.equal(runNextActionLabel('review'), '送去评审这一版')
  assert.equal(runNextActionLabel('saveTemplate'), '存成模板')
  assert.equal(runNextActionLabel('openProject'), '打开作品')
})
