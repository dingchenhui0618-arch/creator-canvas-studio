import test from 'node:test'
import assert from 'node:assert/strict'

// 核对封存包（v0.9.127）：用户手里那个 zip 还是不是当初封存的那一份。
// 这组只测客户端规则：
//   1) SHA-256 的粘贴口径固定（大小写、空格不算错，位数不对就是空）；
//   2) 哈希与大小两个维度分开判，结论只给一句人话；
//   3) 算哈希走 Web Crypto，本机环境里也得能对上已知向量。

const domain = await import('../src/domain/project.ts')
const { checkPackageFile, normalizeSha256, packageShortSha, sha256HexOfBytes } = domain

const sha = 'a'.repeat(64)

test('SHA-256 粘贴口径：大小写与空格收成小写，位数不对返回空串', () => {
  assert.equal(normalizeSha256('  ' + sha.toUpperCase() + ' '), sha)
  assert.equal(normalizeSha256(sha.slice(1)), '')
  assert.equal(normalizeSha256(''), '')
  assert.equal(normalizeSha256('z'.repeat(64)), '')
  assert.equal(packageShortSha(sha.toUpperCase()), 'aaaaaaaaaaaa…')
  assert.equal(packageShortSha('short'), '')
})

test('核对：哈希与大小都对上才算同一个包', () => {
  const check = checkPackageFile({ sha256: sha, bytes: 248643 }, { sha256: sha, bytes: 248643 })
  assert.equal(check.ok, true)
  assert.equal(check.shaOk, true)
  assert.equal(check.sizeOk, true)
  assert.equal(check.sizeDelta, 0)
  assert.match(check.text, /一致/)
})

test('核对：改过一个字节的包必须判失败，并说清是哈希对不上', () => {
  const check = checkPackageFile({ sha256: sha, bytes: 248643 }, { sha256: 'b'.repeat(64), bytes: 248643 })
  assert.equal(check.ok, false)
  assert.equal(check.shaOk, false)
  assert.equal(check.sizeOk, true)
  assert.match(check.text, /不是这一版封存的包/)
})

test('核对：大小差多少字节要报出来，没说哈希却大小不符也算没对上', () => {
  const check = checkPackageFile({ sha256: sha, bytes: 248643 }, { sha256: sha, bytes: 238643 })
  assert.equal(check.ok, false)
  assert.equal(check.sizeOk, false)
  assert.equal(check.sizeDelta, -10000)
  assert.match(check.text, /10000 B/)
})

test('核对：老包没记哈希就直说核对不了，不假装通过；档案没记大小时不拦着核对', () => {
  const legacy = checkPackageFile({ bytes: 250142 }, { sha256: sha, bytes: 250142 })
  assert.equal(legacy.ok, false)
  assert.equal(legacy.shaOk, false)
  assert.equal(legacy.sizeOk, true)
  assert.match(legacy.text, /没记 SHA-256/)
  assert.equal(checkPackageFile({ sha256: sha, bytes: 0 }, { sha256: sha, bytes: 2048 }).ok, true)
  assert.equal(checkPackageFile(null, { sha256: sha, bytes: 1 }).ok, false)
})

test('核对：文件算不出哈希（空值）时给明确结论，不抛错', () => {
  const check = checkPackageFile({ sha256: sha, bytes: 10 }, { sha256: '', bytes: 10 })
  assert.equal(check.ok, false)
  assert.equal(check.shaOk, false)
  assert.match(check.text, /没算出/)
})

test('本机算 SHA-256：与标准向量一致（abc 与空串）', async () => {
  const abc = new TextEncoder().encode('abc')
  assert.equal(await sha256HexOfBytes(abc.buffer), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(await sha256HexOfBytes(new ArrayBuffer(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})
