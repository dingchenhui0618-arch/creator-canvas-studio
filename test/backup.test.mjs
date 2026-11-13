import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { decryptFile, isEncrypted } from '../scripts/backup-crypto.mjs'
import { sha256File, verifyArchive } from '../scripts/backup.mjs'

// 备份是「数据没了就全没了」的最后一道防线，所以这一组测试盯的是「能不能真恢复」，
// 而不是「有没有生成一个文件」：
//   1) WAL 里刚提交、还没 checkpoint 的数据，必须完整出现在备份里；
//   2) 归档必须整体加密（里面有 Key 池的 secret），状态文件里不能出现口令；
//   3) 每次备份后的恢复演练要能查出坏归档（改一个字节就报错）；
//   4) 保留份数、异地副本、失败退出码都要按约定走，否则定时任务不会变红。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PASS = 'test-backup-passphrase-61'
const CLI = path.join(root, 'scripts', 'backup.mjs')

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function baseEnv(overrides = {}) {
  const env = { ...process.env }
  delete env.VQ_BACKUP_OFFSITE
  delete env.VQ_BACKUP_ALLOW_PLAINTEXT
  delete env.VQ_BACKUP_PASSPHRASE_FILE
  Object.assign(env, { VQ_BACKUP_PASSPHRASE: PASS, VQ_BACKUP_KEEP: '5' }, overrides)
  return env
}

function runCli(args, env) {
  return spawnSync(process.execPath, ['--experimental-sqlite', CLI, ...args], { cwd: root, env, encoding: 'utf8' })
}

// 真数据目录的最小等价物：WAL 模式的 auth.db + 模板 + （可选）加密的 Key 池。
function makeData({ users = 3, sealedKey = false } = {}) {
  const dir = tempDir('vq-bak-data-')
  const db = new DatabaseSync(path.join(dir, 'auth.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)')
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)')
  db.exec('CREATE TABLE credit_ledger (id INTEGER PRIMARY KEY, delta INTEGER)')
  for (let index = 0; index < users; index += 1) {
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('usr_' + index, 'user' + index + '@example.com')
  }
  fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify({ items: [{ id: 'tpl_1' }, { id: 'tpl_2' }] }))
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ items: [] }))
  let secret = ''
  if (sealedKey) {
    secret = crypto.randomBytes(32).toString('hex')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv)
    const body = Buffer.concat([cipher.update('sk-demo-upstream-key', 'utf8'), cipher.final()])
    fs.writeFileSync(path.join(dir, '.model-keys.secret'), secret + '\n', { mode: 0o600 })
    fs.writeFileSync(
      path.join(dir, 'model-keys.json'),
      JSON.stringify({
        version: 2,
        keys: [{ id: 'k1', name: 'demo', key: ['enc', 'v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':') }],
      }),
    )
  }
  return { dir, db, secret, close: () => db.close() }
}

function countUsers(dbFile) {
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n || 0)
    } finally {
      db.close()
    }
  } catch {
    return -1
  }
}

function extractEncrypted(archive, passphrase = PASS) {
  const work = tempDir('vq-bak-unpack-')
  const tarPath = path.join(work, 'out.tgz')
  decryptFile(archive, tarPath, passphrase)
  const dir = path.join(work, 'data')
  fs.mkdirSync(dir, { recursive: true })
  const unpacked = spawnSync('tar', ['-xzf', tarPath, '-C', dir], { encoding: 'utf8' })
  assert.equal(unpacked.status, 0, '归档必须能被解开：' + String(unpacked.stderr || ''))
  return dir
}

test('WAL 里刚提交、没 checkpoint 的数据完整进备份，且归档里没有 -wal/-shm', () => {
  const data = makeData({ users: 3 })
  try {
    const out = tempDir('vq-bak-out-')
    const result = runCli(['--data', data.dir, '--out', out], baseEnv())
    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.ok, true)
    assert.equal(summary.verify.users, 3, '恢复演练必须数到 3 个账号')
    assert.equal(summary.manifest.sqlite[0].integrity, 'ok')
    assert.equal(summary.manifest.sqlite[0].tables.users, 3)

    const restored = extractEncrypted(path.join(out, summary.file))
    assert.ok(!fs.existsSync(path.join(restored, 'auth.db-wal')), '归档里不该带运行态的 -wal')
    assert.ok(!fs.existsSync(path.join(restored, 'auth.db-shm')), '归档里不该带运行态的 -shm')
    assert.equal(countUsers(path.join(restored, 'auth.db')), 3)
  } finally {
    data.close()
  }
})

test('v1 的读文件顺序会丢数据：主库副本停在旧页、-wal 又被 checkpoint 清空', () => {
  const data = makeData({ users: 3 })
  try {
    const work = tempDir('vq-bak-v1-')
    const v1Dir = path.join(work, 'archive')
    fs.mkdirSync(v1Dir)
    // 模拟 v1：tar 先读 auth.db，再读 auth.db-wal；中间发生一次 checkpoint（正常写负载下随时可能）
    fs.copyFileSync(path.join(data.dir, 'auth.db'), path.join(v1Dir, 'auth.db'))
    data.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    fs.copyFileSync(path.join(data.dir, 'auth.db-wal'), path.join(v1Dir, 'auth.db-wal'))
    const v1Users = countUsers(path.join(v1Dir, 'auth.db'))
    assert.ok(v1Users !== 3, '这个交错必须真的丢数据，否则这条测试没有说服力（实际 ' + v1Users + '）')

    const out = tempDir('vq-bak-out-')
    const result = runCli(['--data', data.dir, '--out', out], baseEnv())
    assert.equal(result.status, 0, result.stderr)
    const restored = extractEncrypted(path.join(out, JSON.parse(result.stdout).file))
    assert.equal(countUsers(path.join(restored, 'auth.db')), 3, 'VACUUM INTO 拿到的快照不能丢已提交的数据')
  } finally {
    data.close()
  }
})

test('归档整体加密：没有口令解不开，状态文件里不出现口令', () => {
  const data = makeData({ users: 2, sealedKey: true })
  try {
    const out = tempDir('vq-bak-out-')
    const result = runCli(['--data', data.dir, '--out', out], baseEnv())
    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.encrypted, true)
    assert.match(summary.file, /\.tgz\.enc$/)
    const archive = path.join(out, summary.file)
    assert.equal(isEncrypted(archive), true)
    assert.ok(!fs.existsSync(path.join(out, summary.file.replace(/\.enc$/, ''))), '备份目录里不许留明文 tgz')

    // 口令错了必须失败，而不是给出一半内容
    assert.throws(() => decryptFile(archive, path.join(out, 'nope.tgz'), 'wrong-passphrase-xxxxx'))
    assert.equal(summary.passphraseFingerprint.length, 12)
    assert.ok(!summary.passphraseFingerprint.includes(PASS))

    const status = JSON.parse(fs.readFileSync(path.join(data.dir, 'backup-status.json'), 'utf8'))
    const raw = fs.readFileSync(path.join(data.dir, 'backup-status.json'), 'utf8')
    assert.ok(!raw.includes(PASS), '状态文件里不能出现口令明文')
    assert.equal(status.encrypted, true)
    assert.equal(status.verify.ok, true)

    // 带上正确口令，Key 能解出明文（恢复演练真的试过解密）
    const restored = extractEncrypted(archive)
    const drill = verifyArchive(archive, { passphrase: PASS })
    assert.equal(drill.drill.keyDecrypt, 'ok')
    assert.equal(drill.drill.users, 2)
    assert.equal(drill.drill.templates, 2)
    // 备份里的 Key 池文件与 secret 成对出现
    assert.ok(fs.existsSync(path.join(restored, 'model-keys.json')))
    assert.ok(fs.existsSync(path.join(restored, '.model-keys.secret')))
  } finally {
    data.close()
  }
})

test('没有口令时必须拒绝，且不留下任何归档', () => {
  const data = makeData({ users: 1 })
  try {
    const out = tempDir('vq-bak-out-')
    const result = runCli(['--data', data.dir, '--out', out], baseEnv({ VQ_BACKUP_PASSPHRASE: '' }))
    assert.equal(result.status, 2)
    assert.match(result.stderr, /没有口令/)
    assert.deepEqual(fs.readdirSync(out), [])
  } finally {
    data.close()
  }
})

test('口令太短直接拒绝（备份是长期资产）', () => {
  const data = makeData({ users: 1 })
  try {
    const out = tempDir('vq-bak-out-')
    const result = runCli(['--data', data.dir, '--out', out], baseEnv({ VQ_BACKUP_PASSPHRASE: 'short' }))
    assert.equal(result.status, 6)
    assert.match(result.stderr, /口令太短/)
    assert.deepEqual(fs.readdirSync(out), [])
  } finally {
    data.close()
  }
})

test('改一个字节就被 GCM 拒绝：坏归档不能装成好消息', () => {
  const data = makeData({ users: 2 })
  try {
    const out = tempDir('vq-bak-out-')
    const result = runCli(['--data', data.dir, '--out', out], baseEnv())
    assert.equal(result.status, 0, result.stderr)
    const archive = path.join(out, JSON.parse(result.stdout).file)
    const bytes = fs.readFileSync(archive)
    bytes[bytes.length - 20] ^= 0xff
    fs.writeFileSync(archive, bytes)
    assert.throws(() => verifyArchive(archive, { passphrase: PASS }))
    const check = runCli(['--verify-only', archive], baseEnv())
    assert.notEqual(check.status, 0, '--verify-only 对坏归档必须非零退出')
  } finally {
    data.close()
  }
})

test('保留份数：超出 keep 的旧归档会被清掉', async () => {
  const data = makeData({ users: 1 })
  try {
    const out = tempDir('vq-bak-out-')
    const first = runCli(['--data', data.dir, '--out', out, '--keep', '1'], baseEnv())
    assert.equal(first.status, 0, first.stderr)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const second = runCli(['--data', data.dir, '--out', out, '--keep', '1'], baseEnv())
    assert.equal(second.status, 0, second.stderr)
    const summary = JSON.parse(second.stdout)
    const archives = fs.readdirSync(out).filter((name) => name.endsWith('.tgz.enc'))
    assert.equal(archives.length, 1)
    assert.equal(summary.removed.length, 1)
    assert.equal(summary.kept, 1)
  } finally {
    data.close()
  }
})

test('异地副本：复制过去并按 sha256 校验，成功后状态里能查到', () => {
  const data = makeData({ users: 2 })
  try {
    const out = tempDir('vq-bak-out-')
    const offsite = tempDir('vq-bak-offsite-')
    const result = runCli(['--data', data.dir, '--out', out, '--offsite', offsite], baseEnv())
    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.offsite.ok, true)
    assert.equal(summary.offsite.sha256, summary.sha256)
    assert.equal(summary.offsite.sha256, sha256File(path.join(offsite, summary.file)))
    const status = JSON.parse(fs.readFileSync(path.join(data.dir, 'backup-status.json'), 'utf8'))
    assert.equal(status.offsite.ok, true)
  } finally {
    data.close()
  }
})

test('异地副本写不进去：退出码 4，状态文件里留下失败原因', () => {
  const data = makeData({ users: 1 })
  try {
    const out = tempDir('vq-bak-out-')
    const blocker = path.join(tempDir('vq-bak-block-'), 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const result = runCli(['--data', data.dir, '--out', out, '--offsite', path.join(blocker, 'sub')], baseEnv())
    assert.equal(result.status, 4)
    assert.match(result.stderr, /异地副本失败/)
    const status = JSON.parse(fs.readFileSync(path.join(data.dir, 'backup-status.json'), 'utf8'))
    assert.equal(status.ok, false)
    assert.equal(status.offsite.ok, false)
    assert.ok(status.offsite.error)
    // 本地归档仍然保留，失败的是副本而不是整次备份
    assert.equal(fs.readdirSync(out).filter((name) => name.endsWith('.tgz.enc')).length, 1)
  } finally {
    data.close()
  }
})

test('没有 auth.db 时拒绝生成备份', () => {
  const dir = tempDir('vq-bak-empty-')
  fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify({ items: [] }))
  const out = tempDir('vq-bak-out-')
  const result = runCli(['--data', dir, '--out', out], baseEnv())
  assert.equal(result.status, 2)
  assert.match(result.stderr, /没有 auth\.db/)
  assert.deepEqual(fs.readdirSync(out), [])
})

test('--verify-only 对好归档返回 0，并打印演练结果', () => {
  const data = makeData({ users: 2, sealedKey: true })
  try {
    const out = tempDir('vq-bak-out-')
    const result = runCli(['--data', data.dir, '--out', out], baseEnv())
    assert.equal(result.status, 0, result.stderr)
    const archive = path.join(out, JSON.parse(result.stdout).file)
    const check = runCli(['--verify-only', archive], baseEnv())
    assert.equal(check.status, 0, check.stderr)
    const summary = JSON.parse(check.stdout)
    assert.equal(summary.ok, true)
    assert.equal(summary.drill.integrityCheck, 'ok')
    assert.equal(summary.drill.users, 2)
    assert.equal(summary.drill.keyDecrypt, 'ok')
  } finally {
    data.close()
  }
})

test('后台备份状态：状态文件与归档清单都读得到，状态缺失时返回 null 而不是抛错', async () => {
  const dir = tempDir('vq-bak-status-')
  const outDir = path.join(dir, 'backups')
  fs.mkdirSync(outDir)
  fs.writeFileSync(path.join(outDir, 'visionqa-2026-11-13-03-30-00.tgz.enc'), 'encrypted')
  fs.writeFileSync(path.join(outDir, 'visionqa-2026-11-12-03-30-00.tgz'), 'plain-text')
  fs.writeFileSync(path.join(outDir, 'notes.txt'), 'not an archive')
  fs.writeFileSync(
    path.join(dir, 'backup-status.json'),
    JSON.stringify({
      at: '2026-11-13T03:30:00.000Z',
      ok: true,
      file: 'visionqa-2026-11-13-03-30-00.tgz.enc',
      bytes: 9,
      sha256: 'abc',
      encrypted: true,
      passphraseFingerprint: '0123456789ab',
      durationMs: 1200,
      kept: 2,
      errors: [],
      verify: { ok: true, ms: 8, integrityCheck: 'ok', users: 1, templates: 26, keys: 0, keyDecrypt: 'empty', errors: [] },
      offsite: { ok: true, dir: '/mnt/vq-backups', bytes: 9, sha256: 'abc', error: '' },
      previousOkAt: '2026-11-12T03:30:00.000Z',
    }),
  )
  process.env.DATA_DIR = dir
  process.env.VQ_BACKUP_DIR = outDir
  process.env.VQ_BACKUP_KEEP = '7'
  const mod = await import('../server/backup-status.mjs')
  const summary = await mod.backupSummary()
  assert.equal(summary.status.ok, true)
  assert.equal(summary.status.verify.users, 1)
  assert.equal(summary.status.verify.templates, 26)
  assert.equal(summary.status.verify.keyDecrypt, 'empty')
  assert.equal(summary.status.offsite.dir, '/mnt/vq-backups')
  assert.equal(summary.counts.total, 2, '只统计备份归档，notes.txt 不计入')
  assert.equal(summary.counts.encrypted, 1)
  assert.equal(summary.counts.plaintext, 1)
  assert.equal(summary.items[0].name, 'visionqa-2026-11-13-03-30-00.tgz.enc', '最近的排在最前')
  assert.equal(summary.keep, 7)

  // 服务进程没有 VQ_BACKUP_DIR 时，应该跟着备份进程写下的 dir 走（线上就是这么配的）
  const otherDir = path.join(tempDir('vq-bak-other-'), 'backups')
  fs.mkdirSync(otherDir, { recursive: true })
  fs.writeFileSync(path.join(otherDir, 'visionqa-2026-11-11-03-30-00.tgz.enc'), 'x')
  const withDir = JSON.parse(fs.readFileSync(path.join(dir, 'backup-status.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'backup-status.json'), JSON.stringify({ ...withDir, dir: otherDir, keep: 3 }))
  const followed = await mod.backupSummary()
  assert.equal(followed.dir, otherDir)
  assert.equal(followed.keep, 3)
  assert.equal(followed.items.length, 1)

  fs.unlinkSync(path.join(dir, 'backup-status.json'))
  assert.equal(await mod.readBackupStatus(), null, '状态文件缺失时返回 null，后台显示「还没跑过」')
  assert.equal((await mod.backupSummary()).items.length, 2, '没有状态文件也不影响列出已有归档')
})
