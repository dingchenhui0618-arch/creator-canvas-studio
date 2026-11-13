#!/usr/bin/env node
// 数据备份 v2（A2）：把 DATA_DIR 做成一个「能真恢复」的加密归档。
//
// v1 的三个坑，这一版逐个封掉：
// 1) 活库直接 tar：auth.db 是 WAL 模式，tar 按「主库 → -wal」的顺序读文件，
//    中间只要有一次 checkpoint，主库副本就停在旧页、-wal 又被截断 → 备份少最近的账号/积分记录。
//    现在每个 *.db 用 SQLite 自己的 VACUUM INTO 生成一致性快照（单文件、无 WAL）。
// 2) 备份和数据库同盘：现在支持 --offsite 第二份副本（不同挂载点/另一台机器），
//    复制后按 sha256 校验，并且支持单独保留份数。
// 3) 明文备份里带着 .model-keys.secret：现在归档整体用口令加密（scrypt + AES-256-GCM），
//    口令只在 --passphrase-file / VQ_BACKUP_PASSPHRASE 里，绝不进备份目录与状态文件。
//
// 每次备份完立刻做一次恢复演练：解开归档 → 打开 auth.db 跑 integrity_check →
// 核对表行数与 templates.json 条数 → 试着解一把 Key。演练不过就退出码 5，
// 让 systemd 把这次任务标红，而不是留一个「看起来存在」的坏备份。
//
// 用法：
//   node --experimental-sqlite scripts/backup.mjs --passphrase-file /etc/visionqa/backup.key [--offsite /mnt/vq-backups]
//   node --experimental-sqlite scripts/backup.mjs --allow-plaintext --verify-only  # 仅本地调试
// 退出码：0 成功；1 参数/环境错误；2 数据缺失；3 打包失败；4 异地副本失败；5 恢复演练失败；6 加密/口令问题。
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { decryptFile, encryptFile, fingerprintOf, isEncrypted, readPassphrase } from './backup-crypto.mjs'

const SKIP_TOP = new Set(['jobs', 'backups', 'backup-status.json'])
const SKIP_EXT = /\.(pid|tmp|log|tgz|enc)$/i

function argOf(args, flag, fallback) {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function stampNow(iso = new Date().toISOString()) {
  // 与 v1 一致：2026-11-13-05-22-26（本地时间语义由 systemd 那个时区决定，文件名只保证可排序）
  return iso.replace(/[:.]/g, '-').replace('T', '-').slice(0, 19)
}

// 归档里的一份 SQLite 快照：单文件、无 -wal/-shm，恢复时不需要重放。
function snapshotSqlite(file, dest) {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const quoted = dest.replace(/'/g, "''")
    db.exec(`VACUUM INTO '${quoted}'`)
  } finally {
    db.close()
  }
  const check = new DatabaseSync(dest, { readOnly: true })
  try {
    const row = check.prepare('PRAGMA integrity_check').get()
    const verdict = String(row?.integrity_check ?? Object.values(row || {})[0] ?? '')
    const tables = {}
    const names = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    for (const entry of names) {
      const count = check.prepare('SELECT COUNT(*) AS n FROM "' + String(entry.name).replace(/"/g, '""') + '"').get()
      tables[entry.name] = Number(count?.n || 0)
    }
    return { bytes: fs.statSync(dest).size, integrity: verdict, tables }
  } finally {
    check.close()
  }
}

function listFiles(root, out) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (root === out.root && SKIP_TOP.has(entry.name)) continue
      listFiles(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (root === out.root && SKIP_EXT.test(entry.name)) continue
    if (SKIP_EXT.test(entry.name)) continue
    out.files.push(full)
  }
}

function copyInto(staging, dataDir, file) {
  const rel = path.relative(dataDir, file)
  const dest = path.join(staging, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const info = fs.statSync(file)
  fs.copyFileSync(file, dest)
  fs.chmodSync(dest, info.mode & 0o777)
  return { path: rel.split(path.sep).join('/'), bytes: info.size }
}

// 恢复演练：打开还原出来的数据，确认「账号在、模板在、Key 能解」。
// 这里刻意不 import server/*：备份脚本要在服务挂掉时也能跑，不能被业务模块的初始化拖住。
export function drillRestore(dir, manifest) {
  const started = Date.now()
  const errors = []
  const summary = { ok: false, ms: 0, integrityCheck: null, users: null, templates: null, keys: null, keyDecrypt: 'none', errors }
  const dbFile = path.join(dir, 'auth.db')
  if (!fs.existsSync(dbFile)) {
    errors.push('还原目录里没有 auth.db')
  } else {
    try {
      const db = new DatabaseSync(dbFile, { readOnly: true })
      try {
        const row = db.prepare('PRAGMA integrity_check').get()
        summary.integrityCheck = String(row?.integrity_check ?? Object.values(row || {})[0] ?? '')
        if (summary.integrityCheck !== 'ok') errors.push('auth.db integrity_check = ' + summary.integrityCheck)
        summary.users = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n || 0)
      } finally {
        db.close()
      }
    } catch (error) {
      errors.push('打开 auth.db 失败：' + String(error?.message || error))
    }
  }

  const templatesFile = path.join(dir, 'templates.json')
  if (!fs.existsSync(templatesFile)) {
    errors.push('还原目录里没有 templates.json')
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(templatesFile, 'utf8'))
      summary.templates = Array.isArray(parsed) ? parsed.length : Array.isArray(parsed?.items) ? parsed.items.length : null
    } catch (error) {
      errors.push('templates.json 解析失败：' + String(error?.message || error))
    }
  }

  const keysFile = path.join(dir, 'model-keys.json')
  const secretFile = path.join(dir, '.model-keys.secret')
  if (fs.existsSync(keysFile)) {
    if (!fs.existsSync(secretFile)) errors.push('备份里有 model-keys.json 却缺 .model-keys.secret')
    else {
      try {
        const parsed = JSON.parse(fs.readFileSync(keysFile, 'utf8'))
        const items = Array.isArray(parsed) ? parsed : parsed.keys || []
        summary.keys = items.length
        // Key 池的字段是 apiKey（历史上也用过 key/secret），三种都认，避免演练变成假阴性
        const sealed = items.map((item) => item?.apiKey || item?.key || item?.secret || '').find((value) => String(value).startsWith('enc:v1:'))
        if (!sealed) summary.keyDecrypt = 'empty'
        else {
          const stored = fs.readFileSync(secretFile, 'utf8').trim()
          const key = /^[0-9a-f]{64}$/.test(stored) ? Buffer.from(stored, 'hex') : crypto.createHash('sha256').update(stored).digest()
          const parts = String(sealed).split(':')
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64'))
          decipher.setAuthTag(Buffer.from(parts[3], 'base64'))
          const plain = Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64')), decipher.final()]).toString('utf8')
          summary.keyDecrypt = plain ? 'ok' : 'empty-plaintext'
          if (!plain) errors.push('Key 解密结果是空的')
        }
      } catch (error) {
        summary.keyDecrypt = 'failed'
        errors.push('Key 解密失败：' + String(error?.message || error))
      }
    }
  }

  if (manifest?.sqlite?.length && summary.users !== null) {
    for (const entry of manifest.sqlite) {
      if (entry.name === 'auth.db' && entry.tables?.users !== undefined && summary.users !== entry.tables.users) {
        errors.push('users 行数不一致：备份清单 ' + entry.tables.users + ' / 还原后 ' + summary.users)
      }
    }
  }
  if (manifest?.templates !== null && manifest?.templates !== undefined && summary.templates !== null && manifest.templates !== summary.templates) {
    errors.push('templates 条数不一致：备份清单 ' + manifest.templates + ' / 还原后 ' + summary.templates)
  }

  summary.ok = errors.length === 0
  summary.ms = Date.now() - started
  return summary
}

function extractArchive(archive, target) {
  fs.mkdirSync(target, { recursive: true })
  const unpacked = spawnSync('tar', ['-xzf', archive, '-C', target], { encoding: 'utf8' })
  if (unpacked.status !== 0) throw new Error('解开归档失败：' + String(unpacked.stderr || '').slice(0, 300))
}

// 恢复一个归档到指定目录：解密 → 解包 → 立刻跑一遍恢复演练。
// 这是「备份可用」的唯一证明方式，所以把演练做进恢复命令本身，而不是让人手工核对。
export function restoreArchive(archive, target, { passphrase = '' } = {}) {
  const encrypted = isEncrypted(archive)
  const dir = path.resolve(target)
  fs.mkdirSync(dir, { recursive: true })
  let tarPath = archive
  let work = ''
  try {
    if (encrypted) {
      if (!passphrase) throw new Error('归档是加密的，需要口令')
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-restore-'))
      tarPath = path.join(work, 'archive.tgz')
      decryptFile(archive, tarPath, passphrase)
    }
    const unpacked = spawnSync('tar', ['-xzf', tarPath, '-C', dir], { encoding: 'utf8' })
    if (unpacked.status !== 0) throw new Error('解开归档失败：' + String(unpacked.stderr || '').slice(0, 300))
    const manifestFile = path.join(dir, 'manifest.json')
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null
    const drill = drillRestore(dir, manifest)
    return { ok: drill.ok, encrypted, dir, manifest, drill }
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true })
  }
}

export function verifyArchive(archive, { passphrase = '', keepDir = '' } = {}) {
  const work = keepDir || fs.mkdtempSync(path.join(os.tmpdir(), 'vq-verify-'))
  const encrypted = isEncrypted(archive)
  let tarPath = archive
  try {
    if (encrypted) {
      if (!passphrase) throw new Error('归档是加密的，但没有提供口令')
      tarPath = path.join(work, 'verify.tgz')
      decryptFile(archive, tarPath, passphrase)
    }
    const dir = path.join(work, 'data')
    extractArchive(tarPath, dir)
    const manifestFile = path.join(dir, 'manifest.json')
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null
    const drill = drillRestore(dir, manifest)
    return { ok: drill.ok, encrypted, manifest, drill, dir: keepDir ? dir : '' }
  } finally {
    if (!keepDir) fs.rmSync(work, { recursive: true, force: true })
  }
}

function pruneDir(dir, keep, pattern) {
  if (!fs.existsSync(dir)) return { removed: [], kept: 0 }
  const files = fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .reverse()
  const removed = []
  for (const name of files.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, name))
      const sidecar = path.join(dir, name + '.sha256')
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar)
      removed.push(name)
    } catch {
      // 删不掉就留着，不能因为清理失败把这次备份判成失败
    }
  }
  return { removed, kept: Math.min(files.length, keep) }
}

export async function runBackup(options = {}) {
  const started = Date.now()
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || 'data')
  const outDir = path.resolve(options.outDir || process.env.VQ_BACKUP_DIR || path.join(dataDir, 'backups'))
  const keep = Math.max(1, Number(options.keep || process.env.VQ_BACKUP_KEEP || 14) || 14)
  const offsite = String(options.offsite || process.env.VQ_BACKUP_OFFSITE || '').trim()
  const offsiteDir = offsite ? path.resolve(offsite) : ''
  const allowPlaintext = Boolean(options.allowPlaintext)
  const passphrase = String(options.passphrase || '')
  const statusFile = path.resolve(options.statusFile || process.env.VQ_BACKUP_STATUS_FILE || path.join(dataDir, 'backup-status.json'))
  const skipVerify = Boolean(options.skipVerify)

  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) throw new Error('数据目录不存在：' + dataDir)
  if (!passphrase && !allowPlaintext) throw new Error('没有口令：用 --passphrase-file / VQ_BACKUP_PASSPHRASE_FILE 提供口令，或显式 --allow-plaintext')
  if (passphrase && passphrase.length < 16) throw new Error('口令太短（至少 16 位）：备份是长期资产，口令要够长')

  fs.mkdirSync(outDir, { recursive: true })
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-backup-'))
  const stamp = stampNow()
  const baseName = 'visionqa-' + stamp
  const summary = {
    ok: false,
    format: 2,
    at: new Date().toISOString(),
    file: '',
    bytes: 0,
    sha256: '',
    encrypted: Boolean(passphrase),
    passphraseFingerprint: passphrase ? fingerprintOf(passphrase) : '',
    manifest: null,
    verify: null,
    offsite: null,
    kept: 0,
    removed: [],
    durationMs: 0,
    errors: [],
  }

  try {
    const files = []
    listFiles(dataDir, { root: dataDir, files })
    const copied = []
    const sqlite = []
    const dbs = fs.readdirSync(dataDir).filter((name) => name.endsWith('.db') && fs.statSync(path.join(dataDir, name)).isFile())
    for (const file of files) {
      const name = path.basename(file)
      // 库文件单独走 VACUUM INTO；-wal/-shm 是运行态，不进归档
      if (dbs.includes(name) && path.dirname(file) === dataDir) continue
      if (/\.db-(wal|shm)$/i.test(name)) continue
      copied.push(copyInto(staging, dataDir, file))
    }
    for (const name of dbs) {
      const snapshot = snapshotSqlite(path.join(dataDir, name), path.join(staging, name))
      sqlite.push({ name, ...snapshot })
    }

    const templates = (() => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'templates.json'), 'utf8'))
        return Array.isArray(parsed) ? parsed.length : Array.isArray(parsed?.items) ? parsed.items.length : null
      } catch {
        return null
      }
    })()
    const manifest = {
      format: 2,
      at: summary.at,
      dataDir,
      host: os.hostname(),
      node: process.version,
      packageVersion: readPackageVersion(),
      files: copied.length + sqlite.length,
      copiedBytes: copied.reduce((sum, item) => sum + item.bytes, 0),
      templates,
      sqlite,
      excluded: ['jobs/', '*.db-wal', '*.db-shm', '*.tgz', '*.enc', '*.log', '*.pid', '*.tmp', 'backup-status.json'],
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    summary.manifest = manifest
    if (!sqlite.some((entry) => entry.name === 'auth.db')) throw new Error('数据目录里没有 auth.db，拒绝生成「看起来成功」的备份')
    if (templates === null) throw new Error('templates.json 读不出来，拒绝生成备份')

    const tarPath = path.join(staging + '-archive.tgz')
    const packed = spawnSync('tar', ['-czf', tarPath, '-C', staging, '.'], { encoding: 'utf8' })
    if (packed.status !== 0) throw new Error('tar 打包失败：' + String(packed.stderr || '').slice(0, 300))

    const encrypted = Boolean(passphrase)
    const finalName = baseName + (encrypted ? '.tgz.enc' : '.tgz')
    const finalPath = path.join(outDir, finalName)
    const tmpFinal = finalPath + '.tmp-' + process.pid
    if (encrypted) {
      encryptFile(tarPath, tmpFinal, passphrase)
      fs.rmSync(tarPath, { force: true })
    } else {
      fs.copyFileSync(tarPath, tmpFinal)
      fs.rmSync(tarPath, { force: true })
    }
    fs.chmodSync(tmpFinal, 0o600)
    fs.renameSync(tmpFinal, finalPath)
    summary.file = finalName
    summary.bytes = fs.statSync(finalPath).size
    summary.sha256 = sha256File(finalPath)
    fs.writeFileSync(finalPath + '.sha256', summary.sha256 + '  ' + finalName + '\n')

    if (!skipVerify) {
      const verified = verifyArchive(finalPath, { passphrase })
      summary.verify = verified.drill
      if (!verified.drill.ok) {
        summary.errors.push(...verified.drill.errors)
        throw new Error('恢复演练失败：' + verified.drill.errors.join('；'))
      }
    }

    const pruned = pruneDir(outDir, keep, /^visionqa-.*\.(tgz|tgz\.enc)$/)
    summary.kept = pruned.kept
    summary.removed = pruned.removed

    if (offsiteDir) {
      try {
        if (offsiteDir === path.resolve(outDir)) throw new Error('异地目录不能和备份目录相同')
        fs.mkdirSync(offsiteDir, { recursive: true })
        const target = path.join(offsiteDir, finalName)
        fs.copyFileSync(finalPath, target + '.tmp-' + process.pid)
        fs.renameSync(target + '.tmp-' + process.pid, target)
        fs.chmodSync(target, 0o600)
        const hash = sha256File(target)
        if (hash !== summary.sha256) throw new Error('异地副本 sha256 与本地不一致')
        fs.writeFileSync(target + '.sha256', hash + '  ' + finalName + '\n')
        const offPruned = pruneDir(offsiteDir, keep, /^visionqa-.*\.(tgz|tgz\.enc)$/)
        summary.offsite = { ok: true, dir: offsiteDir, bytes: fs.statSync(target).size, sha256: hash, removed: offPruned.removed }
      } catch (error) {
        summary.offsite = { ok: false, dir: offsiteDir, error: String(error?.message || error) }
        summary.errors.push('异地副本失败：' + String(error?.message || error))
      }
    }

    if (summary.errors.length) throw new Error(summary.errors.join('；'))
    summary.ok = true
    return summary
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
    summary.durationMs = Date.now() - started
    try {
      const previous = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : null
      const status = {
        at: summary.at,
        ok: summary.ok,
        // 目录与保留份数由备份进程写下来：服务进程不需要额外环境变量也能找到归档
        dir: outDir,
        keep,
        file: summary.file,
        bytes: summary.bytes,
        sha256: summary.sha256,
        encrypted: summary.encrypted,
        passphraseFingerprint: summary.passphraseFingerprint,
        format: summary.format,
        durationMs: summary.durationMs,
        verify: summary.verify,
        offsite: summary.offsite,
        kept: summary.kept,
        removed: summary.removed,
        errors: summary.errors,
        previousOkAt: summary.ok ? summary.at : previous?.at || null,
      }
      const tmp = statusFile + '.tmp-' + process.pid
      fs.mkdirSync(path.dirname(statusFile), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n')
      fs.renameSync(tmp, statusFile)
    } catch (error) {
      console.error('[backup] 状态文件写不进去：' + String(error?.message || error))
    }
  }
}

function readPackageVersion() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return JSON.parse(fs.readFileSync(file, 'utf8')).version
  } catch {
    return null
  }
}

function exitCodeOf(message) {
  if (/恢复演练失败/.test(message)) return 5
  if (/异地副本失败/.test(message)) return 4
  if (/tar 打包失败/.test(message)) return 3
  // 先判「缺前置」再判「口令本身有问题」：没有口令时报的是配置缺失，不是口令太短
  if (/数据目录不存在|没有 auth\.db|templates\.json 读不出来|没有口令/.test(message)) return 2
  if (/口令|加密|passphrase/i.test(message)) return 6
  return 1
}

async function main(argv) {
  const args = argv.slice(2)
  const passphraseSource = readPassphrase({ file: argOf(args, '--passphrase-file', process.env.VQ_BACKUP_PASSPHRASE_FILE), env: argOf(args, '--passphrase', process.env.VQ_BACKUP_PASSPHRASE) })
  const dataDir = argOf(args, '--data', process.env.DATA_DIR || 'data')
  const outDir = argOf(args, '--out', process.env.VQ_BACKUP_DIR || path.join(dataDir, 'backups'))
  const keep = argOf(args, '--keep', process.env.VQ_BACKUP_KEEP || 14)
  const offsite = argOf(args, '--offsite', process.env.VQ_BACKUP_OFFSITE || '')
  const allowPlaintext = args.includes('--allow-plaintext') || process.env.VQ_BACKUP_ALLOW_PLAINTEXT === '1'
  const verifyOnly = args.includes('--verify-only')
  const verifyFile = argOf(args, '--verify-only', '') || argOf(args, '--file', '')

  try {
    if (verifyOnly) {
      if (!verifyFile) throw new Error('--verify-only 需要给出归档路径：--verify-only <file>')
      const result = verifyArchive(verifyFile, { passphrase: passphraseSource.passphrase })
      console.log(JSON.stringify({ ok: result.ok, file: verifyFile, encrypted: result.encrypted, drill: result.drill }, null, 2))
      process.exit(result.ok ? 0 : 5)
    }
    const summary = await runBackup({
      dataDir,
      outDir,
      keep,
      offsite,
      allowPlaintext,
      passphrase: passphraseSource.passphrase,
      verify: true,
    })
    console.log(JSON.stringify({ ...summary, passphraseSource: passphraseSource.source || null }, null, 2))
    process.exit(0)
  } catch (error) {
    const message = String(error?.message || error)
    console.error('[backup] 失败：' + message)
    process.exit(exitCodeOf(message))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv)
}
