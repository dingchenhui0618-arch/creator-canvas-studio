// r343 独立取证（lead 追加的 4 条）· 普通用户响应里 0 厂牌 / 0 内部型号；切模型仍然真的生效。
//
// (a) 扫这些响应体：/api/models、PUT+GET /api/preferences、GET /api/agents、GET /api/agents/:id、
//     GET /api/agents/:id/history、POST /api/agents/:id/chat、/api/local-agent/meta、
//     /api/system/service、/api/health。
// (b) 从 /api/models 取产品 id → PUT /api/preferences → 发一次智能体对话 →
//     假文本上游收到的 request body 里 model 必须是内部名（对外改名没把路由改坏）。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ADMIN_EMAIL, ROOT, USER_EMAIL, api, createReport, ensureDir, login, seedEnv, startFakeUpstream, startServer, waitFor } from './verify-r343-harness.mjs'

const VENDOR = /deepseek|geteapi|seeapi|cgcm|openai|claude|anthropic|gemini|qwen|doubao|火山|moonshot|zhipu|minimax|grok|sora|midjourney|seedream|kling|hunyuan|ernie|codex|workbuddy/i
const MODELISH = /[a-z0-9]-(flash|pro|turbo|luna|mini|max)\b/i

const report = createReport('r343 · 模型别名（a）接口 0 厂牌 /（b）切模型仍生效')
const work = ensureDir(path.join(ROOT, '.tmp-r343-verify'))
const dataDir = path.join(work, 'data-alias')
fs.rmSync(dataDir, { recursive: true, force: true })
ensureDir(dataDir)

const fake = await startFakeUpstream({ reply: '收到，这一步就这样做。' })
console.log('[fake] ' + fake.origin)

const seed = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['--experimental-sqlite', path.join(ROOT, 'scripts', 'verify-r343-seed.mjs'), 'seed', dataDir, fake.origin], {
    cwd: ROOT,
    env: { ...process.env, ...seedEnv(dataDir) },
    windowsHide: true,
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk) => (out += chunk))
  child.stderr.on('data', (chunk) => (err += chunk))
  child.on('close', (code) => resolve({ code, out, err }))
})
if (seed.code !== 0) {
  console.error(seed.err)
  process.exit(1)
}

const port = await new Promise((resolve, reject) => {
  import('node:net').then(({ default: net }) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port: got } = server.address()
      server.close(() => resolve(got))
    })
  })
})
const server = await startServer({ dataDir, port, fakeOrigin: fake.origin })
console.log('[server] ' + server.base)

const scan = (name, response, expectStatus = 200) => {
  const text = String(response.text || '')
  const vendor = text.match(VENDOR)
  const modelish = text.match(MODELISH)
  report.check(
    name + ' 响应体 0 厂牌 / 0 内部型号',
    response.status === expectStatus && !vendor && !modelish,
    'status=' + response.status + (vendor ? ' 厂牌命中=' + vendor[0] : '') + (modelish ? ' 型号命中=' + modelish[0] : '') + ' len=' + text.length,
  )
  return { vendor, modelish }
}

let exitCode = 0
try {
  const cookie = await login(server.base, USER_EMAIL)

  // ── (a) /api/models ────────────────────────────────────────────────────
  const models = await api(server.base, '/api/models', { cookie })
  scan('(a1) GET /api/models', models)
  const catalog = models.json || {}
  const ids = (catalog.models || []).map((item) => item.id)
  report.check('(a2) /api/models 至少有一个模型', ids.length > 0, 'ids=' + JSON.stringify(ids))
  report.check('(a3) /api/models 的 id 全是产品名', ids.length > 0 && ids.every((id) => /^visionqa-(chat|vision|general)(-\d+)?$/.test(id)), 'ids=' + JSON.stringify(ids))
  const forKeys = ['current', 'textModel', 'visionModel'].filter((key) => catalog[key])
  report.check(
    '(a4) current / textModel / visionModel 也是产品 id',
    forKeys.every((key) => /^visionqa-(chat|vision|general)(-\d+)?$/.test(String(catalog[key]))),
    forKeys.map((key) => key + '=' + catalog[key]).join(' · '),
  )
  const publicId = ids[0]
  console.log('[models] publicId=' + publicId + ' labels=' + JSON.stringify((catalog.models || []).map((item) => item.label)))

  // ── (a) PUT / GET /api/preferences ─────────────────────────────────────
  const put = await api(server.base, '/api/preferences', { method: 'PUT', cookie, body: { model: publicId } })
  scan('(a5) PUT /api/preferences（产品 id）', put)
  report.check('(a6) PUT 回给界面的还是产品 id', put.json?.model === publicId, 'model=' + put.json?.model)

  const putInternal = await api(server.base, '/api/preferences', { method: 'PUT', cookie, body: { model: 'deepseek-flash' } })
  report.check('(a7) PUT 传内部名被 400 挡住', putInternal.status === 400, 'status=' + putInternal.status + ' body=' + String(putInternal.text).slice(0, 160))
  scan('(a8) PUT 内部名的 400 响应体', putInternal, 400)

  const prefs = await api(server.base, '/api/preferences', { cookie })
  scan('(a9) GET /api/preferences', prefs)
  report.check('(a10) GET 回来的是产品 id', prefs.json?.model === publicId, 'model=' + prefs.json?.model)

  // ── (a) /api/agents：先用产品 id 建一个预设（内部名会被挡在外面），再扫列表 ──
  const created = await api(server.base, '/api/agents', {
    method: 'POST',
    cookie,
    body: { name: 'r343 验证预设', category: '脚本分镜', role: '只用来验证模型别名', systemPrompt: '你只回答「好」。不要提到任何模型。', model: publicId, temperature: 0.4 },
  })
  scan('(a11) POST /api/agents（产品 id）', created, 201)
  const agentId = created.json?.id
  report.check('(a12) 建预设成功且模型回产品 id', Boolean(agentId) && created.json?.model === publicId, 'status=' + created.status + ' id=' + agentId + ' model=' + created.json?.model)

  const agents = await api(server.base, '/api/agents', { cookie })
  scan('(a13) GET /api/agents', agents)
  const items = agents.json?.items || []
  report.check('(a14) /api/agents 列表里有这个预设', items.length > 0 && items.some((item) => item.id === agentId), 'count=' + items.length)
  report.check(
    '(a15) /api/agents 的 models / defaultModel 是产品 id',
    (agents.json?.models || []).every((name) => /^visionqa-/.test(name)) && /^visionqa-/.test(String(agents.json?.defaultModel || '')),
    'models=' + JSON.stringify(agents.json?.models) + ' default=' + agents.json?.defaultModel,
  )
  report.check(
    '(a16) /api/agents 的 item.model / lastModel 是产品 id 或空',
    items.every((item) => !item.model || /^visionqa-/.test(item.model)) && items.every((item) => !item.lastModel || /^visionqa-/.test(item.lastModel)),
    JSON.stringify(items.map((item) => ({ id: item.id, model: item.model, lastModel: item.lastModel }))).slice(0, 400),
  )

  const single = await api(server.base, '/api/agents/' + agentId, { cookie })
  scan('(a17) GET /api/agents/:id', single)

  const history = await api(server.base, '/api/agents/' + agentId + '/history', { cookie })
  scan('(a18) GET /api/agents/:id/history', history)

  // ── (a)+(b) 对话：响应干净，同时「切模型」真的换掉了上游请求里的 model ──
  // 关键：要用**第二个**模型来验。只用默认那一个，即使产品 id 没换回内部名，
  // 模型链也会回落到链首（同一个内部名），看起来「没坏」其实什么都没验到。
  const secondId = ids[1] || ''
  report.check('(b0) /api/models 至少两个模型，才验得了「切换」', Boolean(secondId), 'ids=' + JSON.stringify(ids))
  const targetId = secondId || publicId
  const switchPut = await api(server.base, '/api/preferences', { method: 'PUT', cookie, body: { model: targetId } })
  report.check('(b0b) 顶栏切到第二个模型：PUT 成功且回产品 id', switchPut.status === 200 && switchPut.json?.model === targetId, 'status=' + switchPut.status + ' model=' + switchPut.json?.model)

  const chatBefore = fake.of(/\/chat\/completions$/).length
  const chat = await api(server.base, '/api/agents/' + agentId + '/chat', {
    method: 'POST',
    cookie,
    body: { message: '请按你的预设回一句', model: targetId, outputType: '文案', count: 1 },
  })
  scan('(a19) POST /api/agents/:id/chat', chat)
  report.check('(a20) 对话成功', chat.status === 200, 'status=' + chat.status + ' body=' + String(chat.text).slice(0, 200))
  report.check('(a21) 对话响应的 model 是产品 id', chat.json?.model === targetId, 'model=' + chat.json?.model + ' attempted=' + JSON.stringify(chat.json?.attempted))
  const upstream = await waitFor(() => fake.of(/\/chat\/completions$/)[chatBefore], 10000)
  report.check('(b1) 假文本上游收到这次对话', Boolean(upstream), upstream ? 'model=' + upstream.json?.model : '（没收到）')
  report.check(
    '(b2) 切到第二个模型后，上游正文里的 model 是它对应的内部名',
    upstream?.json?.model === 'deepseek-v4-pro',
    'upstream.model=' + upstream?.json?.model + '（对外=' + targetId + '，期望 deepseek-v4-pro）',
  )

  const chatBackBefore = fake.of(/\/chat\/completions$/).length
  const chatBack = await api(server.base, '/api/agents/' + agentId + '/chat', {
    method: 'POST',
    cookie,
    body: { message: '再回一句', model: publicId, outputType: '文案', count: 1 },
  })
  const upstreamBack = await waitFor(() => fake.of(/\/chat\/completions$/)[chatBackBefore], 10000)
  report.check(
    '(b3) 切回第一个模型，上游收到的是它自己的内部名',
    chatBack.status === 200 && upstreamBack?.json?.model === 'deepseek-flash',
    'upstream.model=' + upstreamBack?.json?.model + '（对外=' + publicId + '，期望 deepseek-flash）',
  )

  // ── (a) local-agent / system / health ──────────────────────────────────
  const meta = await api(server.base, '/api/local-agent/meta', { cookie })
  scan('(a22) GET /api/local-agent/meta', meta)
  report.check(
    '(a23) local-agent meta 的 defaultModel 是产品 id',
    /^visionqa-/.test(String(meta.json?.defaultModel || '')),
    'defaultModel=' + meta.json?.defaultModel + ' models=' + JSON.stringify(meta.json?.models),
  )

  const service = await api(server.base, '/api/system/service', { cookie })
  scan('(a24) GET /api/system/service', service)

  const health = await api(server.base, '/api/health')
  scan('(a25) GET /api/health', health)

  fs.writeFileSync(path.join(work, 'alias-responses.json'), JSON.stringify({
    models: catalog,
    preference: prefs.json,
    agentsList: agents.json,
    agentSingle: single.json,
    agentHistory: history.json,
    agentChat: chat.json,
    localAgentMeta: meta.json,
    service: service.json,
    health: health.json,
    upstreamChatRequest: upstream?.json || null,
  }, null, 2))
} catch (error) {
  report.check('执行过程没有抛错', false, String(error?.stack || error).slice(0, 1200))
} finally {
  exitCode = report.finish()
  await server.close()
  await fake.close()
}
process.exit(exitCode)
