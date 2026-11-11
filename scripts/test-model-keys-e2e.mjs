// 平台 Key 池端到端：真实 HTTP 调用走后台 Key、失败切换、冷却后换下一把。
// 用临时数据目录和本地 mock 上游，不碰线上 data/，不产生任何真实上游费用。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-keyvault-e2e-'))
process.env.DATA_DIR = temp
process.env.VQ_KEY_SECRET = 'e2e-secret'
process.env.VISION_API_KEY = ''

const hits = []
const mock = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-flash' }] }))
    return
  }
  if (req.url === '/v1/chat/completions') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      hits.push(JSON.parse(body || '{}').model)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok from mock' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } }))
    })
    return
  }
  res.writeHead(404)
  res.end('nope')
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const port = mock.address().port

const { createKey, testKey, deleteKey } = await import('../server/keyvault.mjs')
const { chatCompletion } = await import('../server/chatcall.mjs')

const bad = createKey({
  name: '坏 Key（优先级更高）',
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'sk-bad-bad-bad',
  models: ['mock-flash'],
  capabilities: ['text'],
  priority: 1,
})
const good = createKey({
  name: '好 Key',
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:' + port + '/v1',
  apiKey: 'sk-good-' + 'x'.repeat(12),
  models: ['mock-flash'],
  capabilities: ['text'],
  priority: 50,
})

// 文本能力：测试按钮必须打一次真实对话请求，而不是拿 /models 的 200 冒充可用
const tested = await testKey(good.id)
assert.equal(tested.ok, true, '文本 Key 的真实调用应通过')
assert.equal(tested.mode, 'real-call')
assert.equal(tested.model, 'mock-flash')
assert.ok(hits.includes('mock-flash'), '测试必须真的打到 /chat/completions')

// 坏 Key：真实调用失败要如实报错
const badTest = await testKey(bad.id)
assert.equal(badTest.ok, false, '连不上的 Key 不能报成功')
assert.equal(badTest.mode, 'real-call')
assert.ok(badTest.error.length > 0)

// 出图能力：不允许为了一个测试按钮真的生成图片，只探测凭证并写明 mode
const imageKey = createKey({
  name: '出图 Key',
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:' + port + '/v1',
  apiKey: 'sk-image-' + 'y'.repeat(12),
  models: ['mock-image'],
  capabilities: ['image'],
})
const probe = await testKey(imageKey.id)
assert.equal(probe.mode, 'credential-probe')
assert.equal(probe.ok, true)
assert.deepEqual(probe.models, ['mock-flash'])
assert.ok(probe.note && probe.note.includes('只验证凭证'))
deleteKey(imageKey.id)

// 前 3 次都先撞坏 Key（每次都会失败并记一次），坏 Key 冷却后第 4 次落到好 Key
let succeeded = 0
for (let attempt = 0; attempt < 4; attempt += 1) {
  try {
    const result = await chatCompletion({ model: 'mock-flash', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 3000 })
    assert.equal(result.message.content, 'ok from mock')
    succeeded += 1
  } catch {
    // 预期：坏 Key 连接失败
  }
}
assert.ok(succeeded >= 1, '冷却后必须能切到好 Key 并成功')
assert.ok(hits.every((model) => model === 'mock-flash'))

deleteKey(bad.id)
deleteKey(good.id)
mock.close()
fs.rmSync(temp, { recursive: true, force: true })
console.log('PASS model-keys e2e: 真实 HTTP 走 Key 池 / 失败切换 / 冷却')
