import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 计量接线测试：不用真上游，也不花一分钱，用一个本地假上游走完整条链路
// （Key 池 → chatcall / gateway → recordUsage → usage_events），
// 证明「模型调用记 token、出图记张数、出视频记秒数、失败记次数但不记成本」不是文档里的说法。
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-usage-wiring-'))
process.env.VQ_KEY_SECRET = 'test-secret-usage-wiring'
process.env.VISION_API_KEY = ''

let failImages = false
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.url.endsWith('/chat/completions')) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      return send(200, {
        model: body.model || 'deepseek-flash',
        choices: [{ message: { content: '收到' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801 },
      })
    }
    if (req.url.includes('/fail/')) {
      failImages = true
      return send(500, { error: { code: 'upstream_overloaded', message: 'boom' } })
    }
    if (req.url.endsWith('/images/generations')) return send(200, { data: [{ url: 'https://example.invalid/usage.png' }] })
    if (req.url.endsWith('/video/generations')) return send(200, { id: 'task_v_usage', status: 'queued' })
    send(404, { error: 'not found' })
  })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + upstream.address().port
test.after(() => new Promise((resolve) => upstream.close(resolve)))

const { createKey } = await import('../server/keyvault.mjs')
const { chatCompletion } = await import('../server/chatcall.mjs')
const { generateImage, createVideoTask } = await import('../server/gateway.mjs')
const usage = await import('../server/usage-meter.mjs')

usage.resetUsageMeter()

test('真实聊天调用落一条带 token 的事件，作品与单据都带上', async () => {
  createKey({
    name: 'DeepSeek 文本',
    provider: 'deepseek',
    baseUrl: base + '/llm',
    apiKey: 'sk-text-usage-1234567890',
    models: ['deepseek-flash'],
    capabilities: ['text'],
    priority: 10,
    weight: 100,
  })
  const result = await chatCompletion({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: '试一条' }],
    maxTokens: 64,
    meter: { projectId: 'prj_usage', ref: 'project:prj_usage' },
  })
  assert.equal(result.finishReason, 'stop')
  const event = usage.usageEvents({ limit: 5 })[0]
  assert.equal(event.kind, 'text')
  assert.equal(event.model, 'deepseek-flash')
  assert.equal(event.tokensIn, 1234, 'token 数只能来自上游 usage，不能自己估')
  assert.equal(event.tokensOut, 567)
  assert.equal(event.tokensKnown, true)
  assert.equal(event.projectId, 'prj_usage')
  assert.equal(event.ref, 'project:prj_usage')
})

test('出图按张数记账，单据号就是这次请求的幂等键', async () => {
  createKey({
    name: 'SeeAPI 出图',
    provider: 'cgcm',
    baseUrl: base + '/seeapi',
    apiKey: 'sk-cgcm-usage-1234567890',
    models: ['image-2-pro'],
    capabilities: ['image'],
    priority: 10,
    weight: 100,
  })
  const result = await generateImage({ model: 'image-2-pro', prompt: '两张图', n: 2, idempotency_key: 'bd-canvas-usage' })
  assert.deepEqual(result.urls, ['https://example.invalid/usage.png'])
  const event = usage.usageEvents({ limit: 5 })[0]
  assert.equal(event.kind, 'image')
  assert.equal(event.units, 2)
  assert.equal(event.unit, 'image')
  assert.equal(event.ref, 'bd-canvas-usage')
})

test('出视频按秒数记账：建任务成功就按请求时长记一条', async () => {
  createKey({
    name: 'SeeAPI 出视频',
    provider: 'cgcm',
    baseUrl: base + '/seeapi',
    apiKey: 'sk-cgcm-usage-video-123456',
    models: ['seedance-1.5-pro'],
    capabilities: ['video'],
    priority: 10,
    weight: 100,
  })
  const created = await createVideoTask({ model: 'seedance-1.5-pro', prompt: '海边日落', duration: 6 })
  assert.equal(created.id, 'task_v_usage')
  const event = usage.usageEvents({ limit: 5 })[0]
  assert.equal(event.kind, 'video')
  assert.equal(event.units, 6)
  assert.equal(event.unit, 'second')
  assert.equal(event.ref, 'task_v_usage')
})

test('失败也留痕：记一次失败、不记张数，汇总里也不算成本', async () => {
  createKey({
    name: '坏掉的出图 Key',
    provider: 'cgcm',
    baseUrl: base + '/fail',
    apiKey: 'sk-cgcm-usage-fail-123456',
    models: ['broken-image-x'],
    capabilities: ['image'],
    priority: 90,
    weight: 1,
  })
  await assert.rejects(() => generateImage({ model: 'broken-image-x', prompt: '会失败' }))
  assert.equal(failImages, true)
  const failed = usage.usageEvents({ limit: 5 })[0]
  assert.equal(failed.kind, 'image')
  assert.equal(failed.ok, false)
  assert.equal(failed.units, 0, '失败不记张数：上游计不计费没有依据')

  const summary = usage.usageSummary({ days: 7 })
  assert.equal(summary.totals.failedCalls, 1)
  assert.equal(summary.totals.images, 2, '只有成功的那 2 张算进张数')
  assert.equal(summary.totals.videoSeconds, 6)
  assert.equal(summary.totals.estCostMilli, 0, '没填单价就不折钱，失败更不折')
  assert.equal(summary.backfill.count, 0, '临时数据目录里没有积分流水，不产生回填')
})
