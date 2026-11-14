// 运行对照（v0.9.110）。这一组盯住四件事：
//   1) 输出按完整内容比对，首段只是预览；键顺序不同不算改动；
//   2) 新增 / 移除 / 状态变了 / 输入或配置变了 各自计数，不能混成一个「变了」；
//   3) 默认找同一条画布更早的一条运行，第一条运行如实说「没得对照」；
//   4) 对照只返回指纹和短预览，不把两条运行的完整输出再搬一遍。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-run-compare-'))
process.env.VQ_KEY_SECRET = 'test-secret-run-compare'
process.env.VISION_API_KEY = ''
process.env.VQ_WATER_GUARD = '0'
process.env.VQ_RUN_QUEUE_MS = '0'
isolateLeaseDir('vq-lease-run-compare-')

const { buildRunCompare } = await import('../server/run-compare.mjs')
const flows = await import('../server/flows.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')

function mockReq({ method = 'GET' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = {}
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
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    write(chunk) { this.body += String(chunk); return true },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true },
  }
}

async function get(router, pathname) {
  const res = mockRes()
  const url = new URL('http://vq.local' + pathname)
  // 真实服务里第四个参数是不带查询串的 url.pathname；带 with= 的用例靠这一点才能命中路由
  await router.handle(mockReq(), res, url, url.pathname)
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') }
}

function runFixture({ id, nodes, revisions = {}, flowRevision = 'rev-a', durationMs = 1000, cost = 0, refunded = false }) {
  return {
    id,
    flowId: 'flow_same',
    flowName: '对照用例画布',
    status: 'success',
    startedAt: id === 'run_new' ? '2026-11-14T10:05:00.000Z' : '2026-11-14T10:00:00.000Z',
    finishedAt: '2026-11-14T10:05:10.000Z',
    durationMs,
    total: nodes.length,
    finishedNodes: nodes.filter((node) => node.status === 'success').length,
    flowRevision,
    nodeRevisions: revisions,
    nodes,
    output: '',
    ownerId: 'user_1',
    credits: { cost, refunded },
  }
}

function node(id, { status = 'success', ms = 100, text = '', key = 'title' } = {}) {
  return {
    id,
    kind: id === 'in' ? 'input' : 'llm',
    title: key,
    status,
    ms,
    output: text === null ? null : { text },
    error: null,
    message: null,
  }
}

test('逐节点对照：新增、移除、状态、输出、输入或配置分开计数，首段预览有上限', () => {
  const long = '很长的一段输出'.repeat(40)
  const current = runFixture({
    id: 'run_new',
    durationMs: 2400,
    cost: 5,
    flowRevision: 'rev-b',
    revisions: { in: 'r2', llm: 'r2', only_new: 'r1' },
    nodes: [
      node('in', { ms: 40, text: '新的输入' }),
      node('llm', { ms: 1800, text: long }),
      node('only_new', { text: '这次才有的节点' }),
    ],
  })
  const previous = runFixture({
    id: 'run_old',
    durationMs: 1000,
    cost: 5,
    refunded: true,
    flowRevision: 'rev-a',
    revisions: { in: 'r1', llm: 'r1', only_old: 'r1' },
    nodes: [
      node('in', { ms: 60, text: '旧的输入' }),
      node('llm', { ms: 900, status: 'error', text: '上一次失败在这' }),
      node('only_old', { text: '这次已经没有的节点' }),
    ],
  })
  const compare = buildRunCompare(current, previous)
  assert.equal(compare.comparable, true)
  assert.equal(compare.graph.changed, true)
  assert.equal(compare.graph.unknown, false)
  assert.equal(compare.totals.added, 1)
  assert.equal(compare.totals.removed, 1)
  assert.equal(compare.totals.statusChanged, 1)
  assert.equal(compare.totals.outputChanged, 2)
  assert.equal(compare.totals.revisionChanged, 2)
  assert.equal(compare.totals.unchanged, 0)
  assert.equal(compare.totals.changed, 4)
  assert.equal(compare.totals.durationDelta, 1400)
  // 上一次那 5 积分已经退回：实际花掉 0，这次花 5
  assert.equal(compare.totals.costDelta, 5)

  const llm = compare.nodes.find((item) => item.id === 'llm')
  assert.equal(llm.previous.status, 'error')
  assert.equal(llm.statusChanged, true)
  assert.equal(llm.outputChanged, true)
  assert.equal(llm.revisionChanged, true)
  assert.equal(llm.msDelta, 900)
  assert.equal(llm.current.preview.length, 181)
  assert.ok(llm.current.preview.endsWith('…'))
  assert.equal(JSON.stringify(llm).includes('很长的一段输出很长'), true)

  const added = compare.nodes.find((item) => item.id === 'only_new')
  assert.equal(added.added, true)
  assert.equal(added.previous, null)
  assert.equal(added.msDelta, null)
})

test('输出键顺序不同不算改动；两条老运行没有指纹时 graph 如实标 unknown', () => {
  const current = runFixture({
    id: 'run_new',
    revisions: {},
    flowRevision: '',
    nodes: [node('same', { text: '一样的结果' })],
  })
  const previous = runFixture({
    id: 'run_old',
    revisions: {},
    flowRevision: '',
    nodes: [node('same', { text: '一样的结果' })],
  })
  // 手工换个键顺序：输出内容相同，对照不能因此报「输出变了」
  current.nodes[0].output = { text: '一样的结果', meta: { b: 2, a: 1 } }
  previous.nodes[0].output = { meta: { a: 1, b: 2 }, text: '一样的结果' }
  const compare = buildRunCompare(current, previous)
  assert.equal(compare.nodes[0].outputChanged, false)
  assert.equal(compare.totals.unchanged, 1)
  assert.equal(compare.graph.changed, false)
  assert.equal(compare.graph.unknown, true)
})

test('对照接口：默认找上一条；第一条说清楚没得比；跨画布与自对照拒绝；不返回完整输出', async () => {
  const flow = await flows.createFlow({
    name: '对照用例画布',
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { title: '输入', description: '', config: { text: '第一次的输入' } } },
      { id: 'out', type: 'output', position: { x: 300, y: 0 }, data: { title: '输出', description: '', config: { format: 'markdown' } } },
    ],
    edges: [{ id: 'e1', source: 'in', target: 'out' }],
  })
  const first = await flows.runFlow(flow, { runId: flows.newRunId() })
  assert.equal(first.status, 'success')
  const router = createFlowsRouter()

  const alone = await get(router, '/api/runs/' + first.id + '/compare')
  assert.equal(alone.status, 200)
  assert.equal(alone.body.comparable, false)
  assert.match(alone.body.reason, /最早的一条运行/)
  assert.equal(alone.body.current.id, first.id)

  await flows.updateFlow(flow.id, {
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { title: '输入', description: '', config: { text: '第二次改过的输入' } } },
      { id: 'out', type: 'output', position: { x: 300, y: 0 }, data: { title: '输出', description: '', config: { format: 'markdown' } } },
    ],
    edges: [{ id: 'e1', source: 'in', target: 'out' }],
  })
  // 改完必须重新取画布：runFlow 跑的是传进去的那份 nodes，不是磁盘上的最新版
  const updatedFlow = await flows.getFlow(flow.id)
  const second = await flows.runFlow(updatedFlow, { runId: flows.newRunId() })
  assert.equal(second.status, 'success')

  const compare = await get(router, '/api/runs/' + second.id + '/compare')
  assert.equal(compare.status, 200)
  assert.equal(compare.body.comparable, true)
  assert.equal(compare.body.previous.id, first.id)
  assert.equal(compare.body.current.id, second.id)
  assert.equal(compare.body.graph.changed, true)
  const input = compare.body.nodes.find((item) => item.id === 'in')
  assert.equal(input.outputChanged, true)
  assert.equal(input.revisionChanged, true)
  // 节点类型里本来就有 kind: "output"；这里查的是「完整输出字段」没有被搬过来
  assert.equal(JSON.stringify(compare.body).includes('"output":'), false, '对照不能把完整输出再搬一遍')
  assert.ok(input.current.preview.length <= 181)

  const explicit = await get(router, '/api/runs/' + second.id + '/compare?with=' + first.id)
  assert.equal(explicit.status, 200)
  assert.equal(explicit.body.previous.id, first.id)

  const self = await get(router, '/api/runs/' + second.id + '/compare?with=' + second.id)
  assert.equal(self.status, 400)

  const otherFlow = await flows.createFlow({
    name: '另一张画布',
    nodes: [{ id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { title: '输入', description: '', config: { text: '不相干' } } }],
    edges: [],
  })
  const otherRun = await flows.runFlow(otherFlow, { runId: flows.newRunId() })
  const cross = await get(router, '/api/runs/' + second.id + '/compare?with=' + otherRun.id)
  assert.equal(cross.status, 400)
  assert.match(cross.body.error, /同一张画布/)

  const missing = await get(router, '/api/runs/' + second.id + '/compare?with=run_not_there')
  assert.equal(missing.status, 404)
})
