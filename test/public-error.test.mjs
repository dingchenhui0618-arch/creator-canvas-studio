import test from 'node:test'
import assert from 'node:assert/strict'
import { publicError } from '../server/public-error.mjs'

// 用户可见报错必须是产品语言：不露模型名、不露上游地址，截断这种内部原因要翻译成「没写完、不计费、重试」

test('模型输出截断翻译成「没写完、不计费、重试」，不露 finish_reason', () => {
  const message = publicError(new Error('deepseek-flash 输出被 max_tokens 截断（finish_reason=length）'), '评审失败')
  assert.match(message, /没写完/)
  assert.match(message, /不计费/)
  assert.ok(!/deepseek/i.test(message), '不该露出模型名')
  assert.ok(!/max_tokens|finish_reason/i.test(message), '不该把内部参数名丢给用户')
  assert.ok(!/评审/.test(message), '画布节点也会撞到同一个上限，话术不能写死成评审')
})

test('额度、凭证、限流、超时都翻成产品语言', () => {
  assert.match(publicError(new Error('Insufficient Balance')), /额度不足/)
  assert.match(publicError(new Error('HTTP 401 Unauthorized')), /凭证不可用/)
  assert.match(publicError(new Error('HTTP 429 rate limit')), /频率/)
  assert.match(publicError(new Error('fetch failed')), /连接超时/)
  assert.equal(publicError(new Error('')), '服务暂时不可用，请稍后重试')
})
