import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 2026-11-13 生产：画布点出图，VisionQA 回 502，报「出图失败：上游凭证无效（HTTP 400）」。
// 真因是 SeeAPI 的同步出图属于计费请求，必须带 Idempotency-Key；画布把它放在正文里发过来了，
// 平台转发时却没提到请求头上，于是上游直接 400 invalid_idempotency_key。
// 这组测试盯两件事：幂等键要透传（正文里不重复），以及再遇到这种拒绝时别再误报成凭证问题。
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-gw-idem-'))
process.env.VQ_KEY_SECRET = 'test-secret-for-idempotency'
process.env.VISION_API_KEY = ''
process.env.VQ_GATEWAY_TOKEN = 'test-gateway-token'
process.env.VQ_GATEWAY_OPEN = '1'

const calls = []
let mode = 'ok'
let unknownCalls = 0

const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    calls.push({ url: req.url, header: req.headers['idempotency-key'] || '', body })
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.url.startsWith('/seeapi-unknown-forever/')) {
      return send(503, { error: { code: 'provider_submit_outcome_unknown', message: 'provider submit outcome unknown' } })
    }
    if (req.url.startsWith('/seeapi-unknown/')) {
      unknownCalls += 1
      if (unknownCalls === 1) {
        return send(502, { error: { code: 'provider_submit_outcome_unknown', message: 'provider submit outcome unknown' } })
      }
      return send(200, { data: [{ url: 'https://example.invalid/seeapi.png' }] })
    }
    if (req.url.startsWith('/seeapi-reject/')) {
      return send(400, {
        error: {
          code: 'invalid_idempotency_key',
          message: 'Idempotency-Key is required for synchronous billable requests.',
          type: 'invalid_request_error',
          request_id: 'req_test_idem',
        },
      })
    }
    if (req.url.startsWith('/seeapi-bad/')) return send(500, { error: { code: 'upstream_overloaded', message: 'boom' } })
    if (mode === 'reject') {
      return send(400, { error: { code: 'invalid_idempotency_key', message: 'Idempotency-Key is required.' } })
    }
    if (req.url.endsWith('/images/generations/async')) {
      return send(202, { id: 'img-job-idem', object: 'task', status: 'queued' })
    }
    // 照真 SeeAPI 的行为：同步出图没有幂等键就 400
    if (req.url.startsWith('/seeapi/') && !req.headers['idempotency-key']) {
      return send(400, { error: { code: 'invalid_idempotency_key', message: 'Idempotency-Key is required for synchronous billable requests.' } })
    }
    send(200, { data: [{ url: 'https://example.invalid/' + (req.url.includes('ark') ? 'ark' : 'seeapi') + '.png' }] })
  })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + upstream.address().port

// 假上游会一直占着事件循环，测试跑完必须关掉，否则 node --test 不退出
test.after(() => new Promise((resolve) => upstream.close(resolve)))

const { createKey, deleteKey, listRoutes } = await import('../server/keyvault.mjs')
const { generateImage, createImageTask } = await import('../server/gateway.mjs')

function cgcmKey(overrides = {}) {
  return createKey({
    name: 'SeeAPI 出图',
    provider: 'cgcm',
    baseUrl: base + '/seeapi',
    apiKey: 'sk-cgcm-idem-1234567890',
    models: ['image-2-pro'],
    capabilities: ['image'],
    priority: 10,
    weight: 100,
    ...overrides,
  })
}

test('画布的幂等键要提到请求头上，正文里不再重复转发', async () => {
  const key = cgcmKey()
  calls.length = 0
  mode = 'ok'
  const result = await generateImage({ model: 'image-2-pro', prompt: '生成一只橘猫', idempotency_key: 'bd-canvas-abc' })
  assert.deepEqual(result.urls, ['https://example.invalid/seeapi.png'])
  assert.equal(calls[0].header, 'bd-canvas-abc')
  const sent = JSON.parse(calls[0].body)
  assert.equal(sent.idempotency_key, undefined)
  assert.equal(sent.prompt, '生成一只橘猫', '业务参数原样保留')
  deleteKey(key.id)
})

test('调用方没给幂等键：平台补一个，别让画布收到 400', async () => {
  const key = cgcmKey()
  calls.length = 0
  const result = await generateImage({ model: 'image-2-pro', prompt: '白底主图' })
  assert.deepEqual(result.urls, ['https://example.invalid/seeapi.png'])
  assert.match(calls[0].header, /^vq-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  deleteKey(key.id)
})

test('上游要幂等键时，错误要说幂等键，不能报成凭证无效', async () => {
  const key = cgcmKey({ baseUrl: base + '/seeapi-reject', models: ['image-2.5'] })
  await assert.rejects(
    () => generateImage({ model: 'image-2.5', prompt: '生成一只橘猫', idempotency_key: 'bd-canvas-zzz' }),
    (error) => {
      assert.equal(error.status, 502, '网关对外仍然是「这次生成失败」')
      assert.equal(error.upstreamStatus, 400)
      assert.equal(error.upstreamCode, 'invalid_idempotency_key', '上游 code 要带出来，后台照它排查')
      assert.match(error.message, /幂等键/)
      assert.doesNotMatch(error.message, /凭证无效/, '这正是 2026-11-13 那次误报')
      assert.match(String(error.detail), /invalid_idempotency_key/)
      return true
    },
  )
  assert.equal(listRoutes(1).items[0].ok, false)
  assert.match(String(listRoutes(1).items[0].error), /idempotency/i, '路由日志也得留下上游原话')
  deleteKey(key.id)
})

test('方舟 Key 不发幂等键头：这条要求只属于 SeeAPI', async () => {
  const key = createKey({
    name: '方舟出图',
    provider: 'volcengine',
    baseUrl: base + '/ark',
    apiKey: 'sk-ark-idem-1234567890',
    models: ['doubao-seedream-4-5-251128'],
    capabilities: ['image'],
    priority: 10,
    weight: 100,
  })
  calls.length = 0
  const result = await generateImage({ model: 'doubao-seedream-4-5-251128', prompt: '白底主图' })
  assert.deepEqual(result.urls, ['https://example.invalid/ark.png'])
  assert.equal(calls[0].header, '')
  deleteKey(key.id)
})

test('换下一把重试时沿用同一个幂等键，同一次生成不会被扣两次', async () => {
  const bad = cgcmKey({ name: 'SeeAPI 坏的那把', baseUrl: base + '/seeapi-bad', apiKey: 'sk-cgcm-bad-1234567890', models: ['nano-banana-flash'], priority: 1 })
  const good = cgcmKey({ name: 'SeeAPI 好的那把', apiKey: 'sk-cgcm-good-1234567890', models: ['nano-banana-flash'], priority: 2 })
  calls.length = 0
  const result = await generateImage({ model: 'nano-banana-flash', prompt: '生成一只橘猫', idempotency_key: 'bd-canvas-retry' })
  assert.deepEqual(result.urls, ['https://example.invalid/seeapi.png'])
  assert.equal(calls.length, 2, '第一把失败后要换第二把')
  assert.deepEqual(calls.map((call) => call.header), ['bd-canvas-retry', 'bd-canvas-retry'])
  assert.equal(result.attempt, 2)
  deleteKey(bad.id)
  deleteKey(good.id)
})

test('上游说结果不明：拿同一个幂等键重放一次，不换 Key 也不让用户重付', async () => {
  const key = cgcmKey({ baseUrl: base + '/seeapi-unknown', models: ['nano-banana-pro'] })
  calls.length = 0
  unknownCalls = 0
  const result = await generateImage({ model: 'nano-banana-pro', prompt: '生成一只橘猫', idempotency_key: 'bd-canvas-unknown' })
  assert.deepEqual(result.urls, ['https://example.invalid/seeapi.png'])
  assert.equal(calls.length, 2, '第一次结果不明，第二次重放')
  assert.deepEqual(calls.map((call) => call.header), ['bd-canvas-unknown', 'bd-canvas-unknown'])
  assert.equal(calls[0].body, calls[1].body, '重放必须原样同 body，上游才认得出是同一次提交')
  deleteKey(key.id)
})

test('重放还是不知道结果：明确报「结果不明」，绝不换另一把 Key 再提交一次', async () => {
  const stuck = cgcmKey({ name: '结果不明的那把', baseUrl: base + '/seeapi-unknown-forever', models: ['image-2.5'], priority: 1 })
  const backup = cgcmKey({ name: '备用那把', baseUrl: base + '/seeapi', models: ['image-2.5'], priority: 2 })
  calls.length = 0
  await assert.rejects(
    () => generateImage({ model: 'image-2.5', prompt: '生成一只橘猫', idempotency_key: 'bd-canvas-stuck' }),
    (error) => {
      assert.equal(error.code, 'UPSTREAM_OUTCOME_UNKNOWN')
      assert.match(error.message, /没确认结果/)
      assert.equal(error.upstreamCode, 'provider_submit_outcome_unknown')
      return true
    },
  )
  assert.equal(calls.length, 2, '只对同一把 Key 重放一次，不换 Key')
  assert.ok(calls.every((call) => call.url.startsWith('/seeapi-unknown-forever/')), '备用 Key 一次都不能碰：那是新的一次提交')
  deleteKey(stuck.id)
  deleteKey(backup.id)
})

test('路由层：画布带的 Idempotency-Key 请求头要原样传给上游（它真就是这么发的）', async () => {
  const key = cgcmKey({ models: ['image-2-pro'] })
  calls.length = 0
  const { createGatewayRouter } = await import('../server/routes/gateway.mjs')
  const { Readable } = await import('node:stream')
  const router = createGatewayRouter()
  const pathname = '/api/gateway/v1/images/generations'
  const req = Readable.from([Buffer.from(JSON.stringify({ model: 'image-2-pro', prompt: '路由这一层' }))])
  Object.assign(req, {
    method: 'POST',
    url: pathname,
    headers: { authorization: 'Bearer test-gateway-token', 'idempotency-key': 'bd-canvas-from-header' },
  })
  const res = {
    status: 0,
    payload: '',
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.payload = String(chunk)
    },
  }
  await router.handle(req, res, new URL('http://local' + pathname), pathname)
  assert.equal(res.status, 200)
  assert.equal(calls[0].header, 'bd-canvas-from-header', '画布直连 SeeAPI 时用请求头，平台不能把它吞掉')
  assert.equal(JSON.parse(calls[0].body).idempotency_key, undefined)
  assert.deepEqual(JSON.parse(res.payload).urls, ['https://example.invalid/seeapi.png'])
  deleteKey(key.id)
})

test('异步出图同样用正文里的幂等键，正文里不再重复转发', async () => {
  const key = cgcmKey({ models: ['image-2-pro'] })
  calls.length = 0
  // 假上游对 /async 也回 200，这里只关心请求头
  await createImageTask({ model: 'image-2-pro', prompt: '异步出图', idempotency_key: 'bd-canvas-async' })
  const call = calls.find((item) => item.url.endsWith('/v1/images/generations/async'))
  assert.equal(call.header, 'bd-canvas-async')
  assert.equal(JSON.parse(call.body).idempotency_key, undefined)
  deleteKey(key.id)
})
