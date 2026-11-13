import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// 告警外推是「出事时唯一会主动叫你」的通道，所以这组测试盯的不是「有没有发 POST」：
//   1) 地址本身就是凭证：接口视图只给掩码，落盘 0600，重存沿用旧密钥；
//   2) 投递绝不阻塞调用方：告警来自 5xx 处理器，等网络等于把故障放大一圈；
//   3) 失败不丢：进重试队列、按退避排期、四次才 dead，可手动补发；
//   4) 签名可验证（HMAC-SHA256，对请求体原文），接收端能据此判断是不是本站发的。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-alert-'))
process.env.DATA_DIR = dir
delete process.env.VQ_ALERT_WEBHOOK

const channel = await import('../server/alert-channel.mjs')
const { config } = await import('../server/config.mjs')

// 环境变量在进程启动时读走，这里直接改配置对象：测的正是「后台没配通道时退回什么」
const ENV_URL = 'https://env.example.com/hook/abcd1234efgh'
function useEnvChannel(url) {
  config.alerts.webhook = url
}

let seq = 0
// 每个用例拿一份新的 alerts 模块实例：缓存与投递链都是模块级的，共用会互相污染
async function freshAlerts() {
  seq += 1
  return import('../server/alerts.mjs?v=' + seq)
}

function clearFiles() {
  for (const name of ['alerts.json', 'alert-outbox.json']) {
    fs.rmSync(path.join(dir, name), { force: true })
  }
}

// 一个真的接收端：capture 里留下原始请求体与头，后面按它验签名
function receiver({ status = 200, delayMs = 0, hold = false } = {}) {
  // hold = 收到请求后压着不回，由用例决定什么时候放行：这样「有没有在等网络」不用拿秒表赌调度
  const capture = { hits: 0, replied: 0, raw: '', headers: {}, body: null, release: () => {} }
  const server = http.createServer((req, res) => {
    capture.hits += 1
    capture.headers = req.headers
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      capture.raw = Buffer.concat(chunks).toString('utf8')
      try {
        capture.body = JSON.parse(capture.raw)
      } catch {
        capture.body = null
      }
      const reply = () => {
        capture.replied += 1
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: status < 400 }))
      }
      if (hold) capture.release = reply
      else if (delayMs) setTimeout(reply, delayMs)
      else reply()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, capture, url: 'http://127.0.0.1:' + server.address().port + '/hook' }))
  })
}

function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(resolve))
}

function expectedSignature(secret, raw) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex')
}

test('地址掩码：留 origin 与末段前 4 位，其余打掉', () => {
  const masked = channel.maskUrl('https://open.feishu.cn/open-apis/bot/v2/hook/abcd1234-ef56-7890')
  assert.match(masked, /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/abcd••••$/)
  assert.ok(!masked.includes('ef56'))
  assert.equal(channel.maskUrl(''), '')
  assert.equal(channel.maskUrl('not a url'), '••••')
})

test('地址校验：只收 http(s)，拒绝其它协议与内嵌口令', () => {
  assert.equal(channel.normalizeChannelUrl('https://example.com/hook').ok, true)
  assert.equal(channel.normalizeChannelUrl('ftp://example.com/hook').ok, false)
  assert.equal(channel.normalizeChannelUrl('file:///etc/passwd').ok, false)
  assert.equal(channel.normalizeChannelUrl('https://user:pass@example.com/hook').ok, false)
  assert.equal(channel.normalizeChannelUrl('').ok, false)
})

test('没配后台通道时退回环境变量，视图里只出现掩码', async () => {
  clearFiles()
  useEnvChannel(ENV_URL)
  const view = await channel.channelView()
  assert.equal(view.source, 'env')
  assert.equal(view.configured, true)
  assert.equal(view.canEdit, false)
  assert.ok(view.urlMasked.startsWith('https://env.example.com/'))
  assert.ok(!view.urlMasked.includes('abcd1234efgh'))
})

test('后台通道：落盘 0600、密钥只第一次生成、重存沿用旧密钥', async () => {
  clearFiles()
  const first = await channel.saveChannel({ url: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret-tail', by: 'admin@example.com' })
  assert.equal(first.ok, true)
  assert.equal(first.secretCreated, true)
  assert.equal(first.channel.secret.length, 64)
  const file = channel.channelFile()
  // Windows 没有 POSIX 权限位（chmod 是空操作），生产是 Linux；那边必须只有宿主账号能读
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.url, 'https://open.feishu.cn/open-apis/bot/v2/hook/secret-tail')

  const again = await channel.saveChannel({ url: 'https://open.feishu.cn/open-apis/bot/v2/hook/another-tail', by: 'admin@example.com' })
  assert.equal(again.secretCreated, false)
  assert.equal(again.channel.secret, first.channel.secret)

  const rotated = await channel.saveChannel({ url: 'https://open.feishu.cn/open-apis/bot/v2/hook/another-tail', rotate: true, by: 'admin@example.com' })
  assert.equal(rotated.secretCreated, true)
  assert.notEqual(rotated.channel.secret, first.channel.secret)
})

test('后台配过就优先用它，清掉后回到环境变量', async () => {
  clearFiles()
  useEnvChannel(ENV_URL)
  await channel.saveChannel({ url: 'https://admin.example.com/hook/admin-tail' })
  let view = await channel.channelView()
  assert.equal(view.source, 'admin')
  assert.equal(view.canEdit, true)
  await channel.clearChannel()
  view = await channel.channelView()
  assert.equal(view.source, 'env')
})

test('投递不阻塞调用方：接收端压着不回，recordAlert 照样返回', async () => {
  clearFiles()
  useEnvChannel('')
  // 接收端收到请求后压着不回（由下面放行）：要是 recordAlert 在等这个响应，
  // 它就会一直挂到 5 秒的兜底超时——那才是「阻塞」；秒表式的 500ms 断言在并行跑测试时是脆的。
  const { server, capture, url } = await receiver({ status: 500, hold: true })
  await channel.saveChannel({ url })
  const alerts = await freshAlerts()
  try {
    const alert = await Promise.race([
      alerts.recordAlert({ kind: 'server-5xx', title: '投递不该挡住请求', dedupeKey: 'blocking' }),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ])
    assert.notEqual(alert, 'timeout', 'recordAlert 5 秒都没返回：它在等接收端的响应')
    assert.ok(alert, '告警要落盘')
    // 请求已经发出去了，而接收端还没回：这正是「没在等网络」
    for (let i = 0; i < 40 && capture.hits < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(capture.hits, 1)
    assert.equal(capture.replied, 0)
    // 放行响应，再让这次投递落地：断言的是失败进重试队列，不是时间
    capture.release()
    await alerts.flushAlertDeliveries()
    const box = await alerts.outboxStats()
    assert.equal(box.pending, 1)
    assert.equal(box.lastAttempt.status, 500)
  } finally {
    await closeServer(server)
  }
})

test('发送内容与签名：text 可读，x-vq-signature 能用密钥验过', async () => {
  clearFiles()
  useEnvChannel('')
  const { server, capture, url } = await receiver({ status: 200 })
  const saved = await channel.saveChannel({ url })
  const alerts = await freshAlerts()
  try {
    const alert = await alerts.recordAlert({ kind: 'disk-low', level: 'warn', title: '数据盘剩余空间不足', detail: '剩余 0.8 GB', dedupeKey: 'sign' })
    await alerts.flushAlertDeliveries()
    assert.equal(capture.hits, 1)
    assert.match(capture.body.text, /^\[磁盘剩余不足\] 数据盘剩余空间不足 · 剩余 0\.8 GB/)
    assert.equal(capture.body.source, 'visionqa')
    assert.equal(capture.body.alert.id, alert.id)
    assert.equal(capture.headers['x-vq-signature'], expectedSignature(saved.channel.secret, capture.raw))
    const box = await alerts.outboxStats()
    assert.equal(box.pending, 0)
    assert.equal(box.sentCount, 1)
    assert.equal(box.lastSentStatus, 200)
  } finally {
    await closeServer(server)
  }
})

test('失败进重试队列：退避排期、四次后标已失败、手动补发能清掉', async () => {
  clearFiles()
  useEnvChannel('')
  const failing = await receiver({ status: 503 })
  const saved = await channel.saveChannel({ url: failing.url })
  const alerts = await freshAlerts()
  let healthy = null
  try {
    await alerts.recordAlert({ kind: 'model-blocked', title: '上游拒绝了这把 Key', dedupeKey: 'retry' })
    await alerts.flushAlertDeliveries()
    let items = await alerts.listOutbox({})
    assert.equal(items.length, 1)
    assert.equal(items[0].attempts, 1)
    assert.equal(items[0].lastStatus, 503)
    const wait = Date.parse(items[0].nextAt) - Date.now()
    assert.ok(wait > 30_000 && wait <= 61_000, '第一次重试应在 1 分钟后，实际 ' + Math.round(wait / 1000) + 's')

    // 再推三次（强制立刻到期）：第 4 次仍失败就 dead，不再无限重试
    for (let index = 0; index < 3; index += 1) await alerts.drainOutbox({ force: true })
    items = await alerts.listOutbox({})
    assert.equal(items[0].attempts, 4)
    assert.equal(items[0].state, 'dead')
    assert.equal((await alerts.outboxStats()).dead, 1)

    // 接收端恢复后手动补发：发出去就从队列里消失，成功计数 +1
    await closeServer(failing.server)
    healthy = await receiver({ status: 200 })
    await channel.saveChannel({ url: healthy.url })
    const sent = await alerts.retryOutboxItem(items[0].id)
    assert.equal(sent.state, 'sent')
    assert.equal((await alerts.listOutbox({})).length, 0)
    assert.equal((await alerts.outboxStats()).sentCount, 1)
    assert.equal(healthy.capture.hits, 1)
    // 换地址不换签名密钥，接收端不用跟着改
    assert.equal(healthy.capture.headers['x-vq-signature'], expectedSignature(saved.channel.secret, healthy.capture.raw))
  } finally {
    await closeServer(failing.server).catch(() => {})
    if (healthy) await closeServer(healthy.server).catch(() => {})
  }
})

test('没有通道时不进队列也不抛错：这事不能影响 5xx 处理', async () => {
  clearFiles()
  await channel.clearChannel()
  useEnvChannel('')
  const alerts = await freshAlerts()
  const alert = await alerts.recordAlert({ kind: 'test', title: '没有通道的测试告警', dedupeKey: 'no-channel' })
  await alerts.flushAlertDeliveries()
  assert.ok(alert)
  assert.equal((await alerts.listOutbox({})).length, 0)
  assert.equal((await alerts.outboxStats()).sentCount, 0)
})
