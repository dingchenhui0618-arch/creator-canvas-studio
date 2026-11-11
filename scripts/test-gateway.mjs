// 平台生成通道集成测试：起一个假方舟（Ark）上游，走真实转发链路。
// 验证：令牌鉴权、出图转发与取图、失败计入 Key 健康度、出视频建任务 + 轮询回到同一把 Key、
// 池里没有对应能力的 Key 时明确报错，以及路由日志记录。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-gateway-'))
process.env.DATA_DIR = temp
process.env.VQ_KEY_SECRET = 'test-secret-for-gateway'
process.env.VISION_API_KEY = ''
process.env.VQ_GATEWAY_TOKEN = 'test-gateway-token'

let imageMode = 'ok'
let videoPolls = 0
let cgcmVideoPolls = 0
const seen = []

const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    // 坏 Key 专用前缀：任何请求都 500，用来验证「换下一把」
    if (req.url.startsWith('/v1bad/')) return send(500, { error: { message: 'bad key boom' } })
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      if (imageMode === 'fail') return send(500, { error: { message: 'internal boom' } })
      if (imageMode === 'empty') return send(200, { data: [] })
      return send(200, { data: [{ url: 'https://example.invalid/a.png' }] })
    }
    if (req.method === 'POST' && req.url === '/v1/contents/generations/tasks') {
      return send(200, { id: 'task-abc' })
    }
    // SeeAPI / CGCM 形态（baseUrl 里带 cgcm 的 Key 走这一套）
    if (req.method === 'POST' && req.url === '/cgcm/v1/images/generations') {
      if (imageMode === 'fail') return send(500, { error: { message: 'cgcm boom' } })
      return send(200, { data: [{ url: 'https://example.invalid/cgcm-sync.png' }] })
    }
    if (req.method === 'POST' && req.url === '/cgcm/v1/images/generations/async') {
      return send(202, { id: 'img-job-1', object: 'task', status: 'queued' })
    }
    if (req.method === 'POST' && req.url === '/cgcm/v1/video/generations') {
      // 发版重启场景用单独的任务 id，免得和前面的用例互相覆盖
      if (body.includes('重启')) return send(202, { id: 'job-restart', object: 'task', status: 'queued' })
      return send(202, { id: 'job-cgcm', object: 'task', status: 'queued' })
    }
    if (req.method === 'GET' && req.url === '/cgcm/v1/tasks/job-restart') {
      return send(200, { id: 'job-restart', status: 'succeeded', output: { video_url: 'https://example.invalid/restart.mp4' } })
    }
    if (req.method === 'GET' && req.url === '/cgcm/v1/tasks/img-job-1') {
      return send(200, { id: 'img-job-1', status: 'succeeded', output: { url: 'https://example.invalid/cgcm-async.png' } })
    }
    if (req.method === 'GET' && req.url === '/cgcm/v1/tasks/job-cgcm') {
      cgcmVideoPolls += 1
      return send(200, cgcmVideoPolls < 2
        ? { id: 'job-cgcm', status: 'running' }
        : { id: 'job-cgcm', status: 'succeeded', output: { video_url: 'https://example.invalid/cgcm.mp4' } })
    }
    if (req.method === 'GET' && req.url === '/v1/contents/generations/tasks/task-abc') {
      videoPolls += 1
      return send(200, videoPolls < 2 ? { id: 'task-abc', status: 'running' } : { id: 'task-abc', status: 'succeeded', content: { video_url: 'https://example.invalid/v.mp4' } })
    }
    send(404, { error: { message: 'not found' } })
  })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + upstream.address().port + '/v1'

const { createKey, deleteKey, listRoutes } = await import('../server/keyvault.mjs')
const { config } = await import('../server/config.mjs')
const { authorizeGateway, createImageTask, createVideoTask, gatewayConfigured, gatewayStatus, generateImage, pollVideoTask } = await import('../server/gateway.mjs')

const imageKey = createKey({
  name: '假出图 Key',
  provider: 'volcengine',
  baseUrl: base,
  apiKey: 'sk-image-1234567890',
  models: ['fake-image'],
  capabilities: ['image'],
  priority: 10,
  weight: 100,
})
createKey({
  name: '假视频 Key',
  provider: 'volcengine',
  baseUrl: base,
  apiKey: 'sk-video-1234567890',
  models: ['fake-video'],
  capabilities: ['video'],
  priority: 10,
  weight: 100,
})
// 出视频 Key 与出图 Key 分开：一次调用只能选到声明了对应能力的那把


// 1) 令牌鉴权：没带 / 带错都拒，带对才放行
assert.equal(gatewayConfigured(), true)
assert.equal(authorizeGateway({ headers: {} }).code, 'GATEWAY_UNAUTHORIZED')
assert.equal(authorizeGateway({ headers: { authorization: 'Bearer wrong' } }).code, 'GATEWAY_UNAUTHORIZED')
assert.equal(authorizeGateway({ headers: { authorization: 'Bearer test-gateway-token' } }).ok, true)

// 2) 出图：转发到 {baseUrl}/images/generations，用池里那把 Key 的凭证
const image = await generateImage({ model: 'fake-image', prompt: '一只猫', size: '1024x1024' })
assert.deepEqual(image.urls, ['https://example.invalid/a.png'])
assert.deepEqual(image.data, [{ url: 'https://example.invalid/a.png' }], '上游 body 必须原样出现在顶层 data：画布按 data[].url 取图')
const imageCall = seen.find((item) => item.url === '/v1/images/generations')
assert.equal(imageCall.auth, 'Bearer sk-image-1234567890', '必须用平台 Key 的凭证请求上游')
assert.match(imageCall.body, /一只猫/)
assert.equal(JSON.parse(imageCall.body).model, 'fake-image')

// 3) 上游 500 → 失败要有结论，并且计入路由日志
imageMode = 'fail'
await assert.rejects(() => generateImage({ model: 'fake-image', prompt: 'x' }), (error) => error.code === 'UPSTREAM_REJECTED' && error.status === 502)
const afterFail = listRoutes(20).items.filter((item) => item.capability === 'image')
assert.equal(afterFail.length, 2)
assert.equal(afterFail[0].ok, false)
assert.equal(afterFail[0].keyName, '假出图 Key')

// 4) 上游 200 但没有图片 → 不能当成功
imageMode = 'empty'
await assert.rejects(() => generateImage({ model: 'fake-image', prompt: 'x' }), (error) => error.code === 'UPSTREAM_EMPTY')

// 5) 出视频：建任务 → 轮询回到同一把 Key → 终态只记一条
imageMode = 'ok'
const task = await createVideoTask({ model: 'fake-video', content: [{ type: 'text', text: '城市夜景' }], ratio: '16:9' })
assert.equal(task.id, 'task-abc')
const createCall = seen.find((item) => item.method === 'POST' && item.url === '/v1/contents/generations/tasks')
assert.equal(createCall.auth, 'Bearer sk-video-1234567890')
const poll1 = await pollVideoTask('task-abc')
assert.equal(poll1.status, 'running')
const poll2 = await pollVideoTask('task-abc')
assert.equal(poll2.status, 'succeeded')
assert.equal(poll2.content.video_url, 'https://example.invalid/v.mp4')
const videoRoutes = listRoutes(50).items.filter((item) => item.capability === 'video')
assert.equal(videoRoutes.length, 2, '建任务一条 + 终态一条，轮询中间态不刷日志')

// 6) 不认识的视频任务：说清是重启导致的，不假装在跑
await assert.rejects(() => pollVideoTask('task-nope'), (error) => error.code === 'TASK_NOT_FOUND' && error.status === 404)

// 6.5) 路由层：方舟写法的路径与平台写法等价，且鉴权在路由层就拦住
const { createGatewayRouter } = await import('../server/routes/gateway.mjs')
const router = createGatewayRouter()
const fakeRes = () => ({
  statusCode: 0,
  body: '',
  writeHead(status) {
    this.statusCode = status
    return this
  },
  end(chunk) {
    this.body = String(chunk || '')
    return this
  },
})
const fakeReq = (method, headers) => Object.assign(new PassThrough(), { method, headers })
const pollCallsBefore = seen.filter((item) => item.url.startsWith('/v1/contents/generations/tasks/task-abc')).length
const arkPollRes = fakeRes()
await router.handle(await fakeReq('GET', { authorization: 'Bearer test-gateway-token' }), arkPollRes, new URL('http://x/api/gateway/v1/contents/generations/tasks/task-abc'), '/api/gateway/v1/contents/generations/tasks/task-abc')
assert.equal(arkPollRes.statusCode, 200)
assert.equal(JSON.parse(arkPollRes.body).status, 'succeeded')
const pollCallsAfter = seen.filter((item) => item.url.startsWith('/v1/contents/generations/tasks/task-abc')).length
assert.equal(pollCallsAfter, pollCallsBefore + 1, '方舟写法必须真的走到轮询')
const deniedRes = fakeRes()
await router.handle(await fakeReq('GET', { authorization: 'Bearer nope' }), deniedRes, new URL('http://x/api/gateway/v1/contents/generations/tasks/task-abc'), '/api/gateway/v1/contents/generations/tasks/task-abc')
assert.equal(deniedRes.statusCode, 401)
assert.equal(JSON.parse(deniedRes.body).code, 'GATEWAY_UNAUTHORIZED')
assert.equal(seen.filter((item) => item.url.startsWith('/v1/contents/generations/tasks/task-abc')).length, pollCallsAfter, '被拒的请求不能打到上游')
const unknownRes = fakeRes()
await router.handle(await fakeReq('GET', { authorization: 'Bearer test-gateway-token' }), unknownRes, new URL('http://x/api/gateway/v1/nope'), '/api/gateway/v1/nope')
assert.equal(unknownRes.statusCode, 404)

// 6.6) 模型目录：画布「测试 Key」探这里判活，内容只来自池里的声明
const modelsRes = fakeRes()
await router.handle(await fakeReq('GET', { authorization: 'Bearer test-gateway-token' }), modelsRes, new URL('http://x/api/gateway/v1/models'), '/api/gateway/v1/models')
assert.equal(modelsRes.statusCode, 200)
const listedModels = JSON.parse(modelsRes.body)
assert.equal(listedModels.object, 'list')
assert.ok(listedModels.data.some((item) => item.id === 'fake-image'), '池里声明的模型要出现在目录里')
assert.equal(JSON.stringify(listedModels).includes('sk-'), false, '模型目录不能带 Key')

// 7) 池里没有出图 Key：明确告诉管理员去加 Key，而不是回一个上游错误
deleteKey(imageKey.id)
await assert.rejects(() => generateImage({ model: 'fake-image', prompt: 'x' }), (error) => error.code === 'NO_IMAGE_KEY' && error.status === 503)
const noKeyRoute = listRoutes(20).items[0]
assert.equal(noKeyRoute.source, 'none')

// 9) 故障回退：第一把 500 就换第二把，调用方仍然拿到图；日志里两条、第二条是第 2 次尝试
const badBase = 'http://127.0.0.1:' + upstream.address().port + '/v1bad'
const badImageKey = createKey({
  name: '坏出图 Key',
  provider: 'volcengine',
  baseUrl: badBase,
  apiKey: 'sk-bad-image-1234567890',
  models: ['fake-image'],
  capabilities: ['image'],
  priority: 5,
  weight: 100,
})
const goodImageKey = createKey({
  name: '备援出图 Key',
  provider: 'volcengine',
  baseUrl: base,
  apiKey: 'sk-good-image-1234567890',
  models: ['fake-image'],
  capabilities: ['image'],
  priority: 10,
  weight: 100,
})
const routed = await generateImage({ model: 'fake-image', prompt: '换把试试' })
assert.deepEqual(routed.urls, ['https://example.invalid/a.png'])
assert.equal(routed.attempt, 2, '第一把失败后必须换到第 2 把')
assert.equal(routed.key.name, '备援出图 Key')
const failoverRoutes = listRoutes(40).items.filter((item) => item.capability === 'image')
assert.equal(failoverRoutes[0].ok, true)
assert.equal(failoverRoutes[0].attempt, 2, '成功那条要标明是第 2 次尝试')
assert.equal(failoverRoutes[0].keyName, '备援出图 Key')
assert.equal(failoverRoutes[1].ok, false)
assert.equal(failoverRoutes[1].attempt, 1)
assert.equal(failoverRoutes[1].keyName, '坏出图 Key')
assert.ok(listRoutes(40).summary.failover >= 1, '后台统计要能看到「换 Key 成功」')

// 9.1) 两把都坏：报错要说清试了几把，不能只报「上游拒绝」
imageMode = 'fail'
await assert.rejects(
  () => generateImage({ model: 'fake-image', prompt: '全坏' }),
  (error) => error.code === 'UPSTREAM_REJECTED' && error.attempts === 2 && /连续试了 2 把 Key/.test(error.message),
)
imageMode = 'ok'

// 9.2) 出视频建任务同样换把：第一把坏、第二把建成功，轮询回到第二把
const badVideoKey = createKey({
  name: '坏视频 Key',
  provider: 'volcengine',
  baseUrl: badBase,
  apiKey: 'sk-bad-video-1234567890',
  models: ['fake-video'],
  capabilities: ['video'],
  priority: 5,
  weight: 100,
})
const task2 = await createVideoTask({ model: 'fake-video', content: [{ type: 'text', text: '换把出视频' }] })
assert.equal(task2.attempt, 2)
assert.equal(task2.key.name, '假视频 Key')
assert.equal(task2.id, 'task-abc')
const pollAfterFailover = await pollVideoTask('task-abc')
assert.equal(pollAfterFailover.status, 'succeeded', '换把后建的任务，轮询要回到接住它的那把 Key')

// 9.3) 画布要的模型名没有任何 Key 声明：回人话，模型名只进后台日志
// （接真 Key 时最容易踩的坑：管理员照产品名填了模型，画布发的是上游真实模型名）
await assert.rejects(
  () => generateImage({ model: 'unserved-model', prompt: 'x' }),
  (error) =>
    error.code === 'NO_IMAGE_KEY' &&
    error.status === 503 &&
    !/unserved-model/.test(error.message) &&
    /unserved-model/.test(String(error.detail)),
)
assert.equal(listRoutes(20).items[0].source, 'none')
assert.ok(/unserved-model/.test(String(listRoutes(20).items[0].error)), '模型名要落在后台路由日志里')

// 9.4) 画布要的模型有没有 Key 接得住：缺 Key / 通用 Key / 精确声明 三种口径
const { modelCoverage, keyProtocol, upstreamUrl } = await import('../server/gateway.mjs')
const imageRows = () => modelCoverage().filter((row) => row.capability === 'image')
assert.deepEqual(imageRows().map((row) => row.coveredBy), ['none', 'none', 'none'], '池里只有声明了别的模型的 Key 时，画布的模型都算缺')
assert.equal(modelCoverage().filter((row) => row.capability === 'video').length, 8, '出视频的 8 个模型也要在对账表里')
const genericKey = createKey({
  name: '通用出图 Key',
  provider: 'volcengine',
  baseUrl: base,
  apiKey: 'sk-generic-image-1234567890',
  models: [],
  capabilities: ['image'],
  priority: 20,
  weight: 100,
})
assert.deepEqual(imageRows().map((row) => row.coveredBy), ['generic', 'generic', 'generic'], '模型清单留空算通用 Key')
assert.deepEqual(
  modelCoverage().filter((row) => row.capability === 'video').map((row) => row.coveredBy),
  Array(8).fill('none'),
  '通用出图 Key 不能顶出视频模型',
)
const exactKey = createKey({
  name: 'Seedream 4.5 专用',
  provider: 'volcengine',
  baseUrl: base,
  apiKey: 'sk-exact-image-1234567890',
  models: ['doubao-seedream-4-5-251128'],
  capabilities: ['image'],
  priority: 30,
  weight: 100,
})
const covered = imageRows()
assert.equal(covered[0].model, 'doubao-seedream-4-5-251128')
assert.equal(covered[0].coveredBy, 'model', '精确声明了模型名的 Key 优先算它')
assert.equal(covered[0].keys[0].name, 'Seedream 4.5 专用')
assert.deepEqual(covered.slice(1).map((row) => row.coveredBy), ['generic', 'generic'])
const videoExact = createKey({
  name: 'Seedance 2.0 Mini 专用',
  provider: 'cgcm',
  baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/cgcm',
  apiKey: 'sk-cgcm-1234567890',
  models: ['seedance-2.0-mini'],
  capabilities: ['video'],
  priority: 30,
  weight: 100,
})
const miniRow = modelCoverage().find((row) => row.model === 'seedance-2.0-mini')
assert.equal(miniRow.coveredBy, 'model')
assert.equal(miniRow.keys[0].name, 'Seedance 2.0 Mini 专用')
deleteKey(videoExact.id)
deleteKey(genericKey.id)
deleteKey(exactKey.id)

// 9.6) 上游协议按 Key 的 baseUrl 认：同一套接口既能接方舟，也能接 SeeAPI / CGCM
assert.equal(keyProtocol({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }), 'ark')
assert.equal(keyProtocol({ baseUrl: 'https://api.cgcm-api.com' }), 'cgcm')
assert.equal(keyProtocol({ baseUrl: 'https://api.cgcm-api.com/v1/' }), 'cgcm')
assert.equal(upstreamUrl({ baseUrl: 'https://api.cgcm-api.com' }, 'videoCreate'), 'https://api.cgcm-api.com/v1/video/generations')
assert.equal(
  upstreamUrl({ baseUrl: 'https://api.cgcm-api.com/v1/' }, 'task', 'job-1'),
  'https://api.cgcm-api.com/v1/tasks/job-1',
  '地址写成 …/v1 也要拼对',
)
assert.equal(
  upstreamUrl({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }, 'task', 'task-1'),
  'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-1',
)
assert.equal(upstreamUrl({ baseUrl: 'http://127.0.0.1:1/ark' }, 'image'), 'http://127.0.0.1:1/ark/images/generations')

const cgcmBase = 'http://127.0.0.1:' + upstream.address().port + '/cgcm'
const cgcmImageKey = createKey({
  name: 'SeeAPI 出图 Key',
  provider: 'cgcm',
  baseUrl: cgcmBase,
  apiKey: 'sk-cgcm-image-1234567890',
  models: ['image-2-pro'],
  capabilities: ['image'],
  priority: 5,
  weight: 100,
})
const cgcmImage = await generateImage({ model: 'image-2-pro', prompt: '白底产品主图' })
assert.deepEqual(cgcmImage.urls, ['https://example.invalid/cgcm-sync.png'])
const cgcmSyncCall = seen.find((item) => item.url === '/cgcm/v1/images/generations')
assert.equal(cgcmSyncCall.auth, 'Bearer sk-cgcm-image-1234567890', 'SeeAPI 形态也要用平台 Key 转发')
assert.equal(JSON.parse(cgcmSyncCall.body).response_format, 'url', 'SeeAPI 同步出图默认回 base64，平台要的是地址')

const cgcmImageTask = await createImageTask({ model: 'image-2-pro', prompt: '异步出图' })
assert.equal(cgcmImageTask.id, 'img-job-1')
assert.ok(seen.some((item) => item.url === '/cgcm/v1/images/generations/async'), '异步出图要走 …/generations/async')
const cgcmImageDone = await pollVideoTask('img-job-1')
assert.equal(cgcmImageDone.status, 'succeeded')
assert.equal(cgcmImageDone.output.url, 'https://example.invalid/cgcm-async.png')

const cgcmVideoKey = createKey({
  name: 'SeeAPI 出视频 Key',
  provider: 'cgcm',
  baseUrl: cgcmBase,
  apiKey: 'sk-cgcm-video-1234567890',
  models: ['seedance-2.0-mini'],
  capabilities: ['video'],
  priority: 5,
  weight: 100,
})
const cgcmTask = await createVideoTask({ model: 'seedance-2.0-mini', prompt: '产品缓慢旋转展示', duration: 4, aspect_ratio: '16:9', resolution: '480p' })
assert.equal(cgcmTask.id, 'job-cgcm')
const cgcmCreateCall = seen.find((item) => item.url === '/cgcm/v1/video/generations')
assert.equal(cgcmCreateCall.auth, 'Bearer sk-cgcm-video-1234567890', 'SeeAPI 建视频任务用平台 Key')
assert.equal((await pollVideoTask('job-cgcm')).status, 'running')
const cgcmDone = await pollVideoTask('job-cgcm')
assert.equal(cgcmDone.status, 'succeeded')
assert.equal(cgcmDone.output.video_url, 'https://example.invalid/cgcm.mp4', 'SeeAPI 的成品在 output.video_url')
assert.equal(listRoutes(10).items[0].capability, 'video')
// 同一款模型两个名字：画布发方舟名，SeeAPI 只认自己的叫法，通道按别名换名转发
const aliasKey = createKey({
  name: 'SeeAPI Seedream 5.0 Pro',
  provider: 'cgcm',
  baseUrl: cgcmBase,
  apiKey: 'sk-cgcm-seedream-1234567890',
  models: ['seedream-5.0-pro'],
  capabilities: ['image'],
  priority: 5,
  weight: 100,
})
const aliasCoverage = modelCoverage().find((row) => row.model === 'doubao-seedream-5-0-pro-260628')
assert.equal(aliasCoverage.ready, true, '声明了 SeeAPI 名字的 Key 也算接得住画布这个模型')
assert.equal(aliasCoverage.upstream, 'seedream-5.0-pro', '后台要标出「按哪个上游名字发」')
const aliasedImage = await generateImage({ model: 'doubao-seedream-5-0-pro-260628', prompt: '一张白底产品图' })
const aliasCall = seen.filter((item) => item.url === '/cgcm/v1/images/generations').at(-1)
assert.equal(JSON.parse(aliasCall.body).model, 'seedream-5.0-pro', '发给 SeeAPI 的必须是它认的名字')
assert.ok(aliasedImage.ok)
// 方舟 Key 声明的是原名，就不要改写
const arkAliasKey = createKey({
  name: '方舟 Seedream 5.0 Pro',
  provider: 'volcengine',
  baseUrl: base,
  apiKey: 'sk-ark-seedream-1234567890',
  models: ['doubao-seedream-5-0-pro-260628'],
  capabilities: ['image'],
  priority: 6,
  weight: 100,
})
deleteKey(aliasKey.id)
const arkImage = await generateImage({ model: 'doubao-seedream-5-0-pro-260628', prompt: 'x' })
const arkCall = seen.filter((item) => item.url === '/v1/images/generations').at(-1)
assert.equal(JSON.parse(arkCall.body).model, 'doubao-seedream-5-0-pro-260628', '方舟 Key 不用改名')
assert.ok(arkImage.ok)
assert.equal(modelCoverage().find((row) => row.model === 'doubao-seedream-5-0-pro-260628').upstream, '', '原名接住时不标改名')
deleteKey(arkAliasKey.id)

for (const id of [cgcmImageKey.id, cgcmVideoKey.id]) deleteKey(id)

// 9.5) 权重只在同优先级内生效：两把同优先级时都算候选，但只试到成功为止
const order = [badImageKey.id, goodImageKey.id, badVideoKey.id]
for (const id of order) deleteKey(id)

// 8) 未配置令牌：整条通道 503，不匿名放行
config.gateway.token = ''
assert.equal(gatewayConfigured(), false)
assert.equal(authorizeGateway({ headers: { authorization: 'Bearer anything' } }).status, 503)
assert.equal(gatewayStatus().configured, false)

// 9.7) 发版重启不丢任务：任务 id → 那把 Key 的对应关系落盘，重启后照样能查到成品
const restartKey = createKey({
  name: '重启用例 Key',
  provider: 'cgcm',
  baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/cgcm',
  apiKey: 'sk_live_restart_1234567890',
  models: ['seedance-2.0-fast'],
  capabilities: ['video'],
  priority: 10,
  weight: 100,
})
const restartTask = await createVideoTask({ model: 'seedance-2.0-fast', prompt: '重启后还要能查到', duration: 4 })
assert.equal(restartTask.id, 'job-restart')
const ledgerRaw = fs.readFileSync(path.join(temp, 'gateway-tasks.json'), 'utf8')
assert.equal(ledgerRaw.includes('job-restart'), true, '任务台账必须落盘')
assert.equal(ledgerRaw.includes('sk_live_restart_1234567890'), false, '台账里不能有密钥明文')

const { forgetInMemoryForTest } = await import('../server/gateway-tasks.mjs')
forgetInMemoryForTest() // 等价于进程重启：内存清空，只能从磁盘恢复
const afterRestart = await pollVideoTask('job-restart')
assert.equal(afterRestart.status, 'succeeded')
assert.equal(afterRestart.output.video_url, 'https://example.invalid/restart.mp4', '重启后仍然查得到成品地址')
const restartPollCall = seen.filter((item) => item.url === '/cgcm/v1/tasks/job-restart').at(-1)
assert.equal(restartPollCall.auth, 'Bearer sk_live_restart_1234567890', '重启后轮询必须还回到同一把 Key 的凭证')

// 建任务的 Key 后来被删掉：已付费的任务照样能查完（凭证密文在台账里）
deleteKey(restartKey.id)
const afterKeyDelete = await pollVideoTask('job-restart')
assert.equal(afterKeyDelete.status, 'succeeded')
// 台账在后台可见：类型、状态、走的 Key 都能读出来
const listedTask = gatewayStatus().recentTasks.find((task) => task.id === 'job-restart')
assert.equal(listedTask.kind, 'video')
assert.equal(listedTask.status, 'succeeded')
assert.equal(listedTask.keyName, '重启用例 Key')
// 不存在的任务 id：明确 404，不说「重启丢了」
await assert.rejects(() => pollVideoTask('task-not-exist'), (error) => error.status === 404 && error.code === 'TASK_NOT_FOUND')

assert.equal(JSON.stringify(listRoutes(50)).includes('sk-image-1234567890'), false, '日志不能带 Key 明文')
assert.equal(JSON.stringify(listRoutes(50)).includes('sk-video-1234567890'), false, '日志不能带 Key 明文')

upstream.close()
fs.rmSync(temp, { recursive: true, force: true })
console.log('PASS gateway: 令牌鉴权 / 出图转发 / 失败计健康 / 空结果 / 视频建任务轮询 / 无 Key 明确报错 / 模型名对不上 / SeeAPI 协议 / 重启不丢任务 / 日志无明文')
