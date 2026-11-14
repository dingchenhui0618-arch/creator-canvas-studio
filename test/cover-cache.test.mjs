// 封面代理的缓存与闸门（v0.9.90）：同一张只抓一次、一个账号每分钟抓几次、
// 整机同时抓几张。三个都是纯状态机，不碰网络与磁盘，所以在 Node 里直接钉住；
// 真正的端到端（假上游数请求）在一次性实例里跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCoverCache, createSemaphore, createWindowLimiter } from '../server/cover-cache.mjs'

const JPG = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

test('缓存：同一张封面第二次是命中，字节与类型原样回去', () => {
  const cache = createCoverCache({ now: () => 1000 })
  assert.equal(cache.get('https://a/1.jpg'), null)
  cache.put('https://a/1.jpg', { type: 'image/jpeg', buffer: JPG() })
  const hit = cache.get('https://a/1.jpg')
  assert.equal(hit.status, 200)
  assert.equal(hit.type, 'image/jpeg')
  assert.deepEqual(hit.buffer, JPG())
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 6, negatives: 0, hits: 1, misses: 1, evictions: 0, maxEntries: 64, maxBytes: 24 * 1024 * 1024 })
})

test('缓存：到点就过期，字节数一起还回去', () => {
  let at = 0
  const cache = createCoverCache({ ttlMs: 100, now: () => at })
  cache.put('k', { type: 'image/png', buffer: Buffer.alloc(10, 1) })
  at = 99
  assert.equal(cache.get('k').status, 200)
  at = 100
  assert.equal(cache.get('k'), null)
  assert.equal(cache.stats().bytes, 0)
  assert.equal(cache.stats().entries, 0)
})

test('缓存：条目上限按最近最少用淘汰，读到过的不会先被删', () => {
  const cache = createCoverCache({ maxEntries: 2, now: () => 0 })
  cache.put('a', { type: 'image/jpeg', buffer: JPG() })
  cache.put('b', { type: 'image/jpeg', buffer: JPG() })
  assert.equal(cache.get('a').status, 200) // a 变成最近用过的
  cache.put('c', { type: 'image/jpeg', buffer: JPG() })
  assert.equal(cache.get('b'), null, 'b 是最久没用过的，应被淘汰')
  assert.equal(cache.get('a').status, 200)
  assert.equal(cache.get('c').status, 200)
  assert.equal(cache.stats().evictions, 1)
})

test('缓存：字节上限比条目上限更早生效，超出的那张不进缓存', () => {
  const cache = createCoverCache({ maxEntries: 10, maxBytes: 15, now: () => 0 })
  cache.put('big', { type: 'image/jpeg', buffer: Buffer.alloc(10, 1) })
  cache.put('big2', { type: 'image/jpeg', buffer: Buffer.alloc(10, 2) })
  // 15 字节放不下两张 10 字节的图：先来的那张被挤掉，只剩一张
  assert.equal(cache.stats().entries, 1)
  assert.ok(cache.stats().bytes <= 15)
  assert.equal(cache.get('big2').status, 200)
  assert.equal(cache.get('big'), null)
})

test('缓存：抓不到的地址记负缓存，过 60 秒再试', () => {
  let at = 0
  const cache = createCoverCache({ negativeTtlMs: 60 * 1000, now: () => at })
  assert.equal(cache.get('dead'), null)
  cache.putMiss('dead')
  assert.equal(cache.get('dead').status, 404, '负缓存里的是 404，不是 200')
  at = 59 * 1000
  assert.equal(cache.get('dead').status, 404)
  at = 60 * 1000
  assert.equal(cache.get('dead'), null, '过了负缓存期就该重新去抓')
})

test('缓存：一张 404 不会把缓存好的图挤出去', () => {
  const cache = createCoverCache({ maxEntries: 1, maxNegatives: 1, now: () => 0 })
  cache.put('ok', { type: 'image/jpeg', buffer: JPG() })
  cache.putMiss('dead')
  cache.putMiss('dead2')
  assert.equal(cache.get('ok').status, 200, '正片按自己的条目上限算，与负缓存分开')
  assert.equal(cache.stats().negatives, 1)
})

test('缓存：空响应不进缓存（上游 200 但没字节时不该被当成可用封面）', () => {
  const cache = createCoverCache({ now: () => 0 })
  assert.equal(cache.put('empty', { type: 'image/jpeg', buffer: Buffer.alloc(0) }), false)
  assert.equal(cache.stats().entries, 0)
})

test('限流：一分钟内第 3 次要抓就拒，并说明几秒后再来', () => {
  let at = 0
  const limit = createWindowLimiter({ max: 2, windowMs: 60000, now: () => at })
  assert.equal(limit.take('u1').ok, true)
  const second = limit.take('u1')
  assert.equal(second.ok, true)
  assert.equal(second.remaining, 0, '第 2 次用掉最后一个名额')
  at = 30 * 1000
  const refused = limit.take('u1')
  assert.equal(refused.ok, false)
  assert.equal(refused.limit, 2)
  assert.equal(refused.retryAfterSec, 30, '过了 30 秒，再等 30 秒就是新窗口')
  at = 60 * 1000
  assert.equal(limit.take('u1').ok, true, '窗口一过就重新算')
})

test('限流：按账号分开算，一个人刷满不影响别人', () => {
  const limit = createWindowLimiter({ max: 1, windowMs: 60000, now: () => 0 })
  assert.equal(limit.take('a').ok, true)
  assert.equal(limit.take('a').ok, false)
  assert.equal(limit.take('b').ok, true, '另一个账号从自己的 0 开始')
  assert.equal(limit.take('share:token').ok, true, '分享链接是另一个对象')
})

test('限流：写 0 = 不限（留一条退回旧行为的开关）', () => {
  const limit = createWindowLimiter({ max: 0, windowMs: 60000, now: () => 0 })
  for (let i = 0; i < 500; i += 1) assert.equal(limit.take('u').ok, true)
})

test('限流：账号表不会无限长，过期的桶会被清掉', () => {
  let at = 0
  const limit = createWindowLimiter({ max: 5, windowMs: 1000, maxKeys: 3, now: () => at })
  limit.take('a')
  limit.take('b')
  limit.take('c')
  at = 5000
  limit.take('d')
  assert.ok(limit.size() <= 3, '超过上限时先清过期桶，表不再跟着账号数长')
  assert.equal(limit.take('a').ok, true, '被清掉的账号重新开始计数，不会永久拉黑')
})

test('整机名额：满了就排队，等到名额才进去；等不到返回 false', async () => {
  const slots = createSemaphore(1)
  assert.equal(await slots.acquire(0), true)
  assert.equal(slots.active, 1)
  assert.equal(await slots.acquire(0), false, '不排队时立刻拒')
  assert.equal(await slots.acquire(20), false, '排了一小会儿没人还名额，还是拒')
  assert.equal(slots.waiting, 0, '超时的排队位要收走，不能留在队列里')
  slots.release()
  assert.equal(slots.active, 0)
  assert.equal(await slots.acquire(0), true)
})

test('整机名额：release 直接把名额交给排队的那一个，active 不变', async () => {
  const slots = createSemaphore(1)
  await slots.acquire(0)
  const waiting = slots.acquire(200)
  assert.equal(slots.waiting, 1)
  slots.release()
  assert.equal(await waiting, true)
  assert.equal(slots.active, 1, '名额转交，不是先还再抢（否则会被新来的插队）')
  slots.release()
  assert.equal(slots.active, 0)
})

test('整机名额：写 0 = 不限，acquire 永远成功', async () => {
  const slots = createSemaphore(0)
  for (let i = 0; i < 10; i += 1) assert.equal(await slots.acquire(0), true)
  assert.equal(slots.active, 0)
  slots.release()
})
