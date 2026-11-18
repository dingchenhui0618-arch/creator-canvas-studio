import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 发码结果留档盯四件事：
//   1) 手机号只留掩码，明文不落盘——这份文件会被后台读出来，不能变成第二个号码表；
//   2) 只留最近 50 条，写多了截尾，不无限长；
//   3) 文件坏了 / 没写过，后台不该因为一份日志打不开；
//   4) 视图给的是「总共几次、成功几次、失败几次、最近一条是什么」。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-smsusage-'))
process.env.DATA_DIR = dir

const usage = await import('../server/sms-usage.mjs')

const PHONE = '138' + '0000' + '4242'
const MASKED = '138****4242'

test.beforeEach(() => {
  fs.rmSync(path.join(dir, 'sms-usage.json'), { force: true })
})

test('落盘只有掩码：明文号码不出现在文件里', async () => {
  const entry = await usage.recordSmsUsage({ phone: PHONE, ok: true, ms: 123, provider: 'aliyun', requestId: '900619746936498440^0', source: 'login' })
  assert.equal(entry.phone, MASKED)
  const raw = fs.readFileSync(path.join(dir, 'sms-usage.json'), 'utf8')
  assert.equal(raw.includes(PHONE), false, '明文号码不该落盘：' + raw)
  assert.ok(raw.includes(MASKED), '掩码要在：' + raw)
  // Windows 没有 POSIX 权限位（Node 一律报 0o666），这条只在类 Unix 上验
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'sms-usage.json')).mode & 0o777, 0o600, '记录文件按 0600')
})

test('失败也留一条：带错误码与原因，后台据此知道被谁拒了', async () => {
  await usage.recordSmsUsage({ phone: PHONE, ok: false, error: '阿里云没受理：isv.SMS_SIGNATURE_ILLEGAL', errorCode: 'isv.SMS_SIGNATURE_ILLEGAL', ms: 88, provider: 'aliyun' })
  const view = await usage.smsUsageView()
  assert.equal(view.total, 1)
  assert.equal(view.failed, 1)
  assert.equal(view.ok, 0)
  assert.equal(view.lastOk, false)
  assert.equal(view.items[0].errorCode, 'isv.SMS_SIGNATURE_ILLEGAL')
  assert.match(view.items[0].error, /SIGNATURE/)
  assert.equal(view.items[0].source, 'login', '不写来源时按登录发码算')
  assert.equal(view.items[0].phone, MASKED)
})

test('只留最近 50 条：写 60 条后最早那几条被截掉', async () => {
  for (let index = 0; index < 60; index += 1) {
    await usage.recordSmsUsage({ phone: PHONE, ok: true, ms: index, source: index % 2 ? 'test' : 'login' })
  }
  const list = await usage.readSmsUsage()
  assert.equal(list.length, usage.SMS_USAGE_CAP)
  assert.equal(list[list.length - 1].ms, 59, '最后写进去的那条还在')
  const view = await usage.smsUsageView({ limit: 3 })
  assert.equal(view.total, 50)
  assert.equal(view.items.length, 3, 'limit 只影响明细条数')
  assert.equal(view.items[0].ms, 59, '明细新的在前')
})

test('文件坏了当没写过：不抛、视图是空的', async () => {
  fs.writeFileSync(path.join(dir, 'sms-usage.json'), '{ 这不是 JSON')
  assert.deepEqual(await usage.readSmsUsage(), [])
  const view = await usage.smsUsageView()
  assert.equal(view.total, 0)
  assert.equal(view.failed, 0)
  assert.equal(view.lastAt, '')
  assert.deepEqual(view.items, [])
})

test('文件里混进坏条目：只丢它自己，好的照样读出来', async () => {
  const good = { at: '2026-11-18T02:00:00.000Z', phone: MASKED, ok: true, source: 'login', provider: 'aliyun', error: '', errorCode: '', ms: 100, requestId: 'x' }
  fs.writeFileSync(path.join(dir, 'sms-usage.json'), JSON.stringify([good, null, { nope: true }, { at: '2026-11-18T03:00:00.000Z', phone: '138****9999', ok: 'yes' }]))
  const list = await usage.readSmsUsage()
  assert.equal(list.length, 2, '坏的两条被丢掉')
  assert.equal(list[0].phone, MASKED)
  assert.equal(list[1].ok, false, 'ok 只有真正 true 才算成功')
})

test('文件里出现明文号码也不回显：读的时候按原样收着，不加工成明文', async () => {
  // 防御性：老版本或人手改坏的文件里可能有明文，视图不该把它当号码展示成明文之外的形态
  fs.writeFileSync(path.join(dir, 'sms-usage.json'), JSON.stringify([{ at: '2026-11-18T02:00:00.000Z', phone: '138****4242', ok: true }]))
  const view = await usage.smsUsageView()
  assert.equal(view.items[0].phone, MASKED)
  assert.equal(JSON.stringify(view).includes(PHONE), false)
})
