// 评审的归属要跟着响应一起回去（r251）。
// 以前 POST /api/review 只回结论，项目/版次只有 GET /api/review/:id 现算——
// 结果是刚评完那一眼，页面根本不知道这条结论记在哪一版，只能自己猜。
// 这里用一个本地假上游顶替模型：它只回答固定 JSON，不花钱、不出网。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: 'pass',
            summary: '固定结论：归属验收',
            observations: [],
            fixes: [],
            notAssessable: [],
          }),
        },
      }],
    }))
  })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const port = upstream.address().port
test.after(() => upstream.close())

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-scope-'))
process.env.VQ_KEY_SECRET = 'test-secret-review-scope'
// 同进程跑评审：不额外起 worker，假上游在同一个进程里排队更快
process.env.VQ_REVIEW_ISOLATE = '0'
isolateLeaseDir('vq-lease-review-scope-')
process.env.VISION_BASE_URL = 'http://127.0.0.1:' + port + '/v1'
process.env.VISION_API_KEY = 'test-key-not-real'
process.env.VISION_MODEL = 'fake-vision'

const auth = await import('../server/auth.mjs')
const { createProject } = await import('../server/projects.mjs')
const { config } = await import('../server/config.mjs')
const { createReviewRouter } = await import('../server/routes/review.mjs')

// 一张本地小图：评审只按扩展名与大小验素材，小到不进缩图流程，不会碰 ffmpeg
const mediaDir = path.join(config.dataDir, 'media')
fs.mkdirSync(mediaDir, { recursive: true })
fs.writeFileSync(path.join(mediaDir, 'shot.jpg'), Buffer.from('not-a-real-jpeg-but-small-enough'))

// 一条有脚本、有分镜的模板：从它起的作品才做得出「存成模板」这件事（r252）
fs.writeFileSync(path.join(config.dataDir, 'templates.json'), JSON.stringify([{
  id: 'tpl_scope',
  ownerId: '',
  kind: 'replica',
  origin: 'ai',
  title: '能沉淀的模板',
  contentType: '口播',
  tags: [],
  platform: 'douyin',
  platformLabel: '抖音',
  structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '第一句', onScreen: '三分钟' }],
  storyboard: [{ shotNo: 1, startSec: 0, endSec: 3, visual: '杯子放下', camera: '近景', caption: '', audio: '', purpose: '', frameUrl: '' }],
  video: { width: 1080, height: 1920, fps: 30, duration: 3 },
  reuseCount: 0,
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
}], null, 2), 'utf8')

const me = auth.createUser({ email: '[EMAIL:RS1]', password: 'Passw0rd!demo', name: '归属用例' })
const cookie = auth.sessionCookie(auth.createSession(me, { userAgent: 'test', ip: '10.0.7.1' }).token).split(';')[0]

function mockReq(body) {
  const req = new Readable({ read() {} })
  req.method = 'POST'
  req.headers = { cookie }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.push(JSON.stringify(body))
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
    setHeader(name, value) { this.headers[name] = value },
    write(chunk) { this.body += String(chunk); return true },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true },
  }
}

async function postReview(body) {
  const router = createReviewRouter()
  const res = mockRes()
  const target = '/api/review'
  await router.handle(mockReq(body), res, new URL('http://127.0.0.1' + target), target)
  let payload = null
  try { payload = JSON.parse(res.body) } catch { payload = null }
  return { status: res.statusCode, payload }
}

test('挂在作品上的评审：POST 响应带回作品、版次与那条工作流', async () => {
  const project = await createProject({ title: '毛衣折叠收纳法', flowId: 'flow_scope_1' }, me)
  assert.equal(project.version, 1, '接了工作流的作品从第 1 版开始')
  const result = await postReview({ media: 'media/shot.jpg', intent: '归属验收', projectId: project.id })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.deepEqual(result.payload.project, {
    id: project.id,
    title: '毛衣折叠收纳法',
    version: 1,
    flowId: 'flow_scope_1',
  })
  assert.equal(result.payload.version, 1)
  // 记录 id 也在：页面据此能直接打开这条评审
  assert.equal(typeof result.payload.reviewId, 'string')
  assert.ok(result.payload.reviewId.length > 0)
})

// 沉淀模板（r252）：结果页要不要给「存成模板」，由服务端按「有脚本、有分镜」现算。
// 前端不自己猜——判错的代价是一个点了就报错的按钮。
test('从有脚本有分镜的模板起的作品：结论里带 templatable，结果页才给「存成模板」', async () => {
  const project = await createProject({ title: '能沉淀的那条', templateId: 'tpl_scope' }, me)
  const result = await postReview({ media: 'media/shot.jpg', intent: '沉淀验收', projectId: project.id })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.equal(result.payload.templatable, true)
  assert.equal(result.payload.project.id, project.id)
})

test('没有分镜的那条（只从工作流起）：templatable 为 false，不给那个按钮', async () => {
  const project = await createProject({ title: '只从工作流起的', flowId: 'flow_bare_1' }, me)
  const result = await postReview({ media: 'media/shot.jpg', intent: '沉淀验收', projectId: project.id })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.equal(result.payload.templatable, false)
})

test('单独评一张画面：project 明确为 null，不靠「字段不在」让人猜', async () => {
  const result = await postReview({ media: 'media/shot.jpg', intent: '单独评一张' })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.equal(Object.hasOwn(result.payload, 'project'), true)
  assert.equal(result.payload.project, null)
  assert.equal(result.payload.version, 0)
  // 没挂作品就没有「这一版」，也就没有沉淀模板这回事
  assert.equal(result.payload.templatable, false)
})
