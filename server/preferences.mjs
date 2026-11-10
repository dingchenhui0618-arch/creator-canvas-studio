// 账号级偏好：目前只有「首选模型」。
// 存服务端的目的：换浏览器、换设备仍然是同一个模型；顶栏下拉不再只是写 localStorage。
// 文件很小（每个账号一条），读多写少；写用临时文件 + rename，避免半截 JSON。
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'

const file = path.join(config.dataDir, 'preferences.json')
let cache = null

function emptyStore() {
  return { users: {} }
}

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    cache = parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object' ? parsed : emptyStore()
  } catch {
    // 文件不存在或内容损坏：按空表处理，不阻塞登录和界面
    cache = emptyStore()
  }
  return cache
}

function persist(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function preferenceOf(userId) {
  const id = String(userId || '')
  const entry = id ? load().users[id] : null
  return {
    model: entry && entry.model ? String(entry.model).slice(0, 120) : '',
    updatedAt: entry && entry.updatedAt ? String(entry.updatedAt) : null,
  }
}

// 给模型调用兜底：请求没指定模型、智能体本身也没绑模型时，用账号偏好。
export function preferenceModel(userId) {
  return preferenceOf(userId).model
}

export function setPreference(userId, patch = {}) {
  const id = String(userId || '').trim()
  if (!id) return preferenceOf('')
  const data = load()
  const current = data.users[id] || {}
  const next = { ...current, updatedAt: new Date().toISOString() }
  if (patch.model !== undefined) next.model = String(patch.model || '').trim().slice(0, 120)
  data.users[id] = next
  persist(data)
  return preferenceOf(id)
}
