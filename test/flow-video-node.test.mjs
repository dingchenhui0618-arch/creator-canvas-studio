// 工作流「出视频」节点（v0.9.200）：不调真实上游，用本地假上游把
//   扣费 → 建任务 → 轮询 → 出片 → 下载落盘 → 节点输出 → 进度事件 → 失败 / 超时退款 → 产物鉴权
// 整条链跑一遍。真实出视频会花上游额度（一条约 15 积分 / ¥1.4），这里一次都不调。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-flow-video-'))
process.env.DATA_DIR = dir
process.env.VQ_KEY_SECRET = 'test-secret-flow-video'
process.env.VISION_API_KEY = ''
process.env.VQ_REQUIRE_AUTH = '1'
// 轮询间隔调小：这里验的是「轮询到出片」这条链路，不是真等三分钟
process.env.VQ_FLOW_VIDEO_POLL_MS = '25'

// 一段最小的 mp4 头（ftyp box）：字节数够小、能原样落盘并原样读回，测试不靠它能播
const tinyMp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isomiso2mp41', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x08]),
  Buffer.from('free', 'ascii'),
])

const tasks = new Map()
let taskSeq = 0
let createAttempts = 0
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const url = String(req.url || '')
    if (req.method === 'POST' && url.endsWith('/v1/video/generations')) {
      createAttempts += 1
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const prompt = String(body.prompt || '')
      if (!body.aspect_ratio) return send(400, { error: { code: 'validation_error', message: 'aspect_ratio 必填' } })
      if (prompt.includes('视频失败')) return send(500, { error: { code: 'upstream_rejected', message: '上游拒绝这次出视频' } })
      taskSeq += 1
      const id = 'task_v' + taskSeq
      tasks.set(id, { prompt, polls: 0 })
      return send(200, { id })
    }
    const poll = url.match(/\/v1\/tasks\/(task_v\d+)$/)
    if (req.method === 'GET' && poll) {
      const rec = tasks.get(poll[1])
      if (!rec) return send(404, { error: 'not found' })
      rec.polls += 1
      if (rec.prompt.includes('超时')) return send(200, { status: 'processing', progress: 0.2 })
      if (rec.polls < 3) return send(200, { status: 'processing', progress: rec.polls * 0.3 })
      return send(200, { status: 'succeeded', video_url: base + '/files/video.mp4' })
    }
    if (req.method === 'GET' && url === '/files/video.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(tinyMp4.length) })
      res.end(tinyMp4)
      return
    }
    send(404, { error: 'not found' })
  })
})
let base = ''
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
base = 'http://127.0.0.1:' + upstream.address().port
test.after(() => new Promise((resolve) => upstream.close(resolve)))

const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const { createKey } = await import('../server/keyvault.mjs')
const flows = await import('../server/flows.mjs')
const video = await import('../server/flow-video.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')

createKey({
  name: '测试工作流出视频',
  provider: 'seeapi',
  baseUrl: base + '/seeapi',
  apiKey: 'sk-test-flow-video-1234567890',
  models: ['seedance-2.0'],
  capabilities: ['video'],
  priority: 10,
  weight: 100,
})

function email(name) {
  return name + String.fromCharCode(64) + 'flow-video.test'
}

const owner = auth.createUser({ email: email('owner'), password: 'Passw0rd!demo', name: '出视频用户', kind: 'user' })
const other = auth.createUser({ email: email('other'), password: 'Passw0rd!demo', name: '别人', kind: 'user' })
for (const user of [owner, other]) {
  if (credits.balanceOf(user.id) < 100) credits.grant(user.id, 100, { note: 'flow-video test' })
}

function node(id, kind, config) {
  return { id, type: kind, position: { x: 0, y: 0 }, data: { kind, title: kind, description: '', config } }
}

function makeFlow(ownerId, nodes, edges) {
  return { id: 'flow-' + Math.random().toString(36).slice(2, 10), name: '出视频流程', ownerId, nodes, edges, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
}

function videoFlow(ownerId, prompt, nodeId = 'video-1') {
  return makeFlow(
    ownerId,
    [
      node('input-1', 'input', { text: '春日陶瓷杯主图' }),
      node(nodeId, 'video', { prompt, ratio: '9:16', duration: 8, resolution: '720p', model: '' }),
      node('output-1', 'output', { format: 'text' }),
    ],
    [
      { id: 'e1', source: 'input-1', target: nodeId, sourceHandle: 'out', targetHandle: 'in' },
      { id: 'e2', source: nodeId, target: 'output-1', sourceHandle: 'out', targetHandle: 'in' },
    ],
  )
}

test('出视频节点：真出一段、扣 15 积分、产物落在这次运行目录里、进度有推给页面', async () => {
  const before = credits.balanceOf(owner.id)
  const events = []
  const run = await flows.runFlow(videoFlow(owner.id, '一只橘猫在木桌上打盹'), { onEvent: (event) => events.push(event) })
  assert.equal(run.status, 'success')
  const videoNode = run.nodes.find((item) => item.kind === 'video')
  assert.equal(videoNode.status, 'success')
  assert.equal(videoNode.output.credits, 15)
  assert.equal(videoNode.output.ratio, '9:16')
  assert.equal(videoNode.output.duration, 8)
  assert.equal(videoNode.output.resolution, '720p')
  assert.equal(videoNode.output.modelLabel, 'Seedance 2.0')
  assert.match(videoNode.output.videoUrl, /^\/api\/runs\/[\w-]+\/assets\/video-1\.mp4$/)
  // 扣费是真的扣，不是只写在输出里
  assert.equal(credits.balanceOf(owner.id), before - 15)
  // 落盘：DATA_DIR/runs/<runId>/video-1.mp4，内容就是上游给的那段
  const file = path.join(dir, 'runs', run.id, 'video-1.mp4')
  assert.equal(fs.readFileSync(file).equals(tinyMp4), true)
  // 三次轮询里至少推过一条进度：没有它，页面在三分钟里只有转圈
  const progress = events.filter((event) => event.type === 'node-progress')
  assert.ok(progress.length >= 2, '应当每轮推一条 node-progress')
  assert.equal(progress[0].nodeId, 'video-1')
  assert.equal(typeof progress[progress.length - 1].waitedMs, 'number')
  // 运行记录：视频积分单独一项，并算进总花费
  assert.equal(run.videoCredits, 15)
  assert.equal(run.imageCredits, 0)
  assert.equal(run.spentTotal, (run.credits?.refunded ? 0 : Number(run.credits?.cost) || 0) + 15)
  // 最终输出里要能看见这段视频，不然用户拿到的只是一段话
  assert.match(run.output, /\/api\/runs\/.+\/assets\/video-1\.mp4/)
  const outputNode = run.nodes.find((item) => item.kind === 'output')
  assert.equal(outputNode.output.videoCount, 1)
})

test('出视频失败：节点记失败、积分全额退回、不留半段文件', async () => {
  const before = credits.balanceOf(owner.id)
  const run = await flows.runFlow(videoFlow(owner.id, '这条视频失败'))
  assert.equal(run.status, 'error')
  const videoNode = run.nodes.find((item) => item.kind === 'video')
  assert.equal(videoNode.status, 'error')
  assert.ok(videoNode.error && videoNode.error.length > 0)
  assert.equal(credits.balanceOf(owner.id), before, '失败必须全额退回，余额不能少')
  assert.equal(fs.existsSync(path.join(dir, 'runs', run.id, 'video-1.mp4')), false)
  assert.equal(run.videoCredits, 0)
})

test('出视频超时：按失败全额退，错误里写清等了多少秒', async () => {
  const before = credits.balanceOf(owner.id)
  const taskBefore = createAttempts
  await assert.rejects(
    video.runVideoGeneration({
      ownerId: owner.id,
      runId: 'run_timeout01',
      nodeId: 'video-1',
      prompt: '一直不出片的超时测试',
      ratio: '9:16',
      duration: 4,
      resolution: '480p',
      timeoutMs: 200,
      pollMs: 25,
    }),
    /超时/,
  )
  assert.equal(credits.balanceOf(owner.id), before, '超时也必须全额退回')
  assert.equal(createAttempts, taskBefore + 1, '超时只建一次任务，不换任务重跑（换一次就是再花一次钱）')
  assert.equal(fs.existsSync(path.join(dir, 'runs', 'run_timeout01', 'video-1.mp4')), false)
})

test('节点 id 带斜杠 / 上跳也只落在 runs/<runId>/ 里，写不出运行目录', async () => {
  const run = await flows.runFlow(videoFlow(owner.id, '越界写入检查', '../evil'))
  const videoNode = run.nodes.find((item) => item.kind === 'video')
  assert.equal(videoNode.status, 'success')
  assert.match(videoNode.output.videoUrl, /^\/api\/runs\/[\w-]+\/assets\/[\w-]+\.mp4$/)
  const fileName = String(videoNode.output.videoUrl).split('/').pop()
  assert.equal(fs.existsSync(path.join(dir, 'runs', run.id, fileName)), true)
  assert.equal(fs.existsSync(path.join(dir, 'runs', 'evil.mp4')), false, '不能写到运行目录外面')
})

test('运行前估价：出视频节点按模型单价，比例 / 时长 / 清晰度来自唯一真源', () => {
  const options = video.videoNodeOptions()
  assert.equal(options.defaultModel, 'seedance-2.0')
  assert.equal(options.defaultRatio, '9:16')
  assert.equal(options.defaultDuration, 4)
  assert.equal(options.defaultResolution, '720p')
  assert.ok(options.models.some((item) => item.id === 'seedance-2.0' && item.credits === 15))
  assert.ok(options.durations.some((item) => item.seconds === 8))
  assert.ok(options.resolutions.some((item) => item.value === '480p'))
  assert.ok(options.ratios.some((item) => item.ratio === '16:9'))
  assert.equal(video.videoNodesCost([{ type: 'video' }, { type: 'video' }, { type: 'image' }], ''), 30)
  assert.equal(video.videoNodeCredits('seedance-2.0'), 15)
})

// ---------- 产物接口：鉴权 + 视频要支持 Range ----------
const cookieOf = (user) => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.21.1' }).token).split(';')[0]

function mockReq({ method = 'GET', cookie = '', headers = {} } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = { ...(cookie ? { cookie } : {}), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.push(null)
  return req
}

function mockRes() {
  const res = new EventEmitter()
  Object.assign(res, {
    statusCode: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
    setHeader(name, value) { this.headers[name] = value },
    write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true },
    end(chunk) { if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.writableEnded = true },
  })
  Object.defineProperty(res, 'raw', { get() { return Buffer.concat(this.chunks) } })
  return res
}

async function callAsset(target, cookie, headers) {
  const router = createFlowsRouter()
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + target)
  await router.handle(mockReq({ method: 'GET', cookie, headers }), res, url, url.pathname)
  return res
}

test('运行产物视频：主人能读、支持 Range、别人 404、未登录 401', async () => {
  const run = await flows.runFlow(videoFlow(owner.id, '归属检查的橘猫视频'))
  const videoNode = run.nodes.find((item) => item.kind === 'video')
  const target = videoNode.output.videoUrl

  const mine = await callAsset(target, cookieOf(owner))
  assert.equal(mine.statusCode, 200)
  assert.equal(mine.headers['Content-Type'], 'video/mp4')
  assert.equal(mine.headers['Accept-Ranges'], 'bytes')
  assert.equal(mine.raw.equals(tinyMp4), true)

  const ranged = await callAsset(target, cookieOf(owner), { range: 'bytes=0-3' })
  assert.equal(ranged.statusCode, 206)
  assert.equal(ranged.headers['Content-Range'], 'bytes 0-3/' + tinyMp4.length)
  assert.equal(ranged.headers['Content-Length'], '4')
  assert.equal(ranged.raw.equals(tinyMp4.subarray(0, 4)), true)

  const bad = await callAsset(target, cookieOf(owner), { range: 'bytes=9999-' })
  assert.equal(bad.statusCode, 416)

  const theirs = await callAsset(target, cookieOf(other))
  assert.equal(theirs.statusCode, 404, '别人的运行对当前账号就是不存在，不能泄露有没有这个文件')

  const anonymous = await callAsset(target, '')
  assert.equal(anonymous.statusCode, 401, '未登录也不能读运行产物')
})

test('运行产物白名单：只认图与视频，脚本、html、路径穿越都不行', async () => {
  const run = await flows.runFlow(videoFlow(owner.id, '白名单检查'))
  const hit = await callAsset('/api/runs/' + run.id + '/assets/evil.sh', cookieOf(owner))
  assert.notEqual(hit.statusCode, 200)
  const evil = await callAsset('/api/runs/' + run.id + '/assets/..%2F..%2Fauth.db', cookieOf(owner))
  assert.notEqual(evil.statusCode, 200)
})
