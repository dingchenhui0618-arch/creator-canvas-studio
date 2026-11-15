import test from 'node:test'
import assert from 'node:assert/strict'

// 换掉的那条旧地址还被点着：那句话怎么说（v0.9.149）。
// 两个数（几次、最近一次）都在记录里，这一层只负责把它说成发件人能照着做的一句话：
// 不报身份、不猜原因，只说「他手上可能还是旧的那条，把现在这条再发一次」。

const domain = await import('../src/domain/delivery-retired-hit.ts')

test('行上那句话：有次数才写，一次都没有就是空串', () => {
  assert.equal(domain.deliveryRetiredHitText(null), '')
  assert.equal(domain.deliveryRetiredHitText(undefined), '')
  assert.equal(domain.deliveryRetiredHitText({ count: 0 }), '')
  assert.equal(domain.deliveryRetiredHitText({ count: 1 }), '旧地址还被点过 1 次')
  assert.equal(domain.deliveryRetiredHitText({ count: 12 }), '旧地址还被点过 12 次')
  // 坏值按零次处理：宁可这一行不出现，也不写「被点过 NaN 次」
  assert.equal(domain.deliveryRetiredHitText({ count: Number.NaN }), '')
  assert.equal(domain.deliveryRetiredHitText({ count: -3 }), '')
})

test('胶囊的 title：说清这意味着什么、下一步做什么，不替他断言收到了没有', () => {
  assert.equal(domain.deliveryRetiredHitHint(null), '')
  assert.equal(domain.deliveryRetiredHitHint({ count: 0, at: '2026-11-15T02:31:00.000Z' }), '')

  const hint = domain.deliveryRetiredHitHint({ count: 2, at: '2026-11-15T02:31:00.000Z' })
  assert.match(hint, /^换掉的那条地址 \d{2}-\d{2} \d{2}:\d{2} 还有人点（2 次）/, '带上最近一次与次数：' + hint)
  assert.match(hint, /把现在这条再发一次/, '给下一步：' + hint)
  assert.match(hint, /别再换地址了/, '换个地址解决不了这件事：' + hint)
  assert.doesNotMatch(hint, /他打不开|他没收到|他点过/, '不替对方下结论：' + hint)
})

test('没有时间也能说：只写「还有人点」，不编一个日期出来', () => {
  const hint = domain.deliveryRetiredHitHint({ count: 1, at: '' })
  assert.equal(hint.startsWith('换掉的那条地址还有人点（1 次）'), true, '没有时间就省掉那一截：' + hint)
  assert.doesNotMatch(hint, /\d{2}-\d{2}/, '不凭空造日期：' + hint)

  const bad = domain.deliveryRetiredHitHint({ count: 1, at: 'not-a-time' })
  assert.doesNotMatch(bad, /Invalid/, '坏时间不该漏到界面上：' + bad)
})
