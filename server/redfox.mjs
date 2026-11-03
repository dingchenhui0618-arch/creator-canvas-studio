import { config, redfoxEnabled } from './config.mjs'

const DOUYIN_SEARCH = '/story/api/dy/data/searchWork'
const XHS_SEARCH = '/story/api/xhs/search/search'
const DOWNLOAD_ENDPOINTS = {
  douyin: '/story/api/parseWork/videoDownload/douyin',
  xiaohongshu: '/story/api/parseWork/videoDownload/xiaohongshu',
}

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
  return {
    id: pick(raw, ['awemeId', 'itemId', 'id']) || slug(url, index),
    platform: 'douyin',
    platformLabel: '抖音',
    title: pick(raw, ['content', 'title', 'desc']).trim(),
    author: pick(raw, ['authorName', 'nickname', 'author']),
    authorId: pick(raw, ['authorId', 'secUid', 'uid']),
    cover: pick(raw, ['cover', 'coverUrl', 'imageUrl', 'cover_url']),
    url,
    publishedAt: pick(raw, ['publishTime', 'createTime', 'publish_time']),
    durationSec: toNumber(pick(raw, ['duration', 'durationSec'], 0)) || null,
    stats: {
      likes: toNumber(pick(raw, ['likeCount', 'diggCount', 'likes'], 0)),
      comments: toNumber(pick(raw, ['commentCount', 'comments'], 0)),
      shares: toNumber(pick(raw, ['shareCount', 'shares'], 0)),
      collects: toNumber(pick(raw, ['collectCount', 'collects'], 0)),
    },
    mock: false,
  }
}

export function normalizeXhs(raw, index = 0) {
  const url = pick(raw, ['noteUrl', 'url', 'link', 'shareUrl'])
  return {
    id: pick(raw, ['noteId', 'id']) || slug(url, index),
    platform: 'xiaohongshu',
    platformLabel: '小红书',
    title: pick(raw, ['title', 'displayTitle', 'content', 'desc']).trim(),
    author: pick(raw, ['authorName', 'nickname', 'userName', 'author']),
    authorId: pick(raw, ['authorId', 'userId', 'uid']),
    cover: pick(raw, ['cover', 'coverUrl', 'image', 'imageUrl']),
    url,
    publishedAt: pick(raw, ['publishTime', 'createTime', 'publish_time']),
    durationSec: toNumber(pick(raw, ['duration', 'videoDuration'], 0)) || null,
    stats: {
      likes: toNumber(pick(raw, ['likeCount', 'likedCount', 'likes'], 0)),
      comments: toNumber(pick(raw, ['commentCount', 'comments'], 0)),
      shares: toNumber(pick(raw, ['shareCount', 'shareCount'], 0)),
      collects: toNumber(pick(raw, ['collectCount', 'collectedCount', 'collects'], 0)),
    },
    mock: false,
  }
}

async function postJson(pathname, payload, headers = {}) {
  const response = await fetch(config.redfox.baseUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 400) } }
  if (!response.ok) throw new Error('红狐接口 HTTP ' + response.status + '：' + (json?.msg || text.slice(0, 200)))
  if (json?.code !== 2000 && Number(json?.code) !== 200) throw new Error('红狐接口返回 code=' + json?.code + '：' + (json?.msg || '未知错误'))
  return json
}

export async function searchMedia({ platform, keyword, startDate, endDate, pageNum = 1, pageSize = 24 }) {
  if (!redfoxEnabled()) throw Object.assign(new Error('未配置 REDFOX_API_KEY'), { code: 'NO_KEY' })
  const tasks = []
  if (platform === 'douyin' || platform === 'all') {
    tasks.push(postJson(DOUYIN_SEARCH, {
      keyword: keyword || '', source: config.redfox.source, pageNum, pageSize,
      ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}),
    }, { REDFOX_API_KEY: config.redfox.key }).then((json) => {
      const list = json?.data?.list || json?.data?.articles || []
      return { platform: 'douyin', items: list.map(normalizeDouyin), total: json?.data?.total ?? list.length }
    }))
  }
  if (platform === 'xiaohongshu' || platform === 'all') {
    tasks.push(postJson(XHS_SEARCH, {
      keyword: keyword || '', pageNum, pageSize, startDate: startDate || '', endDate: endDate || '', source: config.redfox.source,
    }, { 'X-API-KEY': config.redfox.key }).then((json) => {
      const list = json?.data?.articles || json?.data?.list || []
      return { platform: 'xiaohongshu', items: list.map(normalizeXhs), total: json?.data?.total ?? list.length }
    }))
  }
  const settled = await Promise.allSettled(tasks)
  const items = []
  const errors = []
  let total = 0
  settled.forEach((entry) => {
    if (entry.status === 'fulfilled') { items.push(...entry.value.items); total += Number(entry.value.total) || 0 }
    else errors.push(String(entry.reason?.message || entry.reason))
  })
  if (!items.length && errors.length) throw new Error(errors.join('；'))
  items.sort((a, b) => b.stats.likes - a.stats.likes)
  return { mode: 'live', items, total, errors }
}

export async function resolveVideoUrl(platform, pageUrl) {
  if (!redfoxEnabled()) throw Object.assign(new Error('未配置 REDFOX_API_KEY'), { code: 'NO_KEY' })
  const endpoint = DOWNLOAD_ENDPOINTS[platform]
  if (!endpoint) throw new Error('暂不支持的平台：' + platform)
  const json = await postJson(endpoint, { url: pageUrl, source: config.redfox.source }, {
    REDFOX_API_KEY: config.redfox.key, 'X-API-KEY': config.redfox.key,
  })
  const data = json?.data || {}
  const resources = Array.isArray(data.resources) ? data.resources : []
  let downloadUrl = data.downloadUrl || data.videoUrl || ''
  for (const res of resources) {
    const url = res?.downloadUrl || res?.url
    if (url && (res?.type === 'video' || /\.mp4/.test(url))) { downloadUrl = downloadUrl || url }
  }
  if (!downloadUrl) throw new Error('红狐未返回可下载的视频地址（' + (data.msg || json?.msg || '无资源') + '）')
  return { downloadUrl, title: data.desc || data.title || '', cover: data.cover || data.coverUrl || '', durationSec: Number(data.duration || 0) || null }
}
