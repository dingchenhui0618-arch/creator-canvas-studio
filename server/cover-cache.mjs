// 封面代理（/api/cover）的缓存与闸门（v0.9.90）。
//
// 这里原来是纯透传：每个请求各自去上游抓一次，整段读进内存（8MB 上限）。
// 一屏模板库 40 张封面，翻两次页就是 80 次上游请求、十几份整图同时在内存里；
// 2 核 / 1.86GB 的机器撞上这个，慢的是所有人的页面，极端时直接 OOM。
//
// 现在分三层，各管一件事：
//   createCoverCache     同一张封面只抓一次（条目上限、字节上限、过期、以及「抓不到」的负缓存）
//   createWindowLimiter  一个账号每分钟最多抓几张（缓存命中不算）
//   createSemaphore      整机同一刻在上游的请求数（满了先排一会儿，等不到才 503）
// 命中缓存既不打上游、也不吃限流——那是这一路里最便宜的请求。
//
// 这三个在 v0.9.90 都是进程内状态：当时认为「单机一个进程」，为封面图引入共享存储不划算。
// 后来生产跑着两个实例（对外 8799 + 内部 8800），这三层各变成两份——同一张封面抓两次、
// 整机 4 张实际 8 张、一人 120 次实际 240 次。v0.9.94 起由 cover-store.mjs 把它们挪进
// 共享目录（整机一份），这里保留进程内版：目录不可用时的退路，也是单测的默认实现。

// 进程内 LRU：Map 的插入顺序当队列，读到就把那一项挪到队尾。
// 正片与「抓不到」分开存：一张 404 不该把一张已经缓存好的图挤出去。
export function createCoverCache({
  maxEntries = 64,
  maxBytes = 24 * 1024 * 1024,
  ttlMs = 10 * 60 * 1000,
  negativeTtlMs = 60 * 1000,
  maxNegatives = 256,
  now = Date.now,
} = {}) {
  const images = new Map()
  const negatives = new Map()
  let bytes = 0
  let hits = 0
  let misses = 0
  let evictions = 0

  // 超了就从队头删，删到既不超条目也不超字节为止
  const trim = () => {
    while (images.size > maxEntries || bytes > maxBytes) {
      const oldest = images.keys().next().value
      if (oldest === undefined) break
      const entry = images.get(oldest)
      bytes -= entry.bytes
      images.delete(oldest)
      evictions += 1
    }
    while (negatives.size > maxNegatives) {
      const oldest = negatives.keys().next().value
      if (oldest === undefined) break
      negatives.delete(oldest)
    }
  }

  return {
    /** 命中返回 { status: 200, type, buffer } 或 { status: 404 }（负缓存），否则 null。 */
    get(key) {
      const at = now()
      const image = images.get(key)
      if (image) {
        if (image.expiresAt <= at) {
          // 过期就当没有：字节数一起还回去，别让一次过期泄漏内存
          bytes -= image.bytes
          images.delete(key)
          misses += 1
          return null
        }
        // 命中了：挪到队尾（最近用过的最后被淘汰）
        images.delete(key)
        images.set(key, image)
        hits += 1
        return { status: 200, type: image.type, buffer: image.buffer }
      }
      const expiredAt = negatives.get(key)
      if (expiredAt !== undefined) {
        if (expiredAt <= at) {
          negatives.delete(key)
          misses += 1
          return null
        }
        hits += 1
        return { status: 404 }
      }
      misses += 1
      return null
    },
    put(key, { type, buffer }) {
      if (!buffer || !buffer.length) return false
      const previous = images.get(key)
      if (previous) bytes -= previous.bytes
      images.delete(key)
      images.set(key, { type, buffer, bytes: buffer.length, expiresAt: now() + ttlMs })
      bytes += buffer.length
      negatives.delete(key)
      trim()
      return images.has(key)
    },
    /**
     * 只看一眼在不在，不计命中也不挪 LRU（v0.9.94 的排障接口用）：
     * 网关的 /api/gateway/v1/covers?key= 要回答「这张封面在这个实例里有没有」，
     * 但它不是一次真实访问，不该把 hits/misses 的账记花。
     */
    peek(key) {
      const at = now()
      const image = images.get(key)
      if (image && image.expiresAt > at) return { present: true, type: image.type, bytes: image.bytes, expiresAt: image.expiresAt }
      const expiredAt = negatives.get(key)
      if (expiredAt !== undefined && expiredAt > at) return { present: true, type: '', bytes: 0, expiresAt: expiredAt, negative: true }
      return { present: false }
    },
    /** 抓不到也记一笔：60 秒内同一个地址不再去打上游（否则一屏 40 张坏封面会反复重试）。 */
    putMiss(key) {
      negatives.delete(key)
      negatives.set(key, now() + negativeTtlMs)
      trim()
    },
    stats() {
      return { entries: images.size, bytes, negatives: negatives.size, hits, misses, evictions, maxEntries, maxBytes }
    },
  }
}

// 按账号的滑动窗口（固定窗口，够用且不存时间戳数组）：
// 上限是「每分钟抓几次上游」，不是「每分钟看几次封面」——缓存命中在调用前就返回了。
export function createWindowLimiter({ max = 60, windowMs = 60 * 1000, maxKeys = 2048, now = Date.now } = {}) {
  const buckets = new Map()
  return {
    /** { ok: true, remaining } 或 { ok: false, retryAfterSec, limit } */
    take(key) {
      if (!max || max <= 0) return { ok: true, remaining: Infinity }
      const id = String(key || 'anonymous')
      const at = now()
      let bucket = buckets.get(id)
      if (!bucket || at - bucket.start >= windowMs) {
        bucket = { start: at, count: 0 }
        buckets.delete(id)
        buckets.set(id, bucket)
      }
      if (bucket.count >= max) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.start + windowMs - at) / 1000)), limit: max }
      }
      bucket.count += 1
      // 表不能跟着账号数无限长：超过上限就把过期的桶清掉，还超就丢最旧的
      if (buckets.size > maxKeys) {
        for (const [id, entry] of buckets) {
          if (at - entry.start >= windowMs) buckets.delete(id)
        }
        while (buckets.size > maxKeys) {
          const oldest = buckets.keys().next().value
          if (oldest === undefined) break
          buckets.delete(oldest)
        }
      }
      return { ok: true, remaining: max - bucket.count }
    },
    size() {
      return buckets.size
    },
  }
}

// 整机名额：满了先排队等一会儿（封面图小、抓得快，等 5 秒通常够），等不到才拒。
// 名额直接转交，不在 release 之后重新竞争——否则排队的请求会被新来的插队。
export function createSemaphore(max = 4) {
  if (!max || max <= 0) {
    // 0 = 不限：不做计数，acquire 永远成功，release 是空操作
    return { acquire: () => Promise.resolve(true), release: () => {}, get active() { return 0 }, get waiting() { return 0 } }
  }
  let active = 0
  const waiting = []
  return {
    get active() {
      return active
    },
    get waiting() {
      return waiting.length
    },
    acquire(timeoutMs = 0) {
      if (active < max) {
        active += 1
        return Promise.resolve(true)
      }
      if (!timeoutMs || timeoutMs <= 0) return Promise.resolve(false)
      return new Promise((resolve) => {
        const waiter = { resolve, timer: null, done: false }
        const finish = (ok) => {
          if (waiter.done) return
          waiter.done = true
          if (waiter.timer) clearTimeout(waiter.timer)
          resolve(ok)
        }
        // 计时器不要 unref：靠 unref 的计时器兑现的 Promise，在事件循环里没有别的活时
        // 会永远挂着（CI 的 Node 22 上就是这句「Promise resolution is still pending」）。
        // 服务进程本来一直有活，这 5 秒不差这一点。
        waiter.timer = setTimeout(() => {
          const index = waiting.indexOf(waiter)
          if (index >= 0) waiting.splice(index, 1)
          finish(false)
        }, timeoutMs)
        waiter.resolve = (ok) => finish(ok)
        waiting.push(waiter)
      })
    },
    release() {
      const next = waiting.shift()
      if (next) {
        // 名额转交：active 不变，谁先排谁先拿到
        next.resolve(true)
        return
      }
      if (active > 0) active -= 1
    },
  }
}
