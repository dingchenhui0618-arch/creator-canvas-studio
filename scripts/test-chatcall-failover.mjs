// 平台 Key 故障回退单测：同一个模型下第一把 Key 挂了要自动换下一把，
// 而且后台「路由决策」要能证明「这次是第 2 把才成功」。
// 用两个假上游 + 临时数据目录，不碰线上 data/，也不花钱。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-failover-'))
process.env.DATA_DIR = temp
process.env.VQ_KEY_SECRET = 'test-secret-for-failover'
// 环境变量凭证也指到本地假上游：这一步只验「池里空时回落环境变量」，
// 不能把本机 OpenCodex 或线上 DeepSeek 的真凭证发出去（那样测试会真花钱）。
process.env.VISION_API_KEY = 'sk-env-fallback-999999'

function serve(handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ url: req.url, auth: req.headers.authorization, body })
      handler(res)
    })
  })
  return { server, seen }
}

const bad = serve((res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }))
})
const good = serve((res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} }))
})
const truncated = serve((res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"half":' }, finish_reason: 'length' }], usage: {} }))
})

for (const item of [bad, good, truncated]) {
  await new Promise((resolve) => item.server.listen(0, '127.0.0.1', resolve))
}
const urlOf = (item) => 'http://127.0.0.1:' + item.server.address().port + '/v1'
process.env.VISION_BASE_URL = urlOf(good)

const { createKey, deleteKey, listKeys, listRoutes } = await import('../server/keyvault.mjs')
const { chatCompletion } = await import('../server/chatcall.mjs')

const deadKey = createKey({
  name: '失效 Key',
  provider: 'custom',
  baseUrl: urlOf(bad),
  apiKey: 'sk-dead-failover-000001',
  models: ['fake-model'],
  capabilities: ['text'],
  priority: 5,
  weight: 100,
})
const liveKey = createKey({
  name: '备用 Key',
  provider: 'custom',
  baseUrl: urlOf(good),
  apiKey: 'sk-live-failover-000002',
  models: ['fake-model'],
  capabilities: ['text'],
  priority: 10,
  weight: 100,
})

// 1) 第一把（优先级 P5）失效 → 自动换到第二把（P10），调用方仍然拿到正常结果
const result = await chatCompletion({ model: 'fake-model', messages: [{ role: 'user', content: 'ping' }] })
assert.equal(result.message.content, 'ok', '故障回退后应拿到可用 Key 的结果')
assert.equal(bad.seen.length, 1, '先试优先级高的那一把')
assert.equal(bad.seen[0].auth, 'Bearer sk-dead-failover-000001')
assert.equal(good.seen.length, 1, '第一把失败后换第二把')
assert.equal(good.seen[0].auth, 'Bearer sk-live-failover-000002')

// 2) 后台要能证明「是第 2 把才成功」，而不是只看到一条成功记录
const afterFailover = listRoutes(10)
assert.equal(afterFailover.summary.total, 2, '两次真实请求各留一条记录')
assert.equal(afterFailover.summary.ok, 1)
assert.equal(afterFailover.summary.fail, 1)
assert.equal(afterFailover.summary.failover, 1, '「换把成功」计数应为 1')
const [newest, older] = afterFailover.items
assert.equal(newest.ok, true)
assert.equal(newest.keyId, liveKey.id)
assert.equal(newest.attempt, 2, '成功那条要写明是第 2 把')
assert.equal(older.ok, false)
assert.equal(older.keyId, deadKey.id, '失败那条要写明是哪把 Key')
assert.equal(older.attempt, 1)
assert.match(older.error, /凭证无效/, '失败原因要说人话')
assert.equal(JSON.stringify(afterFailover).includes('sk-dead-failover-000001'), false, '路由日志不能带 Key 明文')

// 3) 失效 Key 的失败次数要涨，连续三次后进冷却
assert.equal(listKeys().items.find((item) => item.id === deadKey.id).usage.fail, 1)
await chatCompletion({ model: 'fake-model', messages: [{ role: 'user', content: 'ping' }] })
await chatCompletion({ model: 'fake-model', messages: [{ role: 'user', content: 'ping' }] })
const cooled = listKeys().items.find((item) => item.id === deadKey.id)
assert.ok(cooled.usage.fail >= 3)
assert.equal(cooled.cooling, true, '连续失败 3 次的 Key 要进冷却')

// 4) 冷却中的 Key 不再被试，直接走可用那把（不该再多打一次失效上游）
const before = bad.seen.length
await chatCompletion({ model: 'fake-model', messages: [{ role: 'user', content: 'ping' }] })
assert.equal(bad.seen.length, before, '冷却中的 Key 不应再被打')
assert.equal(listRoutes(10).items[0].keyId, liveKey.id)
assert.equal(listRoutes(10).items[0].attempt, 1, '只剩一把可用时就是首选')

// 5) 输出被 max_tokens 截断不换把：换同模型另一把只会再截断一次，白花钱
deleteKey(liveKey.id)
const cut = createKey({
  name: '截断 Key',
  provider: 'custom',
  baseUrl: urlOf(truncated),
  apiKey: 'sk-trunc-failover-000003',
  models: ['fake-model'],
  capabilities: ['text'],
  priority: 5,
  weight: 100,
})
const goodAgain = createKey({
  name: '备用 Key 2',
  provider: 'custom',
  baseUrl: urlOf(good),
  apiKey: 'sk-live-failover-000004',
  models: ['fake-model'],
  capabilities: ['text'],
  priority: 10,
  weight: 100,
})
const goodBefore = good.seen.length
await assert.rejects(
  () => chatCompletion({ model: 'fake-model', messages: [{ role: 'user', content: 'ping' }] }),
  /截断/,
)
assert.equal(good.seen.length, goodBefore, '截断属于模型问题，不应再打下一把 Key')
assert.ok(cut.id && goodAgain.id)

// 6) 池里全停用 / 全删掉 → 按老规矩回落环境变量凭证，并且日志要标成 env 来源，
//    不能假装是池里某把 Key 干的（升级前的老部署就是靠这条回落的）
deleteKey(cut.id)
deleteKey(goodAgain.id)
const envSeenBefore = good.seen.length
const viaEnv = await chatCompletion({ model: 'fake-model', messages: [{ role: 'user', content: 'ping' }] })
assert.equal(viaEnv.message.content, 'ok')
assert.equal(good.seen.length, envSeenBefore + 1)
assert.equal(good.seen.at(-1).auth, 'Bearer sk-env-fallback-999999', '回落用的应该是环境变量凭证')
const envRoute = listRoutes(10).items[0]
assert.equal(envRoute.source, 'env')
assert.equal(envRoute.keyId, '')
assert.match(envRoute.reason, /环境变量/)

for (const item of [bad, good, truncated]) item.server.close()
fs.rmSync(temp, { recursive: true, force: true })
console.log('PASS chatcall-failover: 换把成功 / 留痕带序号 / 冷却跳过 / 截断不换把 / 池空回落环境变量')
