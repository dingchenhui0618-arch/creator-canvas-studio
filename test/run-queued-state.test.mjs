// 运行记录不再把「排队中 / 运行中」说成失败（v0.9.98）。
// v0.9.96 起运行也能排队，但记录一开始就写成 running：运行记录页把所有非成功都画成红点 +「失败」，
// 于是排队中的一条、正在跑的一条，看起来都像已经失败并且退了钱。这一组盯住四件事：
//   1) 排队单先落 queued，排到、扣完费才翻 running，翻过的不再改开始时间；
//   2) 排队单没扣钱：启动恢复直接撤掉，不留一条永远「排队中」的行；
//   3) 极端时序（扣了钱但还没翻状态就被杀）：恢复按账本退回，再撤记录；
//   4) 路由层：排队期间 GET /api/runs 看得到这条 queued 记录，且不会被「失败」筛选命中；
//      排到之后同一条记录跑完是 success，钱只扣一次。
// 假上游不参与：这一组跑的是 output 节点和排队，一次模型调用都不发。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-run-queued-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-run-queued'
process.env.VQ_RUN_QUEUE_MS = '6000'
process.env.VQ_RUN_QUEUE_MAX = '4'
process.env.VISION_API_KEY = ''
isolateLeaseDir('vq-lease-run-queued-')

const { config } = await import('../server/config.mjs')
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })
const water = await import('../server/waterline.mjs')
const lease = await import('../server/heavy-lease.mjs')
const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const flows = await import('../server/flows.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const user = auth.createUser({ email: '[EMAIL:8M2Q4R]', password: 'Passw0rd!demo', name: '排队记录', kind: 'admin' })
const balance = () => credits.balanceOf(user.id)

async function until(check, ms, what) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) assert.fail('等了 ' + ms + 'ms 还没出现：' + what)
    await sleep(60)
  }
}

/** 把整机三条重活名额占满（占满才有得排）。返回放掉它们的函数。 */
async function holdFullCap(kind = 'flow_run') {
  const held = []
  for (let i = 0; i < 3; i += 1) {
    const got = lease.acquireHeavyLease(kind, { limit: 3, kindLimit: 0 })
    assert.equal(got.ok, true, '第 ' + (i + 1) + ' 条名额应该拿得到')
    held.push(got.lease)
  }
  return () => { for (const item of held) { try { item.release() } catch { /* 已经放掉 */ } } }
}

function mockReq({ method = 'GET', body = null, cookie = '', headers = {} } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = { ...(cookie ? { cookie } : {}), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body !== null) req.push(JSON.stringify(body))
  req.push(null)
  return req
}

function mockRes() {
  const emitter = new EventEmitter()
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    on(name, fn) { emitter.on(name, fn); return res },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    write(chunk) { this.body += String(chunk); return true },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true },
    destroy() { this.destroyed = true; emitter.emit('close') },
  }
  res.abort = () => { emitter.emit('close') }
  return res
}

const cookieOf = () => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.9.2' }).token).split(';')[0]
const outputFlow = () => flows.createFlow({ name: '排队记录画布', nodes: [{ id: 'out', type: 'output', data: { title: '输出', config: {} } }], edges: [] }, user)

test('排队单先写 queued：排到扣完费才翻 running，翻过的不再改开始时间', async () => {
  const flow = await outputFlow()
  const runId = flows.newRunId()
  await flows.startFlowRun(flow, runId, { cost: 2, queued: true })
  const queued = await flows.getRun(runId, user)
  assert.equal(queued.status, 'queued', '排队期间记录必须写排队中，不能先写 running')
  assert.ok(queued.queuedAt, '排队单要记下从哪一刻开始等')
  assert.equal(queued.credits.cost, 2, '记录里写着这一单要花多少，但钱还没扣')

  // 故意等一小段：翻状态后的开始时间必须晚于排队时间，页面的「排队 Ns」才有意义
  await sleep(80)
  const started = await flows.markRunStarted(runId)
  assert.equal(started.status, 'running')
  assert.ok(Date.parse(started.startedAt) >= Date.parse(queued.queuedAt))
  assert.ok(started.queuedMs >= 70, '排队时长 ' + started.queuedMs + 'ms')

  const again = await flows.markRunStarted(runId)
  assert.equal(again.startedAt, started.startedAt, '已经翻过的记录不能把开始时间往后推')
  await flows.abandonRun(runId, '用例收尾')
  assert.equal((await flows.getRun(runId, user)).status, 'error')
})

test('启动恢复撤掉排队单：没扣钱、也不留一条永远排队中的行', async () => {
  await flows.recoverInterruptedRuns()
  const flow = await outputFlow()
  const runId = flows.newRunId()
  await flows.startFlowRun(flow, runId, { cost: 2, queued: true })
  const result = await flows.recoverInterruptedRuns()
  assert.equal(result.dropped, 1, '排队单要撤掉')
  assert.equal(result.refunded, 0, '没扣过钱就没有退款')
  assert.equal(await flows.getRun(runId, user), null, '记录里不能留下这条排队单')
  const again = await flows.recoverInterruptedRuns()
  assert.equal(again.dropped, 0, '重复恢复不会多撤')
})

test('排队单已经扣了钱（极端时序）：恢复按账本退回，再撤记录', async () => {
  await flows.recoverInterruptedRuns()
  const flow = await outputFlow()
  const runId = flows.newRunId()
  await flows.startFlowRun(flow, runId, { cost: 2, queued: true })
  credits.charge(user.id, 'flow_run', { ref: runId })
  const charged = balance()
  const result = await flows.recoverInterruptedRuns()
  assert.equal(result.dropped, 1)
  assert.equal(result.refunded, 1)
  assert.equal(balance(), charged + 2, '钱要原路退回')
  assert.equal(await flows.getRun(runId, user), null)
})

test('路由：排队期间运行记录里看得到「排队中」，排到之后同一条跑成 success', async () => {
  await flows.recoverInterruptedRuns()
  const flow = await outputFlow()
  const router = createFlowsRouter()
  const before = balance()
  const release = await holdFullCap()
  const res = mockRes()
  const target = '/api/flows/' + flow.id + '/run'
  const pending = router.handle(
    mockReq({
      method: 'POST',
      cookie: cookieOf(),
      headers: { 'content-type': 'application/json', 'x-vq-queue-ticket': 'run-record-queued' },
      body: { stream: true },
    }),
    res,
    new URL('http://127.0.0.1' + target),
    target,
  )
  try {
    let queuedRow = null
    await until(async () => {
      const list = await flows.listRuns({ flowId: flow.id }, user)
      queuedRow = list.items.find((item) => item.status === 'queued') || null
      return Boolean(queuedRow)
    }, 4000, '运行记录里出现一条排队中的单')
    assert.ok(queuedRow.queuedAt, '页面要能按它算「排队多少秒」')
    assert.equal(balance(), before, '排队期间一分钱都不扣')
    // 「失败」筛选不能命中排队单：它没失败、也没退过钱
    const failed = await flows.listRuns({ flowId: flow.id, status: 'error' }, user)
    assert.equal(failed.items.some((item) => item.id === queuedRow.id), false)

    release()
    await pending
    assert.equal(res.statusCode, 200, '排到之后正常跑完')
    assert.match(String(res.headers['x-vq-queue-position'] || ''), /^\d+$/, '排到之后要带出名次')
    const finished = await flows.getRun(queuedRow.id, user)
    assert.equal(finished.status, 'success', '同一条记录跑完是成功，不是失败')
    assert.equal(finished.nodes.length, 1)
    assert.equal(balance(), before - 2, '排到之后才扣 2 积分，只扣一次')
    const rows = credits.ledgerOf(user.id, 30).filter((row) => row.kind === 'flow_run' && row.ref === queuedRow.id)
    assert.equal(rows.length, 1, '这次运行只有一张扣费单')
    assert.equal(water.queueView('flow_run').waiting, 0, '跑完队里清零')
  } finally {
    release()
    const leftover = await Promise.race([pending, sleep(50).then(() => null)])
    if (leftover && leftover.lease) leftover.lease.release()
  }
})
