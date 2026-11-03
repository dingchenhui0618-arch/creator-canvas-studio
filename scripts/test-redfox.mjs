#!/usr/bin/env node
// 用假红狐服务验证客户端行为：限流不超速、并发有上限、频繁错误会重试、禁用/积分错误不重试、缓存命中。
import http from 'node:http'

const MOCK_PORT = 8899
const calls = []
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const keyword = String(body.keyword || '')
  calls.push({ at: Date.now(), keyword })
  const reply = (code, data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code, data, msg: data?.msg || '' }))
  }
  if (keyword === 'disabled') return reply(3105, { msg: 'API Key已禁用' })
  if (keyword === 'nopoints') return reply(3210, { msg: '积分不足，请完成支付后重试', amount: 100 })
  if (keyword === 'flaky' && calls.filter((call) => call.keyword === 'flaky').length === 1) {
    return reply(0, { msg: '接口调用过于频繁，当前限制为10次/秒' })
  }
  return reply(2000, { list: [{ content: 'ok ' + keyword, likeCount: 1 }], total: 1 })
})
await new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', resolve))

process.env.REDFOX_BASE_URL = 'http://127.0.0.1:' + MOCK_PORT
process.env.REDFOX_API_KEY = 'test-key'
process.env.REDFOX_CACHE_TTL_MS = '0'
const { postJson } = await import('../server/redfox.mjs')

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

// 1) 20 个不同关键词并发：1000ms 内调用数不应超过 4（抖音桶）
calls.length = 0
const started = Date.now()
const tasks = Array.from({ length: 20 }, (_, index) => postJson('/x', { keyword: 'k' + index }, {}, { platform: 'douyin' }).catch((error) => error))
await Promise.all(tasks)
const firstSecond = calls.filter((call) => call.at - started < 1000).length
check('限流：首秒调用数 <= 4', firstSecond <= 4, '首秒 ' + firstSecond + ' 次')
check('20 个并发全部成功', tasks.every((value) => !(value instanceof Error)), tasks.filter((value) => value instanceof Error).length + ' 个失败')

// 2) 缓存：同参数重复调用只打一次上游
calls.length = 0
process.env.REDFOX_CACHE_TTL_MS = '60000'
const mod = await import('../server/redfox.mjs?cache=1')
await mod.postJson('/y', { keyword: 'same' }, {}, { platform: 'xiaohongshu' })
await mod.postJson('/y', { keyword: 'same' }, {}, { platform: 'xiaohongshu' })
check('缓存：相同参数只上游一次', calls.length === 1, calls.length + ' 次')

// 3) 频繁错误会重试成功
calls.length = 0
const flaky = await postJson('/z', { keyword: 'flaky' }, {}, { platform: 'xiaohongshu' }).then(() => 'ok').catch((error) => String(error?.message || error))
check('限流错误自动重试成功', flaky === 'ok', flaky)

// 4) 禁用 Key 不重试、且短路后续调用
calls.length = 0
const disabled1 = await postJson('/w', { keyword: 'disabled' }, {}, { platform: 'douyin' }).catch((error) => error.code)
await postJson('/w2', { keyword: 'disabled2' }, {}, { platform: 'douyin' }).catch(() => null)
check('禁用 Key 返回 REDFOX_DISABLED', disabled1 === 'REDFOX_DISABLED', String(disabled1))
check('禁用后短路后续调用（只打 1 次上游）', calls.length === 1, calls.length + ' 次')

// 5) 积分不足返回 REDFOX_QUOTA
const quota = await postJson('/q', { keyword: 'nopoints' }, {}, { platform: 'xiaohongshu' }).catch((error) => error.code)
check('积分不足返回 REDFOX_QUOTA', quota === 'REDFOX_QUOTA', String(quota))

server.close()
const failed = results.filter((item) => !item.pass)
console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, results }, null, 2))
process.exit(failed.length ? 1 : 0)
