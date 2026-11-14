// 封面代理的两个实例视角（v0.9.94）：缓存、在途数、账号窗口都该是整机一份。
// 这里用两个 createCoverProxy 指向同一个目录来扮演两个实例：它们和两个真进程看到的是同一批文件，
// 差别只在 pid（真跨进程的那两条在 cover-store.test.mjs 里用子进程测）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCoverProxy } from '../server/cover-proxy.mjs'
import { coverReport, registerCoverStats, waterlineReport } from '../server/waterline.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vq-cover-shared-'))
const mkRes = () => ({
  status: 0,
  headers: {},
  body: null,
  writeHead(status, headers) {
    this.status = status
    this.headers = headers
  },
  end(body) {
    this.body = body
  },
})
const call = async (proxy, url, key = 'user:1') => {
  const res = mkRes()
  await proxy.serve(res, url, key)
  return res
}
const fakeImage = (url) => ({ type: 'image/png', buffer: Buffer.from('png:' + url.pathname) })

test('两个实例共用一份缓存：同一张封面只抓一次，第二个实例是 hit', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let fetches = 0
  const fetchImage = async (url) => {
    fetches += 1
    return fakeImage(url)
  }
  const a = createCoverProxy({ dir, fetchImage, perMinute: 100, concurrency: 4 })
  const b = createCoverProxy({ dir, fetchImage, perMinute: 100, concurrency: 4 })
  const first = await call(a, 'https://img.example.com/same.png')
  const second = await call(b, 'https://img.example.com/same.png')
  assert.equal(first.status, 200)
  assert.equal(first.headers['X-VQ-Cover'], 'miss')
  assert.equal(second.status, 200)
  assert.equal(second.headers['X-VQ-Cover'], 'hit')
  assert.equal(fetches, 1, '同一张封面两个实例合计只该去上游一次')
  assert.equal(second.body.toString(), first.body.toString())
  assert.equal(a.stats().entries, 1)
  assert.equal(b.stats().entries, 1)
  assert.equal(a.stats().bytes, b.stats().bytes)
  assert.equal(a.stats().scope, 'lease')
  assert.equal(b.stats().scope, 'lease')
  assert.equal(a.stats().dir, dir)
})

test('整机在途上限：两个实例同时抓，上游峰值不超过配置数', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let inFlight = 0
  let peak = 0
  const fetchImage = async (url) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 120))
    inFlight -= 1
    return fakeImage(url)
  }
  const a = createCoverProxy({ dir, fetchImage, perMinute: 100, concurrency: 1, waitMs: 4000 })
  const b = createCoverProxy({ dir, fetchImage, perMinute: 100, concurrency: 1, waitMs: 4000 })
  const urls = ['https://img.example.com/1.png', 'https://img.example.com/2.png', 'https://img.example.com/3.png']
  const results = await Promise.all(urls.map((url, index) => call(index % 2 ? a : b, url, 'user:' + (index + 1))))
  assert.deepEqual(results.map((res) => res.status), [200, 200, 200])
  assert.equal(peak, 1, '整机只有 1 个名额：两个实例不能各抓一张')
  assert.ok(a.stats().acquired + b.stats().acquired >= 3)
})

test('账号窗口跨实例一份：同一个账号在两个实例之间共享每分钟额度', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let fetches = 0
  const fetchImage = async (url) => {
    fetches += 1
    return fakeImage(url)
  }
  const a = createCoverProxy({ dir, fetchImage, perMinute: 2, concurrency: 4 })
  const b = createCoverProxy({ dir, fetchImage, perMinute: 2, concurrency: 4 })
  const one = await call(a, 'https://img.example.com/w1.png')
  const two = await call(b, 'https://img.example.com/w2.png')
  const three = await call(b, 'https://img.example.com/w3.png')
  assert.equal(one.status, 200)
  assert.equal(two.status, 200)
  assert.equal(three.status, 429)
  assert.equal(three.headers['X-VQ-Cover'], 'limited')
  assert.ok(Number(three.headers['Retry-After']) >= 1)
  assert.equal(fetches, 2, '被限流的那张一次也不该去上游')
})

test('后台那一屏：waterlineReport().cover 来自封面代理，没挂上就是 null', () => {
  assert.equal(coverReport(), null)
  assert.equal(waterlineReport().cover, null)
  registerCoverStats(() => ({ scope: 'lease', entries: 7, bytes: 1024 }))
  const report = waterlineReport()
  assert.equal(report.cover.scope, 'lease')
  assert.equal(report.cover.entries, 7)
  assert.equal(coverReport().bytes, 1024)
  registerCoverStats(null)
  assert.equal(waterlineReport().cover, null)
})
