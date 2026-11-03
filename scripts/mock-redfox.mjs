#!/usr/bin/env node
// 本地假红狐服务：用来验证限流 / 重试 / 禁用短路，不需要真实 Key、不消耗积分。
// 用法：node scripts/mock-redfox.mjs [port]   然后 REDFOX_BASE_URL=http://127.0.0.1:<port>
import http from 'node:http'

const port = Number(process.argv[2] || 8899)
const state = { calls: 0, times: [], byPath: {} }

http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const keyword = String(body.keyword || '')
  state.calls += 1
  state.times.push(Date.now())
  state.byPath[req.url] = (state.byPath[req.url] || 0) + 1

  const send = (code, payload) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code, data: payload, msg: payload?.msg || '' }))
  }

  if (keyword === 'disabled') return send(3105, { msg: 'API Key已禁用' })
  if (keyword === 'nopoints') return send(3210, { msg: '积分不足，请完成支付后重试', amount: 100, goodsName: 'RedFox API积分充值（100元=1000积分）' })
  if (keyword === 'flaky' && Math.random() < 0.6) return send(0, { msg: '接口调用过于频繁，当前限制为10次/秒，请稍后再试' })

  const list = Array.from({ length: Number(body.pageSize || 3) }, (_, index) => ({
    content: '假数据 ' + (index + 1) + ' · ' + keyword,
    authorName: 'mock-author',
    likeCount: 1000 + index,
    commentCount: 10 + index,
    shareCount: 5 + index,
    collectCount: 20 + index,
    opusUrl: 'https://example.com/video/' + (index + 1),
    publishTime: '2026-11-01 10:00',
  }))
  return send(2000, { list, total: list.length })
}).listen(port, '127.0.0.1', () => console.log('[mock-redfox] http://127.0.0.1:' + port))
