// 参考素材：快捷创作里上传的「参考图片 / 参考视频」。
//
// 为什么不复用 server/uploads.mjs（评审那套）：
//  - 那套只认 jpg/png/webp、8 MB、20 张，且没有视频 —— 参考视频是生成的前提，这里必须有；
//  - 生成参考素材还要记住「这张图多宽多高、这段视频几秒」，界面上要如实显示拿什么去参考，
//    只存文件不存元信息，下拉里就只剩一串随机文件名。
//
// 四条边界（宁可拒，不要留坑）：
//  1) 只认文件头，不信扩展名、也不信 Content-Type；
//  2) 图片 ≤ 8 MB、视频 ≤ 48 MB；每个账号 60 个 / 400 MB，超了顶掉最旧的
//     —— 没有清理入口时，无上限等于把磁盘交给上传的人；
//  3) 素材只属于上传的人：目录里带账号 id，读的时候按归属校验，不进分享页、不进交付包；
//  4) 生成时也只认自己账号的素材，别的账号的 id 传进来一律当不存在。
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { refusal } from './public-error.mjs'
import { writeFileAtomic } from './atomic-write.mjs'

const MB = 1024 * 1024

export const ASSET_LIMITS = {
  imageBytes: 8 * MB,
  videoBytes: 48 * MB,
  maxFiles: 60,
  maxTotalBytes: 400 * MB,
  maxNameChars: 80,
}

// 只认这几种：截图是 png，相机/导出是 jpg，手机相册常给 webp，动图 gif；
// 视频是 mp4 / mov / webm。按文件头认，改名的 html / svg / exe 进不来。
const SIGNATURES = [
  { kind: 'image', ext: 'jpg', mime: 'image/jpeg', test: (buffer) =>
    buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  { kind: 'image', ext: 'png', mime: 'image/png', test: (buffer) =>
    buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a },
  { kind: 'image', ext: 'webp', mime: 'image/webp', test: (buffer) =>
    buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' },
  { kind: 'image', ext: 'gif', mime: 'image/gif', test: (buffer) =>
    buffer.length > 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a') },
  { kind: 'video', ext: 'mp4', mime: 'video/mp4', test: (buffer) =>
    buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '].includes(buffer.toString('ascii', 8, 12)) },
  { kind: 'video', ext: 'mov', mime: 'video/quicktime', test: (buffer) =>
    buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && buffer.toString('ascii', 8, 12) === 'qt  ' },
  { kind: 'video', ext: 'webm', mime: 'video/webm', test: (buffer) =>
    buffer.length > 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3 },
]

/** 认文件头：返回 { kind, ext, mime } 或 null（null = 这不是我们能拿去做参考的东西）。 */
export function sniffMedia(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null
  for (const item of SIGNATURES) {
    if (item.test(buffer)) return { kind: item.kind, ext: item.ext, mime: item.mime }
  }
  return null
}

/** 账号 id 只允许字母数字下划线横线：路径里要拼它，先钉死。 */
export function safeUserId(value) {
  const id = String(value ?? '')
  return /^[A-Za-z0-9_-]{3,64}$/.test(id) ? id : ''
}

export function assetRoot() {
  return path.join(config.dataDir, 'media', 'assets')
}

export function assetDirFor(userId) {
  const id = safeUserId(userId)
  if (!id) throw refusal(400, 'ASSET_USER', '素材的归属账号不对')
  return path.join(assetRoot(), id)
}

// 任务号与素材号都是服务端起的；读的时候只认这个形状，不做任何路径拼接。
const ID_PATTERN = /^ast_[a-z0-9]{8,20}_[a-z0-9]{4,12}$/
export function validAssetId(value) {
  return ID_PATTERN.test(String(value ?? '')) ? String(value) : ''
}

function clipName(value) {
  const raw = String(value || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()
  return (raw || '参考素材').slice(0, ASSET_LIMITS.maxNameChars)
}

function positiveNumber(value, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.min(Math.round(number * 100) / 100, max)
}

/** 给前端的形状：不暴露磁盘路径，只给一个需要登录的预览地址。 */
export function publicAsset(meta) {
  return {
    id: meta.id,
    kind: meta.kind,
    name: meta.name,
    mime: meta.mime,
    bytes: meta.bytes,
    width: meta.width || null,
    height: meta.height || null,
    duration: meta.duration || null,
    createdAt: meta.createdAt,
    previewUrl: '/api/media/assets/' + meta.id + '/file',
  }
}

async function writeMeta(dir, meta) {
  const target = path.join(dir, meta.id + '.json')
  await writeFileAtomic(target, JSON.stringify(meta, null, 2))
}

async function readMeta(dir, id) {
  if (!validAssetId(id)) return null
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dir, id + '.json'), 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.id === id ? parsed : null
  } catch {
    return null
  }
}

/** 顶掉最旧的几个，给新素材腾位置：只动这个账号自己的目录。 */
async function makeRoom(dir, { keepFiles, keepBytes }) {
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return { removed: 0 }
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -5)
    if (!validAssetId(id)) continue
    const meta = await readMeta(dir, id)
    if (!meta) continue
    files.push({ id, bytes: Number(meta.bytes) || 0, createdAt: String(meta.createdAt || '') })
  }
  files.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  let total = files.reduce((sum, item) => sum + item.bytes, 0)
  let removed = 0
  let failures = 0
  while (files.length && (files.length > keepFiles || total > keepBytes)) {
    const oldest = files.shift()
    try {
      await fsp.rm(path.join(dir, oldest.id + '.json'), { force: true })
      await fsp.rm(path.join(dir, oldest.id), { force: true })
      total -= oldest.bytes
      removed += 1
    } catch {
      failures += 1
      if (failures >= 3) break
    }
  }
  return { removed }
}

/**
 * 落盘一个参考素材。name / width / height / duration 都由调用方给（浏览器读出来的真实值），
 * 服务端只做形状与范围校验，不去猜 —— 猜出来的尺寸比没有尺寸更坏。
 */
export async function saveMediaAsset({ userId, buffer, name = '', width = null, height = null, duration = null }) {
  const id = safeUserId(userId)
  if (!id) throw refusal(400, 'ASSET_USER', '素材的归属账号不对')
  const size = Buffer.isBuffer(buffer) ? buffer.length : 0
  if (!size) throw refusal(400, 'ASSET_EMPTY', '没有收到文件内容：换一个再传')
  const type = sniffMedia(buffer)
  if (!type) {
    throw refusal(415, 'ASSET_TYPE', '只接受 jpg / png / webp / gif 图片与 mp4 / mov / webm 视频：这个文件按内容看都不是')
  }
  const limit = type.kind === 'image' ? ASSET_LIMITS.imageBytes : ASSET_LIMITS.videoBytes
  if (size > limit) {
    const mb = Math.round((size / MB) * 10) / 10
    throw refusal(413, 'ASSET_TOO_LARGE', '这个文件 ' + mb + ' MB，超过 ' + limit / MB + ' MB 上限：先压一下再传')
  }
  const dir = assetDirFor(id)
  await fsp.mkdir(dir, { recursive: true })
  const room = await makeRoom(dir, {
    keepFiles: ASSET_LIMITS.maxFiles - 1,
    keepBytes: Math.max(0, ASSET_LIMITS.maxTotalBytes - size),
  })
  const assetId = 'ast_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex')
  await fsp.writeFile(path.join(dir, assetId), buffer, { mode: 0o600 })
  const meta = {
    version: 1,
    id: assetId,
    ownerId: id,
    kind: type.kind,
    name: clipName(name),
    mime: type.mime,
    bytes: size,
    width: positiveNumber(width, 20000),
    height: positiveNumber(height, 20000),
    duration: positiveNumber(duration, 3600),
    createdAt: new Date().toISOString(),
    replaced: room.removed,
  }
  await writeMeta(dir, meta)
  return publicAsset(meta)
}

/** 我自己最近的参考素材：新的在前；读不到目录就是空，不编数字。 */
export async function listMediaAssets(userId, limit = 30) {
  const id = safeUserId(userId)
  if (!id) return []
  const dir = assetDirFor(id)
  let entries = []
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return []
  }
  const items = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const meta = await readMeta(dir, entry.slice(0, -5))
    if (meta) items.push(meta)
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return items.slice(0, Math.max(1, Math.min(60, Number(limit) || 30))).map(publicAsset)
}

/** 生成时读素材本体：只有归属账号本人能读，读不到就是不存在。 */
export async function readMediaAsset(userId, assetId) {
  const owner = safeUserId(userId)
  const id = validAssetId(assetId)
  if (!owner || !id) return null
  const dir = assetDirFor(owner)
  const meta = await readMeta(dir, id)
  if (!meta) return null
  try {
    const buffer = await fsp.readFile(path.join(dir, id))
    return { meta, buffer }
  } catch {
    return null
  }
}

/** 预览用的文件定位（返回路径与 mime，不读进内存）。 */
export async function locateMediaAsset(userId, assetId) {
  const owner = safeUserId(userId)
  const id = validAssetId(assetId)
  if (!owner || !id) return null
  const dir = assetDirFor(owner)
  const meta = await readMeta(dir, id)
  if (!meta) return null
  const file = path.join(dir, id)
  try {
    const stat = await fsp.stat(file)
    return { file, meta, size: stat.size }
  } catch {
    return null
  }
}

export async function removeMediaAsset(userId, assetId) {
  const owner = safeUserId(userId)
  const id = validAssetId(assetId)
  if (!owner || !id) return false
  const dir = assetDirFor(owner)
  const meta = await readMeta(dir, id)
  if (!meta) return false
  await fsp.rm(path.join(dir, id), { force: true })
  await fsp.rm(path.join(dir, id + '.json'), { force: true })
  return true
}

/** 这个账号的占用：页面据此说「还能传几个」。 */
export async function assetUsage(userId) {
  const empty = { files: 0, bytes: 0, maxFiles: ASSET_LIMITS.maxFiles, maxTotalBytes: ASSET_LIMITS.maxTotalBytes }
  const id = safeUserId(userId)
  if (!id) return empty
  const assets = await listMediaAssets(id, 60)
  return {
    files: assets.length,
    bytes: assets.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
    maxFiles: ASSET_LIMITS.maxFiles,
    maxTotalBytes: ASSET_LIMITS.maxTotalBytes,
  }
}
