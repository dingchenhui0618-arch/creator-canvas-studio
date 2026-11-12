import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKUP_CODE_COUNT,
  base32Decode,
  base32Encode,
  generateBackupCodes,
  generateSecret,
  hashBackupCode,
  matchBackupCode,
  hotp,
  normalizeCode,
  otpauthUrl,
  totp,
  verifyTotp,
} from '../server/totp.mjs'

// RFC 6238 附录 B 的种子：ASCII "12345678901234567890"
const SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

test('base32 编解码与 RFC 种子一致', () => {
  assert.equal(base32Encode(Buffer.from('12345678901234567890', 'ascii')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.equal(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString('ascii'), '12345678901234567890')
  assert.equal(base32Decode('gezd gnbv-gy3t qojq').length, 10, '小写与分隔符要被忽略')
  assert.equal(base32Decode('').length, 0)
})

test('RFC 6238 测试向量（SHA-1，取后 6 位）', () => {
  const cases = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ]
  for (const [at, expected] of cases) {
    assert.equal(hotp(SECRET, Math.floor(at / 30)), expected, 'at=' + at)
  }
})

test('TOTP 与 HOTP 同口径（按 30 秒取步长）', () => {
  assert.equal(totp(SECRET, 59 * 1000), '287082')
  assert.equal(totp(SECRET, 30 * 1000), '287082', '同一 30 秒窗口内（30–59s）不变')
  assert.equal(totp(SECRET, 61 * 1000), hotp(SECRET, 2))
  assert.notEqual(totp(SECRET, 61 * 1000), totp(SECRET, 59 * 1000), '跨窗口就换码')
})

test('验码允许前后一个步长，但同一步长不能重放', () => {
  const at = 1111111100 * 1000 // 步长 37037036 附近
  const current = totp(SECRET, at)
  assert.equal(verifyTotp(SECRET, current, { at }).ok, true)
  // 上一步长的码也算对（客户端时钟慢一点）
  const previous = hotp(SECRET, Math.floor(at / 30000) - 1)
  assert.equal(verifyTotp(SECRET, previous, { at }).ok, true)
  // 但已经用过的步长不允许再用
  const used = verifyTotp(SECRET, current, { at, lastCounter: Math.floor(at / 30000) })
  assert.equal(used.ok, false, '同一步长重放要被拒')
  // 隔了两个步长的码不算
  const stale = hotp(SECRET, Math.floor(at / 30000) - 5)
  assert.equal(verifyTotp(SECRET, stale, { at }).ok, false)
  // 位数不对 / 非数字直接拒
  assert.equal(verifyTotp(SECRET, '12345', { at }).ok, false)
  assert.equal(verifyTotp(SECRET, 'abcdef', { at }).ok, false)
})

test('normalizeCode 只留数字', () => {
  assert.equal(normalizeCode(' 123 456 '), '123456')
  assert.equal(normalizeCode('12-34-56'), '123456')
})

test('生成的 secret 是 32 位 base32，每次不同', () => {
  const a = generateSecret()
  const b = generateSecret()
  assert.match(a, /^[A-Z2-7]{32}$/)
  assert.notEqual(a, b)
  assert.equal(base32Decode(a).length, 20)
})

test('otpauth 链接带 issuer / secret / 参数', () => {
  const url = otpauthUrl({ issuer: 'VisionQA', account: 'ops@example.com', secret: 'ABC234' })
  assert.match(url, /^otpauth:\/\/totp\/VisionQA%3Aops%40example\.com\?/)
  assert.match(url, /secret=ABC234/)
  assert.match(url, /issuer=VisionQA/)
  assert.match(url, /digits=6/)
  assert.match(url, /period=30/)
})

test('备用码：10 枚、格式统一、只存哈希、用过即失效', () => {
  const codes = generateBackupCodes()
  assert.equal(codes.length, BACKUP_CODE_COUNT)
  for (const code of codes) assert.match(code, /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/)
  const stored = codes.map((code) => ({ hash: hashBackupCode(code), usedAt: null }))
  const hit = matchBackupCode(stored, codes[3].toLowerCase().replace('-', ' '))
  assert.equal(hit.ok, true, '大小写与分隔符不影响')
  assert.equal(hit.remaining.filter((item) => !item.usedAt).length, BACKUP_CODE_COUNT - 1)
  const reuse = matchBackupCode(hit.remaining, codes[3])
  assert.equal(reuse.ok, false, '同一枚备用码不能再用')
  assert.equal(matchBackupCode(stored, 'AAAAA-BBBBB').ok, false)
})
