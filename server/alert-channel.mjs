// 外部告警通道：告警往哪儿推（飞书 / 钉钉 / Slack 机器人或自建 webhook）。
// 以前只能改服务器 .env 里的 VQ_ALERT_WEBHOOK 再重启；现在后台能直接配、能清掉。
// 设计取舍：
//   - 地址本身就是凭证（机器人 URL 里带 key），接口只回掩码，明文只写进数据目录；
//   - 后台配过就用后台的，没配过仍读环境变量——老部署不改也能继续用；
//   - 签名用 HMAC-SHA256（x-vq-signature），收到的人能验，飞书 / 钉钉会忽略这个头。
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import { config } from './config.mjs'

const MAX_URL_LENGTH = 500

export const channelFile = () => path.join(config.dataDir, 'alert-channel.json')

// 只留 origin 和末段前 4 位：够认出「是哪个群」，又不方便别人直接拿去用。
export function maskUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  try {
    const url = new URL(value)
    const segments = url.pathname.split('/').filter(Boolean)
    const tail = segments.pop() || ''
    const kept = tail.length > 6 ? tail.slice(0, 4) + '••••' : tail ? '••••' : ''
    const rest = [...segments, kept].filter(Boolean).join('/')
    return url.origin + '/' + rest + (url.search ? '?••••' : '')
  } catch {
    return '••••'
  }
}

// 只收 http(s)，且不接受把账号口令写进 URL 的形式（日志与掩码都兜不住）。
export function normalizeChannelUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return { ok: false, error: '地址不能为空' }
  if (value.length > MAX_URL_LENGTH) return { ok: false, error: '地址太长（上限 ' + MAX_URL_LENGTH + ' 个字符）' }
  let url
  try {
    url = new URL(value)
  } catch {
    return { ok: false, error: '不是合法地址，要带 http:// 或 https://' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: '只支持 http / https 地址' }
  if (url.username || url.password) return { ok: false, error: '不要把账号口令写进地址里' }
  return { ok: true, url: url.toString() }
}

export function maskSecret(raw) {
  const value = String(raw || '')
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return value.slice(0, 4) + '••••' + value.slice(-4)
}

function newSecret() {
  return crypto.randomBytes(32).toString('hex')
}

export async function readChannel() {
  try {
    const parsed = JSON.parse(await fsp.readFile(channelFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const url = String(parsed.url || '')
    if (!url) return null
    return {
      url,
      secret: String(parsed.secret || ''),
      enabled: parsed.enabled !== false,
      updatedAt: String(parsed.updatedAt || ''),
      updatedBy: String(parsed.updatedBy || ''),
    }
  } catch {
    return null
  }
}

async function persistChannel(channel) {
  const target = channelFile()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = target + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(channel, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, target)
  // rename 会保留旧文件权限，显式收紧一次：地址与密钥不能让同机其他账号读到。
  await fsp.chmod(target, 0o600).catch(() => {})
}

// 保存通道。给了 rotate 就换一把签名密钥；没给且从没有过，就顺手生成一把。
export async function saveChannel({ url, enabled = true, rotate = false, by = '' }) {
  const checked = normalizeChannelUrl(url)
  if (!checked.ok) return { ok: false, error: checked.error }
  const previous = await readChannel()
  const secret = rotate || !previous?.secret ? newSecret() : previous.secret
  const channel = {
    url: checked.url,
    secret,
    enabled: enabled !== false,
    updatedAt: new Date().toISOString(),
    updatedBy: String(by || '').slice(0, 120),
  }
  await persistChannel(channel)
  return { ok: true, channel, secretCreated: !previous?.secret || Boolean(rotate) }
}

export async function clearChannel() {
  await fsp.rm(channelFile(), { force: true })
}

// 生效中的通道：后台配过优先，其次环境变量；两处都没有就是「没配」。
export async function resolveChannel() {
  const saved = await readChannel()
  if (saved?.url) {
    return { source: 'admin', url: saved.url, secret: saved.secret || '', enabled: saved.enabled !== false, updatedAt: saved.updatedAt }
  }
  const envUrl = String(config.alerts.webhook || '').trim()
  if (envUrl) return { source: 'env', url: envUrl, secret: String(config.alerts.secret || ''), enabled: true, updatedAt: '' }
  return { source: 'none', url: '', secret: '', enabled: false, updatedAt: '' }
}

// 对外的安全视图：URL 与密钥都只给掩码。
export async function channelView() {
  const channel = await resolveChannel()
  const saved = await readChannel()
  return {
    configured: Boolean(channel.url) && channel.enabled,
    source: channel.source,
    urlMasked: maskUrl(channel.url),
    secretMasked: maskSecret(channel.secret),
    signed: Boolean(channel.secret),
    enabled: channel.enabled,
    updatedAt: saved?.updatedAt || '',
    updatedBy: saved?.updatedBy || '',
    canEdit: channel.source !== 'env',
  }
}

export function signBody(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(body).digest('hex')
}
