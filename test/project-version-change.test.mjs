// 版本行「比上一版改了什么」与旧版脚本快照（v0.9.114）。
// 这一组盯住四件事：
//   1) 作品详情带 versionChanges，只给一句话，不把节点数组塞进响应；
//   2) 快照按版次取：v1 是当时的 A，当前版是现在的 B，不拿现在的脚本冒充历史；
//   3) 没开过的版次 404，不编一份空脚本；
//   4) 普通详情不带 scriptSnapshot（正文只在导出 / 点开时取）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-version-change-'))
process.env.VQ_KEY_SECRET = 'test-secret-version-change'

const projects = await import('../server/projects.mjs')
const flows = await import('../server/flows.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')

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

async function get(pathname) {
  const res = mockRes()
  const url = new URL('http://vq.local' + pathname)
  await createProjectsRouter().handle(mockReq(), res, url, url.pathname)
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') }
}

const node = (text, title = '写一句') => ({
  id: 'n_llm',
  type: 'llm',
  data: { title, config: { systemPrompt: text } },
})

const script = (hook, beats) => ({
  hook,
  structure: beats.map(([beat, voiceover], index) => ({
    beat,
    voiceover,
    onScreen: '',
    purpose: '',
    startSec: index * 3,
    endSec: index * 3 + 3,
  })),
  source: 'project',
  updatedAt: '2026-11-14T12:00:00.000Z',
})

test('详情里的 versionChanges：v2、v3 各一句，普通详情不带节点与快照正文', async () => {
  const v1 = await flows.createFlow({ name: '版本改动 v1', nodes: [node('第一版')], edges: [] })
  const v2 = await flows.createFlow({ name: '版本改动 v2', nodes: [node('第二版')], edges: [] })
  const v3 = await flows.createFlow({ name: '版本改动 v3', nodes: [node('第三版')], edges: [] })
  const project = await projects.createProject({ title: '版本改动', flowId: v1.id })

  const A = script('旧钩子', [['开场', '第一版的一句']])
  const B = script('新钩子', [['开场', '第一版的一句'], ['收尾', '第二版加的一句']])
  await projects.saveProjectScript(project.id, A)
  await projects.archiveProjectVersion(project.id, { flowId: v2.id, prevName: '版本改动 v1', script: A })
  await projects.saveProjectScript(project.id, B)
  await projects.archiveProjectVersion(project.id, { flowId: v3.id, prevName: '版本改动 v2', script: B })

  const detail = await get('/api/projects/' + project.id)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.project.version, 3)
  assert.equal(detail.body.versions.length, 2)
  const changes = detail.body.versionChanges || {}
  assert.match(changes['2'], /画布改 1 个（写一句）/, 'v2 应说画布改过')
  assert.match(changes['2'], /脚本多 1 段（收尾）/, 'v2 应说脚本多了收尾')
  assert.match(changes['2'], /钩子换过/, 'v2 应说钩子换过')
  assert.match(changes['3'], /画布改 1 个（写一句）/, 'v3 应说画布改过')
  assert.equal(changes['1'], undefined, '最早一版没有「比上一版」')
  // 页面只需要一句话：节点数组与快照正文不进普通详情
  assert.ok(detail.body.versions.every((entry) => !('nodeList' in entry)), '普通详情不带节点数组')
  assert.ok(detail.body.versions.every((entry) => !('scriptSnapshot' in entry)), '普通详情不带脚本正文')
})

test('旧版脚本按版次取：v1 是 A，当前版是 B；没开过的版次 404', async () => {
  const list = await projects.listProjects()
  const project = list.find((item) => item.title === '版本改动')
  assert.ok(project, '上一组建的作品应还在')

  const v1 = await get('/api/projects/' + project.id + '/versions/1/script')
  assert.equal(v1.status, 200)
  assert.equal(v1.body.script.hook, '旧钩子')
  assert.equal(v1.body.script.structure.length, 1)
  assert.equal(v1.body.current, false)

  const v3 = await get('/api/projects/' + project.id + '/versions/3/script')
  assert.equal(v3.status, 200)
  assert.equal(v3.body.current, true)
  assert.equal(v3.body.script.hook, '新钩子')
  assert.equal(v3.body.script.structure.length, 2)

  const missing = await get('/api/projects/' + project.id + '/versions/9/script')
  assert.equal(missing.status, 404)
  assert.match(missing.body.error, /没有 v9/)
})
