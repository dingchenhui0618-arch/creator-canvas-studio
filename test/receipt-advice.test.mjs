import test from 'node:test'
import assert from 'node:assert/strict'

// 对不上之后做什么（v0.9.142）：逐项说清差在哪之后，再给一句「这意味着什么、下一步做什么」。
// 五个分支各自只认能证明的那种差别；推不出来就说推不出来；
// 对得上时不出现——不拿一句话去打扰好消息。
const { receiptAdvice } = await import('../src/domain/project.ts')

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
  summary: over.summary || '一句话',
  via: 'link',
  ...(over.checks === null ? {} : { checks: over.checks || checks(over) }),
})

test('对得上、没贴过：都不给建议', () => {
  assert.equal(receiptAdvice(null), null)
  assert.equal(receiptAdvice({ at: '', state: 'match', summary: '', checks: checks() }), null)
})

test('他那边读不出来：让他用包里的校验页重导一张，并重发一份包', () => {
  const advice = receiptAdvice(receipt('broken', { checks: null, summary: '对方读不出来' }))
  assert.equal(advice.tone, 'bad')
  assert.equal(advice.title, '他没验成：包在他那边读不出来')
  assert.ok(advice.text.includes('「校验.html」'), advice.text)
  assert.ok(advice.text.includes('重发一份包'), advice.text)
})

test('包对得上、只是他写的结论不一样：用警示色，让他按逐项重贴', () => {
  const advice = receiptAdvice(receipt('conflict', { verdictOk: false, verdictGot: '有问题' }))
  assert.equal(advice.tone, 'warn')
  assert.equal(advice.title, '包对得上，只是他写的结论不一样')
  assert.ok(advice.text.includes('按逐项'), advice.text)
})

test('版次对不上：先确认他打开的是哪个文件，不说内容坏了', () => {
  const advice = receiptAdvice(receipt('mismatch', { versionOk: false, versionGot: 'v3' }))
  assert.equal(advice.tone, 'bad')
  assert.equal(advice.title, '他验的不是这一版的包')
  assert.ok(advice.text.includes('回执链接'), advice.text)
  assert.ok(!advice.text.includes('校验.html'), '这一种先别让他重验内容：' + advice.text)
})

test('包名对不上：同一条判断', () => {
  const advice = receiptAdvice(receipt('mismatch', { packageOk: false, packageGot: '别的包.zip' }))
  assert.equal(advice.title, '他验的不是这一版的包')
})

test('字节数不一样：说他手上那份不是这个文件，并给重发这一步', () => {
  const advice = receiptAdvice(receipt('mismatch', { bytesOk: false, bytesGot: '250142', shaOk: false, shaGot: 'ffffff…ffff' }))
  assert.equal(advice.title, '他手上那份不是这个文件')
  assert.ok(advice.text.includes('没传全'), advice.text)
  assert.ok(advice.text.includes('上面那个「交付包」'), advice.text)
})

test('名字与字节都对、只有哈希不同：字节一样，内容不一样', () => {
  const advice = receiptAdvice(receipt('mismatch', { shaOk: false, shaGot: 'aaaaaa…aaaa' }))
  assert.equal(advice.title, '字节一样，内容不一样')
  assert.ok(advice.text.includes('重新压过'), advice.text)
  assert.ok(advice.text.includes('「校验.html」'), advice.text)
})

test('收据上哈希是空的：说没算出来，不说成换了一串', () => {
  const advice = receiptAdvice(receipt('mismatch', { shaOk: false, shaGot: '' }))
  assert.equal(advice.title, '他那边没算出哈希')
  assert.ok(!advice.text.includes('重新压过'), advice.text)
})

test('这张没带逐项：明说看不出差在哪', () => {
  const advice = receiptAdvice({ at: '2026-11-15T02:00:00.000Z', state: 'mismatch', summary: '对不上', checks: [] })
  assert.equal(advice.title, '对不上，但看不出差在哪')
  assert.ok(advice.text.includes('「校验.html」'), advice.text)
})

test('老收据只剩结论这一项：不硬猜是哪一种', () => {
  const advice = receiptAdvice(receipt('mismatch', { checks: [{ k: 'verdict', want: '都对得上', got: '有问题', ok: false }] }))
  assert.equal(advice.title, '有几项对不上')
  assert.ok(advice.text.includes('看上面逐项'), advice.text)
})

test('每一句都收尾：标题、下一步都不空，句子以句号收住', () => {
  const cases = [
    receipt('broken', { checks: null }),
    receipt('conflict', { verdictOk: false }),
    receipt('mismatch', { versionOk: false }),
    receipt('mismatch', { bytesOk: false }),
    receipt('mismatch', { shaOk: false, shaGot: 'aaaaaa…aaaa' }),
    receipt('mismatch', { shaOk: false, shaGot: '' }),
    receipt('mismatch', { checks: [] }),
  ]
  for (const entry of cases) {
    const advice = receiptAdvice(entry)
    assert.ok(advice && advice.title && advice.text, JSON.stringify(advice))
    assert.ok(advice.tone === 'bad' || advice.tone === 'warn', advice.tone)
    assert.ok(advice.text.endsWith('。'), advice.text)
  }
})
