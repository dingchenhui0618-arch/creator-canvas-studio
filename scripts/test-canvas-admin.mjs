// 画布身份（跨系统）单元测试：不连真画布，起一个假画布企业服务验证协议。
import http from 'node:http'
import assert from 'node:assert/strict'

const SECRET = 'test-secret-' + Math.random().toString(16).slice(2)
let lastRequest = null
let mode = 'ok'

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    lastRequest = { method: req.method, url: req.url, secret: req.headers['x-visionqa-secret'], body }
    if (req.headers['x-visionqa-secret'] !== SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '无权访问', code: 'TRUST_UNAUTHORIZED' }))
      return
    }
    if (mode === 'reject') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '内部错误', code: 'BOOM' }))
      return
    }
    if (req.method === 'GET' && req.url === '/enterprise/api/visionqa/users') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ items: [{ id: 3, externalId: 'vq:vqusr_DEMO', visionqaUserId: 'vqusr_DEMO', displayName: 'VisionQA 管理员', active: true, lastLoginAt: '2026-11-11 13:01:00' }], total: 1 }))
      return
    }
    if (req.method === 'POST' && req.url === '/enterprise/api/visionqa/users/3/access') {
      const parsed = JSON.parse(body || '{}')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ item: { id: 3, externalId: 'vq:vqusr_DEMO', visionqaUserId: 'vqusr_DEMO', displayName: 'VisionQA 管理员', active: Boolean(parsed.enabled) } }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// 1) 没配置：明确报「未配置」，不假装成功
process.env.VQ_CANVAS_SHARED_SECRET = ''
process.env.VQ_CANVAS_ADMIN_URL = ''
const off = await import('../server/canvas-admin.mjs?case=off')
assert.equal(off.canvasAdminConfigured(), false)
await assert.rejects(() => off.listCanvasUsers(), (error) => error.code === 'CANVAS_NOT_CONFIGURED')
console.log('ok 1/5 未配置 → CANVAS_NOT_CONFIGURED')

process.env.VQ_CANVAS_SHARED_SECRET = SECRET
process.env.VQ_CANVAS_ADMIN_URL = `http://127.0.0.1:${port}`
const client = await import('../server/canvas-admin.mjs?case=on')
assert.equal(client.canvasAdminConfigured(), true)

// 2) 密钥必须放在请求头里
const items = await client.listCanvasUsers()
assert.equal(items.length, 1)
assert.equal(items[0].visionqaUserId, 'vqusr_DEMO')
assert.equal(lastRequest.secret, SECRET)
assert.equal(lastRequest.method, 'GET')
console.log('ok 2/5 列表：带密钥请求头、返回真实字段')

// 3) 停用/恢复：布尔值原样传给画布
const suspended = await client.setCanvasUserAccess(3, false)
assert.equal(suspended.active, false)
assert.equal(JSON.parse(lastRequest.body).enabled, false)
const restored = await client.setCanvasUserAccess(3, true)
assert.equal(restored.active, true)
assert.equal(JSON.parse(lastRequest.body).enabled, true)
console.log('ok 3/5 停用 / 恢复：POST 布尔值，返回最新状态')

// 4) 画布拒绝：把上游错误码带出来，不吞掉
mode = 'reject'
await assert.rejects(() => client.listCanvasUsers(), (error) => error.code === 'CANVAS_REJECTED')
mode = 'ok'
console.log('ok 4/5 画布拒绝 → CANVAS_REJECTED')

// 5) 画布连不上：超时/拒绝都归成 CANVAS_UNREACHABLE
await new Promise((resolve) => server.close(resolve))
const dead = await import('../server/canvas-admin.mjs?case=dead')
await assert.rejects(() => dead.listCanvasUsers(), (error) => error.code === 'CANVAS_UNREACHABLE')
console.log('ok 5/5 画布连不上 → CANVAS_UNREACHABLE')

console.log('画布身份（跨系统）单元测试：5/5 通过')
