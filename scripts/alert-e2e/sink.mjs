// 本地假告警接收端：够验证 VisionQA 的外推通道（POST + x-vq-signature）
// 顺便扮两家机器人：路径像飞书（/open-apis/bot/...）就按飞书的规矩回业务码，
// 这样「200 + code 19024 也必须算失败」这条能在整条链路上被验到，而不只是单测。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.env.SINK_OUT || '/tmp/vq-alert-e2e/inbox'
const PORT = Number(process.env.SINK_PORT || 2526)
const STATUS = Number(process.env.SINK_STATUS || 200)
fs.mkdirSync(OUT, { recursive: true })
let seq = 0

// /open-apis/bot/v2/hook/reject... → 飞书「关键词不匹配」的真实回法（HTTP 200）
function replyFor(url) {
  if (url.startsWith('/open-apis/bot/v2/hook/reject')) return { code: 19024, msg: 'Key Words Not Found' }
  if (url.startsWith('/open-apis/bot/')) return { code: 0, msg: 'success' }
  if (url.startsWith('/robot/send')) return { errcode: 0, errmsg: 'ok' }
  return null
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const name = 'req-' + String(++seq).padStart(2, '0') + '.json'
    fs.writeFileSync(path.join(OUT, name), JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }, null, 2))
    const shaped = replyFor(String(req.url || ''))
    res.statusCode = shaped ? 200 : STATUS
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(shaped || { ok: STATUS < 400 }))
  })
  req.on('error', () => {})
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('alert sink on 127.0.0.1:' + PORT + ' -> ' + OUT + ' reply=' + STATUS)
})
