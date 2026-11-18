// 运行花费文案（v0.9.199 / v0.9.200）：出图每张、出视频每条都另扣一次积分，不能只报运行本身那笔。
// 这一组盯住四件事：生成节点要单独算进来、退款只退运行那笔、主动停止按已跑部分写、没扣费不写。
import test from 'node:test'
import assert from 'node:assert/strict'
import { runCreditsText } from '../src/domain/run.ts'

const run = (over = {}) => ({
  id: 'run_1',
  flowId: 'flow_1',
  flowName: '出图流程',
  status: 'success',
  startedAt: '2026-11-18T10:00:00.000Z',
  finishedAt: '2026-11-18T10:00:10.000Z',
  durationMs: 10000,
  total: 3,
  nodes: [],
  output: '',
  credits: { cost: 2, balance: 100, refunded: false },
  ...over,
})

test('含出图节点：运行 2 + 出图 5 都要写出来', () => {
  assert.equal(runCreditsText(run({ imageCredits: 5 })), '消耗 2 积分 + 出图 5 积分')
})

test('含出视频节点：运行 2 + 出视频 15 也要写出来，和出图并排时各算各的', () => {
  assert.equal(runCreditsText(run({ videoCredits: 15 })), '消耗 2 积分 + 出视频 15 积分')
  assert.equal(runCreditsText(run({ imageCredits: 5, videoCredits: 15 })), '消耗 2 积分 + 出图 5 积分 + 出视频 15 积分')
})

test('没有生成节点：只写运行本身那笔，不加尾巴', () => {
  assert.equal(runCreditsText(run()), '消耗 2 积分')
})

test('运行失败全额退：退回的是运行那笔，画成了的图 / 出了片的视频不退，要照实说', () => {
  const text = runCreditsText(run({ imageCredits: 5, credits: { cost: 2, balance: 100, refunded: true } }))
  assert.equal(text, '已退回 2 积分；出图 5 积分不退')
  const both = runCreditsText(run({ imageCredits: 5, videoCredits: 15, credits: { cost: 2, balance: 100, refunded: true } }))
  assert.equal(both, '已退回 2 积分；出图 5 积分、出视频 15 积分不退')
})

test('主动停止按已跑部分结算：已跑、已退、出图三件事都写', () => {
  const text = runCreditsText(run({
    imageCredits: 5,
    credits: { cost: 4, balance: 100, refunded: true, settled: true, kept: 3, refundedAmount: 1 },
  }))
  assert.equal(text, '已跑部分 3 积分 · 已退 1 积分 + 出图 5 积分')
})

test('没有任何扣费就不写这一项；只有生成节点没运行费时仍要写出来', () => {
  assert.equal(runCreditsText(run({ credits: null })), '')
  assert.equal(runCreditsText(null), '')
  assert.equal(runCreditsText(run({ credits: null, videoCredits: 15 })), '出视频 15 积分')
})
