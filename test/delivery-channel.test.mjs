// 「换个渠道问一句」（v0.9.157）：催过几次、三天以上还没动静时，该问的不是「验一下」。
//
// 上一版（v0.9.156）把「催完 4 天没动静」写到了每个人那一枚上，可那只是一句判断；
// 真到要发消息时，手上还是那段「打开校验.html 拖进去」——同一段话发到第四遍，
// 问题多半不在他忘了，而在这条消息根本没送到他手上。
//
// 这个文件只验纯计算：什么时候算「催了几天没动静」、那段话该说什么、不该说什么。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { deliveryChannelText, deliveryNagLate, deliveryWaitDays } = await import('../src/domain/delivery-wait.ts')

const AT = '2026-11-12T08:00:00.000Z'

test('催过几天没动静：第三天起算，前两天再等等，时间读不出来就不说', () => {
  assert.equal(deliveryNagLate(AT, Date.parse('2026-11-14T09:00:00.000Z')), false, '两天不算没动静')
  assert.equal(deliveryNagLate(AT, Date.parse('2026-11-15T09:00:00.000Z')), true, '第三天起算该换个渠道问了')
  assert.equal(deliveryNagLate(AT, Date.parse('2026-11-20T09:00:00.000Z')), true)
  assert.equal(deliveryNagLate('', Date.now()), false, '没记催收时间就别下结论')
  assert.equal(deliveryNagLate('不是时间', Date.now()), false)
  // 系统时间被往回拨：不出现负数天、也不因此说「没动静」
  assert.equal(deliveryWaitDays(AT, Date.parse('2026-11-01T00:00:00.000Z')), 0)
  assert.equal(deliveryNagLate(AT, Date.parse('2026-11-01T00:00:00.000Z')), false)
})

test('换个渠道问的那一段：问收到没有、要不要换一种发法，不再教怎么验包', () => {
  const text = deliveryChannelText({
    title: '居家收纳改造',
    version: 3,
    at: AT,
    recipient: '王老师',
  })
  // 说清是哪一份：称呼 + 作品名 + 版次 + 哪天发的
  assert.equal(text.startsWith('王老师，'), true, '写了称呼就用它开头：' + text)
  assert.equal(text.includes('《') || text.includes('居家收纳改造'), true)
  assert.equal(text.includes('第 v3 版'), true)
  assert.match(text, /我 \d{2}-\d{2} 发你的/)
  // 这一段要问的是「收到没有 / 换个发法」，不是再教一遍怎么验
  for (const must of ['打得开吗', '直接发你文件', '邮箱', '回执']) {
    assert.equal(text.includes(must), true, '该提到「' + must + '」：' + text)
  }
  assert.equal(text.includes('校验.html'), false, '这一段不教怎么验包')
  assert.equal(text.includes('拖进去'), false)
  // 不责备、不编原因、不替发件人许诺
  assert.equal(text.includes('催'), false, '不把「催过 N 次」说给对方听')
  assert.equal(/重发|赔|保证|一定|已经处理|已读/.test(text), false)
  assert.equal(/undefined|null|NaN|\[object/.test(text), false)
  assert.equal(text.length <= 220, true, '发到微信里一段话，不该是一屏：' + text.length)
  assert.equal(text.endsWith('我这边记上。'), true)
})

test('作品名、版次、时间缺了也不编：只说这一份', () => {
  const bare = deliveryChannelText({ title: '', version: 0 })
  assert.equal(bare.includes('这份包那份包'), false)
  assert.equal(bare.includes('我上次发你的'), true, '没记交付时间就写「上次」')
  assert.equal(/我 \d{2}-\d{2} 发你的/.test(bare), false)
  assert.equal(/（）/.test(bare), false)
  assert.equal(/undefined|null/.test(bare), false)

  const noVersion = deliveryChannelText({ title: '一条作品', at: AT })
  assert.equal(noVersion.includes('一条作品那份包'), true)
  assert.equal(noVersion.includes('第 v0 版'), false, '没有版次就不写「第 v0 版」')

  const noTitle = deliveryChannelText({ version: 2, at: AT })
  assert.equal(noTitle.includes('第 v2 版那份包'), true)
})

test('称呼：没写就不加称呼，也不写「你好」', () => {
  const text = deliveryChannelText({ title: '一条作品', version: 1, at: AT })
  assert.equal(text.startsWith('一条作品 第 v1 版那份包'), true, '没有称呼就直接说事：' + text)
  assert.equal(text.includes('你好'), false)
  assert.equal(text.startsWith('，'), false, '没有称呼就不该以一个逗号开头')
})
