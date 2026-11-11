// 画布信任票据：VisionQA 是唯一身份源，画布企业服务用同一把共享密钥校验这张短时 JWT，
// 换出自己的会话与影子用户。只有「换会话」这一个用途，时效默认 120 秒，不落库、不可复用。
// 没配共享密钥时整体关闭（fail-closed）：画布继续走它自己的登录，不会误开一个免登录入口。
import crypto from 'node:crypto'
import { config } from './config.mjs'

function b64(value) {
  return Buffer.from(value).toString('base64url')
}

function hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url')
}

export function canvasTrustEnabled() {
  return Boolean(config.canvas.sharedSecret)
}

/**
 * 签发一张画布票据。
 * 只带「是谁」和「多久内有效」，不带积分、权限位等业务数据——那些仍由画布按影子用户自己算。
 */
export function mintCanvasTicket(user, options = {}) {
  const secret = config.canvas.sharedSecret
  if (!secret) throw Object.assign(new Error('画布账号互通未开启'), { code: 'CANVAS_TRUST_DISABLED', status: 503 })
  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.max(30, Math.min(600, Number(options.ttlSec || config.canvas.ttlSec)))
  const payload = {
    iss: config.canvas.issuer,
    aud: config.canvas.audience,
    sub: String(user.id),
    email: String(user.email || ''),
    name: String(user.name || ''),
    role: user.kind === 'admin' ? 'admin' : 'member',
    iat: now,
    exp: now + ttl,
    jti: crypto.randomBytes(12).toString('base64url'),
  }
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64(JSON.stringify(payload))
  const data = head + '.' + body
  return {
    token: data + '.' + hmac(data, secret),
    expiresAt: payload.exp * 1000,
    issuer: payload.iss,
    audience: payload.aud,
  }
}

/**
 * 校验票据（服务端自检与画布侧同款算法）。
 * 返回 { ok, payload, code }；过期、签名不符、受众不对都算失败，不做任何宽松兜底。
 */
export function verifyCanvasTicket(token, options = {}) {
  const secret = options.secret || config.canvas.sharedSecret
  if (!secret) return { ok: false, code: 'CANVAS_TRUST_DISABLED' }
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return { ok: false, code: 'MALFORMED' }
  const [head, body, mac] = parts
  const expected = hmac(head + '.' + body, secret)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: 'BAD_SIGNATURE' }
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, code: 'BAD_PAYLOAD' }
  }
  if (payload.iss !== config.canvas.issuer) return { ok: false, code: 'BAD_ISSUER' }
  if (payload.aud !== config.canvas.audience) return { ok: false, code: 'BAD_AUDIENCE' }
  if (!payload.exp || payload.exp * 1000 <= Date.now()) return { ok: false, code: 'EXPIRED' }
  return { ok: true, payload }
}
