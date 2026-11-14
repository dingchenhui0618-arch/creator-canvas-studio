// 运行记录页的续跑预检文案（v0.9.105）。这一组盯住四件事：
//   1) 记录里的旧估算过期时，页面只信刚算出来的 plan；
//   2) 改过 / 删掉的节点要在「还差几个」里说清楚，不能只说复用；
//   3) 补 0 积分时不要写「补 0 积分」；
//   4) 不能续时给出原因，并且不给按钮——避免点进去才发现没有可复用节点。
import test from 'node:test'
import assert from 'node:assert/strict'
import { runResumePlanView } from '../src/domain/run.ts'

const plan = (over = {}) => ({
  ok: true,
  runId: 'run_stopped',
  flowId: 'flow_1',
  total: 5,
  reused: 3,
  rerun: 2,
  stale: 0,
  cost: 2,
  resumable: true,
  reason: '',
  ...over,
})

test('能续：复用 / 还差 / 补多少写在同一行，按钮跟着 plan 走', () => {
  const view = runResumePlanView(plan())
  assert.equal(view.resumable, true)
  assert.equal(view.summary, '复用 3 个 · 还差 2 个 · 补 2 积分')
  assert.equal(view.button, '继续运行 · 补 2 积分')
  assert.match(view.note, /上次跑完且内容没变/)
})

test('画布改过：把失效的节点数写进括号，还差的是当前画布要跑的总数', () => {
  const view = runResumePlanView(plan({ reused: 2, rerun: 3, stale: 1 }))
  assert.equal(view.summary, '复用 2 个 · 还差 3 个（其中 1 个改过） · 补 2 积分')
  assert.match(view.note, /改过或已不在画布上的 1 个节点会重跑/)
})

test('补 0 积分：说「不再扣费」，不写「补 0 积分」', () => {
  const view = runResumePlanView(plan({ cost: 0 }))
  assert.equal(view.summary, '复用 3 个 · 还差 2 个 · 不再扣费')
  assert.equal(view.button, '继续运行 · 不再扣费')
})

test('不能续：用服务端给的具体原因，按钮为空', () => {
  const view = runResumePlanView(plan({
    reused: 0,
    rerun: 5,
    stale: 3,
    cost: 0,
    resumable: false,
    reason: '画布改动后没有能原样复用的节点：重新运行会用最新画布从头跑',
  }))
  assert.equal(view.resumable, false)
  assert.match(view.summary, /没有能原样复用的节点/)
  assert.equal(view.button, '')
  assert.match(view.note, /从头运行会按最新画布跑全图/)
})

test('还没拿到 plan：不编数字，也不给按钮', () => {
  const view = runResumePlanView(null)
  assert.deepEqual(view, { resumable: false, summary: '', note: '', button: '' })
})
