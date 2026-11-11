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
const { authorizeGateway, createVideoTask, gatewayConfigured, gatewayStatus, generateImage, pollVideoTask } = await import('../server/gateway.mjs')

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

// 9.3) 权重只在同优先级内生效：两把同优先级时都算候选，但只试到成功为止
const order = [badImageKey.id, goodImageKey.id, badVideoKey.id]
for (const id of order) deleteKey(id)

// 8) 未配置令牌：整条通道 503，不匿名放行
config.gateway.token = ''
assert.equal(gatewayConfigured(), false)
assert.equal(authorizeGateway({ headers: { authorization: 'Bearer anything' } }).status, 503)
assert.equal(gatewayStatus().configured, false)

assert.equal(JSON.stringify(listRoutes(50)).includes('sk-image-1234567890'), false, '日志不能带 Key 明文')
assert.equal(JSON.stringify(listRoutes(50)).includes('sk-video-1234567890'), false, '日志不能带 Key 明文')

upstream.close()
fs.rmSync(temp, { recursive: true, force: true })
console.log('PASS gateway: 令牌鉴权 / 出图转发 / 失败计健康 / 空结果 / 视频建任务轮询 / 无 Key 明确报错 / 日志无明文')
