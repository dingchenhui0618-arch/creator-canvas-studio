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
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { config } from './config.mjs'

const SAFE_ID = /^[0-9a-z_-]{1,80}$/i
const PACKAGE_ID = /^[0-9a-f]{16}$/

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
 */
export async function saveDeliveryPackage(projectId, deliveryId, data, { fileName = '' } = {}) {
  const target = packagePath(projectId, deliveryId)
  if (!target) throw new Error('交付包编号不合法')
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (!buffer.length) throw new Error('交付包是空的')
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, buffer)
  return {
    id: deliveryId,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    fileName: String(fileName || '').slice(0, 180),
    savedAt: new Date().toISOString(),
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
