import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'

// 检索历史：谁搜过什么，按账号存，收藏的关键词不被裁剪。
// 只把关键词与筛选条件记下来，不存检索结果本身——结果会过期，重搜要重新花钱。

const CAP = 40 // 每个账号最多留多少条非收藏记录
const LIMIT = 14 // 界面一次最多给多少条

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const text = await fsp.readFile(config.searchHistoryFile, 'utf8')
    const parsed = JSON.parse(text)
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  return cache
}

function enqueueWrite(task) {
  const next = writeChain.then(task, task)
  writeChain = next.catch(() => {})
  return next
}

async function persist(list) {
  cache = list
  return enqueueWrite(async () => {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const tmp = config.searchHistoryFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    await fsp.rename(tmp, config.searchHistoryFile)
  })
}

const ownerOf = (user) => String(user?.id || '')

const sameQuery = (entry, next) =>
  entry.userId === next.userId &&
  entry.platform === next.platform &&
  entry.keyword === next.keyword &&
  entry.range === next.range

export async function recordSearch({ user, platform = 'all', keyword = '', range = '', sort = 'likes', total = 0 }) {
  const owner = ownerOf(user)
  const q = String(keyword || '').trim()
  if (!owner || !q) return null
  const list = await loadAll()
  const next = { userId: owner, platform, keyword: q, range, sort, total: Number(total) || 0, at: new Date().toISOString(), favorite: false }
  const index = list.findIndex((entry) => sameQuery(entry, next))
  let rest = list
  if (index >= 0) {
    const existing = list[index]
    next.id = existing.id
    next.favorite = Boolean(existing.favorite)
    rest = [...list.slice(0, index), ...list.slice(index + 1)]
  } else {
    next.id = 'sh_' + randomUUID().slice(0, 8)
  }
  const mine = rest.filter((entry) => entry.userId === owner)
  const others = rest.filter((entry) => entry.userId !== owner)
  const favorites = mine.filter((entry) => entry.favorite)
  const plain = mine.filter((entry) => !entry.favorite).slice(0, CAP - 1)
  await persist([next, ...favorites, ...plain, ...others])
  return next
}

export async function listSearchHistory(user, limit = LIMIT) {
  const owner = ownerOf(user)
  if (!owner) return []
  const list = await loadAll()
  const mine = list.filter((entry) => entry.userId === owner)
  mine.sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || String(b.at).localeCompare(String(a.at)))
  return mine.slice(0, limit)
}

export async function toggleSearchFavorite(user, id) {
  const owner = ownerOf(user)
  if (!owner || !id) return null
  const list = await loadAll()
  const index = list.findIndex((entry) => entry.id === id && entry.userId === owner)
  if (index < 0) return null
  const next = { ...list[index], favorite: !list[index].favorite }
  const copy = [...list]
  copy[index] = next
  await persist(copy)
  return next
}

// 清空只清「没收藏」的：收藏是用户主动留的，不该被一次清空带走
export async function clearSearchHistory(user) {
  const owner = ownerOf(user)
  if (!owner) return { removed: 0 }
  const list = await loadAll()
  const kept = list.filter((entry) => entry.userId !== owner || entry.favorite)
  const removed = list.length - kept.length
  await persist(kept)
  return { removed }
}
