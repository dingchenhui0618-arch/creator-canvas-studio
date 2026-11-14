import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createCoverStore,
  createSharedCoverCache,
  createSharedSlotLimiter,
  createSharedWindowLimiter,
} from '../server/cover-store.mjs'
import { coverInChild } from './cover-child.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vq-cover-'))
const keyFile = (dir, key, ext = '.img') => path.join(dir, crypto.createHash('sha256').update(key).digest('hex').slice(0, 32) + ext)
const alive = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode) return resolve()
  child.once('exit', () => resolve())
})
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('共享缓存：一个进程写进去，另一个进程读得到（同一份目录）', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const a = createSharedCoverCache({ dir })
  const b = createSharedCoverCache({ dir })
  assert.equal(a.put('https://img.example.com/a.png', { type: 'image/png', buffer: Buffer.from('a-image') }), true)
  const hit = b.get('https://img.example.com/a.png')
  assert.equal(hit.status, 200)
  assert.equal(hit.type, 'image/png')
  assert.equal(hit.buffer.toString(), 'a-image')
  assert.equal(a.stats().entries, 1)
  assert.equal(b.stats().entries, 1)
})

test('URL 不落盘：文件名只有哈希，内容里没有原始地址', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cache = createSharedCoverCache({ dir })
  const key = 'https://img.example.com/a.png?sign=SECRET-TOKEN-123'
  cache.put(key, { type: 'image/jpeg', buffer: Buffer.from('bytes') })
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.img'))
  assert.deepEqual(names, [crypto.createHash('sha256').update(key).digest('hex').slice(0, 32) + '.img'])
  const text = fs.readFileSync(path.join(dir, names[0])).toString('latin1')
  assert.equal(text.includes('SECRET-TOKEN-123'), false, '签名参数不能随缓存落盘')
})

test('写是原子的：目录里不会留下半个文件或临时文件', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cache = createSharedCoverCache({ dir })
  for (let i = 0; i < 5; i += 1) cache.put('https://img.example.com/x' + i + '.png', { type: 'image/png', buffer: Buffer.from('x'.repeat(64)) })
  const names = fs.readdirSync(dir)
  assert.equal(names.filter((name) => name.endsWith('.tmp')).length, 0)
  assert.equal(names.filter((name) => name.endsWith('.img')).length, 5)
  for (const name of names.filter((n) => n.endsWith('.img'))) assert.ok(fs.statSync(path.join(dir, name)).size > 64)
})

test('过期：到点就删文件，读的人拿不到旧图', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let clock = 1000
  const cache = createSharedCoverCache({ dir, ttlMs: 30, now: () => clock })
  cache.put('https://img.example.com/e.png', { type: 'image/png', buffer: Buffer.from('old') })
  assert.equal(cache.get('https://img.example.com/e.png').status, 200)
  clock += 31
  assert.equal(cache.get('https://img.example.com/e.png'), null)
  assert.equal(fs.existsSync(keyFile(dir, 'https://img.example.com/e.png')), false)
})

test('负缓存：抓不到的地址 60 秒内不再问上游，过期后重新 miss', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let clock = 5000
  const cache = createSharedCoverCache({ dir, now: () => clock })
  cache.putMiss('https://img.example.com/bad.png')
  assert.deepEqual(cache.get('https://img.example.com/bad.png'), { status: 404 })
  assert.deepEqual(cache.get('https://img.example.com/bad.png'), { status: 404 })
  clock += 60001
  assert.equal(cache.get('https://img.example.com/bad.png'), null)
  assert.equal(fs.existsSync(keyFile(dir, 'https://img.example.com/bad.png', '.neg')), false)
})

test('淘汰按最久没用过：条目上限是整机口径', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cache = createSharedCoverCache({ dir, maxEntries: 2 })
  cache.put('https://img.example.com/a.png', { type: 'image/png', buffer: Buffer.from('a') })
  await pause(8)
  cache.put('https://img.example.com/b.png', { type: 'image/png', buffer: Buffer.from('b') })
  await pause(8)
  // 读一次 a：mtime 挪到最新，于是要淘汰的是 b
  assert.equal(cache.get('https://img.example.com/a.png').status, 200)
  await pause(8)
  cache.put('https://img.example.com/c.png', { type: 'image/png', buffer: Buffer.from('c') })
  const stats = cache.stats()
  assert.equal(stats.entries, 2)
  assert.ok(stats.evictions >= 1)
  assert.equal(fs.existsSync(keyFile(dir, 'https://img.example.com/a.png')), true)
  assert.equal(fs.existsSync(keyFile(dir, 'https://img.example.com/b.png')), false)
  assert.equal(fs.existsSync(keyFile(dir, 'https://img.example.com/c.png')), true)
})

test('字节上限也生效：两张加起来超了就只留一张', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cache = createSharedCoverCache({ dir, maxEntries: 64, maxBytes: 160 })
  cache.put('https://img.example.com/1.png', { type: 'image/png', buffer: Buffer.from('x'.repeat(100)) })
  await pause(8)
  cache.put('https://img.example.com/2.png', { type: 'image/png', buffer: Buffer.from('y'.repeat(100)) })
  const stats = cache.stats()
  assert.equal(stats.entries, 1)
  assert.ok(stats.bytes <= 160)
})

test('跨进程：另一个进程写进来的条目这边立刻读得到（真子进程）', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const child = coverInChild({ mode: 'put', dir, key: 'https://img.example.com/cross.png', body: 'from-child' })
  t.after(() => child.child.kill())
  const done = await child.ready
  assert.equal(done.ok, true)
  const cache = createSharedCoverCache({ dir })
  const hit = cache.get('https://img.example.com/cross.png')
  assert.equal(hit.status, 200)
  assert.equal(hit.buffer.toString(), 'from-child')
})

test('整机在途数：两个实例合起来不超过上限', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const a = createSharedSlotLimiter({ dir, max: 2, pollMs: 20 })
  const b = createSharedSlotLimiter({ dir, max: 2, pollMs: 20 })
  const one = await a.acquire(200)
  const two = await a.acquire(200)
  assert.ok(one && two)
  assert.equal(a.active(), 2)
  assert.equal(await b.acquire(80), null, '另一个实例也不该再拿到第 3 个槽位')
  one.release()
  const three = await b.acquire(1500)
  assert.ok(three, '放掉一个之后另一个实例要能拿到')
  assert.equal(a.active(), 2)
  two.release()
  three.release()
  assert.equal(a.active(), 0)
})

test('死掉的槽位立刻清掉：不用等 20 秒', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const child = coverInChild({ mode: 'hold', dir, max: 1 })
  const held = await child.ready
  assert.equal(held.ok, true)
  const slots = createSharedSlotLimiter({ dir, max: 1, pollMs: 20 })
  assert.equal(await slots.acquire(100), null)
  child.child.kill('SIGTERM')
  await alive(child.child)
  await pause(100)
  const handle = await slots.acquire(2000)
  assert.ok(handle, '进程没了，名额应当立刻回来')
  assert.ok(slots.counters.pruned >= 1)
  handle.release()
})

test('陈旧槽位（pid 还在但 20 秒没心跳）按泄漏清掉', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const name = process.pid + '-stale-' + Date.now().toString(36) + '.slot'
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: 0 }))
  const old = new Date(Date.now() - 30000)
  fs.utimesSync(file, old, old)
  const slots = createSharedSlotLimiter({ dir, max: 1, pollMs: 20 })
  const handle = await slots.acquire(500)
  assert.ok(handle)
  assert.equal(fs.existsSync(file), false)
  assert.ok(slots.counters.pruned >= 1)
  handle.release()
})

test('账号窗口跨实例一份：第 3 次在另一个实例被拒', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const a = createSharedWindowLimiter({ dir, max: 2 })
  const b = createSharedWindowLimiter({ dir, max: 2 })
  assert.equal(a.take('user:1').ok, true)
  assert.equal(b.take('user:1').ok, true)
  const third = b.take('user:1')
  assert.equal(third.ok, false)
  assert.ok(third.retryAfterSec >= 1)
  assert.equal(third.limit, 2)
  // 别的账号不受影响
  assert.equal(b.take('user:2').ok, true)
})

test('窗口过一个周期就重置', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let clock = 2000
  const limit = createSharedWindowLimiter({ dir, max: 1, windowMs: 50, now: () => clock })
  assert.equal(limit.take('user:9').ok, true)
  assert.equal(limit.take('user:9').ok, false)
  clock += 51
  assert.equal(limit.take('user:9').ok, true)
})

test('目录不可用：整体退回进程内并如实报 scope=process', async (t) => {
  const base = tmp()
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const blocked = path.join(base, 'not-a-dir')
  fs.writeFileSync(blocked, 'x')
  const store = createCoverStore({ dir: blocked, maxEntries: 4 })
  assert.equal(store.scope, 'process')
  assert.equal(store.dir, '')
  await store.remember('https://img.example.com/a.png', { type: 'image/png', buffer: Buffer.from('a') })
  assert.equal((await store.lookup('https://img.example.com/a.png')).status, 200)
  assert.equal((await store.acquireSlot(50)) !== null, true)
  const report = store.report()
  assert.equal(report.scope, 'process')
  assert.equal(report.dir, '')
  assert.equal(report.entries, 1)
})

test('共享报告：条目与字节是整机口径，hits/misses 是本进程计数', async (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const a = createSharedCoverCache({ dir })
  const b = createSharedCoverCache({ dir })
  a.put('https://img.example.com/a.png', { type: 'image/png', buffer: Buffer.from('a'.repeat(50)) })
  b.get('https://img.example.com/a.png')
  const statsA = a.stats()
  const statsB = b.stats()
  assert.equal(statsA.entries, statsB.entries)
  assert.equal(statsA.bytes, statsB.bytes)
  assert.equal(statsA.hits, 0)
  assert.equal(statsB.hits, 1)
  const store = createCoverStore({ dir, maxEntries: 8 })
  const report = store.report()
  assert.equal(report.scope, 'lease')
  assert.equal(report.countsScope, 'process')
  assert.equal(report.dir, dir)
  assert.equal(report.pid, process.pid)
})
