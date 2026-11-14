// 运行画布快照（v0.9.107）。这一组盯住三件事：
//   1) 运行开始时把位置/参数/连线留下，运行后再改画布也不影响这份快照；
//   2) 单条运行详情才带快照，运行列表不背几十张画布的配置；
//   3) 运行记录被挤出 60 条窗口时，快照文件一起清掉，不留下孤儿文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-run-graph-'))
process.env.VQ_KEY_SECRET = 'test-secret-run-graph'
process.env.VISION_API_KEY = ''
process.env.VQ_WATER_GUARD = '0'
process.env.VQ_RUN_QUEUE_MS = '0'
isolateLeaseDir('vq-lease-run-graph-')

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
  await router.handle(mockReq(), res, url, pathname)
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') }
}

function graphNodes() {
  return [
    { id: 'in', type: 'input', position: { x: 12, y: 34 }, data: { title: '当时的输入', description: '', config: { text: '一开始写的那句话' } } },
    { id: 'out', type: 'output', position: { x: 320, y: 90 }, data: { title: '当时的输出', description: '', config: { format: 'markdown' } } },
  ]
}

test('运行开始时留下画布快照；改画布后仍回看当时的位置与参数，列表不带快照，超窗口会清理', async () => {
  const flow = await flows.createFlow({
    name: '快照用例画布',
    nodes: graphNodes(),
    edges: [{ id: 'e-in-out', source: 'in', target: 'out' }],
  })
  const runId = flows.newRunId()
  const run = await flows.runFlow(flow, { runId })
  assert.equal(run.status, 'success')

  const graph = await flows.loadRunGraph(runId)
  assert.ok(graph, '运行开始后应该留下快照')
  assert.equal(await flows.hasRunGraph(runId), true, '运行页要能只凭 id 判断有没有快照')
  assert.equal(await flows.hasRunGraph('run_not_there'), false)
  assert.match(graph.capturedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(graph.nodes.find((node) => node.id === 'in')?.position.x, 12)
  assert.equal(graph.nodes.find((node) => node.id === 'in')?.data.config.text, '一开始写的那句话')
  assert.equal(graph.nodes.find((node) => node.id === 'out')?.position.y, 90)
  assert.equal(graph.edges.length, 1)

  // 运行之后再挪位置、改提示词：快照不能被现在的画布覆盖
  await flows.updateFlow(flow.id, {
    nodes: [
      { id: 'in', type: 'input', position: { x: 600, y: 480 }, data: { title: '现在改过的输入', description: '', config: { text: '后来改掉的那句话' } } },
      { id: 'out', type: 'output', position: { x: 900, y: 600 }, data: { title: '现在的输出', description: '', config: { format: 'text' } } },
    ],
    edges: [{ id: 'e-in-out', source: 'in', target: 'out' }],
  })
  const pinned = await flows.loadRunGraph(runId)
  assert.equal(pinned.nodes.find((node) => node.id === 'in')?.position.x, 12)
  assert.equal(pinned.nodes.find((node) => node.id === 'in')?.data.config.text, '一开始写的那句话')
  assert.equal(pinned.nodes.find((node) => node.id === 'in')?.data.title, '当时的输入')

  // 单条详情带快照；列表只看结果，不把整张画布一起发出去
  const router = createFlowsRouter()
  const detail = await get(router, '/api/runs/' + runId)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.graph.nodes.length, 2)
  assert.equal(detail.body.graph.nodes.find((node) => node.id === 'in')?.position.x, 12)
  const list = await get(router, '/api/runs')
  assert.equal(list.status, 200)
  const row = list.body.items.find((item) => item.id === runId)
  assert.ok(row)
  assert.equal(row.graph, undefined)
  assert.equal(row.total, 2)

  // 磁盘上的运行记录也不复制一份快照进去
  const stored = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'runs.json'), 'utf8'))
  assert.equal(stored.find((item) => item.id === runId)?.graph, undefined)

  // 61 条新运行把这条挤出历史窗口：画布快照跟着清掉，不留孤儿
  const newer = []
  for (let index = 0; index < 61; index += 1) {
    const id = flows.newRunId()
    await flows.runFlow(flow, { runId: id })
    newer.push(id)
  }
  assert.equal(await flows.loadRunGraph(newer[0]), null)
  assert.equal(await flows.hasRunGraph(newer[0]), false, '快照清理后不能还报「有」')
  assert.ok(await flows.loadRunGraph(newer[61 - 1]))
  assert.equal(await flows.hasRunGraph(newer[61 - 1]), true)
  const files = fs.readdirSync(path.join(process.env.DATA_DIR, 'run-graphs')).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 60)
})
