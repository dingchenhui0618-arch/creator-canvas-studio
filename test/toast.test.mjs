// 全局提示条（r324）：该停多久、收尾等多久。
// 只测纯函数；计时器与真渲染的数字交给 scripts/shot-r324.mjs 真点一遍。
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  TOAST_BASE_MS,
  TOAST_EXIT_MS,
  TOAST_MAX_MS,
  TOAST_PER_CHAR_MS,
  toastDuration,
  toastExitDelay,
} = await import('../src/domain/toast.ts')

test('短提示按打底时长：三个字不会因为太短而一闪而过', () => {
  assert.equal(toastDuration('已保存'), TOAST_BASE_MS + 3 * TOAST_PER_CHAR_MS)
  assert.equal(toastDuration('已保存'), 2580)
})

test('停留时间跟着字数走：报错比「已保存」明显停得久', () => {
  const short = toastDuration('已复制')
  const failure = toastDuration('复制失败：浏览器没给剪贴板权限')
  assert.equal(failure, TOAST_BASE_MS + '复制失败：浏览器没给剪贴板权限'.length * TOAST_PER_CHAR_MS)
  assert.ok(failure > short + 600, { short: short, failure: failure })
  assert.ok(failure > 2400, { failure: failure })
})

test('再长也有上限：不会让提示条一直挂着', () => {
  assert.equal(toastDuration('长'.repeat(200)), TOAST_MAX_MS)
  assert.equal(toastDuration('长'.repeat(60)), TOAST_MAX_MS)
  // 60 字刚好顶到上限，59 字还差一点点
  assert.equal(toastDuration('长'.repeat(59)), TOAST_MAX_MS - TOAST_PER_CHAR_MS)
})

test('空文案与非字符串都按打底时长：不能因为 0 字变成 0 秒', () => {
  assert.equal(toastDuration(''), TOAST_BASE_MS)
  assert.equal(toastDuration('   '), TOAST_BASE_MS)
  assert.equal(toastDuration(undefined), TOAST_BASE_MS)
  assert.equal(toastDuration(null), TOAST_BASE_MS)
})

test('首尾空白不算字数：写代码时多敲的空格不该让提示多停', () => {
  assert.equal(toastDuration('  已保存  '), toastDuration('已保存'))
})

test('收尾时长：正常 180ms，开了减弱动态效果立刻收掉', () => {
  assert.equal(toastExitDelay(false), TOAST_EXIT_MS)
  assert.equal(toastExitDelay(true), 0)
  assert.ok(TOAST_EXIT_MS > 0)
})

test('几个常量本身站得住：上限最高、收尾不超过一档动效', () => {
  assert.ok(TOAST_MAX_MS > TOAST_BASE_MS)
  assert.ok(TOAST_PER_CHAR_MS > 0)
  assert.ok(TOAST_EXIT_MS <= 260, { exit: TOAST_EXIT_MS })
})
