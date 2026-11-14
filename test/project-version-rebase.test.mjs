// 以旧版为底开新版（v0.9.115），以及回退版的底座对账（v0.9.116）。
// 这一组盯住五件事：
//   1) from 指向归档版时，新画布复制那一版，新脚本也换成那一版的快照；
//   2) 当前版照常归档，v1 / v2 / v3 各自的话都还在；
//   3) 新一版记住 basedOn，详情里的改动按底座算，不再拿上一版当基准；
//   4) 没存脚本快照的版本不允许整版回退，409 说清原因；
//   5) from 越界 / 不存在的版次不偷偷退回「从当前版开」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-version-rebase-'))
process.env.VQ_KEY_SECRET = 'test-secret-version-rebase'

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

const node = (text) => ({
  id: 'n_llm',
  type: 'llm',
  data: { title: '写一句', config: { systemPrompt: text } },
})
const script = (hook, voiceover) => ({
  hook,
  structure: [{ beat: '开场', voiceover, startSec: 0, endSec: 3 }],
  source: 'project',
  updatedAt: '2026-11-14T12:00:00.000Z',
})

test('from 指向旧版：新画布和新脚本都回到那一版，当前版照常归档', async () => {
  const v1 = await flows.createFlow({ name: '回退验收 v1', nodes: [node('第一版提示词')], edges: [] })
  const project = await projects.createProject({ title: '回退验收', flowId: v1.id })
  const A = script('第一版的钩子', '第一版的一句')
  const B = script('第二版的钩子', '第二版改过的一句')
  const C = script('第三版的钩子', '第三版又改了一句')
  await projects.saveProjectScript(project.id, A)

  const v2 = await call('POST', '/api/projects/' + project.id + '/versions', {})
  assert.equal(v2.status, 201)
  assert.equal(v2.body.project.version, 2)
  await flows.updateFlow(v2.body.flow.id, { nodes: [node('第二版提示词')] })
  await projects.saveProjectScript(project.id, B)

  const v3 = await call('POST', '/api/projects/' + project.id + '/versions', {})
  assert.equal(v3.status, 201)
  assert.equal(v3.body.project.version, 3)
  await flows.updateFlow(v3.body.flow.id, { nodes: [node('第三版提示词')] })
  await projects.saveProjectScript(project.id, C)

  const v4 = await call('POST', '/api/projects/' + project.id + '/versions', { from: 1 })
  assert.equal(v4.status, 201)
  assert.equal(v4.body.basedOn, 1)
  assert.equal(v4.body.project.version, 4)
  assert.match(v4.body.flow.name, /以 v1 为底/)
  assert.equal(v4.body.project.script.hook, '第一版的钩子', '新一版脚本要回到 v1 快照')
  assert.equal(v4.body.project.versions.length, 3)
  assert.equal(v4.body.project.versions[0].script.hook, '第一版的钩子')
  assert.equal(v4.body.project.versions[1].script.hook, '第二版的钩子')
  assert.equal(v4.body.project.versions[2].script.hook, '第三版的钩子')

  const copied = await flows.getFlow(v4.body.flow.id)
  assert.equal(copied.nodes[0].data.config.systemPrompt, '第一版提示词', '新画布要复制 v1 的节点，不是 v3 的')

  const detail = await call('GET', '/api/projects/' + project.id)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.project.version, 4)
  assert.equal(detail.body.script.hook, '第一版的钩子')
  assert.equal(detail.body.versions.length, 3)
  assert.equal(detail.body.project.basedOn, 1, 'v4 的来源要写进作品')
  assert.deepEqual(
    detail.body.versionBaseChanges['4'],
    { base: 1, text: '画布与脚本都没动' },
    'v4 是照 v1 复制的，跟底座对账应说没动',
  )
  assert.equal(detail.body.versions[2].basedOn, 0, 'v3 不是回退来的')
  // 老前端口径不变：versionChanges 仍然按上一版算，避免「比 v3」被静默改掉
  assert.match(detail.body.versionChanges['4'], /脚本/, 'v4 相对 v3 要有改动句')
  assert.match(detail.body.versionChanges['4'], /钩子换过/, 'v4 的脚本与 v3 不同')

  const old = await call('GET', '/api/projects/' + project.id + '/versions/3/script')
  assert.equal(old.body.script.hook, '第三版的钩子', 'v3 归档后仍然是它自己的脚本')
  const oldest = await call('GET', '/api/projects/' + project.id + '/versions/1/script')
  assert.equal(oldest.body.script.hook, '第一版的钩子')
})

test('from 越界或版本没有脚本快照：明确拒绝，不偷偷从当前版开', async () => {
  const list = await projects.listProjects()
  const project = list.find((item) => item.title === '回退验收')
  assert.ok(project)

  const tooNew = await call('POST', '/api/projects/' + project.id + '/versions', { from: 4 })
  assert.equal(tooNew.status, 400)
  assert.equal(tooNew.body.code, 'VERSION_FROM_INVALID')

  const missing = await call('POST', '/api/projects/' + project.id + '/versions', { from: 99 })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'VERSION_FROM_INVALID')

  // 另一条作品：v1 开版时没存脚本快照，from v1 只能拒绝
  const bareFlow = await flows.createFlow({ name: '无脚本 v1', nodes: [node('没有脚本')], edges: [] })
  const bare = await projects.createProject({ title: '无脚本回退', flowId: bareFlow.id })
  const bumped = await call('POST', '/api/projects/' + bare.id + '/versions', {})
  assert.equal(bumped.status, 201)
  const noSnapshot = await call('POST', '/api/projects/' + bare.id + '/versions', { from: 1 })
  assert.equal(noSnapshot.status, 409)
  assert.equal(noSnapshot.body.code, 'VERSION_SCRIPT_MISSING')
  assert.match(noSnapshot.body.error, /脚本快照/)
})

test('以旧版为底的一版归档后，来源跟着它走；新版不再继承底座', async () => {
  const base = await flows.createFlow({ name: '来源归档 v1', nodes: [node('第一版提示词')], edges: [] })
  const project = await projects.createProject({ title: '来源归档', flowId: base.id })
  await projects.saveProjectScript(project.id, script('来源的钩子', '来源的一句'))

  const v2 = await call('POST', '/api/projects/' + project.id + '/versions', {})
  assert.equal(v2.status, 201)
  const v3 = await call('POST', '/api/projects/' + project.id + '/versions', { from: 1 })
  assert.equal(v3.status, 201)
  assert.equal(v3.body.basedOn, 1)
  const v4 = await call('POST', '/api/projects/' + project.id + '/versions', {})
  assert.equal(v4.status, 201)
  assert.equal(v4.body.project.version, 4)
  assert.equal(v4.body.project.basedOn, 0, '普通开版不继承上一版的底座')

  const detail = await call('GET', '/api/projects/' + project.id)
  const archivedV3 = detail.body.versions.find((row) => row.n === 3)
  assert.ok(archivedV3, 'v3 应已归档')
  assert.equal(archivedV3.basedOn, 1, '归档后仍记得它是从 v1 回来的')
  assert.deepEqual(
    detail.body.versionBaseChanges['3'],
    { base: 1, text: '画布与脚本都没动' },
    'v3 归档后，对账仍然对 v1',
  )
  assert.equal(detail.body.versionBaseChanges['4'], undefined, 'v4 接着 v3 改，不写底座对账')
})
