// 工作流 beta（r313）：用户说这个功能「没什么用」，先收成只给管理员的 beta。
//
// 这一组盯住六件事：
//   1) 开关默认关闭；只有 VQ_WORKFLOW_BETA=all / 1 才对全部账号打开（内部实例排障）；
//   2) 普通账号打 /api/flows、/api/runs 一律 403，载荷固定（ok / error / code）；无限画布 /api/canvas 不在此列；
//   3) 403 发生在扣费与读盘之前：余额一分不动，也没有多出一条运行记录；
//   4) 管理员照旧——列表、新建、运行记录、画布排队位都通；
//   5) /api/auth/me 的 features.workflow 跟身份一致；打开开关后普通账号也放行、features 跟着变；
//   6) 源码契约：工作流路由在扣费之前判权，无限画布路由不挂这道闸门，auth/me 用的是同一个判定函数；
//   7) 作品侧（task-22）：普通账号不能从作品接口建 / 绑工作流，也读不到 flowBrief、flowId 与节点；
//      作品自己的脚本、分镜、评审、交付照旧，管理员照旧；
//   8) 开新版（r313 补）：普通账号照常开版（脚本与分镜跟着走），但不复制工作流、旧工作流一个字节不动；
//      详情里的历史运行与版本说明都不带工作流名、节点与 flowId；管理员开版照旧复制工作流。
//
// 不设 VQ_WORKFLOW_BETA=all：这个文件测的就是「没打开时的 403」，要放行的那一条自己临时开。
// 不调真实上游：被拦的请求连读盘都不会发生，一条模型 / 出图调用都没有。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-workflow-beta-'))
process.env.VQ_KEY_SECRET = 'test-secret-workflow-beta'
process.env.VISION_API_KEY = ''

const beta = await import('../server/workflow-beta.mjs')
const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const flows = await import('../server/flows.mjs')
const { createAuthRouter } = await import('../server/routes/auth.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')
const { createCanvasRouter } = await import('../server/routes/canvas.mjs')
const projectStore = await import('../server/projects.mjs')
const templates = await import('../server/templates.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')

// .env 是给真实实例用的：这一组的结果不能被本机配置改写，导入完再确认一次没打开。
delete process.env.VQ_WORKFLOW_BETA

const authRouter = createAuthRouter()
const flowsRouter = createFlowsRouter()
const canvasRouter = createCanvasRouter()
const projectsRouter = createProjectsRouter()

// 邮箱用拼接的写法：测试文件里不落真实地址
const emailOf = (name) => name + String.fromCharCode(64) + 'workflow-beta.test'

const admin = auth.createUser({ email: emailOf('beta-admin'), password: 'Passw0rd!demo', name: 'beta 管理员', kind: 'admin' })
const plain = auth.createUser({ email: emailOf('beta-plain'), password: 'Passw0rd!demo', name: 'beta 普通账号', kind: 'user' })

const cookieOf = (user) => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.20.1' }).token).split(';')[0]

function mockReq({ method = 'GET', body = null, cookie = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = cookie ? { cookie } : {}
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body !== null) req.push(JSON.stringify(body))
  req.push(null)
  return req
}

function mockRes() {
  const parts = []
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    write(chunk) {
      if (chunk) parts.push(chunk)
      return true
    },
    end(chunk) {
      if (chunk) parts.push(chunk)
      this.writableEnded = true
    },
    body() {
      return Buffer.concat(parts.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(String(item))))).toString('utf8')
    },
    json() {
      const text = this.body()
      return text ? JSON.parse(text) : null
    },
  }
}

// 和 server/index.mjs 一样：请求交给第一个认领它的路由
async function call(router, { method = 'GET', path = '', body = null, cookie = '' } = {}) {
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + path)
  const handled = await router.handle(mockReq({ method, body, cookie }), res, url, url.pathname)
  assert.equal(handled, true, '路由应当认领 ' + method + ' ' + path)
  return res
}

const plainFlow = await flows.createFlow({ name: '普通账号的画布' }, plain)

// 作品侧（task-22）：普通账号的历史记录里确实绑着工作流——库里留着，接口上不该再露出来。
// 历史用存储层造成（z 接口那条路这一轮已经堵上）：绑一块、再以旧版为底开一版，就有一条
// 「当前工作流 + 一个归档版本」的老作品，正是 r313 之前留下的数据形状。
const plainProject = await projectStore.createProject({ title: 'Beta 阅读用例' }, plain)
const historyFlow = await flows.createFlow({ name: '历史版工作流' }, plain)
const archivedFlow = await flows.createFlow({ name: '第一版工作流' }, plain)
await projectStore.bindProjectFlow(plainProject.id, historyFlow.id, plain)
await projectStore.archiveProjectVersion(plainProject.id, { flowId: archivedFlow.id, prevName: '第一版' }, plain)

// 管理员那两块对照：一块用来绑到已有作品，一块用来「从工作流建作品」
// （一块工作流只归一条作品，同一块不能同时走两条路）
const adminBindFlow = await flows.createFlow({ name: '管理员绑定用例' }, admin)
const adminNewFlow = await flows.createFlow({ name: '管理员建作品用例' }, admin)
const adminProject = await projectStore.createProject({ title: '管理员的作品' }, admin)

// 开新版（r313 补）：普通账号照常开版——这是作品的核心动作，只是不再顺带复制工作流。
// 两条路都要盯：从模板建的（v0，一块工作流都没有）与 r313 之前就绑着工作流的老作品。
const versionTemplate = await templates.createTemplateFromDraft({
  draft: {
    title: 'Beta 开版用例模板',
    hook: '开头一句',
    structure: [
      { beat: '开场', voiceover: '开场先交代场景', onScreen: '字幕一', purpose: '抓人' },
      { beat: '卖点', voiceover: '把卖点讲清楚', onScreen: '字幕二', purpose: '说服' },
    ],
    storyboard: [
      { no: 1, shot: '人站在门口', prompt: '镜头一' },
      { no: 2, shot: '产品特写', prompt: '镜头二' },
    ],
  },
  user: plain,
})
const versionProject = await projectStore.createProject({ title: 'Beta 开新版用例', templateId: versionTemplate.id }, plain)
// 历史老作品的脚本：开版时它要跟着走（归档快照 + 作品自己的脚本都还在）
await projectStore.saveProjectScript(plainProject.id, {
  hook: '钩子',
  structure: [{ beat: '开场', voiceover: '第一版口播', onScreen: '', purpose: '' }],
  updatedAt: '',
}, plain)

// 403 的形状只有一种：ok=false + 同一句人话 + 同一个 code，前端不必从文案里猜是哪一种拒绝
function expectRefusal(res, label) {
  assert.equal(res.statusCode, 403, label + ' 应当是 403，实际 ' + res.statusCode)
  const body = res.json()
  assert.deepEqual(body, {
    ok: false,
    error: '工作流还是 beta，现在只对管理员开放',
    code: 'WORKFLOW_BETA',
  }, label + ' 的 403 载荷不对：' + res.body())
  return body
}

test('开关默认关；只有 all / 1 才打开（内部排障）', () => {
  delete process.env.VQ_WORKFLOW_BETA
  assert.equal(beta.workflowBetaOpen(), false, '默认关：没配就是只给管理员')
  assert.equal(beta.WORKFLOW_BETA_ERROR, '工作流还是 beta，现在只对管理员开放')

  // 只有显式写 all / 1 才算打开：别的值一律按「没开」处理，漏配不会变成全员可用
  for (const value of ['', '0', 'none', 'true', 'yes', 'admin']) {
    process.env.VQ_WORKFLOW_BETA = value
    assert.equal(beta.workflowBetaOpen(), false, '这个值不该打开：' + JSON.stringify(value))
  }
  for (const value of ['all', '1', 'ALL', ' all ']) {
    process.env.VQ_WORKFLOW_BETA = value
    assert.equal(beta.workflowBetaOpen(), true, '这个值应当打开：' + JSON.stringify(value))
  }

  delete process.env.VQ_WORKFLOW_BETA
  assert.equal(beta.workflowBetaAllowed(null), false, '没登录不是管理员')
  assert.equal(beta.workflowBetaAllowed(plain), false, '普通账号默认不能用')
  assert.equal(beta.workflowBetaAllowed(admin), true, '管理员照旧')

  // 打开时不再看身份
  process.env.VQ_WORKFLOW_BETA = 'all'
  try {
    assert.equal(beta.workflowBetaAllowed(null), true)
    assert.equal(beta.workflowBetaAllowed(plain), true)
  } finally {
    delete process.env.VQ_WORKFLOW_BETA
  }
})

test('普通账号：工作流与运行记录一律 403，一个字节的工作流内容都不回；无限画布不受影响', async () => {
  const cookie = cookieOf(plain)
  expectRefusal(await call(flowsRouter, { path: '/api/flows', cookie }), '工作流列表')
  expectRefusal(await call(flowsRouter, { path: '/api/runs', cookie }), '运行记录')
  expectRefusal(await call(flowsRouter, { path: '/api/flows/meta', cookie }), '节点元信息')
  expectRefusal(
    await call(flowsRouter, { method: 'POST', path: '/api/flows', body: { name: '偷建一张' }, cookie }),
    '新建工作流',
  )
  // 无限画布（#/board）不是工作流：它的票据与排队位对普通账号照常 200（r313 撤回过一次误判）
  const boardQueue = await call(canvasRouter, { path: '/api/canvas/queue', cookie })
  assert.equal(boardQueue.statusCode, 200, '无限画布的排队位不该被工作流闸门拦下')

  // 匿名也不是管理员：生产端由 index.mjs 的登录门先回 401，路由层这里只认 beta 这一条
  const anon = await call(flowsRouter, { path: '/api/flows' })
  assert.equal(anon.statusCode, 403, '匿名在路由层同样是 403，实际 ' + anon.statusCode)
})

test('403 在扣费与读盘之前：余额一分不动，也没有多出一条运行记录', async () => {
  const before = credits.balanceOf(plain.id)
  assert.equal(typeof before, 'number')
  const runsBefore = await flows.listRuns({ limit: 50 }, plain)

  const res = await call(flowsRouter, {
    method: 'POST',
    path: '/api/flows/' + plainFlow.id + '/run',
    body: { stream: false },
    cookie: cookieOf(plain),
  })
  expectRefusal(res, '运行一条流程')

  assert.equal(credits.balanceOf(plain.id), before, '被拦下的运行不许扣积分（一分都不行）')
  const runsAfter = await flows.listRuns({ limit: 50 }, plain)
  assert.equal(runsAfter.total, runsBefore.total, '被拦下的运行不许在盘上留下记录')
  assert.equal(res.body().includes(plainFlow.id), false, '403 不该带出这条流程的 id：' + res.body())
})

test('管理员照旧：列表、新建、运行记录、画布排队位都通', async () => {
  const cookie = cookieOf(admin)

  const list = await call(flowsRouter, { path: '/api/flows', cookie })
  assert.equal(list.statusCode, 200)
  assert.ok(Array.isArray(list.json().items), '管理员拿得到工作流列表')

  const created = await call(flowsRouter, {
    method: 'POST',
    path: '/api/flows',
    body: { name: '管理员的画布', nodes: [], edges: [] },
    cookie,
  })
  assert.equal(created.statusCode, 201)
  assert.ok(created.json().id, '管理员建得动')

  const runs = await call(flowsRouter, { path: '/api/runs', cookie })
  assert.equal(runs.statusCode, 200)
  assert.ok(Array.isArray(runs.json().items))

  const queue = await call(canvasRouter, { path: '/api/canvas/queue', cookie })
  assert.equal(queue.statusCode, 200)
  assert.equal(typeof queue.json().kind, 'string')
})

test('普通账号：作品侧建 / 绑工作流的入口一律 403，余额与盘上数据一分不动', async () => {
  const cookie = cookieOf(plain)
  const balance = credits.balanceOf(plain.id)
  const assetsDir = path.join(process.env.DATA_DIR, 'assets')
  // 被判权挡下的请求应该在读作品 / 建文件之前返回：三份盘上数据一个字节都不该变
  const snapshot = () => ({
    flows: fs.readFileSync(path.join(process.env.DATA_DIR, 'flows.json'), 'utf8'),
    projects: fs.readFileSync(path.join(process.env.DATA_DIR, 'projects.json'), 'utf8'),
    assets: fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir, { recursive: true }).map(String).sort().join('|')
      : '',
  })
  const before = snapshot()

  expectRefusal(
    await call(projectsRouter, {
      method: 'POST',
      path: '/api/projects',
      body: { flowId: plainFlow.id, title: '从工作流建一条' },
      cookie,
    }),
    'POST /api/projects 带 flowId',
  )
  expectRefusal(
    await call(projectsRouter, { method: 'POST', path: '/api/projects/' + plainProject.id + '/canvas', cookie }),
    'POST /api/projects/:id/canvas',
  )
  expectRefusal(
    await call(projectsRouter, {
      method: 'PATCH',
      path: '/api/projects/' + plainProject.id,
      body: { flowId: plainFlow.id },
      cookie,
    }),
    'PATCH /api/projects/:id 带 flowId',
  )

  assert.deepEqual(snapshot(), before, '被拒之后 flows.json / projects.json / 资产目录都不该变')
  assert.equal(credits.balanceOf(plain.id), balance, '被拒之后余额一分不动')
})

test('普通账号：作品详情与列表里没有工作流，作品自己的脚本 / 评审 / 交付一个不少', async () => {
  const cookie = cookieOf(plain)

  // ?snapshots 是交付稿那条读法：普通账号这里同样不该带节点
  const detailRes = await call(projectsRouter, { path: '/api/projects/' + plainProject.id + '?snapshots=1', cookie })
  assert.equal(detailRes.statusCode, 200)
  const detail = detailRes.json()
  assert.equal(detail.flow, null, '看不到工作流时 flowBrief 必须是 null，不能只靠前端不显示')
  assert.equal(detail.project.flowId, '', '作品上的工作流指针要置空')
  assert.equal(detail.project.versions[0].flowId, '', '作品简报里的版本行也要置空')
  assert.equal(detail.versions.length, 1, '版本历史本身还在：它是作品的记录，不是工作流')
  assert.equal(detail.versions[0].flowId, '')
  assert.equal(detail.versions[0].available, false, '看不到工作流时「能不能打开」只能是 false')
  assert.equal(detail.versions[0].nodes, 0)
  assert.equal(JSON.stringify(detail).includes('nodeList'), false, '?snapshots 也不许带节点')
  assert.equal(JSON.stringify(detail).includes(historyFlow.id), false, '历史 flowId 不出接口')
  // 作品自己的内容一个不少
  assert.ok('script' in detail, '脚本字段要还在')
  assert.ok(Array.isArray(detail.reviews), '评审照旧')
  assert.ok(Array.isArray(detail.project.deliveries), '交付字段照旧')
  assert.ok('template' in detail && 'spend' in detail, '模板与花费照旧')
  assert.equal(typeof detail.spend.runs.credits, 'number')

  const listRes = await call(projectsRouter, { path: '/api/projects', cookie })
  assert.equal(listRes.statusCode, 200)
  const item = (listRes.json().items || []).find((entry) => entry.id === plainProject.id)
  assert.ok(item, '自己的作品要在列表里')
  assert.equal(item.flowId, '')
  assert.equal(item.versions[0].flowId, '')
  assert.equal(JSON.stringify(item).includes(historyFlow.id), false, '列表里连历史 flowId 都不该出现')
  assert.ok('template' in item && Array.isArray(item.deliveries), '作品自己的字段一个不少')
  assert.equal(typeof item.reviews.count, 'number')
  assert.equal(typeof item.spend.total, 'number')
})

test('管理员：作品侧建 / 绑工作流照旧，flowBrief 有值', async () => {
  const cookie = cookieOf(admin)

  const bound = await call(projectsRouter, {
    method: 'PATCH',
    path: '/api/projects/' + adminProject.id,
    body: { flowId: adminBindFlow.id },
    cookie,
  })
  assert.equal(bound.statusCode, 200)
  assert.equal(bound.json().project.flowId, adminBindFlow.id, '管理员绑得上工作流')

  const fromFlow = await call(projectsRouter, {
    method: 'POST',
    path: '/api/projects',
    body: { flowId: adminNewFlow.id, title: '管理员从工作流建' },
    cookie,
  })
  assert.equal(fromFlow.statusCode, 201)
  assert.equal(fromFlow.json().project.flowId, adminNewFlow.id)
  assert.equal(fromFlow.json().flow.id, adminNewFlow.id)

  const openCanvas = await call(projectsRouter, { method: 'POST', path: '/api/projects/' + adminProject.id + '/canvas', cookie })
  assert.equal(openCanvas.statusCode, 200, '已经有工作流时「开工作流」回 200 created:false')
  assert.equal(openCanvas.json().created, false)
  assert.equal(openCanvas.json().flow.id, adminBindFlow.id)

  const detail = await call(projectsRouter, { path: '/api/projects/' + adminProject.id, cookie })
  assert.equal(detail.statusCode, 200)
  assert.equal(detail.json().flow.id, adminBindFlow.id, '管理员详情里 flowBrief 有值')
  assert.equal(detail.json().project.flowId, adminBindFlow.id)

  const list = await call(projectsRouter, { path: '/api/projects', cookie })
  const card = (list.json().items || []).find((entry) => entry.id === adminProject.id)
  assert.ok(card)
  assert.equal(card.flowId, adminBindFlow.id, '管理员列表照旧带工作流指针')
})

test('/api/auth/me 的 features.workflow 跟身份一致；打开开关后普通账号也放行', async () => {
  const meOf = async (user) => {
    const res = await call(authRouter, { path: '/api/auth/me', cookie: cookieOf(user) })
    assert.equal(res.statusCode, 200)
    return res.json()
  }

  const asAdmin = await meOf(admin)
  assert.equal(asAdmin.features.workflow, true, '管理员这里必须是 true')
  assert.equal(asAdmin.user.kind, 'admin')
  assert.equal(asAdmin.user.twoFactor, false, '登录态返回的 user 结构没被 features 顶掉')

  const asPlain = await meOf(plain)
  assert.equal(asPlain.features.workflow, false, '普通账号这里必须是 false')
  assert.equal(asPlain.user.kind, 'user')
  assert.equal(asPlain.user.id, plain.id)

  // 内部实例排障：开关一开，普通账号立刻能用，features 跟着同一条判定走（不用重启）
  process.env.VQ_WORKFLOW_BETA = 'all'
  try {
    assert.equal((await meOf(plain)).features.workflow, true)
    const list = await call(flowsRouter, { path: '/api/flows', cookie: cookieOf(plain) })
    assert.equal(list.statusCode, 200, '开关打开时普通账号照常可用')
  } finally {
    delete process.env.VQ_WORKFLOW_BETA
  }

  // 关掉之后立刻恢复 403：判定每次读当前环境，不是启动时缓存的一份
  const again = await call(flowsRouter, { path: '/api/flows', cookie: cookieOf(plain) })
  assert.equal(again.statusCode, 403, '关掉开关后普通账号立刻回到 403')
})

test('源码契约：两个路由都在扣费之前判权，auth/me 用的是同一个判定', () => {
  const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8')

  const flowsSource = read('server/routes/flows.mjs')
  const flowsBody = flowsSource.slice(flowsSource.indexOf('async handle('))
  const flowGate = flowsBody.indexOf('if (!workflowBetaAllowed(user)) return denyWorkflowBeta(res)')
  assert.ok(flowGate > 0, '工作流路由要在 handle 最前面判权')
  for (const after of ['beginRunCharge(res, user, runId', 'startFlowRun(', 'readBody(req)', 'await listFlows(']) {
    const at = flowsBody.indexOf(after)
    assert.ok(at > 0, '找不到 ' + after + '：契约断言要跟着代码改')
    assert.ok(flowGate < at, '判权必须在 ' + after + ' 之前：否则非管理员能先把钱扣了，或者先读到盘上的工作流')
  }

  // 无限画布（/api/canvas）不判工作流权：它是 #/board 的票据与排队位，不是工作流
  const canvasSource = read('server/routes/canvas.mjs')
  assert.equal(
    canvasSource.includes('denyWorkflowBeta'),
    false,
    '无限画布路由不该挂工作流闸门：普通账号打开 #/board 会拿不到票据',
  )

  const authSource = read('server/routes/auth.mjs')
  assert.ok(
    authSource.includes('features: { workflow: workflowBetaAllowed(row) }'),
    '/api/auth/me 要用同一个判定下发 features.workflow',
  )
  // 登录 / 注册 / 两步验证那几条路返回的 user 结构不动：features 只出现在 /api/auth/me
  assert.equal((authSource.match(/features:/g) || []).length, 1, 'features 只能下发一处，别把其它接口的返回结构也改了')
})

test('普通账号：开新版照常成功，但不复制工作流，脚本与分镜跟着走', async () => {
  const cookie = cookieOf(plain)
  const flowsFile = path.join(process.env.DATA_DIR, 'flows.json')
  const flowsBefore = fs.readFileSync(flowsFile, 'utf8')
  const before = await projectStore.getProject(versionProject.id, plain)
  assert.equal(before.version, 0, '从模板建的作品还没有版本：开版就是 v1')

  const res = await call(projectsRouter, {
    method: 'POST',
    path: '/api/projects/' + versionProject.id + '/versions',
    cookie,
  })
  assert.equal(res.statusCode, 201, '普通账号开新版应当放行，实际 ' + res.statusCode + '：' + res.body())
  const body = res.json()
  assert.equal(body.project.id, versionProject.id)
  assert.equal(body.project.flowId, '', '普通账号开版不建工作流，回执里也没有工作流指针')
  assert.equal('flow' in body, false, '开版回执不该带 flowBrief')
  assert.equal(body.project.version, 1)

  assert.equal(fs.readFileSync(flowsFile, 'utf8'), flowsBefore, '一块工作流都没建：flows.json 一个字节不动')

  // 脚本与分镜跟着走：新版仍读得到模板的脚本与分镜
  const detail = (await call(projectsRouter, { path: '/api/projects/' + versionProject.id, cookie })).json()
  assert.equal(detail.project.version, 1)
  assert.equal(detail.script.hook, '开头一句')
  assert.equal(detail.script.source, 'template', '没动过脚本时仍跟随模板')
  assert.equal(detail.script.structure.length, 2)
  assert.ok(detail.template, '模板（分镜的来源）还在')
  assert.equal(detail.template.storyboard.length, 2, '分镜跟着走')
  assert.equal(detail.spend.runs.credits, 0)
})

test('普通账号：给历史工作流的作品开新版，旧工作流一个字节不动，版本行不带工作流名', async () => {
  const cookie = cookieOf(plain)
  const flowsFile = path.join(process.env.DATA_DIR, 'flows.json')
  const flowsBefore = fs.readFileSync(flowsFile, 'utf8')
  const before = await projectStore.getProject(plainProject.id, plain)
  assert.ok(before.flowId, '老作品在库里确实还绑着工作流')

  const res = await call(projectsRouter, {
    method: 'POST',
    path: '/api/projects/' + plainProject.id + '/versions',
    cookie,
  })
  assert.equal(res.statusCode, 201, '普通账号开新版应当放行，实际 ' + res.statusCode + '：' + res.body())
  const body = res.json()
  assert.equal(body.project.flowId, '')
  assert.equal('flow' in body, false)
  assert.equal(JSON.stringify(body).includes(before.flowId), false, '回执里连历史 flowId 都不该出现')

  assert.equal(fs.readFileSync(flowsFile, 'utf8'), flowsBefore, '旧工作流一个字节不动（没建、没删、没改）')

  // 库里：版次 +1、指针还是原来那块、这一版的脚本快照存下来了（历史值不删，只是不下发）
  const after = await projectStore.getProject(plainProject.id, plain)
  assert.equal(after.version, before.version + 1)
  assert.equal(after.flowId, before.flowId, '普通账号开版不动作品上的工作流指针')
  assert.equal(after.versions.length, before.versions.length + 1)
  const row = after.versions[after.versions.length - 1]
  assert.equal(row.n, before.version)
  assert.equal(row.name, '第 ' + before.version + ' 版', '版本行名字写中性的「第 N 版」，不写工作流名')
  assert.ok(row.script && row.script.structure.length, '这一版的脚本快照存下来了')
  assert.equal(after.script.structure.length, 1, '作品自己的脚本没被开版改掉')
})

test('管理员：开新版照旧复制一块新工作流', async () => {
  const cookie = cookieOf(admin)
  const flowsFile = path.join(process.env.DATA_DIR, 'flows.json')
  const flowsBefore = JSON.parse(fs.readFileSync(flowsFile, 'utf8'))

  const res = await call(projectsRouter, {
    method: 'POST',
    path: '/api/projects/' + adminProject.id + '/versions',
    cookie,
  })
  assert.equal(res.statusCode, 201, res.body())
  const body = res.json()
  assert.ok(body.flow && body.flow.id, '管理员开版回执里带着新工作流')
  assert.notEqual(body.flow.id, adminBindFlow.id, '新一版是一块新工作流，不是原来那块')
  assert.equal(body.project.flowId, body.flow.id, '作品改指向新工作流')

  const flowsAfter = JSON.parse(fs.readFileSync(flowsFile, 'utf8'))
  assert.equal(flowsAfter.length, flowsBefore.length + 1, '管理员开版会新建一块工作流')
  const created = flowsAfter.find((flow) => flow.id === body.flow.id)
  assert.ok(created, '新工作流确实落盘了')
  assert.equal(created.name, '管理员的作品 v2')
  assert.equal(created.ownerId, admin.id)
})

test('普通账号：详情里的历史运行与版本说明都不带工作流，花费照旧算', async () => {
  const cookie = cookieOf(plain)
  // 造一条历史运行：那块老工作流跑过一次、花了 6 分。走的是运行记录同一条落盘路。
  await flows.startFlowRun(historyFlow, flows.newRunId(), { cost: 6 })
  // 脚本再改一版：当前版比上一版多一段，版本行要给出「脚本多 1 段」这种中性说明
  await projectStore.saveProjectScript(plainProject.id, {
    hook: '钩子',
    structure: [
      { beat: '开场', voiceover: '第一版口播', onScreen: '', purpose: '' },
      { beat: '卖点', voiceover: '新加的一段', onScreen: '', purpose: '' },
    ],
    updatedAt: '',
  }, plain)

  const res = await call(projectsRouter, { path: '/api/projects/' + plainProject.id + '?snapshots=1', cookie })
  assert.equal(res.statusCode, 200)
  const detail = res.json()
  const text = JSON.stringify(detail)
  assert.equal(text.includes('flowName'), false, '运行摘要里不许带工作流名：' + text.slice(0, 600))
  assert.equal(text.includes('nodeList'), false)
  assert.equal(text.includes(historyFlow.id), false)
  assert.equal(text.includes(archivedFlow.id), false)
  assert.equal(text.includes('历史版工作流'), false, '历史工作流的名字不出接口')
  assert.equal(text.includes('第一版工作流'), false)

  // 运行归集还在，只是没有工作流那两列；花费与次数照旧（那是作品自己的账）
  assert.equal(detail.runs.length, 1, '历史运行仍然列得出来')
  assert.equal(detail.runs[0].flowId, undefined)
  assert.equal(detail.runs[0].flowName, undefined)
  assert.equal(detail.runs[0].version, 1, '运行仍归到它发生的那一版')
  assert.equal(detail.runs[0].available, false)
  assert.equal(detail.spend.runs.credits, 6, '花费照旧算')
  assert.equal(detail.spend.runs.count, 1)
  assert.ok(detail.spend.total >= 6)

  // 版本行的一句话：只按脚本比，不拼「工作流」
  const changes = Object.values(detail.versionChanges)
  assert.ok(changes.length, '当前版比上一版有话说：' + JSON.stringify(detail.versionChanges))
  for (const line of changes) assert.equal(String(line).includes('工作流'), false, '版本说明不许出现工作流：' + line)
  assert.ok(String(detail.versionChanges['3'] || '').includes('脚本'), '脚本这一侧照旧比：' + JSON.stringify(detail.versionChanges))
  for (const entry of Object.values(detail.versionBaseChanges)) {
    assert.equal(String(entry?.text || '').includes('工作流'), false, '底座对照同样不许出现工作流：' + JSON.stringify(entry))
  }

  // 两版对照：节点一侧整块不给，脚本照旧
  const cmp = await call(projectsRouter, {
    path: '/api/projects/' + plainProject.id + '/versions/compare?base=2&target=3',
    cookie,
  })
  assert.equal(cmp.statusCode, 200, cmp.body())
  const view = cmp.json()
  assert.equal(view.canvas, null, '普通账号的对照没有节点一侧')
  assert.equal(view.base.nodes, 0)
  assert.equal(view.base.canvasAvailable, false)
  assert.equal(JSON.stringify(view).includes('工作流'), false, '对照文案不许出现工作流：' + cmp.body())
  assert.equal(JSON.stringify(view).includes(historyFlow.id), false)
  assert.equal(JSON.stringify(view).includes(archivedFlow.id), false)
  assert.ok(String(view.summary).includes('脚本'), '脚本一侧照旧对照：' + String(view.summary))

  // 旧版脚本快照也还在（作品自己的记录，不是工作流的）
  const v2Script = await call(projectsRouter, { path: '/api/projects/' + plainProject.id + '/versions/2/script', cookie })
  assert.equal(v2Script.statusCode, 200)
  assert.equal(v2Script.json().name, '第 2 版', '归档版本名也是中性的')
  assert.equal(v2Script.json().script.structure.length, 1)
})

test('普通账号：以旧版为底开新版也只回到脚本与分镜，工作流一个字节不动', async () => {
  const cookie = cookieOf(plain)
  const flowsFile = path.join(process.env.DATA_DIR, 'flows.json')
  const flowsBefore = fs.readFileSync(flowsFile, 'utf8')

  // 先写一版自己的脚本，再开新版：v1 的脚本快照就存下来了
  await projectStore.saveProjectScript(versionProject.id, {
    hook: '自己的钩子',
    structure: [{ beat: '开场', voiceover: '自己写的口播', onScreen: '', purpose: '' }],
    updatedAt: '',
  }, plain)
  const v2 = await call(projectsRouter, {
    method: 'POST',
    path: '/api/projects/' + versionProject.id + '/versions',
    cookie,
  })
  assert.equal(v2.statusCode, 201, v2.body())
  assert.equal(v2.json().project.version, 2)

  // 脚本改得面目全非，再从 v1 开一版：脚本回到当时的快照
  await projectStore.saveProjectScript(versionProject.id, {
    hook: '改过的钩子',
    structure: [{ beat: '开场', voiceover: '改过的口播', onScreen: '', purpose: '' }],
    updatedAt: '',
  }, plain)
  const res = await call(projectsRouter, {
    method: 'POST',
    path: '/api/projects/' + versionProject.id + '/versions',
    body: { from: 1 },
    cookie,
  })
  assert.equal(res.statusCode, 201, '普通账号以旧版为底也要放行，实际 ' + res.statusCode + '：' + res.body())
  const body = res.json()
  assert.equal(body.project.version, 3)
  assert.equal(body.basedOn, 1)
  assert.equal(fs.readFileSync(flowsFile, 'utf8'), flowsBefore, '以旧版为底也不建工作流：flows.json 一个字节不动')

  const detail = (await call(projectsRouter, { path: '/api/projects/' + versionProject.id, cookie })).json()
  assert.equal(detail.script.hook, '自己的钩子', '脚本回到 v1 当时那一份（开 v2 时存下的快照）')
  assert.equal(detail.script.structure.length, 1)
  assert.ok(detail.template && detail.template.storyboard.length === 2, '分镜照旧跟着模板')
  assert.equal(JSON.stringify(detail).includes('工作流'), false, '这条作品从头到尾没碰过工作流：详情里也不出现这个词')
})
