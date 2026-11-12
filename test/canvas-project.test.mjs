import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 画布挂在作品上（v0.9.34）：画布是从作品某一步被带进来的能力，进去以后得知道在帮哪条作品、哪一版，
// 并且走得回去。这一组盯四条口径：
//   1. 一块画布挂在哪条作品的第几版，按运行/评审同一张索引算（归档版也认得出，没归作品就是 null）；
//   2. 列表、详情、保存回来的画布都带同一个 project 字段，前端不会把上下文丢掉；
//   3. 新建的流程一律 project: null——不编一条「未命名作品」出来；
//   4. 别人账号的作品不出现在自己的画布上（看得见才认得出）。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-canvas-project-'))
process.env.DATA_DIR = dir

const at = (day, hour) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'

const projects = [
  {
    id: 'prj_a',
    ownerId: 'u_a',
    title: '毛衣折叠收纳法',
    templateId: 'tpl_a',
    flowId: 'flow_cur',
    version: 3,
    versions: [{ n: 2, flowId: 'flow_arch', name: '第二版画布', archivedAt: at(5, 0) }],
    status: 'active',
    createdAt: at(1, 0),
    updatedAt: at(6, 0),
  },
  {
    id: 'prj_b',
    ownerId: 'u_b',
    title: '别人的作品',
    templateId: '',
    flowId: 'flow_b',
    version: 1,
    versions: [],
    status: 'active',
    createdAt: at(1, 1),
    updatedAt: at(2, 1),
  },
]

const flows = [
  { id: 'flow_cur', name: '毛衣折叠收纳法 v3', nodes: [], edges: [], ownerId: 'u_a', createdAt: at(2, 0), updatedAt: at(6, 0) },
  { id: 'flow_arch', name: '毛衣折叠收纳法 v2', nodes: [], edges: [], ownerId: 'u_a', createdAt: at(2, 1), updatedAt: at(5, 0) },
  { id: 'flow_free', name: '空白画布 · 还没归谁', nodes: [], edges: [], ownerId: 'u_a', createdAt: at(2, 2), updatedAt: at(3, 0) },
  { id: 'flow_b', name: '别人那块画布', nodes: [], edges: [], ownerId: 'u_b', createdAt: at(2, 3), updatedAt: at(2, 3) },
]

fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(flows, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')

const me = { id: 'u_a' }

test('画布挂在哪条作品：当前版、归档版、没归作品三种都说得清', async () => {
  const { projectsByFlow, withFlowProject } = await import('../server/run-ownership.mjs')
  const { listProjects } = await import('../server/projects.mjs')
  const byFlow = projectsByFlow(await listProjects(me))

  const [current, archived, free] = withFlowProject(
    [{ id: 'flow_cur' }, { id: 'flow_arch' }, { id: 'flow_free' }],
    byFlow,
  )
  assert.deepEqual(current.project, { id: 'prj_a', title: '毛衣折叠收纳法', version: 3, archived: false })
  assert.deepEqual(archived.project, { id: 'prj_a', title: '毛衣折叠收纳法', version: 2, archived: true }, '归档版也认得出是第几版')
  assert.equal(free.project, null, '空白画布不编一条作品出来')
  assert.equal(withFlowProject([{ id: 'flow_b' }], byFlow)[0].project, null, '别人的作品不在自己的画布上认')

  // 原有的字段一个字都不动
  assert.equal(current.id, 'flow_cur')
  assert.equal(archived.project.archived, true)

  assert.deepEqual(withFlowProject([{ id: 'flow_cur' }], new Map())[0].project, null)
  assert.deepEqual(withFlowProject([], byFlow), [])
  assert.deepEqual(withFlowProject(undefined, undefined), [])
})

test('接口：列表、详情、保存回来的画布都带同一个 project，新建的流程是 null', async () => {
  const { createFlowsRouter } = await import('../server/routes/flows.mjs')
  const router = createFlowsRouter()

  const call = async (method, pathname, body) => {
    const res = {
      status: 0,
      body: '',
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers || {}
      },
      setHeader(key, value) {
        this.headers[key] = value
      },
      end(chunk) {
        this.body = String(chunk ?? '')
      },
      write(chunk) {
        this.body += String(chunk ?? '')
        return true
      },
      writableEnded: false,
    }
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(payload) } }
    const url = new URL('http://localhost' + pathname)
    await router.handle(req, res, url, url.pathname)
    return { status: res.status, body: JSON.parse(res.body || '{}') }
  }

  const list = await call('GET', '/api/flows')
  assert.equal(list.status, 200)
  const byId = new Map(list.body.items.map((flow) => [flow.id, flow]))
  assert.deepEqual(byId.get('flow_cur').project, { id: 'prj_a', title: '毛衣折叠收纳法', version: 3, archived: false })
  assert.equal(byId.get('flow_arch').project.version, 2)
  assert.equal(byId.get('flow_arch').project.archived, true)
  assert.equal(byId.get('flow_free').project, null)

  const detail = await call('GET', '/api/flows/flow_cur')
  assert.equal(detail.body.project.id, 'prj_a')
  assert.equal(detail.body.name, '毛衣折叠收纳法 v3', '详情原有的字段照旧')

  const saved = await call('PATCH', '/api/flows/flow_cur', { name: '毛衣折叠收纳法 v3', nodes: [], edges: [] })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.project.version, 3, '保存回来的画布同样带着作品，前端替换列表项时不会丢上下文')

  const created = await call('POST', '/api/flows', { name: '新画布', nodes: [], edges: [] })
  assert.equal(created.status, 201)
  assert.equal(created.body.project, null, '新建的画布不编一条作品')

  const missing = await call('GET', '/api/flows/flow_nope')
  assert.equal(missing.status, 404)
})
