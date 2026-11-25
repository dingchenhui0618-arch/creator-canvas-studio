// 账号隔离回归（跟 0.9.174 的账号管理配套）：一个账号拿不到另一个账号的东西。
//
// 为什么值得单独一组：归属判断散在各个模块里（模板 / 作品 / 工作流 / 运行 / 上传图 / 生成任务 / 积分 / 偏好 / 后台），
// 某天有人加一条路由时忘了 canAccess，界面上不会报错——用户要么看到别人的数据，要么以为自己「没有数据」。
// 这里用同一套真实路由 + 真实 SQLite，把「列表看不到、按 id 取不到、改不动、下不了、后台进不去」钉成一张表。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-isolation-'))
process.env.DATA_DIR = DATA_DIR
// 工作流 beta（r313）只对管理员开放：这一组测的是工作流本身，显式对全部账号打开，不改变测试意图
process.env.VQ_WORKFLOW_BETA = 'all'
process.env.VQ_KEY_SECRET = 'test-secret-isolation'
process.env.VQ_REQUIRE_AUTH = '1'

const auth = await import('../server/auth.mjs')
const flows = await import('../server/flows.mjs')
const projectStore = await import('../server/projects.mjs')
const uploads = await import('../server/uploads.mjs')
const credits = await import('../server/credits.mjs')
const { modelCatalog } = await import('../server/models.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')
const { createMediaRouter } = await import('../server/routes/media.mjs')
const { createMediaGenRouter } = await import('../server/routes/media-gen.mjs')
const { createPreferencesRouter } = await import('../server/routes/preferences.mjs')
const { createCreditsRouter } = await import('../server/routes/credits.mjs')
const { createAdminRouter } = await import('../server/routes/admin.mjs')

// 临时目录不在这里删：这一组会打开 SQLite（auth.db / credits.db），Windows 上文件还开着时
// 删目录会 EBUSY，整个测试文件会被判成失败。临时目录留在系统 temp 里，由系统清。

// 邮箱与口令都在源码里拼出来：仓库里不出现任何看起来像真实地址的字符串
const AT = String.fromCharCode(64)
const mail = (name) => name + AT + 'vq.test'
const PASS = 'Passw0rd!demo'

const alice = auth.createUser({ email: mail('alice'), password: PASS, name: '甲', kind: 'account' })
const bob = auth.createUser({ email: mail('bob'), password: PASS, name: '乙', kind: 'account' })
const boss = auth.createUser({ email: mail('boss'), password: PASS, name: '管理员', kind: 'admin' })

const cookieOf = (user) => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.0.1' }).token).split(';')[0]
const aliceCookie = cookieOf(alice)
const bobCookie = cookieOf(bob)
const bossCookie = cookieOf(boss)

function mockReq({ method = 'GET', body = null, cookie = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = cookie ? { cookie } : {}
  req.socket = { remoteAddress: '127.0.0.1' }
  req.once = () => {}
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
    parts,
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

const routers = [
  createProjectsRouter(),
  createFlowsRouter(),
  createMediaRouter(),
  createMediaGenRouter(),
  createPreferencesRouter(),
  createCreditsRouter(),
  createAdminRouter(),
]

// 和 server/index.mjs 一样：把请求交给第一个认领它的路由
async function call({ method = 'GET', path: pathname, body = null, cookie = '' } = {}) {
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + pathname)
  for (const router of routers) {
    const handled = await router.handle(mockReq({ method, body, cookie }), res, url, pathname)
    if (handled) return res
  }
  return res
}

// 别人的东西「取不到」可以是 403 也可以是 404：404 连存在性都不告诉对方，是更严的那种
const denied = (status) => status === 403 || status === 404

const aliceFlow = await flows.createFlow({ name: '甲的流程' }, alice)
const bobFlow = await flows.createFlow({ name: '乙的流程' }, bob)
const aliceProject = await projectStore.createProject({ title: '甲的作品', flowId: aliceFlow.id }, alice)
const bobProject = await projectStore.createProject({ title: '乙的作品', flowId: bobFlow.id }, bob)
const aliceRunId = flows.newRunId()
await flows.startFlowRun(aliceFlow, aliceRunId, { cost: 0, queued: true })

test('作品：列表只列自己的，按 id 取、改名、删除都碰不到别人的', async () => {
  const list = await call({ path: '/api/projects', cookie: bobCookie })
  assert.equal(list.statusCode, 200)
  const ids = (list.json().items || []).map((item) => item.id)
  assert.ok(ids.includes(bobProject.id), '自己的作品要在列表里')
  assert.equal(ids.includes(aliceProject.id), false, '不该出现在别人的列表里')

  const detail = await call({ path: '/api/projects/' + aliceProject.id, cookie: bobCookie })
  assert.ok(denied(detail.statusCode), '按 id 取别人的作品应当是 403/404，实际 ' + detail.statusCode)

  const rename = await call({ method: 'PATCH', path: '/api/projects/' + aliceProject.id, body: { title: '被乙改了' }, cookie: bobCookie })
  assert.ok(denied(rename.statusCode), '改名应当被拒，实际 ' + rename.statusCode)
  const after = await projectStore.getProject(aliceProject.id, alice)
  assert.equal(after.title, '甲的作品', '被拒之后甲的作品名不该变')

  const remove = await call({ method: 'DELETE', path: '/api/projects/' + aliceProject.id, cookie: bobCookie })
  assert.ok(denied(remove.statusCode), '删除应当被拒，实际 ' + remove.statusCode)
  assert.ok(await projectStore.getProject(aliceProject.id, alice), '被拒之后甲的作品还在')
})

test('工作流与运行：列表隔离，按 id 取别人的流程与运行都拿不到', async () => {
  const list = await call({ path: '/api/flows', cookie: aliceCookie })
  assert.equal(list.statusCode, 200)
  const ids = (list.json().items || []).map((item) => item.id)
  assert.ok(ids.includes(aliceFlow.id))
  assert.equal(ids.includes(bobFlow.id), false, '不该看到乙的流程')

  assert.equal(await flows.getFlow(bobFlow.id, alice), null, '存储层也要按归属挡')
  const runs = await call({ path: '/api/runs', cookie: bobCookie })
  assert.equal(runs.statusCode, 200)
  const runIds = (runs.json().items || []).map((item) => item.id)
  assert.equal(runIds.includes(aliceRunId), false, '不该看到甲的运行记录')
  assert.equal(await flows.getRun(aliceRunId, bob), null, '按 id 取别人的运行也给 null')
})

test('上传的图：别人的下载地址一律 404，最近上传列表里也没有', async () => {
  // 1×1 的 PNG：只要是真的 PNG，归属判断不该因为内容而变
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const saved = await uploads.saveUpload({ userId: alice.id, buffer: png })
  assert.match(saved.imageUrl, /^\/media\/uploads\//)

  const mine = await call({ path: saved.imageUrl, cookie: aliceCookie })
  assert.equal(mine.statusCode, 200, '本人应当能取到自己的图')

  const other = await call({ path: saved.imageUrl, cookie: bobCookie })
  assert.equal(other.statusCode, 404, '别人的图要 404（连存在性都不说），实际 ' + other.statusCode)

  const admin = await call({ path: saved.imageUrl, cookie: bossCookie })
  assert.equal(admin.statusCode, 200, '管理员排障可以看，这是写在路由注释里的约定')

  const list = await call({ path: '/api/media/uploads', cookie: bobCookie })
  assert.equal(list.statusCode, 200)
  assert.equal((list.json().items || []).length, 0, '乙的最近上传里不该有甲的图')
  const own = await call({ path: '/api/media/uploads', cookie: aliceCookie })
  assert.equal((own.json().items || []).length, 1)
})

test('生成任务：别人的任务读不了、文件也下不了', async () => {
  const taskId = 'mgen_' + 'isolation0001'
  const dir = path.join(DATA_DIR, 'media', 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, taskId + '.json'),
    JSON.stringify({ version: 1, id: taskId, userId: alice.id, kind: 'image', status: 'done', prompt: '测试', model: 'gpt-image-2', credits: {}, createdAt: new Date().toISOString() }),
    'utf8',
  )

  const mine = await call({ path: '/api/media/tasks/' + taskId, cookie: aliceCookie })
  assert.equal(mine.statusCode, 200)
  assert.equal(mine.json().task.id, taskId)

  const other = await call({ path: '/api/media/tasks/' + taskId, cookie: bobCookie })
  assert.equal(other.statusCode, 403, '别人的生成任务要 403，实际 ' + other.statusCode)
  assert.equal(other.json().code, 'MEDIA_TASK_FORBIDDEN')

  const file = await call({ path: '/api/media/tasks/' + taskId + '/file', cookie: bobCookie })
  assert.equal(file.statusCode, 403, '别人的结果文件也要 403，实际 ' + file.statusCode)
})

test('积分账本与偏好：各算各的，读不到对方的', async () => {
  credits.grant(alice.id, 50, { note: '隔离测试' })
  const aliceLedger = await call({ path: '/api/credits', cookie: aliceCookie })
  const bobLedger = await call({ path: '/api/credits', cookie: bobCookie })
  assert.equal(aliceLedger.statusCode, 200)
  assert.equal(bobLedger.statusCode, 200)
  // 账本说明写在 ref 里（note 与操作人拼在一起），这里只认那一段字
  const refsOf = (res) => (res.json().ledger || []).map((item) => String(item.ref || ''))
  assert.equal(refsOf(bobLedger).some((ref) => ref.includes('隔离测试')), false, '乙的账本里不该有甲那笔')
  assert.ok(refsOf(aliceLedger).some((ref) => ref.includes('隔离测试')), '甲自己的账本里要有那笔')
  assert.ok(Number(aliceLedger.json().balance) > Number(bobLedger.json().balance), '甲的余额里要有这笔，乙的没有')

  const modelId = modelCatalog().models[0]?.id || ''
  const saved = await call({ method: 'PUT', path: '/api/preferences', body: { model: modelId }, cookie: aliceCookie })
  assert.equal(saved.statusCode, 200)
  const bobPrefs = await call({ path: '/api/preferences', cookie: bobCookie })
  assert.equal(bobPrefs.statusCode, 200)
  if (modelId) assert.notEqual(bobPrefs.json().model, modelId, '乙读到的偏好不该是甲设的')
})

test('后台：普通账号进不去，也改不了自己的身份（不能自助提权或换掉找回密码的邮箱）', async () => {
  const list = await call({ path: '/api/admin/users', cookie: bobCookie })
  assert.equal(list.statusCode, 403)

  // 最要紧的一条：自己改自己也不行——绕过后台就等于绕过管理员
  const self = await call({ method: 'PATCH', path: '/api/admin/users/' + bob.id, body: { email: mail('hijack') }, cookie: bobCookie })
  assert.equal(self.statusCode, 403, '普通账号改自己的身份要 403，实际 ' + self.statusCode)
  assert.equal(auth.findUserById(bob.id).email, mail('bob'), '被拒之后邮箱不该动')

  const other = await call({ method: 'PATCH', path: '/api/admin/users/' + alice.id, body: { username: 'hijacked' }, cookie: bobCookie })
  assert.equal(other.statusCode, 403)
  assert.equal(String(auth.findUserById(alice.id).login_name || ''), '', '被拒之后甲的登录名不该动')

  const admin = await call({ path: '/api/admin/users', cookie: bossCookie })
  assert.equal(admin.statusCode, 200)
  const ids = (admin.json().items || []).map((item) => item.id)
  assert.deepEqual(ids.sort(), [alice.id, bob.id, boss.id].sort(), '管理员看全部')
})

// 两层门：index.mjs 在功能路由之前统一挡（needsLogin，PUBLIC_API 白名单之外一律 401），
// 这几条路由自己还会再判一次——单测直接调路由时行为不该依赖外面那一层。
// /api/flows 属于「只靠外层门」的那种：它不在这个名单里，靠的正是 index.mjs 里那句
// 「登录门必须排在功能路由前面」（见 server/index.mjs 的 needsLogin 与分发顺序）。
test('自判登录的门：没登录一律 401', async () => {
  for (const pathname of ['/api/projects', '/api/credits', '/api/preferences', '/api/media/uploads', '/api/admin/users']) {
    const res = await call({ path: pathname })
    assert.equal(res.statusCode, 401, pathname + ' 未登录应当是 401，实际 ' + res.statusCode)
  }
})
