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

const { buildRunCompare, buildRunOutputDiff } = await import('../server/run-compare.mjs')
const flows = await import('../server/flows.mjs')
const projects = await import('../server/projects.mjs')
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

test('输出差异只列改动附近的行：新增、删除各一行，长行折开，JSON 按字段排序', () => {
  const current = runFixture({
    id: 'run_new',
    nodes: [
      {
        id: 'script',
        kind: 'llm',
        title: '脚本',
        status: 'success',
        ms: 100,
        output: { text: '第一行\n第二行 · 新版\n第三行\n第四行' },
      },
      {
        id: 'sheet',
        kind: 'llm',
        title: '分镜',
        status: 'success',
        ms: 100,
        output: { b: 3, a: 1 },
      },
    ],
  })
  const previous = runFixture({
    id: 'run_old',
    nodes: [
      {
        id: 'script',
        kind: 'llm',
        title: '脚本',
        status: 'success',
        ms: 100,
        output: { text: '第一行\n第二行 · 旧版\n第三行\n第四行' },
      },
      {
        id: 'sheet',
        kind: 'llm',
        title: '分镜',
        status: 'success',
        ms: 100,
        output: { b: 2, a: 1 },
      },
    ],
  })

  const textDiff = buildRunOutputDiff(current, previous, 'script')
  assert.equal(textDiff.outputKind, 'text')
  assert.equal(textDiff.stats.added, 1)
  assert.equal(textDiff.stats.removed, 1)
  assert.equal(textDiff.lines.some((line) => line.op === 'del' && line.text.includes('旧版')), true)
  assert.equal(textDiff.lines.some((line) => line.op === 'add' && line.text.includes('新版')), true)
  assert.equal(textDiff.lines.some((line) => line.op === 'same' && line.text === '第一行'), true)
  assert.equal(textDiff.truncated, false)
  // 差异接口只给改动附近的行，不算完整输出
  assert.equal(JSON.stringify(textDiff).includes('"output":'), false)

  const jsonDiff = buildRunOutputDiff(current, previous, 'sheet')
  assert.equal(jsonDiff.outputKind, 'json')
  assert.equal(jsonDiff.stats.added, 1)
  assert.equal(jsonDiff.stats.removed, 1)
  assert.equal(jsonDiff.lines.some((line) => line.op === 'del' && line.text.includes('"b": 2')), true)
  assert.equal(jsonDiff.lines.some((line) => line.op === 'add' && line.text.includes('"b": 3')), true)

  // 单行几千字也不返回一整行：按 160 字折开，仍能看见改动落在哪一段
  const longBefore = '甲'.repeat(500) + '旧' + '乙'.repeat(500)
  const longAfter = '甲'.repeat(500) + '新' + '乙'.repeat(500)
  const longCurrent = runFixture({ id: 'run_new', nodes: [{ id: 'long', kind: 'llm', title: '长文', status: 'success', ms: 1, output: { text: longAfter } }] })
  const longPrevious = runFixture({ id: 'run_old', nodes: [{ id: 'long', kind: 'llm', title: '长文', status: 'success', ms: 1, output: { text: longBefore } }] })
  const longDiff = buildRunOutputDiff(longCurrent, longPrevious, 'long')
  assert.equal(longDiff.stats.added > 0, true)
  assert.equal(longDiff.lines.every((line) => line.op === 'skip' || Array.from(line.text || '').length <= 160), true)

  // 超过 2.4 万字符：如实标 truncated，不假装比完了全文
  const hugeCurrent = runFixture({ id: 'run_new', nodes: [{ id: 'huge', kind: 'llm', title: '超长', status: 'success', ms: 1, output: { text: '甲'.repeat(30000) + '新' } }] })
  const hugePrevious = runFixture({ id: 'run_old', nodes: [{ id: 'huge', kind: 'llm', title: '超长', status: 'success', ms: 1, output: { text: '甲'.repeat(30000) + '旧' } }] })
  const hugeDiff = buildRunOutputDiff(hugeCurrent, hugePrevious, 'huge')
  assert.equal(hugeDiff.truncated, true)
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

test('跨版本对照：同一件作品的两张画布按节点 id 对齐，并说清 v1 → v2', () => {
  const node = (id, output) => ({ id, kind: id === 'in' ? 'input' : 'output', title: id, status: 'success', ms: 100, output })
  const current = {
    id: 'run_v2', flowId: 'flow_v2', flowName: '跨版作品 v2',
    project: { id: 'prj_1', title: '跨版作品', version: 2 },
    nodes: [node('in', '新版的输入'), node('out', '新版的输入')],
    nodeRevisions: { in: 'r2', out: 'r2' }, flowRevision: 'rev-2',
  }
  const previous = {
    id: 'run_v1', flowId: 'flow_v1', flowName: '跨版作品 v1',
    project: { id: 'prj_1', title: '跨版作品', version: 1 },
    nodes: [node('in', '旧版的输入'), node('out', '旧版的输入'), node('gone', '上一版有')],
    nodeRevisions: { in: 'r1', out: 'r1' }, flowRevision: 'rev-1',
  }
  const compare = buildRunCompare(current, previous)
  assert.equal(compare.crossVersion, true)
  assert.equal(compare.project.id, 'prj_1')
  assert.equal(compare.current.project.version, 2)
  assert.equal(compare.previous.project.version, 1)
  assert.equal(compare.nodes.find((item) => item.id === 'in').added, false, '不同 flowId 上同 id 的节点要能对上')
  assert.equal(compare.nodes.find((item) => item.id === 'in').outputChanged, true)
  assert.equal(compare.nodes.find((item) => item.id === 'gone').removed, true)

  // 不同作品的两张画布不能被说成「同一件作品的版本」
  const foreign = buildRunCompare(current, { ...previous, project: { id: 'prj_2', title: '别家', version: 1 } })
  assert.equal(foreign.crossVersion, false)
  assert.equal(foreign.project, null)
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
  assert.equal(alone.body.options.length, 0, '第一条运行时还没有可对照的候选')
  assert.equal(alone.body.optionsTotal, 0)

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
  assert.equal(compare.body.optionsTotal, 1, '同一条画布上另有 1 条已结束运行')
  assert.equal(compare.body.options.length, 1)
  assert.equal(compare.body.options[0].id, first.id, '候选里应有上一条运行')
  assert.equal(compare.body.options.some((item) => item.id === second.id), false, '候选不能包含当前这条')
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
  assert.match(cross.body.error, /不属于同一件作品/)

  const missing = await get(router, '/api/runs/' + second.id + '/compare?with=run_not_there')
  assert.equal(missing.status, 404)

  // 再跑第三次：最早那条运行默认仍没有更早的，但候选里应出现之后两条；
  // 点名之后的一条也必须能对照——「最早」不再是死路。
  await flows.updateFlow(flow.id, {
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { title: '输入', description: '', config: { text: '第三次的输入' } } },
      { id: 'out', type: 'output', position: { x: 300, y: 0 }, data: { title: '输出', description: '', config: { format: 'markdown' } } },
    ],
    edges: [{ id: 'e1', source: 'in', target: 'out' }],
  })
  const thirdFlow = await flows.getFlow(flow.id)
  const third = await flows.runFlow(thirdFlow, { runId: flows.newRunId() })
  assert.equal(third.status, 'success')

  const firstAgain = await get(router, '/api/runs/' + first.id + '/compare')
  assert.equal(firstAgain.status, 200)
  assert.equal(firstAgain.body.comparable, false, '最早一条默认仍不硬凑对照')
  assert.equal(firstAgain.body.optionsTotal, 2)
  assert.equal(firstAgain.body.options.length, 2)
  assert.equal(firstAgain.body.options[0].id, third.id, '候选按开始时间倒序，最近的在前')

  const picked = await get(router, '/api/runs/' + first.id + '/compare?with=' + third.id)
  assert.equal(picked.status, 200)
  assert.equal(picked.body.comparable, true, '最早一条可以点名对照之后的一条')
  assert.equal(picked.body.current.id, first.id)
  assert.equal(picked.body.previous.id, third.id)
  assert.equal(picked.body.graph.changed, true)

  // 单节点输出差异：只读、按需，返回改动附近的行，不返回完整输出
  const diff = await get(router, '/api/runs/' + third.id + '/compare/diff?with=' + first.id + '&node=in')
  assert.equal(diff.status, 200)
  assert.equal(diff.body.nodeId, 'in')
  assert.equal(diff.body.outputKind, 'text')
  assert.equal(diff.body.stats.added, 1)
  assert.equal(diff.body.stats.removed, 1)
  assert.equal(diff.body.lines.some((line) => line.op === 'del' && line.text.includes('第一次的输入')), true)
  assert.equal(diff.body.lines.some((line) => line.op === 'add' && line.text.includes('第三次的输入')), true)
  assert.equal(JSON.stringify(diff.body).includes('"output":'), false)

  assert.equal((await get(router, '/api/runs/' + third.id + '/compare/diff?node=in')).status, 400)
  assert.equal((await get(router, '/api/runs/' + third.id + '/compare/diff?with=' + first.id)).status, 400)
  assert.equal((await get(router, '/api/runs/' + third.id + '/compare/diff?with=' + third.id + '&node=in')).status, 400)
  assert.equal((await get(router, '/api/runs/' + third.id + '/compare/diff?with=' + first.id + '&node=nope')).status, 404)
  const crossDiff = await get(router, '/api/runs/' + third.id + '/compare/diff?with=' + otherRun.id + '&node=in')
  assert.equal(crossDiff.status, 400)
  assert.match(crossDiff.body.error, /不属于同一件作品/)

  // 跨版本对照（v0.9.113）：同一件作品开过新版后，两张画布上的运行可以挑来对照。
  // 节点 id 由开新版时的复制保留，所以「同一节点」仍能按 id 对齐。
  const v1 = await flows.createFlow({
    name: '跨版作品 v1',
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { title: '输入', description: '', config: { text: '旧版的输入' } } },
      { id: 'out', type: 'output', position: { x: 300, y: 0 }, data: { title: '输出', description: '', config: { format: 'markdown' } } },
    ],
    edges: [{ id: 'e1', source: 'in', target: 'out' }],
  })
  const project = await projects.createProject({ title: '跨版作品', flowId: v1.id })
  const v1Run = await flows.runFlow(v1, { runId: flows.newRunId() })
  const v2 = await flows.createFlow({
    name: '跨版作品 v2',
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { title: '输入', description: '', config: { text: '新版的输入' } } },
      { id: 'out', type: 'output', position: { x: 300, y: 0 }, data: { title: '输出', description: '', config: { format: 'markdown' } } },
    ],
    edges: [{ id: 'e1', source: 'in', target: 'out' }],
  })
  await projects.archiveProjectVersion(project.id, { flowId: v2.id, prevName: v1.name })
  const v2Run = await flows.runFlow(await flows.getFlow(v2.id), { runId: flows.newRunId() })

  const crossVersion = await get(router, '/api/runs/' + v2Run.id + '/compare?with=' + v1Run.id)
  assert.equal(crossVersion.status, 200)
  assert.equal(crossVersion.body.comparable, true)
  assert.equal(crossVersion.body.crossVersion, true)
  assert.equal(crossVersion.body.project.title, '跨版作品')
  assert.equal(crossVersion.body.current.project.version, 2)
  assert.equal(crossVersion.body.previous.project.version, 1)
  assert.equal(crossVersion.body.optionsScoped, 'project')
  assert.equal(crossVersion.body.options.some((item) => item.id === v1Run.id && item.project.version === 1), true)
  const crossInput = crossVersion.body.nodes.find((item) => item.id === 'in')
  assert.equal(crossInput.added, false, '两张画布上的同 id 节点应能对上')
  assert.equal(crossInput.outputChanged, true)
  assert.equal(crossInput.revisionChanged, true)

  // 默认仍只取同一条画布更早的一条：跨版本要人自己点名，不替人改对照口径
  const defaultOnV2 = await get(router, '/api/runs/' + v2Run.id + '/compare')
  assert.equal(defaultOnV2.status, 200)
  assert.equal(defaultOnV2.body.comparable, false)
  assert.equal(defaultOnV2.body.options.some((item) => item.id === v1Run.id), true)
  assert.match(defaultOnV2.body.reason, /其它版本/)

  const crossVersionDiff = await get(router, '/api/runs/' + v2Run.id + '/compare/diff?with=' + v1Run.id + '&node=in')
  assert.equal(crossVersionDiff.status, 200)
  assert.equal(crossVersionDiff.body.lines.some((line) => line.op === 'add' && line.text.includes('新版的输入')), true)
  assert.equal(crossVersionDiff.body.lines.some((line) => line.op === 'del' && line.text.includes('旧版的输入')), true)

  // 别的作品的画布仍然不能硬凑
  const unrelated = await get(router, '/api/runs/' + v2Run.id + '/compare?with=' + otherRun.id)
  assert.equal(unrelated.status, 400)
  assert.match(unrelated.body.error, /不属于同一件作品/)
})
