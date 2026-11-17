// 在临时 DATA_DIR 里建一个邮箱账号，给邮件链路测试用（别对生产 DATA_DIR 跑）
const root = process.env.VQ_APP_ROOT || '/opt/visionqa'
const auth = await import(root + '/server/auth.mjs')
const email = process.argv[2]
const password = process.argv[3]
if (!email || !password) {
  console.error('用法：DATA_DIR=<临时数据目录> node --experimental-sqlite scripts/mail-e2e/seed-user.mjs <邮箱> <口令>')
  process.exit(1)
}
const existing = auth.findUserByEmail(email)
if (existing) {
  auth.setPassword(existing.id, password)
  console.log('UPDATED ' + existing.id)
} else {
  const created = auth.createUser({ email, password, name: 'mail e2e', terms: null })
  console.log('CREATED ' + created.id + ' kind=' + created.kind)
}
