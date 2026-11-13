import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 复刻任务是「发一次版就可能漏一次钱」的地方：任务只存内存时，进程一重启就 404，
// 已经扣掉的积分留在平台账上。这一组测试盯住三条不变量：
//   1) 任务与每一步都落库，重启后还能查到；
//   2) 重启恢复把没跑完的任务标成失败，并按积分账本把净扣款退回；
//   3) 同一条任务无论被收尾多少次，退款只发生一次（余额不会凭空变多）。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-jobs-'))
process.env.DATA_DIR = dir

const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const jobs = await import('../server/jobs.mjs')

const user = auth.createUser({ email: 'jobs@example.com', password: 'Passw0rd!demo', name: '任务测试', kind: 'admin' })
const balance = () => credits.balanceOf(user.id)

// 每个用例都从「没有在跑的任务」开始：上一条用例留下的草稿先按重启恢复清掉，
// 这样断言的是本条用例自己的账，而不是测试执行顺序。
function clean() {
  jobs.recoverInterruptedJobs()
  return balance()
}

function draftWithCharge(jobId, { amount = 10, label = '一条测试原片' } = {}) {
  jobs.createJobDraft({ id: jobId, ownerId: user.id, cost: amount, label })
  credits.charge(user.id, 'replicate', { ref: jobId, meta: { label } })
}

test('任务草稿与每一步都落库，重启后按 id 还能查到', () => {
  clean()
  const jobId = jobs.newJobId()
  draftWithCharge(jobId)
  const record = jobs.readJobRecord(jobId)
  assert.ok(record, '草稿必须已经写进库里，而不是只存在内存')
  assert.equal(record.status, 'queued')
  assert.equal(record.cost, 10)
  assert.equal(record.label, '一条测试原片', '任务要记住用户看得懂的说明')
  assert.equal(jobs.getJob(jobId, user)?.id, jobId)
  // 别人拿着 id 也读不到
  assert.equal(jobs.getJob(jobId, { id: 'usr_other', kind: 'account' }), null)
  clean()
})

test('重启恢复：没跑完的任务标成失败，并按账本退回积分', () => {
  const before = clean()
  const jobId = jobs.newJobId()
  draftWithCharge(jobId)
  assert.equal(balance(), before - 10)

  const first = jobs.recoverInterruptedJobs()
  assert.equal(first.recovered, 1)
  assert.equal(first.refunded, 1)
  const record = jobs.readJobRecord(jobId)
  assert.equal(record.status, 'error', '中断任务不能还挂在 running')
  assert.match(record.error, /重启/)
  assert.equal(record.refunded, true)
  assert.equal(balance(), before, '扣掉的 10 积分必须原样退回')
  // 账本说明列给用户看标题，ref 里才是 jobId：退款行也要带上
  const refundRow = credits.ledgerOf(user.id, 5).find((row) => row.kind === 'replicate-refund' && row.ref === jobId)
  assert.equal(refundRow?.label, '一条测试原片')

  // 再启动一次（或者路由兜底又收尾一遍）：不能退第二次
  const second = jobs.recoverInterruptedJobs()
  assert.equal(second.recovered, 0)
  assert.equal(balance(), before, '重复恢复不能多退')
})

test('扣费成功、流水线还没启动就断电：恢复时按净扣款退', () => {
  const before = clean()
  const jobId = jobs.newJobId()
  // 模拟「扣费成功、流水线还没启动」就断电：任务仍是 queued
  draftWithCharge(jobId, { amount: 10 })
  const owed = credits.outstandingCharge(user.id, 'replicate', jobId)
  assert.equal(owed, 10, '账本里看到的就是还欠用户的净额')
  jobs.recoverInterruptedJobs()
  assert.equal(credits.outstandingCharge(user.id, 'replicate', jobId), 0)
  assert.equal(balance(), before)
})

test('正常完成的任务不被恢复逻辑碰，也不退款', () => {
  const before = clean()
  const jobId = jobs.newJobId()
  draftWithCharge(jobId)
  const db = auth.openDb()
  db.prepare("UPDATE replicate_jobs SET status = 'done', step = 'done', progress = 100 WHERE id = ?").run(jobId)
  const result = jobs.recoverInterruptedJobs()
  assert.equal(result.recovered, 0)
  assert.equal(jobs.readJobRecord(jobId).status, 'done')
  assert.equal(jobs.readJobRecord(jobId).refunded, false)
  assert.equal(balance(), before - 10, '成功的任务照常扣费')
})

test('并发闸门 / 积分不足时草稿撤掉，不留空任务', () => {
  clean()
  const jobId = jobs.newJobId()
  jobs.createJobDraft({ id: jobId, ownerId: user.id, cost: 10 })
  assert.equal(jobs.dropJobDraft(jobId), true)
  assert.equal(jobs.readJobRecord(jobId), null)
  // 已经扣过钱的草稿不能直接删：删掉就再也没人退这笔钱了
  const paidId = jobs.newJobId()
  draftWithCharge(paidId)
  assert.equal(jobs.dropJobDraft(paidId), false)
  assert.ok(jobs.readJobRecord(paidId))
  clean()
})

test('后台任务列表按时间倒序，带状态计数与退款标记', () => {
  clean()
  const a = jobs.newJobId()
  draftWithCharge(a)
  jobs.recoverInterruptedJobs()
  const b = jobs.newJobId()
  draftWithCharge(b)
  jobs.recoverInterruptedJobs()
  const data = jobs.listJobs({ limit: 10 })
  assert.ok(data.items.length >= 2)
  const times = data.items.map((item) => String(item.createdAt))
  assert.deepEqual(times, [...times].sort().reverse(), '最近的任务排最前')
  assert.ok(data.items.some((item) => item.refunded), '退过款的任务要能标出来')
  assert.ok(Number(data.counts.error) >= 2)
  const mine = jobs.listJobs({ limit: 10, userId: user.id })
  assert.equal(mine.items.length, data.items.length)
  assert.deepEqual(jobs.listJobs({ limit: 10, userId: 'usr_nobody' }).items, [])
})

test('停机收尾：在跑任务标中断并退款，关机不再扣钱', () => {
  const before = clean()
  const jobId = jobs.newJobId()
  draftWithCharge(jobId)
  // 直接把内存里的任务当成 running，模拟流水线正在跑
  const job = jobs.createJobDraft({ id: jobId, ownerId: user.id, cost: 10 })
  job.status = 'running'
  const interrupted = jobs.interruptRunningJobs('服务重启')
  assert.equal(interrupted, 1)
  const record = jobs.readJobRecord(jobId)
  assert.equal(record.status, 'error')
  assert.equal(record.refunded, true)
  assert.equal(balance(), before)
  // 收尾重复调用无副作用
  assert.equal(jobs.interruptRunningJobs('服务重启'), 0)
  assert.equal(balance(), before)
})

test('没有视频链接时任务立刻失败，已扣的积分退回（不需要等轮询）', async () => {
  const before = clean()
  const jobId = jobs.newJobId()
  jobs.createJobDraft({ id: jobId, ownerId: user.id, cost: 10 })
  credits.charge(user.id, 'replicate', { ref: jobId })
  let settled = ''
  const job = await jobs.startReplicate({ title: '没有链接' }, '', {
    jobId,
    ownerId: user.id,
    cost: 10,
    onSettled: (status) => {
      settled = status
    },
  })
  assert.equal(job.status, 'error')
  assert.equal(settled, 'error', '结算回调必须被调用，否则并发闸门永远不放')
  assert.equal(jobs.readJobRecord(jobId).refunded, true)
  assert.equal(balance(), before)
})