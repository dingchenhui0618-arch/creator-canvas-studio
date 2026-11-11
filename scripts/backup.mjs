// 数据备份：把 DATA_DIR 整体打成一个 tar.gz，校验里面确实有关键文件，然后按份数清理旧备份。
// 为什么必须整目录打：除了 JSON 与 SQLite，还有 model-keys.json 和 .model-keys.secret ——
// 两者必须成对出现，单独恢复 model-keys.json 的话所有 Key 都解不开。
// 用法：node scripts/backup.mjs [--data DIR] [--out DIR] [--keep 14]
// 退出码：0 成功；1 参数/环境错误；2 打包成功但缺少关键文件；3 打包失败。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
function argOf(flag, fallback) {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const dataDir = path.resolve(argOf('--data', process.env.DATA_DIR || 'data'))
const outDir = path.resolve(argOf('--out', process.env.VQ_BACKUP_DIR || path.join(dataDir, 'backups')))
const keep = Math.max(1, Number(argOf('--keep', process.env.VQ_BACKUP_KEEP || 14)) || 14)

if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
  console.error('[backup] 数据目录不存在：' + dataDir)
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19)
const file = path.join(outDir, 'visionqa-' + stamp + '.tgz')

// 备份目录自己在数据目录下时排除掉，避免备份套备份
const tarArgs = ['-czf', file, '-C', dataDir]
if (path.resolve(outDir).startsWith(dataDir + path.sep)) tarArgs.push('--exclude=backups')
tarArgs.push('.')
const packed = spawnSync('tar', tarArgs, { stdio: 'inherit' })
if (packed.status !== 0) {
  console.error('[backup] tar 打包失败（退出码 ' + packed.status + '）')
  process.exit(3)
}

// 校验：能列出内容才算备份可用。auth.db 与 templates.json 必须有；
// 源目录里有 model-keys.json 时，必须连 .model-keys.secret 一起备——否则恢复后 Key 全解不开。
const listed = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' })
const names = String(listed.stdout || '')
const required = ['auth.db', 'templates.json']
if (fs.existsSync(path.join(dataDir, 'model-keys.json'))) required.push('model-keys.json', '.model-keys.secret')
const missing = required.filter((name) => !names.includes(name))
if (missing.length) {
  console.error('[backup] 备份缺少关键文件：' + missing.join(', '))
  process.exit(2)
}

// 清理旧备份：按文件名倒序（文件名带时间戳），只留最近 keep 份
const files = fs
  .readdirSync(outDir)
  .filter((name) => name.startsWith('visionqa-') && name.endsWith('.tgz'))
  .sort()
  .reverse()
const removed = []
for (const name of files.slice(keep)) {
  try {
    fs.unlinkSync(path.join(outDir, name))
    removed.push(name)
  } catch (error) {
    console.error('[backup] 删除旧备份失败：' + name + ' ' + String(error?.message || error))
  }
}

const size = fs.statSync(file).size
if (size < 1024) {
  console.error('[backup] 备份体积异常（' + size + ' 字节）')
  process.exit(2)
}

console.log(JSON.stringify({
  ok: true,
  file,
  bytes: size,
  files: names.split('\n').filter((line) => line && !line.endsWith('/')).length,
  kept: files.length - removed.length,
  removed,
  at: new Date().toISOString(),
}))
