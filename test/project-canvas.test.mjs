import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 画布归作品（v0.9.29）：一块空白画布跑出来的东西，得能变成一条作品。
// 这一组盯四条口径：
//   1. 一块画布只归一条作品（运行与评审都按 flowId 反查作品，归两条就有两个答案）；
//   2. 一条作品只有一块当前画布（直接换画布会让旧版的运行对不上号，要换先开新版）；
//   3. 归过去不复制运行记录：一接上，这块画布跑过的运行就是这条作品的运行；
//   4. 看得见才动得手：别人的作品、别人的画布一律 404，管理员照旧全通。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-canvas-adopt-'))
process.env.DATA_DIR = dir

const at = (day, hour) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'

const me = { id: 'u_a' }
const other = { id: 'u_b' }
const admin = { id: 'u_admin', kind: 'admin' }

/**
 * prj_free   u_a，还没开画布（version 0）：接受一块空白画布
 * prj_taken  u_a，已经绑着 flow_own（v2，v1 归档在 flow_old）：不能再塞第二块
 * prj_other  u_b 的作品，绑着 flow_b
 */
const projects = [
  {
    id: 'prj_free',
    ownerId: 'u_a',
    title: '还没开画布的作品',
    templateId: '',
    flowId: '',
    version: 0,
    versions: [],
    status: 'active',
    createdAt: at(1, 0),
    updatedAt: at(1, 0),
  },
  {
    id: 'prj_taken',
    ownerId: 'u_a',
    title: '已经有一块画布',
    templateId: '',
    flowId: 'flow_own',
    version: 2,
    versions: [{ n: 1, flowId: 'flow_old', name: '第一版画布', archivedAt: at(2, 0) }],
    status: 'active',
    createdAt: at(1, 1),
    updatedAt: at(2, 0),
  },
  {
    id: 'prj_route',
    ownerId: 'u_a',
    title: '接口那一条',
    templateId: '',
    flowId: '',
    version: 0,
    versions: [],
    status: 'active',
    createdAt: at(1, 3),
    updatedAt: at(1, 3),
  },
  {
    id: 'prj_other',
    ownerId: 'u_b',
    title: '别人的作品',
    templateId: '',
    flowId: 'flow_b',
    version: 1,
    versions: [],
    status: 'active',
    createdAt: at(1, 2),
    updatedAt: at(1, 2),
  },
]

const flows = [
  { id: 'flow_free', name: '空白画布 · 还没归谁', nodes: [], edges: [], ownerId: 'u_a', createdAt: at(3, 0), updatedAt: at(3, 0) },
  { id: 'flow_extra', name: '另一块空白画布', nodes: [], edges: [], ownerId: 'u_a', createdAt: at(3, 1), updatedAt: at(3, 1) },
  { id: 'flow_router', name: '路由那一块画布', nodes: [], edges: [], ownerId: 'u_a', createdAt: at(3, 2), updatedAt: at(3, 2) },
  { id: 'flow_router2', name: '照它建一条作品', nodes: [], edges: [], ownerId: 'u_a', createdAt: at(3, 3), updatedAt: at(3, 3) },
  { id: 'flow_router3', name: '接口从画布建的那条', nodes: [], edges: [], ownerId: 'u_a', createdAt: at(3, 7), updatedAt: at(3, 7) },
  { id: 'flow_own', name: '作品现在这块', nodes: [], edges: [], ownerId: 'u_a', createdAt: at(3, 4), updatedAt: at(3, 4) },
  { id: 'flow_old', name: '第一版画布', nodes: [], edges: [], ownerId: 'u_a', createdAt: at(3, 5), updatedAt: at(3, 5) },
  { id: 'flow_b', name: '别人那块画布', nodes: [], edges: [], ownerId: 'u_b', createdAt: at(3, 6), updatedAt: at(3, 6) },
]

const runs = [
  { id: 'run_free1', flowId: 'flow_free', flowName: '空白画布 · 还没归谁', ownerId: 'u_a', status: 'success', startedAt: at(4, 1), finishedAt: at(4, 1), durationMs: 1200, total: 1, nodes: [] },
  { id: 'run_router1', flowId: 'flow_router', flowName: '路由那一块画布', ownerId: 'u_a', status: 'success', startedAt: at(4, 2), finishedAt: at(4, 2), durationMs: 900, total: 1, nodes: [] },
  { id: 'run_own1', flowId: 'flow_own', flowName: '作品现在这块', ownerId: 'u_a', status: 'success', startedAt: at(4, 3), finishedAt: at(4, 3), durationMs: 800, total: 1, nodes: [] },
  { id: 'run_b1', flowId: 'flow_b', flowName: '别人那块画布', ownerId: 'u_b', status: 'success', startedAt: at(4, 4), finishedAt: at(4, 4), durationMs: 700, total: 1, nodes: [] },
]

fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(flows, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify(runs, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')

const canvasModule = () => import('../server/project-canvas.mjs')
const ownership = () => import('../server/run-ownership.mjs')
const projectsModule = () => import('../server/projects.mjs')

test('画布归谁读的就是那张索引：当前版与归档版都算', async () => {
  const { canvasOwner } = await canvasModule()
  const { projectsByFlow } = await ownership()
  const byFlow = projectsByFlow(await projectsModule().then((mod) => mod.listProjects(me)))
  assert.equal(canvasOwner(byFlow, 'flow_own').id, 'prj_taken')
  assert.equal(canvasOwner(byFlow, 'flow_old').version, 1, '归档版也认得出是哪条作品的第几版')
  assert.equal(canvasOwner(byFlow, 'flow_old').archived, true)
  assert.equal(canvasOwner(byFlow, 'flow_free'), null, '没归作品的画布返回 null')
  assert.equal(canvasOwner(byFlow, ''), null)
  assert.equal(canvasOwner(new Map(), 'flow_free'), null)
})

test('挂到已有作品前的判断：一块画布只归一条作品，一条作品只有一块当前画布', async () => {
  const { adoptCanvasBlock } = await canvasModule()
  const { projectsByFlow } = await ownership()
  const byFlow = projectsByFlow(await projectsModule().then((mod) => mod.listProjects(me)))
  const free = { id: 'prj_free', flowId: '', version: 0 }
  const taken = { id: 'prj_taken', flowId: 'flow_own', version: 2 }
  const flowFree = { id: 'flow_free' }

  assert.equal(adoptCanvasBlock({ project: free, flow: flowFree, byFlow }), null, '空白画布 + 还没画布的作品：可以挂')

  const bound = adoptCanvasBlock({ project: free, flow: { id: 'flow_own' }, byFlow })
  assert.equal(bound.code, 'FLOW_BOUND')
  assert.match(bound.error, /已经归在《已经有一块画布》第 2 版上/)
  assert.equal(bound.status, 409)

  const conflict = adoptCanvasBlock({ project: taken, flow: flowFree, byFlow })
  assert.equal(conflict.code, 'CANVAS_TAKEN')
  assert.match(conflict.error, /开一版新的/)

  // 白名单：本来就归这条作品的同一块画布，重复点一下不算冲突
  assert.equal(adoptCanvasBlock({ project: taken, flow: { id: 'flow_own' }, byFlow }), null)

  assert.equal(adoptCanvasBlock({ project: null, flow: flowFree, byFlow }).code, 'PROJECT_NOT_FOUND')
  assert.equal(adoptCanvasBlock({ project: free, flow: null, byFlow }).code, 'FLOW_NOT_FOUND')
})

test('照画布建作品前的判断：这块画布不能已经属于别人', async () => {
  const { newProjectFromCanvasBlock } = await canvasModule()
  const { projectsByFlow } = await ownership()
  const byFlow = projectsByFlow(await projectsModule().then((mod) => mod.listProjects(me)))
  assert.equal(newProjectFromCanvasBlock({ flow: { id: 'flow_free' }, byFlow }), null)
  // flow_own 已经归在 prj_taken 上：再照它建一条就是两条作品盯着同一块画布
  const bound = newProjectFromCanvasBlock({ flow: { id: 'flow_own' }, byFlow })
  assert.equal(bound.code, 'FLOW_BOUND')
  assert.match(bound.error, /别新建一条重复的/)
  assert.equal(newProjectFromCanvasBlock({ flow: null, byFlow }).code, 'FLOW_NOT_FOUND')
})

test('归到已有作品：作品从 v0 变 v1，这块画布跑过的运行一起归过去', async () => {
  const { adoptCanvasForProject } = await canvasModule()
  const result = await adoptCanvasForProject({ projectId: 'prj_free', flowId: 'flow_free', user: me })
  assert.equal(result.status, 200)
  assert.equal(result.body.changed, true)
  assert.equal(result.body.project.flowId, 'flow_free')
  assert.equal(result.body.project.version, 1, '画布已经在了，归过去就是 v1，不是 v0')
  assert.equal(result.body.runs.count, 1, '运行不复制记录，只认这块画布')
  assert.equal(result.body.flow.id, 'flow_free')

  // 运行记录那边按同一张索引读：这一条已经从「没挂在作品上」变成这条作品的 v1
  const { projectsByFlow } = await ownership()
  const byFlow = projectsByFlow(await projectsModule().then((mod) => mod.listProjects(me)))
  assert.equal(byFlow.get('flow_free').id, 'prj_free')
  assert.equal(byFlow.get('flow_free').version, 1)
})

test('同一块画布再归一次：什么都不改，不刷新更新时间', async () => {
  const { adoptCanvasForProject } = await canvasModule()
  const { getProject } = await projectsModule()
  const before = await getProject('prj_free', me)
  const again = await adoptCanvasForProject({ projectId: 'prj_free', flowId: 'flow_free', user: me })
  assert.equal(again.status, 200)
  assert.equal(again.body.changed, false)
  const after = await getProject('prj_free', me)
  assert.equal(after.updatedAt, before.updatedAt, '重复点一下不该像改了一次作品')
  assert.equal(after.version, 1)
})

test('看得见才动得手：别人的作品、别人的画布一律 404', async () => {
  const { adoptCanvasForProject } = await canvasModule()
  const missingProject = await adoptCanvasForProject({ projectId: 'prj_free', flowId: 'flow_router', user: other })
  assert.equal(missingProject.status, 404)
  assert.equal(missingProject.body.code, 'PROJECT_NOT_FOUND')

  const missingFlow = await adoptCanvasForProject({ projectId: 'prj_taken', flowId: 'flow_b', user: me })
  assert.equal(missingFlow.status, 404)
  assert.equal(missingFlow.body.code, 'FLOW_NOT_FOUND')

  // 管理员看得见全部，也就归得动全部（与作品、评审、拍板的归属同一套 canAccess）
  const byAdmin = await adoptCanvasForProject({ projectId: 'prj_other', flowId: 'flow_b', user: admin })
  assert.equal(byAdmin.status, 200)
  assert.equal(byAdmin.body.changed, false, '本来就归这条作品：管理员点一下也只是确认')
})

test('照画布建作品：没有模板，画布已经在了，一出生就是 v1', async () => {
  const { createProjectFromCanvas } = await canvasModule()
  const created = await createProjectFromCanvas({ flowId: 'flow_extra', user: me })
  assert.equal(created.status, 201)
  assert.equal(created.body.project.title, '另一块空白画布', '画布名就是作品名')
  assert.equal(created.body.project.templateId, '', '这条路没有模板，不编一条出来')
  assert.equal(created.body.project.flowId, 'flow_extra')
  assert.equal(created.body.project.version, 1)
  assert.equal(created.body.project.status, 'active')

  const repeat = await createProjectFromCanvas({ flowId: 'flow_extra', user: me })
  assert.equal(repeat.status, 409)
  assert.equal(repeat.body.code, 'FLOW_BOUND', '同一块画布不建第二条作品')

  const named = await createProjectFromCanvas({ flowId: 'flow_router2', title: '  我自己起的名字  ', user: me })
  assert.equal(named.body.project.title, '我自己起的名字')

  const empty = await createProjectFromCanvas({ flowId: '', user: me })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.code, 'FLOW_REQUIRED')
})

test('接口：PUT 归画布、POST 从画布建作品，跑过的运行当场有了「作品 · 第几版」', async () => {
  const { createProjectsRouter } = await import('../server/routes/projects.mjs')
  const { createFlowsRouter } = await import('../server/routes/flows.mjs')
  const router = createProjectsRouter()
  const flowsRouter = createFlowsRouter()

  const call = async (target, method, pathname, body) => {
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
    await target.handle(req, res, url, url.pathname)
    return { status: res.status, body: JSON.parse(res.body || '{}') }
  }

  const missing = await call(router, 'PUT', '/api/projects/prj_free/canvas', {})
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'FLOW_REQUIRED')

  const noTarget = await call(router, 'PUT', '/api/projects/prj_nope/canvas', { flowId: 'flow_router' })
  assert.equal(noTarget.status, 404)

  // 这个用例没有登录态：看得见全部，所以把一块还没归谁的画布挂到「还没开画布的作品」上
  const adopted = await call(router, 'PUT', '/api/projects/prj_route/canvas', { flowId: 'flow_router' })
  assert.equal(adopted.status, 200)
  assert.equal(adopted.body.changed, true)
  assert.equal(adopted.body.runs.count, 1)

  // 运行记录按同一张索引回「属于哪条作品的第几版」——这就是「画布产出落进作品」那一步
  const runs = await call(flowsRouter, 'GET', '/api/runs?flowId=flow_router')
  assert.equal(runs.status, 200)
  assert.equal(runs.body.items[0].project.id, 'prj_route')
  assert.equal(runs.body.items[0].project.version, 1)

  const created = await call(router, 'POST', '/api/projects', { flowId: 'flow_router3' })
  assert.equal(created.status, 201)
  assert.equal(created.body.project.version, 1)

  const needsStart = await call(router, 'POST', '/api/projects', {})
  assert.equal(needsStart.status, 400)
  assert.equal(needsStart.body.code, 'TEMPLATE_REQUIRED')
  assert.match(needsStart.body.error, /模板.*画布/)
})
