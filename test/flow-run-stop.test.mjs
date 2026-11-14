// 停止一条已经开跑的运行（v0.9.101）。这一组盯住四件事：
//   1) 停止信号能穿过模型链，打到真正的 fetch 上，而不是等上游自己超时；
//   2) 停止不是失败：终态 interrupted、canceled=true，不留一条假错误节点；
//   3) 钱按「已经开始的节点」结算，没跑的部分退回；重复收尾不会多退；
//   4) 路由层有一条明确的 POST /api/runs/:id/stop，流照常收到 run-end。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-run-stop-'))
process.env.VQ_KEY_SECRET = 'test-secret-run-stop'
process.env.VISION_API_KEY = ''
process.env.VQ_WATER_GUARD = '0'
process.env.VQ_RUN_QUEUE_MS = '0'
isolateLeaseDir('vq-lease-run-stop-')

const { config } = await import('../server/config.mjs')
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })
const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const flows = await import('../server/flows.mjs')
const { createKey } = await import('../server/keyvault.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const user = auth.createUser({ email: 'stop-run@example.com', password: 'Passw0rd!demo', name: '停止运行', kind: 'admin' })
const balance = () => credits.balanceOf(user.id)

let upstream = null
let releaseRequest = null
let requestSeen = null

async function startUpstream(delayMs = 1200) {
  releaseRequest = null
  requestSeen = new Promise((resolve) => { releaseRequest = resolve })
  upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      releaseRequest?.()
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ message: { content: '这句不该跑完' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }))
      }, delayMs)
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  return upstream.address().port
}

function mockReq({ method = 'POST', body = null, cookie = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = cookie ? { cookie } : {}
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body !== null) req.push(JSON.stringify(body))
  req.push(null)
  return req
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    write(chunk) { this.body += String(chunk); return true },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true },
  }
}

const sessionCookie = () => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.9.9' }).token).split(';')[0]
const stopFlow = () => [
  { id: 'in', type: 'input', data: { title: '输入', config: { text: '说一句' } } },
  { id: 'llm', type: 'llm', data: { title: '模型', config: { model: 'deepseek-flash' } } },
]

test('运行中停止：中止上游、按跑完节点结算、终态说清是用户停的', async () => {
  const port = await startUpstream()
  test.after(() => new Promise((resolve) => upstream.close(resolve)))
  createKey({
    name: '停止用例文本 Key',
    provider: 'deepseek',
    baseUrl: 'http://127.0.0.1:' + port + '/llm',
    apiKey: 'sk-test-run-stop-1234567890',
    models: ['deepseek-flash'],
    capabilities: ['text'],
    priority: 10,
    weight: 100,
  })
  const flow = await flows.createFlow({ name: '停止用例画布', nodes: stopFlow(), edges: [{ source: 'in', target: 'llm' }] }, user)
  const before = balance()
  const runId = flows.newRunId()
  await flows.startFlowRun(flow, runId, { cost: 2 })
  credits.charge(user.id, 'flow_run', { ref: runId })
  const running = flows.runFlow(flow, { runId, credits: { cost: 2 } })
  await requestSeen
  await sleep(80)

  const stopped = flows.requestRunStop(runId, { reason: 'user' })
  assert.equal(stopped.ok, true, '正在跑的运行必须能被停止')

  const run = await running
  assert.equal(run.status, 'interrupted')
  assert.equal(run.canceled, true)
  assert.match(String(run.error), /你停止了这次运行/)
  assert.equal(run.startedNodes, 2, '输入节点跑完、模型节点已经开始；正在跑的那个不算钱')
  assert.equal(run.finishedNodes, 1, '只有输入节点跑完了')
  assert.equal(run.nodes.filter((node) => node.status === 'error').length, 0, '用户停止不该留一条假错误节点')
  assert.equal(run.credits.cost, 2)
  assert.equal(run.credits.kept, 1, '2 个节点、跑完 1 个：留下 1 积分')
  assert.equal(run.credits.refundedAmount, 1)
  assert.equal(run.credits.settled, true)
  assert.equal(balance(), before - 1, '没跑的那一半要退回')

  const saved = await flows.getRun(runId, user)
  assert.equal(saved.status, 'interrupted')
  assert.equal(saved.credits.kept, 1)
  const refundRows = credits.ledgerOf(user.id, 20).filter((row) => row.kind === 'flow_run-refund' && row.ref === runId)
  assert.equal(refundRows.length, 1)
  assert.equal(refundRows.reduce((sum, row) => sum + Number(row.delta), 0), 1)

  // 收尾再跑一次也不能多退：停止路径已经结过账
  assert.equal(flows.refundRunCredits(saved), 0)
  assert.equal(balance(), before - 1)
})

test('路由：POST /api/runs/:id/stop 停止流式运行，页面仍然拿到 run-end', async () => {
  const port = await startUpstream(1200)
  test.after(() => new Promise((resolve) => upstream.close(resolve)))
  createKey({
    name: '停止路由文本 Key',
    provider: 'deepseek',
    baseUrl: 'http://127.0.0.1:' + port + '/llm',
    apiKey: 'sk-test-run-stop-route-1234567890',
    models: ['deepseek-flash'],
    capabilities: ['text'],
    priority: 9,
    weight: 100,
  })
  const flow = await flows.createFlow({ name: '停止路由用例', nodes: stopFlow(), edges: [{ source: 'in', target: 'llm' }] }, user)
  const router = createFlowsRouter()
  const before = balance()
  const res = mockRes()
  const target = '/api/flows/' + flow.id + '/run'
  const pending = router.handle(
    mockReq({ cookie: sessionCookie(), headers: { 'content-type': 'application/json' }, body: { stream: true } }),
    res,
    new URL('http://127.0.0.1' + target),
    target,
  )
  await requestSeen
  await sleep(120)
  const start = res.body.trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.type === 'run-start')
  assert.ok(start?.run?.id, '流里要能拿到 run id，页面才有停止的凭据')

  const stopRes = mockRes()
  const stopTarget = '/api/runs/' + start.run.id + '/stop'
  const handled = await router.handle(mockReq({ cookie: sessionCookie() }), stopRes, new URL('http://127.0.0.1' + stopTarget), stopTarget)
  assert.equal(handled, true)
  assert.equal(stopRes.statusCode, 200)
  assert.equal(JSON.parse(stopRes.body).ok, true)

  await pending
  const lines = res.body.trim().split('\n').map((line) => JSON.parse(line))
  const end = lines.find((event) => event.type === 'run-end')
  assert.ok(end, '停止也要把 run-end 推回来，页面不能一直等')
  assert.equal(end.run.status, 'interrupted')
  assert.equal(end.run.canceled, true)
  assert.equal(end.run.credits.kept, 1)
  assert.equal(end.run.credits.refundedAmount, 1)
  assert.equal(balance(), before - 1)
})
