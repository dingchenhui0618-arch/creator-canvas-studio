// 一次性建号：读 .tmp-accounts.json（不提交），每行 { "username": "...", "password": "...", "name": "..." }。
// 只为「用户名 + 口令」这种账号准备：没有邮箱的账号用内部占位邮箱，登录走 login_name。
// 运行：node --experimental-sqlite scripts/create-accounts-once.mjs .tmp-accounts.json
import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2] || '.tmp-accounts.json'
const raw = fs.readFileSync(file, 'utf8')
const list = JSON.parse(raw)
if (!Array.isArray(list) || !list.length) {
  console.error('文件里没有账号')
  process.exit(1)
}

const auth = await import('../server/auth.mjs')
for (const item of list) {
  const username = String(item.username || '').trim().toLowerCase()
  const password = String(item.password || '')
  const name = String(item.name || username)
  if (!/^[0-9a-z._-]{4,32}$/.test(username)) {
    console.log('SKIP 用户名不合法（4-32 位字母数字）')
    continue
  }
  if (password.length < 8) {
    console.log('SKIP 口令太短（至少 8 位）')
    continue
  }
  const existing = auth.findUserByLoginName(username)
  if (existing) {
    auth.setPassword(existing.id, password)
    console.log('UPDATED 用户名已存在，口令已重设 · ' + username.slice(0, 3) + '•••')
    continue
  }
  const created = auth.createUser({
    email: username + '@login.visionqa.local',
    password,
    name,
    loginName: username,
    terms: null,
  })
  console.log('CREATED ' + username.slice(0, 3) + '••• · id=' + created.id + ' · kind=' + created.kind)
}
// 建完把明文文件删掉，避免口令留在仓库目录里
try {
  fs.unlinkSync(path.resolve(file))
  console.log('已删除 ' + file)
} catch {
  console.log('没能删除 ' + file + '，请手工删掉')
}
