// 交付包封存（v0.9.125）：标记交付的那一刻，把整套 zip 原样存下来。
//
// 为什么不在下载时现打：交付包会跟着模板、脚本、帧图与评审一起变。
// 半年后回看「当时交给甲方的是什么」，现打只会打出今天的样子，历史被悄悄改写。
// 所以交付时封存一份，之后开新版、改模板、清帧图，都不动它。
//
// 边界：
//  - 文件只在服务器数据目录里，路径由作品编号 + 交付记录编号拼成，不接受外部给的路径；
//  - 下载仍走作品详情的登录态，包本身不是公开链接；
//  - 封存失败不挡「标记交付」：记录照落，只是这一条没有包（界面如实说）。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { config } from './config.mjs'

const SAFE_ID = /^[0-9a-z_-]{1,80}$/i
const PACKAGE_ID = /^[0-9a-f]{16}$/
/** 交付记录里最多记这么多条包内文件；交付包本身不受影响，只是清单不再往下记。 */
const MAX_MANIFEST_FILES = 60

/** 新交付记录的编号：16 位十六进制，够短、可放地址，也不和别的记录撞。 */
export function newDeliveryPackageId() {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

/** 这个编号只认 16 位十六进制；外面传进来的路径一律先过这里。 */
export function isDeliveryPackageId(value) {
  return PACKAGE_ID.test(String(value || ''))
}

function projectDir(projectId) {
  const id = String(projectId || '')
  if (!SAFE_ID.test(id) || id === '.' || id === '..') return ''
  return path.join(config.dataDir, 'delivery-packages', id)
}

function packagePath(projectId, deliveryId) {
  const dir = projectDir(projectId)
  if (!dir || !isDeliveryPackageId(deliveryId)) return ''
  return path.join(dir, deliveryId + '.zip')
}

/**
 * 存一份交付包：返回写进交付记录的元数据，不返回磁盘路径。
 * fileName 是给下载响应头用的中文名；sha256 让人能核对「还是不是当初那一份」。
 *
 * files 是包内清单（v0.9.126）：只记名字与字节数，不记内容；封存时顺手存下，
 * 之后不用解开 zip 才能说清「这个包里有什么」。清单上限 60 条，超出的只记总数。
 */
export async function saveDeliveryPackage(projectId, deliveryId, data, { fileName = '', files = [] } = {}) {
  const target = packagePath(projectId, deliveryId)
  if (!target) throw new Error('交付包编号不合法')
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (!buffer.length) throw new Error('交付包是空的')
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, buffer)
  const manifest = (Array.isArray(files) ? files : [])
    .map((file) => ({
      name: String(file?.name || '').replace(/\p{Cc}/gu, '').trim().slice(0, 160),
      bytes: Math.max(0, Math.round(Number(file?.bytes) || 0)),
    }))
    .filter((file) => file.name)
  return {
    id: deliveryId,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    fileName: String(fileName || '').slice(0, 180),
    savedAt: new Date().toISOString(),
    fileCount: manifest.length,
    files: manifest.slice(0, MAX_MANIFEST_FILES),
  }
}

/** 读回封存的那一份；文件不在了返回 null（不拿今天的样子补一份）。 */
export async function readDeliveryPackage(projectId, deliveryId) {
  const target = packagePath(projectId, deliveryId)
  if (!target) return null
  try {
    return await fsp.readFile(target)
  } catch {
    return null
  }
}

/**
 * 打开盘上那份只读句柄（v0.9.130）：列目录、整包体检都按偏移读，不把整包读进内存。
 * 文件不在、或者不是普通文件，回 null；调用方负责 close。
 */
export async function openDeliveryPackage(projectId, deliveryId) {
  const target = packagePath(projectId, deliveryId)
  if (!target) return null
  try {
    const handle = await fsp.open(target, 'r')
    const info = await handle.stat()
    if (!info.isFile()) {
      await handle.close().catch(() => {})
      return null
    }
    return {
      fd: handle.fd,
      size: info.size,
      close: () => handle.close().catch(() => {}),
    }
  } catch {
    return null
  }
}

/**
 * 服务器上那一份还在不在（v0.9.128）：只 stat，不读内容、不改文件。
 * 包没了不等于档案错了：档案记的是「当初封存了什么」，这两件事要分开说。
 */
export async function statDeliveryPackage(projectId, deliveryId) {
  const target = packagePath(projectId, deliveryId)
  if (!target) return { present: false, bytes: 0 }
  try {
    const info = await fsp.stat(target)
    if (!info.isFile()) return { present: false, bytes: 0 }
    return { present: true, bytes: info.size }
  } catch {
    return { present: false, bytes: 0 }
  }
}

/**
 * 流式算盘上这一份的 SHA-256：只读文件、不缓存、不写盘。
 * 为什么要重算：档案里的哈希是封存那一刻记下的；盘上的文件可能被截断、覆盖或悄悄换掉，
 * 不重算就永远发现不了「下载回来的其实已经不是当初那一份」。
 */
export async function hashDeliveryPackage(projectId, deliveryId) {
  const target = packagePath(projectId, deliveryId)
  if (!target) return null
  try {
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of fs.createReadStream(target)) {
      hash.update(chunk)
      bytes += chunk.length
    }
    return { sha256: hash.digest('hex'), bytes }
  } catch {
    return null
  }
}

/**
 * 盘上这一份与档案那一笔对得上吗（v0.9.128）：纯函数，不碰磁盘。
 * state 分开写：missing 是文件没了，resized 是大小变了，mismatch 是大小没变但内容被换过；
 * 没记哈希的老包只能比大小，如实回 unverifiable，不把「比不了」说成「对得上」。
 */
export function packageIntegrity(record, actual) {
  const wantSha = String(record?.sha256 || '').trim().toLowerCase()
  const wantBytes = Math.max(0, Math.round(Number(record?.bytes) || 0))
  if (!actual) return { ok: false, state: 'missing' }
  const gotSha = String(actual.sha256 || '').trim().toLowerCase()
  const gotBytes = Math.max(0, Math.round(Number(actual.bytes) || 0))
  if (wantBytes && gotBytes !== wantBytes) return { ok: false, state: 'resized' }
  if (!wantSha) return { ok: true, state: 'unverifiable' }
  if (wantSha !== gotSha) return { ok: false, state: 'mismatch' }
  return { ok: true, state: 'ok' }
}

/**
 * 作品详情里顺手带上「盘上还在不在」：只 stat，不读内容。
 * 每条交付记录都换成新对象，package 也是新的：档案本身是事实，不能就地改写。
 */
export async function deliveriesWithDisk(projectId, deliveries = []) {
  const list = Array.isArray(deliveries) ? deliveries : []
  return Promise.all(list.map(async (entry) => {
    if (!entry?.id || !entry.package) return entry
    const disk = await statDeliveryPackage(projectId, entry.id)
    return { ...entry, package: { ...entry.package, disk } }
  }))
}

/** 删一份：重新打开这一版、或同一版重新交付时，旧包不该继续留在盘上。 */
export async function dropDeliveryPackage(projectId, deliveryId) {
  const target = packagePath(projectId, deliveryId)
  if (!target) return false
  try {
    await fsp.unlink(target)
    return true
  } catch {
    return false
  }
}

/** 作品删掉时把整目录带走：包是作品的产物，作品没了就不该留。 */
export async function dropProjectDeliveryPackages(projectId) {
  const dir = projectDir(projectId)
  if (!dir) return false
  try {
    await fsp.rm(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 只保留这些交付记录的包。交付记录有上限（20 条），被挤掉的旧包要一起清掉；
 * 清理失败不影响交付本身（包留在盘上只是占空间，不会让记录变得可下载）。
 */
export async function pruneDeliveryPackages(projectId, keepIds = []) {
  const dir = projectDir(projectId)
  if (!dir) return 0
  const keep = new Set((Array.isArray(keepIds) ? keepIds : []).filter(isDeliveryPackageId))
  let removed = 0
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.zip')) continue
    const id = name.slice(0, -4)
    if (!isDeliveryPackageId(id) || keep.has(id)) continue
    try {
      await fsp.unlink(path.join(dir, name))
      removed += 1
    } catch {
      // 清不掉就留着：下次交付再扫一遍
    }
  }
  return removed
}
