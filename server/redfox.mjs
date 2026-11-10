import { config, redfoxEnabled } from './config.mjs'

const DOUYIN_SEARCH = '/story/api/dy/data/searchWork'
const XHS_SEARCH = '/story/api/xhs/search/search'
const DOWNLOAD_ENDPOINTS = {
  douyin: '/story/api/parseWork/videoDownload/douyin',
  xiaohongshu: '/story/api/parseWork/videoDownload/xiaohongshu',
}

// 红狐返回的封面常是 http，前端是 https 页面；这里先升级协议，代理层不再走一次 403
const httpsify = (value) => String(value || '').replace(/^http:\/\//i, 'https://')

const pick = (obj, keys, fallback = '') => {
  for (const key of keys) {
    const value = obj?.[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return fallback
}

const toNumber = (value) => {
  if (typeof value === 'number') return value
  if (!value) return 0
  const text = String(value).replace(/,/g, '').trim()
  const match = text.match(/^([\d.]+)\s*([万wW千万])?/)
  if (!match) return Number(text) || 0
  const base = Number(match[1])
  const unit = match[2]
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(base * 10000)
  if (unit === '千万') return Math.round(base * 10000000)
  return Math.round(base)
}

const slug = (text, index) => {
  const value = String(text || '').replace(/[^a-zA-Z0-9]/g, '')
  return value ? value.slice(0, 16) : 'item' + index
}

export function normalizeDouyin(raw, index = 0) {
  const url = pick(raw, ['opusUrl', 'workUrl', 'shareUrl', 'url'])
  // 红狐的 duration 是毫秒（68568 = 68.6 秒），统一折成秒
  const seconds = toNumber(pick(raw, ['duration', 'durationSec'], 0))
  return {
    id: pick(raw, ['awemeId', 'videoId', 'itemId', 'id']) || slug(url, index),
    platform: 'douyin',
    platformLabel: '抖音',
    title: pick(raw, ['content', 'title', 'desc']).trim(),
    author: pick(raw, ['authorName', 'nickname', 'author']),
    authorId: pick(raw, ['authorId', 'secUid', 'uid', 'authorUid']),
    authorFans: toNumber(pick(raw, ['authorFansCount', 'fansCount'], 0)) || null,
    avatar: pick(raw, ['authorAvatarUrl', 'avatar']),
    tags: Array.isArray(raw?.tagList) ? raw.tagList.map((tag) => String(tag?.tagName || tag?.name || tag)).filter(Boolean).slice(0, 8) : [],
    cover: httpsify(pick(raw, ['cover', 'coverUrl', 'imageUrl', 'cover_url'])),
    url,
    publishedAt: pick(raw, ['publishTime', 'createTime', 'publish_time']),
    durationSec: seconds > 1000 ? Math.round(seconds / 1000) : seconds || null,
    stats: {
      // 播放量只有抖音有；收藏、转发、评论三个都取，缺的按 0 显示，不做估算
      plays: toNumber(pick(raw, ['playCount', 'play_count', 'videoPlayCount', 'statistics.play_count'], 0)),
      likes: toNumber(pick(raw, ['likeCount', 'diggCount', 'likes'], 0)),
      comments: toNumber(pick(raw, ['commentCount', 'comments'], 0)),
      shares: toNumber(pick(raw, ['shareCount', 'shares'], 0)),
      collects: toNumber(pick(raw, ['collectCount', 'collects'], 0)),
    },
    mock: false,
  }
}

export function normalizeXhs(raw, index = 0) {
  // 红狐小红书的原文链接字段叫 shareInfoLink；评论/转发是复数形式（commentsCount / sharedCount）
  const url = pick(raw, ['noteUrl', 'shareInfoLink', 'url', 'link', 'shareUrl'])
  return {
    id: pick(raw, ['noteId', 'id']) || slug(url, index),
    platform: 'xiaohongshu',
    platformLabel: '小红书',
    title: pick(raw, ['title', 'displayTitle', 'desc', 'content']).trim(),
    author: pick(raw, ['authorNickname', 'authorName', 'nickname', 'userName', 'author']),
    authorId: pick(raw, ['authorId', 'userId', 'uid']),
    authorFans: toNumber(pick(raw, ['authorFans', 'fansCount'], 0)) || null,
    avatar: pick(raw, ['authorAvatar', 'avatar']),
    tags: [],
    cover: httpsify(pick(raw, ['cover', 'coverUrl', 'image', 'imageUrl'])),
    url,
    publishedAt: pick(raw, ['publishTime', 'createTime', 'publish_time']),
    durationSec: toNumber(pick(raw, ['duration', 'videoDuration'], 0)) || null,
    stats: {
      // 小红书没有播放量，互动量用平台自己的 interactiveCount（点赞+收藏+评论+分享）
      plays: 0,
      likes: toNumber(pick(raw, ['likedCount', 'likeCount', 'likes'], 0)),
      comments: toNumber(pick(raw, ['commentsCount', 'commentCount', 'comments'], 0)),
      shares: toNumber(pick(raw, ['sharedCount', 'shareCount', 'shares'], 0)),
      collects: toNumber(pick(raw, ['collectedCount', 'collectCount', 'collects'], 0)),
      interactions: toNumber(pick(raw, ['interactiveCount'], 0)) || null,
    },
    mock: false,
  }
}


// ── 限流 / 去重 / 缓存 ──────────────────────────────────────
// 红狐官方限制：抖音 10 次/秒、小红书 20 次/秒。超限会返回「接口调用过于频繁」，
// 这里在客户端排队，避免把上游打到 429。
// 实测：贴到上限（10/20 次/秒）连续打，Key 会被直接禁用（3105）。这里留足余量。
const RATE_LIMIT = { douyin: 4, xiaohongshu: 8, default: 4 }
const MAX_INFLIGHT = 2
const windows = new Map()
const inflightCount = new Map()
const blockedUntil = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function takeToken(platform) {
  const limit = RATE_LIMIT[platform] || RATE_LIMIT.default
  for (;;) {
    const now = Date.now()
    const hits = (windows.get(platform) || []).filter((time) => now - time < 1000)
    windows.set(platform, hits)
    const active = inflightCount.get(platform) || 0
    if (hits.length < limit && active < MAX_INFLIGHT) {
      hits.push(now)
      inflightCount.set(platform, active + 1)
      return () => inflightCount.set(platform, Math.max(0, (inflightCount.get(platform) || 1) - 1))
    }
    await sleep(120 + Math.random() * 120)
  }
}

const isBlocked = (error) => error?.redfoxCode === 3105 || /禁用|disabled/i.test(String(error?.message || ''))

const isRateLimit = (error) => error?.redfoxRate === true || /过于频繁|频繁|限流|too many|rate limit/i.test(String(error?.message || ''))

const CACHE_TTL = Number(process.env.REDFOX_CACHE_TTL_MS || 300000)
const cache = new Map()
const inflight = new Map()

function cacheKey(pathname, payload) {
  return pathname + '|' + JSON.stringify(payload)
}

async function withCache(key, producer) {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value
  if (inflight.has(key)) return inflight.get(key)
  const task = producer()
    .then((value) => {
      cache.set(key, { value, expires: Date.now() + CACHE_TTL })
      if (cache.size > 300) {
        for (const [staleKey, entry] of cache) {
          if (entry.expires <= Date.now()) cache.delete(staleKey)
        }
      }
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

export async function postJson(pathname, payload, headers = {}, options = {}) {
  const platform = options.platform || 'default'
  const blocked = blockedUntil.get(platform)
  if (blocked && blocked > Date.now()) {
    throw Object.assign(new Error('检索服务返回 3105（凭证不可用），暂停调用 ' + Math.ceil((blocked - Date.now()) / 1000) + ' 秒'), { redfoxCode: 3105, code: 'REDFOX_DISABLED' })
  }
  const key = cacheKey(pathname, payload)
  return withCache(key, async () => {
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const release = await takeToken(platform)
      try {
        return await requestOnce(pathname, payload, headers)
      } catch (error) {
        lastError = error
        // 永久错误：不重试，直接把状态记下来
        if (error?.code === 'REDFOX_QUOTA' || isBlocked(error)) {
          if (isBlocked(error)) blockedUntil.set(platform, Date.now() + 5 * 60 * 1000)
          error.code = isBlocked(error) ? 'REDFOX_DISABLED' : 'REDFOX_QUOTA'
          throw error
        }
        if (!isRateLimit(error) && !(error?.status >= 500)) throw error
        if (attempt === 1) break
        // 触限后长退避，避免把上游继续打爆
        await sleep(1500 + Math.random() * 700)
      } finally {
        release()
      }
    }
    throw lastError
  })
}

async function requestOnce(pathname, payload, headers) {
  const response = await fetch(config.redfox.baseUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  })
  const text = await response.text()
  if (!response.ok) {
    const error = new Error('检索接口 HTTP ' + response.status + '：' + text.slice(0, 160))
    error.status = response.status
    error.redfoxRate = response.status === 429
    throw error
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('检索接口返回的不是 JSON：' + text.slice(0, 120))
  }
  const code = json?.code
  const okCode = code === 2000 || code === 200 || code === undefined
  if (!okCode) {
    const message = json?.msg || json?.message || ('检索接口返回码 ' + code)
    const error = new Error(message)
    error.redfoxCode = code
    error.redfoxRate = /过于频繁|限流/.test(message)
    if (code === 3210) {
      error.code = 'REDFOX_QUOTA'
      error.rechargeUrl = 'https://redfox.hk/dashboard/recharge'
      error.quota = {
        amount: json?.data?.amount ?? null,
        goodsName: json?.data?.goodsName ?? '',
        cashierUrl: json?.data?.cashierUrl ?? '',
      }
    }
    throw error
  }
  return json
}

export async function searchMedia({ platform, keyword, startDate, endDate, pageNum = 1, pageSize = 24 }) {
  if (!redfoxEnabled()) throw Object.assign(new Error('检索服务未接入'), { code: 'NO_KEY' })
  const tasks = []
  if (platform === 'douyin' || platform === 'all') {
    tasks.push(postJson(DOUYIN_SEARCH, {
      keyword: keyword || '', source: config.redfox.source, pageNum, pageSize,
      ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}),
    }, { REDFOX_API_KEY: config.redfox.key }, { platform: 'douyin' }).then((json) => {
      const list = json?.data?.list || json?.data?.articles || []
      return { platform: 'douyin', items: list.map(normalizeDouyin), total: json?.data?.total ?? list.length }
    }))
  }
  if (platform === 'xiaohongshu' || platform === 'all') {
    tasks.push(postJson(XHS_SEARCH, {
      keyword: keyword || '', pageNum, pageSize, startDate: startDate || '', endDate: endDate || '', source: config.redfox.source,
    }, { 'X-API-KEY': config.redfox.key }, { platform: 'xiaohongshu' }).then((json) => {
      const list = json?.data?.articles || json?.data?.list || []
      return { platform: 'xiaohongshu', items: list.map(normalizeXhs), total: json?.data?.total ?? list.length }
    }))
  }
  const settled = await Promise.allSettled(tasks)
  const items = []
  const errors = []
  let total = 0
  let quota = null
  settled.forEach((entry) => {
    if (entry.status === 'fulfilled') { items.push(...entry.value.items); total += Number(entry.value.total) || 0 }
    else {
      errors.push(String(entry.reason?.message || entry.reason))
      if (entry.reason?.code === 'REDFOX_QUOTA') quota = entry.reason
    }
  })
  if (!items.length && quota) throw Object.assign(new Error(quota.message), { code: 'REDFOX_QUOTA', quota: quota.quota, rechargeUrl: quota.rechargeUrl })
  if (!items.length && errors.length) {
    if (errors.some((message) => /禁用|disabled/.test(message))) {
      throw Object.assign(new Error('检索服务返回 3105（凭证不可用），请到后台确认检索凭证状态'), { code: 'REDFOX_DISABLED' })
    }
    const rateLimited = errors.some((message) => /过于频繁|限流/.test(message))
    throw Object.assign(new Error(errors.join('；')), { code: rateLimited ? 'REDFOX_RATE' : 'REDFOX_ERROR' })
  }
  items.sort((a, b) => b.stats.likes - a.stats.likes)
  return { mode: 'live', items, total, errors }
}

export async function resolveVideoUrl(platform, pageUrl) {
  if (!redfoxEnabled()) throw Object.assign(new Error('检索服务未接入'), { code: 'NO_KEY' })
  const endpoint = DOWNLOAD_ENDPOINTS[platform]
  if (!endpoint) throw new Error('暂不支持的平台：' + platform)
  const json = await postJson(endpoint, { url: pageUrl, source: config.redfox.source }, {
    REDFOX_API_KEY: config.redfox.key, 'X-API-KEY': config.redfox.key,
  }, { platform })
  const data = json?.data || {}
  const resources = Array.isArray(data.resources) ? data.resources : []
  let downloadUrl = data.downloadUrl || data.videoUrl || ''
  for (const res of resources) {
    const url = res?.downloadUrl || res?.url
    if (url && (res?.type === 'video' || /\.mp4/.test(url))) { downloadUrl = downloadUrl || url }
  }
  if (!downloadUrl) throw new Error('检索服务未返回可下载的视频地址（' + (data.msg || json?.msg || '无资源') + '）')
  return { downloadUrl, title: data.desc || data.title || '', cover: data.cover || data.coverUrl || '', durationSec: Number(data.duration || 0) || null }
}
