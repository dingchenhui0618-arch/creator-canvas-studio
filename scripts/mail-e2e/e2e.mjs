// 找回密码整条链路：后台配通道 → 发测试信 → 忘记密码 → 从邮件取链接 → 换新口令 → 用新口令登录
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8802'
const INBOX = process.env.SINK_OUT || '/tmp/vq-mail-e2e/inbox'
const AT = String.fromCharCode(64)
const EMAIL = 'mailtest' + AT + 'example.com'
const OLD_PASS = process.argv[2] || 'TestPass123'
const NEW_PASS = process.argv[3] || 'NewPass456'
const out = { base: BASE, steps: [] }

function note(step, value) {
  out.steps.push({ step, value })
}

async function call(method, pathname, body, cookie) {
  const headers = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  const res = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
  return { status: res.status, json, cookies: res.headers.getSetCookie ? res.headers.getSetCookie() : [] }
}

function waitFor(predicate, timeoutMs = 12000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const hit = predicate()
      if (hit || Date.now() - started > timeoutMs) return resolve(hit || null)
      setTimeout(tick, 250)
    }
    tick()
  })
}

function readInbox() {
  let names = []
  try { names = fs.readdirSync(INBOX).sort() } catch { names = [] }
  return names.map((name) => ({ name, text: fs.readFileSync(path.join(INBOX, name), 'utf8') }))
}

// 信体是多段 base64（multipart/alternative），原样搜不到链接，先解码
function decodeParts(raw) {
  const out = []
  const re = /Content-Transfer-Encoding: base64\s*\n[\s\S]*?\n\s*\n((?:[A-Za-z0-9+/=\s]+\n)+)/g
  let m
  while ((m = re.exec(raw))) {
    const chunk = m[1].replace(/\s+/g, '')
    try { out.push(Buffer.from(chunk, 'base64').toString('utf8')) } catch {}
  }
  return out.join('\n')
}

function bodyOf(item) {
  return item.text + '\n' + decodeParts(item.text)
}

function decode2047(value) {
  return String(value || '').replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (all, b64) => {
    try { return Buffer.from(b64, 'base64').toString('utf8') } catch { return all }
  })
}

// 1. 起状态：通道应先是没有
const before = await call('GET', '/api/auth/config')
note('auth/config passwordReset', before.json && before.json.passwordReset)

// 2. 登录管理员（VQ_ADMIN_EMAILS 指定）
const login1 = await call('POST', '/api/auth/login', { email: EMAIL, password: OLD_PASS })
const cookie = (login1.cookies[0] || '').split(';')[0]
note('login(old pass)', login1.status)
if (!cookie) { console.log(JSON.stringify(out, null, 2)); process.exit(1) }

// 3. 后台看邮件通道（应为未配置）
const mailBefore = await call('GET', '/api/admin/mail', null, cookie)
note('admin/mail configured before', mailBefore.json && mailBefore.json.mail && mailBefore.json.mail.configured)

// 4. 保存通道指向本地假 SMTP（starttls 关掉，sink 不提供 TLS）
const save = await call('PUT', '/api/admin/mail/channel', {
  host: '127.0.0.1',
  port: Number(process.env.SINK_PORT || 2525),
  secure: false,
  starttls: false,
  user: 'sink-user',
  pass: 'sink-pass',
  fromName: 'VisionQA 测试',
  fromAddress: 'no-reply' + AT + 'sink.local',
  enabled: true,
}, cookie)
note('admin/mail/channel PUT', save.status + ' ' + JSON.stringify(save.json && save.json.mail ? { configured: save.json.mail.configured, host: save.json.mail.host, port: save.json.mail.port, passMasked: save.json.mail.passMasked || save.json.mail.pass } : save.json))

// 5. 真发一封测试信，等 SMTP 结果再回话
const test = await call('POST', '/api/admin/mail/test', { to: 'receiver' + AT + 'example.com' }, cookie)
note('admin/mail/test', test.status + ' ' + JSON.stringify(test.json))

// 6. 忘记密码：接口不区分邮箱是否存在，但真的会发信
const forgot = await call('POST', '/api/auth/password/forgot', { email: EMAIL })
note('password/forgot', forgot.status + ' ' + JSON.stringify(forgot.json))

// 7. 从假 SMTP 收件箱里找重置信
const resetMail = await waitFor(() => readInbox().find((item) => /reset\?token=/.test(bodyOf(item))))
note('inbox messages', readInbox().length)
if (!resetMail) {
  note('reset mail', 'NOT RECEIVED')
  console.log(JSON.stringify(out, null, 2))
  process.exit(1)
}
const tokenMatch = bodyOf(resetMail).match(/reset\?token=([^"\s>]+)/)
const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : ''
note('reset mail subject', decode2047((resetMail.text.match(/^Subject: (.*)$/m) || [])[1] || ''))
note('reset mail has token', Boolean(token && token.length > 10))
note('reset mail from', (resetMail.text.match(/^From: (.*)$/m) || [])[1] || '')

// 8. 重置页探测：这枚 token 还能不能用
const peek = await call('GET', '/api/auth/password/reset?token=' + encodeURIComponent(token))
note('reset peek', peek.status + ' ' + JSON.stringify(peek.json))

// 9. 用 token 换新口令
const reset = await call('POST', '/api/auth/password/reset', { token, password: NEW_PASS })
note('reset consume', reset.status + ' ' + JSON.stringify(reset.json))

// 10. 旧口令应失败、新口令应成功
const loginOld = await call('POST', '/api/auth/login', { email: EMAIL, password: OLD_PASS })
note('login with OLD pass after reset', loginOld.status)
const loginNew = await call('POST', '/api/auth/login', { email: EMAIL, password: NEW_PASS })
note('login with NEW pass after reset', loginNew.status)

// 11. 同一枚 token 不能再用第二次
const reuse = await call('POST', '/api/auth/password/reset', { token, password: 'AnotherPass789' })
note('reset reuse', reuse.status + ' ' + JSON.stringify(reuse.json))

// 12. 通道配好之后，登录页的「忘记密码」应变成可用
const after = await call('GET', '/api/auth/config')
note('auth/config passwordReset after', after.json && after.json.passwordReset)

console.log(JSON.stringify(out, null, 2))