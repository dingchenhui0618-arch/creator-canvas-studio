// 无限画布的归属（r214）：画布是独立应用，它的 workspace 是全局的、文件里没有「谁建的」。
// 不补这一层，作品流就会把别人画布里的图端给当前账号看——那是越权，不是「被打通」。
//
// 真源是 DATA_DIR/canvas-owners.json：画布 id -> 第一个从 VisionQA 认领它的账号。
// 只有三种写入：VisionQA 新建画布、从 #/board/<id> 打开它、后台管理员显式认领；
// 认领是一次性的（先到先得），后来的人不能把别人的画布抢走。
// 没有任何记录的老画布只有管理员看得到：宁可少给，也不默认共享。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'

const MAX_OWNERS = 2000
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

function ownersFile() {
  return path.join(config.dataDir, 'canvas-owners.json')
}

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(ownersFile(), 'utf8'))
    const owners = raw && typeof raw.owners === 'object' && raw.owners ? raw.owners : {}
    const out = {}
    for (const [id, value] of Object.entries(owners)) {
      if (!ID_RE.test(id) || !value || typeof value !== 'object') continue
      const ownerId = String(value.ownerId || '')
      if (!ownerId) continue
      out[id] = { ownerId, at: Number(value.at) || 0, by: String(value.by || '') }
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(owners) {
  const file = ownersFile()
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const entries = Object.entries(owners)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_OWNERS)
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, owners: Object.fromEntries(entries) }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 上不生效，不影响正确性 */ }
}

export function canvasOwnerId(canvasId) {
  const id = String(canvasId || '')
  if (!ID_RE.test(id)) return ''
  return readAll()[id]?.ownerId || ''
}

/**
 * 认领一块画布。先到先得：已有主人时原样返回它，不覆盖。
 * 返回 { ok, ownerId, claimed }，claimed 表示这次真的写进去了。
 */
export function claimCanvas(canvasId, userId, by = '') {
  const id = String(canvasId || '')
  const uid = String(userId || '')
  if (!ID_RE.test(id) || !uid) return { ok: false, error: '画布或账号不合法' }
  const owners = readAll()
  const existing = owners[id]
  if (existing && existing.ownerId !== uid) {
    return { ok: true, ownerId: existing.ownerId, claimed: false }
  }
  if (existing && existing.ownerId === uid) return { ok: true, ownerId: uid, claimed: false }
  owners[id] = { ownerId: uid, at: Date.now(), by: String(by || '').slice(0, 40) }
  writeAll(owners)
  return { ok: true, ownerId: uid, claimed: true }
}

/** 管理员可以把一块无主/自己的画布改派给别人；有主人时不会静默抢。 */
export function assignCanvas(canvasId, userId, by = '') {
  return claimCanvas(canvasId, userId, by)
}

export function isCanvasAdmin(user) {
  return Boolean(user && user.kind === 'admin')
}

/**
 * 这个账号能看到的画布：管理员看全部；其他人只看自己认领过的。
 * 无主的老画布只给管理员——见文件头的取舍。
 */
export function visibleCanvases(user, canvases) {
  const list = Array.isArray(canvases) ? canvases : []
  if (isCanvasAdmin(user)) return list
  const owners = readAll()
  return list.filter((canvas) => owners[String(canvas.id || '')]?.ownerId === String(user?.id || ''))
}
