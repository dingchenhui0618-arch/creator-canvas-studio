// 评完之后往哪走（r251 / v0.9.234）。
// 测的是「结论出来那一刻，结果页给哪几个出口、写什么字」：以前这里到说明就结束了，
// 结论记在哪一版、要不要拍板、该回作品还是回工作流，全靠自己再找一遍。
import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewNextActionLabel, reviewNextPlan } from '../src/domain/review-next.ts'

const project = { id: 'prj_1', title: '毛衣折叠收纳法', version: 2 }
const withFlow = { ...project, flowId: 'flow_1' }
const issues = { blocker: 1, major: 2, minor: 0, info: 0, counted: 3, observations: 4 }

test('通过了又挂在作品上：往交付走，作品页排第一，没接工作流就不给工作流出口', () => {
  const plan = reviewNextPlan({ verdict: 'pass', project, issues })
  assert.equal(plan.tone, 'pass')
  assert.equal(plan.title, '这一版可以往交付走')
  assert.equal(plan.copy, '《毛衣折叠收纳法》第 2 版这次没查出必须先解决的问题。确认这一版、封成交付包都在作品页。')
  assert.deepEqual(plan.actions, ['openProject'])
})

test('通过了又有修正建议：建议写进正文，不新建出口', () => {
  const plan = reviewNextPlan({ verdict: 'pass', project, issues, fixes: 2 })
  assert.equal(plan.copy.endsWith('另有 2 条建议，想再打磨也可以改完再评一次。'), true)
  assert.deepEqual(plan.actions, ['openProject'])
})

test('挂在接了工作流的作品上：作品页在前，回工作流改结构跟在后面', () => {
  assert.deepEqual(reviewNextPlan({ verdict: 'pass', project: withFlow }).actions, ['openProject', 'openFlow'])
  assert.deepEqual(reviewNextPlan({ verdict: 'fail', project: withFlow, issues }).actions, ['openProject', 'openFlow'])
})

test('不通过：说清有几处必须先解决，并分开「改结构」与「换画面」两条路', () => {
  const plan = reviewNextPlan({ verdict: 'fail', project, issues })
  assert.equal(plan.tone, 'fix')
  assert.equal(plan.title, '先别发布这一版')
  assert.equal(plan.copy, '《毛衣折叠收纳法》第 2 版有 3 处必须先解决（1 阻塞 · 2 主要）。结构要改就打开工作流重跑，只是画面问题就换一张新画面再评。')
})

test('不通过但老记录没记严重度：不写「有 0 处」', () => {
  const plan = reviewNextPlan({ verdict: 'fail', project })
  assert.equal(plan.copy.includes('有 0 处'), false)
  assert.equal(plan.copy, '《毛衣折叠收纳法》第 2 版这次判了不通过。结构要改就打开工作流重跑，只是画面问题就换一张新画面再评。')
})

test('需人工确认：把结论与问题数写在同一条里，出口仍是作品页', () => {
  const plan = reviewNextPlan({ verdict: 'needs_review', project, issues })
  assert.equal(plan.title, '这一版要你拍板')
  assert.equal(plan.copy, '《毛衣折叠收纳法》第 2 版这次结论是「需人工确认」：1 阻塞 · 2 主要。看完回作品页确认这一版，或者改完再评一次。')
  assert.deepEqual(plan.actions, ['openProject'])
})

test('还没开工作流的作品：不写「第 0 版」', () => {
  const plan = reviewNextPlan({ verdict: 'pass', project: { ...project, version: 0 } })
  assert.equal(plan.copy.includes('第 0 版'), false)
  assert.equal(plan.copy.startsWith('《毛衣折叠收纳法》这次没查出'), true)
})

test('单独评一张画面：说清作品页看不到这份结论，只给去作品流', () => {
  const plan = reviewNextPlan({ verdict: 'pass', project: null })
  assert.equal(plan.tone, 'loose')
  assert.equal(plan.title, '这次评的是一张单独的图')
  assert.equal(plan.copy.includes('作品页看不到这份结论'), true)
  assert.deepEqual(plan.actions, ['openProjects'])
})

test('回头看的旧记录：只读，只给回作品看这一版', () => {
  const plan = reviewNextPlan({ verdict: 'pass', project: withFlow, history: true })
  assert.equal(plan.tone, 'loose')
  assert.equal(plan.title, '这条结论记在《毛衣折叠收纳法》第 2 版')
  assert.equal(plan.copy.includes('历史记录只能看'), true)
  assert.deepEqual(plan.actions, ['openProject'])
})

test('旧记录也没挂作品：不给动手的出口', () => {
  const plan = reviewNextPlan({ verdict: 'fail', project: null, history: true })
  assert.deepEqual(plan.actions, ['openProjects'])
  assert.equal(plan.title, '这条结论没挂在作品上')
})

test('按钮字：回作品带作品名，太长按字数截断，其余两个是固定说法', () => {
  assert.equal(reviewNextActionLabel('openProject', project), '回《毛衣折叠收纳法》这一版')
  assert.equal(reviewNextActionLabel('openProject', { ...project, title: '一条特别特别长的作品标题啊真的长' }), '回《一条特别特别长的作品标题…》这一版')
  assert.equal(reviewNextActionLabel('openProject', null), '去作品页')
  assert.equal(reviewNextActionLabel('openFlow', project), '打开工作流')
  assert.equal(reviewNextActionLabel('openProjects', project), '去作品流')
})

test('三种结论的语气分开：通过往交付走，另外两种都还要动手', () => {
  assert.equal(reviewNextPlan({ verdict: 'pass', project }).tone, 'pass')
  assert.equal(reviewNextPlan({ verdict: 'needs_review', project }).tone, 'fix')
  assert.equal(reviewNextPlan({ verdict: 'fail', project }).tone, 'fix')
})
