// 全站重活上限（v0.9.70）：按账号的并发管不住「两个账号各来两条」。
// 这一组盯住三件事：
//   1) 别的账号在跑重活、全站名额已满时，这一单在扣费之前被拒（503 SERVER_BUSY，不扣积分、不落运行记录）；
//   2) 那条活一结束名额就还回来，同一个账号立刻能接；
//   3) 拒绝走的是真实路由与真实账本，不是只测一个纯函数。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-global-heavy-'))
process.env.VQ_KEY_SECRET = 'test-secret-global-heavy'

const { config } = await import('../server/config.mjs')
const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const flows = await import('../server/flows.mjs')
const gate = await import('../server/gate.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')

const me = auth.createUser({ email: '[EMAIL:GLB1]', password: 'Passw0rd!demo', name: '我自己', kind: 'admin' })
const other = auth.createUser({ email: '[EMAIL:GLB2]', password: 'Passw0rd!demo', name: '另一个账号', kind: 'user' })
const cookie = auth.sessionCookie(auth.createSession(me, { userAgent: 'test', ip: '10.0.4.1' }).token).split(';')[0]
const balance = () => credits.balanceOf(me.id)

const outputOnly = () => [{ id: 'out', type: 'output', data: { title: '输出', config: { format: 'markdown' } } }]

function withGlobalCap(value, run) {
  const previous = config.credits.globalHeavy
  config.credits.globalHeavy = value
  return Promise.resolve(run()).finally(() => { config.credits.globalHeavy = previous })
}

function mockReq({ method = 'POST', body = null, cookie: c = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = c ? { cookie: c } : {}
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

async function runFlowRoute(flow) {
  const router = createFlowsRouter()
  const res = mockRes()
  const target = '/api/flows/' + flow.id + '/run'
  await router.handle(mockReq({ cookie, body: {} }), res, new URL('http://127.0.0.1' + target), target)
  let payload = null
  try { payload = JSON.parse(res.body) } catch {}
  return { status: res.statusCode, payload, raw: res.body }
}

test('全站名额满：另一个账号在跑重活时，这一单不扣积分也不落运行记录', async () => {
  await flows.recoverInterruptedRuns()
  await withGlobalCap(1, async () => {
    const flow = await flows.createFlow({ name: '全站上限用例', nodes: outputOnly(), edges: [] }, me)
    const before = balance()
    const runsBefore = (await flows.listRuns({ limit: 50 }, me)).total
    // 另一个账号正在跑一条重活：全站只剩 0 个名额
    assert.equal(gate.enter(other.id, 'flow_run', 1), true)
    try {
      const refused = await runFlowRoute(flow)
      assert.equal(refused.status, 503)
      assert.equal(refused.payload.code, 'SERVER_BUSY')
      assert.equal(refused.payload.active, 1)
      assert.equal(refused.payload.limit, 1)
      assert.equal(refused.payload.retryAfterSec, 60)
      assert.match(refused.payload.error, /没有扣积分/)
      assert.equal(balance(), before, '被拒的这一单不能扣积分')
      assert.equal((await flows.listRuns({ limit: 50 }, me)).total, runsBefore, '被拒的这一单不能留下运行记录')
      assert.equal(credits.ledgerOf(me.id, 10).filter((row) => row.kind === 'flow_run').length, 0, '账本里不能有这笔扣费')
    } finally {
      gate.leave(other.id, 'flow_run')
    }
    // 名额还回来：同一条路由立刻接单，并且照常记账
    const accepted = await runFlowRoute(flow)
    assert.equal(accepted.status, 200)
    assert.equal(balance(), before - Number(config.credits.prices.flow_run || 0))
  })
})

test('上限写 0 = 不限：全站名额这一层不生效', async () => {
  await flows.recoverInterruptedRuns()
  await withGlobalCap(0, async () => {
    const flow = await flows.createFlow({ name: '不限用例', nodes: outputOnly(), edges: [] }, me)
    assert.equal(gate.enter(other.id, 'flow_run', 1), true)
    try {
      const accepted = await runFlowRoute(flow)
      assert.equal(accepted.status, 200)
      assert.equal(accepted.payload.status, 'success')
    } finally {
      gate.leave(other.id, 'flow_run')
    }
  })
})
