// 读封存包里的目录与单个条目（v0.9.129）：只读，不解压到磁盘，也不写任何文件。
//
// 为什么自己读而不是装 jszip：封存包是我们自己用 zip-store.mjs 打的（store，不压缩），
// 目录就写在文件尾部的中央目录里，按偏移取一段就够。几十行读得完的代码，
// 比再引一个依赖更容易审：读进来的名字、大小、CRC 都来自包本身，不是另记一份。
//
// 边界：
//  - 只认我们写得出、也解得开的那两种压缩方式（0 = store、8 = deflate）；别的回 null，不猜；
//  - 条目大小、条目数、整包大小都有上限，超了如实说，不把整台机器的内存交给一个坏包；
//  - 目录读不出来就回 null（被截断 / 尾部被改），不拿中央目录之前的东西硬拼一份清单。
import { inflateRawSync } from 'node:zlib'
import { crc32 } from './zip-store.mjs'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const EOCD_MIN = 22
/** 尾记录后面可能跟一段注释（最多 65535 字节）：找 EOCD 时只往回扫这么远。 */
const EOCD_SCAN = EOCD_MIN + 0xffff
export const MAX_ENTRIES = 2000
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024

/**
 * 读包里的目录（中央目录）：只认条目名、字节数、CRC32、压缩方式与本地头偏移。
 * 不是 zip、被截断、写了 ZIP64 都回 null —— 读不出来比读出一份错的清单安全。
 */
export function readZipDirectory(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : null
  if (!data || data.length < EOCD_MIN) return null
  try {
    let eocd = -1
    const start = Math.max(0, data.length - EOCD_SCAN)
    for (let at = data.length - EOCD_MIN; at >= start; at -= 1) {
      if (data.readUInt32LE(at) === EOCD_SIG) {
        eocd = at
        break
      }
    }
    if (eocd < 0) return null
    const total = data.readUInt16LE(eocd + 10)
    const centralBytes = data.readUInt32LE(eocd + 12)
    const centralOffset = data.readUInt32LE(eocd + 16)
    // ZIP64：条目数或偏移写成 0xffff / 0xffffffff，这里不解释那套扩展
    if (total === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) return null
    if (total > MAX_ENTRIES) return null
    if (centralOffset + centralBytes > data.length) return null

    const entries = []
    let at = centralOffset
    for (let index = 0; index < total; index += 1) {
      if (at + 46 > data.length || data.readUInt32LE(at) !== CEN_SIG) return null
      const flags = data.readUInt16LE(at + 8)
      const method = data.readUInt16LE(at + 10)
      const crc = data.readUInt32LE(at + 16)
      const packed = data.readUInt32LE(at + 20)
      const bytes = data.readUInt32LE(at + 24)
      const nameBytes = data.readUInt16LE(at + 28)
      const extraBytes = data.readUInt16LE(at + 30)
      const commentBytes = data.readUInt16LE(at + 32)
      const offset = data.readUInt32LE(at + 42)
      if (at + 46 + nameBytes > data.length) return null
      const name = data.subarray(at + 46, at + 46 + nameBytes).toString('utf8')
      if (!name || name.includes('\\')) return null
      entries.push({
        index,
        name,
        bytes,
        packed,
        crc,
        method,
        offset,
        encrypted: Boolean(flags & 1),
      })
      at += 46 + nameBytes + extraBytes + commentBytes
    }
    return { entries, total }
  } catch {
    return null
  }
}

/**
 * 按目录里的一条取内容：只读这一段，解开后立刻验 CRC32。
 * crcOk 为 false 表示「这一条在包里就是坏的」——界面照实说，不把这堆字节当内容展示。
 */
export function readZipEntry(buffer, entry) {
  const data = Buffer.isBuffer(buffer) ? buffer : null
  if (!data || !entry || entry.encrypted) return null
  try {
    if (entry.offset + 30 > data.length || data.readUInt32LE(entry.offset) !== LOC_SIG) return null
    const nameBytes = data.readUInt16LE(entry.offset + 26)
    const extraBytes = data.readUInt16LE(entry.offset + 28)
    const start = entry.offset + 30 + nameBytes + extraBytes
    if (start + entry.packed > data.length) return null
    if (entry.packed > MAX_ENTRY_BYTES || entry.bytes > MAX_ENTRY_BYTES) return null
    const raw = data.subarray(start, start + entry.packed)
    const content = entry.method === 0 ? Buffer.from(raw) : entry.method === 8 ? inflateRawSync(raw) : null
    if (!content || content.length !== entry.bytes) return null
    return { data: content, bytes: content.length, crcOk: crc32(content) === entry.crc }
  } catch {
    return null
  }
}

/**
 * 按条目名找一条：名字来自地址，所以只认「目录里真有的那一个」。
 * 带 .. 的、空的、超长的直接不认——即便目录里恰好有一条同名，也不顺着它往上走。
 */
export function findZipEntry(entries, name) {
  const wanted = String(name ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim()
  if (!wanted || wanted.length > 200) return null
  const parts = wanted.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  const list = Array.isArray(entries) ? entries : []
  return list.find((entry) => entry.name === wanted) || null
}

/** 包里这一条是哪一类：界面据此决定拿图片、读文字，还是塞进沙箱 iframe。 */
export function entryKind(name) {
  const ext = String(name ?? '').toLowerCase().split('.').pop() || ''
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return 'image'
  if (['html', 'htm'].includes(ext)) return 'html'
  if (['txt', 'md', 'markdown', 'csv', 'json', 'log'].includes(ext)) return 'text'
  return 'other'
}

/** 按扩展名给 Content-Type：只发这几种，其余一律 application/octet-stream。 */
export function entryMime(name) {
  const ext = String(name ?? '').toLowerCase().split('.').pop() || ''
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'avif':
      return 'image/avif'
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8'
    case 'txt':
    case 'md':
    case 'markdown':
    case 'csv':
    case 'json':
    case 'log':
      return 'text/plain; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

/**
 * 档案里记的清单 vs 包里真有的条目（只比名字）：两边都是事实，差在哪就说哪。
 * 老包（v0.9.125 / v0.9.126 之前）没记清单，recorded 为 0 —— 那时不比较，也不把整包说成「多出来的」。
 */
export function compareManifest(entries, files) {
  const archivedNames = (Array.isArray(entries) ? entries : []).map((entry) => entry.name)
  const archived = new Set(archivedNames)
  const recorded = (Array.isArray(files) ? files : [])
    .map((file) => String(file?.name ?? ''))
    .filter(Boolean)
  const recordedSet = new Set(recorded)
  return {
    recorded: recorded.length,
    archived: archivedNames.length,
    missing: recorded.filter((name) => !archived.has(name)),
    extra: recorded.length ? archivedNames.filter((name) => !recordedSet.has(name)) : [],
  }
}
