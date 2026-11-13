// 站点公示：备案号、运营主体、地址、客服邮箱、投诉渠道——对外必须写清楚的那几项。
//
// 设计取舍（与邮件通道 / 告警通道同一套）：
//   1) 能在后台填，不必改环境变量再重启：这些值会随主体、备案、客服邮箱变化，不该每次都发一版；
//   2) 环境变量 VQ_ICP / VQ_SUPPORT_EMAIL 仍然兜底，老部署一行不改也能显示；
//   3) 只存与展示，不编造：空就是空，页面不渲染空壳，也不写「待填」占位；
//   4) 每项都有长度上限、写入走临时文件 + rename、落盘 0600——不算机密，但也没必要让同机其他账号读。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
// 「统一社会信用代码」是 18 位大写字母与数字，不含 I / O / Z / S / V（国标排除易混字符），
// 这里只校验长度与字符集，不校验校验位：校验位算错说明抄错了，但拒绝保存会让人卡住。
const CREDIT_PATTERN = /^[0-9A-HJ-NPQRTUWXY]{18}$/

export const SITE_FIELDS = {
  icp: { label: 'ICP 备案号', max: 40, required: true, hint: '例如「沪ICP备2026000000号-1」，没有就不显示' },
  operator: { label: '运营主体全称', max: 80, required: true, hint: '公司或个体工商户全称，隐私说明里会原样展示' },
  address: { label: '联系地址', max: 120, required: false, hint: '注册地址或通讯地址，选填' },
  creditCode: { label: '统一社会信用代码', max: 18, required: false, hint: '18 位，选填' },
  supportEmail: { label: '客服邮箱', max: 190, required: true, hint: '登录页「忘记密码」、页脚与帮助中心都会用它' },
  complaint: { label: '投诉与举报渠道', max: 120, required: false, hint: '邮箱、电话或页面地址，选填' },
}

export const SITE_FIELD_KEYS = Object.keys(SITE_FIELDS)

export function siteFile() {
  return path.join(config.dataDir, 'site.json')
}

const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** 校验一份待保存的公示信息；错误给后台表单直接显示。 */
export function validateSiteInfo(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const value = {
    icp: cleanText(source.icp, SITE_FIELDS.icp.max),
    operator: cleanText(source.operator, SITE_FIELDS.operator.max),
    address: cleanText(source.address, SITE_FIELDS.address.max),
    // 信用代码按大写存：用户抄的时候常带小写与空格，展示时统一成国标样子
    creditCode: cleanText(source.creditCode, SITE_FIELDS.creditCode.max).replace(/\s+/g, '').toUpperCase(),
    supportEmail: cleanText(source.supportEmail, SITE_FIELDS.supportEmail.max),
    complaint: cleanText(source.complaint, SITE_FIELDS.complaint.max),
  }
  if (value.creditCode && !CREDIT_PATTERN.test(value.creditCode)) {
    return { ok: false, error: '统一社会信用代码要 18 位大写字母或数字（选填，留空也可以）' }
  }
  if (value.supportEmail && !EMAIL_PATTERN.test(value.supportEmail)) {
    return { ok: false, error: '客服邮箱不是合法邮箱地址' }
  }
  if (!value.icp && !value.operator && !value.supportEmail && !value.address && !value.creditCode && !value.complaint) {
    return { ok: false, error: '六项都空着没有必要保存：要清空请用「清空后台填写」' }
  }
  return { ok: true, value }
}

function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object') return null
  const value = {}
  let has = false
  for (const key of SITE_FIELD_KEYS) {
    const text = cleanText(raw[key], SITE_FIELDS[key].max)
    value[key] = text
    if (text) has = true
  }
  if (!has) return null
  return {
    ...value,
    updatedAt: String(raw.updatedAt || ''),
    updatedBy: String(raw.updatedBy || ''),
  }
}

export async function readSiteInfo() {
  try {
    return normalizeStored(JSON.parse(await fsp.readFile(siteFile(), 'utf8')))
  } catch {
    return null
  }
}

async function persist(saved) {
  const target = siteFile()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = target + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, target)
  await fsp.chmod(target, 0o600).catch(() => {})
}

/** 保存：整份覆盖（表单一次提交六项），不是逐项合并——避免「改了一项，另一项还是旧的」这种半份状态。 */
export async function saveSiteInfo(input = {}, { by = '' } = {}) {
  const checked = validateSiteInfo(input)
  if (!checked.ok) return { ok: false, error: checked.error }
  const saved = { ...checked.value, updatedAt: new Date().toISOString(), updatedBy: String(by || '').slice(0, 120) }
  await persist(saved)
  return { ok: true, site: saved }
}

export async function clearSiteInfo() {
  await fsp.rm(siteFile(), { force: true })
}

/**
 * 生效中的公示信息：后台填的优先，环境变量只兜底备案号与客服邮箱。
 * source 说明这些值从哪来：admin（后台）/ env（环境变量）/ none（没配）。
 */
export async function resolveSiteInfo() {
  const stored = await readSiteInfo()
  const env = config.site || {}
  const value = {
    icp: stored?.icp || String(env.icp || '').trim(),
    operator: stored?.operator || '',
    address: stored?.address || '',
    creditCode: stored?.creditCode || '',
    supportEmail: stored?.supportEmail || String(env.supportEmail || '').trim(),
    complaint: stored?.complaint || '',
  }
  const source = stored ? 'admin' : value.icp || value.supportEmail ? 'env' : 'none'
  // 对外公开必需的三项：备案号、主体全称、客服邮箱。地址与信用代码是加分项，不影响「能否公开运营」的判断。
  const missing = SITE_FIELD_KEYS.filter((key) => SITE_FIELDS[key].required && !value[key]).map((key) => SITE_FIELDS[key].label)
  return {
    ...value,
    source,
    // complete 只用在「上线就绪」判断上，页面不拿它决定显示什么
    complete: missing.length === 0,
    missing,
    updatedAt: stored?.updatedAt || '',
    updatedBy: stored?.updatedBy || '',
  }
}

/** 公开视图：匿名接口与页脚用，去掉 updatedBy 这类后台痕迹。 */
export async function sitePublicView() {
  const site = await resolveSiteInfo()
  return {
    icp: site.icp,
    operator: site.operator,
    address: site.address,
    creditCode: site.creditCode,
    supportEmail: site.supportEmail,
    complaint: site.complaint,
    complete: site.complete,
  }
}
