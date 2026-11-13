// SMTP 发信：自己实现一个最小客户端，不引第三方依赖。
// 为什么不上 nodemailer：部署机上只在 lock 文件变化时才 npm ci，多一个包就多一处生产差异；
// 我们只需要「连上去、认证（可选）、发一封 UTF-8 邮件」这一小段协议面。
//
// 支持：
//   - 直连 TLS（465 / secure=true）
//   - STARTTLS 升级（587 / secure=false 且 starttls=true）
//   - AUTH PLAIN / AUTH LOGIN（服务器广告哪个用哪个）
//   - 正文 base64（不受 8bit 限制，也不会出现以 . 开头的行）
// 不做的：附件、退信解析、连接池、DKIM 签名。发信量是「找回密码 + 测试」级别，用不上。
import crypto from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'

const CRLF = '\r\n'
const DEFAULT_TIMEOUT = 20000
const MAX_REPLY_LINES = 200

/** RFC 2047 编码：非 ASCII 主题 / 发件人名按 base64 编码，纯 ASCII 原样发。 */
export function encodeHeaderWord(value) {
  const text = String(value || '')
  if (!text) return ''
  // 可打印 ASCII 且不含会破坏头部的字符时原样发；其余一律编码，避免中文被截坏
  if (/^[\x20-\x7e]*$/.test(text) && !/[<>@,;:"\\]/.test(text)) return text
  return '=?UTF-8?B?' + Buffer.from(text, 'utf8').toString('base64') + '?='
}

function formatAddress(input) {
  const address = String(input?.address || '').trim()
  const name = String(input?.name || '').trim()
  if (!name) return address
  return encodeHeaderWord(name) + ' <' + address + '>'
}

function base64Lines(text) {
  const encoded = Buffer.from(String(text || ''), 'utf8').toString('base64')
  const lines = []
  for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76))
  return lines.join(CRLF)
}

function textPart(text) {
  return ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(text)]
}

function htmlPart(html) {
  return ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(html)]
}

/**
 * 拼一封 MIME 报文（CRLF 结尾）。
 * 纯文本时是单段 text/plain；给了 html 就发 multipart/alternative，客户端自己挑能显示的。
 */
export function buildMessage(input = {}) {
  const from = input.from || {}
  const address = String(from.address || '').trim()
  const to = String(input.to || '').trim()
  const subject = String(input.subject || '').trim()
  const text = String(input.text || '')
  const html = String(input.html || '')
  if (!address) throw new Error('发件地址不能为空')
  if (!to) throw new Error('收件地址不能为空')
  const domain = address.split('@')[1] || 'visionqa.local'
  const messageId = String(input.messageId || '<' + crypto.randomBytes(12).toString('hex') + '@' + domain + '>')
  const date = input.date instanceof Date ? input.date : new Date()
  const lines = [
    'From: ' + formatAddress(from),
    'To: ' + to,
    'Subject: ' + encodeHeaderWord(subject),
    'Date: ' + date.toUTCString(),
    'Message-ID: ' + messageId,
    'MIME-Version: 1.0',
  ]
  if (html) {
    const boundary = 'vq-' + crypto.randomBytes(8).toString('hex')
    lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"', '')
    lines.push('--' + boundary, ...textPart(text), '--' + boundary, ...htmlPart(html), '--' + boundary + '--')
  } else {
    lines.push(...textPart(text))
  }
  return lines.join(CRLF) + CRLF
}

/** 规范化并校验 SMTP 配置；错误信息直接给后台表单用。 */
export function normalizeSmtp(input = {}) {
  const host = String(input?.host || '').trim()
  if (!host) throw new Error('SMTP 服务器地址不能为空')
  if (host.length > 190) throw new Error('SMTP 服务器地址太长')
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(host)) throw new Error('SMTP 服务器地址只能包含字母、数字、点、横线和方括号')
  const secure = input?.secure === true
  const rawPort = input?.port === undefined || input?.port === null || input?.port === '' ? (secure ? 465 : 587) : Number(input.port)
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) throw new Error('SMTP 端口要是 1 到 65535 之间的整数')
  const user = String(input?.user || '').trim()
  const pass = String(input?.pass || '')
  if (user && !pass) throw new Error('填了账号就要填口令')
  if (!user && pass) throw new Error('填了口令就要填账号')
  return {
    host,
    port: rawPort,
    secure,
    starttls: !secure && input?.starttls !== false,
    user,
    pass,
    insecure: input?.insecure === true,
  }
}

class SmtpReader {
  constructor(socket, timeoutMs) {
    this.socket = socket
    this.timeoutMs = timeoutMs
    this.buffer = ''
    this.failure = null
    this.waiter = null
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      this.buffer += chunk
      this.flush()
    })
    socket.on('error', (cause) => {
      this.failure = cause
      this.flush()
    })
    socket.on('close', () => {
      if (!this.failure) this.failure = new Error('SMTP 连接被对方关掉了')
      this.flush()
    })
  }

  /** 从缓冲区切一个完整响应；没有完整响应时返回 null（等下一块数据）。 */
  take() {
    let index = 0
    const lines = []
    while (lines.length < MAX_REPLY_LINES) {
      const end = this.buffer.indexOf(CRLF, index)
      if (end < 0) return null
      const line = this.buffer.slice(index, end)
      index = end + 2
      lines.push(line)
      if (/^\d{3}(?: |$)/.test(line)) {
        this.buffer = this.buffer.slice(index)
        return { code: Number(line.slice(0, 3)), lines, text: lines.map((item) => item.slice(4)).join(' ') }
      }
    }
    this.buffer = this.buffer.slice(index)
    return { code: 0, lines, text: '看不懂的响应：' + lines.join(' / ').slice(0, 200) }
  }

  flush() {
    if (!this.waiter) return
    const waiter = this.waiter
    const reply = this.take()
    if (reply) {
      this.waiter = null
      clearTimeout(waiter.timer)
      waiter.resolve(reply)
      return
    }
    if (this.failure) {
      this.waiter = null
      clearTimeout(waiter.timer)
      waiter.reject(this.failure)
    }
  }

  next() {
    return new Promise((resolve, reject) => {
      const seconds = Math.max(1, Math.round(this.timeoutMs / 1000))
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new Error('SMTP 超时：' + seconds + ' 秒没有响应'))
      }, this.timeoutMs)
      timer.unref?.()
      this.waiter = { resolve, reject, timer }
      this.flush()
    })
  }
}

function command(reader, line) {
  reader.socket.write(line + CRLF)
  return reader.next()
}

function expectReply(reply, stage, codes) {
  if (codes.includes(reply.code)) return reply
  const detail = (reply.text || '').trim()
  throw new Error('SMTP ' + stage + ' 被拒绝（' + reply.code + '）' + (detail ? '：' + detail : ''))
}

async function ehlo(reader) {
  const reply = await command(reader, 'EHLO visionqa.local')
  expectReply(reply, 'EHLO（服务器需要先打招呼）', [250])
  return reply
}

function authMechanisms(reply) {
  const joined = reply.lines.join('\n').toUpperCase()
  return { plain: /AUTH[ =][^\n]*PLAIN/.test(joined), login: /AUTH[ =][^\n]*LOGIN/.test(joined) }
}

async function authenticate(reader, smtp, mechanisms) {
  if (mechanisms.plain) {
    const token = Buffer.from('\u0000' + smtp.user + '\u0000' + smtp.pass, 'utf8').toString('base64')
    const reply = await command(reader, 'AUTH PLAIN ' + token)
    expectReply(reply, 'AUTH PLAIN（账号或口令不对）', [235])
    return 'PLAIN'
  }
  if (mechanisms.login) {
    expectReply(await command(reader, 'AUTH LOGIN'), 'AUTH LOGIN', [334])
    expectReply(await command(reader, Buffer.from(smtp.user, 'utf8').toString('base64')), 'AUTH LOGIN（账号）', [334])
    expectReply(await command(reader, Buffer.from(smtp.pass, 'utf8').toString('base64')), 'AUTH LOGIN（口令不对）', [235])
    return 'LOGIN'
  }
  throw new Error('服务器没有提供 AUTH PLAIN / LOGIN，这个发信账号用不了')
}

async function upgradeToTls(socket, host, insecure, timeoutMs) {
  const secured = tls.connect({ socket, servername: host, rejectUnauthorized: insecure !== true })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      secured.destroy()
      reject(new Error('STARTTLS 握手超时'))
    }, timeoutMs)
    timer.unref?.()
    secured.once('secureConnect', () => {
      clearTimeout(timer)
      resolve()
    })
    secured.once('error', (cause) => {
      clearTimeout(timer)
      reject(new Error('STARTTLS 握手失败：' + cause.message))
    })
  })
  return secured
}

async function openSocket(smtp, timeoutMs) {
  const socket = smtp.secure
    ? tls.connect({ host: smtp.host, port: smtp.port, servername: smtp.host, rejectUnauthorized: smtp.insecure !== true })
    : net.connect({ host: smtp.host, port: smtp.port })
  await new Promise((resolve, reject) => {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000))
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('连不上 SMTP 服务器 ' + smtp.host + ':' + smtp.port + '（' + seconds + ' 秒超时）'))
    }, timeoutMs)
    timer.unref?.()
    socket.once(smtp.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', (cause) => {
      clearTimeout(timer)
      reject(new Error('连不上 SMTP 服务器 ' + smtp.host + ':' + smtp.port + '：' + cause.message))
    })
  })
  return socket
}

/** 建一条会话：连接、打招呼、按需 STARTTLS、按需登录。返回当前 socket 与 reader。 */
async function openSession(smtp, timeoutMs) {
  let socket = await openSocket(smtp, timeoutMs)
  try {
    let reader = new SmtpReader(socket, timeoutMs)
    const greeting = await reader.next()
    expectReply(greeting, '握手（对方没按 SMTP 应门）', [220])
    let capabilities = await ehlo(reader)
    if (!smtp.secure && smtp.starttls) {
      expectReply(await command(reader, 'STARTTLS'), 'STARTTLS', [220])
      // 升级前把旧 reader 的监听摘掉，否则 TLS 握手期间旧的 data 事件还会继续往旧缓冲区写
      socket.removeAllListeners('data')
      socket.removeAllListeners('error')
      socket.removeAllListeners('close')
      socket = await upgradeToTls(socket, smtp.host, smtp.insecure, timeoutMs)
      reader = new SmtpReader(socket, timeoutMs)
      capabilities = await ehlo(reader)
    }
    let auth = ''
    if (smtp.user) auth = await authenticate(reader, smtp, authMechanisms(capabilities))
    return { socket, reader, auth }
  } catch (error) {
    // 握手 / 认证失败时连接还开着：不销毁的话调用方的服务器会一直挂着一个连接
    socket.destroy()
    throw error
  }
}

function dotStuff(body) {
  return body.replace(/(^|\r\n)\./g, '$1..')
}

async function closeSession(session) {
  try {
    session.socket.write('QUIT' + CRLF)
    // 不要求等 221：收不到就直接断，别为一句告别多等一个超时
    await Promise.race([session.reader.next(), new Promise((resolve) => setTimeout(resolve, 1500).unref?.())])
  } catch {
    // 对端已经断了，没必要再报错
  } finally {
    session.socket.destroy()
  }
}

/**
 * 发一封信。message: { to, subject, text, html, from: { name, address } }
 * smtp: normalizeSmtp() 的输出。返回 { ok, ms, auth, messageId }，失败抛错（带阶段信息）。
 */
export async function sendMail(message, smtpInput, options = {}) {
  const smtp = normalizeSmtp({ ...smtpInput, pass: smtpInput?.pass })
  const timeoutMs = Math.max(2000, Number(options.timeoutMs) || DEFAULT_TIMEOUT)
  const to = String(message?.to || '').trim()
  if (!to) throw new Error('收件地址不能为空')
  const fromAddress = String(message?.from?.address || smtp.user || '').trim()
  if (!fromAddress) throw new Error('发件地址不能为空：后台填一个发件邮箱')
  const raw = buildMessage({ ...message, to, from: { name: message?.from?.name || '', address: fromAddress } })
  const started = Date.now()
  const session = await openSession(smtp, timeoutMs)
  try {
    expectReply(await command(session.reader, 'MAIL FROM:<' + fromAddress + '>'), 'MAIL FROM（发件地址被拒）', [250])
    expectReply(await command(session.reader, 'RCPT TO:<' + to + '>'), 'RCPT TO（收件地址被拒）', [250, 251])
    expectReply(await command(session.reader, 'DATA'), 'DATA', [354])
    session.socket.write(dotStuff(raw) + (raw.endsWith(CRLF) ? '' : CRLF) + '.' + CRLF)
    expectReply(await session.reader.next(), 'DATA（对方没有接收这封信）', [250])
    await closeSession(session)
    return { ok: true, ms: Date.now() - started, auth: session.auth || '', messageId: (raw.match(/^Message-ID: (.*)$/m) || [])[1] || '' }
  } catch (error) {
    session.socket.destroy()
    throw error
  }
}

/** 只验连通与登录，不发信：后台「测一下」用，避免为了探测凭空给人发一封邮件。 */
export async function verifySmtp(smtpInput, options = {}) {
  const smtp = normalizeSmtp({ ...smtpInput, pass: smtpInput?.pass })
  const timeoutMs = Math.max(2000, Number(options.timeoutMs) || DEFAULT_TIMEOUT)
  const started = Date.now()
  const session = await openSession(smtp, timeoutMs)
  await closeSession(session)
  return { ok: true, ms: Date.now() - started, auth: session.auth || '' }
}
