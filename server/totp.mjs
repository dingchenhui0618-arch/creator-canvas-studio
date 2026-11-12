import crypto from 'node:crypto'

// TOTP（RFC 6238）+ 一次性备用码。不引第三方库：算法只有几十行，自己的实现能被单测钉住
// （RFC 附录 B 的测试向量见 test/totp.test.mjs）。
//
// 约定：SHA-1 / 30 秒 / 6 位，与 Google Authenticator、1Password、Authy 的默认口径一致；
// 验码允许前后各一个步长（±30 秒），并记录「最后用过的步长」，同一窗口不能重放。

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const DIGITS = 6
const STEP_SEC = 30
const WINDOW = 1

export function base32Encode(buffer) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text) {
  const clean = String(text || '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const bytes = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** 20 字节（160 bit）= 32 个 base32 字符，和主流认证器的默认长度一致。 */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes))
}

export function hotp(secret, counter, digits = DIGITS) {
  const key = base32Decode(secret)
  if (!key.length) throw new Error('TOTP secret 不是合法的 base32')
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buffer.writeUInt32BE(counter % 0x100000000, 4)
  const digest = crypto.createHmac('sha1', key).update(buffer).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(binary % 10 ** digits).padStart(digits, '0')
}

export const counterFor = (at = Date.now()) => Math.floor(at / 1000 / STEP_SEC)

export function totp(secret, at = Date.now()) {
  return hotp(secret, counterFor(at))
}

export function normalizeCode(input) {
  return String(input || '').replace(/\D/g, '')
}

/**
 * 验码：允许 ±WINDOW 个步长；lastCounter 用来防同窗口重放。
 * 返回 { ok, counter }，ok 时调用方应把 counter 存回去。
 */
export function verifyTotp(secret, token, { at = Date.now(), window = WINDOW, lastCounter = 0 } = {}) {
  const code = normalizeCode(token)
  if (code.length !== DIGITS) return { ok: false, counter: 0 }
  const current = counterFor(at)
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset
    if (counter <= 0 || counter <= lastCounter) continue
    const expected = hotp(secret, counter)
    // 定长比较，避免按字节提前返回看出差异
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return { ok: true, counter }
  }
  return { ok: false, counter: 0 }
}

/** otpauth:// 链接：认证器扫不了码时也能手输 secret。 */
export function otpauthUrl({ issuer = 'VisionQA', account = '', secret = '' } = {}) {
  const label = issuer + ':' + (account || 'account')
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SEC) })
  return 'otpauth://totp/' + encodeURIComponent(label) + '?' + query.toString()
}

// 备用码：去掉 0/O/1/I 这类看着一样的字符，10 位分两组；只在开启时显示一次
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export function generateBackupCodes(count = 10) {
  const codes = []
  for (let index = 0; index < count; index += 1) {
    let raw = ''
    for (let offset = 0; offset < 10; offset += 1) raw += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5))
  }
  return codes
}

export const normalizeBackupCode = (input) => String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '')

export function hashBackupCode(code) {
  return crypto.createHash('sha256').update('vq-totp:' + normalizeBackupCode(code)).digest('hex')
}

/** 备用码比对：哈希后定长比较，命中就返回剩余未用列表由调用方落库。 */
export function matchBackupCode(codes, input) {
  const normalized = normalizeBackupCode(input)
  if (normalized.length !== 10) return { ok: false, remaining: codes }
  const target = hashBackupCode(normalized)
  const index = (Array.isArray(codes) ? codes : []).findIndex((item) => item && !item.usedAt && item.hash === target)
  if (index < 0) return { ok: false, remaining: codes }
  const remaining = codes.map((item, position) => (position === index ? { ...item, usedAt: new Date().toISOString() } : item))
  return { ok: true, remaining }
}

export const BACKUP_CODE_COUNT = 10
export const TOTP_STEP_SEC = STEP_SEC
export const TOTP_DIGITS = DIGITS
