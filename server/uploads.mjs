// 用户自己传的图：评审之前先把图落盘，之后评审走的是同一条「本地素材」链路。
//
// 为什么需要它：在这之前，评审只能评「已经躺在数据目录里的图」（模板首帧、画布帧）或一个公网图片地址。
// 而作品页那句「把这一版要发的画面贴进来最准」一直是个空承诺——没有入口能把图放进来。
// 对做视觉 QA 的人来说，最自然的一步恰恰是「我有一张图，你帮我看看」，这一步不该要求先建作品、先出图。
//
// 四条边界（都是「宁可拒，不要留坑」）：
//  1) 只认 jpg / png / webp，按文件头认，不看扩展名、也不信 Content-Type——改名的 html / svg 进不来；
//  2) 单张 ≤ 8 MB，与评审入口同一个上限（评审要把图读成 base64，这条上限决定堆用多少）；
//  3) 图只属于传的人：路径里带账号 id，读的时候按归属校验，管理员除外；不公开、不进分享页；
//  4) 每个账号只留 20 张（合计 ≤ 160 MB），再传就顶掉最旧的——没有任何清理入口时，
//     无上限等于把磁盘交给上传的人。顶掉之后旧评审记录还在，只是那张原图可能已经没了（评审页本来就按这个情况写文案）。
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { refusal } from './public-error.mjs'

const MB = 1024 * 1024

export const UPLOAD_LIMITS = {
  // 与 server/routes/review.mjs 的 MAX_MEDIA_BYTES 同一口径：一张图读进内存要变成 base64（约 1.37 倍），
  // 8 MB 的原图在评审那一侧已经是几份副本了，再大就不该从这条入口进来。
  maxBytes: 8 * MB,
  maxFiles: 20,
  maxTotalBytes: 160 * MB,
}

export const UPLOAD_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

// 只认这三种：浏览器截图是 png，相机 / 导出是 jpg，手机相册常给 webp。
// 文件头而不是扩展名：把 .html 改名成 .jpg、或 Content-Type 写成 image/jpeg，都过不了这里。
const SIGNATURES = [
  { ext: 'jpg', test: (buffer) =>
    buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  { ext: 'png', test: (buffer) =>
    buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a },
  { ext: 'webp', test: (buffer) =>
    buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' },
]

/** 认文件头：返回 { ext, mime } 或 null（null = 这不是一张我们能评的图）。 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null
  for (const item of SIGNATURES) {
    if (item.test(buffer)) return { ext: item.ext, mime: UPLOAD_MIME[item.ext] }
  }
  return null
}

/** 账号 id 只允许由字母数字下划线横线组成：路径里要拼它，先把它钉死。 */
export function safeUserId(value) {
  const id = String(value ?? '')
  return /^[A-Za-z0-9_-]{3,64}$/.test(id) ? id : ''
}

/** 文件名是服务端起的：时间戳 + 随机串 + 扩展名。读的时候只认这个形状，不做任何路径拼接。 */
const FILE_PATTERN = /^(\d{10,16})-([0-9a-f]{8,24})\.(jpg|png|webp)$/

export function safeFileName(value) {
  const name = String(value ?? '')
  return FILE_PATTERN.test(name) ? name : ''
}

export function uploadsRoot() {
  return path.join(config.dataDir, 'uploads')
}

export function uploadDirFor(userId) {
  const id = safeUserId(userId)
  if (!id) throw refusal(400, 'UPLOAD_USER', '上传的归属账号不对')
  return path.join(uploadsRoot(), id)
}

/** 一个人的上传占用：页面据此说明「还能传几张」。读不到目录就是 0，不编数字。 */
export async function uploadUsage(userId) {
  const empty = { files: 0, bytes: 0, maxFiles: UPLOAD_LIMITS.maxFiles, maxBytes: UPLOAD_LIMITS.maxBytes, maxTotalBytes: UPLOAD_LIMITS.maxTotalBytes }
  const id = safeUserId(userId)
  if (!id) return empty
  let entries = []
  try {
    entries = await fsp.readdir(uploadDirFor(id), { withFileTypes: true })
  } catch {
    return empty
  }
  let files = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isFile() || !safeFileName(entry.name)) continue
    try {
      const stat = await fsp.stat(path.join(uploadsRoot(), id, entry.name))
      files += 1
      bytes += stat.size
    } catch {
      // 刚被顶掉：跳过
    }
  }
  return { files, bytes, maxFiles: UPLOAD_LIMITS.maxFiles, maxBytes: UPLOAD_LIMITS.maxBytes, maxTotalBytes: UPLOAD_LIMITS.maxTotalBytes }
}

/**
 * 顶掉最旧的几张，给新图腾位置：先按张数，再按总量。
 * 只动这个账号自己的目录；删的永远是自己的老图（最新的一张刚写进来，mtime 最大）。
 */
async function makeRoom(dir, { keepFiles, keepBytes }) {
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return { removed: 0 }
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !safeFileName(entry.name)) continue
    const target = path.join(dir, entry.name)
    try {
      const stat = await fsp.stat(target)
      files.push({ target, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      // 并发顶掉：跳过
    }
  }
  files.sort((a, b) => a.mtime - b.mtime)
  let total = files.reduce((sum, item) => sum + item.size, 0)
  let removed = 0
  let failures = 0
  while (files.length && (files.length > keepFiles || total > keepBytes)) {
    const oldest = files.shift()
    try {
      await fsp.rm(oldest.target, { force: true })
      total -= oldest.size
      removed += 1
    } catch {
      // 删不掉就不假装腾出了空间；连着删不掉就停手，别在一个死循环里把请求挂住
      failures += 1
      if (failures >= 3) break
    }
  }
  return { removed }
}

/**
 * 落盘一张上传的图。返回 media 相对路径（与模板帧同一套写法：相对数据目录），
 * 评审接口读 media 时不需要知道它是「模板帧」还是「用户传的」。
 */
export async function saveUpload({ userId, buffer }) {
  const id = safeUserId(userId)
  if (!id) throw refusal(400, 'UPLOAD_USER', '上传的归属账号不对')
  const size = Buffer.isBuffer(buffer) ? buffer.length : 0
  if (!size) throw refusal(400, 'UPLOAD_EMPTY', '没有收到图片内容：换一张图再试')
  if (size > UPLOAD_LIMITS.maxBytes) {
    const mb = Math.round((size / MB) * 10) / 10
    throw refusal(413, 'UPLOAD_TOO_LARGE', '这张图 ' + mb + ' MB，超过 ' + UPLOAD_LIMITS.maxBytes / MB + ' MB 上限：先压一下再传')
  }
  const type = sniffImage(buffer)
  if (!type) throw refusal(415, 'UPLOAD_TYPE', '只接受 jpg / png / webp 图片：这个文件按内容看不是这三种之一')

  const dir = uploadDirFor(id)
  await fsp.mkdir(dir, { recursive: true })
  // 留出这一张的位置：最多 maxFiles - 1 张、maxTotalBytes - 这张 字节
  const room = await makeRoom(dir, { keepFiles: UPLOAD_LIMITS.maxFiles - 1, keepBytes: Math.max(0, UPLOAD_LIMITS.maxTotalBytes - size) })
  const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.' + type.ext
  const target = path.join(dir, name)
  const tmp = target + '.tmp'
  await fsp.writeFile(tmp, buffer, { mode: 0o600 })
  await fsp.rename(tmp, target)
  const media = 'uploads/' + id + '/' + name
  return {
    media,
    imageUrl: '/media/' + media,
    bytes: size,
    mime: type.mime,
    replaced: room.removed,
    usage: await uploadUsage(id),
  }
}

/** 读一张上传图：归属与文件名都在这里钉死。返回 { file, mime } 或 null（不存在 / 不合法）。 */
export function resolveUpload(userId, fileName) {
  const id = safeUserId(userId)
  const name = safeFileName(fileName)
  if (!id || !name) return null
  const file = path.join(uploadsRoot(), id, name)
  return { file, mime: UPLOAD_MIME[name.split('.').pop()] || 'application/octet-stream' }
}

/** 最近传的几张（新的在前）；页面要「刚才那张」时才读，不缓存。 */
export async function listUploads(userId, limit = 8) {
  const id = safeUserId(userId)
  if (!id) return []
  const dir = path.join(uploadsRoot(), id)
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !safeFileName(entry.name)) continue
    try {
      const stat = await fsp.stat(path.join(dir, entry.name))
      rows.push({ name: entry.name, media: 'uploads/' + id + '/' + entry.name, imageUrl: '/media/uploads/' + id + '/' + entry.name, bytes: stat.size, at: stat.mtime.toISOString() })
    } catch {
      // 刚被顶掉：跳过
    }
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return rows.slice(0, Math.max(1, Math.min(40, Math.round(Number(limit) || 8))))
}
