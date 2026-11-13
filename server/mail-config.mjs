// 邮件通道：找回密码要靠它发信。
// 设计取舍与告警通道一致：
//   - 口令是凭证，接口只回掩码，明文只落在数据目录（0600）；
//   - 后台配过优先，没配过读环境变量 VQ_SMTP_*，老部署不改也能用；
//   - 保存时口令留空表示「沿用旧口令」（只改端口 / 发件人时不用重输），换账号则必须重填。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { normalizeSmtp } from './mailer.mjs'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export const mailFile = () => path.join(config.dataDir, 'mail.json')

/** 账号里可能带 @（邮箱形式的登录名），也可能是纯 key；只留前 2 位与域名。 */
export function maskAccount(raw) {
  const value = String(raw || '')
  if (!value) return ''
  const at = value.indexOf('@')
  if (at > 0) return value.slice(0, 2) + '••••' + value.slice(at)
  return value.length <= 4 ? '••••' : value.slice(0, 2) + '••••'
}

export async function readMail() {
  try {
    const parsed = JSON.parse(await fsp.readFile(mailFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.host) return null
    return {
      host: String(parsed.host),
      port: Number(parsed.port) || 0,
      secure: parsed.secure === true,
      starttls: parsed.starttls !== false,
      user: String(parsed.user || ''),
      pass: String(parsed.pass || ''),
      fromName: String(parsed.fromName || ''),
      fromAddress: String(parsed.fromAddress || ''),
      enabled: parsed.enabled !== false,
      updatedAt: String(parsed.updatedAt || ''),
      updatedBy: String(parsed.updatedBy || ''),
    }
  } catch {
    return null
  }
}

async function persist(saved) {
  const target = mailFile()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = target + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, target)
  await fsp.chmod(target, 0o600).catch(() => {})
}

/** 校验一条待保存的配置；错误直接给后台表单显示。 */
export function validateMailConfig(input = {}) {
  let smtp
  try {
    smtp = normalizeSmtp(input)
  } catch (error) {
    return { ok: false, error: error.message }
  }
  const fromAddress = String(input?.fromAddress || smtp.user || '').trim()
  if (!fromAddress) return { ok: false, error: '发件地址不能为空（收件人看到的是它）' }
  if (!EMAIL_PATTERN.test(fromAddress)) return { ok: false, error: '发件地址不是合法邮箱' }
  if (fromAddress.length > 190) return { ok: false, error: '发件地址过长' }
  const fromName = String(input?.fromName || '').trim()
  if (fromName.length > 60) return { ok: false, error: '发件人名最多 60 个字' }
  return { ok: true, value: { ...smtp, fromName, fromAddress, enabled: input?.enabled !== false } }
}

/**
 * 保存通道。口令留空表示沿用旧口令；换账号（user 变了）又没填新口令就报错，
 * 免得保存成功、发信时才发现拿旧口令登不上。
 */
export async function saveMail(input = {}, { by = '' } = {}) {
  const previous = await readMail()
  const wantsPass = String(input?.pass || '')
  const user = String(input?.user || '').trim()
  const keepPass = !wantsPass && previous && previous.user === user ? previous.pass : ''
  if (!wantsPass && !keepPass && user) {
    return { ok: false, error: previous?.user && previous.user !== user ? '换了发信账号，要重新填口令' : '请填发信口令' }
  }
  const checked = validateMailConfig({ ...input, pass: wantsPass || keepPass })
  if (!checked.ok) return { ok: false, error: checked.error }
  const saved = {
    ...checked.value,
    pass: checked.value.pass || '',
    updatedAt: new Date().toISOString(),
    updatedBy: String(by || '').slice(0, 120),
  }
  await persist(saved)
  return { ok: true, mail: saved, passKept: !wantsPass && Boolean(keepPass) }
}

export async function clearMail() {
  await fsp.rm(mailFile(), { force: true })
}

function fromEnv() {
  const env = config.mail || {}
  if (!String(env.host || '').trim()) return null
  return {
    host: String(env.host).trim(),
    port: Number(env.port) || 0,
    secure: env.secure === true,
    starttls: env.starttls !== false,
    user: String(env.user || ''),
    pass: String(env.pass || ''),
    fromName: String(env.fromName || ''),
    fromAddress: String(env.fromAddress || env.user || ''),
    enabled: true,
    updatedAt: '',
    updatedBy: '',
  }
}

/** 生效中的邮件通道：后台配置优先，其次环境变量；两处都没有 = 没配（找回密码不可用）。 */
export async function resolveMail() {
  const saved = await readMail()
  if (saved?.host) return { source: 'admin', mail: saved }
  const env = fromEnv()
  if (env) return { source: 'env', mail: env }
  return { source: 'none', mail: null }
}

/** 对外安全视图：口令只给「有没有」，账号给掩码。 */
export async function mailView() {
  const resolved = await resolveMail()
  const saved = await readMail()
  const mail = resolved.mail
  const configured = Boolean(mail?.host) && mail.enabled !== false && Boolean(mail.fromAddress)
  return {
    configured,
    source: resolved.source,
    host: mail?.host || '',
    port: Number(mail?.port) || 0,
    secure: mail?.secure === true,
    starttls: mail ? mail.starttls !== false : true,
    accountMasked: maskAccount(mail?.user || ''),
    hasPassword: Boolean(mail?.pass),
    fromName: mail?.fromName || '',
    fromAddress: mail?.fromAddress || '',
    enabled: mail ? mail.enabled !== false : false,
    updatedAt: saved?.updatedAt || '',
    updatedBy: saved?.updatedBy || '',
    canEdit: resolved.source !== 'env',
  }
}

/** 发信时用的完整配置（含口令）；没配返回 null。 */
export async function smtpForSending() {
  const resolved = await resolveMail()
  const mail = resolved.mail
  if (!mail?.host || mail.enabled === false) return null
  return {
    smtp: { host: mail.host, port: mail.port, secure: mail.secure, starttls: mail.starttls, user: mail.user, pass: mail.pass },
    from: { name: mail.fromName, address: mail.fromAddress },
    source: resolved.source,
  }
}

export async function mailConfigured() {
  const view = await mailView()
  return view.configured
}
