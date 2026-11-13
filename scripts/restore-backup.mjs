#!/usr/bin/env node
// 恢复命令：把一份归档还原到指定目录，并当场跑恢复演练。
// 演练不过就退出码 5——宁可让恢复「失败」，也不要让人拿着一份坏数据起服务。
//
// 用法：
//   node --experimental-sqlite scripts/restore-backup.mjs <归档> --target /tmp/vq-restore \
//     --passphrase-file /etc/visionqa/backup.key
// 退出码：0 演练通过；2 参数错误；5 演练失败；6 解密失败。
import fs from 'node:fs'
import path from 'node:path'
import { readPassphrase } from './backup-crypto.mjs'
import { restoreArchive } from './backup.mjs'

function argOf(args, flag, fallback) {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const args = process.argv.slice(2)
const archive = args.find((item) => !item.startsWith('--') && item !== argOf(args, '--target', '') && item !== argOf(args, '--passphrase-file', ''))
const target = argOf(args, '--target', '')
const targetPath = target || path.join(path.dirname(archive || '.'), 'restored')
const passphraseSource = readPassphrase({ file: argOf(args, '--passphrase-file', process.env.VQ_BACKUP_PASSPHRASE_FILE), env: argOf(args, '--passphrase', process.env.VQ_BACKUP_PASSPHRASE) })

if (!archive || !fs.existsSync(archive)) {
  console.error('[restore] 找不到归档：' + (archive || '(未给出)'))
  process.exit(2)
}

try {
  const result = restoreArchive(archive, targetPath, { passphrase: passphraseSource.passphrase })
  console.log(JSON.stringify({ ...result, passphraseSource: passphraseSource.source || null }, null, 2))
  process.exit(result.ok ? 0 : 5)
} catch (error) {
  const message = String(error?.message || error)
  console.error('[restore] 失败：' + message)
  // GCM 的「Unsupported state or unable to authenticate data」就是口令不对，按解密失败返回 6
  process.exit(/口令|解密|加密|passphrase|unsupported state|authenticate data|bad decrypt/i.test(message) ? 6 : 2)
}
