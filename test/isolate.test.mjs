// 重活隔离池（v0.9.77）：worker 撞上限或超时只杀它自己，池补一个新的；并发受 size 限制。
// 这组测试不碰模型、不联网：worker 入口在临时目录里现写，测的是隔离层本身。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { IsolateError, WorkerPool, isolateStatus, resetIsolateStats, reviewIsolateConfig, runInWorker } from '../server/isolate.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-isolate-'))
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

const source = [
  "import { parentPort } from 'node:worker_threads'",
  'parentPort.on("message", async (message) => {',
  '  if (!message || message.type !== "job") return',
  '  const { id, payload } = message',
  '  const mode = payload && payload.mode',
  '  if (mode === "hog") {',
  '    const chunks = []',
  '    for (let i = 0; i < 400; i += 1) chunks.push(new Array(131072).fill(i))',
  '    parentPort.postMessage({ type: "done", id, result: { chunks: chunks.length } })',
  '    return',
  '  }',
  '  if (mode === "hang") { await new Promise((r) => setTimeout(r, 5000)); parentPort.postMessage({ type: "done", id, result: { ok: true } }); return }',
  '  if (mode === "fail") { parentPort.postMessage({ type: "error", id, message: "上游说不行", code: "MEDIA_TOO_LARGE", status: 413 }); return }',
  '  if (mode === "delay") {',
  '    const started = Date.now()',
  '    await new Promise((r) => setTimeout(r, payload.ms || 100))',
  '    parentPort.postMessage({ type: "done", id, result: { started, ended: Date.now() } })',
  '    return',
  '  }',
  '  parentPort.postMessage({ type: "log", id, message: "收到任务" })',
  '  parentPort.postMessage({ type: "done", id, result: { echo: payload } })',
  '})',
].join('\n')
const file = path.join(dir, 'multi.mjs')
fs.writeFileSync(file, source)
const ENTRY = pathToFileURL(file)

test('正常回话：payload 原样进去，结果原样出来，日志能转发', async () => {
  const logs = []
  const result = await runInWorker(ENTRY, { n: 3, text: '评审一张图' }, { onLog: (m) => logs.push(m), timeoutMs: 10000 })
  assert.deepEqual(result, { echo: { n: 3, text: '评审一张图' } })
  assert.deepEqual(logs, ['收到任务'])
})

test('worker 撞到 64 MB 上限：只杀它自己，调用方拿到可读错误', async () => {
  await assert.rejects(
    () => runInWorker(ENTRY, { mode: 'hog' }, { heapMb: 64, timeoutMs: 30000 }),
    (error) => {
      assert.ok(error instanceof IsolateError)
      assert.equal(error.code, 'REVIEW_WORKER_OOM')
      assert.match(error.message, /64 MB/)
      return true
    },
  )
})

test('超时直接收掉：504 语义，不会一直挂住请求', async () => {
  const started = Date.now()
  await assert.rejects(
    () => runInWorker(ENTRY, { mode: 'hang' }, { heapMb: 128, timeoutMs: 400 }),
    (error) => {
      assert.ok(error instanceof IsolateError)
      assert.equal(error.code, 'REVIEW_TIMEOUT')
      assert.equal(error.status, 504)
      return true
    },
  )
  assert.ok(Date.now() - started < 4000, '要真的提前收掉，不是等它自己跑完')
})

test('worker 内部报错：保留状态码与 code，前端能按它提示', async () => {
  await assert.rejects(
    () => runInWorker(ENTRY, { mode: 'fail' }, { timeoutMs: 10000 }),
    (error) => {
      assert.equal(error.code, 'MEDIA_TOO_LARGE')
      assert.equal(error.status, 413)
      assert.match(error.message, /上游说不行/)
      return true
    },
  )
})

test('池有上限：5 单排队，同一时刻最多 2 个在跑，结果一条不少', async () => {
  const pool = new WorkerPool(ENTRY, { size: 2, heapMb: 128, timeoutMs: 20000 })
  try {
    const tasks = Array.from({ length: 5 }, () => pool.run({ mode: 'delay', ms: 200 }))
    const busy = pool.stats()
    assert.equal(busy.size, 2)
    assert.ok(busy.queued >= 1, '超出的单子要排队，实际排队 ' + busy.queued)
    const results = await Promise.all(tasks)
    assert.equal(results.length, 5)
    // 用每单的起止时间算最大重叠：池的上限必须兜住
    const events = []
    for (const item of results) {
      events.push([item.started, 1], [item.ended, -1])
    }
    events.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
    let current = 0
    let peak = 0
    for (const [, delta] of events) { current += delta; peak = Math.max(peak, current) }
    assert.ok(peak <= 2, '同时最多 2 个，实际 ' + peak)
  } finally {
    pool.close()
  }
})

test('一单把 worker 撞死后，池补一个新 worker，下一单照常跑', async () => {
  const pool = new WorkerPool(ENTRY, { size: 1, heapMb: 64, timeoutMs: 20000 })
  try {
    await assert.rejects(() => pool.run({ mode: 'hog' }), (error) => error.code === 'REVIEW_WORKER_OOM')
    const after = await pool.run({ ok: true })
    assert.deepEqual(after, { echo: { ok: true } })
    assert.equal(pool.stats().alive, 1, '撞死之后要补一个新的回来')
  } finally {
    pool.close()
  }
})

test('开关与池规格走环境变量：默认开，VQ_REVIEW_ISOLATE=0 可退回同进程', () => {
  const normal = reviewIsolateConfig({})
  assert.equal(normal.enabled, true)
  assert.equal(normal.heapMb, 192)
  assert.equal(normal.workers, 3)
  assert.equal(reviewIsolateConfig({ VQ_REVIEW_ISOLATE: '0' }).enabled, false)
  assert.equal(reviewIsolateConfig({ VQ_REVIEW_WORKER_MB: '96' }).heapMb, 96)
  assert.equal(reviewIsolateConfig({ VQ_REVIEW_WORKERS: '2' }).workers, 2)
  // 乱填不能把上限放到天花板上，也不能小到起不来
  assert.equal(reviewIsolateConfig({ VQ_REVIEW_WORKER_MB: '99999' }).heapMb, 1024)
  assert.equal(reviewIsolateConfig({ VQ_REVIEW_WORKER_MB: 'abc' }).heapMb, 192)
  assert.equal(reviewIsolateConfig({ VQ_REVIEW_WORKERS: '99' }).workers, 8)
  assert.equal(reviewIsolateConfig({ VQ_REVIEW_WORKERS: '0' }).workers, 1)
})

test('计数只给数字：跑过几次、失败几次，不暴露请求内容', async () => {
  resetIsolateStats()
  const empty = isolateStatus({})
  assert.equal(empty.runs, 0)
  assert.equal(empty.enabled, true)
  assert.equal(empty.pool.size, 3)
  assert.deepEqual(Object.keys(empty).sort(), ['enabled', 'failed', 'heapMb', 'lastFailure', 'ok', 'pool', 'runs', 'timeoutMs', 'workers'])
  await runInWorker(ENTRY, { ok: true }, { timeoutMs: 10000 })
  assert.equal(isolateStatus({}).runs, 0)
})
