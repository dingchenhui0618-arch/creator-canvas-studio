import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 「确认」是标记不是删除：ackAt / ackBy 落盘了，就得能按口径翻回来。
// 这组测试盯三件事：
//   1) 三个口径各回什么（未确认 / 已确认 / 全部），别的值一律按「未确认」；
//   2) 确认之后原始告警还在盘上，ackAt 与 ackBy 都留得住；
//   3) counts 里 open / acked / total 三个数彼此对得上，不靠页面自己减。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-alerts-status-'))
process.env.DATA_DIR = dir
delete process.env.VQ_ALERT_WEBHOOK

let seq = 0
async function freshAlerts() {
  seq += 1
  return import('../server/alerts.mjs?v=' + seq)
}

const ADMIN = 'admin@example.com'

test('三个口径各回什么：别的值一律按未确认，不把已确认的混进待办', async () => {
  const { parseAlertStatus } = await freshAlerts()
  assert.equal(parseAlertStatus('open'), 'open')
  assert.equal(parseAlertStatus('acked'), 'acked')
  assert.equal(parseAlertStatus('all'), 'all')
  assert.equal(parseAlertStatus(' acked '), 'acked')
  assert.equal(parseAlertStatus(''), 'open')
  assert.equal(parseAlertStatus(null), 'open')
  assert.equal(parseAlertStatus('OPEN'), 'open')
  assert.equal(parseAlertStatus('hacked'), 'open')
  assert.equal(parseAlertStatus('1'), 'open')
})

test('确认过的告警还在：未确认 1 条、已确认 1 条、全部 2 条，ackBy 留得住', async () => {
  fs.rmSync(path.join(dir, 'alerts.json'), { force: true })
  const { ackAlert, alertCounts, listAlerts, recordAlert } = await freshAlerts()

  const first = await recordAlert({ kind: 'server-5xx', level: 'error', title: '保存作品失败', detail: 'GET /api/works → 500', dedupeKey: 'works:500' })
  const second = await recordAlert({ kind: 'disk-low', level: 'warn', title: '数据盘剩余空间不足', detail: '剩余 1.20 GB' })
  assert.ok(first && second)

  const acked = await ackAlert(second.id, ADMIN)
  assert.ok(acked.ackAt)
  assert.equal(acked.ackBy, ADMIN)

  const open = await listAlerts({ status: 'open' })
  assert.deepEqual(open.map((item) => item.id), [first.id])

  const done = await listAlerts({ status: 'acked' })
  assert.deepEqual(done.map((item) => item.id), [second.id])
  assert.equal(done[0].ackBy, ADMIN)
  assert.ok(Date.parse(done[0].ackAt) > 0)

  const all = await listAlerts({ status: 'all' })
  assert.equal(all.length, 2)

  const counts = await alertCounts()
  assert.deepEqual({ open: counts.open, acked: counts.acked, total: counts.total }, { open: 1, acked: 1, total: 2 })
  assert.equal(counts.byKind['server-5xx'], 1)
  assert.equal(counts.byKind['disk-low'], undefined)
})

test('重复确认只刷新时间，不会多出一条，也不会把已确认的退回未确认', async () => {
  fs.rmSync(path.join(dir, 'alerts.json'), { force: true })
  const { ackAlert, alertCounts, listAlerts, recordAlert } = await freshAlerts()

  const alert = await recordAlert({ kind: 'test', level: 'warn', title: '测试告警：后台链路正常' })
  const once = await ackAlert(alert.id, ADMIN)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const twice = await ackAlert(alert.id, 'ops@example.com')

  assert.ok(Date.parse(twice.ackAt) >= Date.parse(once.ackAt))
  assert.equal(twice.ackBy, 'ops@example.com')
  const counts = await alertCounts()
  assert.deepEqual({ open: counts.open, acked: counts.acked, total: counts.total }, { open: 0, acked: 1, total: 1 })
  assert.equal((await listAlerts({ status: 'open' })).length, 0)
})

test('确认不存在的告警返回 null，不会凭空造一条', async () => {
  fs.rmSync(path.join(dir, 'alerts.json'), { force: true })
  const { ackAlert, alertCounts } = await freshAlerts()
  assert.equal(await ackAlert('alt_missing', ADMIN), null)
  const counts = await alertCounts()
  assert.equal(counts.total, 0)
})
