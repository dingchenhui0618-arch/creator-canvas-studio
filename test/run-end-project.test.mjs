// run-end 里要带「这次跑的是哪条作品的哪一版」（r250 / v0.9.233）。
//
// 探针实测：一条绑好作品的运行跑完，抽屉底栏却写着「这次运行还没挂到作品上」——
// 因为只有 GET /api/runs/:id 会补 project，流式那条路（页面真正用的那条）没补。
// 这一组盯住两条：绑了要给作品与版次，没绑要明确给 null，别让前端去猜缺字段。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-run-project-'))
// 工作流 beta（r313）只对管理员开放：这一组测的是工作流本身，显式对全部账号打开，不改变测试意图
process.env.VQ_WORKFLOW_BETA = 'all'
process.env.VQ_KEY_SECRET = 'test-secret-run-project'
process.env.VQ_WATER_GUARD = '0'
process.env.VQ_RUN_QUEUE_MS = '0'
isolateLeaseDir('vq-lease-run-project-')

const { config } = await import('../server/config.mjs')
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })
const auth = await import('../server/auth.mjs')
const flows = await import('../server/flows.mjs')
const projects = await import('../server/projects.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')

const user = auth.createUser({ email: '[EMAIL:3QJ3TZ]', password: 'Passw0rd!demo', name: '运行归属用例', kind: 'admin' })
const cookie = () => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', userAgentData: null, ip: '10.0.9.11' }).token).split(';')[0]

function mockReq({ body = null } = {}) {
  const req = new Readable({ read() {} })
  req.method = 'POST'
  req.headers = { cookie: cookie(), 'content-type': 'application/json' }
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

// 不碰上游的一条工作流：输入 -> 输出，跑完就是 success
const offlineNodes = () => [
  { id: 'in', type: 'input', data: { title: '原始素材', config: { text: '毛衣折叠收纳法：铺平、袖口内收、下摆上折两次。' } } },
  { id: 'out', type: 'output', data: { title: '最终输出', config: {} } },
]

async function runOnce(flowId) {
  const router = createFlowsRouter()
  const res = mockRes()
  const target = '/api/flows/' + flowId + '/run'
  await router.handle(mockReq({ body: { stream: true } }), res, new URL('http://127.0.0.1' + target), target)
  const events = res.body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return events.find((event) => event.type === 'run-end')
}

test('绑好作品的运行：run-end 里就带作品与版次，页面不用再补一次请求', async () => {
  const flow = await flows.createFlow({ name: '毛衣折叠 · 复刻', nodes: offlineNodes(), edges: [{ source: 'in', target: 'out' }] }, user)
  const project = await projects.createProject({ title: '毛衣折叠收纳法', flowId: flow.id }, user)
  assert.equal(project.version, 1, '绑了工作流的作品出生就是 v1')

  const end = await runOnce(flow.id)
  assert.equal(end.run.status, 'success')
  assert.ok(end.run.project, 'run-end 必须带 project')
  assert.equal(end.run.project.id, project.id)
  assert.equal(end.run.project.title, '毛衣折叠收纳法')
  assert.equal(end.run.project.version, 1)
  assert.equal(end.run.project.archived, false)
})

test('没挂作品的工作流：run-end 明确给 null，不留给前端猜', async () => {
  const flow = await flows.createFlow({ name: '空白工作流', nodes: offlineNodes(), edges: [{ source: 'in', target: 'out' }] }, user)
  const end = await runOnce(flow.id)
  assert.equal(end.run.status, 'success')
  assert.equal('project' in end.run, true)
  assert.equal(end.run.project, null)
})
