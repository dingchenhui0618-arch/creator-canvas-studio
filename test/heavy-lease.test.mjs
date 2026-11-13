// 跨进程重活租约（v0.9.78）：生产机同时跑两个 Node 实例（对外 8799 / 内部版 8800），
// 进程内计数让「全站上限 3 条」变成「每个实例 3 条」。
// 这一组盯住五件事：
//   1) 名额就是租约：占满就拒、还回来立刻能进、limit 0 只记不拦；
//   2) 另一个进程占的租约，这里看得见（真起一个子进程，不是模拟）；
//   3) 进程被 SIGKILL，名额靠 pid 不在立刻归还，不用等 TTL；
//   4) 活着的租约靠心跳续命，不会被 TTL 误清；
//   5) 共享目录用不了时退回进程内计数（source=memory），不把重活全拒掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isolateLeaseDir } from './lease-isolation.mjs'
import { holdInChild, stopChild, LEASE_MODULE_PATH } from './lease-child.mjs'

const lease = await import(pathToFileURL(LEASE_MODULE_PATH).href)

isolateLeaseDir('vq-lease-unit-')

// 每个用例一个干净目录：租约是文件，互不干扰才能单独判断
function freshDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  process.env.VQ_HEAVY_LEASE_DIR = dir
  delete process.env.VQ_HEAVY_LEASE_TTL_MS
  delete process.env.VQ_HEAVY_LEASE_HEARTBEAT_MS
  lease.resetHeavyLeaseState()
  return dir
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('名额就是租约：占满就拒，还回来立刻能进', () => {
  freshDir('vq-lease-cap-')
  const a = lease.acquireHeavyLease('review', { limit: 2 })
  const b = lease.acquireHeavyLease('review', { limit: 2 })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a.source, 'lease')
  assert.equal(a.active, 0)
  assert.equal(b.active, 1)
  const refused = lease.acquireHeavyLease('review', { limit: 2 })
  assert.equal(refused.ok, false)
  assert.equal(refused.active, 2)
  assert.equal(refused.limit, 2)
  assert.equal(refused.byKind.review, 2)
  // 只还一个：刚好空出一个名额
  a.lease.release()
  const again = lease.acquireHeavyLease('review', { limit: 2 })
  assert.equal(again.ok, true)
  assert.equal(again.active, 1)
  b.lease.release()
  again.lease.release()
  assert.equal(lease.heavyLeaseSnapshot().total, 0)
})

test('limit 0 = 只记不拦：在跑几条照样数得出来', () => {
  freshDir('vq-lease-unlimited-')
  const held = []
  for (let i = 0; i < 5; i += 1) held.push(lease.acquireHeavyLease('flow_run', { limit: 0 }))
  assert.equal(held.every((item) => item.ok), true)
  const snapshot = lease.heavyLeaseSnapshot(['flow_run'])
  assert.equal(snapshot.source, 'lease')
  assert.equal(snapshot.total, 5)
  assert.equal(snapshot.byKind.flow_run, 5)
  for (const item of held) item.lease.release()
  assert.equal(lease.heavyLeaseSnapshot().total, 0)
})

test('另一个进程占的租约看得见：父进程按整机名额拒，杀掉子进程立刻归还', async () => {
  const dir = freshDir('vq-lease-xproc-')
  const { child, ready } = holdInChild({ dir, count: 2 })
  try {
    assert.equal(await ready, 2)
    // 父进程看到的不是 0，而是那个子进程占的 2 条
    const snapshot = lease.heavyLeaseSnapshot(['review'])
    assert.equal(snapshot.total, 2)
    assert.equal(snapshot.otherPids.length, 1)
    const refused = lease.acquireHeavyLease('review', { limit: 2 })
    assert.equal(refused.ok, false)
    assert.equal(refused.active, 2)
    // 三个名额里还能进一个：这不是「一律拒绝」
    const third = lease.acquireHeavyLease('review', { limit: 3 })
    assert.equal(third.ok, true)
    assert.equal(third.active, 2)
    third.lease.release()
  } finally {
    await stopChild(child)
  }
  // 子进程被 SIGKILL / 正常退出后：租约文件还在，但 pid 不在了，下一次数名额时清掉
  const got = lease.acquireHeavyLease('review', { limit: 2 })
  assert.equal(got.ok, true)
  assert.equal(got.active, 0)
  got.lease.release()
  assert.ok(lease.heavyLeaseStatus().stats.pruned >= 2)
})

test('死 pid 的租约不算名额（进程被杀不会留下永久占位）', () => {
  const dir = freshDir('vq-lease-dead-')
  fs.writeFileSync(path.join(dir, '999999-abc-1.lease'), JSON.stringify({ pid: 999999, kind: 'review', startedAt: Date.now() }))
  assert.equal(lease.heavyLeaseSnapshot(['review']).total, 0)
  assert.equal(fs.existsSync(path.join(dir, '999999-abc-1.lease')), false)
})

test('活着的租约不会被 TTL 误清：心跳续命，另一个进程照样看得见', async () => {
  freshDir('vq-lease-heartbeat-')
  process.env.VQ_HEAVY_LEASE_TTL_MS = '300'
  process.env.VQ_HEAVY_LEASE_HEARTBEAT_MS = '80'
  const held = lease.acquireHeavyLease('replicate', { limit: 1 })
  assert.equal(held.ok, true)
  try {
    await sleep(900)
    const snapshot = lease.heavyLeaseSnapshot(['replicate'])
    assert.equal(snapshot.total, 1, '心跳在跑，租约不该被当泄漏清掉')
    const refused = lease.acquireHeavyLease('replicate', { limit: 1 })
    assert.equal(refused.ok, false)
  } finally {
    held.lease.release()
  }
})

test('陈旧租约（pid 还在但半小时没动静）按泄漏清掉', () => {
  const dir = freshDir('vq-lease-stale-')
  const file = path.join(dir, process.pid + '-zzz-1.lease')
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, kind: 'review', startedAt: Date.now() }))
  const old = new Date(Date.now() - 60 * 60 * 1000)
  fs.utimesSync(file, old, old)
  assert.equal(lease.heavyLeaseSnapshot(['review']).total, 0)
  assert.equal(fs.existsSync(file), false)
})

test('共享目录用不了：退回进程内计数并标记 degraded，不把重活全拒', () => {
  const blocker = path.join(os.tmpdir(), 'vq-lease-blocker-' + process.pid + '.txt')
  fs.writeFileSync(blocker, 'not a directory')
  process.env.VQ_HEAVY_LEASE_DIR = path.join(blocker, 'leases')
  lease.resetHeavyLeaseState()
  try {
    const got = lease.acquireHeavyLease('review', { limit: 1 })
    assert.equal(got.ok, true)
    assert.equal(got.source, 'memory')
    assert.equal(got.degraded, true)
    const snapshot = lease.heavyLeaseSnapshot(['review'])
    assert.equal(snapshot.source, 'process')
    assert.equal(snapshot.degraded, true)
    assert.ok(lease.heavyLeaseStatus().stats.dirFail >= 1)
  } finally {
    fs.rmSync(blocker, { force: true })
    lease.resetHeavyLeaseState()
  }
})

test('状态接口：两个实例共用同一个目录、清理计数与配置都在', () => {
  freshDir('vq-lease-status-')
  const status = lease.heavyLeaseStatus()
  for (const key of ['enabled', 'dir', 'source', 'total', 'byKind', 'otherPids', 'ttlMs', 'heartbeatMs', 'lockWaitMs', 'stats']) {
    assert.ok(key in status, '状态里缺 ' + key)
  }
  assert.equal(status.enabled, true)
  assert.equal(status.ttlMs, 30 * 60 * 1000)
  assert.equal(status.stats.refused, 0)
})