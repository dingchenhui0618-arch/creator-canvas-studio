// 运行水位（v0.9.69）。这一组盯住五件事：
//   1) 判定是纯函数：给定两个读数与四个阈值就能算出等级，不依赖跑测试这台机器的内存；
//   2) 阈值写 0 等于关掉那一条：运营不想拦的时候，闸门不会偷偷生效；
//   3) 偏紧只收紧重活：复刻/评审/画布运行降到 1 条，检索与对话不受影响；
//   4) 到红线在扣费前拒绝：503 + MEMORY_PRESSURE + 「没有扣积分」，生产口径不带内部读数；
//   5) 后台只读：非管理员 403，管理员能读到真实读数，没有任何写入入口。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-water-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-waterline'
// 跨进程租约（v0.9.78）：测试文件并行跑，名额必须各算各的
isolateLeaseDir('vq-lease-waterline-')

const { config } = await import('../server/config.mjs')
const water = await import('../server/waterline.mjs')
const auth = await import('../server/auth.mjs')
const { listAlerts } = await import('../server/alerts.mjs')
const { createAdminRouter } = await import('../server/routes/admin.mjs')

const admin = auth.createUser({ email: '[EMAIL:WATER1]', password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })
const plain = auth.createUser({ email: '[EMAIL:WATER2]', password: 'Passw0rd!demo', name: '普通账号', kind: 'user' })
const adminCookie = auth.sessionCookie(auth.createSession(admin, { userAgent: 'test', ip: '10.0.3.1' }).token).split(';')[0]
const plainCookie = auth.sessionCookie(auth.createSession(plain, { userAgent: 'test', ip: '10.0.3.2' }).token).split(';')[0]

const LIMITS = { guard: true, tightAvailableMb: 320, criticalAvailableMb: 128, tightHeapPercent: 80, criticalHeapPercent: 92 }

// 阈值与模式都是进程级单例：每次动过都要还原，免得污染后面的用例
function withWaterline(patch, run) {
  const previous = { ...config.waterline }
  const mode = config.ui.mode
  try {
    Object.assign(config.waterline, patch)
    return run()
  } finally {
    Object.assign(config.waterline, previous)
    config.ui.mode = mode
  }
}

test('判定：三档只看可用内存与堆占比，两个都不够才是临界', () => {
  assert.equal(water.assessWaterline({ memory: { availableMb: 900 }, heap: { heapPercent: 20, heapLimitMb: 384 } }, LIMITS).level, 'ok')
  const tight = water.assessWaterline({ memory: { availableMb: 200 }, heap: { heapPercent: 30, heapLimitMb: 384 } }, LIMITS)
  assert.equal(tight.level, 'tight')
  assert.match(tight.reasons.join('；'), /低于警戒线 320 MB/)
  const lowMem = water.assessWaterline({ memory: { availableMb: 64 }, heap: { heapPercent: 10, heapLimitMb: 384 } }, LIMITS)
  assert.equal(lowMem.level, 'critical')
  assert.match(lowMem.reasons.join('；'), /低于红线 128 MB/)
  const fullHeap = water.assessWaterline({ memory: { availableMb: 900 }, heap: { heapPercent: 95, heapLimitMb: 384 } }, LIMITS)
  assert.equal(fullHeap.level, 'critical')
  assert.match(fullHeap.reasons.join('；'), /堆已用 95%/)
})

test('阈值写 0 等于关掉那一条，不会因为空值把闸门关掉', () => {
  const off = { guard: true, tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 }
  assert.equal(water.assessWaterline({ memory: { availableMb: 1 }, heap: { heapPercent: 99 } }, off).level, 'ok')
  // 只关一条时另一条照旧生效
  const half = { ...off, criticalHeapPercent: 92 }
  assert.equal(water.assessWaterline({ memory: { availableMb: 1 }, heap: { heapPercent: 95 } }, half).level, 'critical')
})

test('偏紧只收紧重活：复刻 2 → 1，不限也收紧到 1，检索与对话不动', () => {
  assert.equal(water.capacityFor('replicate', 2, 'ok'), 2)
  assert.equal(water.capacityFor('replicate', 2, 'tight'), 1)
  assert.equal(water.capacityFor('replicate', 0, 'tight'), 1)
  assert.equal(water.capacityFor('flow_run', 4, 'tight'), 1)
  assert.equal(water.capacityFor('search', 1, 'tight'), 1)
  assert.equal(water.capacityFor('chat', 2, 'tight'), 2)
  // 到红线时重活一条都不放：后台那一屏和入口的行为要一致
  assert.equal(water.capacityFor('replicate', 2, 'critical'), 0)
})

test('读数：来自真实系统与真实 V8 堆，不是编的', () => {
  const memory = water.readMemoryFacts()
  assert.ok(memory.totalMb > 0)
  assert.ok(memory.availableMb > 0)
  assert.ok(['proc', 'os'].includes(memory.source))
  assert.ok(memory.swapUsedMb >= 0)
  const heap = water.readHeapFacts()
  assert.ok(heap.heapLimitMb > 0, '堆上限要来自 V8 的真实值')
  assert.ok(heap.heapPercent >= 0)
  const report = water.waterlineReport()
  assert.equal(report.ok, true)
  assert.ok(['ok', 'tight', 'critical'].includes(report.level))
  assert.deepEqual(report.heavyKinds, ['replicate', 'review', 'flow_run', 'canvas_gen'])
  // 按类型的整机上限只给「没有账号可挂」的画布出图用（v0.9.79），其余仍靠每账号上限
  assert.equal(water.kindLimitFor('canvas_gen', 'ok', true), 2)
  assert.equal(water.kindLimitFor('review', 'ok', true), 0, '评审是每账号 1 条 + 整机 3 条，不该再叠一层整机 1 条')
  // 这一屏的数字跟着当前水位走（偏紧时会从 2 收紧到 1）：断言「同一套公式算出来的」
  assert.equal(report.heavy.kindLimits.canvas_gen, water.capacityFor('canvas_gen', config.credits.concurrency.canvas_gen, report.level))
  assert.equal(report.retryAfterSec, 60)
  assert.equal(report.thresholds.criticalAvailableMb, 128)
  assert.equal(report.thresholds.tightAvailableMb, 320)
  for (const kind of report.heavyKinds) {
    assert.equal(typeof report.capacity[kind], 'number')
    assert.equal(typeof report.baseCapacity[kind], 'number')
  }
  // 全站重活在跑几条：真实计数（不是任务表里的历史行），默认上限 3 条
  assert.equal(typeof report.heavy.active, 'number')
  assert.equal(report.heavy.configLimit, 3)
  // 上限会随水位收紧（偏紧时 3 → 2）：这一屏要说的是「现在会按几条放行」，不是配置原值
  assert.equal(report.heavy.limit, water.globalHeavyCap(report.level))
  assert.equal(report.heavy.unlimited, report.heavy.limit === 0)
  assert.equal(report.heavy.scope, 'lease')
  // 排队位（v0.9.80 起是画布出图，v0.9.95 起评审也排）：这两类各有一条整机的队
  assert.equal(report.heavy.queue.kind, 'canvas_gen')
  assert.equal(report.heavy.queue.waitMs, config.credits.canvasQueue.waitMs)
  assert.equal(report.heavy.queue.maxWaiting, config.credits.canvasQueue.maxWaiting)
  assert.equal(report.heavy.queue.waiting, 0)
  // v0.9.95 之前这里断言「评审不排队，客户端自己重试更合适」；评审是主付费动作，改成它也排：
  // 每条最多等 60 秒、最多 4 条同时排（整机口径）。v0.9.96 起运行（flow_run）也进来，同一档参数。
  assert.equal(water.queueLimitsFor('review').waitMs, config.credits.reviewQueue.waitMs)
  assert.equal(water.queueLimitsFor('review').maxWaiting, config.credits.reviewQueue.maxWaiting)
  assert.equal(water.admissionQueueReport('review').waiting, 0)
  assert.equal(water.queueLimitsFor('replicate').waitMs, 0, '复刻仍然不排队：有账号的调用方自己重试')
  assert.equal(water.queueLimitsFor('flow_run').waitMs, config.credits.runQueue.waitMs, 'v0.9.96 起运行也排队')
  assert.equal(water.admissionQueueReport('flow_run').waiting, 0)
})

test('到红线：重活被拒且说清没扣积分，轻活照常，生产口径不带内部读数', async () => {
  water.resetWaterlineAlert()
  await withWaterline({ criticalAvailableMb: 10 ** 9, criticalHeapPercent: 0 }, async () => {
    const refusal = water.admit('replicate')
    assert.equal(refusal.ok, false)
    assert.equal(refusal.status, 503)
    assert.equal(refusal.body.code, 'MEMORY_PRESSURE')
    assert.equal(refusal.body.retryAfterSec, 60)
    assert.match(refusal.body.error, /没有扣积分/)
    assert.equal(refusal.body.availableMb, undefined, '生产口径不把内部读数带出去')
    // 轻活不跟着拦
    assert.equal(water.admit('search').ok, true)
    assert.equal(water.admit('chat').ok, true)
    // 内部环境才给判据，排障用
    config.ui.mode = 'internal'
    const internal = water.admit('review')
    assert.equal(internal.ok, false)
    assert.ok(Array.isArray(internal.body.reasons) && internal.body.reasons.length > 0)
  })
})

test('到红线会进站内告警，且同一段时间不刷屏', async () => {
  water.resetWaterlineAlert()
  await withWaterline({ criticalAvailableMb: 10 ** 9 }, async () => {
    water.admit('flow_run')
    water.admit('flow_run')
  })
  // 告警是异步落盘的：等它写完再看
  await new Promise((resolve) => setTimeout(resolve, 300))
  const items = await listAlerts({})
  const memory = items.filter((item) => item.kind === 'memory')
  assert.equal(memory.length, 1, '同一条红线只记一条，不按每次拒绝刷屏')
  assert.match(memory[0].title, /内存/)
})

test('全站重活上限：跨账号合计满了就拒，放手后立刻放行，写 0 等于不限', async () => {
  const previous = config.credits.globalHeavy
  try {
    config.credits.globalHeavy = 1
    // 另一个账号正在复刻：整机名额被它占着（v0.9.78 起是一份跨进程租约，不是进程内计数）
    const held = water.admit('replicate')
    assert.equal(held.ok, true)
    assert.equal(held.scope, 'lease')
    try {
      const refusal = water.admit('replicate')
      assert.equal(refusal.ok, false)
      assert.equal(refusal.status, 503)
      assert.equal(refusal.body.code, 'SERVER_BUSY')
      assert.equal(refusal.body.active, 1)
      assert.equal(refusal.body.limit, 1)
      assert.equal(refusal.body.retryAfterSec, 60)
      assert.match(refusal.body.error, /没有扣积分/)
      // 轻活不跟着拦：检索只是转发一个 HTTP
      assert.equal(water.admit('search').ok, true)
      assert.equal(water.admit('chat').ok, true)
      const report = water.waterlineReport()
      assert.equal(report.heavy.active, 1)
      assert.equal(report.heavy.byKind.replicate, 1)
      assert.equal(report.heavy.full, true)
      // 这一屏数的是整机（两个实例共用），不是本进程
      assert.equal(report.heavy.scope, 'lease')
      assert.equal(report.heavy.lease.enabled, true)
      assert.equal(typeof report.heavy.lease.dir, 'string')
    } finally {
      held.lease.release()
    }
    // 那条活跑完，立刻能接新的
    const again = water.admit('replicate')
    assert.equal(again.ok, true)
    again.lease.release()
    assert.equal(water.waterlineReport().heavy.full, false)
    // 写 0 = 不限：这一层整个不生效（改配置就恢复旧行为），但在跑几条照样数得出来
    config.credits.globalHeavy = 0
    const free = water.admit('flow_run')
    assert.equal(free.ok, true)
    try {
      assert.equal(water.waterlineReport().heavy.unlimited, true)
      assert.equal(water.waterlineReport().heavy.active, 1)
    } finally {
      free.lease.release()
    }
  } finally {
    config.credits.globalHeavy = previous
  }
})

test('全站上限随水位收紧：偏紧 2 条，配置更严时听配置，红线回 0', () => {
  const previous = config.credits.globalHeavy
  try {
    config.credits.globalHeavy = 5
    assert.equal(water.globalHeavyCap('ok'), 5)
    assert.equal(water.globalHeavyCap('tight'), 2)
    assert.equal(water.globalHeavyCap('critical'), 0)
    config.credits.globalHeavy = 1
    assert.equal(water.globalHeavyCap('tight'), 1)
    config.credits.globalHeavy = 0
    assert.equal(water.globalHeavyCap('ok'), 0)
  } finally {
    config.credits.globalHeavy = previous
  }
})

test('守卫可以整条关掉：只量不拦', async () => {
  await withWaterline({ guard: false, criticalAvailableMb: 10 ** 9 }, async () => {
    // 守卫关掉时只量不拦：名额照样占（后台看得见），只是不看水位也不看上限
    const free = water.admit('replicate')
    assert.equal(free.ok, true)
    try {
      const report = water.waterlineReport()
      assert.equal(report.guard, false)
      // 关掉的是「拦」，等级照样如实报出来；并发不折算，如实显示会放行几条
      assert.equal(report.level, 'critical')
      assert.equal(report.capacity.replicate, report.baseCapacity.replicate)
      assert.equal(report.heavy.limit, 0)
    } finally {
      free.lease.release()
    }
  })
})

function mockReq({ method = 'GET', cookie = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = cookie ? { cookie } : {}
  req.socket = { remoteAddress: '127.0.0.1' }
  req.push(null)
  return req
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    write(chunk) {
      this.body += String(chunk)
      return true
    },
    end(chunk) {
      if (chunk) this.body += String(chunk)
      this.writableEnded = true
    },
  }
}

const call = async (router, req, pathname) => {
  const res = mockRes()
  // 和真实服务器一致：参数里带查询串，pathname 是不带查询串的那一段
  const url = new URL('http://127.0.0.1' + pathname)
  await router.handle(req, res, url, url.pathname)
  return res
}

test('后台预检：和真实请求同一个判定，占到的名额立刻还回去', async () => {
  const router = createAdminRouter()
  const previous = config.credits.globalHeavy
  try {
    config.credits.globalHeavy = 1
    const held = water.admit('review')
    try {
      const busy = await call(router, mockReq({ cookie: adminCookie }), '/api/admin/waterline/admission?kind=review')
      assert.equal(busy.statusCode, 200)
      const payload = JSON.parse(busy.body)
      assert.equal(payload.ok, false)
      assert.equal(payload.code, 'SERVER_BUSY')
      assert.equal(payload.active, 1)
      assert.equal(payload.limit, 1)
      assert.equal(payload.scope, 'lease')
      assert.equal(typeof payload.ms, 'number')
    } finally {
      held.lease.release()
    }
    const free = await call(router, mockReq({ cookie: adminCookie }), '/api/admin/waterline/admission?kind=review')
    assert.equal(free.statusCode, 200)
    const payload = JSON.parse(free.body)
    assert.equal(payload.ok, true)
    // 预检占的名额必须还回去：否则每查一次就少一个名额
    assert.equal(payload.active, 0)
    assert.equal(water.waterlineReport().heavy.active, 0)
    // 只认三种重活：检索不占名额，问它没有意义
    const bad = await call(router, mockReq({ cookie: adminCookie }), '/api/admin/waterline/admission?kind=search')
    assert.equal(bad.statusCode, 400)
  } finally {
    config.credits.globalHeavy = previous
  }
})

test('后台只读：非管理员 403，管理员读到真实读数，没有写入入口', async () => {
  const router = createAdminRouter()
  const denied = await call(router, mockReq({ cookie: plainCookie }), '/api/admin/waterline')
  assert.equal(denied.statusCode, 403)

  const read = await call(router, mockReq({ cookie: adminCookie }), '/api/admin/waterline')
  assert.equal(read.statusCode, 200)
  const payload = JSON.parse(read.body)
  assert.equal(payload.ok, true)
  assert.ok(payload.memory.availableMb > 0)
  assert.ok(payload.heap.heapLimitMb > 0)
  assert.ok(payload.cpu.cores >= 1)
  assert.equal(typeof payload.thresholds.tightAvailableMb, 'number')

  // 阈值不接受后台改写：PUT 走到的是别的分支，不会改到运行水位（这条路本来就不存在）
  const put = await call(router, mockReq({ method: 'PUT', cookie: adminCookie }), '/api/admin/waterline')
  assert.notEqual(put.statusCode, 200)
})