import test from 'node:test'
import assert from 'node:assert/strict'

// 服务器上那一份（v0.9.128）：档案里的哈希是封存那一刻记的，盘上的文件后来可能被截断、覆盖或换掉。
// 这组只测两条纯规则（不碰磁盘）：
//   1) packageIntegrity 把「丢了 / 大小变了 / 内容被换过 / 只能比大小 / 对得上」分开判；
//   2) 作品页把结论说成人话，盘上不对劲时档案行只给一句红字，正常时不占地方。

const store = await import('../server/delivery-packages.mjs')
const domain = await import('../src/domain/project.ts')
const { packageIntegrity } = store
const { serverPackageText, packageDiskAlert } = domain

const sha = 'c'.repeat(64)
const record = { sha256: sha, bytes: 248643 }

test('盘上对得上：哈希与大小都一致才是 ok', () => {
  const check = packageIntegrity(record, { sha256: sha, bytes: 248643 })
  assert.equal(check.ok, true)
  assert.equal(check.state, 'ok')
})

test('大小没变但内容被换过：判 mismatch，不能说「对得上」', () => {
  const check = packageIntegrity(record, { sha256: 'd'.repeat(64), bytes: 248643 })
  assert.equal(check.ok, false)
  assert.equal(check.state, 'mismatch')
})

test('被截断了：判 resized，并让界面报差多少字节', () => {
  const check = packageIntegrity(record, { sha256: sha, bytes: 248000 })
  assert.equal(check.ok, false)
  assert.equal(check.state, 'resized')
  assert.match(serverPackageText({ ok: false, state: 'resized', checkedAt: '', expected: record, actual: { sha256: sha, bytes: 248000 } }), /差 643 B/)
})

test('盘上文件没了：判 missing，档案不算错', () => {
  const check = packageIntegrity(record, null)
  assert.equal(check.ok, false)
  assert.equal(check.state, 'missing')
  assert.match(serverPackageText({ ok: false, state: 'missing', checkedAt: '', expected: record, actual: null }), /档案还在/)
})

test('老包没记哈希：只比大小，如实说「只能比大小」，不冒充核对过内容', () => {
  const noSha = { sha256: '', bytes: 248643 }
  const same = packageIntegrity(noSha, { sha256: 'e'.repeat(64), bytes: 248643 })
  assert.equal(same.ok, true)
  assert.equal(same.state, 'unverifiable')
  assert.match(serverPackageText({ ok: true, state: 'unverifiable', checkedAt: '', expected: noSha, actual: { sha256: 'e'.repeat(64), bytes: 248643 } }), /只能比大小/)
  const cut = packageIntegrity(noSha, { sha256: 'e'.repeat(64), bytes: 100 })
  assert.equal(cut.state, 'resized')
})

test('哈希大小写不算错：档案里存大写也能对上', () => {
  const check = packageIntegrity({ sha256: sha.toUpperCase(), bytes: 10 }, { sha256: sha, bytes: 10 })
  assert.equal(check.ok, true)
  assert.equal(check.state, 'ok')
})

test('档案行提示：只在盘上不对劲时说话，正常时是空串', () => {
  assert.equal(packageDiskAlert(null), '')
  assert.equal(packageDiskAlert({ bytes: 10, sha256: sha, fileName: 'a.zip', savedAt: '' }), '')
  assert.equal(packageDiskAlert({ bytes: 10, sha256: sha, fileName: 'a.zip', savedAt: '', disk: { present: true, bytes: 10 } }), '')
  assert.equal(packageDiskAlert({ bytes: 10, sha256: sha, fileName: 'a.zip', savedAt: '', disk: { present: true, bytes: 9 } }), '服务器上大小变了')
  assert.equal(packageDiskAlert({ bytes: 10, sha256: sha, fileName: 'a.zip', savedAt: '', disk: { present: false, bytes: 0 } }), '服务器上包没了')
})
