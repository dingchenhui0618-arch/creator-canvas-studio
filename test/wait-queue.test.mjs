// 排队位进共享目录（v0.9.93）：一台机器上的两个实例排同一条队。
// v0.9.80 会排队、v0.9.83 能看到名次，但那条队一直活在本进程的 Map 里——
// 「最多 8 条同时排」实际是每进程 8 条，先来先得在跨进程时也不成立。
// 这一组盯六件事：
//   1) 排队位就是共享目录里的文件：同一张票不重复占位，名次按入场顺序；
//   2) 票号只以哈希落盘——那是「查自己排第几」的凭据，不能明文躺在全机器可读的目录里；
//   3) 另一个真进程排进来的那一条，这边看得见（名次与条数都是整机口径），它一退立刻消失；
//   4) 排队位上限是整机的：另一个进程占满，这边就进不来；
//   5) 心跳停了的 waiter 会被清掉——头名死在半路不能把整条队堵住；
//   6) 共享目录用不了就退回进程内，并把 queueScope 如实报成 process。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isolateLeaseDir } from './lease-isolation.mjs'
import { stopChild } from './lease-child.mjs'
import { waitInChild } from './wait-child.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-wait-queue-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-wait-queue'
isolateLeaseDir('vq-wait-queue-lease-')

const waitq = await import('../server/wait-queue.mjs')
const lease = await import('../server/heavy-lease.mjs')
const water = await import('../server/waterline.mjs')
const { config } = await import('../server/config.mjs')
// 这组测的是排队位，不是这台机器的内存：把水位阈值关掉，判定就只剩名额与排队这一层
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })

// 每个用例一个干净目录：排队位是文件，互不干扰才能单独判断
function freshDir(prefix = 'vq-wq-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  process.env.VQ_HEAVY_LEASE_DIR = dir
  delete process.env.VQ_QUEUE_STALE_MS
  waitq.resetWaitQueueState()
  lease.resetHeavyLeaseState()
  return dir
}

const waitersOf = (dir) => {
  try {
    return fs.readdirSync(path.join(dir, 'waiters'))
  } catch {
    return []
  }
}

test('排队位就是共享目录里的文件：同一张票不重复占位，票号不落盘', () => {
  const dir = freshDir('vq-wq-basic-')
  const first = waitq.joinWaitQueue('canvas_gen', 't-a', { maxWaiting: 4 })
  assert.equal(first.ok, true)
  assert.equal(first.scope, 'lease', '共享目录可用时排队位就是整机的')
  assert.equal(first.position, 1)
  const again = waitq.joinWaitQueue('canvas_gen', 't-a', { maxWaiting: 4 })
  assert.equal(again.position, 1, '同一张票重试不重复占位')
  assert.equal(again.waiting, 1)
  const second = waitq.joinWaitQueue('canvas_gen', 't-b', { maxWaiting: 4 })
  assert.equal(second.position, 2, '名次按入场顺序')

  const snapshot = waitq.waitQueueSnapshot('canvas_gen')
  assert.equal(snapshot.scope, 'lease')
  assert.equal(snapshot.waiting, 2)
  assert.deepEqual(snapshot.queue.map((row) => row.position), [1, 2])
  assert.ok(snapshot.oldestWaitMs >= 0)
  assert.equal(waitq.waitQueuePosition('canvas_gen', 't-b').ahead, 1, '前面还有一张')
  assert.equal(waitq.waitQueueAhead('canvas_gen', first.order), 0, '头名前面没有人')

  const files = waitersOf(dir)
  assert.equal(files.length, 2, '两条 waiter = 两个文件：' + files.join(','))
  for (const name of files) {
    assert.match(name, /^[a-f0-9]{16}-\d+-[a-z0-9]+\.wait$/, '文件名是「票号哈希-进程-入场时间」：' + name)
    const text = fs.readFileSync(path.join(dir, 'waiters', name), 'utf8')
    assert.equal(text.includes('t-a'), false, '票号本身不落盘：' + text)
    assert.equal(text.includes('t-b'), false, '票号本身不落盘：' + text)
    assert.equal(JSON.parse(text).kind, 'canvas_gen')
  }

  assert.equal(waitq.leaveWaitQueue('canvas_gen', 't-a'), true)
  assert.equal(waitq.leaveWaitQueue('canvas_gen', 't-b'), true)
  assert.equal(waitq.waitQueueSnapshot('canvas_gen').waiting, 0)
  assert.equal(waitersOf(dir).length, 0, '排完要把文件收干净')
})

test('另一个进程排进来的那一条，这里看得见；它一退，名次立刻放出来', async () => {
  const dir = freshDir('vq-wq-child-')
  const mine = waitq.joinWaitQueue('canvas_gen', 'parent-1', { maxWaiting: 8 })
  assert.equal(mine.position, 1)
  const { child, ready } = waitInChild({ dir, ticket: 'child-1', maxWaiting: 8 })
  try {
    const joined = await ready
    assert.equal(joined.ok, true)
    assert.equal(joined.scope, 'lease')
    assert.equal(joined.position, 2, '子进程看得见父进程那一条：' + JSON.stringify(joined))
    const snapshot = waitq.waitQueueSnapshot('canvas_gen')
    assert.equal(snapshot.waiting, 2, '两个进程各一条，整机就是两条')
    assert.equal(waitq.waitQueuePosition('canvas_gen', 'child-1').position, 2)
    assert.equal(waitq.waitQueuePosition('canvas_gen', 'parent-1').ahead, 0, '先来的还是头名')
    assert.equal(water.admissionQueueReport('canvas_gen').waiting, 2, '后台那份数也是整机的')
  } finally {
    await stopChild(child)
  }
  // 进程没了：靠 pid 不在立刻清掉，不用等心跳超时
  assert.equal(waitq.waitQueueSnapshot('canvas_gen').waiting, 1, '子进程退出了，它那一条要立刻消失')
  assert.equal(waitq.waitQueuePosition('canvas_gen', 'child-1'), null)
  waitq.leaveWaitQueue('canvas_gen', 'parent-1')
})

test('排队位上限是整机口径：另一个进程把位子占满，这边就进不来', async () => {
  const dir = freshDir('vq-wq-max-')
  assert.equal(waitq.joinWaitQueue('canvas_gen', 'p-1', { maxWaiting: 2 }).ok, true)
  const { child, ready } = waitInChild({ dir, ticket: 'c-1', maxWaiting: 2 })
  try {
    const joined = await ready
    assert.equal(joined.waiting, 2, '子进程那边看到整机两条')
    const refused = waitq.joinWaitQueue('canvas_gen', 'p-2', { maxWaiting: 2 })
    assert.equal(refused.ok, false)
    assert.equal(refused.full, true)
    assert.equal(refused.waiting, 2, '数的是整机两条，不是本进程一条')
    assert.equal(waitq.waitQueuePosition('canvas_gen', 'p-2'), null, '被拒的这张不占名次')
  } finally {
    await stopChild(child)
  }
  waitq.leaveWaitQueue('canvas_gen', 'p-1')
  const again = waitq.joinWaitQueue('canvas_gen', 'p-2', { maxWaiting: 2 })
  assert.equal(again.ok, true, '位子空出来就能进')
  waitq.leaveWaitQueue('canvas_gen', 'p-2')
})

test('心跳停了的 waiter 会被清掉：头名死在半路也不能把整条队堵住', () => {
  const dir = freshDir('vq-wq-stale-')
  const joined = waitq.joinWaitQueue('canvas_gen', 'stale-1', { maxWaiting: 4 })
  assert.equal(joined.position, 1)
  const files = waitersOf(dir)
  assert.equal(files.length, 1)
  const file = path.join(dir, 'waiters', files[0])
  const past = new Date(Date.now() - 30000)
  fs.utimesSync(file, past, past)
  assert.equal(waitq.waitQueueSnapshot('canvas_gen').waiting, 0, '30 秒没动静的当泄漏清掉')
  assert.equal(fs.existsSync(file), false, '文件也要删掉，别一直堆在目录里')

  // 心跳还在的那条不能被误清（2 秒 < 4 秒的过期线）
  const live = waitq.joinWaitQueue('canvas_gen', 'live-1', { maxWaiting: 4 })
  assert.equal(live.position, 1)
  const liveFiles = waitersOf(dir)
  const liveFile = path.join(dir, 'waiters', liveFiles[0])
  const recent = new Date(Date.now() - 2000)
  fs.utimesSync(liveFile, recent, recent)
  assert.equal(waitq.waitQueueSnapshot('canvas_gen').waiting, 1)
  waitq.leaveWaitQueue('canvas_gen', 'live-1')
})

test('共享目录用不了就退回进程内，并把 queueScope 如实报成 process', () => {
  const dir = freshDir('vq-wq-fallback-')
  const blocked = path.join(dir, 'not-a-dir')
  fs.writeFileSync(blocked, 'x')
  const previous = process.env.VQ_HEAVY_LEASE_DIR
  process.env.VQ_HEAVY_LEASE_DIR = blocked
  try {
    const joined = waitq.joinWaitQueue('canvas_gen', 'local-1', { maxWaiting: 4 })
    assert.equal(joined.ok, true)
    assert.equal(joined.scope, 'process', '目录用不了就退回进程内')
    assert.equal(joined.position, 1)
    const snapshot = waitq.waitQueueSnapshot('canvas_gen')
    assert.equal(snapshot.scope, 'process')
    assert.equal(snapshot.waiting, 1)
    const view = water.canvasQueueView()
    assert.equal(view.queueScope, 'process', '退回进程内这一点要写在响应里')
    assert.equal(view.waiting, 1, '退回进程内也照样看得见自己那一条')
    assert.equal(waitq.leaveWaitQueue('canvas_gen', 'local-1'), false, '共享目录里没东西，进程内那份照样划掉')
    assert.equal(waitq.waitQueueSnapshot('canvas_gen').waiting, 0)
  } finally {
    process.env.VQ_HEAVY_LEASE_DIR = previous
  }
})

test('先来先得跨进程：前面还有人在等，这轮就不去抢名额（让出去不算拒绝）', async () => {
  const dir = freshDir('vq-wq-fifo-')
  config.credits.concurrency.canvas_gen = 2
  config.credits.canvasQueue.waitMs = 1500
  config.credits.canvasQueue.maxWaiting = 8
  const { child, ready } = waitInChild({ dir, ticket: 'head-1', maxWaiting: 8 })
  try {
    const head = await ready
    assert.equal(head.position, 1)
    assert.equal(lease.heavyLeaseSnapshot(['canvas_gen']).total, 0, '起跑线：一个名额都没被占')
    const second = await water.admitWaiting('canvas_gen', { ticket: 'second-1', tickMs: 120 })
    assert.equal(second.ok, false)
    assert.equal(second.timedOut, true, '头名还在等，这一条就该一直让着')
    assert.equal(lease.heavyLeaseSnapshot(['canvas_gen']).total, 0, '让出去的时候不许偷偷占名额')
    const report = water.admissionQueueReport('canvas_gen')
    assert.ok(report.yielded > 0, '让出去记在 yielded 上：' + JSON.stringify(report))
    assert.equal(report.full, 0, '让出去不是「排满拒」')
  } finally {
    await stopChild(child)
  }
  const after = await water.admitWaiting('canvas_gen', { ticket: 'second-1', tickMs: 120 })
  assert.equal(after.ok, true, '前面没人了，立刻拿到名额')
  assert.equal(after.queued, false)
  assert.equal(after.waitedMs, 0)
  after.lease.release()
  assert.equal(lease.heavyLeaseSnapshot(['canvas_gen']).total, 0)
})

test('后台那一屏把两层口径分开写：整机的排队位 + 本进程的计数', async () => {
  const dir = freshDir('vq-wq-report-')
  const joined = waitq.joinWaitQueue('canvas_gen', 'r-1', { maxWaiting: 4 })
  assert.equal(joined.position, 1)
  const report = water.waterlineReport()
  assert.equal(report.heavy.queue.scope, 'lease')
  assert.equal(report.heavy.queue.waiting, 1)
  assert.equal(report.heavy.queue.countsScope, 'process', '排到 / 超时这些计数仍按进程算，别混着说')
  assert.equal(report.heavy.queueRegistry.shared.dir, path.join(dir, 'waiters'))
  assert.equal(report.heavy.queueRegistry.stats.joined, 1)
  waitq.leaveWaitQueue('canvas_gen', 'r-1')
  assert.equal(water.waterlineReport().heavy.queue.waiting, 0)
})
test('同一毫秒里连着登记的 6 张票：名次仍按登记顺序，不退化成按哈希排', () => {
  const dir = freshDir('vq-wq-burst-')
  const rows = []
  for (let i = 0; i < 6; i += 1) rows.push(waitq.joinWaitQueue('canvas_gen', 'burst-' + i, { maxWaiting: 8 }))
  assert.deepEqual(rows.map((row) => row.position), [1, 2, 3, 4, 5, 6])
  assert.equal(waitersOf(dir).length, 6)
  const snapshot = waitq.waitQueueSnapshot('canvas_gen')
  assert.deepEqual(snapshot.queue.map((row) => row.position), [1, 2, 3, 4, 5, 6])
})
