// GeteAPI 这类 OpenAI 兼容中转的出图通道（v0.9.165）：
// 路径是 /v1/images/generations，Bearer 鉴权，不需要 Idempotency-Key；
// 上游常常只回 data[0].b64_json，而且 b64 自带 data: 前缀 —— 平台不能把它拼成两份前缀，
// 否则无限画布按 data URL 解码会直接失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-gw-openai-'))
process.env.VQ_KEY_SECRET = 'test-secret-for-openai-image'
process.env.VISION_API_KEY = ''
process.env.VQ_GATEWAY_TOKEN = 'test-gateway-token'
process.env.VQ_GATEWAY_OPEN = '1'

const calls = []
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    calls.push({
      url: req.url,
      auth: String(req.headers.authorization || ''),
      idempotency: String(req.headers['idempotency-key'] || ''),
      body: Buffer.concat(chunks).toString('utf8'),
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // 照 GeteAPI 真实行为：只回 b64_json，且自带 data: 前缀
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: 'data:image/png;base64,AAAA' }] }))
  })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + upstream.address().port
test.after(() => new Promise((resolve) => upstream.close(resolve)))

const { createKey, deleteKey, listKeys } = await import('../server/keyvault.mjs')
const { generateImage, keyProtocol, upstreamUrl } = await import('../server/gateway.mjs')

function openaiKey(overrides = {}) {
  return createKey({
    name: 'GeteAPI 出图',
    provider: 'geteapi',
    baseUrl: base + '/v1',
    apiKey: 'sk-gete-openai-1234567890',
    models: ['gpt-image-2'],
    capabilities: ['image'],
    priority: 10,
    weight: 100,
    ...overrides,
  })
}

test('geteapi 的 Key 按 openai 协议走，路径是 /v1/images/generations', () => {
  assert.equal(keyProtocol({ baseUrl: 'https://www.geteapi.com/v1' }), 'openai')
  assert.equal(keyProtocol({ baseUrl: 'https://www.geteapi.com' }), 'openai')
  assert.equal(keyProtocol({ baseUrl: 'https://relay.example.com/v1', provider: 'geteapi' }), 'openai')
  assert.equal(keyProtocol({ baseUrl: 'https://api.cgcm-api.com' }), 'cgcm')
  assert.equal(keyProtocol({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }), 'ark')
  // 只填域名时补 /v1；填了 /v1 不重复
  assert.equal(upstreamUrl({ baseUrl: 'https://www.geteapi.com' }, 'image'), 'https://www.geteapi.com/v1/images/generations')
  assert.equal(upstreamUrl({ baseUrl: 'https://www.geteapi.com/v1' }, 'image'), 'https://www.geteapi.com/v1/images/generations')
})

test('OpenAI 兼容中转不带幂等键，业务参数原样转发', async () => {
  const key = openaiKey()
  calls.length = 0
  const result = await generateImage({ model: 'gpt-image-2', prompt: '一只橘猫', size: '1024x1024', n: 1, response_format: 'url' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/v1/images/generations')
  assert.equal(calls[0].idempotency, '', '这条协议不要求幂等键，别乱发')
  assert.match(calls[0].auth, /^Bearer sk-gete/)
  const sent = JSON.parse(calls[0].body)
  assert.equal(sent.model, 'gpt-image-2')
  assert.equal(sent.size, '1024x1024')
  assert.equal(sent.prompt, '一只橘猫')
  assert.equal(result.urls.length, 1)
  assert.ok(result.urls[0].startsWith('data:image/png;base64,'), '原样交回 data URL')
  assert.ok(!result.urls[0].startsWith('data:image/png;base64,data:'), '不能拼成两份前缀')
  deleteKey(key.id)
})

test('同一模型多平台：池里同时有 SeeAPI 与 GeteAPI 时按模型各走各的 Key', async () => {
  const gete = openaiKey({ models: ['gpt-image-2'], name: 'GeteAPI' })
  const seeapi = createKey({
    name: 'SeeAPI 出图',
    provider: 'cgcm',
    baseUrl: base + '/seeapi',
    apiKey: 'sk-cgcm-openai-1234567890',
    models: ['image-2-pro'],
    capabilities: ['image'],
    priority: 10,
    weight: 100,
  })
  calls.length = 0
  await generateImage({ model: 'image-2-pro', prompt: '白底主图' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/seeapi/v1/images/generations')
  assert.match(calls[0].idempotency, /^vq-/, 'SeeAPI 那条仍然要带幂等键')
  deleteKey(gete.id)
  deleteKey(seeapi.id)
})

test('Key 列表里能看出这条通道是 geteapi，后台不用猜', () => {
  const key = openaiKey({ name: 'GeteAPI 验收' })
  const item = listKeys().items.find((row) => row.id === key.id)
  assert.equal(item.provider, 'geteapi')
  assert.equal(item.baseUrl, base + '/v1')
  deleteKey(key.id)
})
