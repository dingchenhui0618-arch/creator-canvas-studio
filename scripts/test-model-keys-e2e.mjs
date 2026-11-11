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

const tested = await testKey(good.id)
assert.equal(tested.ok, true, '测试接口应能连上 mock /models')
assert.deepEqual(tested.models, ['mock-flash'])

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
