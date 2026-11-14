// 封存包巡检（v0.9.132）：每天把盘上每个封存包按偏移读一遍、逐条重算 CRC32，
// 把结论落成 data/package-audits.json，作品页据此写「上次巡检 …」。
//
// 为什么要有它：体检（v0.9.130）得有人点。封存包是交付凭据，坏掉往往不是因为有人碰它，
// 而是盘坏了 / 迁移时截断 / 备份恢复错了——没人点，就没人知道。巡检不替人判断内容对不对，
// 只说「这一刻，包里每一条的字节还跟目录里记的 CRC32 对得上」。
//
// 边界：
//  - 只读包：打开只读句柄、按偏移读，内存里最多一条，finally 关；不改文件、不解压到磁盘；
//  - 只写一份报告：data/package-audits.json（临时文件 + rename），不碰作品、评审、账本；
//  - 巡检失败不抛给调用方：某个包读不出来就记成 missing / unreadable，继续看下一个；
//  - 报告只留最近一次：巡检是「现在还好不好」，不是流水账；历史结论看交付档案里的体检按钮。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { openDeliveryPackage } from './delivery-packages.mjs'
import { MAX_PACKAGE_BYTES, readZipDirectoryAt, verifyZipAt } from './zip-read.mjs'

/** 报告文件名：和 projects.json 放一起，备份脚本按目录打包时会一起带走。 */
export const AUDIT_REPORT_FILE = 'package-audits.json'
/** 一次巡检最多看这么多个包：作品上限 200、每件交付上限 20，留够余量又不至于跑一晚上。 */
export const MAX_AUDIT_PACKAGES = 400
/** 一个包最多记这么多条坏条目：再多也只是「坏得很多」，界面不需要逐个列。 */
const MAX_FAILED_KEPT = 12

export function auditReportPath() {
  return path.join(config.dataDir, AUDIT_REPORT_FILE)
}

/** 读上一次巡检的报告；没有、坏了、形状不对都回 null —— 宁可说「还没巡检过」，不猜。 */
export async function readAuditReport() {
  try {
    const parsed = JSON.parse(await fsp.readFile(auditReportPath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.at !== 'string' || !Array.isArray(parsed.packages)) return null
    return parsed
  } catch {
    return null
  }
}

/** 写报告：临时文件 + rename，巡检跑到一半被打断也不会留下半份 JSON。 */
export async function writeAuditReport(report) {
  await fsp.mkdir(config.dataDir, { recursive: true })
  const file = auditReportPath()
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(report, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

/** 这一件交付在报告里长什么样：包还在不在、目录读不读得出来、每条的 CRC32 对不对。 */
function blank(projectId, delivery) {
  const item = delivery && typeof delivery === 'object' ? delivery : {}
  const pkg = item.package && typeof item.package === 'object' ? item.package : {}
  return {
    projectId: String(projectId || ''),
    deliveryId: String(item.id || ''),
    version: Number(item.version) || 0,
    fileName: String(pkg.fileName || ''),
    sha256: String(pkg.sha256 || ''),
  }
}

/**
 * 巡检一个封存包：只读按偏移读，逐条重算 CRC32。
 * state 说清是「验了」还是「没验成」：ok / missing / unreadable / too-large。
 */
export async function auditSealedPackage(projectId, delivery) {
  const base = blank(projectId, delivery)
  const started = Date.now()
  const handle = await openDeliveryPackage(base.projectId, base.deliveryId)
  if (!handle) {
    return { ...base, state: 'missing', ok: false, total: 0, passed: 0, skipped: 0, failed: [], bytes: 0, readBytes: 0, ms: Date.now() - started }
  }
  try {
    const size = handle.size
    if (size > MAX_PACKAGE_BYTES) {
      return { ...base, state: 'too-large', ok: false, total: 0, passed: 0, skipped: 0, failed: [], bytes: size, readBytes: 0, ms: Date.now() - started }
    }
    const directory = readZipDirectoryAt(handle.fd, size)
    if (!directory) {
      return { ...base, state: 'unreadable', ok: false, total: 0, passed: 0, skipped: 0, failed: [], bytes: size, readBytes: 0, ms: Date.now() - started }
    }
    const audit = verifyZipAt(handle.fd, size, directory.entries)
    return {
      ...base,
      state: 'ok',
      // 有坏条目、或有因为预算没走完的条目，都算「有问题」：没走完不等于对得上
      ok: audit.failed.length === 0 && audit.skipped === 0,
      total: audit.total,
      passed: audit.passed,
      skipped: audit.skipped,
      failed: audit.failed.slice(0, MAX_FAILED_KEPT),
      bytes: size,
      readBytes: audit.readBytes,
      ms: Date.now() - started,
    }
  } finally {
    await handle.close()
  }
}

async function readProjects() {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(config.dataDir, 'projects.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 跑一次巡检：把 projects.json 里每个封存包都过一遍，写一份报告。
 * write=false 只算不落盘（测试 / 排查用）。
 */
export async function runPackageAudit({ at = new Date(), write = true } = {}) {
  const started = Date.now()
  const projects = await readProjects()
  const packages = []
  for (const project of projects) {
    if (packages.length >= MAX_AUDIT_PACKAGES) break
    if (!project || !Array.isArray(project.deliveries)) continue
    for (const delivery of project.deliveries) {
      if (packages.length >= MAX_AUDIT_PACKAGES) break
      if (!delivery || !delivery.id || !delivery.package) continue
      packages.push(await auditSealedPackage(project.id, delivery))
    }
  }
  const report = {
    version: 1,
    at: at.toISOString(),
    ms: Date.now() - started,
    checked: packages.length,
    problems: packages.filter((item) => !item.ok).length,
    packages,
  }
  if (write) await writeAuditReport(report)
  return report
}
