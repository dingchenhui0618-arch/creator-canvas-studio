import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'

// 画布运行的钱与记录：这一组盯住四条不变量——
//   1) 运行一开始就落盘，进程被杀也查得到这次运行；
//   2) 重启 / 停机把没跑完的运行标成 interrupted，并按账本把净扣款退回；
//   3) 扣费单据 ref = 运行 id（不是画布名），账本、运行记录、退款三处对得上；
//   4) 同一次运行无论被收尾多少次，退款只发生一次。
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-run-recovery-'))
process.env.VQ_KEY_SECRET = 'test-secret-run-recovery'
process.env.VISION_API_KEY = ''

const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const flows = await import('../server/flows.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')
const { createKey } = await import('../server/keyvault.mjs')

const user = auth.createUser({ email: 'run-recovery@example.test', password: 'Passw0rd!demo', name: '运行恢复', kind: 'admin' })
const balance = () => credits.balanceOf(user.id)

const outputOnly = () => [{ id: 'out', type: 'output', data: { title: '输出', config: { format: 'markdown' } } }]
// 没配评审图片的 review 节点会在读图前就抛错：用它验证「节点失败不进上游也不扣钱」
const reviewMissingImage = () => [{ id: 'rv', type: 'review', data: { title: '视觉评审', config: { profile: 'brand', image: '' } } }]

async function makeFlow(nodes, edges = []) {
  return flows.createFlow({ name: '恢复用例画布', nodes, edges }, user)
}

async function newChargedRun(flow, { cost = 2 } = {}) {
  const runId = flows.newRunId()
  await flows.startFlowRun(flow, runId, { cost })
  credits.charge(user.id, 'flow_run', { ref: runId })
  return runId
}

// 路由层的假 req / res：只够跑到 JSON 应答，不起真实端口
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
  const res = {
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
  return res
}

test('运行一开始就落盘：扣完费马上断电也留得下这条单', async () => {
  await flows.recoverInterruptedRuns()
  const before = balance()
  const flow = await makeFlow(outputOnly())
  const runId = await newChargedRun(flow)
  const saved = await flows.getRun(runId, user)
  assert.ok(saved, '扣费之前就必须有这条运行记录')
  assert.equal(saved.status, 'running')
  assert.equal(saved.credits.cost, 2)
  assert.equal(saved.credits.refunded, false)
  // 收尾：这条用例只验落盘，不把 running 留给下一个用例
  await flows.abandonRun(runId, '用例收尾')
  assert.equal(balance(), before)
  assert.equal((await flows.getRun(runId, user)).status, 'error')
})

test('重启恢复：没跑完的运行标成已中断，并按账本退回积分', async () => {
  await flows.recoverInterruptedRuns()
  const before = balance()
  const flow = await makeFlow(outputOnly())
  const runId = await newChargedRun(flow)
  assert.equal(balance(), before - 2)

  const first = await flows.recoverInterruptedRuns()
  assert.equal(first.recovered, 1)
  assert.equal(first.refunded, 1)
  const rec = await flows.getRun(runId, user)
  assert.equal(rec.status, 'interrupted')
  assert.match(String(rec.error), /重启/)
  assert.equal(rec.credits.refunded, true)
  assert.equal(balance(), before, '扣掉的积分必须原样退回')
  const refund = credits.ledgerOf(user.id, 10).find((row) => row.kind === 'flow_run-refund' && row.ref === runId)
  assert.ok(refund, '退款流水要和扣费同一个 ref')

  const second = await flows.recoverInterruptedRuns()
  assert.equal(second.recovered, 0)
  assert.equal(balance(), before, '重复恢复不能多退')
})

test('正常跑完的运行不被恢复逻辑碰，也不退款', async () => {
  await flows.recoverInterruptedRuns()
  const before = balance()
  const flow = await makeFlow(outputOnly())
  const runId = await newChargedRun(flow)
  const run = await flows.runFlow(flow, { runId, credits: { cost: 2 } })
  assert.equal(run.status, 'success')
  assert.equal(balance(), before - 2)

  const rec = await flows.getRun(runId, user)
  assert.equal(rec.status, 'success')
  assert.equal(rec.credits.refunded, false)
  const again = await flows.recoverInterruptedRuns()
  assert.equal(again.recovered, 0)
  const list = await flows.listRuns({ limit: 50 }, user)
  assert.equal(list.items.filter((item) => item.id === runId).length, 1, '开始与结束各写一次不能变成两条记录')
})

test('节点失败：运行标失败，按账本退回，只退一次', async () => {
  await flows.recoverInterruptedRuns()
  const before = balance()
  const flow = await makeFlow(reviewMissingImage())
  const runId = await newChargedRun(flow)
  const run = await flows.runFlow(flow, { runId, credits: { cost: 2 } })
  assert.equal(run.status, 'error')
  assert.equal(balance(), before, '失败的运行不能扣钱')
  const rec = await flows.getRun(runId, user)
  assert.equal(rec.credits.refunded, true)
  const refunds = credits.ledgerOf(user.id, 20).filter((row) => row.kind === 'flow_run-refund' && row.ref === runId)
  assert.equal(refunds.length, 1)
})

test('路由扣费单据 ref = 运行 id，账本能对上这次运行', async () => {
  await flows.recoverInterruptedRuns()
  const before = balance()
  const flow = await makeFlow(reviewMissingImage())
  const session = auth.createSession(user)
  const router = createFlowsRouter()
  const res = mockRes()
  const target = '/api/flows/' + flow.id + '/run'
  const handled = await router.handle(mockReq({ cookie: auth.sessionCookie(session.token).split(';')[0], body: {} }), res, new URL('http://127.0.0.1' + target), target)
  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.status, 'error')
  const runId = payload.id
  assert.match(runId, /^run_/)

  const rows = credits.ledgerOf(user.id, 20)
  assert.ok(rows.find((row) => row.kind === 'flow_run' && row.ref === runId), '扣费 ref 必须是运行 id，不能是画布名')
  assert.ok(rows.find((row) => row.kind === 'flow_run-refund' && row.ref === runId), '退款也要用同一个 ref')
  assert.equal(balance(), before)
})

test('停机收尾：在跑的运行标中断 + 退款，跑完也不会改回成功', async () => {
  await flows.recoverInterruptedRuns()
  let releaseRequest = null
  const requestSeen = new Promise((resolve) => { releaseRequest = resolve })
  const upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (releaseRequest) releaseRequest()
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ message: { content: '好的' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        }))
      }, 300)
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  test.after(() => new Promise((resolve) => upstream.close(resolve)))
  createKey({
    name: '停机用例文本 Key',
    provider: 'deepseek',
    baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/llm',
    apiKey: 'sk-test-run-recovery-1234567890',
    models: ['deepseek-flash'],
    capabilities: ['text'],
    priority: 10,
    weight: 100,
  })

  const before = balance()
  const flow = await makeFlow(
    [
      { id: 'in', type: 'input', data: { title: '输入', config: { text: '说一句' } } },
      { id: 'llm', type: 'llm', data: { title: '模型', config: { model: 'deepseek-flash' } } },
    ],
    [{ source: 'in', target: 'llm' }],
  )
  const runId = await newChargedRun(flow)
  const running = flows.runFlow(flow, { runId, credits: { cost: 2 } })
  await requestSeen

  const interrupted = await flows.interruptRunningRuns('服务重启')
  assert.equal(interrupted, 1)
  const rec = await flows.getRun(runId, user)
  assert.equal(rec.status, 'interrupted')
  assert.equal(rec.credits.refunded, true)
  assert.equal(balance(), before, '停机收尾要先把钱退回去')

  const finished = await running
  assert.equal(finished.status, 'interrupted', '上游返回后也不能把中断的终态改回成功')
  assert.equal(balance(), before, '同一次运行只退一次')
})
