// 备份状态：备份本身由 systemd 的独立进程跑（服务挂了也要能备），
// 服务进程只读它留下的状态文件与目录清单，后台据此回答「上一次备份到底成不成」。
// 状态文件里不含口令，只有口令指纹——后台不该看到、也不需要看到能解开备份的东西。
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'

export function backupDir() {
  return path.resolve(process.env.VQ_BACKUP_DIR || path.join(config.dataDir, 'backups'))
}

export function backupStatusFile() {
  return path.resolve(process.env.VQ_BACKUP_STATUS_FILE || path.join(config.dataDir, 'backup-status.json'))
}

export async function readBackupStatus() {
  try {
    const parsed = JSON.parse(await fs.readFile(backupStatusFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return {
      at: String(parsed.at || ''),
      ok: Boolean(parsed.ok),
      dir: parsed.dir ? String(parsed.dir) : '',
      keep: Number(parsed.keep || 0) || 0,
      file: String(parsed.file || ''),
      bytes: Number(parsed.bytes || 0),
      sha256: String(parsed.sha256 || ''),
      encrypted: Boolean(parsed.encrypted),
      passphraseFingerprint: String(parsed.passphraseFingerprint || ''),
      format: Number(parsed.format || 1),
      durationMs: Number(parsed.durationMs || 0),
      kept: Number(parsed.kept || 0),
      errors: Array.isArray(parsed.errors) ? parsed.errors.map(String).slice(0, 5) : [],
      verify: parsed.verify && typeof parsed.verify === 'object'
        ? {
            ok: Boolean(parsed.verify.ok),
            ms: Number(parsed.verify.ms || 0),
            integrityCheck: String(parsed.verify.integrityCheck || ''),
            users: parsed.verify.users === null || parsed.verify.users === undefined ? null : Number(parsed.verify.users),
            templates: parsed.verify.templates === null || parsed.verify.templates === undefined ? null : Number(parsed.verify.templates),
            keys: parsed.verify.keys === null || parsed.verify.keys === undefined ? null : Number(parsed.verify.keys),
            keyDecrypt: String(parsed.verify.keyDecrypt || 'none'),
            errors: Array.isArray(parsed.verify.errors) ? parsed.verify.errors.map(String).slice(0, 5) : [],
          }
        : null,
      offsite: parsed.offsite && typeof parsed.offsite === 'object'
        ? {
            ok: Boolean(parsed.offsite.ok),
            dir: String(parsed.offsite.dir || ''),
            bytes: Number(parsed.offsite.bytes || 0),
            sha256: String(parsed.offsite.sha256 || ''),
            error: parsed.offsite.error ? String(parsed.offsite.error) : '',
          }
        : null,
      previousOkAt: parsed.previousOkAt ? String(parsed.previousOkAt) : null,
    }
  } catch {
    return null
  }
}

// 备份目录清单：后台只显示「有什么、多大、什么时候」，不读内容。
export async function listBackupArchives(dir = backupDir(), limit = 8) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const items = []
    for (const entry of entries) {
      if (!entry.isFile() || !/^visionqa-.*\.(tgz|tgz\.enc)$/.test(entry.name)) continue
      try {
        const info = await fs.stat(path.join(dir, entry.name))
        items.push({ name: entry.name, bytes: info.size, mtime: info.mtime.toISOString(), encrypted: entry.name.endsWith('.enc') })
      } catch {
        // 统计期间被清理掉的旧备份跳过
      }
    }
    items.sort((a, b) => (a.name < b.name ? 1 : -1))
    const counts = {
      total: items.length,
      encrypted: items.filter((item) => item.encrypted).length,
      plaintext: items.filter((item) => !item.encrypted).length,
      bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    }
    return { dir, items: items.slice(0, limit), counts }
  } catch {
    return { dir, items: [], counts: { total: 0, encrypted: 0, plaintext: 0, bytes: 0 } }
  }
}

export async function backupSummary() {
  const status = await readBackupStatus()
  // 备份目录：优先用备份进程自己写下的路径（它一定是对的），再回落到服务端环境变量。
  const archives = await listBackupArchives(status?.dir || backupDir())
  return {
    ok: true,
    status,
    dir: archives.dir,
    keep: Math.max(1, Number(status?.keep || process.env.VQ_BACKUP_KEEP || 14) || 14),
    offsiteConfigured: Boolean(String(process.env.VQ_BACKUP_OFFSITE || '').trim()) || Boolean(status?.offsite?.dir),
    items: archives.items,
    counts: archives.counts,
    checkedAt: new Date().toISOString(),
  }
}
