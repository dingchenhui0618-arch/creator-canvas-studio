import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 上游余额这块只做三件事，所以测试也只盯这三件：
//   1) 换算与阈值判定对得上（quota ÷ quota_per_unit，低于阈值 = low）；
//   2) 访问令牌永远不出服务端——接口只回「有没有 + 末四位」；
//   3) New API 那条链路真能读出金额，401 时给的是「令牌或 New-Api-User」这种能照着修的话。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-balance-'))
process.env.DATA_DIR = dir

let seq = 0
async function fresh() {
  seq += 1
  return import('../server/upstream-balance.mjs?v=' + seq)
}

const realFetch = globalThis.fetch

test('quota 换算：500000 quota = 1 个货币单位，余额按四位小数留', async () => {
  const { quotaToAmount } = await fresh()
  assert.equal(quotaToAmount(500000, 500000), 1)
  assert.equal(quotaToAmount(250000, 500000), 0.5)
  // 真实量级：10,000,000 quota = ¥20
  assert.equal(quotaToAmount(10000000, 500000), 20)
  // 上游给不出 quota_per_unit 时不能瞎算
  assert.equal(quotaToAmount(123, 0), null)
  assert.equal(quotaToAmount('abc', 500000), null)
})

test('阈值判定：低于是 low，等于不算低，没核对过是 unknown', async () => {
  const { balanceState } = await fresh()
  assert.equal(balanceState(19.99, 20), 'low')
  assert.equal(balanceState(20, 20), 'ok')
  assert.equal(balanceState(0, 20), 'low')
  assert.equal(balanceState(null, 20), 'unknown')
  assert.equal(balanceState(12, undefined), 'ok')
})

test('令牌只回末四位：保存后视图里拿不到明文', async () => {
  fs.rmSync(path.join(dir, 'upstream-balance.json'), { force: true })
  const { saveBalanceChannel, maskToken } = await fresh()
  const token = 'abcdef1234567890'
  const saved = await saveBalanceChannel('geteapi', { accessToken: token, threshold: 30 }, { by: '[EMAIL:ADMIN]' })
  assert.equal(saved.ok, true)
  assert.equal(saved.channel.hasToken, true)
  assert.equal(saved.channel.tokenMask, maskToken(token))
  assert.ok(!saved.channel.tokenMask.includes(token.slice(0, 10)))
  assert.equal(JSON.stringify(saved).includes(token), false)

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'upstream-balance.json'), 'utf8'))
  assert.equal(onDisk.channels.geteapi.accessToken, token)
  // 文件是 0600，别的账号读不到
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'upstream-balance.json')).mode & 0o777, 0o600)
  }
})

test('令牌留空 = 沿用旧令牌；clearToken 才真的清掉', async () => {
  fs.rmSync(path.join(dir, 'upstream-balance.json'), { force: true })
  const { saveBalanceChannel, balanceView } = await fresh()
  await saveBalanceChannel('geteapi', { accessToken: 'keep-me-12345678' })
  const kept = await saveBalanceChannel('geteapi', { threshold: 15 })
  assert.equal(kept.ok, true)
  assert.equal(kept.tokenKept, true)
  assert.equal(kept.channel.hasToken, true)
  assert.equal(kept.channel.threshold, 15)

  const cleared = await saveBalanceChannel('geteapi', { clearToken: true })
  assert.equal(cleared.channel.hasToken, false)
  const view = await balanceView()
  assert.equal(view.channels.find((item) => item.id === 'geteapi').hasToken, false)
})

test('手动登记的余额带来源与时间，低于阈值就是 low', async () => {
  fs.rmSync(path.join(dir, 'upstream-balance.json'), { force: true })
  const { saveBalanceChannel } = await fresh()
  const saved = await saveBalanceChannel('seeapi', { manualAmount: 12.5, threshold: 20, currency: '¥' })
  assert.equal(saved.ok, true)
  assert.equal(saved.channel.amount, 12.5)
  assert.equal(saved.channel.source, 'manual')
  assert.equal(saved.channel.state, 'low')
  assert.ok(Date.parse(saved.channel.checkedAt) > 0)
  assert.equal(saved.channel.currency, '¥')

  const enough = await saveBalanceChannel('seeapi', { manualAmount: 99, threshold: 20, currency: '¥' })
  assert.equal(enough.channel.state, 'ok')

  // 负数与离谱数值直接拒，别把余额表写坏
  const bad = await saveBalanceChannel('seeapi', { manualAmount: -5 })
  assert.equal(bad.ok, false)
})

test('New API 余额真读一遍：quota ÷ quota_per_unit，带上 New-Api-User 头', async () => {
  fs.rmSync(path.join(dir, 'upstream-balance.json'), { force: true })
  const { saveBalanceChannel, checkBalanceChannel } = await fresh()
  await saveBalanceChannel('geteapi', { accessToken: 'token-abc', newApiUser: '42' }, { by: 'test' })

  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} })
    if (String(url).endsWith('/api/status')) {
      return new Response(JSON.stringify({ data: { quota_per_unit: 500000, custom_currency_symbol: '¥' } }), { status: 200 })
    }
    if (String(url).endsWith('/api/user/self')) {
      return new Response(JSON.stringify({ success: true, data: { id: 42, quota: 10000000, used_quota: 2500000 } }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  try {
    const result = await checkBalanceChannel('geteapi', { by: 'test' })
    assert.equal(result.ok, true)
    assert.equal(result.channel.amount, 20)
    assert.equal(result.channel.used, 5)
    assert.equal(result.channel.currency, '¥')
    assert.equal(result.channel.source, 'auto')
    assert.equal(result.channel.state, 'ok')
    const self = calls.find((call) => call.url.endsWith('/api/user/self'))
    assert.equal(self.headers['New-Api-User'], '42')
    assert.equal(self.headers.Authorization, 'Bearer token-abc')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('上游 401 时说人话：令牌失效或少了 New-Api-User，不把原始报错丢给管理员', async () => {
  fs.rmSync(path.join(dir, 'upstream-balance.json'), { force: true })
  const { saveBalanceChannel, checkBalanceChannel } = await fresh()
  await saveBalanceChannel('geteapi', { accessToken: 'bad-token' })
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/status')) {
      return new Response(JSON.stringify({ data: { quota_per_unit: 500000 } }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: false, message: '无权进行此操作' }), { status: 401 })
  }
  try {
    const result = await checkBalanceChannel('geteapi', { by: 'test' })
    assert.equal(result.ok, false)
    assert.match(result.error, /访问令牌被上游拒绝/)
    assert.match(result.error, /New-Api-User/)
    // 失败也要落盘：界面上要能看到「上次核对失败、原因是什么」，而不是悄悄回退成「没核对过」
    assert.equal(result.channel.state, 'unknown')
    assert.match(result.channel.error, /访问令牌/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('没有余额接口的渠道不做假自动核对：直接叫管理员手动登记', async () => {
  fs.rmSync(path.join(dir, 'upstream-balance.json'), { force: true })
  const { checkBalanceChannel } = await fresh()
  const result = await checkBalanceChannel('seeapi')
  assert.equal(result.ok, false)
  assert.match(result.error, /只能手动登记/)
})
