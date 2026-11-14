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
const { saveReview } = await import('../server/reviews.mjs')
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

// 打印页回的是 HTML，不是 JSON：单独一个调用器，别让 JSON.parse 把纸吞了。
async function callHtml(pathname) {
  const res = mockRes()
  const url = new URL('http://vq.local' + pathname)
  await createProjectsRouter().handle(mockReq({ method: 'GET' }), res, url, url.pathname)
  return { status: res.statusCode, headers: res.headers, body: res.body }
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

const reviewResult = (verdict, observations) => ({
  verdict,
  summary: verdict === 'pass' ? '画面可以交' : '还有一处要改',
  observations: observations.map((severity) => ({ severity, note: '问题' })),
})

async function buildProject(title) {
  const v1 = await flows.createFlow({ name: title + ' v1', nodes: nodesV1, edges: [] })
  const project = await projects.createProject({ title, flowId: v1.id })
  await projects.saveProjectScript(project.id, scriptA)
  await saveReview({
    projectId: project.id,
    version: 1,
    intent: 'v1 验收',
    result: reviewResult('pass', ['major', 'major']),
    credits: { cost: 5, balance: 95 },
  })
  const v2 = await call('POST', '/api/projects/' + project.id + '/versions', {})
  assert.equal(v2.status, 201)
  await flows.updateFlow(v2.body.flow.id, { nodes: nodesV2 })
  await projects.saveProjectScript(project.id, scriptB)
  await saveReview({
    projectId: project.id,
    version: 2,
    intent: 'v2 验收',
    result: reviewResult('pass', ['major']),
    credits: { cost: 5, balance: 90 },
  })
  // v2 交出去：交付记录里带着当时的评审快照，之后开 v3 不覆盖它
  const delivered = await call('PATCH', '/api/projects/' + project.id, { status: 'done' })
  assert.equal(delivered.status, 200)
  const v3 = await call('POST', '/api/projects/' + project.id + '/versions', {})
  assert.equal(v3.status, 201)
  await flows.updateFlow(v3.body.flow.id, { nodes: nodesV3 })
  await projects.saveProjectScript(project.id, scriptC)
  await saveReview({
    projectId: project.id,
    version: 3,
    intent: 'v3 验收',
    result: reviewResult('needs_review', ['blocker', 'major']),
    credits: { cost: 5, balance: 85 },
  })
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

  // 评审与交付（v0.9.119）：两侧各读这一版最近一评，交付只认这一版的记录
  assert.equal(res.body.base.review.count, 1)
  assert.equal(res.body.base.review.verdict, 'pass')
  assert.deepEqual(res.body.base.review.issues, { blocker: 0, major: 2, minor: 0, info: 0, counted: 2, observations: 2 })
  assert.equal(res.body.target.review.count, 1)
  assert.equal(res.body.target.review.verdict, 'needs_review')
  assert.deepEqual(res.body.target.review.issues, { blocker: 1, major: 1, minor: 0, info: 0, counted: 2, observations: 2 })
  assert.equal(res.body.base.delivery, null)
  assert.equal(res.body.target.delivery, null)
  assert.deepEqual(res.body.reviewChange, {
    text: '结论从「通过」变成「需人工确认」',
    tone: 'worse',
  })

  // 方向反过来：多 / 少跟着换边，钩子的前后也换边
  const reverse = await call('GET', '/api/projects/' + built.project.id + '/versions/compare?base=3&target=1')
  assert.equal(reverse.status, 200)
  assert.deepEqual(reverse.body.script.added, [])
  assert.deepEqual(reverse.body.script.removed, ['收尾'])
  assert.equal(reverse.body.script.hookBefore, '第二版钩子')
  assert.equal(reverse.body.script.hookAfter, '第一版钩子')
  assert.deepEqual(reverse.body.reviewChange, {
    text: '结论从「需人工确认」变成「通过」',
    tone: 'better',
  })
  assert.deepEqual(reverse.body.canvas.fields.n_input.map((item) => [item.before, item.after]), [['第三版', '第一版']])

  // 1 → 2 能看到 v2 新增的「出图」节点；2 → 3 只剩画布变化
  const oneToTwo = await call('GET', '/api/projects/' + built.project.id + '/versions/compare?base=1&target=2')
  assert.equal(oneToTwo.status, 200)
  assert.deepEqual(oneToTwo.body.canvas.added.map((item) => item.title), ['出图'])
  // v2 交过：交付时间落在 v2 这一侧；v1 没交
  assert.equal(oneToTwo.body.base.review.verdict, 'pass')
  assert.equal(oneToTwo.body.base.delivery, null)
  assert.equal(oneToTwo.body.target.review.verdict, 'pass')
  assert.ok(oneToTwo.body.target.delivery)
  assert.ok(oneToTwo.body.target.delivery.at.length > 0, 'v2 交付记录应有时间')
  // 交时评审快照（v0.9.120）：交付那一刻 v2 是通过、1 个主要，不随后来的重评改写
  assert.equal(oneToTwo.body.target.delivery.review.verdict, 'pass')
  assert.deepEqual(oneToTwo.body.target.delivery.review.issues, {
    blocker: 0,
    major: 1,
    minor: 0,
    info: 0,
    counted: 1,
    observations: 1,
  })
  assert.equal(oneToTwo.body.target.delivery.review.at, oneToTwo.body.target.review.at, '交时评审时间应是交付当时的最近一评')
  assert.deepEqual(oneToTwo.body.reviewChange, { text: '主要少 1 个', tone: 'better' })
  const twoToThree = await call('GET', '/api/projects/' + built.project.id + '/versions/compare?base=2&target=3')
  assert.equal(twoToThree.status, 200)
  assert.deepEqual(twoToThree.body.script.added, [])
  assert.deepEqual(twoToThree.body.script.removed, [])
  assert.deepEqual(twoToThree.body.script.changed, [])
  assert.equal(twoToThree.body.script.hookChanged, false)
  assert.deepEqual(twoToThree.body.canvas.removed.map((item) => item.title), ['出图'])
  assert.equal(twoToThree.body.base.delivery.review.verdict, 'pass', 'v2 那一侧仍带交时快照')

  // 对照纸（v0.9.121）：与弹窗同一份取数，排成 A4；不是 JSON、不改任何东西
  const sheet = await callHtml('/print/projects/' + built.project.id + '/versions/compare?base=2&target=3&tz=480')
  assert.equal(sheet.status, 200)
  assert.match(sheet.headers['Content-Type'] || sheet.headers['content-type'], /text\/html/)
  assert.match(sheet.body, /两版对照 · 两版对照验收/)
  assert.match(sheet.body, /v2 → v3/)
  assert.match(sheet.body, /交时评审：通过 · 1 主要/)
  assert.match(sheet.body, /交付过 · /)
  assert.match(sheet.body, /data-print/)
  assert.doesNotMatch(sheet.body, /undefined/, '纸上不能漏出 undefined')
  const badSheet = await callHtml('/print/projects/' + built.project.id + '/versions/compare?base=2&target=2&tz=480')
  assert.equal(badSheet.status, 400)
  assert.match(badSheet.body, /这两版对不上/)

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
  assert.equal(noScript.body.base.review.count, 0)
  assert.equal(noScript.body.target.review.count, 0)
  assert.equal(noScript.body.reviewChange.tone, 'unknown')
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
