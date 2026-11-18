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

test('清掉型号与网址之后整句还是英文：给中文结论，不把上游原话丢给用户（r248）', () => {
  const raw = 'deepseek-v3 rejected: you are not allowed to use this subscription on this device, see https://api.example.com/docs'
  const message = publicError(new Error(raw), '上游没有返回可用的回答，稍后再试一次')
  assert.equal(message, '上游没有返回可用的回答，稍后再试一次')
  assert.equal(/deepseek|example\.com|subscription/i.test(message), false, '不该把上游原文原样透出')
  // 我们自己的中文说明照旧透传：那不是上游报文
  assert.match(publicError(new Error('刚被上游拒过，正在冷却，约 30 秒后再点一次')), /冷却/)
})
