// 本地假告警接收端：只够验证 VisionQA 的外推通道（POST + x-vq-signature）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.env.SINK_OUT || '/tmp/vq-alert-e2e/inbox'
const PORT = Number(process.env.SINK_PORT || 2526)
const STATUS = Number(process.env.SINK_STATUS || 200)
fs.mkdirSync(OUT, { recursive: true })
let seq = 0

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const name = 'req-' + String(++seq).padStart(2, '0') + '.json'
    fs.writeFileSync(path.join(OUT, name), JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }, null, 2))
    res.statusCode = STATUS
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: STATUS < 400 }))
  })
  req.on('error', () => {})
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('alert sink on 127.0.0.1:' + PORT + ' -> ' + OUT + ' reply=' + STATUS)
})
