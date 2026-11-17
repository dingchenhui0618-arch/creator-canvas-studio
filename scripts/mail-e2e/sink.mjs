// 本地假 SMTP 收信口：只够验证 VisionQA 的发信客户端（EHLO / AUTH / MAIL / RCPT / DATA / QUIT）
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.env.SINK_OUT || '/tmp/vq-mail-e2e/inbox'
const PORT = Number(process.env.SINK_PORT || 2525)
fs.mkdirSync(OUT, { recursive: true })
let seq = 0

const server = net.createServer((socket) => {
  socket.setEncoding('utf8')
  socket.write('220 sink.local ESMTP ready' + String.fromCharCode(13, 10))
  let buf = ''
  let inData = false
  let lines = []
  let authStage = ''
  socket.on('data', (chunk) => {
    buf += chunk
    let at
    while ((at = buf.indexOf(String.fromCharCode(13, 10))) >= 0) {
      const line = buf.slice(0, at)
      buf = buf.slice(at + 2)
      if (inData) {
        if (line === '.') {
          inData = false
          const file = path.join(OUT, 'msg-' + (++seq).toString().padStart(2, '0') + '.eml')
          fs.writeFileSync(file, lines.join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10))
          lines = []
          socket.write('250 2.0.0 queued' + String.fromCharCode(13, 10))
        } else {
          lines.push(line)
        }
        continue
      }
      if (authStage === 'user') {
        authStage = 'pass'
        socket.write('334 UGFzc3dvcmQ6' + String.fromCharCode(13, 10))
        continue
      }
      if (authStage === 'pass') {
        authStage = ''
        socket.write('235 2.7.0 authenticated' + String.fromCharCode(13, 10))
        continue
      }
      const upper = line.toUpperCase()
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        socket.write('250-sink.local' + String.fromCharCode(13, 10) + '250-AUTH PLAIN LOGIN' + String.fromCharCode(13, 10) + '250-SIZE 1048576' + String.fromCharCode(13, 10) + '250 8BITMIME' + String.fromCharCode(13, 10))
      } else if (upper.startsWith('AUTH PLAIN')) {
        socket.write('235 2.7.0 authenticated' + String.fromCharCode(13, 10))
      } else if (upper === 'AUTH LOGIN') {
        authStage = 'user'
        socket.write('334 VXNlcm5hbWU6' + String.fromCharCode(13, 10))
      } else if (upper.startsWith('STARTTLS')) {
        socket.write('502 not available here' + String.fromCharCode(13, 10))
      } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
        socket.write('250 2.1.0 ok' + String.fromCharCode(13, 10))
      } else if (upper === 'DATA') {
        inData = true
        socket.write('354 end with <String.fromCharCode(13, 10)>.<String.fromCharCode(13, 10)>' + String.fromCharCode(13, 10))
      } else if (upper === 'RSET') {
        socket.write('250 ok' + String.fromCharCode(13, 10))
      } else if (upper === 'QUIT') {
        socket.write('221 bye' + String.fromCharCode(13, 10))
        socket.end()
      } else if (upper === 'NOOP') {
        socket.write('250 ok' + String.fromCharCode(13, 10))
      } else {
        socket.write('500 unknown command' + String.fromCharCode(13, 10))
      }
    }
  })
  socket.on('error', () => {})
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('sink listening on 127.0.0.1:' + PORT + ' -> ' + OUT)
})