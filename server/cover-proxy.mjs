// 封面代理（/api/cover、分享页的封面）：抓一次就够，抓不到也有话说（v0.9.90）。
//
// 这里原来是 index.mjs 里的一段纯透传：每个请求各自去上游抓一次，整段读进内存（8MB 上限）。
// 一屏模板库 40 张封面，翻两次页就是 80 次上游请求；两个人同时翻，内存里十几份整图，
// 2 核 / 1.86GB 的机器上慢的是所有人的页面，极端时直接 OOM。
//
// 现在三层，各管一件事（状态都在 cover-cache.mjs 里，这里只做编排）：
//   缓存命中 → 直接回，不打上游、不吃限流（最便宜的那种请求）
//   要抓    → 先过按账号限流（每分钟几次），再过整机名额（同一刻几张在上游，满了排一会儿）
//   抓不到  → 记一笔负缓存，60 秒内同一个地址不再去上游
// 响应带一个 X-VQ-Cover: hit|miss|limited|busy|bad，排障时不用猜这张是从哪来的。

import { fetchPublic } from './media.mjs'
import { createCoverCache, createSemaphore, createWindowLimiter } from './cover-cache.mjs'

const IMAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122 Safari/537.36'
export const COVER_MAX_BYTES = 8 * 1024 * 1024

// 边读边数：以前是整段 arrayBuffer 之后再量大小——一张 500MB 的图会先被完整读进内存，
// 那个 8MB 上限等于没写。现在先看 Content-Length，超了立刻放弃；没有就以 maxBytes 为界边读边断。
export async function readImageBody(response, maxBytes = COVER_MAX_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) return null
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > maxBytes) {
      try {
        await response.body.cancel()
      } catch {
        // 已经中断了，取消失败不影响结论
      }
      return null
    }
    chunks.push(Buffer.from(chunk))
  }
  return chunks.length ? Buffer.concat(chunks) : null
}

// 小红书 / 抖音的封面常以 http 下发，而 CDN 只认 https + 对应站点的 Referer（实测 http 直连 403、https 200）。
// 所以先按原样试，失败再把协议升到 https 重试，都失败才返回 404。
// 走 fetchPublic：内网地址直接拒，重定向逐跳校验，带超时。
export async function fetchCoverImage(url) {
  const referer = /xhscdn|xiaohongshu/.test(url.host)
    ? 'https://www.xiaohongshu.com'
    : /douyinpic|douyin/.test(url.host)
      ? 'https://www.douyin.com'
      : url.origin
  const attempt = async (target) => {
    const { response } = await fetchPublic(target, {
      headers: { Referer: referer, 'User-Agent': IMAGE_UA },
      timeoutMs: 15000,
    })
    const type = response.headers.get('content-type') || ''
    if (!response.ok || !type.startsWith('image/')) return null
    const buffer = await readImageBody(response)
    if (!buffer) return null
    return { type, buffer }
  }
  const candidates = [url]
  if (url.protocol === 'http:') candidates.push(new URL('https://' + url.host + url.pathname + url.search))
  for (const candidate of candidates) {
    try {
      const hit = await attempt(candidate)
      if (hit) return hit
    } catch {
      // 换下一个候选
    }
  }
  return null
}

// 封面响应统一从这里出去：状态、缓存头、以及 X-VQ-Cover 这一个可观测的标记。
export function coverReply(res, status, body, { state, type, retryAfterSec } = {}) {
  const headers = {
    'Content-Type': status === 200 ? type || 'application/octet-stream' : 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    // 200 让浏览器也存一天（同一张封面不必每天来问一次）；429/503/404 一律不存，
    // 限流与忙是「过了一会儿就好」，被浏览器存住就劝人重开页面了。
    'Cache-Control': status === 200 ? 'public, max-age=86400' : 'no-store',
    'X-VQ-Cover': state || 'miss',
  }
  if (retryAfterSec) headers['Retry-After'] = String(retryAfterSec)
  res.writeHead(status, headers)
  res.end(body)
}

/**
 * 组装封面代理。fetchImage 可注入：单测里换成一个假的抓取器，
 * 就能在没有网络的情况下量「同一张抓几次」「同时几张在上游」。
 */
export function createCoverProxy({
  fetchImage = fetchCoverImage,
  perMinute = 120,
  concurrency = 4,
  waitMs = 5000,
  cacheEntries = 64,
  cacheBytes = 24 * 1024 * 1024,
  cacheTtlMs = 10 * 60 * 1000,
  negativeTtlMs = 60 * 1000,
  log = () => {},
} = {}) {
  const cache = createCoverCache({
    maxEntries: cacheEntries,
    maxBytes: cacheBytes,
    ttlMs: cacheTtlMs,
    negativeTtlMs,
  })
  const rate = createWindowLimiter({ max: perMinute, windowMs: 60 * 1000 })
  const slots = createSemaphore(concurrency)

  async function serve(res, target, cacheKey = 'anonymous') {
    let url
    try {
      url = new URL(target)
      if (!/^https?:$/.test(url.protocol)) throw new Error('bad protocol')
    } catch {
      return coverReply(res, 404, 'image unavailable', { state: 'bad' })
    }
    const key = url.href
    const cached = cache.get(key)
    if (cached) {
      // 缓存命中：不打上游、也不吃限流。一屏 40 张封面重复出现时走的就是这条。
      if (cached.status === 200) return coverReply(res, 200, cached.buffer, { state: 'hit', type: cached.type })
      return coverReply(res, 404, 'image unavailable', { state: 'hit' })
    }
    // 只有「要真去抓」的请求吃限流：上限是「每分钟抓几次上游」，不是「看几次封面」
    const allowed = rate.take(cacheKey)
    if (!allowed.ok) {
      log('cover.refused', { state: 'limited', host: url.host, retryAfterSec: allowed.retryAfterSec })
      return coverReply(res, 429, 'image unavailable', { state: 'limited', retryAfterSec: allowed.retryAfterSec })
    }
    const gotSlot = await slots.acquire(waitMs)
    if (!gotSlot) {
      log('cover.refused', { state: 'busy', host: url.host })
      return coverReply(res, 503, 'image unavailable', { state: 'busy', retryAfterSec: 2 })
    }
    try {
      const hit = await fetchImage(url)
      if (!hit) {
        // 抓不到也记一笔：一屏 40 张坏封面不该在每次渲染时各重试一遍
        cache.putMiss(key)
        return coverReply(res, 404, 'image unavailable', { state: 'miss' })
      }
      cache.put(key, hit)
      return coverReply(res, 200, hit.buffer, { state: 'miss', type: hit.type })
    } finally {
      slots.release()
    }
  }

  return {
    serve,
    stats: () => ({ ...cache.stats(), inFlight: slots.active, waiting: slots.waiting, accounts: rate.size() }),
  }
}
