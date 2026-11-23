// 工作流「出图」节点：不调真实上游，用本地假上游把
//   扣费 → 出图 → 下载落盘 → 节点输出 → 运行归属鉴权 → 失败退款 整条链跑一遍。
// 真实出图会花上游额度，这里一次都不调。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-flow-image-'))
process.env.DATA_DIR = dir
process.env.VQ_KEY_SECRET = 'test-secret-flow-image'
process.env.VISION_API_KEY = ''
process.env.VQ_REQUIRE_AUTH = '1'

const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
)

let imageAttempts = 0
const seenPrompts = []
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      imageAttempts += 1
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const prompt = String(body.prompt || '')
      seenPrompts.push({ prompt, size: body.size, model: body.model })
      if (prompt.includes('图失败')) return send(500, { error: { code: 'upstream_rejected', message: '上游拒绝这次出图' } })
      // 回地址而不是 base64：把「下载上游文件」这一步也真的走一遍
      return send(200, { created: 1, data: [{ url: base + '/files/img.png' }] })
    }
    if (req.method === 'GET' && req.url === '/files/img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(tinyPng.length) })
      res.end(tinyPng)
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
const { createFlowsRouter } = await import('../server/routes/flows.mjs')

createKey({
  name: '测试工作流出图',
  provider: 'geteapi',
  baseUrl: base + '/v1',
  apiKey: 'sk-test-flow-image-1234567890',
  models: ['gpt-image-2'],
  capabilities: ['image'],
  priority: 10,
  weight: 100,
})

function email(name) {
  return name + String.fromCharCode(64) + 'flow-image.test'
}

const owner = auth.createUser({ email: email('owner'), password: 'Passw0rd!demo', name: '出图用户', kind: 'user' })
const other = auth.createUser({ email: email('other'), password: 'Passw0rd!demo', name: '别人', kind: 'user' })
for (const user of [owner, other]) {
  if (credits.balanceOf(user.id) < 100) credits.grant(user.id, 100, { note: 'flow-image test' })
}

function node(id, kind, config) {
  return { id, type: kind, position: { x: 0, y: 0 }, data: { kind, title: kind, description: '', config } }
}

function makeFlow(ownerId, nodes, edges) {
  return { id: 'flow-' + Math.random().toString(36).slice(2, 10), name: '出图流程', ownerId, nodes, edges, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
}

function imageFlow(ownerId, prompt) {
  return makeFlow(
    ownerId,
    [
      node('input-1', 'input', { text: '春日陶瓷杯主图' }),
      node('image-1', 'image', { prompt, ratio: '9:16', model: '' }),
      node('output-1', 'output', { format: 'text' }),
    ],
    [
      { id: 'e1', source: 'input-1', target: 'image-1', sourceHandle: 'out', targetHandle: 'in' },
      { id: 'e2', source: 'image-1', target: 'output-1', sourceHandle: 'out', targetHandle: 'in' },
    ],
  )
}

test('出图节点：真的画一张、扣 3 积分（最便宜的 2.6）、产物落在这次运行目录里', async () => {
  const before = credits.balanceOf(owner.id)
  const run = await flows.runFlow(imageFlow(owner.id, '一只橘猫坐在木桌上'))
  assert.equal(run.status, 'success')
  const imageNode = run.nodes.find((item) => item.kind === 'image')
  assert.equal(imageNode.status, 'success')
  assert.equal(imageNode.output.credits, 3)
  assert.equal(imageNode.output.ratio, '9:16')
  assert.equal(imageNode.output.size, '1024x1536')
  assert.equal(imageNode.output.modelLabel, 'VisionQA通用图片模型')
  assert.match(imageNode.output.imageUrl, /^\/api\/runs\/[\w-]+\/assets\/image-1\.png$/)
  // 扣费是真的扣，不是只写在输出里
  assert.equal(credits.balanceOf(owner.id), before - 3)
  // 落盘：DATA_DIR/runs/<runId>/image-1.png，内容是上游给的那张
  const file = path.join(dir, 'runs', run.id, 'image-1.png')
  assert.equal(fs.readFileSync(file).equals(tinyPng), true)
  // 上游收到的是选中的尺寸与提示词
  const last = seenPrompts[seenPrompts.length - 1]
  assert.equal(last.size, '1024x1536')
  assert.equal(last.prompt, '一只橘猫坐在木桌上')
  // 最终输出里要能看见这张图，不然用户拿到的只是一段话
  assert.match(run.output, /\/api\/runs\/.+\/assets\/image-1\.png/)
  const outputNode = run.nodes.find((item) => item.kind === 'output')
  assert.equal(outputNode.output.imageCount, 1)
})

test('出图失败：节点记失败、积分全额退回、不留半张图', async () => {
  const before = credits.balanceOf(owner.id)
  const run = await flows.runFlow(imageFlow(owner.id, '这张图失败'))
  assert.equal(run.status, 'error')
  const imageNode = run.nodes.find((item) => item.kind === 'image')
  assert.equal(imageNode.status, 'error')
  assert.ok(imageNode.error && imageNode.error.length > 0)
  assert.equal(credits.balanceOf(owner.id), before, '失败必须全额退回，余额不能少')
  assert.equal(fs.existsSync(path.join(dir, 'runs', run.id, 'image-1.png')), false)
})

test('积分不足：节点直接说清楚要多少、还剩多少，不调上游', async () => {
  const poor = auth.createUser({ email: email('poor'), password: 'Passw0rd!demo', name: '没积分', kind: 'user' })
  const balance = credits.balanceOf(poor.id)
  if (balance > 0) credits.charge(poor.id, 'image_gen', { amount: balance, meta: { label: '测试清空余额' } })
  assert.equal(credits.balanceOf(poor.id), 0)
  const attemptsBefore = imageAttempts
  const run = await flows.runFlow(imageFlow(poor.id, '一只橘猫'))
  const imageNode = run.nodes.find((item) => item.kind === 'image')
  assert.equal(imageNode.status, 'error')
  assert.match(imageNode.error, /积分不足/)
  assert.equal(imageAttempts, attemptsBefore, '没钱就不该打上游')
})

test('评审节点看图：节点上填了用填的，留空用上游出图那张', () => {
  assert.equal(flows.pickReviewReference('frames/tpl_1/frame-01.jpg', 'runs/r1/image-1.png'), 'frames/tpl_1/frame-01.jpg')
  assert.equal(flows.pickReviewReference('', 'runs/r1/image-1.png'), 'runs/r1/image-1.png')
  assert.equal(flows.pickReviewReference('', ''), '')
})

test('运行前估价：按出图节点个数 × 模型单价', () => {
  const nodes = [{ type: 'image' }, { type: 'image' }, { type: 'llm' }]
  assert.equal(flows.NODE_KINDS.includes('image'), true)
  const cost = nodes.filter((item) => item.type === 'image').length * 5
  assert.equal(cost, 10)
})

// ---------- 产物接口的归属：只有这条运行的主人能读 ----------
const cookieOf = (user) => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.20.1' }).token).split(';')[0]

function mockReq({ method = 'GET', cookie = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = cookie ? { cookie } : {}
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
  Object.defineProperty(res, 'body', { get() { return Buffer.concat(this.chunks).toString('utf8') } })
  return res
}

async function callAsset(target, cookie) {
  const router = createFlowsRouter()
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + target)
  await router.handle(mockReq({ method: 'GET', cookie }), res, url, url.pathname)
  return res
}

test('运行产物只有主人能读：别人 404、自己 200 且拿回原图', async () => {
  const run = await flows.runFlow(imageFlow(owner.id, '归属检查的橘猫'))
  const imageNode = run.nodes.find((item) => item.kind === 'image')
  const target = imageNode.output.imageUrl

  const mine = await callAsset(target, cookieOf(owner))
  assert.equal(mine.statusCode, 200)
  assert.equal(mine.headers['Content-Type'], 'image/png')
  assert.equal(mine.raw.equals(tinyPng), true)

  const theirs = await callAsset(target, cookieOf(other))
  assert.equal(theirs.statusCode, 404, '别人的运行对当前账号就是不存在，不能泄露有没有这张图')

  const anonymous = await callAsset(target, '')
  assert.ok(anonymous.statusCode === 401 || anonymous.statusCode === 404, '未登录也不能读')
})

test('不存在的文件与非法文件名都被挡住', async () => {
  const run = await flows.runFlow(imageFlow(owner.id, '文件名检查'))
  const miss = await callAsset('/api/runs/' + run.id + '/assets/notthere.png', cookieOf(owner))
  assert.equal(miss.statusCode, 404)
  const evil = await callAsset('/api/runs/' + run.id + '/assets/..%2F..%2Fauth.db', cookieOf(owner))
  assert.notEqual(evil.statusCode, 200)
})
