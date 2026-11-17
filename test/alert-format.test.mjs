import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// 告警载荷适配盯的是「配了机器人地址却没人收到」这件事：
//   1) 飞书 / 钉钉 / 企业微信 / Slack 各要各的 JSON，通用载荷填进去会被拒；
//   2) 这三家会用 HTTP 200 回业务错误码，只看状态码就会把失败记成「已发出」；
//   3) 认不出就当通用 webhook，自建接收端一个字都不用改。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-alert-format-'))
process.env.DATA_DIR = dir
delete process.env.VQ_ALERT_WEBHOOK

const fmt = await import('../server/alert-format.mjs')
const channel = await import('../server/alert-channel.mjs')
const { config } = await import('../server/config.mjs')

const FEISHU = 'https://open.feishu.cn/open-apis/bot/v2/hook/1111-2222'
const FEISHU_LARK = 'https://open.larksuite.com/open-apis/bot/v2/hook/1111-2222'
const DINGTALK = 'https://oapi.dingtalk.com/robot/send?access_token=abc123'
const WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123'
const SLACK = 'https://hooks.slack.com/services/T000/B000/xxxx'
const SELF = 'https://ops.example.com/hook/alert'

test('按地址认出是哪家机器人', () => {
  assert.equal(fmt.detectProvider(FEISHU), 'feishu')
  assert.equal(fmt.detectProvider(FEISHU_LARK), 'feishu')
  assert.equal(fmt.detectProvider(DINGTALK), 'dingtalk')
  assert.equal(fmt.detectProvider(WECOM), 'wecom')
  assert.equal(fmt.detectProvider(SLACK), 'slack')
  assert.equal(fmt.detectProvider(SELF), 'generic')
  // 认不出不能猜：猜成飞书就会往自建接收端发一个 {msg_type}，对方解析失败反而更难查
  assert.equal(fmt.detectProvider(''), 'generic')
  assert.equal(fmt.detectProvider('not a url'), 'generic')
  assert.equal(fmt.detectProvider('ftp://open.feishu.cn/open-apis/bot/v2/hook/x'), 'feishu')
})

test('每家一种载荷：文本消息只带那一句人读得到的告警', () => {
  const alert = { id: 'alt_1', kind: 'disk-low', level: 'warn', title: '数据盘剩余空间不足', detail: '剩余 0.8 GB', count: 2, lastAt: '2026-11-17T10:00:00.000Z' }
  const text = '[磁盘剩余不足] 数据盘剩余空间不足 · 剩余 0.8 GB（第 2 次，2026-11-17T10:00:00.000Z）'

  assert.deepEqual(fmt.buildPayload('feishu', { text, alert }), { msg_type: 'text', content: { text } })
  assert.deepEqual(fmt.buildPayload('dingtalk', { text, alert }), { msgtype: 'text', text: { content: text } })
  assert.deepEqual(fmt.buildPayload('wecom', { text, alert }), { msgtype: 'text', text: { content: text } })
  assert.deepEqual(fmt.buildPayload('slack', { text, alert }), { text })
  // 通用格式保持原样：已经在用的自建接收端不用跟着改
  assert.deepEqual(fmt.buildPayload('generic', { text, alert }), {
    text,
    alert: { id: 'alt_1', kind: 'disk-low', level: 'warn', title: '数据盘剩余空间不足', detail: '剩余 0.8 GB', count: 2, lastAt: '2026-11-17T10:00:00.000Z' },
    source: 'visionqa',
  })
  assert.equal(fmt.buildPayload('generic', { text, alert: null }).alert, null)
})

test('HTTP 200 不等于送到：飞书 / 钉钉 / 企微的业务码要单独看', () => {
  // 飞书：关键词不匹配是 code 19024，而 HTTP 还是 200
  assert.equal(fmt.readVerdict('feishu', 200, '{"code":0,"msg":"success"}').ok, true)
  assert.equal(fmt.readVerdict('feishu', 200, '{"StatusCode":0,"StatusMessage":"success"}').ok, true)
  const feishuBad = fmt.readVerdict('feishu', 200, '{"code":19024,"msg":"Key Words Not Found"}')
  assert.equal(feishuBad.ok, false)
  assert.match(feishuBad.error, /19024/)
  assert.match(feishuBad.error, /Key Words Not Found/)
  assert.equal(fmt.readVerdict('feishu', 200, '{"StatusCode":19021,"StatusMessage":"sign match fail"}').ok, false)
  // 正文里连 code 都没有：不能当成功
  assert.equal(fmt.readVerdict('feishu', 200, '{"hello":"world"}').ok, false)
  assert.equal(fmt.readVerdict('feishu', 200, 'not json').ok, false)

  assert.equal(fmt.readVerdict('dingtalk', 200, '{"errcode":0,"errmsg":"ok"}').ok, true)
  const dingBad = fmt.readVerdict('dingtalk', 200, '{"errcode":310000,"errmsg":"keywords not in content"}')
  assert.equal(dingBad.ok, false)
  assert.match(dingBad.error, /310000/)

  assert.equal(fmt.readVerdict('wecom', 200, '{"errcode":0,"errmsg":"ok"}').ok, true)
  assert.equal(fmt.readVerdict('wecom', 200, '{"errcode":93000,"errmsg":"invalid webhook key"}').ok, false)
  // 钉钉与企业微信同名不同家：报错要说是谁拒的
  assert.match(fmt.readVerdict('wecom', 200, '{"errcode":93000,"errmsg":"x"}').error, /企业微信/)
  assert.match(fmt.readVerdict('dingtalk', 200, '{"errcode":310000,"errmsg":"x"}').error, /钉钉/)

  // Slack 回的是纯文本 ok
  assert.equal(fmt.readVerdict('slack', 200, 'ok').ok, true)
  assert.equal(fmt.readVerdict('slack', 200, '{"ok":true}').ok, true)
  assert.equal(fmt.readVerdict('slack', 200, '{"ok":false,"error":"invalid_payload"}').ok, false)

  // 通用接收端只看状态码
  assert.equal(fmt.readVerdict('generic', 200, 'ok').ok, true)
  assert.equal(fmt.readVerdict('generic', 500, 'boom').ok, false)
  assert.match(fmt.readVerdict('generic', 404, '').error, /404/)
})

// ——— 真发一次：本地起一个假飞书 / 假钉钉，按它们的路径喂进来 ———
let seq = 0
async function freshAlerts() {
  seq += 1
  return import('../server/alerts.mjs?v=' + seq)
}

function clearFiles() {
  for (const name of ['alerts.json', 'alert-outbox.json']) fs.rmSync(path.join(dir, name), { force: true })
}

function fakeRobot(routePath, reply) {
  const capture = { hits: 0, raw: '', body: null }
  const server = http.createServer((req, res) => {
    capture.hits += 1
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      capture.raw = Buffer.concat(chunks).toString('utf8')
      try {
        capture.body = JSON.parse(capture.raw)
      } catch {
        capture.body = null
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, capture, url: 'http://127.0.0.1:' + server.address().port + routePath }))
  })
}

function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(resolve))
}

test('假飞书回了 200 + code 19024：不许记成已发出，要进重试队列', async () => {
  clearFiles()
  config.alerts.webhook = ''
  const { server, capture, url } = await fakeRobot('/open-apis/bot/v2/hook/zzz', { code: 19024, msg: 'Key Words Not Found' })
  await channel.saveChannel({ url })
  const alerts = await freshAlerts()
  try {
    const alert = await alerts.recordAlert({ kind: 'test', title: '飞书关键词不匹配', dedupeKey: 'feishu-code' })
    await alerts.flushAlertDeliveries()
    assert.equal(capture.hits, 1)
    // 发出去的必须是飞书格式
    assert.deepEqual(capture.body, { msg_type: 'text', content: { text: capture.body.content.text } })
    assert.match(capture.body.content.text, /^\[测试告警\] 飞书关键词不匹配/)
    assert.equal(alert.notify.ok, false)
    assert.equal(alert.notify.status, 200)
    assert.match(alert.notify.error, /19024/)
    const box = await alerts.outboxStats()
    assert.equal(box.sentCount, 0, '业务码失败不能算发出去')
    assert.equal(box.pending, 1, '失败的进队列，重启后还能补发')
    assert.match(box.lastAttempt.error, /Key Words Not Found/)
  } finally {
    await closeServer(server)
  }
})

test('假钉钉回 errcode 0：按钉钉格式发、算发出、成功计数 +1', async () => {
  clearFiles()
  config.alerts.webhook = ''
  const { server, capture, url } = await fakeRobot('/robot/send?access_token=abc', { errcode: 0, errmsg: 'ok' })
  await channel.saveChannel({ url })
  const alerts = await freshAlerts()
  try {
    const alert = await alerts.recordAlert({ kind: 'server-5xx', title: '接口 500 了三下', dedupeKey: 'ding-ok' })
    await alerts.flushAlertDeliveries()
    assert.equal(capture.hits, 1)
    assert.deepEqual(capture.body, { msgtype: 'text', text: { content: capture.body.text.content } })
    assert.equal(alert.notify.ok, true)
    assert.equal(alert.notify.providerLabel, '钉钉机器人')
    const box = await alerts.outboxStats()
    assert.equal(box.sentCount, 1)
    assert.equal(box.pending, 0)
    assert.equal(box.lastSentStatus, 200)
  } finally {
    await closeServer(server)
  }
})
