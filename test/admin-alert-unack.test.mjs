import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 确认是双向的：点错了要能撤回，撤回不能变成删除。
// 这组测试盯五件事：
//   1) 撤回把 ackAt / ackBy 清空、另记 unackAt / unackBy，counts 从已确认回到未确认；
//   2) 没确认过的不能「撤回」（not-acked），不存在的告警是 not-found，两者分开报；
//   3) 撤回不动告警本身：id / 标题 / 次数 / 首次与最近时间一条不改，也不多一条；
//   4) 撤回后再确认，上一轮的撤回痕迹要清掉，界面只看到当前状态；
//   5) 连续撤回第二次是 not-acked，不会把时间戳越改越新。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-alerts-unack-'))
process.env.DATA_DIR = dir
delete process.env.VQ_ALERT_WEBHOOK

let seq = 0
async function freshAlerts() {
  seq += 1
  return import('../server/alerts.mjs?v=' + seq)
}

const ADMIN = 'admin@visionqa.test'
const OPS = 'ops@visionqa.test'

test('撤回把确认退回去：ackAt/ackBy 清空，unackAt/unackBy 记下来，计数回到未确认', async () => {
  fs.rmSync(path.join(dir, 'alerts.json'), { force: true })
  const { ackAlert, alertCounts, listAlerts, recordAlert, unackAlert } = await freshAlerts()

  const alert = await recordAlert({ kind: 'server-5xx', level: 'error', title: '保存作品失败', detail: 'POST /api/works → 500' })
  await ackAlert(alert.id, ADMIN)
  assert.equal((await alertCounts()).acked, 1)

  const undone = await unackAlert(alert.id, OPS)
  assert.equal(undone.ok, true)
  assert.equal(undone.alert.id, alert.id)
  assert.equal(undone.alert.ackAt, null)
  assert.equal(undone.alert.ackBy, '')
  assert.ok(Date.parse(undone.alert.unackAt) > 0)
  assert.equal(undone.alert.unackBy, OPS)

  const counts = await alertCounts()
  assert.deepEqual({ open: counts.open, acked: counts.acked, total: counts.total }, { open: 1, acked: 0, total: 1 })

  // 落盘的也是这个状态，不是只在内存里退回去
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'alerts.json'), 'utf8'))
  assert.ok(Array.isArray(onDisk))
  const saved = onDisk.find((item) => item.id === alert.id)
  assert.equal(saved.ackAt, null)
  assert.equal(saved.ackBy, '')
  assert.equal(saved.unackBy, OPS)
  assert.equal((await listAlerts({ status: 'open' })).length, 1)
  assert.equal((await listAlerts({ status: 'acked' })).length, 0)
})

test('没确认过的告警不能撤回：报 not-acked，且一个字段都不改', async () => {
  fs.rmSync(path.join(dir, 'alerts.json'), { force: true })
  const { alertCounts, listAlerts, recordAlert, unackAlert } = await freshAlerts()

  const alert = await recordAlert({ kind: 'disk-low', level: 'warn', title: '数据盘剩余空间不足' })
  const result = await unackAlert(alert.id, ADMIN)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-acked')
  assert.equal(result.alert.id, alert.id)

  const open = await listAlerts({ status: 'open' })
  assert.equal(open.length, 1)
  assert.equal(open[0].ackAt, null)
  assert.equal(open[0].unackAt, null)
  const counts = await alertCounts()
  assert.deepEqual({ open: counts.open, acked: counts.acked, total: counts.total }, { open: 1, acked: 0, total: 1 })
})

test('撤回不存在的告警是 not-found，不会凭空造一条', async () => {
  fs.rmSync(path.join(dir, 'alerts.json'), { force: true })
  const { alertCounts, unackAlert } = await freshAlerts()

  const result = await unackAlert('alt_missing', ADMIN)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-found')
  assert.equal(result.alert, undefined)
  assert.equal((await alertCounts()).total, 0)
})

test('撤回不动告警内容：次数、首次与最近时间、标题都不变，也不多一条', async () => {
  fs.rmSync(path.join(dir, 'alerts.json'), { force: true })
  const { ackAlert, alertCounts, listAlerts, recordAlert, unackAlert } = await freshAlerts()

  const alert = await recordAlert({ kind: 'model-blocked', level: 'error', title: '上游拒绝', detail: 'HTTP 402' })
  await ackAlert(alert.id, ADMIN)
  const undone = await unackAlert(alert.id, OPS)

  assert.equal(undone.alert.id, alert.id)
  assert.equal(undone.alert.title, '上游拒绝')
  assert.equal(undone.alert.detail, 'HTTP 402')
  assert.equal(undone.alert.kind, 'model-blocked')
  assert.equal(undone.alert.count, 1)
  assert.equal(undone.alert.firstAt, alert.firstAt)
  assert.equal(undone.alert.lastAt, alert.lastAt)
  assert.equal((await alertCounts()).total, 1)
  assert.equal((await listAlerts({ status: 'all' })).length, 1)
})

test('撤回后再确认：上一轮的撤回痕迹清掉，确认人是这一次的', async () => {
  fs.rmSync(path.join(dir, 'alerts.json'), { force: true })
  const { ackAlert, alertCounts, listAlerts, recordAlert, unackAlert } = await freshAlerts()

  const alert = await recordAlert({ kind: 'test', level: 'warn', title: '测试告警：后台链路正常' })
  await ackAlert(alert.id, ADMIN)
  await unackAlert(alert.id, OPS)
  const again = await ackAlert(alert.id, ADMIN)

  assert.ok(again.ackAt)
  assert.equal(again.ackBy, ADMIN)
  assert.equal(again.unackAt, null)
  assert.equal(again.unackBy, '')
  const counts = await alertCounts()
  assert.deepEqual({ open: counts.open, acked: counts.acked, total: counts.total }, { open: 0, acked: 1, total: 1 })

  const acked = await listAlerts({ status: 'acked' })
  assert.equal(acked.length, 1)
  assert.equal(acked[0].unackAt, null)
})

test('连续撤回第二次是 not-acked：不会把撤回时间越改越新', async () => {
  fs.rmSync(path.join(dir, 'alerts.json'), { force: true })
  const { ackAlert, recordAlert, unackAlert } = await freshAlerts()

  const alert = await recordAlert({ kind: 'test', level: 'warn', title: '测试告警：后台链路正常' })
  await ackAlert(alert.id, ADMIN)
  const first = await unackAlert(alert.id, OPS)
  const stamp = first.alert.unackAt
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await unackAlert(alert.id, ADMIN)

  assert.equal(second.ok, false)
  assert.equal(second.reason, 'not-acked')
  assert.equal(second.alert.unackAt, stamp)
  assert.equal(second.alert.unackBy, OPS)
})
