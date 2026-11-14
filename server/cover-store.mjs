// 封面缓存与两道闸门的共享目录版（v0.9.94）。
//
// v0.9.90 给 /api/cover 加了三层：同一张抓一次（LRU + 负缓存）、按账号每分钟限流、
// 整机同一刻最多几张在上游。三层都写在进程里。v0.9.78 起「在跑几条重活」已经是
// 共享目录里的租约，v0.9.93 又把画布的排队位搬了过去——只剩封面这一路还是
// 「每个实例各一份」：两个实例各自缓存 64 张 / 24MB（实际 128 张 / 48MB），
// 同一张封面各抓一次；整机 4 张的闸门实际是 8 张；一人每分钟 120 次实际是 240 次。
// 于是「这台机器上一共在上游抓几张」这个问题，两张嘴各说一个数。
//
// 做法和排队位同一套，不引新依赖：
//   一张封面 = 共享目录里的一个文件，文件名是 sha256(URL) 前 32 位（URL 本身不落盘：
//     封面 URL 可能带签名参数，缓存不是凭据该待的地方），内容是「一行头 + 图片字节」；
//   写入先写临时文件再 rename——读的人永远看不到半张图；
//   淘汰按文件 mtime 从旧到新，条目上限与字节上限都是**整机**口径；
//   在跑的槽位 = <pid>-<ts>-<seq>.slot 文件，pid 没了或 20 秒没心跳就按泄漏清掉；
//   账号窗口 = 每个账号一个 .win 文件（开始时间 + 次数），读改写在那把跨进程锁里做；
//   目录写不了时整体退回进程内（和 v0.9.93 的排队位一样如实报 scope=process）。
//
// 三条边界：
//   1) 只跨进程、不跨机器：目录是本地磁盘，多机部署要另外的协调者（没做）；
//   2) 读命中路径是同步读盘（单张上限 8MB）。命中不抢锁、不打上游，代价是几毫秒的
//      事件循环阻塞——比让同一张图在两个实例里各占一份内存便宜；
//   3) 拿不到锁时窗口限流放行（封面不是安全边界，宁可多抓一张，也不要把图片墙挂死）；
//      槽位拿不到锁时按「忙」拒绝——那一层本来就是保护上游与内存的。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LEASE_LOCK_MISS, pidAlive, withDirLock } from './heavy-lease.mjs'
import { createCoverCache, createSemaphore, createWindowLimiter } from './cover-cache.mjs'

const MAGIC = 'VQCOVER1 '
const IMG_EXT = '.img'
const NEG_EXT = '.neg'
// 槽位的过期时间：封面抓取本身 15 秒超时，心跳 5 秒一次，20 秒没动静就是进程死在了中间
const SLOT_STALE_MS = 20000
const SLOT_NAME_RE = /^(\d+)-[a-z0-9]+-[a-z0-9]+\.slot$/

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32)
}

/** 排障接口用：把封面地址换成缓存里的那个名字，地址本身不往外发。 */
export function coverKeyHash(key) {
  return hashKey(key)
}

function removeQuiet(file) {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

// 不 unref：靠 unref 计时器兑现的 Promise 在事件循环空转时可能永远不 resolve。
// 这里的等待有 timeoutMs 上限，不会把进程拖住。
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)))
}

function listNames(dir, suffix) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(suffix))
  } catch {
    return []
  }
}

// 只看头：排障问「这张在不在缓存里」时，不该为了一张 8MB 的图把整段读进内存
function readHeader(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(256)
    const read = fs.readSync(fd, buf, 0, buf.length, 0)
    const nl = buf.subarray(0, read).indexOf(0x0a)
    if (nl < 0) return null
    const head = buf.subarray(0, nl).toString('utf8')
    if (!head.startsWith(MAGIC)) return null
    const meta = JSON.parse(head.slice(MAGIC.length))
    if (!meta || typeof meta.type !== 'string' || !Number.isFinite(meta.expiresAt)) return null
    return meta
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // 关不掉也不影响结论
      }
    }
  }
}

function listSized(dir, suffix) {
  const out = []
  for (const name of listNames(dir, suffix)) {
    const file = path.join(dir, name)
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) out.push({ file, name, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      // 正好被别的进程删了：跳过
    }
  }
  return out
}

/** 目录能不能当共享缓存用：能建、能写、能删。不行就整体退回进程内。 */
export function ensureCoverDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 })
    try {
      fs.chmodSync(dir, 0o777)
    } catch {
      // 不是自己的目录：跟着现有权限走，能不能写由下面那次写说话
    }
    const probe = path.join(dir, '.probe-' + process.pid + '-' + Date.now().toString(36))
    fs.writeFileSync(probe, 'ok', { mode: 0o666 })
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 共享封面缓存：get / put / putMiss 与进程内版同一个语义，只是落盘。
 * stats() 读目录现算整机条目与字节（后台那一屏才调，不在请求路径上）。
 */
export function createSharedCoverCache({
  dir,
  maxEntries = 64,
  maxBytes = 24 * 1024 * 1024,
  ttlMs = 10 * 60 * 1000,
  negativeTtlMs = 60 * 1000,
  maxNegatives = 256,
  now = Date.now,
} = {}) {
  const base = path.resolve(dir)
  const counters = { hits: 0, misses: 0, evictions: 0, pruned: 0, writes: 0, lockMiss: 0, lastError: '' }
  let seq = 0
  const fileFor = (key, ext) => path.join(base, hashKey(key) + ext)

  function readNegative(key) {
    const file = fileFor(key, NEG_EXT)
    let meta = null
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return false
    }
    if (!meta || !Number.isFinite(meta.expiresAt)) {
      removeQuiet(file)
      return false
    }
    if (meta.expiresAt <= now()) {
      removeQuiet(file)
      counters.pruned += 1
      return false
    }
    return true
  }

  function get(key) {
    const file = fileFor(key, IMG_EXT)
    let buf
    try {
      buf = fs.readFileSync(file)
    } catch {
      if (readNegative(key)) {
        counters.hits += 1
        return { status: 404 }
      }
      counters.misses += 1
      return null
    }
    const nl = buf.indexOf(0x0a)
    if (nl < 0 || nl > 512) {
      removeQuiet(file)
      counters.pruned += 1
      counters.misses += 1
      return null
    }
    const head = buf.subarray(0, nl).toString('utf8')
    let meta = null
    try {
      if (!head.startsWith(MAGIC)) throw new Error('magic')
      meta = JSON.parse(head.slice(MAGIC.length))
    } catch {
      removeQuiet(file)
      counters.pruned += 1
      counters.misses += 1
      return null
    }
    if (!meta || typeof meta.type !== 'string' || !Number.isFinite(meta.expiresAt) || meta.expiresAt <= now()) {
      removeQuiet(file)
      counters.pruned += 1
      counters.misses += 1
      return null
    }
    const body = buf.subarray(nl + 1)
    if (!body.length) {
      removeQuiet(file)
      counters.pruned += 1
      counters.misses += 1
      return null
    }
    // 命中就把 mtime 往后挪：淘汰按「最久没被用过」来，而不是「最早抓进来」
    const stamp = new Date()
    try {
      fs.utimesSync(file, stamp, stamp)
    } catch {
      // 文件正好被别人清了：这一次仍然从读到的字节里回，下一次会 miss
    }
    counters.hits += 1
    return { status: 200, type: meta.type, buffer: body }
  }

  /**
   * 只回答「在不在」，不计命中、不挪 LRU、不删过期文件（v0.9.94 的排障用）。
   * 过期条目照样报 present=true + expired=true：那正是排障想知道的状态。
   */
  function peek(key) {
    const file = fileFor(key, IMG_EXT)
    const meta = readHeader(file)
    if (meta) {
      let bytes = 0
      try {
        bytes = fs.statSync(file).size
      } catch {
        return { present: false }
      }
      return { present: true, type: meta.type, bytes, expiresAt: meta.expiresAt, expired: meta.expiresAt <= now() }
    }
    const negFile = fileFor(key, NEG_EXT)
    let neg = null
    try {
      neg = JSON.parse(fs.readFileSync(negFile, 'utf8'))
    } catch {
      // 没有负缓存
    }
    if (neg && Number.isFinite(neg.expiresAt)) {
      return { present: true, type: '', bytes: 0, expiresAt: neg.expiresAt, expired: neg.expiresAt <= now(), negative: true }
    }
    return { present: false }
  }

  function put(key, { type, buffer } = {}) {
    if (!buffer || !buffer.length) return false
    const meta = { type: String(type || 'application/octet-stream'), expiresAt: now() + ttlMs }
    const header = Buffer.from(MAGIC + JSON.stringify(meta) + '\n', 'utf8')
    const file = fileFor(key, IMG_EXT)
    const tmp = path.join(base, '.' + hashKey(key) + '-' + process.pid + '-' + (++seq).toString(36) + '.tmp')
    try {
      fs.writeFileSync(tmp, Buffer.concat([header, buffer]), { mode: 0o666 })
      fs.renameSync(tmp, file)
      counters.writes += 1
    } catch (error) {
      removeQuiet(tmp)
      counters.lastError = '封面缓存写入失败：' + String((error && (error.code || error.message)) || error)
      return false
    }
    removeQuiet(fileFor(key, NEG_EXT))
    trim()
    return true
  }

  /** 抓不到也记一笔：同一个坏地址在 negativeTtlMs 内不再去上游。 */
  function putMiss(key) {
    const file = fileFor(key, NEG_EXT)
    const tmp = path.join(base, '.' + hashKey(key) + '-' + process.pid + '-' + (++seq).toString(36) + '.tmp2')
    try {
      fs.writeFileSync(tmp, JSON.stringify({ expiresAt: now() + negativeTtlMs }), { mode: 0o666 })
      fs.renameSync(tmp, file)
    } catch {
      removeQuiet(tmp)
    }
    // 同一条目原来缓存成功过：现在抓不到了，旧的图不能再回给用户
    removeQuiet(fileFor(key, IMG_EXT))
    trim()
  }

  // 淘汰：先无锁地看一眼有没有超，超了才进锁里现算一遍再删。
  // 这样绝大多数 put 不进锁，两个实例同时淘汰也不会各删一份（后进锁的看到已经合规）。
  function trim() {
    const images = listSized(base, IMG_EXT)
    const bytes = images.reduce((sum, item) => sum + item.size, 0)
    const negatives = listNames(base, NEG_EXT).length
    if (images.length <= maxEntries && bytes <= maxBytes && negatives <= maxNegatives) return
    const outcome = withDirLock(base, () => {
      const fresh = listSized(base, IMG_EXT)
      let total = fresh.reduce((sum, item) => sum + item.size, 0)
      fresh.sort((a, b) => a.mtimeMs - b.mtimeMs)
      while (fresh.length > maxEntries || total > maxBytes) {
        const oldest = fresh.shift()
        if (!oldest) break
        if (removeQuiet(oldest.file)) {
          total -= oldest.size
          counters.evictions += 1
        }
      }
      const negs = listSized(base, NEG_EXT).sort((a, b) => a.mtimeMs - b.mtimeMs)
      while (negs.length > maxNegatives) {
        const oldest = negs.shift()
        if (!oldest) break
        if (removeQuiet(oldest.file)) counters.pruned += 1
      }
    })
    if (outcome === LEASE_LOCK_MISS) counters.lockMiss += 1
  }

  function stats() {
    const images = listSized(base, IMG_EXT)
    return {
      entries: images.length,
      bytes: images.reduce((sum, item) => sum + item.size, 0),
      negatives: listNames(base, NEG_EXT).length,
      maxEntries,
      maxBytes,
      hits: counters.hits,
      misses: counters.misses,
      evictions: counters.evictions,
      pruned: counters.pruned,
      writes: counters.writes,
      lockMiss: counters.lockMiss,
    }
  }

  /** 测试与排障用：清掉这个目录里的所有封面条目（不动窗口与槽位）。 */
  function clear() {
    for (const item of listSized(base, IMG_EXT)) removeQuiet(item.file)
    for (const item of listSized(base, NEG_EXT)) removeQuiet(item.file)
  }

  return { get, put, putMiss, peek, stats, clear, dir: base }
}

/**
 * 整机在途抓取数：一条在途 = 一个 .slot 文件。
 * 占槽位 = 锁里数一遍、没满就写下自己那一条；满了按 pollMs 轮询到超时。
 * pid 不在或 20 秒没心跳的槽位会被后来者清掉——进程被 SIGKILL 也不至于把闸门焊死。
 */
export function createSharedSlotLimiter({ dir, max = 4, staleMs = SLOT_STALE_MS, pollMs = 80, heartbeatMs = 5000 } = {}) {
  const base = path.resolve(dir)
  const counters = { acquired: 0, refused: 0, pruned: 0, lockMiss: 0, waited: 0 }
  const live = new Map()
  let seq = 0
  let waiting = 0

  function listSlots() {
    const out = []
    for (const name of listNames(base, '.slot')) {
      const match = SLOT_NAME_RE.exec(name)
      if (!match) continue
      const file = path.join(base, name)
      try {
        const stat = fs.statSync(file)
        out.push({ file, pid: Number(match[1]), mtimeMs: stat.mtimeMs })
      } catch {
        // 正好被释放了
      }
    }
    return out
  }

  function pruneSlots() {
    const at = Date.now()
    for (const item of listSlots()) {
      if (!pidAlive(item.pid) || at - item.mtimeMs > staleMs) {
        if (removeQuiet(item.file)) counters.pruned += 1
      }
    }
  }

  async function acquire(timeoutMs = 0) {
    if (!max || max <= 0) {
      // 0 = 不限：不写槽位，release 是空操作
      return { file: '', release() {} }
    }
    const started = Date.now()
    let tried = false
    for (;;) {
      const outcome = withDirLock(base, () => {
        pruneSlots()
        const alive = listSlots()
        if (alive.length >= max) return { ok: false, count: alive.length }
        const token = process.pid + '-' + Date.now().toString(36) + '-' + (++seq).toString(36)
        const file = path.join(base, token + '.slot')
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: os.hostname() }), { flag: 'wx', mode: 0o666 })
        return { ok: true, file, token, count: alive.length }
      })
      if (outcome === LEASE_LOCK_MISS) {
        counters.lockMiss += 1
        return null
      }
      if (outcome.ok) {
        counters.acquired += 1
        const timer = setInterval(() => {
          const stamp = new Date()
          try {
            fs.utimesSync(outcome.file, stamp, stamp)
          } catch {
            // 被当成泄漏清了：心跳没有意义
          }
        }, heartbeatMs)
        if (typeof timer.unref === 'function') timer.unref()
        const handle = { file: outcome.file, token: outcome.token, release: null }
        live.set(handle.token, handle)
        handle.release = () => {
          if (!live.has(handle.token)) return
          live.delete(handle.token)
          clearInterval(timer)
          removeQuiet(outcome.file)
        }
        return handle
      }
      if (!tried) {
        tried = true
        counters.waited += 1
      }
      if (!timeoutMs || timeoutMs <= 0 || Date.now() - started >= timeoutMs) {
        counters.refused += 1
        return null
      }
      const left = timeoutMs - (Date.now() - started)
      waiting += 1
      try {
        await sleep(Math.min(pollMs + Math.floor(Math.random() * 40), Math.max(10, left)))
      } finally {
        waiting -= 1
      }
    }
  }

  function active() {
    pruneSlots()
    return listSlots().length
  }

  return { acquire, active, waiting: () => waiting, counters, dir: base }
}

/**
 * 按账号的每分钟抓取窗口，跨进程一份。
 * 每个账号一个文件（账号 id 哈希后当文件名，id 本身不落盘）：开始时间 + 次数。
 * 拿不到锁时放行并记一笔 lockMiss——这一层是防滥用，不是安全边界。
 */
export function createSharedWindowLimiter({ dir, max = 60, windowMs = 60 * 1000, maxKeys = 2048, now = Date.now } = {}) {
  const base = path.resolve(dir)
  const counters = { allowed: 0, refused: 0, pruned: 0, lockMiss: 0 }
  const fileFor = (key) => path.join(base, hashKey('win:' + String(key || 'anonymous')) + '.win')

  function readBucket(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Number.isFinite(data && data.start) && Number.isFinite(data && data.count)) return data
    } catch {
      // 坏文件当没有：下一行会覆盖它
    }
    return null
  }

  function writeBucket(file, bucket) {
    const tmp = path.join(base, '.' + path.basename(file) + '-' + process.pid + '-' + Date.now().toString(36) + '.tmp')
    try {
      fs.writeFileSync(tmp, JSON.stringify(bucket), { mode: 0o666 })
      fs.renameSync(tmp, file)
    } catch {
      removeQuiet(tmp)
    }
  }

  function pruneWindows(at) {
    const files = listSized(base, '.win')
    for (const item of files) {
      const bucket = readBucket(item.file)
      if (!bucket || at - bucket.start >= windowMs) {
        if (removeQuiet(item.file)) counters.pruned += 1
      }
    }
    const left = listSized(base, '.win')
    if (left.length <= maxKeys) return
    left.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const item of left.slice(0, left.length - maxKeys)) {
      if (removeQuiet(item.file)) counters.pruned += 1
    }
  }

  function take(key) {
    if (!max || max <= 0) return { ok: true, remaining: Infinity }
    const file = fileFor(key)
    const outcome = withDirLock(base, () => {
      const at = now()
      const files = listNames(base, '.win').length
      if (files > maxKeys) pruneWindows(at)
      const bucket = readBucket(file)
      if (!bucket || at - bucket.start >= windowMs) {
        writeBucket(file, { start: at, count: 1 })
        return { ok: true, remaining: max - 1 }
      }
      if (bucket.count >= max) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.start + windowMs - at) / 1000)), limit: max }
      }
      writeBucket(file, { start: bucket.start, count: bucket.count + 1 })
      return { ok: true, remaining: max - bucket.count - 1 }
    })
    if (outcome === LEASE_LOCK_MISS) {
      counters.lockMiss += 1
      return { ok: true, remaining: Infinity, degraded: true }
    }
    if (outcome.ok) counters.allowed += 1
    else counters.refused += 1
    return outcome
  }

  function size() {
    return listNames(base, '.win').length
  }

  return { take, size, counters, dir: base }
}

/**
 * 封面这一路的仓库：缓存 + 账号窗口 + 在途槽位，共享目录可用就整机一份，
 * 不可用就整体退回进程内（并如实报 scope=process，不与共享目录的数混着写）。
 */
export function createCoverStore(options = {}) {
  const {
    dir = '',
    shared = true,
    maxEntries = 64,
    maxBytes = 24 * 1024 * 1024,
    ttlMs = 10 * 60 * 1000,
    negativeTtlMs = 60 * 1000,
    maxNegatives = 256,
    perMinute = 120,
    windowMs = 60 * 1000,
    concurrency = 4,
    waitMs = 5000,
    now = Date.now,
  } = options
  const wanted = Boolean(String(dir || '').trim()) && shared !== false
  const base = wanted ? path.resolve(String(dir)) : ''
  const usable = wanted ? ensureCoverDir(base) : false

  if (usable) {
    const cache = createSharedCoverCache({ dir: base, maxEntries, maxBytes, ttlMs, negativeTtlMs, maxNegatives, now })
    const rate = createSharedWindowLimiter({ dir: base, max: perMinute, windowMs, now })
    const slots = createSharedSlotLimiter({ dir: base, max: concurrency })
    return {
      scope: 'lease',
      dir: base,
      shared: true,
      async lookup(key) {
        return cache.get(key)
      },
      async remember(key, hit) {
        return cache.put(key, hit)
      },
      async rememberMiss(key) {
        cache.putMiss(key)
      },
      async takeQuota(key) {
        return rate.take(key)
      },
      async peek(key) {
        return cache.peek(key)
      },
      async acquireSlot(timeoutMs = waitMs) {
        return slots.acquire(timeoutMs)
      },
      releaseSlot(handle) {
        if (handle && typeof handle.release === 'function') handle.release()
      },
      clear() {
        cache.clear()
      },
      report() {
        const stats = cache.stats()
        return {
          scope: 'lease',
          countsScope: 'process',
          dir: base,
          pid: process.pid,
          entries: stats.entries,
          bytes: stats.bytes,
          negatives: stats.negatives,
          maxEntries: stats.maxEntries,
          maxBytes: stats.maxBytes,
          inFlight: slots.active(),
          waiting: slots.waiting(),
          accounts: rate.size(),
          hits: stats.hits,
          misses: stats.misses,
          evictions: stats.evictions,
          pruned: stats.pruned + slots.counters.pruned + rate.counters.pruned,
          lockMiss: slots.counters.lockMiss + rate.counters.lockMiss + stats.lockMiss,
          acquired: slots.counters.acquired,
          refused: slots.counters.refused,
          waited: slots.counters.waited,
        }
      },
    }
  }

  const cache = createCoverCache({ maxEntries, maxBytes, ttlMs, negativeTtlMs, maxNegatives, now })
  const rate = createWindowLimiter({ max: perMinute, windowMs })
  const slots = createSemaphore(concurrency)
  return {
    scope: 'process',
    dir: '',
    shared: false,
    async lookup(key) {
      return cache.get(key)
    },
    async remember(key, hit) {
      return cache.put(key, hit)
    },
    async rememberMiss(key) {
      cache.putMiss(key)
    },
    async takeQuota(key) {
      return rate.take(key)
    },
    async peek(key) {
      return cache.peek(key)
    },
    async acquireSlot(timeoutMs = waitMs) {
      return (await slots.acquire(timeoutMs)) ? { release: () => slots.release() } : null
    },
    releaseSlot(handle) {
      if (handle && typeof handle.release === 'function') handle.release()
    },
    clear() {
      // 进程内缓存没有 clear 接口：测试不依赖它
    },
    report() {
      const stats = cache.stats()
      return {
        scope: 'process',
        countsScope: 'process',
        dir: '',
        pid: process.pid,
        entries: stats.entries,
        bytes: stats.bytes,
        negatives: stats.negatives,
        maxEntries: stats.maxEntries,
        maxBytes: stats.maxBytes,
        inFlight: slots.active,
        waiting: slots.waiting,
        accounts: rate.size(),
        hits: stats.hits,
        misses: stats.misses,
        evictions: stats.evictions,
        pruned: 0,
        lockMiss: 0,
        acquired: 0,
        refused: 0,
        waited: 0,
      }
    },
  }
}