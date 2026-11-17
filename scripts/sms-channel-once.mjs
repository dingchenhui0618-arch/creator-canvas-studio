// 一次性配好短信通道、并发一条真短信：读 .tmp-sms-channel.json（不提交、跑完自动删）。
//   { "keyId": "LTAI...", "keySecret": "...", "signName": "...", "templateCode": "SMS_...", "testPhone": "13xxxxxxxxx" }
// 运行：node --experimental-sqlite scripts/sms-channel-once.mjs .tmp-sms-channel.json
// 为什么要有这个脚本：生产配通道 / 发测试短信要走管理员会话，而管理员登录名是手机号；
// 在服务器本机直接调模块，就不用把凭据和手机号搬来搬去，也不用在命令里出现明文。
import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2] || '.tmp-sms-channel.json'
let payload = null
try {
  payload = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch {
  console.error('读不到配置：' + file)
  process.exit(1)
}

const { saveSms, smsView, smsForSending, isValidPhone, normalizePhone, maskPhone } = await import('../server/sms-config.mjs')
const { issueSmsCode } = await import('../server/sms-login.mjs')
const { sendSmsCode } = await import('../server/sms-send.mjs')

const saved = await saveSms(
  {
    provider: payload.provider || 'aliyun',
    keyId: payload.keyId,
    keySecret: payload.keySecret,
    signName: payload.signName,
    templateCode: payload.templateCode,
    templateParam: payload.templateParam || 'code',
    region: payload.region || 'cn-hangzhou',
    ttlMinutes: payload.ttlMinutes || 5,
    codeLength: payload.codeLength || 6,
    enabled: true,
  },
  { by: 'ops:sms-channel-once' },
)
if (!saved.ok) {
  console.error('保存失败：' + saved.error)
  process.exit(1)
}
const view = await smsView()
console.log('SAVED provider=' + view.provider + ' sign=' + view.signName + ' template=' + view.templateCode + ' key=' + view.keyIdMasked + ' secretKept=' + Boolean(saved.secretKept) + ' configured=' + view.configured)

const phone = normalizePhone(payload.testPhone || '')
if (!isValidPhone(phone)) {
  console.log('没有可用的测试号码，只保存通道，不发短信')
} else {
  const channel = await smsForSending()
  if (!channel) {
    console.log('通道不完整，没法发测试短信')
  } else {
    const issued = issueSmsCode(phone, { ttlMinutes: channel.sms.ttlMinutes, codeLength: channel.sms.codeLength })
    const started = Date.now()
    const sent = await sendSmsCode(channel, { phone, code: issued.code, timeoutMs: 15000 })
    console.log('TEST to=' + maskPhone(phone) + ' ok=' + sent.ok + ' ms=' + (sent.ok ? sent.ms : Date.now() - started) + (sent.ok ? ' requestId=' + (sent.requestId || '').slice(0, 12) + '…' : ' error=' + sent.error))
  }
}

// 密钥与号码只在这一次里用，跑完把这个文件删掉
try {
  fs.unlinkSync(path.resolve(file))
  console.log('已删除 ' + file)
} catch {
  console.log('没能删除 ' + file + '，请手工删掉')
}
