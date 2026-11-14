// 停止之后接着跑（v0.9.102）。这一组盯住三件事：
//   1) 已经跑完的节点不重新调上游，结果原样复用；
//   2) 钱只补「上次没付的那部分」，不会按全价再收一次；
//   3) 路由层接 resumeOf，页面仍然拿得到 run-end 与新运行的 id。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-run-resume-'))
process.env.VQ_KEY_SECRET = 'test-secret-run-resume'
process.env.VISION_API_KEY = ''
process.env.VQ_WATER_GUARD = '0'
process.env.VQ_RUN_QUEUE_MS = '0'
isolateLeaseDir('vq-lease-run-resume-')

const { config } = await import('../server/config.mjs')
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })
const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const flows = await import('../server/flows.mjs')
const { createKey } = await import('../server/keyvault.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const user = auth.createUser({ email: '[EMAIL:D7M2QQ]', password: 'Passw0rd!demo', name: '续跑用例', kind: 'admin' })
const balance = () => credits.balanceOf(user.id)

let upstream = null
let releaseRequest = null
let requestSeen = null
let calls = 0

async function waitForCalls(target, timeoutMs = 5000) {
  const started = Date.now()
  while (calls < target) {
    if (Date.now() - started > timeoutMs) throw new Error('等上游调用超时：期望 ' + target + ' 次，实际 ' + calls + ' 次')
    await sleep(10)
  }
}

async function startUpstream(delayMs = 350) {
  releaseRequest = null
  requestSeen = new Promise((resolve) => { releaseRequest = resolve })
  upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      calls += 1
      releaseRequest?.()
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ message: { content: '续跑补上的这一句' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
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

const sessionCookie = () => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', userAgentData: null, ip: '10.0.9.10' }).token).split(';')[0]
const resumeFlow = () => [
  { id: 'in', type: 'input', data: { title: '输入', config: { text: '先写一句' } } },
  { id: 'llm', type: 'llm', data: { title: '模型', config: { model: 'deepseek-flash' } } },
]

test('续跑：复用已跑节点、只补没付的部分、余额一共只扣两次该扣的钱', async () => {
  const port = await startUpstream()
  test.after(() => new Promise((resolve) => upstream.close(resolve)))
  createKey({
    name: '续跑用例文本 Key',
    provider: 'deepseek',
    baseUrl: 'http://127.0.0.1:' + port + '/llm',
    apiKey: 'sk-test-run-resume-1234567890',
    models: ['deepseek-flash'],
    capabilities: ['text'],
    priority: 10,
    weight: 100,
  })
  const flow = await flows.createFlow({ name: '续跑用例画布', nodes: resumeFlow(), edges: [{ source: 'in', target: 'llm' }] }, user)
  const before = balance()

  // 第一次：跑完输入节点，模型节点还在等上游时停掉
  const firstId = flows.newRunId()
  await flows.startFlowRun(flow, firstId, { cost: 2 })
  credits.charge(user.id, 'flow_run', { ref: firstId })
  const firstRunning = flows.runFlow(flow, { runId: firstId, credits: { cost: 2 } })
  await requestSeen
  await sleep(60)
  assert.equal(flows.requestRunStop(firstId, { reason: 'user' }).ok, true)
  const first = await firstRunning
  assert.equal(first.status, 'interrupted')
  assert.equal(first.finishedNodes, 1)
  assert.equal(first.credits.kept, 1)
  assert.equal(balance(), before - 1)
  assert.equal(calls, 1, '第一次只该调一次上游')

  // 第二次：只补模型节点，不再调输入节点
  const seed = flows.resumeSeedFor(first, flow)
  assert.equal(seed.reusedCount, 1)
  assert.equal(seed.results.get('in')?.status, 'success')
  assert.equal(seed.edgeActive.get(flow.edges[0].id), true)
  const secondId = flows.newRunId()
  await flows.startFlowRun(flow, secondId, {
    cost: 1,
    resumeOf: first.id,
    reusedNodes: seed.reusedCount,
    billTotal: flow.nodes.length - seed.reusedCount,
    flowRevision: flows.flowRevisionOf(flow),
  })
  credits.charge(user.id, 'flow_run', { ref: secondId, amount: 1 })
  const second = await flows.runFlow(flow, {
    runId: secondId,
    credits: { cost: 1 },
    resume: { ...seed, of: first.id },
  })

  assert.equal(second.status, 'success')
  assert.equal(second.resumeOf, first.id)
  assert.equal(second.reusedNodes, 1)
  assert.equal(second.billTotal, 1)
  assert.equal(second.billFinished, 1)
  assert.equal(second.finishedNodes, 2)
  assert.equal(second.nodes.length, 2)
  assert.equal(second.nodes.find((node) => node.id === 'in')?.reused, true)
  assert.equal(second.nodes.find((node) => node.id === 'llm')?.status, 'success')
  assert.equal(calls, 2, '续跑只该补一次上游，输入节点不能再调')
  assert.equal(balance(), before - 2, '两次运行一共只付 2 积分：上次留 1 + 这次补 1')
  assert.equal(second.credits.cost, 1)
  assert.equal(second.credits.refunded, false)
})

test('路由：带 resumeOf 再跑一次，流里有 run-start / run-end，新运行记得续的是哪条', async () => {
  const port = await startUpstream(350)
  test.after(() => new Promise((resolve) => upstream.close(resolve)))
  createKey({
    name: '续跑路由文本 Key',
    provider: 'deepseek',
    baseUrl: 'http://127.0.0.1:' + port + '/llm',
    apiKey: 'sk-test-run-resume-route-1234567890',
    models: ['deepseek-flash'],
    capabilities: ['text'],
    priority: 9,
    weight: 100,
  })
  const flow = await flows.createFlow({ name: '续跑路由用例', nodes: resumeFlow(), edges: [{ source: 'in', target: 'llm' }] }, user)
  const router = createFlowsRouter()
  const before = balance()
  const cookie = sessionCookie()
  const target = '/api/flows/' + flow.id + '/run'

  const firstRes = mockRes()
  const firstPending = router.handle(
    mockReq({ cookie, body: { stream: true } }),
    firstRes,
    new URL('http://127.0.0.1' + target),
    target,
  )
  await requestSeen
  await sleep(100)
  const firstLines = firstRes.body.trim().split('\n').map((line) => JSON.parse(line))
  const firstStart = firstLines.find((event) => event.type === 'run-start')
  assert.ok(firstStart?.run?.id, '第一次运行要拿到 id')
  const stopRes = mockRes()
  await router.handle(
    mockReq({ cookie }),
    stopRes,
    new URL('http://127.0.0.1/api/runs/' + firstStart.run.id + '/stop'),
    '/api/runs/' + firstStart.run.id + '/stop',
  )
  await firstPending
  const firstEnd = firstRes.body.trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.type === 'run-end')
  assert.equal(firstEnd.run.status, 'interrupted')
  assert.equal(firstEnd.run.credits.kept, 1)
  assert.equal(balance(), before - 1)

  // 改下游的提示词：上游输入没变，续跑仍应允许，只重跑模型节点。
  // 这正是 v0.9.102 会一刀切拒绝的情况，v0.9.103 要能局部接上。
  await flows.updateFlow(flow.id, {
    nodes: flow.nodes.map((node) => (node.id === 'llm'
      ? { ...node, data: { ...node.data, config: { ...node.data.config, systemPrompt: '路由改过的提示词' } } }
      : node)),
  })

  // 预检只读：不改余额、不写运行记录，页面据此显示「还能复用几个、还要补几个」
  const planRes = mockRes()
  await router.handle(
    mockReq({ method: 'GET' }),
    planRes,
    new URL('http://127.0.0.1/api/flows/' + flow.id + '/resume-plan?runId=' + firstStart.run.id),
    '/api/flows/' + flow.id + '/resume-plan',
  )
  assert.equal(planRes.statusCode, 200)
  const plan = JSON.parse(planRes.body)
  assert.equal(plan.runId, firstStart.run.id)
  assert.equal(plan.resumable, true)
  assert.equal(plan.reused, 1)
  assert.equal(plan.rerun, 1)
  assert.equal(plan.stale, 0)
  assert.equal(plan.cost, 1)
  assert.equal(balance(), before - 1, '预检不能扣费')

  const secondRes = mockRes()
  const secondPending = router.handle(
    mockReq({ cookie, body: { stream: true, resumeOf: firstStart.run.id } }),
    secondRes,
    new URL('http://127.0.0.1' + target),
    target,
  )
  await secondPending
  const secondLines = secondRes.body.trim().split('\n').map((line) => JSON.parse(line))
  const secondStart = secondLines.find((event) => event.type === 'run-start')
  const secondEnd = secondLines.find((event) => event.type === 'run-end')
  assert.ok(secondStart?.run?.id, '续跑要有一条新运行 id')
  assert.equal(secondStart.run.resumeOf, firstStart.run.id)
  assert.equal(secondStart.run.reusedNodes, 1)
  assert.equal(secondEnd.run.status, 'success')
  assert.equal(secondEnd.run.resumeOf, firstStart.run.id)
  assert.equal(secondEnd.run.reusedNodes, 1)
  assert.equal(secondEnd.run.credits.cost, 1)
  assert.equal(balance(), before - 2)
})

test('画布局部改动：只重跑改过的节点和下游，没改的上游继续复用', async () => {
  calls = 0
  const port = await startUpstream(180)
  test.after(() => new Promise((resolve) => upstream.close(resolve)))
  createKey({
    name: '局部续跑文本 Key',
    provider: 'deepseek',
    baseUrl: 'http://127.0.0.1:' + port + '/llm',
    apiKey: 'sk-test-run-resume-partial-123456',
    models: ['deepseek-flash'],
    capabilities: ['text'],
    priority: 8,
    weight: 100,
  })
  const nodes = [
    { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { title: '输入', config: { text: '先写一句' } } },
    { id: 'a', type: 'llm', position: { x: 200, y: 0 }, data: { title: '第一段', config: { model: 'deepseek-flash', systemPrompt: '第一段' } } },
    { id: 'b', type: 'llm', position: { x: 400, y: 0 }, data: { title: '第二段', config: { model: 'deepseek-flash', systemPrompt: '第二段' } } },
    { id: 'c', type: 'llm', position: { x: 600, y: 0 }, data: { title: '第三段', config: { model: 'deepseek-flash', systemPrompt: '第三段' } } },
    { id: 'out', type: 'output', position: { x: 800, y: 0 }, data: { title: '输出', config: { format: 'markdown' } } },
  ]
  const edges = [
    { source: 'in', target: 'a' },
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'out' },
  ]
  const flow = await flows.createFlow({ name: '局部续跑用例', nodes, edges }, user)
  const before = balance()

  // 第一次：input / 第一段 / 第二段跑完，第三段正在等上游时停掉
  const firstId = flows.newRunId()
  await flows.startFlowRun(flow, firstId, { cost: 5 })
  assert.equal(credits.charge(user.id, 'flow_run', { ref: firstId, amount: 5 }).ok, true)
  const firstPending = flows.runFlow(flow, { runId: firstId, credits: { cost: 5 } })
  await waitForCalls(3)
  assert.equal(flows.requestRunStop(firstId, { reason: 'user' }).ok, true)
  const first = await firstPending
  assert.equal(first.status, 'interrupted')
  assert.equal(first.finishedNodes, 3)
  assert.equal(first.credits.kept, 3)
  assert.equal(first.credits.refundedAmount, 2)
  assert.equal(calls, 3, '第一段、第二段、第三段各调一次上游；第三段没有结果')
  assert.equal(balance(), before - 3)

  // 只改第二段的提示词，并把所有节点挪一下：位置不算内容，第二段和下游失效
  const edited = {
    ...flow,
    nodes: flow.nodes.map((node) => ({
      ...node,
      position: { x: node.position.x + 20, y: node.position.y + 10 },
      data: node.id === 'b'
        ? { ...node.data, config: { ...node.data.config, systemPrompt: '改过的第二段' } }
        : node.data,
    })),
  }
  const revisions = flows.nodeRevisionsOf(flow)
  const editedRevisions = flows.nodeRevisionsOf(edited)
  assert.equal(editedRevisions.in, revisions.in, '挪位置不能让输入节点失效')
  assert.equal(editedRevisions.a, revisions.a, '上游没改，仍然能复用')
  assert.notEqual(editedRevisions.b, revisions.b, '改过的第二段必须失效')
  assert.notEqual(editedRevisions.c, revisions.c, '第二段的下游必须一起失效')

  const seed = flows.resumeSeedFor(first, edited)
  assert.equal(seed.reusedCount, 2)
  assert.deepEqual([...seed.results.keys()].sort(), ['a', 'in'])
  assert.equal(seed.staleCount, 1)
  const plan = flows.resumePlanFor(first, edited, 5)
  assert.equal(plan.resumable, true)
  assert.equal(plan.reused, 2)
  assert.equal(plan.rerun, 3)
  assert.equal(plan.stale, 1)
  assert.equal(plan.cost, 2)

  // 第二次：只补第二段、第三段和输出；输入与第一段不重复调上游
  const secondId = flows.newRunId()
  await flows.startFlowRun(edited, secondId, {
    cost: plan.cost,
    resumeOf: first.id,
    reusedNodes: plan.reused,
    billTotal: plan.rerun,
    flowRevision: flows.flowRevisionOf(edited),
  })
  assert.equal(credits.charge(user.id, 'flow_run', { ref: secondId, amount: plan.cost }).ok, true)
  const second = await flows.runFlow(edited, {
    runId: secondId,
    credits: { cost: plan.cost },
    resume: { ...plan.seed, of: first.id },
  })

  assert.equal(second.status, 'success')
  assert.equal(second.reusedNodes, 2)
  assert.equal(second.finishedNodes, 5)
  assert.equal(second.billTotal, 3)
  assert.equal(second.billFinished, 3)
  assert.equal(second.nodes.find((node) => node.id === 'in')?.reused, true)
  assert.equal(second.nodes.find((node) => node.id === 'a')?.reused, true)
  assert.equal(second.nodes.find((node) => node.id === 'b')?.status, 'success')
  assert.equal(calls, 5, '续跑只补第二段和第三段，输入与第一段不能再调')
  assert.equal(balance(), before - 5, '两次运行一共只付 5 积分：上次留 3 + 这次补 2')
})
