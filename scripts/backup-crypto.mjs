// 备份包的加解密（A2）。
// 为什么加密：整目录备份里必然带 model-keys.json 与 .model-keys.secret——
// 那把 secret 就是 Key 池的钥匙，备份文件一旦外流（异地副本、误传、云盘），
// 里面所有上游 Key 都是明文可解的。所以归档落地前统一用口令加密。
//
// 口令从 --passphrase-file 或环境变量读，绝不写进备份目录、也不写进状态文件；
// 状态文件里只留口令指纹（sha256 前 12 位），用来确认「这份备份是哪把口令加的」。
//
// 文件格式（VQBACK1）：
//   magic(8) | salt(16) | iv(12) | tag(16) | ciphertext
// 算法：scrypt(passphrase, salt, 32) → AES-256-GCM。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAGIC = Buffer.from('VQBACK1\n', 'utf8')
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

export function fingerprintOf(passphrase) {
  return crypto.createHash('sha256').update(String(passphrase)).digest('hex').slice(0, 12)
}

// 读口令：优先文件（权限应 0600/0640），其次环境变量。两者都没有时返回空串，由调用方决定是否允许明文。
export function readPassphrase({ file, env } = {}) {
  const fromFile = String(file || '').trim()
  if (fromFile) {
    try {
      const value = fs.readFileSync(fromFile, 'utf8').trim()
      return value ? { passphrase: value, source: 'file:' + path.basename(fromFile) } : { passphrase: '', source: '' }
    } catch (error) {
      throw new Error('读不到口令文件 ' + fromFile + '：' + String(error?.message || error))
    }
  }
  const fromEnv = String(env || '').trim()
  if (fromEnv) return { passphrase: fromEnv, source: 'env' }
  return { passphrase: '', source: '' }
}

export function encryptFile(source, dest, passphrase) {
  if (!passphrase) throw new Error('缺少加密口令')
  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  const input = fs.readFileSync(source)
  const body = Buffer.concat([cipher.update(input), cipher.final()])
  const tag = cipher.getAuthTag()
  const tmp = dest + '.tmp-' + process.pid
  fs.writeFileSync(tmp, Buffer.concat([MAGIC, salt, iv, tag, body]), { mode: 0o600 })
  fs.renameSync(tmp, dest)
  return { bytes: fs.statSync(dest).size, fingerprint: fingerprintOf(passphrase) }
}

// 解密到指定文件：先写临时文件再改名，解到一半失败不会留下半截「可恢复」的假备份。
export function decryptFile(source, dest, passphrase) {
  const input = fs.readFileSync(source)
  if (input.length < MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES) throw new Error('备份文件太小，不是有效的加密备份')
  if (!input.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是 VisionQA 加密备份（文件头不匹配）')
  let offset = MAGIC.length
  const salt = input.subarray(offset, (offset += SALT_BYTES))
  const iv = input.subarray(offset, (offset += IV_BYTES))
  const tag = input.subarray(offset, (offset += TAG_BYTES))
  const body = input.subarray(offset)
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(body), decipher.final()])
  const tmp = dest + '.tmp-' + process.pid
  fs.writeFileSync(tmp, plain, { mode: 0o600 })
  fs.renameSync(tmp, dest)
  return { bytes: plain.length }
}

export function isEncrypted(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(MAGIC.length)
    fs.readSync(fd, head, 0, MAGIC.length, 0)
    fs.closeSync(fd)
    return head.equals(MAGIC)
  } catch {
    return false
  }
}

export const BACKUP_MAGIC = MAGIC
