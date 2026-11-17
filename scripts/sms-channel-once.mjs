// 一次性配好短信通道、并发一条真短信：读 .tmp-sms-channel.json（不提交、跑完自动删）。
//   { "keyId": "LTAI...", "keySecret": "...", "signName": "...", "signNames": ["..."],
//     "templateCode": "SMS_...", "testPhone": "13xxxxxxxxx" }
// 运行：node --experimental-sqlite scripts/sms-channel-once.mjs .tmp-sms-channel.json
// 为什么要有这个脚本：生产配通道 / 发测试短信要走管理员会话，而管理员登录名是手机号；
// 在服务器本机直接调模块，就不用把凭据和手机号搬来搬去，也不用在命令里出现明文。
// 签名有两种写法在控制台里都出现过（「关联签名」里带「赠」、模板列表里不带），所以 signNames 可以给多个
// 候选：被阿里云按 isv.SMS_SIGN* 拒掉就换下一个，只有真发出去的那一个会留在配置里。
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
const { sendSmsCode, signCandidates, isSignatureRejection } = await import('../server/sms-send.mjs')

// 生产上若还是旧版 server/sms-send.mjs（没有 signCandidates），退回「只试一个签名」，别把命令跑挂
const candidates = typeof signCandidates === 'function'
  ? signCandidates(payload.signName, payload.signNames)
  : [payload.signName, ...(Array.isArray(payload.signNames) ? payload.signNames : [])].map((s) => String(s || '').trim()).filter(Boolean)
if (typeof signCandidates !== 'function') console.log('提示：这份 server/sms-send.mjs 还没有候选签名逻辑，只会试第一个签名')
if (!candidates.length) {
  console.error('没有可用的签名名称')
  process.exit(1)
}
const phone = normalizePhone(payload.testPhone || '')
const canSend = isValidPhone(phone)

/** 保存一次通道（密钥每轮都重写，配置里只留最后生效的那个签名）。 */
async function configure(signName) {
  const saved = await saveSms(
    {
      provider: payload.provider || 'aliyun',
      keyId: payload.keyId,
      keySecret: payload.keySecret,
      signName,
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
  console.log(
    'SAVED provider=' + view.provider + ' sign=' + view.signName + ' template=' + view.templateCode +
      ' key=' + view.keyIdMasked + ' secretKept=' + Boolean(saved.secretKept) + ' configured=' + view.configured,
  )
}

let ok = false
for (let i = 0; i < candidates.length; i += 1) {
  const signName = candidates[i]
  await configure(signName)
  if (!canSend) {
    ok = true
    break
  }
  const channel = await smsForSending()
  if (!channel) {
    console.log('通道不完整，没法发测试短信')
    break
  }
  const issued = issueSmsCode(phone, { ttlMinutes: channel.sms.ttlMinutes, codeLength: channel.sms.codeLength })
  const started = Date.now()
  const sent = await sendSmsCode(channel, { phone, code: issued.code, timeoutMs: 15000 })
  const ms = sent.ok ? sent.ms : sent.ms || Date.now() - started
  if (sent.ok) {
    console.log('TEST to=' + maskPhone(phone) + ' sign=' + signName + ' ok=true ms=' + ms + ' requestId=' + String(sent.requestId || '').slice(0, 12) + '…')
    ok = true
    break
  }
  console.log(
    'TEST to=' + maskPhone(phone) + ' sign=' + signName + ' ok=false ms=' + ms +
      ' code=' + (sent.errorCode || '-') + ' error=' + sent.error,
  )
  if (!isSignatureRejection(sent.errorCode)) break
  if (i + 1 < candidates.length) console.log('阿里云说签名不合法，换下一个候选：' + candidates[i + 1])
}

// 密钥与号码只在这一次里用，跑完把这个文件删掉
try {
  fs.unlinkSync(path.resolve(file))
  console.log('已删除 ' + file)
} catch {
  console.log('没能删除 ' + file + '，请手工删掉')
}
if (canSend && !ok) process.exitCode = 2
