// 两个实例共用一份 DATA_DIR，启动恢复不能收别人还在跑的单（v0.9.99）。
// 这一组盯住：
//   1) 心跳文件写得出来、认得自己、退出时摘掉；
//   2) 另一个实例心跳新 + 进程在：它的 running / queued 记录都不动，也不退款；
//   3) 心跳还新但进程已经没了（崩溃后马上重启）：照收，不能把崩溃当成「还在跑」；
//   4) 心跳过期 / 升级前没有归属的旧记录：照旧收（标中断、按账本退款 / 撤排队单）。
// 零上游：只跑 output 节点，模型一次都不调。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { isolateLeaseDir } from './lease-isolation.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-instance-recovery-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-instance-recovery'
process.env.VISION_API_KEY = ''
process.env.VQ_INSTANCE_ID = 'test-self:8787'
process.env.VQ_INSTANCE_BEAT_MS = '1000'
process.env.VQ_INSTANCE_TTL_MS = '4000'
isolateLeaseDir('vq-lease-instance-recovery-')

const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const flows = await import('../server/flows.mjs')
const instances = await import('../server/instances.mjs')

const user = auth.createUser({ email: '[EMAIL:SM4W1K]', password: 'Passw0rd!demo', name: '实例恢复', kind: 'admin' })
const balance = () => credits.balanceOf(user.id)

const outputFlow = () => flows.createFlow({ name: '实例恢复画布', nodes: [{ id: 'out', type: 'output', data: { title: '输出', config: {} } }], edges: [] }, user)

async function writeBeat(id, { beatAt = new Date().toISOString(), pid = process.pid, host = os.hostname(), bootId = '' } = {}) {
  const file = instances.instanceFilePath(id)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify({ id, pid, host, bootId, startedAt: beatAt, beatAt }))
  return file
}

async function removeBeat(id) {
  await fsp.rm(instances.instanceFilePath(id), { force: true })
}

async function chargedRun(flow, { owner = '' } = {}) {
  const runId = flows.newRunId()
  await flows.startFlowRun(flow, runId, { cost: 2 })
  credits.charge(user.id, 'flow_run', { ref: runId })
  const rec = await flows.getRun(runId, user)
  if (owner) rec.ownerInstance = owner
  return runId
}

test('心跳：启动写一份、列表认自己是本实例、退出时摘掉', async () => {
  assert.deepEqual((await instances.listInstances()).items, [])
  const me = await instances.startInstanceHeartbeat()
  assert.equal(me.id, 'test-self:8787')
  const list = await instances.listInstances()
  assert.equal(list.items.length, 1)
  assert.equal(list.self, 'test-self:8787')
  assert.equal(list.items[0].self, true)
  assert.equal(list.items[0].alive, true)
  assert.equal(list.items[0].state, 'alive')
  assert.equal(list.heartbeatError, '')
  assert.ok(list.items[0].ageMs !== null && list.items[0].ageMs < 5000)
  assert.equal(list.beatMs, 1000)
  assert.equal(list.ttlMs, 4000)

  await instances.stopInstanceHeartbeat()
  assert.deepEqual((await instances.listInstances()).items, [])
})

test('另一个实例还活着：它的运行记录不收回、不退款；心跳过期后才收', async () => {
  const before = balance()
  const flow = await outputFlow()
  const runId = await chargedRun(flow, { owner: 'other:8799' })
  assert.equal(balance(), before - 2)
  await writeBeat('other:8799')

  const skipped = await flows.recoverInterruptedRuns()
  assert.equal(skipped.skipped, 1, '主人还活着的运行要跳过')
  assert.equal(skipped.recovered, 0)
  assert.equal(skipped.refunded, 0)
  assert.equal(balance(), before - 2, '跳过时不能退款')
  const alive = await flows.getRun(runId, user)
  assert.equal(alive.status, 'running', '跳过时记录原样保留')

  // 另一台也停了：心跳过期之后，这条才轮到我们收
  await writeBeat('other:8799', { beatAt: new Date(Date.now() - 12000).toISOString() })
  const recovered = await flows.recoverInterruptedRuns()
  assert.equal(recovered.recovered, 1)
  assert.equal(recovered.refunded, 1)
  assert.equal(balance(), before, '没收掉之后才退款')
  assert.equal((await flows.getRun(runId, user)).status, 'interrupted')
  await removeBeat('other:8799')
})

test('排队单也一样：另一个实例还在排队，不能被撤掉', async () => {
  const flow = await outputFlow()
  const other = 'other:8799'
  await writeBeat(other)
  const runId = flows.newRunId()
  await flows.startFlowRun(flow, runId, { cost: 2, queued: true })
  const rec = await flows.getRun(runId, user)
  rec.ownerInstance = other
  const skipped = await flows.recoverInterruptedRuns()
  assert.equal(skipped.skipped, 1)
  assert.equal(skipped.dropped, 0, '别人还在排队的单不能撤')
  assert.equal((await flows.getRun(runId, user)).status, 'queued')

  // 收尾：另一台也没了，下一位恢复会把它当没扣过钱的排队单撤掉
  await writeBeat(other, { beatAt: new Date(Date.now() - 12000).toISOString() })
  const dropped = await flows.recoverInterruptedRuns()
  assert.equal(dropped.dropped, 1)
  assert.equal(await flows.getRun(runId, user), null)
  await removeBeat(other)
})

test('心跳还新但进程已经没了：照收，崩溃不能被当成「还在跑」', async () => {
  const before = balance()
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  const deadPid = child.pid
  await writeBeat('crash:8799', { pid: deadPid })
  const row = (await instances.listInstances()).items.find((item) => item.id === 'crash:8799')
  assert.equal(row.alive, false, '进程没了就是没了，心跳新也不行')
  assert.equal(row.state, 'dead')

  const flow = await outputFlow()
  await chargedRun(flow, { owner: 'crash:8799' })
  const result = await flows.recoverInterruptedRuns()
  assert.equal(result.skipped, 0)
  assert.equal(result.recovered, 1)
  assert.equal(balance(), before, '崩溃实例的已扣积分要退回')
  await removeBeat('crash:8799')
})

test('升级前没有实例归属的旧记录照旧收；自己的记录也照旧收', async () => {
  const before = balance()
  const flow = await outputFlow()
  const legacyId = await chargedRun(flow)
  delete (await flows.getRun(legacyId, user)).ownerInstance
  const mineId = await chargedRun(flow)
  assert.equal((await flows.getRun(mineId, user)).ownerInstance, 'test-self:8787')

  const result = await flows.recoverInterruptedRuns()
  assert.equal(result.recovered, 2)
  assert.equal(result.refunded, 2)
  assert.equal(balance(), before)
  assert.equal((await flows.getRun(legacyId, user)).status, 'interrupted')
  assert.equal((await flows.getRun(mineId, user)).status, 'interrupted')
})

test('runFlow 覆盖占位记录时不会丢掉实例归属', async () => {
  const flow = await outputFlow()
  const runId = flows.newRunId()
  await flows.startFlowRun(flow, runId, { cost: 0 })
  const run = await flows.runFlow(flow, { runId, credits: null })
  assert.equal(run.status, 'success')
  assert.equal((await flows.getRun(runId, user)).ownerInstance, 'test-self:8787')
})

test('超过保留期的死心跳会被清掉，新鲜的留着给判据', async () => {
  const now = Date.now()
  await writeBeat('old-dead:8799', { beatAt: new Date(now - 8 * 24 * 3600 * 1000).toISOString(), pid: 2147483647 })
  await writeBeat('fresh:8799')
  const removed = await instances.pruneInstances()
  assert.ok(removed >= 1)
  const ids = (await instances.listInstances()).items.map((item) => item.id)
  assert.ok(!ids.includes('old-dead:8799'))
  assert.ok(ids.includes('fresh:8799'))
  await removeBeat('fresh:8799')
})
