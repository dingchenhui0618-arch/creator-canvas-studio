// 签名名称有两种写法（控制台「关联签名」里带「赠」、模板列表里不带），
// 真发一条才知道哪个对：按候选逐个试，只有被阿里云按 isv.SMS_SIGN* 拒掉才换下一个。
//   node --experimental-sqlite scripts/sms-sign-fix-once.mjs [userId]
// 输出只打掩码：手机号、AccessKeyId、签名都只留前后缀。
import fs from 'node:fs'
import { config } from '../server/config.mjs'
import { readSms, saveSms, smsForSending, normalizePhone, isValidPhone, maskPhone, maskKeyId } from '../server/sms-config.mjs'
import { issueSmsCode } from '../server/sms-login.mjs'
import { sendSmsCode, signCandidates, isSignatureRejection } from '../server/sms-send.mjs'

const userId = process.argv[2] || 'usr_7s55Vz2pejJ_'
const current = await readSms()
if (!current) {
  console.error('还没有短信通道，先配好再来')
  process.exit(1)
}

function maskedSign(name) {
  const raw = String(name || '')
  if (raw.length <= 3) return raw[0] + '**'
  return raw.slice(0, 2) + '**' + raw.slice(-1) + '（' + raw.length + '字）'
}

const withoutGift = current.signName.replace(/赠$/, '')
const withGift = withoutGift + '赠'
const candidates = signCandidates(current.signName, [withoutGift, withGift])
console.log('候选签名：' + candidates.map(maskedSign).join(' / '))

if (!fs.existsSync(config.auth.dbFile)) {
  console.error('找不到 auth.db')
  process.exit(1)
}
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(config.auth.dbFile)
const row = db.prepare('SELECT login_name FROM users WHERE id = ?').get(userId)
db.close()
const phone = normalizePhone(row?.login_name || '')
if (!isValidPhone(phone)) {
  console.error('这个账号没有可用的登录手机号')
  process.exit(2)
}

let lastFailure = null
for (const signName of candidates) {
  const saved = await saveSms(
    {
      provider: current.provider,
      keyId: current.keyId,
      signName,
      templateCode: current.templateCode,
      templateParam: current.templateParam,
      region: current.region,
      ttlMinutes: current.ttlMinutes,
      codeLength: current.codeLength,
      enabled: true,
    },
    { by: 'ops:sms-sign-fix' },
  )
  if (!saved.ok) {
    console.error('保存失败：' + saved.error)
    process.exit(1)
  }
  const channel = await smsForSending()
  const issued = issueSmsCode(phone, { ttlMinutes: channel.sms.ttlMinutes, codeLength: channel.sms.codeLength })
  const started = Date.now()
  const sent = await sendSmsCode(channel, { phone, code: issued.code, timeoutMs: 15000 })
  console.log(
    '试发 ' + maskedSign(signName) + ' ok=' + Boolean(sent.ok) + ' to=' + maskPhone(phone) +
      ' ms=' + (Date.now() - started) +
      (sent.ok ? ' bizId=' + String(sent.bizId || '').slice(0, 14) + '…' : ' code=' + (sent.errorCode || '-') + ' ' + sent.error),
  )
  if (sent.ok) {
    console.log('SUCCESS sign=' + maskedSign(signName) + ' key=' + maskKeyId(channel.sms.keyId) + '（配置里已留这一个）')
    process.exit(0)
  }
  lastFailure = sent
  if (!isSignatureRejection(sent.errorCode)) break
}

console.error('都没发出去：' + (lastFailure?.errorCode || '-') + ' ' + (lastFailure?.error || ''))
process.exit(3)
