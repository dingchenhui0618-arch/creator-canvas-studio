// 任意两版对照（v0.9.117）：只读接口的明细与边界。
// 这一组盯住五件事：
//   1) 任意两版都能选，方向按 base → target，反过来就是看「改回去了什么」；
//   2) 画布逐项列出多 / 少 / 改的节点，脚本逐段列出多 / 少 / 改，改过的段带前后口播；
//   3) 当前版读现在的画布与脚本，归档版读自己的快照，不拿别的版本顶替；
//   4) 缺画布 / 缺脚本快照时明细为 null，notes 说清哪一侧不比；
//   5) 只读：对照前后作品、版本与脚本一个字都不变。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-version-compare-'))
process.env.VQ_KEY_SECRET = 'test-secret-version-compare'

const projects = await import('../server/projects.mjs')
const flows = await import('../server/flows.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')

function mockReq({ method = 'GET', body = null } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = body ? { 'content-type': 'application/json' } : {}
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body === null) req.push(null)
  else {
    req.push(JSON.stringify(body))
    req.push(null)
  }
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

async function call(method, pathname, body = null) {
  const res = mockRes()
  const url = new URL('http://vq.local' + pathname)
  await createProjectsRouter().handle(mockReq({ method, body }), res, url, url.pathname)
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') }
}

const node = (id, type, title, config) => ({ id, type, data: { title, config } })
const script = (hook, beats) => ({
  hook,
  structure: beats.map(([beat, voiceover], index) => ({
    beat,
    voiceover,
    onScreen: '',
    purpose: '',
    startSec: index * 4,
    endSec: index * 4 + 4,
  })),
  source: 'project',
  updatedAt: '2026-11-14T12:00:00.000Z',
})

const scriptA = script('第一版钩子', [['开场', '同一句'], ['闷蒸', '第一版闷蒸']])
const scriptB = script('第二版钩子', [['开场', '同一句'], ['闷蒸', '第二版闷蒸'], ['收尾', '第二版新增']])
const scriptC = script('第二版钩子', [['开场', '同一句'], ['闷蒸', '第二版闷蒸'], ['收尾', '第二版新增']])

const nodesV1 = [node('n_input', 'input', '输入', { text: '第一版' }), node('n_llm', 'llm', '写一句', { systemPrompt: '第一版提示词' }), node('n_out', 'output', '输出', { format: 'markdown' })]
const nodesV2 = [node('n_input', 'input', '输入', { text: '第一版' }), node('n_llm', 'llm', '写一句', { systemPrompt: '第二版提示词' }), node('n_out', 'output', '输出', { format: 'markdown' }), node('n_image', 'output', '出图', { format: 'markdown' })]
const nodesV3 = [node('n_input', 'input', '输入', { text: '第三版' }), node('n_llm', 'llm', '写一句', { systemPrompt: '第二版提示词' }), node('n_out', 'output', '输出', { format: 'markdown' })]

async function buildProject(title) {
  const v1 = await flows.createFlow({ name: title + ' v1', nodes: nodesV1, edges: [] })
  const project = await projects.createProject({ title, flowId: v1.id })
  await projects.saveProjectScript(project.id, scriptA)
  const v2 = await call('POST', '/api/projects/' + project.id + '/versions', {})
  assert.equal(v2.status, 201)
  await flows.updateFlow(v2.body.flow.id, { nodes: nodesV2 })
  await projects.saveProjectScript(project.id, scriptB)
  const v3 = await call('POST', '/api/projects/' + project.id + '/versions', {})
  assert.equal(v3.status, 201)
  await flows.updateFlow(v3.body.flow.id, { nodes: nodesV3 })
  await projects.saveProjectScript(project.id, scriptC)
  return { project, v1: v1.id, v2: v2.body.flow.id, v3: v3.body.flow.id }
}

test('任意两版对照：明细逐项列出，当前版读现在的、归档版读快照', async () => {
  const built = await buildProject('两版对照验收')
  const before = await call('GET', '/api/projects/' + built.project.id)

  const res = await call('GET', '/api/projects/' + built.project.id + '/versions/compare?base=1&target=3')
  assert.equal(res.status, 200)
  assert.equal(res.body.base.n, 1)
  assert.equal(res.body.target.n, 3)
  assert.equal(res.body.base.name, '两版对照验收 v1')
  assert.equal(res.body.target.name, '两版对照验收')
  assert.equal(res.body.target.current, true)
  assert.equal(res.body.base.nodes, 3)
  assert.equal(res.body.target.nodes, 3)
  assert.equal(res.body.base.beats, 2)
  assert.equal(res.body.target.beats, 3)
  assert.match(res.body.summary, /画布/)
  assert.match(res.body.summary, /脚本/)
  assert.match(res.body.summary, /钩子换过/)

  assert.deepEqual(res.body.canvas.added, [])
  assert.deepEqual(res.body.canvas.removed, [])
  assert.deepEqual(res.body.canvas.changed.map((item) => item.title).sort(), ['写一句', '输入'])
  const inputFields = res.body.canvas.fields.n_input
  assert.deepEqual(inputFields.map((item) => [item.label, item.before, item.after]), [['输入文本', '第一版', '第三版']])
  const llmFields = res.body.canvas.fields.n_llm
  assert.deepEqual(llmFields.map((item) => [item.label, item.before, item.after]), [['提示词', '第一版提示词', '第二版提示词']])
  assert.deepEqual(res.body.script.added, ['收尾'])
  assert.deepEqual(res.body.script.removed, [])
  assert.deepEqual(res.body.script.changed, [{
    name: '闷蒸',
    before: ['第一版闷蒸'],
    after: ['第二版闷蒸'],
  }])
  assert.equal(res.body.script.hookChanged, true)
  assert.equal(res.body.script.hookBefore, '第一版钩子')
  assert.equal(res.body.script.hookAfter, '第二版钩子')
  assert.deepEqual(res.body.notes, [])

  // 方向反过来：多 / 少跟着换边，钩子的前后也换边
  const reverse = await call('GET', '/api/projects/' + built.project.id + '/versions/compare?base=3&target=1')
  assert.equal(reverse.status, 200)
  assert.deepEqual(reverse.body.script.added, [])
  assert.deepEqual(reverse.body.script.removed, ['收尾'])
  assert.equal(reverse.body.script.hookBefore, '第二版钩子')
  assert.equal(reverse.body.script.hookAfter, '第一版钩子')
  assert.deepEqual(reverse.body.canvas.fields.n_input.map((item) => [item.before, item.after]), [['第三版', '第一版']])

  // 1 → 2 能看到 v2 新增的「出图」节点；2 → 3 只剩画布变化
  const oneToTwo = await call('GET', '/api/projects/' + built.project.id + '/versions/compare?base=1&target=2')
  assert.equal(oneToTwo.status, 200)
  assert.deepEqual(oneToTwo.body.canvas.added.map((item) => item.title), ['出图'])
  const twoToThree = await call('GET', '/api/projects/' + built.project.id + '/versions/compare?base=2&target=3')
  assert.equal(twoToThree.status, 200)
  assert.deepEqual(twoToThree.body.script.added, [])
  assert.deepEqual(twoToThree.body.script.removed, [])
  assert.deepEqual(twoToThree.body.script.changed, [])
  assert.equal(twoToThree.body.script.hookChanged, false)
  assert.deepEqual(twoToThree.body.canvas.removed.map((item) => item.title), ['出图'])

  // 只读：对照前后作品一个字都不变
  const after = await call('GET', '/api/projects/' + built.project.id)
  assert.equal(after.body.project.version, before.body.project.version)
  assert.equal(after.body.script.hook, before.body.script.hook)
  assert.deepEqual(after.body.versions, before.body.versions)
  assert.equal(after.body.project.updatedAt, before.body.project.updatedAt)
})

test('版次不对、选同一版：明确拒绝，不偷偷读别的版本', async () => {
  const list = await projects.listProjects()
  const project = list.find((item) => item.title === '两版对照验收')
  assert.ok(project)

  const zero = await call('GET', '/api/projects/' + project.id + '/versions/compare?base=0&target=2')
  assert.equal(zero.status, 400)
  assert.equal(zero.body.code, 'VERSION_COMPARE_INVALID')

  const tooNew = await call('GET', '/api/projects/' + project.id + '/versions/compare?base=1&target=99')
  assert.equal(tooNew.status, 400)
  assert.equal(tooNew.body.code, 'VERSION_COMPARE_INVALID')

  const missing = await call('GET', '/api/projects/' + project.id + '/versions/compare?base=1')
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'VERSION_COMPARE_INVALID')

  const same = await call('GET', '/api/projects/' + project.id + '/versions/compare?base=2&target=2')
  assert.equal(same.status, 400)
  assert.equal(same.body.code, 'VERSION_COMPARE_SAME')
})

test('缺画布 / 缺脚本快照：明细为 null，notes 说清哪一侧不比', async () => {
  // 无脚本快照：v1 开版时没存脚本
  const bareFlow = await flows.createFlow({ name: '无脚本对照 v1', nodes: nodesV1, edges: [] })
  const bare = await projects.createProject({ title: '无脚本对照', flowId: bareFlow.id })
  const bumped = await call('POST', '/api/projects/' + bare.id + '/versions', {})
  assert.equal(bumped.status, 201)
  const noScript = await call('GET', '/api/projects/' + bare.id + '/versions/compare?base=1&target=2')
  assert.equal(noScript.status, 200)
  assert.equal(noScript.body.script, null)
  assert.ok(noScript.body.canvas)
  assert.ok(noScript.body.notes.some((note) => note.includes('脚本快照')))
  assert.doesNotMatch(noScript.body.summary, /脚本跟.*一样/)

  // 画布被删：v1 的画布删掉，脚本快照仍然可比
  const goneFlow = await flows.createFlow({ name: '画布被删对照 v1', nodes: nodesV1, edges: [] })
  const gone = await projects.createProject({ title: '画布被删对照', flowId: goneFlow.id })
  await projects.saveProjectScript(gone.id, scriptA)
  const goneV2 = await call('POST', '/api/projects/' + gone.id + '/versions', {})
  assert.equal(goneV2.status, 201)
  await flows.deleteFlow(goneFlow.id)
  const noCanvas = await call('GET', '/api/projects/' + gone.id + '/versions/compare?base=1&target=2')
  assert.equal(noCanvas.status, 200)
  assert.equal(noCanvas.body.canvas, null)
  assert.ok(noCanvas.body.script)
  assert.ok(noCanvas.body.notes.some((note) => note.includes('画布已被删除')))
  assert.match(noCanvas.body.summary, /脚本/)
})
