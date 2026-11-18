// 给指定账号的登录手机号真发一条验证码：手机号与通道都从服务端取，命令行和日志里都不出现明文。
//   node --experimental-sqlite scripts/sms-send-test-once.mjs [userId]
// 用途：生产配好短信通道后，不开浏览器、不把手机号贴进命令行，验证「真的发得出去」。
// 发出去的码同时写进登录用的短期记录（同 /api/auth/sms/send），所以收到后可以直接用它登录。
import { config } from '../server/config.mjs'
import { smsForSending, normalizePhone, isValidPhone, maskPhone, maskKeyId } from '../server/sms-config.mjs'
import { issueSmsCode } from '../server/sms-login.mjs'
import { sendSmsCode } from '../server/sms-send.mjs'

const userId = process.argv[2] || 'usr_7s55Vz2pejJ_'

if ((await import('node:fs')).existsSync(config.auth.dbFile) === false) {
  console.error('找不到 auth.db：' + config.auth.dbFile)
  process.exit(1)
}
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(config.auth.dbFile)
const row = db.prepare('SELECT login_name, name FROM users WHERE id = ?').get(userId)
db.close()
const phone = normalizePhone(row?.login_name || '')
if (!isValidPhone(phone)) {
  console.error('这个账号没有可用的登录手机号')
  process.exit(2)
}
const channel = await smsForSending()
if (!channel) {
  console.error('短信通道不完整或已停用，先在后台配好')
  process.exit(3)
}
const issued = issueSmsCode(phone, { ttlMinutes: channel.sms.ttlMinutes, codeLength: channel.sms.codeLength })
const started = Date.now()
const sent = await sendSmsCode(channel, { phone, code: issued.code, timeoutMs: 15000 })
console.log(
  'SEND ok=' + Boolean(sent.ok) + ' to=' + maskPhone(phone) + ' key=' + maskKeyId(channel.sms.keyId) +
    ' ttl=' + channel.sms.ttlMinutes + 'min ms=' + (Date.now() - started) +
    (sent.ok ? ' bizId=' + String(sent.bizId || '').slice(0, 14) + '…' : ' error=' + sent.error + ' code=' + (sent.errorCode || '')),
)
process.exit(sent.ok ? 0 : 4)
