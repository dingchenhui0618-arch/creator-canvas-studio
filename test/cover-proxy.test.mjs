// 封面代理的端到端行为（v0.9.90）：抓几次、能不能同时抓、抓不到怎么办。
// 抓取器是注入的：这里没有网络，只有「上游被调了几次」这一个可数的事实。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCoverProxy, readImageBody } from '../server/cover-proxy.mjs'

const JPG = (byte = 0x44, size = 300) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, byte)])

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    },
    get bytes() {
      return Buffer.concat(this.chunks)
    },
  }
}

// 假抓取器：记下每次抓的是谁、同一刻最多几条在抓
function fakeFetcher({ delayMs = 0, respond = () => ({ type: 'image/jpeg', buffer: JPG() }) } = {}) {
  const calls = []
  let peak = 0
  let inFlight = 0
  const fetchImage = async (url) => {
    calls.push(url.href)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    try {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      return respond(url)
    } finally {
      inFlight -= 1
    }
  }
  return { fetchImage, calls, get peak() { return peak } }
}

test('同一张封面只抓一次：第二次是命中，字节一模一样', async () => {
  const fetcher = fakeFetcher()
  const proxy = createCoverProxy({ fetchImage: fetcher.fetchImage })
  const first = mockRes()
  await proxy.serve(first, 'https://cdn.example.com/a.jpg', 'user:u1')
  const second = mockRes()
  await proxy.serve(second, 'https://cdn.example.com/a.jpg', 'user:u1')

  assert.equal(first.statusCode, 200)
  assert.equal(first.headers['X-VQ-Cover'], 'miss')
  assert.equal(second.statusCode, 200)
  assert.equal(second.headers['X-VQ-Cover'], 'hit')
  assert.deepEqual(second.bytes, first.bytes)
  assert.equal(second.headers['Content-Length'], String(first.bytes.length))
  assert.equal(second.headers['Cache-Control'], 'public, max-age=86400')
  assert.equal(fetcher.calls.length, 1)
  assert.equal(proxy.stats().hits, 1)
})

test('抓不到就 404：同一个地址 60 秒内不再去打上游', async () => {
  const fetcher = fakeFetcher({ respond: () => null })
  const proxy = createCoverProxy({ fetchImage: fetcher.fetchImage })
  const first = mockRes()
  await proxy.serve(first, 'https://cdn.example.com/dead.jpg', 'user:u1')
  const second = mockRes()
  await proxy.serve(second, 'https://cdn.example.com/dead.jpg', 'user:u1')

  assert.equal(first.statusCode, 404)
  assert.equal(first.headers['X-VQ-Cover'], 'miss')
  assert.equal(second.statusCode, 404)
  assert.equal(second.headers['X-VQ-Cover'], 'hit')
  assert.equal(second.headers['Cache-Control'], 'no-store')
  assert.equal(fetcher.calls.length, 1, '60 秒内不再去打上游')
})

test('按账号限流：第 3 张起 429，带 Retry-After，且不再打上游；命中缓存不吃限流', async () => {
  const fetcher = fakeFetcher()
  const proxy = createCoverProxy({ fetchImage: fetcher.fetchImage, perMinute: 2 })
  for (const name of ['1', '2']) {
    await proxy.serve(mockRes(), 'https://cdn.example.com/' + name + '.jpg', 'user:u1')
  }
  const limited = mockRes()
  await proxy.serve(limited, 'https://cdn.example.com/3.jpg', 'user:u1')
  assert.equal(limited.statusCode, 429)
  assert.equal(limited.headers['X-VQ-Cover'], 'limited')
  assert.equal(limited.headers['Retry-After'], '60')
  assert.equal(limited.headers['Cache-Control'], 'no-store')
  assert.equal(fetcher.calls.length, 2, '被限流的这次没有碰上游')

  // 已经缓存好的那张再要一次：命中，不消耗新名额
  const cached = mockRes()
  await proxy.serve(cached, 'https://cdn.example.com/1.jpg', 'user:u1')
  assert.equal(cached.statusCode, 200)
  assert.equal(cached.headers['X-VQ-Cover'], 'hit')

  // 另一个账号不受影响
  const other = mockRes()
  await proxy.serve(other, 'https://cdn.example.com/1.jpg', 'user:u2')
  assert.equal(other.statusCode, 200, '别人从自己的 0 开始计数')
})

test('整机名额：满了先排队，排队期间不会同时打上游', async () => {
  const fetcher = fakeFetcher({ delayMs: 30 })
  const proxy = createCoverProxy({ fetchImage: fetcher.fetchImage, concurrency: 1, waitMs: 500 })
  const results = await Promise.all([1, 2, 3, 4].map(async (n) => {
    const res = mockRes()
    const started = Date.now()
    await proxy.serve(res, 'https://cdn.example.com/p' + n + '.jpg', 'user:u1')
    return { res, ms: Date.now() - started }
  }))
  for (const { res } of results) assert.equal(res.statusCode, 200)
  assert.equal(fetcher.peak, 1, '同一刻只有 1 条在上游')
  assert.equal(fetcher.calls.length, 4)
  assert.equal(proxy.stats().inFlight, 0, '跑完要把名额还回去')
})

test('整机名额：不排队（waitMs=0）时立刻 503，带 Retry-After', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const calls = []
  const proxy = createCoverProxy({
    concurrency: 1,
    waitMs: 0,
    fetchImage: async (url) => {
      calls.push(url.href)
      await gate
      return { type: 'image/jpeg', buffer: JPG() }
    },
  })
  const busyRun = proxy.serve(mockRes(), 'https://cdn.example.com/slow.jpg', 'user:u1')
  await new Promise((r) => setTimeout(r, 10))
  const busy = mockRes()
  await proxy.serve(busy, 'https://cdn.example.com/other.jpg', 'user:u1')
  assert.equal(busy.statusCode, 503)
  assert.equal(busy.headers['X-VQ-Cover'], 'busy')
  assert.equal(busy.headers['Retry-After'], '2')
  assert.equal(calls.length, 1, '忙的那次没碰上游')
  release()
  await busyRun
  // 名额还回去之后，同一个地址（上次 503 没有缓存）还能正常抓
  const after = mockRes()
  await proxy.serve(after, 'https://cdn.example.com/other.jpg', 'user:u1')
  assert.equal(after.statusCode, 200)
})

test('不是 http(s) 的地址直接拒，不去解析也不去抓', async () => {
  const fetcher = fakeFetcher()
  const proxy = createCoverProxy({ fetchImage: fetcher.fetchImage })
  const res = mockRes()
  await proxy.serve(res, 'file:///C:/Windows/win.ini', 'user:u1')
  assert.equal(res.statusCode, 404)
  assert.equal(res.headers['X-VQ-Cover'], 'bad')
  assert.equal(fetcher.calls.length, 0)
})

test('限流与忙都记一行日志（在访问日志之外能查到原因）', async () => {
  const events = []
  const proxy = createCoverProxy({
    fetchImage: fakeFetcher().fetchImage,
    perMinute: 1,
    log: (event, payload) => events.push([event, payload.state]),
  })
  await proxy.serve(mockRes(), 'https://cdn.example.com/1.jpg', 'user:u1')
  await proxy.serve(mockRes(), 'https://cdn.example.com/2.jpg', 'user:u1')
  assert.deepEqual(events, [['cover.refused', 'limited']])
})

test('读响应体：Content-Length 超限的不读，边读边超的立刻断', async () => {
  const oversized = {
    headers: new Headers({ 'content-length': String(9 * 1024 * 1024) }),
    body: (async function* () { yield Buffer.alloc(4) })(),
  }
  assert.equal(await readImageBody(oversized, 1024), null)

  const streamed = {
    headers: new Headers(),
    body: (async function* () {
      yield Buffer.alloc(800)
      yield Buffer.alloc(800)
    })(),
  }
  assert.equal(await readImageBody(streamed, 1024), null, '没有 Content-Length 时边读边数')

  const fine = {
    headers: new Headers(),
    body: (async function* () {
      yield Buffer.alloc(300, 1)
      yield Buffer.alloc(200, 2)
    })(),
  }
  const body = await readImageBody(fine, 1024)
  assert.equal(body.length, 500)
  assert.equal(body[0], 1)
  assert.equal(body[499], 2)
})
