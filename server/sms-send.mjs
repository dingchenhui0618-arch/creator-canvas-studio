// 发短信：把「码」交给服务商。同一份配置支持两条路：
//   - aliyun：阿里云短信 SendSms（RPC 签名 HMAC-SHA1，官方文档口径）；
//   - fake：本地假通道，不发真短信，只把码写进数据目录的 sms-outbox.json —— 给 E2E 与本地开发用。
// 失败要能说清是哪一步：返回 {ok:false, error} 而不是抛一个没有上下文的异常。
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'

const ALIYUN_ENDPOINT = 'https://dysmsapi.aliyuncs.com/'
const ALIYUN_VERSION = '2017-05-25'

/** 阿里云把「签名不对」都归在 isv.SMS_SIGN* 下：换一个候选签名重试可能就通了。 */
export function isSignatureRejection(errorCode) {
  return /^isv\.SMS_SIGN/i.test(String(errorCode || ''))
}

/** 候选签名：主签名在前，去空白去重，最多试 4 个（控制台里同一个赠送签名可能带「赠」也可能不带）。 */
export function signCandidates(primary, more = []) {
  const list = [primary, ...(Array.isArray(more) ? more : [])]
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const value = String(raw || '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= 4) break
  }
  return out
}

/** 阿里云 RPC 签名要求的百分号编码：空格是 %20，星号是 %2A，波浪号不编码。 */
export function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
    .replace(/\+/g, '%20')
}

/** 待签名的 query：参数名按字典序排，值各自编码。 */
export function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => percentEncode(key) + '=' + percentEncode(params[key]))
    .join('&')
}

/** stringToSign = POST & %2F & 编码后的 query（阿里云 RPC 签名的固定形状）。 */
export function stringToSign(query) {
  return 'POST&' + percentEncode('/') + '&' + percentEncode(query)
}

export function signQuery(query, accessKeySecret) {
  return crypto.createHmac('sha1', String(accessKeySecret) + '&').update(stringToSign(query)).digest('base64')
}

/**
 * 组装一次 SendSms 的完整表单。
 * 时间戳走 GMT，nonce 每次随机——重放窗口里同一 nonce 会被阿里云拒。
 */
export function buildSendSmsForm({ keyId, keySecret, signName, templateCode, templateParam = 'code', phone, code, region = 'cn-hangzhou', now = new Date(), nonce = crypto.randomBytes(16).toString('hex') }) {
  const params = {
    AccessKeyId: keyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: region,
    SignName: signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ [templateParam]: String(code) }),
    Timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: ALIYUN_VERSION,
  }
  const query = canonicalQuery(params)
  return { params: { ...params, Signature: signQuery(query, keySecret) }, query }
}

/** 阿里云：走真实 SendSms。 */
async function sendViaAliyun(sms, { phone, code, timeoutMs = 15000 }) {
  const { params } = buildSendSmsForm({
    keyId: sms.keyId,
    keySecret: sms.keySecret,
    signName: sms.signName,
    templateCode: sms.templateCode,
    templateParam: sms.templateParam,
    phone,
    code,
    region: sms.region,
  })
  const body = new URLSearchParams(params).toString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(ALIYUN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    })
    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    const code2 = String(payload?.Code || '')
    if (!response.ok || code2 !== 'OK') {
      const detail = payload ? code2 + (payload.Message ? '：' + payload.Message : '') : 'HTTP ' + response.status + ' ' + text.slice(0, 200)
      return { ok: false, error: '阿里云没受理：' + detail, errorCode: code2, status: response.status, ms: Date.now() - started }
    }
    return { ok: true, requestId: String(payload?.BizId || payload?.RequestId || ''), ms: Date.now() - started }
  } catch (error) {
    const message = error?.name === 'AbortError' ? '阿里云发短信超时（' + timeoutMs + ' ms）' : String(error?.message || error)
    return { ok: false, error: message, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** 假通道：把码写进数据目录，E2E 从这里取。 */
async function sendViaFake(_sms, { phone, code }) {
  const started = Date.now()
  const file = path.join(config.dataDir, 'sms-outbox.json')
  let list = []
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (Array.isArray(parsed)) list = parsed
  } catch {
    list = []
  }
  list.push({ at: new Date().toISOString(), phone, code })
  // 只留最近 50 条：这是调试用的假收件箱，不是审计日志
  list = list.slice(-50)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, file)
  return { ok: true, requestId: 'fake-' + crypto.randomBytes(4).toString('hex'), ms: Date.now() - started }
}

/** 统一入口：按配置里的 provider 分发。 */
export async function sendSmsCode(channel, { phone, code, timeoutMs } = {}) {
  const sms = channel?.sms
  if (!sms?.provider) return { ok: false, error: '短信通道没配置' }
  if (sms.provider === 'aliyun') return sendViaAliyun(sms, { phone, code, timeoutMs })
  if (sms.provider === 'fake') return sendViaFake(sms, { phone, code })
  return { ok: false, error: '不认识的短信服务商：' + sms.provider }
}

/** 假收件箱（只有 fake 通道会写）：后台「最近发出的码」与 E2E 都用它。 */
export async function readFakeOutbox() {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(config.dataDir, 'sms-outbox.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
