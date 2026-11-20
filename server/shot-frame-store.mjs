// 分镜画面自己的库（r279）：工作流跑完按分镜画出来的图，贴回分镜时不再借用「上传素材」那 20 个位置。
//
// 为什么单独存（这是 r278 上线后实测出来的真问题，不是洁癖）：
//  r278 的回贴先 saveUpload 复制一份，而上传素材是每账号 20 张 / 160 MB 的环形空间，
//  超出就顶掉最早上传的那张。一条 8 镜的作品贴两次就占 16 张，一次回贴会无声顶掉
//  8 张「用户自己传进来准备评审的图」——评审记录还在，原图已经没了。
//  分镜画面不是「用户上传的东西」，它是工作流的产物，应该有自己的定额、自己的寿命。
//
// 三条边界：
//  1) 目录按账号 + 作品分开（shotframes/<账号>/<作品>/<文件>）：一条作品的画面不可能把别人的挤掉；
//  2) 只认服务端起的文件名（时间戳-随机串.jpg/png/webp）与文件头，别的一律不接受，路径不做拼接；
//  3) 每账号 800 张 / 1.2 GB 封顶，满了就明说，不悄悄删别人的画面。一条作品最多 60 个文件（分镜上限 48 镜留余量）。
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { refusal } from './public-error.mjs'
import { sniffImage, UPLOAD_MIME } from './uploads.mjs'
import { SHOT_MEDIA_STORE } from './project-shots.mjs'
import { writeFileAtomic } from './atomic-write.mjs'

const MB = 1024 * 1024

export const SHOT_FRAME_LIMITS = {
  // 与上传素材同一张图的上限：出图产物最大也就是几 MB，再大就不是我们要存的东西
  maxBytes: 8 * MB,
  // 一条作品最多留几个文件：分镜上限 48 镜，留一点余量给「换图那一刻」的短暂重叠
  maxProjectFiles: 60,
  // 一个账号的总量：真实用法是几十条作品 × 十几镜，800 张足够；封顶是为了不把磁盘交给它
  maxAccountFiles: 800,
  maxAccountBytes: 1200 * MB,
}

const ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/

/** 文件名形状：时间戳-随机串.扩展名。读的时候只认这个形状，绝不把请求里的字符串拼进路径。 */
export const SHOT_FRAME_FILE = /^(\d{10,16})-([0-9a-f]{8,24})\.(jpg|png|webp)$/

export function shotFramesRoot() {
  return path.join(config.dataDir, 'shotframes')
}

function storeId(value) {
  const id = String(value ?? '')
  return ID_PATTERN.test(id) ? id : ''
}

/** 画面目录：账号与作品都必须像编号，否则直接拒——路径里要拼它们。 */
export function shotFrameDirFor(userId, projectId) {
  const uid = storeId(userId)
  const pid = storeId(projectId)
  if (!uid || !pid) throw refusal(400, 'SHOT_STORE_ID', '画面的归属不对：账号或作品编号不合法')
  return path.join(shotFramesRoot(), uid, pid)
}

export function safeShotFrameName(value) {
  const name = String(value ?? '')
  return SHOT_FRAME_FILE.test(name) ? name : ''
}

/** 从 media 字符串里取文件名：只认 shotframes/<账号>/<作品>/<文件>，而且确实属于这个目录。 */
export function shotFrameFileName(media, userId, projectId) {
  const matched = String(media || '').match(SHOT_MEDIA_STORE)
  if (!matched) return ''
  if (storeId(userId) && matched[1] !== storeId(userId)) return ''
  if (storeId(projectId) && matched[2] !== storeId(projectId)) return ''
  return safeShotFrameName(matched[3])
}

async function listFiles(dir) {
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !safeShotFrameName(entry.name)) continue
    const file = path.join(dir, entry.name)
    try {
      const stat = await fsp.stat(file)
      files.push({ name: entry.name, file, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      // 刚被清掉：跳过
    }
  }
  return files
}

/** 这个账号的画面占了多少：设置页 / 满额提示据此说实数，不编数字。读不到就是 0。 */
export async function shotFrameUsage(userId) {
  const empty = {
    files: 0,
    bytes: 0,
    projects: 0,
    maxFiles: SHOT_FRAME_LIMITS.maxAccountFiles,
    maxBytes: SHOT_FRAME_LIMITS.maxAccountBytes,
    maxProjectFiles: SHOT_FRAME_LIMITS.maxProjectFiles,
  }
  const uid = storeId(userId)
  if (!uid) return empty
  let dirs = []
  try {
    dirs = await fsp.readdir(path.join(shotFramesRoot(), uid), { withFileTypes: true })
  } catch {
    return empty
  }
  let files = 0
  let bytes = 0
  let projects = 0
  for (const dir of dirs) {
    if (!dir.isDirectory() || !storeId(dir.name)) continue
    const rows = await listFiles(path.join(shotFramesRoot(), uid, dir.name))
    if (!rows.length) continue
    projects += 1
    for (const row of rows) {
      files += 1
      bytes += row.size
    }
  }
  return { files, bytes, projects, maxFiles: SHOT_FRAME_LIMITS.maxAccountFiles, maxBytes: SHOT_FRAME_LIMITS.maxAccountBytes, maxProjectFiles: SHOT_FRAME_LIMITS.maxProjectFiles }
}

/**
 * 按作品拆开看占用（r280）：只回编号与数字，作品标题由调用方去作品库拼。
 * 为什么要拆：封顶 800 张 / 1.2 GB 之后，只显示一个总数回答不了「是哪条作品占的」，
 * 用户想腾地方也没处下手。按字节从大到小排，一眼能看出该清哪一条。
 */
export async function shotFrameBreakdown(userId) {
  const uid = storeId(userId)
  const projects = []
  if (!uid) return { projects, files: 0, bytes: 0 }
  let dirs = []
  try {
    dirs = await fsp.readdir(path.join(shotFramesRoot(), uid), { withFileTypes: true })
  } catch {
    return { projects, files: 0, bytes: 0 }
  }
  let files = 0
  let bytes = 0
  for (const dir of dirs) {
    if (!dir.isDirectory() || !storeId(dir.name)) continue
    const rows = await listFiles(path.join(shotFramesRoot(), uid, dir.name))
    if (!rows.length) continue
    let size = 0
    let newest = 0
    for (const row of rows) {
      size += row.size
      if (row.mtime > newest) newest = row.mtime
    }
    files += rows.length
    bytes += size
    projects.push({
      projectId: dir.name,
      files: rows.length,
      bytes: size,
      newestAt: newest ? new Date(newest).toISOString() : '',
    })
  }
  projects.sort((a, b) => b.bytes - a.bytes || a.projectId.localeCompare(b.projectId))
  return { projects, files, bytes }
}

/**
 * 清空一条作品的画面目录（r280「一键清空」）。
 * 调用方必须先把作品记录里指向这些文件的镜头摘掉——顺序反了就会留下一批读不出来的破图。
 */
export async function clearProjectShotFrames(userId, projectId) {
  const uid = storeId(userId)
  const pid = storeId(projectId)
  if (!uid || !pid) return { removed: 0, bytes: 0 }
  const dir = path.join(shotFramesRoot(), uid, pid)
  const rows = await listFiles(dir)
  let bytes = 0
  for (const row of rows) bytes += row.size
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  return { removed: rows.length, bytes }
}

/**
 * 只清没人引用的文件（r280）：referenced = { [作品编号]: [media, ...] }，含回收站里那些作品。
 *
 * 什么时候会有孤儿：贴图时先写文件、再落记录，中间断掉（进程被杀、磁盘满）就留一张没人认的；
 * 或者作品被彻底删掉、目录却没删成。它们永远读不出来，却一直占着账号额度。
 * 回收站里的作品不算孤儿：恢复要连画面一起回来（所以调用方必须把回收站也算进 referenced）。
 */
export async function collectUnreferencedShotFrames({ userId, referenced = {} } = {}) {
  const uid = storeId(userId)
  if (!uid) return { removed: 0, bytes: 0 }
  let dirs = []
  try {
    dirs = await fsp.readdir(path.join(shotFramesRoot(), uid), { withFileTypes: true })
  } catch {
    return { removed: 0, bytes: 0 }
  }
  let removed = 0
  let bytes = 0
  for (const dir of dirs) {
    if (!dir.isDirectory() || !storeId(dir.name)) continue
    const pid = dir.name
    const names = new Set()
    for (const media of Array.isArray(referenced?.[pid]) ? referenced[pid] : []) {
      const name = shotFrameFileName(media, uid, pid)
      if (name) names.add(name)
    }
    const folder = path.join(shotFramesRoot(), uid, pid)
    for (const row of await listFiles(folder)) {
      if (names.has(row.name)) continue
      try {
        await fsp.rm(row.file, { force: true })
        removed += 1
        bytes += row.size
      } catch {
        // 删不掉就留着：下一轮再清，不能因为清理失败把整个操作判成失败
      }
    }
    // 目录空了就一起收掉：账号目录里留一堆空目录，下次按作品翻页会误以为还有东西
    try {
      const rest = await fsp.readdir(folder)
      if (!rest.length) await fsp.rmdir(folder).catch(() => {})
    } catch {
      // 目录已经不在了：正常
    }
  }
  return { removed, bytes }
}

/** 只数不清（r280 面板上那句「有 N 张没人引用」）：与清理用同一套判定，不另写一份。 */
export async function shotFrameOrphans({ userId, referenced = {} } = {}) {
  const uid = storeId(userId)
  if (!uid) return { files: 0, bytes: 0, projects: [] }
  let dirs = []
  try {
    dirs = await fsp.readdir(path.join(shotFramesRoot(), uid), { withFileTypes: true })
  } catch {
    return { files: 0, bytes: 0, projects: [] }
  }
  let files = 0
  let bytes = 0
  const projects = []
  for (const dir of dirs) {
    if (!dir.isDirectory() || !storeId(dir.name)) continue
    const pid = dir.name
    const names = new Set()
    for (const media of Array.isArray(referenced?.[pid]) ? referenced[pid] : []) {
      const name = shotFrameFileName(media, uid, pid)
      if (name) names.add(name)
    }
    let count = 0
    let size = 0
    for (const row of await listFiles(path.join(shotFramesRoot(), uid, pid))) {
      if (names.has(row.name)) continue
      count += 1
      size += row.size
    }
    if (!count) continue
    files += count
    bytes += size
    projects.push({ projectId: pid, files: count, bytes: size })
  }
  return { files, bytes, projects }
}

/** 一条作品的目录里只留还在用的文件：换掉的、撤销的、写了一半的都在这里清掉。 */
export async function sweepProjectShotFrames({ userId, projectId, keep = [] } = {}) {
  const uid = storeId(userId)
  const pid = storeId(projectId)
  if (!uid || !pid) return { removed: 0, kept: 0 }
  const dir = path.join(shotFramesRoot(), uid, pid)
  const names = new Set()
  for (const media of Array.isArray(keep) ? keep : []) {
    const name = shotFrameFileName(media, uid, pid)
    if (name) names.add(name)
  }
  let removed = 0
  for (const row of await listFiles(dir)) {
    if (names.has(row.name)) continue
    try {
      await fsp.rm(row.file, { force: true })
      removed += 1
    } catch {
      // 删不掉就留着，下一轮再清：不能因为清理失败把这次贴图判成失败
    }
  }
  return { removed, kept: names.size }
}

/**
 * 存一张画面：返回 media 相对路径（shotframes/<账号>/<作品>/<文件>）。
 * 满了（账号总量）就 409 明说，不顶掉任何别人的画面。
 */
export async function saveShotFrame({ userId, projectId, buffer }) {
  const uid = storeId(userId)
  const pid = storeId(projectId)
  if (!uid || !pid) throw refusal(400, 'SHOT_STORE_ID', '画面的归属不对：账号或作品编号不合法')
  const size = Buffer.isBuffer(buffer) ? buffer.length : 0
  if (!size) throw refusal(400, 'SHOT_EMPTY', '没有收到图片内容：这张画面没有贴上来')
  if (size > SHOT_FRAME_LIMITS.maxBytes) {
    const mb = Math.round((size / MB) * 10) / 10
    throw refusal(413, 'SHOT_TOO_LARGE', '这张画面 ' + mb + ' MB，超过 ' + SHOT_FRAME_LIMITS.maxBytes / MB + ' MB 上限')
  }
  const type = sniffImage(buffer)
  if (!type) throw refusal(415, 'SHOT_TYPE', '只接受 jpg / png / webp 图片：这个文件按内容看不是这三种之一')

  const usage = await shotFrameUsage(uid)
  if (usage.files + 1 > SHOT_FRAME_LIMITS.maxAccountFiles || usage.bytes + size > SHOT_FRAME_LIMITS.maxAccountBytes) {
    const mb = Math.round(usage.bytes / MB)
    throw refusal(
      409,
      'SHOT_STORE_FULL',
      '工作流画面存到上限了（已有 ' + usage.files + ' 张 / ' + mb + ' MB，上限 ' +
        SHOT_FRAME_LIMITS.maxAccountFiles + ' 张 / ' + SHOT_FRAME_LIMITS.maxAccountBytes / MB +
        ' MB）：到设置页的「工作流画面」点「管理」，清掉不用的作品画面，再回来贴',
    )
  }

  const dir = shotFrameDirFor(uid, pid)
  await fsp.mkdir(dir, { recursive: true })
  // 一条作品的文件数封顶：正常只会是「分镜数」个，超出的只会是没清掉的旧文件
  const existing = await listFiles(dir)
  if (existing.length >= SHOT_FRAME_LIMITS.maxProjectFiles) {
    existing.sort((a, b) => a.mtime - b.mtime)
    for (const row of existing.slice(0, existing.length - SHOT_FRAME_LIMITS.maxProjectFiles + 1)) {
      await fsp.rm(row.file, { force: true }).catch(() => {})
    }
  }
  const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.' + type.ext
  const target = path.join(dir, name)
  await writeFileAtomic(target, buffer)
  return {
    media: 'shotframes/' + uid + '/' + pid + '/' + name,
    imageUrl: '/media/shotframes/' + uid + '/' + pid + '/' + name,
    bytes: size,
    mime: type.mime || UPLOAD_MIME[type.ext],
  }
}

/** 读一张画面：归属、作品、文件名三样都在这里钉死。返回 { file, mime } 或 null。 */
export function resolveShotFrame(userId, projectId, fileName) {
  const uid = storeId(userId)
  const pid = storeId(projectId)
  const name = safeShotFrameName(fileName)
  if (!uid || !pid || !name) return null
  const file = path.join(shotFramesRoot(), uid, pid, name)
  return { file, mime: UPLOAD_MIME[name.split('.').pop()] || 'application/octet-stream' }
}

/** 删掉一张画面（只在「这一镜换图 / 撤销」后由 sweep 调用；不对外提供删除入口）。 */
export async function removeShotFrame(media) {
  const matched = String(media || '').match(SHOT_MEDIA_STORE)
  if (!matched) return false
  const target = resolveShotFrame(matched[1], matched[2], matched[3])
  if (!target) return false
  try {
    await fsp.rm(target.file, { force: true })
    return true
  } catch {
    return false
  }
}

/** 彻底删除一条作品时，它的画面一起走（回收站里的作品不动：恢复要连画面一起回来）。 */
export async function removeProjectShotFrames(userId, projectId) {
  const uid = storeId(userId)
  const pid = storeId(projectId)
  if (!uid || !pid) return 0
  const dir = path.join(shotFramesRoot(), uid, pid)
  const rows = await listFiles(dir)
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  return rows.length
}

/** 注销账号时：这个账号的画面整棵清掉。 */
export async function removeUserShotFrames(userId) {
  const uid = storeId(userId)
  if (!uid) return 0
  const dir = path.join(shotFramesRoot(), uid)
  const usage = await shotFrameUsage(uid)
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  return usage.files
}
