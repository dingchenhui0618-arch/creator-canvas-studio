// 素材占用的上限（v0.9.68）：积分管「能花多少」，这一层管「能占多少磁盘」。
//
// 为什么要有：一次复刻会在服务器上留下十几帧图片，一个账号复刻几十条就是几百兆。
// 磁盘写满时坏的不只是这个账号——SQLite 与备份同盘，写不进去会连带整站停摆。
// 所以到顶之后直接不接新任务（429），而不是等磁盘满了再一起出事。
//
// 三个刻意的决定：
//   1. 默认 0 = 不限：上限是运营决定，没定之前不偷偷替用户设死；
//   2. 只算「自己的模板」：公共示例（ownerId 为空）不记在任何账号头上；
//   3. 只在任务入口拦一道：一次任务要写多少兆事先不知道，估个数反而会拦错，
//      所以口径是「已经到顶就不再接新的」——超出的那一单不会发生，账也不扣。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { findUserById, listUsers } from './auth.mjs'

const file = path.join(config.dataDir, 'storage-limits.json')
// 上限单位是 MB，1 TB 封顶：再大就不是「限制」而是打错了一个数。
const MAX_MB = 1_048_576
const MB = 1024 * 1024
let cache = null

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    cache = parsed && typeof parsed === 'object' ? parsed : { defaultMb: 0, overrides: {} }
  } catch {
    cache = { defaultMb: 0, overrides: {} }
  }
  if (!cache.overrides || typeof cache.overrides !== 'object') cache.overrides = {}
  return cache
}

function persist(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  cache = data
}

function cleanMb(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const int = Math.trunc(num)
  if (int !== num) return null
  if (int < 0 || int > MAX_MB) return null
  return int
}

export function formatSize(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 * MB) return (value / (1024 * MB)).toFixed(2) + ' GB'
  if (value >= MB) return (value / MB).toFixed(1) + ' MB'
  if (value >= 1024) return Math.round(value / 1024) + ' KB'
  return value + ' B'
}

/** 上限配置：默认值 + 按账号覆盖，0 表示不限。 */
export function storageLimits() {
  const data = load()
  return {
    defaultMb: cleanMb(data.defaultMb) || 0,
    overrides: { ...data.overrides },
    updatedAt: String(data.updatedAt || ''),
    updatedBy: String(data.updatedBy || ''),
  }
}

function limitFor(userId, data = storageLimits()) {
  const hasOverride = Boolean(userId) && Object.prototype.hasOwnProperty.call(data.overrides, String(userId))
  const current = hasOverride ? cleanMb(data.overrides[String(userId)]) : null
  const limitMb = current === null ? data.defaultMb : current
  return { limitMb: limitMb > 0 ? limitMb : 0, overridden: current !== null, unlimited: !(limitMb > 0) }
}

async function dirSize(dir) {
  let bytes = 0
  let files = 0
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true, recursive: true })
  } catch {
    return { bytes: 0, files: 0 }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const info = await fsp.stat(path.join(entry.parentPath || dir, entry.name))
      bytes += info.size
      files += 1
    } catch {
      // 统计期间被删掉的文件不计入
    }
  }
  return { bytes, files }
}

// 模板清单直接读文件：这一层只读、不改，不必碰模板库的写队列与缓存。
async function readTemplates() {
  try {
    const parsed = JSON.parse(await fsp.readFile(config.templatesFile, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 每个模板目录的真实占用，按归属汇总；再挑出「没有任何模板指向」的目录。 */
async function framesUsage() {
  const templates = await readTemplates()
  const known = new Map()
  for (const item of templates) known.set(String(item.id), item)
  const dirs = []
  let entries = []
  try {
    entries = await fsp.readdir(config.framesDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!/^tpl_[\w-]+$/.test(entry.name)) continue
    const size = await dirSize(path.join(config.framesDir, entry.name))
    const template = known.get(entry.name)
    dirs.push({
      id: entry.name,
      bytes: size.bytes,
      files: size.files,
      ownerId: template ? String(template.ownerId || '') : '',
      shared: template ? Boolean(template.shared) : false,
      template: Boolean(template),
      title: template ? String(template.title || '') : '',
    })
  }
  const byOwner = new Map()
  for (const dir of dirs) {
    if (!dir.template) continue
    if (dir.shared || !dir.ownerId) continue
    byOwner.set(dir.ownerId, (byOwner.get(dir.ownerId) || 0) + dir.bytes)
  }
  const totalBytes = dirs.reduce((sum, dir) => sum + dir.bytes, 0)
  const totalFiles = dirs.reduce((sum, dir) => sum + dir.files, 0)
  const orphans = dirs.filter((dir) => !dir.template)
  return {
    dirs,
    byOwner,
    bytes: totalBytes,
    files: totalFiles,
    sharedBytes: dirs.filter((dir) => dir.template && (dir.shared || !dir.ownerId)).reduce((sum, dir) => sum + dir.bytes, 0),
    orphanBytes: orphans.reduce((sum, dir) => sum + dir.bytes, 0),
    orphans,
  }
}

/**
 * 一个账号的素材占用视图。unlimited 时 remainingBytes 为 null——
 * 前端据此显示「未设上限」，不编一个假余量。
 */
export async function storageOf(userId, usage = null) {
  const data = storageLimits()
  const own = usage || (await framesUsage())
  const bytes = userId ? own.byOwner.get(String(userId)) || 0 : 0
  const limit = limitFor(userId, data)
  const limitBytes = limit.unlimited ? 0 : limit.limitMb * MB
  return {
    bytes,
    limitMb: limit.limitMb,
    limitBytes,
    unlimited: limit.unlimited,
    overridden: limit.overridden,
    remainingBytes: limit.unlimited ? null : Math.max(0, limitBytes - bytes),
    over: !limit.unlimited && bytes >= limitBytes,
    percent: limit.unlimited ? null : Math.min(100, Math.round((bytes / Math.max(1, limitBytes)) * 100)),
  }
}

function refundMessage(view) {
  return (
    '素材占用已到上限：已用 ' + formatSize(view.bytes) + '，上限 ' + view.limitMb + ' MB。' +
    '一次复刻要往服务器写十几帧图片，所以到顶后不再接新任务（这一单不扣积分）。' +
    '删掉不用的模板（回收站里的也要彻底删除）就能继续；管理员可以在后台「系统 → 素材占用上限」给这个账号单独放宽。'
  )
}

/** 任务入口的闸门：已经到顶就整单不做，不扣积分、也不调上游。 */
export async function storageRoom(userId) {
  const view = await storageOf(userId)
  if (view.unlimited || !view.over) return { ok: true, ...view }
  return { ok: false, code: 'STORAGE_LIMIT', message: refundMessage(view), ...view }
}

/** 后台视图：磁盘、按账号占用、公共示例、孤立目录、当前上限。 */
export async function storageOverview() {
  const usage = await framesUsage()
  const data = storageLimits()
  const users = listUsers()
  const accounts = users
    .map((user) => {
      const bytes = usage.byOwner.get(user.id) || 0
      const limit = limitFor(user.id, data)
      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        kind: user.kind,
        active: user.active,
        templates: usage.dirs.filter((dir) => dir.template && dir.ownerId === user.id).length,
        bytes,
        limitMb: limit.limitMb,
        unlimited: limit.unlimited,
        overridden: limit.overridden,
        over: !limit.unlimited && bytes >= limit.limitMb * MB,
      }
    })
    .sort((a, b) => b.bytes - a.bytes || String(a.email).localeCompare(String(b.email)))
  return {
    frames: { bytes: usage.bytes, files: usage.files, dirs: usage.dirs.length },
    shared: { bytes: usage.sharedBytes },
    orphans: {
      count: usage.orphans.length,
      bytes: usage.orphanBytes,
      ids: usage.orphans.slice(0, 20).map((dir) => dir.id),
    },
    accounts,
    limits: { ...data, file: file },
    checkedAt: new Date().toISOString(),
  }
}

/** 清掉没有任何模板指向的帧图目录：模板记录已经删了，图还占着盘。 */
export async function cleanOrphanFrames() {
  const usage = await framesUsage()
  let bytes = 0
  const removed = []
  for (const dir of usage.orphans) {
    try {
      await fsp.rm(path.join(config.framesDir, dir.id), { recursive: true, force: true })
      removed.push(dir.id)
      bytes += dir.bytes
    } catch {
      // 删不掉的留着，下一次再试
    }
  }
  return { dirs: removed.length, bytes, ids: removed }
}

// ---- 后台维护 ----

export function saveStorageLimit(defaultMb, by = '') {
  const value = cleanMb(defaultMb)
  if (value === null) return { ok: false, error: '默认上限要写 0–' + MAX_MB + ' 的整数（0 表示不限）' }
  const data = load()
  persist({
    ...data,
    defaultMb: value,
    overrides: { ...data.overrides },
    updatedAt: new Date().toISOString(),
    updatedBy: String(by || ''),
  })
  return { ok: true, ...storageLimits() }
}

export function setStorageOverride(userId, mb, by = '') {
  const target = String(userId || '')
  if (!target) return { ok: false, code: 'NOT_FOUND', error: '没有这个账号' }
  if (!findUserById(target)) return { ok: false, code: 'NOT_FOUND', error: '这个账号不存在（可能已被删除）' }
  const value = cleanMb(mb)
  if (value === null) return { ok: false, error: '单独上限要写 0–' + MAX_MB + ' 的整数（0 表示不限）' }
  const data = load()
  persist({ ...data, overrides: { ...data.overrides, [target]: value }, updatedAt: new Date().toISOString(), updatedBy: String(by || '') })
  return { ok: true, ...storageLimits() }
}

export function clearStorageOverride(userId) {
  const target = String(userId || '')
  const data = load()
  if (!Object.prototype.hasOwnProperty.call(data.overrides, target)) {
    return { ok: false, code: 'NOT_FOUND', error: '这个账号没有单独上限（走的是默认上限）' }
  }
  const overrides = { ...data.overrides }
  delete overrides[target]
  persist({ ...data, overrides, updatedAt: new Date().toISOString() })
  return { ok: true, ...storageLimits() }
}

/** 测试用：扔掉缓存，下一次读文件。 */
export function resetStorageCache() {
  cache = null
}
