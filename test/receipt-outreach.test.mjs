import test from 'node:test'
import assert from 'node:assert/strict'

// 给收包人的那段话（v0.9.143）：把收据里的差别写成能直接发出去的两三句。
// 只把收据上真实记着的东西说回去；不编原因、不承诺；对得上时一个字都不写。
const { receiptOutreach } = await import('../src/domain/project.ts')

const NAME = 'VisionQA-毛衣折叠收纳法 · 第三版-20261115-交付包.zip'

const checks = (over = {}) => [
  { k: 'version', want: 'v4', got: over.versionGot || 'v4', ok: over.versionOk !== false },
  { k: 'package', want: NAME, got: over.packageGot || NAME, ok: over.packageOk !== false },
  { k: 'bytes', want: '277725', got: over.bytesGot || '277725', ok: over.bytesOk !== false },
  { k: 'sha256', want: 'debb04…353a', got: over.shaGot === undefined ? 'debb04…353a' : over.shaGot, ok: over.shaOk !== false },
  { k: 'verdict', want: '都对得上', got: over.verdictGot || '都对得上', ok: over.verdictOk !== false },
]

const receipt = (state, over = {}) => ({
  at: '2026-11-15T02:00:00.000Z',
  state,
  summary: '一句话',
  via: 'link',
  claimed: { chip: over.chip || '都对得上' },
  ...(over.checks === null ? {} : { checks: over.checks || checks(over) }),
})

test('对得上、没贴过：没有要说的', () => {
  assert.equal(receiptOutreach(null), '')
  assert.equal(receiptOutreach({ at: '', state: 'match', summary: '', checks: checks() }), '')
})

test('他读不出来：说清读不出来，并给出重验那一步', () => {
  const text = receiptOutreach(receipt('broken', { checks: null }))
  assert.ok(text.includes('读不出来'), text)
  assert.ok(text.includes('「校验.html」'), text)
  assert.ok(text.includes('重发一份'), text)
})

test('包对上、结论不一样：照他写的结论说回去，不叫他去重下包', () => {
  const text = receiptOutreach(receipt('conflict', { verdictOk: false, verdictGot: '有问题', chip: '有问题' }))
  assert.ok(text.includes('「有问题」'), text)
  assert.ok(text.includes('重贴一张'), text)
  assert.ok(!text.includes('重下一份'), text)
})

test('版次不对：两边的版次都写出来，再请他重下', () => {
  const text = receiptOutreach(receipt('mismatch', { versionOk: false, versionGot: 'v3' }))
  assert.ok(text.includes('v3'), text)
  assert.ok(text.includes('v4'), text)
  assert.ok(text.includes('重下一份'), text)
})

test('包名不对：两边的包名都写出来', () => {
  const text = receiptOutreach(receipt('mismatch', { packageOk: false, packageGot: '旧的-交付包.zip' }))
  assert.ok(text.includes('旧的-交付包.zip'), text)
  assert.ok(text.includes(NAME), text)
})

test('字节不对：两个字节数都补上千分位', () => {
  const text = receiptOutreach(receipt('mismatch', { bytesOk: false, bytesGot: '250142', shaOk: false, shaGot: 'ffffff…ffff' }))
  assert.ok(text.includes('250,142 B'), text)
  assert.ok(text.includes('277,725 B'), text)
  assert.ok(text.includes('没传全'), text)
})

test('只有哈希不对：两边的头尾都贴出来，并说清别重压', () => {
  const text = receiptOutreach(receipt('mismatch', { shaOk: false, shaGot: 'aaaaaa…aaaa' }))
  assert.ok(text.includes('aaaaaa…aaaa'), text)
  assert.ok(text.includes('debb04…353a'), text)
  assert.ok(text.includes('重新压过'), text)
})

test('哈希空着：说没算出来，不写成「换了一串」', () => {
  const text = receiptOutreach(receipt('mismatch', { shaOk: false, shaGot: '' }))
  assert.ok(text.includes('没有整包 SHA-256'), text)
  assert.ok(!text.includes('重新压过'), text)
  assert.ok(text.includes('「校验.html」'), text)
})

test('没带逐项：明说看不出差在哪，请他重新导一张', () => {
  const text = receiptOutreach(receipt('mismatch', { checks: [] }))
  assert.ok(text.includes('没带逐项'), text)
  assert.ok(text.includes('「校验.html」'), text)
})

test('每一段都能直接发出去：收尾是句号、不超过 300 字、不出现占位符', () => {
  const cases = [
    receipt('broken', { checks: null }),
    receipt('conflict', { verdictOk: false, chip: '有问题' }),
    receipt('mismatch', { versionOk: false, versionGot: 'v3' }),
    receipt('mismatch', { packageOk: false, packageGot: '旧的-交付包.zip' }),
    receipt('mismatch', { bytesOk: false, bytesGot: '250142' }),
    receipt('mismatch', { shaOk: false, shaGot: 'aaaaaa…aaaa' }),
    receipt('mismatch', { shaOk: false, shaGot: '' }),
    receipt('mismatch', { checks: [] }),
  ]
  for (const entry of cases) {
    const text = receiptOutreach(entry)
    assert.ok(text.length > 20 && text.length <= 300, text.length + '：' + text)
    assert.ok(text.endsWith('。'), text)
    assert.ok(!/undefined|null|NaN|\{.*\}/.test(text), text)
    assert.ok(text.includes('收据'), '每段都该说回收据：' + text)
  }
})
