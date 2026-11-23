// 画布数据隔离（r296）：VisionQA 服务端调画布 API 要证明自己；往别人画布落笔记要按归属拦住。
// 画布那一侧的 owner 判断在 /opt/bdcanvas（另仓），这里钉住的是本仓的两处：
//   1) bdc.mjs 发出的 X-VQ-Canvas 签名（画布后端按同一把密钥验）
//   2) /api/bdc/canvases/note 在写之前先认归属
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-canvas-isolation-'))
process.env.DATA_DIR = dir
process.env.VQ_CANVAS_SHARED_SECRET = 'test-canvas-secret'

const { canvasServiceHeaders } = await import('../server/bdc.mjs')
const ROOT = path.resolve(import.meta.dirname, '..')

test('服务端调画布带签名头：画布后端用同一把密钥就能验出来', () => {
  const headers = canvasServiceHeaders()
  const token = headers['X-VQ-Canvas']
  assert.ok(token, '没有带 X-VQ-Canvas')
  const [body, mac] = token.split('.')
  assert.equal(token.split('.').length, 2)
  const expected = crypto.createHmac('sha256', 'test-canvas-secret').update(body).digest('base64url')
  assert.equal(mac, expected, '签名对不上')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  assert.equal(payload.aud, 'bd-canvas')
  assert.equal(payload.iss, 'visionqa')
  assert.equal(payload.sub, 'service:visionqa')
  // 60 秒就过期：它只证明「这一次请求来自 VisionQA 服务端」，不是长期凭据
  assert.ok(payload.exp * 1000 > Date.now())
  assert.ok(payload.exp * 1000 <= Date.now() + 120 * 1000)
})

test('没配共享密钥时不发头：画布那边按匿名处理，不会误开服务端身份', () => {
  assert.deepEqual(canvasServiceHeaders(''), {})
})

test('往画布落笔记之前先按归属拦：不是自己的一律 403', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server', 'index.mjs'), 'utf8')
  const block = /if \(pathname === '\/api\/bdc\/canvases\/note'[\s\S]{0,700}?appendCanvasNote/.exec(source)
  assert.ok(block, '找不到落笔记的路由')
  assert.match(block[0], /isCanvasAdmin\(user\)/, '没有管理员例外')
  assert.match(block[0], /canvasOwnerId\(noteCanvasId\)/, '没有按归属判断')
  assert.match(block[0], /CANVAS_FOREIGN/, '拒绝时没有给可识别的错误码')
})
