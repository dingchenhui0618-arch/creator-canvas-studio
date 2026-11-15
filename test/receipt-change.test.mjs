import test from 'node:test'
import assert from 'node:assert/strict'

// 又贴了一次（v0.9.141）：同一条交付上前前后后贴过几次，这一组盯「和上一次比变了哪一项」。
// 只比两边都记了的项；上一次读不出来时明说比不了，不把「没记」当成「对得上」；
// 一次贴过的没有「上一次」，返回 null，界面不会多出一行。
const { receiptChangeOf } = await import('../src/domain/project.ts')

const SHA_OK = 'debb047096f8cf518ae593fdd8ffe706933c74651313d0e4506fe02b011d353a'
const SHA_BAD = 'f'.repeat(64)
const NAME = 'VisionQA-毛衣折叠收纳法 · 第三版-20261115-交付包.zip'

const checks = (over) => [
  { k: 'version', want: 'v4', got: 'v4', ok: true },
  { k: 'package', want: NAME, got: NAME, ok: true },
  { k: 'bytes', want: '277725', got: over.bytesGot || '277725', ok: over.bytesOk !== false },
  { k: 'sha256', want: 'debb04…353a', got: over.shaGot || 'debb04…353a', ok: over.shaOk !== false },
  { k: 'verdict', want: '都对得上', got: over.verdictGot || '都对得上', ok: over.verdictOk !== false },
]

const claimed = (over = {}) => ({
  at: '2026-11-14 23:29',
  kind: '交付包',
  title: '毛衣折叠收纳法 · 第三版',
  version: over.version === undefined ? 4 : over.version,
  bytes: over.bytes === undefined ? 277725 : over.bytes,
  sha256: over.sha256 === undefined ? SHA_OK : over.sha256,
  packageName: over.packageName === undefined ? NAME : over.packageName,
  chip: '都对得上',
  summary: '',
})

const receipt = (state, over = {}) => ({
  at: over.at || '2026-11-14T23:29:36.393Z',
  state,
  summary: over.summary || '一句话',
  via: over.via || 'link',
  ...(over.checks === null ? {} : { checks: over.checks || checks(over) }),
  ...(over.claimed === null ? {} : { claimed: over.claimed || claimed(over) }),
})

test('只贴过一次：没有「上一次」，不生成那一行', () => {
  assert.equal(receiptChangeOf(null), null)
  assert.equal(receiptChangeOf([]), null)
  assert.equal(receiptChangeOf([receipt('match')]), null)
})

test('哈希从对不上变成对得上：说清哪一项、结论怎么变、收据上换成了哪一串', () => {
  const change = receiptChangeOf([
    receipt('mismatch', { shaOk: false, shaGot: 'ffffff…ffff', sha256: SHA_BAD, summary: '哈希对不上' }),
    receipt('match'),
  ])
  assert.deepEqual(change.items, [{ label: '整包 SHA-256', before: false, after: true }])
  assert.equal(change.tone, 'better')
  assert.equal(
    change.text,
    '和上一次比：整包 SHA-256 从对不上变成对得上。结论从「对不上」变成「对得上」。' +
      '收据上写的变了：整包 SHA-256 从 ffffff…ffff 换成 debb04…353a。',
  )
})

test('反过来了：字节与哈希两项从对得上变成对不上，语气跟着转坏', () => {
  const change = receiptChangeOf([
    receipt('match'),
    receipt('mismatch', { bytesOk: false, bytesGot: '123', bytes: 123, shaOk: false, shaGot: 'ffffff…ffff', sha256: SHA_BAD }),
  ])
  assert.deepEqual(change.items, [
    { label: '字节', before: true, after: false },
    { label: '整包 SHA-256', before: true, after: false },
  ])
  assert.equal(change.tone, 'worse')
  assert.equal(
    change.text,
    '和上一次比：字节、整包 SHA-256 这 2 项从对得上变成对不上。结论从「对得上」变成「对不上」。' +
      '收据上写的变了：字节从 277,725 B 换成 123 B、整包 SHA-256 从 debb04…353a 换成 ffffff…ffff。',
  )
})

test('同一张又贴一遍：每一项都没变，结论照旧', () => {
  const one = receipt('mismatch', { shaOk: false, shaGot: 'ffffff…ffff', sha256: SHA_BAD })
  const change = receiptChangeOf([one, { ...one, at: '2026-11-14T23:40:00.000Z' }])
  assert.deepEqual(change.items, [])
  assert.equal(change.tone, 'flat')
  assert.equal(change.text, '和上一次比：每一项都没变，结论还是「对不上」。')
})

test('上一次读不出来：明说比不了，不把没记的项当成对得上', () => {
  const change = receiptChangeOf([
    receipt('broken', { checks: null, claimed: null, summary: '对方读不出来' }),
    receipt('match'),
  ])
  assert.equal(change.tone, 'unknown')
  assert.equal(change.text, '和上一次比：上一次那张读不出来，比不了哪一项变了。')
})

test('哈希对上但结论打架 → 对得上：只变「对方结论」这一项', () => {
  const change = receiptChangeOf([
    receipt('conflict', { verdictOk: false, verdictGot: '有问题' }),
    receipt('match'),
  ])
  assert.deepEqual(change.items, [{ label: '对方结论', before: false, after: true }])
  assert.equal(change.tone, 'better')
  assert.equal(change.text, '和上一次比：对方结论 从对不上变成对得上。结论从「说法打架」变成「对得上」。')
})

test('老收据只剩一项：只比两边都记了的那一项，缺的不算变了', () => {
  const change = receiptChangeOf([
    { at: '2026-11-14T20:00:00.000Z', state: 'mismatch', checks: [{ k: 'sha256', want: 'debb04…353a', got: 'ffffff…ffff', ok: false }] },
    { at: '2026-11-14T21:00:00.000Z', state: 'match', checks: checks({}) },
  ])
  assert.deepEqual(change.items, [{ label: '整包 SHA-256', before: false, after: true }])
  assert.equal(change.text, '和上一次比：整包 SHA-256 从对不上变成对得上。结论从「对不上」变成「对得上」。')
})
