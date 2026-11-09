// 一次性迁移：把早期 seed 出来的「演示账号」改成普通账号。
// 早期版本 seed 的账号 kind='demo'，界面上会显示成「演示账号」；上线后不应再出现这个词。
// 用法（在 /opt/visionqa 下）：node scripts/migrate-account.mjs [新显示名]
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dataDir = process.env.DATA_DIR || ''
const candidates = [
  dataDir ? path.join(dataDir, 'auth.db') : '',
  '/var/lib/visionqa/data/auth.db',
  path.join(process.cwd(), 'data', 'auth.db'),
].filter(Boolean)

const file = candidates.find((item) => {
  try {
    return fs.statSync(item).isFile()
  } catch {
    return false
  }
})

if (!file) {
  console.error('没找到 auth.db，检查 DATA_DIR。已查找：' + candidates.join(' / '))
  process.exit(1)
}

const db = new DatabaseSync(file)
const before = db.prepare("SELECT id, email, name FROM users WHERE kind = 'demo'").all()
if (!before.length) {
  console.log('没有 kind=demo 的账号，无需迁移。库：' + file)
  process.exit(0)
}

const newName = (process.argv[2] || 'VisionQA 管理员').trim()
db.prepare("UPDATE users SET kind = 'account', name = ? WHERE kind = 'demo'").run(newName)
for (const row of before) console.log('已迁移：' + row.email + '（' + row.name + ' → ' + newName + '）')
console.log('完成。库：' + file)
