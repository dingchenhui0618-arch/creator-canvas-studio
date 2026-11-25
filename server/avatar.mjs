// 账号头像（r313）：只存一张 256 方图，按账号 id 落盘。
//
// 边界：
//  1) 只认 PNG / JPEG / WebP 的文件头，不信扩展名，也不信 Content-Type；
//  2) 文件 ≤ 2 MB，图片在设置页已经裁成 256×256，这里只做服务端复核；
//  3) 落盘权限 0600，只有账号本人和管理员能读；别人一律 404，连存在性都不告诉；
//  4) 版本号存在 users.avatar_version，换图 / 删图都改它，前端 URL 带 ?v= 防缓存。
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { renameWithRetry } from './atomic-write.mjs'
import { refusal } from './public-error.mjs'
import { safeUserId, sniffMedia } from './media-assets.mjs'
import { avatarUrlFor, findUserById, setAvatarVersion } from './auth.mjs'

const MB = 1024 * 1024

export const AVATAR_LIMITS = {
  bytes: 2 * MB,
}

const ALLOWED = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['webp', 'image/webp'],
])

export function avatarRoot() {
  return path.join(config.dataDir, 'avatars')
}

function avatarDir() {
  return avatarRoot()
}

function validId(value) {
  return safeUserId(value)
}

async function locateFile(id) {
  for (const ext of ALLOWED.keys()) {
    const file = path.join(avatarDir(), id + '.' + ext)
    try {
      const stat = await fsp.stat(file)
      if (stat.isFile()) return { file, ext, mime: ALLOWED.get(ext), bytes: stat.size }
    } catch {
      // 这个扩展名没有文件，继续找下一种
    }
  }
  return null
}

/** 读接口要的头像视图：没有头像时 url 是空串，has 是 false。 */
export async function avatarView(userId) {
  const id = validId(userId)
  if (!id) return { has: false, url: '', version: '' }
  const row = findUserById(id)
  if (!row || !row.avatar_version) return { has: false, url: '', version: '' }
  const found = await locateFile(id)
  if (!found) return { has: false, url: '', version: '' }
  return { has: true, url: avatarUrlFor(id, row.avatar_version), version: String(row.avatar_version) }
}

/** 路由读文件用：只回已经校验过的路径、mime 与版本。 */
export async function avatarFile(userId) {
  const id = validId(userId)
  if (!id) return null
  const row = findUserById(id)
  if (!row || !row.avatar_version) return null
  const found = await locateFile(id)
  if (!found) return null
  return { ...found, version: String(row.avatar_version) }
}

/**
 * 上传并替换头像。mime 只是入参说明，真正认的是文件头；返回给前端的仍是 avatarView 的形状。
 */
export async function saveAvatar(userId, buffer, mime) {
  void mime
  const id = validId(userId)
  if (!id) throw refusal(400, 'AVATAR_USER', '头像的归属账号不对')
  const size = Buffer.isBuffer(buffer) ? buffer.length : 0
  if (!size) throw refusal(400, 'AVATAR_EMPTY', '没有收到图片内容：换一张再传')
  const type = sniffMedia(buffer)
  if (!type || !ALLOWED.has(type.ext)) {
    throw refusal(415, 'AVATAR_TYPE', '头像只支持 PNG / JPEG / WebP：这个文件按内容看都不是')
  }
  if (size > AVATAR_LIMITS.bytes) {
    const mb = Math.round((size / MB) * 10) / 10
    throw refusal(413, 'AVATAR_TOO_LARGE', '这张图 ' + mb + ' MB，超过 2 MB 上限：先裁小一点再传')
  }
  const row = findUserById(id)
  if (!row) throw refusal(404, 'AVATAR_USER', '账号不存在')

  const version = Date.now().toString(36) + crypto.randomBytes(5).toString('hex')
  const dir = avatarDir()
  await fsp.mkdir(dir, { recursive: true })
  const target = path.join(dir, id + '.' + type.ext)
  const temp = path.join(dir, '.' + id + '.' + type.ext + '.' + version + '.tmp')
  try {
    await fsp.writeFile(temp, buffer, { mode: 0o600 })
    // Windows 上 rename 覆盖同名文件可能被占用：先删旧图，再换上新图；
    // 换名仍然走 atomic-write 的重试（EPERM/EBUSY 在 Windows 上很常见）
    await fsp.rm(target, { force: true })
    await renameWithRetry(temp, target)
    await fsp.chmod(target, 0o600).catch(() => {})
    // 换格式时把旧扩展名那一张也清掉，目录里只留当前头像
    for (const ext of ALLOWED.keys()) {
      if (ext === type.ext) continue
      await fsp.rm(path.join(dir, id + '.' + ext), { force: true })
    }
    const updated = setAvatarVersion(id, version)
    if (!updated) {
      await fsp.rm(target, { force: true })
      throw refusal(404, 'AVATAR_USER', '账号不存在')
    }
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return avatarView(id)
}

/** 删除头像：文件和版本号一起清；本来没有头像也返回 false，不报错。 */
export async function removeAvatar(userId) {
  const id = validId(userId)
  if (!id) return false
  const row = findUserById(id)
  if (!row) return false
  const hadVersion = Boolean(row.avatar_version)
  let removed = false
  for (const ext of ALLOWED.keys()) {
    try {
      await fsp.rm(path.join(avatarDir(), id + '.' + ext), { force: false })
      removed = true
    } catch {
      // 没有这个扩展名的文件就跳过
    }
  }
  if (hadVersion) setAvatarVersion(id, '')
  return removed || hadVersion
}
