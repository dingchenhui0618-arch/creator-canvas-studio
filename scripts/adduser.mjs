// 建账号的命令行入口：注册关闭的部署里，这是唯一不开浏览器就能加人的办法。
// 用法（在服务器 /opt/visionqa 下）：
//   npm run adduser -- --email someone@example.com --password '至少8位' [--name 显示名]
// 依赖与生产同一个 DATA_DIR：写到 /var/lib/visionqa/data/auth.db（或 .env 里的 DATA_DIR）。
import { createUser, findUserByEmail } from '../server/auth.mjs'

function arg(name) {
  const index = process.argv.indexOf('--' + name)
  if (index === -1) return ''
  return process.argv[index + 1] || ''
}

const email = arg('email').trim().toLowerCase()
const password = arg('password')
const name = arg('name')

if (!email || !password) {
  console.error('缺少参数。用法：npm run adduser -- --email someone@example.com --password 至少8位 [--name 显示名]')
  process.exit(1)
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
  console.error('邮箱格式不正确：' + email)
  process.exit(1)
}
if (password.length < 8) {
  console.error('口令至少 8 位')
  process.exit(1)
}
if (findUserByEmail(email)) {
  console.error('这个邮箱已经存在：' + email)
  process.exit(2)
}

const user = createUser({ email, password, name })
console.log('已创建：' + user.email + '（' + user.name + '，id ' + user.id + '）')
console.log('口令不会回显，也不会写进任何日志。')
