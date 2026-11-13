import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { buildMessage, encodeHeaderWord, normalizeSmtp, sendMail, verifySmtp } from '../server/mailer.mjs'

// 这组测试盯的是协议行为，不是「函数返回了 true」：
//   1) 报文本身是合法 MIME —— 中文主题 / 人名要按 RFC 2047 编，正文能解回原文；
//   2) 会话顺序对（EHLO → [STARTTLS] → AUTH → MAIL FROM → RCPT TO → DATA → .）；
//   3) 认证方式按服务器广告的选：只给 LOGIN 的服务器不能拿 PLAIN 硬上；
//   4) 被拒、超时都能说清是哪一步，后台表单要拿这句话显示。

const ADDRESS = (user) => user + '@' + 'example.test'

/** 一个够真的 SMTP 服务器：能广告认证方式、能拒绝收件人、能故意不说话。 */
function fakeSmtp({ auth = ['PLAIN', 'LOGIN'], rejectRcpt = null, silent = false, starttls = false } = {}) {
  const capture = { messages: [], auth: [], commands: [], connections: 0, users: [] }
  const server = net.createServer((socket) => {
    capture.connections += 1
    socket.setEncoding('utf8')
    if (silent) return
    socket.write('220 test.local ESMTP ready\r\n')
    let buffer = ''
    let inData = false
    let stage = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          const raw = buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          capture.messages.push(raw)
          socket.write('250 2.0.0 queued as ' + capture.messages.length + '\r\n')
          continue
        }
        const lineEnd = buffer.indexOf('\r\n')
        if (lineEnd < 0) return
        const line = buffer.slice(0, lineEnd)
        buffer = buffer.slice(lineEnd + 2)
        capture.commands.push(line)
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO')) {
          const lines = ['250-test.local']
          if (auth.length) lines.push('250-AUTH ' + auth.join(' '))
          if (starttls) lines.push('250-STARTTLS')
          lines.push('250 SIZE 1000000')
          socket.write(lines.join('\r\n') + '\r\n')
        } else if (upper.startsWith('AUTH PLAIN')) {
          capture.auth.push('PLAIN')
          const token = line.slice('AUTH PLAIN '.length)
          const parts = Buffer.from(token, 'base64').toString('utf8').split('\u0000')
          capture.users.push({ user: parts[1], pass: parts[2] })
          socket.write('235 2.7.0 accepted\r\n')
        } else if (upper === 'AUTH LOGIN') {
          capture.auth.push('LOGIN')
          stage = 'user'
          socket.write('334 VXNlcm5hbWU6\r\n')
        } else if (stage === 'user') {
          capture.users.push({ user: Buffer.from(line, 'base64').toString('utf8') })
          stage = 'pass'
          socket.write('334 UGFzc3dvcmQ6\r\n')
        } else if (stage === 'pass') {
          const last = capture.users[capture.users.length - 1]
          last.pass = Buffer.from(line, 'base64').toString('utf8')
          stage = ''
          socket.write('235 2.7.0 accepted\r\n')
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 ok\r\n')
        } else if (upper.startsWith('RCPT TO')) {
          if (rejectRcpt) socket.write(rejectRcpt + '\r\n')
          else socket.write('250 2.1.5 ok\r\n')
        } else if (upper === 'DATA') {
          if (rejectRcpt) socket.write('503 5.5.1 need RCPT first\r\n')
          else {
            inData = true
            socket.write('354 end with <CRLF>.<CRLF>\r\n')
          }
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n')
          socket.end()
        } else {
          socket.write('500 5.5.1 unknown\r\n')
        }
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, capture, smtp: { host: '127.0.0.1', port: server.address().port, secure: false, starttls: false } })
    })
  })
}

function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(resolve))
}

function decodeWord(value) {
  const match = String(value).match(/=\?UTF-8\?B\?(.*?)\?=/i)
  return match ? Buffer.from(match[1], 'base64').toString('utf8') : String(value)
}

function headerOf(raw, name) {
  const match = raw.match(new RegExp('^' + name + ': (.*)$', 'm'))
  return match ? match[1] : ''
}

function bodiesOf(raw) {
  // 单段报文：头部之后就是 base64 正文；multipart：按 boundary 切开，每段去掉自己的头
  const boundary = raw.match(/boundary="([^"]+)"/)
  if (boundary) {
    return raw
      .split('--' + boundary[1])
      .slice(1)
      .map((part) => {
        const index = part.indexOf('\r\n\r\n')
        if (index < 0) return ''
        return part.slice(index + 4).replace(/\r\n/g, '').replace(/--$/, '').trim()
      })
      .filter(Boolean)
  }
  const index = raw.indexOf('\r\n\r\n')
  return index < 0 ? [] : [raw.slice(index + 4).replace(/\r\n/g, '').trim()]
}

function decodeBody(raw) {
  for (const body of bodiesOf(raw).reverse()) {
    try {
      const text = Buffer.from(body, 'base64').toString('utf8')
      if (text) return text
    } catch {
      // 不是 base64 的那一段跳过
    }
  }
  return ''
}

test('中文主题与人名按 RFC 2047 编码，纯 ASCII 原样发', () => {
  assert.equal(encodeHeaderWord('VisionQA'), 'VisionQA')
  assert.equal(decodeWord(encodeHeaderWord('重置口令（30 分钟内有效）')), '重置口令（30 分钟内有效）')
  // 带逗号的名字也走编码，否则会被邮件客户端当成两个收件人
  assert.match(encodeHeaderWord('Chen, Hui'), /^=\?UTF-8\?B\?/)
})

test('报文是合法 MIME：主题/发件人可解码，正文能还原', () => {
  const raw = buildMessage({
    from: { name: 'VisionQA 视觉评审', address: ADDRESS('noreply') },
    to: ADDRESS('inbox'),
    subject: '重置 VisionQA 口令',
    text: '点这里重置：https://visionqa.example/#/reset?token=abc',
  })
  assert.match(raw, /^From: =\?UTF-8\?B\?/m)
  assert.equal(decodeWord(headerOf(raw, 'Subject')), '重置 VisionQA 口令')
  assert.equal(headerOf(raw, 'To'), ADDRESS('inbox'))
  assert.match(raw, /^MIME-Version: 1\.0$/m)
  assert.match(raw, /^Message-ID: <[^>]+>$/m)
  assert.equal(decodeBody(raw), '点这里重置：https://visionqa.example/#/reset?token=abc')
  assert.ok(raw.endsWith('\r\n\r\n') || raw.endsWith('\r\n'))
})

test('有 html 时发 multipart/alternative，两段都在', () => {
  const raw = buildMessage({
    from: { address: ADDRESS('noreply') },
    to: ADDRESS('inbox'),
    subject: 'hi',
    text: '纯文本版',
    html: '<p>HTML 版</p>',
  })
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="/)
  assert.equal(decodeWord(headerOf(raw, 'Subject')), 'hi')
  assert.ok(raw.includes('Content-Type: text/plain; charset=UTF-8'))
  assert.ok(raw.includes('Content-Type: text/html; charset=UTF-8'))
  const decoded = bodiesOf(raw).map((body) => Buffer.from(body, 'base64').toString('utf8'))
  assert.ok(decoded.includes('纯文本版'))
  assert.ok(decoded.includes('<p>HTML 版</p>'))
})

test('sendMail 走完整会话：不认证的服务器也能发，DATA 正确收尾', async () => {
  const { server, capture, smtp } = await fakeSmtp({ auth: [] })
  try {
    const result = await sendMail(
      { to: ADDRESS('inbox'), subject: '测试', text: '正文', from: { name: 'VisionQA', address: ADDRESS('noreply') } },
      smtp,
    )
    assert.equal(result.ok, true)
    assert.ok(result.ms >= 0)
    assert.equal(capture.messages.length, 1)
    assert.ok(capture.commands[0].startsWith('EHLO '))
    assert.ok(capture.commands.some((line) => line.startsWith('MAIL FROM:<' + ADDRESS('noreply') + '>')))
    assert.ok(capture.commands.some((line) => line.startsWith('RCPT TO:<' + ADDRESS('inbox') + '>')))
    assert.ok(capture.commands.includes('DATA'))
    assert.equal(decodeBody(capture.messages[0]), '正文')
  } finally {
    await closeServer(server)
  }
})

test('服务器只广告 AUTH LOGIN 时用 LOGIN，账号口令逐行 base64', async () => {
  const { server, capture, smtp } = await fakeSmtp({ auth: ['LOGIN'] })
  try {
    await sendMail(
      { to: ADDRESS('inbox'), subject: 's', text: 't', from: { address: ADDRESS('noreply') } },
      { ...smtp, user: 'bot', pass: 'p@ss word' },
    )
    assert.deepEqual(capture.auth, ['LOGIN'])
    assert.deepEqual(capture.users[0], { user: 'bot', pass: 'p@ss word' })
  } finally {
    await closeServer(server)
  }
})

test('服务器广告 AUTH PLAIN 时用 PLAIN，凭据不含明文口令命令', async () => {
  const { server, capture, smtp } = await fakeSmtp({ auth: ['PLAIN'] })
  try {
    await sendMail({ to: ADDRESS('inbox'), subject: 's', text: 't', from: { address: ADDRESS('noreply') } }, { ...smtp, user: 'bot', pass: 'secret' })
    assert.deepEqual(capture.auth, ['PLAIN'])
    assert.deepEqual(capture.users[0], { user: 'bot', pass: 'secret' })
    // AUTH 行里是 base64，不该出现明文口令
    assert.ok(!capture.commands.some((line) => line.includes('secret')))
  } finally {
    await closeServer(server)
  }
})

test('收件人被拒时报出是哪一步、以及对方的原话', async () => {
  const { server, smtp } = await fakeSmtp({ auth: [], rejectRcpt: '550 5.1.1 mailbox unavailable' })
  try {
    await assert.rejects(
      () => sendMail({ to: ADDRESS('nobody'), subject: 's', text: 't', from: { address: ADDRESS('noreply') } }, smtp),
      (error) => {
        assert.match(error.message, /RCPT TO/)
        assert.match(error.message, /550/)
        assert.match(error.message, /mailbox unavailable/)
        return true
      },
    )
  } finally {
    await closeServer(server)
  }
})

test('服务器不说话时按超时失败，不无限等', async () => {
  const { server, smtp } = await fakeSmtp({ silent: true })
  try {
    const started = Date.now()
    await assert.rejects(
      () => sendMail({ to: ADDRESS('inbox'), subject: 's', text: 't', from: { address: ADDRESS('noreply') } }, smtp, { timeoutMs: 2000 }),
      /超时/,
    )
    assert.ok(Date.now() - started < 5000)
  } finally {
    await closeServer(server)
  }
})

test('verifySmtp 只连通+登录，不发信', async () => {
  const { server, capture, smtp } = await fakeSmtp({ auth: ['PLAIN'] })
  try {
    const result = await verifySmtp({ ...smtp, user: 'bot', pass: 'p' })
    assert.equal(result.ok, true)
    assert.equal(result.auth, 'PLAIN')
    assert.equal(capture.messages.length, 0)
  } finally {
    await closeServer(server)
  }
})

test('配置校验：端口、协议、账号口令成对', () => {
  assert.equal(normalizeSmtp({ host: 'smtp.example.test', port: 465, secure: true }).port, 465)
  assert.equal(normalizeSmtp({ host: 'smtp.example.test', secure: false }).port, 587)
  assert.throws(() => normalizeSmtp({ host: '' }), /服务器地址不能为空/)
  assert.throws(() => normalizeSmtp({ host: 'smtp.example.test', port: 70000 }), /端口/)
  assert.throws(() => normalizeSmtp({ host: 'smtp.example.test', user: 'bot' }), /口令/)
  assert.throws(() => normalizeSmtp({ host: 'smtp.example.test', pass: 'x' }), /账号/)
  assert.throws(() => normalizeSmtp({ host: 'smtp example.test' }), /只能包含/)
})
