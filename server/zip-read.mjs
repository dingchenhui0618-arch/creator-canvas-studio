// 读封存包里的目录、单条内容，以及整包逐条体检（v0.9.129 / v0.9.130）：只读，不解压到磁盘，也不写任何文件。
//
// 为什么自己读而不是装 jszip：封存包是我们自己用 zip-store.mjs 打的（store，不压缩），
// 目录就写在文件尾部的中央目录里，按偏移取一段就够。几十行读得完的代码，
// 比再引一个依赖更容易审：读进来的名字、大小、CRC 都来自包本身，不是另记一份。
//
// 两种读法（v0.9.130）：路由里已经把包读进内存时用内存那一路；整包体检、列目录用盘上的
// 只读句柄按偏移读，内存里最多只有一条，不把整包和它的解压结果一起摊在内存里。
//
// 边界：
//  - 只认我们写得出、也解得开的那两种压缩方式（0 = store、8 = deflate）；别的回 null，不猜；
//  - 条目大小、条目数、整包大小都有上限，超了如实说，不把整台机器的内存交给一个坏包；
//  - 体检另外记一个「解开过多少字节」的预算：条目小但条数多，乘起来照样能撑爆内存；
//  - 目录读不出来就回 null（被截断 / 尾部被改），不拿中央目录之前的东西硬拼一份清单。
import { readSync } from 'node:fs'
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
/** 一次体检最多解开这么多字节：条目大小上限管的是单条，条数乘起来还得有个总预算。 */
export const MAX_VERIFY_BYTES = 128 * 1024 * 1024

/** 内存里的整份：只在包已经读进内存时用（比如单条内容预览）。 */
function memorySource(buffer) {
  if (!Buffer.isBuffer(buffer)) return null
  return {
    size: buffer.length,
    read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > buffer.length) return null
      return buffer.subarray(offset, offset + length)
    },
  }
}

/** 盘上的只读句柄：按偏移读多少算多少；只读、不缓存、不写回。 */
function fdSource(fd, size, onRead) {
  const total = Math.max(0, Math.round(Number(size) || 0))
  return {
    size: total,
    read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > total) return null
      const buffer = Buffer.allocUnsafe(length)
      let got = 0
      while (got < length) {
        const n = readSync(fd, buffer, got, length - got, offset + got)
        if (n <= 0) return null
        got += n
      }
      if (onRead && length > 0) onRead(length)
      return buffer
    },
  }
}

/** 解析中央目录：只读尾部与中央目录那两段，不碰条目内容。 */
function parseDirectory(source) {
  if (!source || source.size < EOCD_MIN) return null
  try {
    const scanStart = Math.max(0, source.size - EOCD_SCAN)
    const tail = source.read(scanStart, source.size - scanStart)
    if (!tail || tail.length < EOCD_MIN) return null
    let at = -1
    for (let pos = tail.length - EOCD_MIN; pos >= 0; pos -= 1) {
      if (tail.readUInt32LE(pos) === EOCD_SIG) {
        at = pos
        break
      }
    }
    if (at < 0) return null
    const total = tail.readUInt16LE(at + 10)
    const centralBytes = tail.readUInt32LE(at + 12)
    const centralOffset = tail.readUInt32LE(at + 16)
    // ZIP64：条目数或偏移写成 0xffff / 0xffffffff，这里不解释那套扩展
    if (total === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) return null
    if (total > MAX_ENTRIES) return null
    if (centralOffset + centralBytes > source.size) return null

    const central = source.read(centralOffset, centralBytes)
    if (!central) return null
    const entries = []
    let cursor = 0
    for (let index = 0; index < total; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CEN_SIG) return null
      const flags = central.readUInt16LE(cursor + 8)
      const method = central.readUInt16LE(cursor + 10)
      const crc = central.readUInt32LE(cursor + 16)
      const packed = central.readUInt32LE(cursor + 20)
      const bytes = central.readUInt32LE(cursor + 24)
      const nameBytes = central.readUInt16LE(cursor + 28)
      const extraBytes = central.readUInt16LE(cursor + 30)
      const commentBytes = central.readUInt16LE(cursor + 32)
      const offset = central.readUInt32LE(cursor + 42)
      if (cursor + 46 + nameBytes > central.length) return null
      const name = central.subarray(cursor + 46, cursor + 46 + nameBytes).toString('utf8')
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
      cursor += 46 + nameBytes + extraBytes + commentBytes
    }
    return { entries, total }
  } catch {
    return null
  }
}

/**
 * 读包里的目录（中央目录）：只认条目名、字节数、CRC32、压缩方式与本地头偏移。
 * 不是 zip、被截断、写了 ZIP64 都回 null —— 读不出来比读出一份错的清单安全。
 */
export function readZipDirectory(buffer) {
  return parseDirectory(memorySource(buffer))
}

/** 同上，但走盘上的只读句柄：只读尾部与中央目录，不把整包读进内存。 */
export function readZipDirectoryAt(fd, size) {
  return parseDirectory(fdSource(fd, size))
}

/**
 * 按目录里的一条取内容：只读这一段，解开后立刻验 CRC32。
 * 出错时回 { error } —— 界面照实说是哪一种（截断 / 加密 / 认不出 / 太大），不拿字节硬拼。
 */
function readEntryFrom(source, entry) {
  if (!source || !entry) return { error: 'unreadable' }
  if (entry.encrypted) return { error: 'encrypted' }
  if (entry.method !== 0 && entry.method !== 8) return { error: 'method' }
  if (entry.packed > MAX_ENTRY_BYTES || entry.bytes > MAX_ENTRY_BYTES) return { error: 'too-large' }
  try {
    if (entry.offset + 30 > source.size) return { error: 'truncated' }
    const head = source.read(entry.offset, 30)
    if (!head || head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) return { error: 'truncated' }
    const nameBytes = head.readUInt16LE(26)
    const extraBytes = head.readUInt16LE(28)
    const start = entry.offset + 30 + nameBytes + extraBytes
    if (start + entry.packed > source.size) return { error: 'truncated' }
    const raw = source.read(start, entry.packed)
    if (!raw || raw.length !== entry.packed) return { error: 'truncated' }
    const content = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    if (!content || content.length !== entry.bytes) return { error: 'unreadable' }
    return { data: content, bytes: content.length, crcOk: crc32(content) === entry.crc }
  } catch {
    return { error: 'unreadable' }
  }
}

/**
 * 按目录里的一条取内容（内存里的整份）：只读这一段，解开后立刻验 CRC32。
 * crcOk 为 false 表示「这一条在包里就是坏的」——界面照实说，不把这堆字节当内容展示。
 */
export function readZipEntry(buffer, entry) {
  const source = memorySource(buffer)
  if (!source || !entry || entry.encrypted) return null
  const read = readEntryFrom(source, entry)
  return read.data ? read : null
}

/** 同上，但走盘上的只读句柄：只把这一条读进内存。 */
export function readZipEntryAt(fd, size, entry) {
  if (!entry || entry.encrypted) return null
  const read = readEntryFrom(fdSource(fd, size), entry)
  return read.data ? read : null
}

/**
 * 整包体检（v0.9.130）：把目录里每一条都解开、重算 CRC32 与目录里记的比。
 * 逐条按范围读，内存里最多一条，解开的总字节数受 MAX_VERIFY_BYTES 约束：
 * 超了就把剩下的记为 skipped（没走完），不装作「都对得上」。
 */
export function verifyZipEntries(source, entries, { budgetBytes = MAX_VERIFY_BYTES } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const failed = []
  let passed = 0
  let skipped = 0
  let decompressed = 0
  for (const entry of list) {
    if (decompressed + entry.bytes > budgetBytes) {
      skipped += 1
      continue
    }
    decompressed += entry.bytes
    const read = readEntryFrom(source, entry)
    if (read.data && read.crcOk) {
      passed += 1
      continue
    }
    failed.push({ name: entry.name, bytes: entry.bytes, reason: read.error || 'crc' })
  }
  return { total: list.length, passed, skipped, failed }
}

/** 体检盘上那一份，并记下这次真读了多少字节（用来跟包大小对照，不是估算）。 */
export function verifyZipAt(fd, size, entries, options = {}) {
  let readBytes = 0
  const source = fdSource(fd, size, (n) => {
    readBytes += n
  })
  return { ...verifyZipEntries(source, entries, options), readBytes }
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
