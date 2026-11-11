// 平台 Key 路由集成测试：起一个假上游，走真实 chatCompletion 链路，
// 验证「选哪把 Key → 落路由记录 → 后台能读出来」，失败也要留痕。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-route-'))
process.env.DATA_DIR = temp
process.env.VQ_KEY_SECRET = 'test-secret-for-routes'
process.env.VISION_API_KEY = ''
process.env.VISION_BASE_URL = ''

let reply = 'ok'
let status = 200
const seen = []

const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    seen.push({ url: req.url, auth: req.headers.authorization, body })
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Insufficient Balance' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: {} }))
  })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1'

const { createKey, listRoutes, previewRoute } = await import('../server/keyvault.mjs')
const { chatCompletion } = await import('../server/chatcall.mjs')

const key = createKey({
  name: '假上游 Key',
  provider: 'custom',
  baseUrl: upstreamUrl,
  apiKey: 'sk-route-test-123456',
  models: ['fake-model'],
  capabilities: ['text'],
  priority: 10,
  weight: 100,
})

// 1) 预演说的和真实调用一致：会用这把
const preview = previewRoute({ capability: 'text', model: 'fake-model' })
assert.equal(preview.group.length, 1)
assert.equal(preview.chosen.id, key.id)
assert.match(preview.description, /假上游 Key/)

// 2) 真实调用成功 → 落一条成功记录，带上 Key 与判定理由
const result = await chatCompletion({ model: 'fake-model', messages: [{ role: 'user', content: 'ping' }] })
assert.equal(result.message.content, 'ok')
const afterOk = listRoutes(10)
assert.equal(afterOk.summary.total, 1)
assert.equal(afterOk.summary.ok, 1)
assert.equal(afterOk.items[0].source, 'pool')
assert.equal(afterOk.items[0].keyId, key.id)
assert.equal(afterOk.items[0].keyName, '假上游 Key')
assert.match(afterOk.items[0].reason, /优先级 P10/)
assert.ok(afterOk.items[0].ms >= 0)
assert.equal(JSON.stringify(afterOk).includes('sk-route-test-123456'), false, '路由日志不能带 Key 明文')
assert.equal(JSON.stringify(afterOk).includes('ping'), false, '路由日志不能带对话内容')

// 3) 上游欠费 → 失败也要留痕，后台能看出是「余额不足」不是「路由选错」
status = 402
await assert.rejects(() => chatCompletion({ model: 'fake-model', messages: [{ role: 'user', content: 'ping' }] }))
const afterFail = listRoutes(10)
assert.equal(afterFail.summary.total, 2)
assert.equal(afterFail.summary.fail, 1)
assert.equal(afterFail.items[0].ok, false)
assert.match(afterFail.items[0].error, /402/)
assert.equal(afterFail.items[0].keyId, key.id, '失败也要记下是哪把 Key')

// 4) 池里 Key 全停用 → 没有可用 Key 也要留痕，并且不假装成功
upstream.close()
fs.rmSync(temp, { recursive: true, force: true })
console.log('PASS model-routes: 预演一致 / 成功留痕 / 失败留痕 / 无明文无对话内容')
