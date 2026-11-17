import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// 短信通道的保存口径（与邮件通道同一套）：
//   1) AccessKeySecret 是凭证，接口只回「有没有」，落盘 0600；
//   2) AccessKeyId 留空 = 沿用已保存的，只改签名 / 模板时不该被逼重输密钥；
//   3) 真换了 AccessKeyId 又没给新密钥，当场报错，而不是保存成功、发码时才 401；
//   4) fake 通道不发真短信，只写 sms-outbox.json —— 给 E2E 用。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-smscfg-'))
process.env.DATA_DIR = dir

const smsConfig = await import('../server/sms-config.mjs')
const smsSend = await import('../server/sms-send.mjs')

const PHONE = '138' + '0000' + '0001'
const AT = String.fromCharCode(64)
const ADMIN_BY = 'admin' + AT + 'example.test'
const SECRET = 'SmsSecret-For-Test-Only-123456'
const KEY = 'LTAI-test-key-id-0001'

function clear() {
  fs.rmSync(path.join(dir, 'sms.json'), { force: true })
  fs.rmSync(path.join(dir, 'sms-outbox.json'), { force: true })
}

const aliyun = (patch = {}) => ({
  provider: 'aliyun',
  keyId: KEY,
  keySecret: SECRET,
  signName: 'VisionQA',
  templateCode: 'SMS_000000001',
  ...patch,
})

test('保存阿里云通道：密钥只落盘不回显，文件 0600', async () => {
  clear()
  const saved = await smsConfig.saveSms(aliyun(), { by: ADMIN_BY })
  assert.equal(saved.ok, true, saved.error)
  assert.equal(saved.secretKept, false)
  assert.equal(saved.sms.keySecret, SECRET, '落盘有密钥')
  const mode = fs.statSync(path.join(dir, 'sms.json')).mode & 0o777
  if (process.platform !== 'win32') assert.equal(mode, 0o600, '凭证文件必须是 0600')

  const view = await smsConfig.smsView()
  assert.equal(view.configured, true)
  assert.equal(view.provider, 'aliyun')
  assert.equal(view.hasSecret, true, '视图只说有没有密钥')
  assert.equal(view.keyIdMasked.includes(SECRET), false)
  assert.equal(view.keyIdMasked.startsWith('LTAI'), true, 'AccessKeyId 只留前 4 位')
  assert.equal(view.signName, 'VisionQA')
  assert.equal(view.templateCode, 'SMS_000000001')
  assert.equal(JSON.stringify(view).includes(SECRET), false, '视图里不能出现密钥原文')
})

test('AccessKeyId 留空 = 沿用已保存的密钥（只改签名不用重输）', async () => {
  clear()
  await smsConfig.saveSms(aliyun(), {})
  const second = await smsConfig.saveSms({ provider: 'aliyun', keyId: '', keySecret: '', signName: '瓦视觉', templateCode: 'SMS_000000002' }, {})
  assert.equal(second.ok, true, second.error)
  assert.equal(second.secretKept, true)
  assert.equal(second.sms.signName, '瓦视觉')
  assert.equal(second.sms.keyId, KEY, 'AccessKeyId 沿用上一次的')
  assert.equal(second.sms.keySecret, SECRET, '密钥不该被空值冲掉')
})

test('换了 AccessKeyId 又不填密钥：当场报错，不保存', async () => {
  clear()
  await smsConfig.saveSms(aliyun(), {})
  const before = fs.readFileSync(path.join(dir, 'sms.json'), 'utf8')
  const bad = await smsConfig.saveSms({ provider: 'aliyun', keyId: 'LTAI-another-key', keySecret: '', signName: 'VisionQA', templateCode: 'SMS_000000001' }, {})
  assert.equal(bad.ok, false)
  assert.match(bad.error, /重新填密钥/)
  assert.equal(fs.readFileSync(path.join(dir, 'sms.json'), 'utf8'), before, '校验失败不该动已保存的配置')
})

test('阿里云缺签名 / 模板 / 密钥：保存不了，也不会显示成「已配置」', async () => {
  clear()
  for (const patch of [{ signName: '' }, { templateCode: '' }, { keyId: '' }]) {
    const bad = await smsConfig.saveSms(aliyun(patch), {})
    assert.equal(bad.ok, false, JSON.stringify(patch) + ' 应该被拒')
  }
  const unknown = await smsConfig.saveSms(aliyun({ provider: 'tencent' }), {})
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /服务商/)
  assert.equal((await smsConfig.smsView()).configured, false)
})

test('fake 通道不需要密钥，也能显示成已配置', async () => {
  clear()
  const saved = await smsConfig.saveSms({ provider: 'fake', ttlMinutes: 5, codeLength: 6 }, {})
  assert.equal(saved.ok, true, saved.error)
  const view = await smsConfig.smsView()
  assert.equal(view.configured, true)
  assert.equal(view.provider, 'fake')
  assert.equal(view.ttlMinutes, 5)
  assert.equal(view.codeLength, 6)
})

test('号码归一与掩码：+86、空格、横杠都认，日志里只出现 138****xxxx', () => {
  assert.equal(smsConfig.normalizePhone('+86 ' + PHONE), PHONE, '+86 前缀要能剥掉')
  const dashed = PHONE.slice(0, 3) + '-' + PHONE.slice(3, 7) + '-' + PHONE.slice(7)
  assert.equal(smsConfig.normalizePhone(dashed), PHONE, '横杠要能去掉')
  assert.equal(smsConfig.isValidPhone(PHONE), true)
  assert.equal(smsConfig.isValidPhone('12345'), false)
  assert.equal(smsConfig.isValidPhone('128' + '0000' + '0001'), false, '第二位不能是 2')
  assert.equal(smsConfig.maskPhone(PHONE), PHONE.slice(0, 3) + '****' + PHONE.slice(7))
})

test('清掉通道：登录页的验证码入口随之消失', async () => {
  clear()
  await smsConfig.saveSms({ provider: 'fake' }, {})
  assert.equal(await smsConfig.smsConfigured(), true)
  await smsConfig.clearSms()
  assert.equal(await smsConfig.smsConfigured(), false)
  assert.equal(fs.existsSync(path.join(dir, 'sms.json')), false)
})

test('阿里云 RPC 签名：排序、编码、HMAC 都能手算对上', () => {
  const fixed = new Date('2026-11-17T08:00:00.000Z')
  const built = smsSend.buildSendSmsForm({
    keyId: KEY,
    keySecret: SECRET,
    signName: 'VisionQA',
    templateCode: 'SMS_000000001',
    phone: PHONE,
    code: '123456',
    now: fixed,
    nonce: 'fixed-nonce-0001',
  })
  assert.equal(built.params.Timestamp, '2026-11-17T08:00:00Z', '时间戳是 GMT 且不带毫秒')
  assert.equal(built.params.TemplateParam, '{"code":"123456"}')
  assert.equal(built.params.Action, 'SendSms')
  assert.equal(built.params.Version, '2017-05-25')
  assert.ok(built.params.Signature, '必须带签名')

  // 自己按文档重算一遍：排序后的 key=value 用 & 连接，再做 HMAC-SHA1(secret + '&')
  const unsigned = { ...built.params }
  delete unsigned.Signature
  const query = Object.keys(unsigned)
    .sort()
    .map((key) => smsSend.percentEncode(key) + '=' + smsSend.percentEncode(unsigned[key]))
    .join('&')
  assert.equal(query, built.query)
  const expected = crypto
    .createHmac('sha1', SECRET + '&')
    .update('POST&' + smsSend.percentEncode('/') + '&' + smsSend.percentEncode(query))
    .digest('base64')
  assert.equal(built.params.Signature, expected)
  assert.equal(smsSend.percentEncode('a b*c~d'), 'a%20b%2Ac~d', '空格 %20、星号 %2A、波浪号不编码')
})

test('假通道把码写进 outbox，真通道不落明文到数据目录', async () => {
  clear()
  const sent = await smsSend.sendSmsCode({ sms: { provider: 'fake' } }, { phone: PHONE, code: '654321' })
  assert.equal(sent.ok, true)
  const outbox = await smsSend.readFakeOutbox()
  assert.equal(outbox.length, 1)
  assert.equal(outbox[0].code, '654321')
  assert.equal(outbox[0].phone, PHONE)

  const unknown = await smsSend.sendSmsCode({ sms: { provider: 'nope' } }, { phone: PHONE, code: '111111' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /服务商/)
})

test('签名候选：主签名在前、去重去空、最多 4 个', () => {
  assert.deepEqual(
    smsSend.signCandidates(' 企业名赠 ', ['企业名', '', ' 企业名赠 ']),
    ['企业名赠', '企业名'],
    '主签名在前，空白项丢掉，重复项只留一个',
  )
  assert.deepEqual(smsSend.signCandidates('', ['A', 'B']), ['A', 'B'], '主签名为空时用候选')
  assert.deepEqual(smsSend.signCandidates('A', ['B', 'C', 'D', 'E']), ['A', 'B', 'C', 'D'], '最多试 4 个')
  assert.deepEqual(smsSend.signCandidates(undefined, 'notarray'), [])
})

test('只有签名相关的错误码才值得换个签名重试', () => {
  assert.equal(smsSend.isSignatureRejection('isv.SMS_SIGNATURE_ILLEGAL'), true)
  assert.equal(smsSend.isSignatureRejection('isv.SMS_SIGN_NOT_MATCH'), true)
  assert.equal(smsSend.isSignatureRejection('isv.BUSINESS_LIMIT_CONTROL'), false, '限流换签名也没用')
  assert.equal(smsSend.isSignatureRejection('isv.SMS_TEMPLATE_ILLEGAL'), false, '模板错了换签名也没用')
  assert.equal(smsSend.isSignatureRejection(''), false)
})

test('阿里云拒发时把错误码带回调用方，且响应里没有密钥', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ Code: 'isv.SMS_SIGNATURE_ILLEGAL', Message: '签名不合法' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  try {
    const channel = {
      sms: { provider: 'aliyun', keyId: KEY, keySecret: SECRET, signName: 'VisionQA', templateCode: 'SMS_000000001', templateParam: 'code', region: 'cn-hangzhou' },
    }
    const sent = await smsSend.sendSmsCode(channel, { phone: PHONE, code: '123456' })
    assert.equal(sent.ok, false)
    assert.equal(sent.errorCode, 'isv.SMS_SIGNATURE_ILLEGAL')
    assert.equal(smsSend.isSignatureRejection(sent.errorCode), true, '调用方据此决定换下一个签名')
    assert.match(sent.error, /签名不合法/)
    assert.equal(JSON.stringify(sent).includes(SECRET), false)
  } finally {
    globalThis.fetch = realFetch
  }
})
