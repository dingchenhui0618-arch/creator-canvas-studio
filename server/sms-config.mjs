// 短信通道：手机号验证码登录靠它发码。
// 与邮件通道同一套口径：
//   - AccessKeySecret 是凭证，接口只回「有没有」，明文只落在数据目录（0600）；
//   - 后台配过优先，没配过读环境变量 VQ_SMS_*，老部署不改也能用；
//   - 保存时密钥留空表示「沿用旧密钥」（只改签名 / 模板时不用重输），换 AccessKeyId 则必须重填；
//   - provider=fake 是给本地和 E2E 用的假通道：不发真短信，把码写进数据目录的 sms-outbox.json。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { writeFileAtomic } from './atomic-write.mjs'

export const smsFile = () => path.join(config.dataDir, 'sms.json')

export const PROVIDERS = {
  aliyun: '阿里云短信',
  fake: '本地假通道（不发真短信，只写文件）',
}

const DEFAULT_CODE_LENGTH = 6
const DEFAULT_TTL_MINUTES = 5

/** 手机号归一：去掉空格、横杠、括号与前缀 +86；只要 11 位国内手机号。 */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '')
  const local = digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits
  return local
}

export function isValidPhone(raw) {
  return /^1[3-9]\d{9}$/.test(normalizePhone(raw))
}

/** 界面与日志只显示 138****0001，全文永不出现在响应里。 */
export function maskPhone(raw) {
  const phone = normalizePhone(raw)
  if (!isValidPhone(phone)) return ''
  return phone.slice(0, 3) + '****' + phone.slice(7)
}

/** AccessKeyId 也按凭证处理：只留前 4 位。 */
export function maskKeyId(raw) {
  const value = String(raw || '')
  if (!value) return ''
  return value.length <= 6 ? '••••' : value.slice(0, 4) + '••••' + value.slice(-2)
}

function clampInt(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(num)))
}

export async function readSms() {
  try {
    const parsed = JSON.parse(await fsp.readFile(smsFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.provider) return null
    return {
      provider: String(parsed.provider),
      keyId: String(parsed.keyId || ''),
      keySecret: String(parsed.keySecret || ''),
      signName: String(parsed.signName || ''),
      templateCode: String(parsed.templateCode || ''),
      templateParam: String(parsed.templateParam || 'code'),
      region: String(parsed.region || 'cn-hangzhou'),
      ttlMinutes: clampInt(parsed.ttlMinutes, DEFAULT_TTL_MINUTES, 1, 15),
      codeLength: clampInt(parsed.codeLength, DEFAULT_CODE_LENGTH, 4, 8),
      enabled: parsed.enabled !== false,
      updatedAt: String(parsed.updatedAt || ''),
      updatedBy: String(parsed.updatedBy || ''),
    }
  } catch {
    return null
  }
}

async function persist(saved) {
  const target = smsFile()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await writeFileAtomic(target, JSON.stringify(saved, null, 2))
  await fsp.chmod(target, 0o600).catch(() => {})
}

/** 校验一条待保存的配置；错误直接给后台表单显示。 */
export function validateSmsConfig(input = {}) {
  const provider = String(input?.provider || '').trim()
  if (!provider) return { ok: false, error: '请选择短信服务商' }
  if (!PROVIDERS[provider]) return { ok: false, error: '不认识的短信服务商' }
  const signName = String(input?.signName || '').trim()
  const templateCode = String(input?.templateCode || '').trim()
  const templateParam = String(input?.templateParam || 'code').trim() || 'code'
  if (signName.length > 32) return { ok: false, error: '签名名称最多 32 个字' }
  if (templateCode.length > 64) return { ok: false, error: '模板 CODE 过长' }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(templateParam)) return { ok: false, error: '模板变量名只能用字母数字下划线' }
  if (provider === 'aliyun') {
    if (!signName) return { ok: false, error: '阿里云短信必须填签名名称（如 VisionQA）' }
    if (!templateCode) return { ok: false, error: '阿里云短信必须填模板 CODE（SMS_ 开头）' }
    const keyId = String(input?.keyId || '').trim()
    if (!keyId) return { ok: false, error: '请填 AccessKey ID' }
    if (keyId.length > 64) return { ok: false, error: 'AccessKey ID 过长' }
  }
  return {
    ok: true,
    value: {
      provider,
      signName,
      templateCode,
      templateParam,
      region: String(input?.region || 'cn-hangzhou').trim() || 'cn-hangzhou',
      ttlMinutes: clampInt(input?.ttlMinutes, DEFAULT_TTL_MINUTES, 1, 15),
      codeLength: clampInt(input?.codeLength, DEFAULT_CODE_LENGTH, 4, 8),
      enabled: input?.enabled !== false,
    },
  }
}

/**
 * 保存通道。密钥留空表示沿用旧密钥；换了 AccessKeyId 又没填新密钥就报错，
 * 免得保存成功、发码时才发现 401。
 */
export async function saveSms(input = {}, { by = '' } = {}) {
  const previous = await readSms()
  const wantsSecret = String(input?.keySecret || '')
  const keyId = String(input?.keyId || '').trim() || (previous?.keyId || '')
  const keepSecret = !wantsSecret && previous && previous.keyId === keyId ? previous.keySecret : ''
  if (!wantsSecret && !keepSecret && keyId && String(input?.provider || previous?.provider) === 'aliyun') {
    return { ok: false, error: previous?.keyId && previous.keyId !== keyId ? '换了 AccessKey ID，要重新填密钥' : '请填 AccessKey Secret' }
  }
  const checked = validateSmsConfig({ ...input, keyId, keySecret: wantsSecret || keepSecret })
  if (!checked.ok) return { ok: false, error: checked.error }
  const saved = {
    ...checked.value,
    keyId,
    keySecret: wantsSecret || keepSecret,
    updatedAt: new Date().toISOString(),
    updatedBy: String(by || '').slice(0, 120),
  }
  await persist(saved)
  return { ok: true, sms: saved, secretKept: !wantsSecret && Boolean(keepSecret) }
}

export async function clearSms() {
  await fsp.rm(smsFile(), { force: true })
}

function fromEnv() {
  const env = config.sms || {}
  if (!String(env.provider || '').trim()) return null
  return {
    provider: String(env.provider).trim(),
    keyId: String(env.keyId || ''),
    keySecret: String(env.keySecret || ''),
    signName: String(env.signName || ''),
    templateCode: String(env.templateCode || ''),
    templateParam: String(env.templateParam || 'code'),
    region: String(env.region || 'cn-hangzhou'),
    ttlMinutes: clampInt(env.ttlMinutes, DEFAULT_TTL_MINUTES, 1, 15),
    codeLength: clampInt(env.codeLength, DEFAULT_CODE_LENGTH, 4, 8),
    enabled: true,
    updatedAt: '',
    updatedBy: '',
  }
}

/** 生效中的短信通道：后台配置优先，其次环境变量；两处都没有 = 没配（登录页不给验证码入口）。 */
export async function resolveSms() {
  const saved = await readSms()
  if (saved?.provider) return { source: 'admin', sms: saved }
  const env = fromEnv()
  if (env) return { source: 'env', sms: env }
  return { source: 'none', sms: null }
}

/** 对外安全视图：密钥只给「有没有」，AccessKeyId 与签名给掩码。 */
export async function smsView() {
  const resolved = await resolveSms()
  const saved = await readSms()
  const sms = resolved.sms
  const configured = Boolean(sms?.provider) && sms.enabled !== false && (sms.provider !== 'aliyun' || (Boolean(sms.keyId) && Boolean(sms.keySecret) && Boolean(sms.signName) && Boolean(sms.templateCode)))
  return {
    configured,
    provider: sms?.provider || '',
    providerLabel: PROVIDERS[sms?.provider || ''] || '',
    signName: sms?.signName || '',
    templateCode: sms?.templateCode || '',
    templateParam: sms?.templateParam || 'code',
    region: sms?.region || '',
    keyIdMasked: maskKeyId(sms?.keyId || ''),
    hasSecret: Boolean(sms?.keySecret),
    ttlMinutes: sms?.ttlMinutes || DEFAULT_TTL_MINUTES,
    codeLength: sms?.codeLength || DEFAULT_CODE_LENGTH,
    enabled: sms ? sms.enabled !== false : false,
    source: resolved.source,
    updatedAt: saved?.updatedAt || '',
    updatedBy: saved?.updatedBy || '',
    canEdit: resolved.source !== 'env',
    providers: Object.entries(PROVIDERS).map(([value, label]) => ({ value, label })),
  }
}

/** 发码时用的完整配置（含密钥）；没配或停用返回 null。 */
export async function smsForSending() {
  const resolved = await resolveSms()
  const sms = resolved.sms
  if (!sms?.provider || sms.enabled === false) return null
  if (sms.provider === 'aliyun' && !(sms.keyId && sms.keySecret && sms.signName && sms.templateCode)) return null
  return { sms, source: resolved.source }
}

export async function smsConfigured() {
  const view = await smsView()
  return view.configured
}
