// 短信登录整条链路（不发短信）：给指定账号的登录手机号发一枚码（只落库、不真发），
// 再用这个码调本机 /api/auth/sms/login，确认真的换到会话。
//   node --experimental-sqlite scripts/sms-login-e2e-once.mjs [userId]
// 这是「验证码登录能用」的最后一环：短信通道真发已在 sms-sign-fix-once 里验过，这里验兑换。
import { config } from '../server/config.mjs'
import { smsForSending, normalizePhone, isValidPhone, maskPhone } from '../server/sms-config.mjs'
import { issueSmsCode } from '../server/sms-login.mjs'

const userId = process.argv[2] || 'usr_7s55Vz2pejJ_'
const base = process.env.VQ_LOCAL_API || 'http://127.0.0.1:8799'
const channel = await smsForSending()
if (!channel) {
  console.error('短信通道不完整，先配好')
  process.exit(3)
}
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(config.auth.dbFile)
const row = db.prepare('SELECT id, name, login_name FROM users WHERE id = ?').get(userId)
db.close()
const phone = normalizePhone(row?.login_name || '')
if (!isValidPhone(phone)) {
  console.error('这个账号没有可用的登录手机号')
  process.exit(2)
}
const issued = issueSmsCode(phone, { ttlMinutes: channel.sms.ttlMinutes, codeLength: channel.sms.codeLength })
const response = await fetch(base + '/api/auth/sms/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone, code: issued.code }),
})
const text = await response.text()
let parsed = null
try { parsed = JSON.parse(text) } catch { parsed = null }
const cookie = response.headers.get('set-cookie') || ''
const who = parsed?.user?.id || parsed?.session?.user?.id || ''
console.log(
  'LOGIN status=' + response.status + ' phone=' + maskPhone(phone) + ' setCookie=' + (cookie.includes('vq_session=') ? 'yes' : 'no') +
    ' user=' + (who ? who.slice(0, 10) + '…' : '(none)') + ' match=' + String(who === userId) + ' body=' + text.slice(0, 120).replace(/"/g, "'"),
)
// 用完就把这枚码失效，别在库里留一个能用 5 分钟的凭证
try {
  const { consumeSmsCode } = await import('../server/sms-login.mjs')
  if (typeof consumeSmsCode === 'function') consumeSmsCode(phone)
} catch { /* 没有这个导出就算了，TTL 只有 5 分钟 */ }
process.exit(response.ok && who === userId ? 0 : 1)
