// 告警外推整条链路：配通道 → 打不通时进待重试队列 → 通道通了首推成功并验签 → 手动重试补发
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8803'
const INBOX = process.env.SINK_OUT || '/tmp/vq-alert-e2e/inbox'
const SINK_PORT = Number(process.env.SINK_PORT || 2526)
const DEAD_PORT = Number(process.env.DEAD_PORT || 2527)
const AT = String.fromCharCode(64)
const EMAIL = process.env.ALERT_E2E_EMAIL || ('alerttest' + AT + 'example.com')
const PASS = process.argv[2] || 'TestPass123'
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
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  return { status: res.status, json, cookie: (cookies[0] || '').split(';')[0] }
}

function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = async () => {
      const hit = await predicate()
      if (hit || Date.now() - started > timeoutMs) return resolve(hit || null)
      setTimeout(tick, 250)
    }
    tick()
  })
}

function readInbox() {
  let names = []
  try { names = fs.readdirSync(INBOX).sort() } catch { names = [] }
  return names.map((name) => JSON.parse(fs.readFileSync(path.join(INBOX, name), 'utf8')))
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(body).digest('hex')
}

// 1. 登录管理员
const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASS })
const cookie = login.cookie
note('login', login.status)
if (!cookie) { console.log(JSON.stringify(out, null, 2)); process.exit(1) }

// 2. 配之前：没有通道，队列空
const before = await call('GET', '/api/admin/alerts', null, cookie)
note('channel.configured before', before.json?.channel?.configured)
note('outbox before', JSON.stringify(before.json?.outbox || null))

// 3. 先指向一个「打不通」的地址，签一次名拿密钥（只在第一次保存时回明文）
const dead = await call('PUT', '/api/admin/alerts/channel', { url: 'http://127.0.0.1:' + DEAD_PORT + '/hook', rotate: true, enabled: true }, cookie)
const secret = dead.json?.secret || ''
note('PUT channel (dead port)', dead.status + ' configured=' + (dead.json?.channel?.configured) + ' secretGiven=' + Boolean(secret))
if (!secret) { note('secret', '首次保存没回密钥，验签做不了'); console.log(JSON.stringify(out, null, 2)); process.exit(1) }

// 4. 触发一条真告警：外推失败，应进「待重试」
const failTest = await call('POST', '/api/admin/alerts/test', {}, cookie)
note('POST alerts/test (dead)', failTest.status)
const queued = await waitFor(async () => {
  const s = await call('GET', '/api/admin/alerts', null, cookie)
  const items = s.json?.outboxItems || []
  const pending = items.find((item) => item.state === 'pending' || item.state === 'failed')
  return pending ? { item: pending, stats: s.json.outbox } : null
})
note('queued after failure', queued ? JSON.stringify({ id: queued.item.id, state: queued.item.state, lastStatus: queued.item.lastStatus, lastError: String(queued.item.lastError || '').slice(0, 80) }) : 'NO_QUEUE_ITEM')
if (!queued) { console.log(JSON.stringify(out, null, 2)); process.exit(1) }

// 5. 把通道换成能收的地址（不换密钥），再触发一条：这次应直接成功
const live = await call('PUT', '/api/admin/alerts/channel', { url: 'http://127.0.0.1:' + SINK_PORT + '/hook', rotate: false, enabled: true }, cookie)
note('PUT channel (live sink)', live.status + ' secretKept=' + (live.json?.secret === ''))
const okTest = await call('POST', '/api/admin/alerts/test', {}, cookie)
note('POST alerts/test (live)', okTest.status)
const first = await waitFor(() => {
  const box = readInbox()
  return box.length ? box[0] : null
})
if (!first) {
  note('sink request', 'NOT RECEIVED')
  console.log(JSON.stringify(out, null, 2))
  process.exit(1)
}
note('sink request', 'POST ' + first.url + ' ua=' + first.headers['user-agent'])
note('signature present', Boolean(first.headers['x-vq-signature']))
note('signature matches', first.headers['x-vq-signature'] === sign(secret, first.body))
let payload = null
try { payload = JSON.parse(first.body) } catch {}
note('payload source/kind', payload ? payload.source + '/' + (payload.alert?.kind || '') : 'unparsable')
note('payload text', payload ? String(payload.text).slice(0, 60) : '')

// 6. 手动重试那条没发出去的：接收端应再收到一条
const retry = await call('POST', '/api/admin/alerts/outbox/' + queued.item.id + '/retry', {}, cookie)
note('POST outbox retry', retry.status + ' state=' + (retry.json?.item?.state || '') + ' attempts=' + (retry.json?.item?.attempts ?? ''))
const second = await waitFor(() => {
  const box = readInbox()
  return box.length > 1 ? box[1] : null
})
note('sink request after retry', second ? 'POST ' + second.url + ' signed=' + Boolean(second.headers['x-vq-signature']) : 'NO_SECOND_REQUEST')
if (second) note('retry signature matches', second.headers['x-vq-signature'] === sign(secret, second.body))

// 7. 收尾状态：队列应清空、发送计数应增加
const after = await call('GET', '/api/admin/alerts', null, cookie)
note('outbox after', JSON.stringify(after.json?.outbox || null))
note('alerts counts', JSON.stringify(after.json?.counts || null))
note('sink total', readInbox().length)

console.log(JSON.stringify(out, null, 2))
