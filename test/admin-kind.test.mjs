// 对外报的 kind 要和管理员判定一致（r246）：VQ_ADMIN_EMAILS 里的账号在接口上是管理员，
// 后台界面却曾经显示「没有后台权限」。这条用例把两边钉在一起。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-admin-kind-'))
process.env.DATA_DIR = dir
process.env.VQ_ADMIN_EMAILS = 'boss@example.test'

const auth = await import('../server/auth.mjs')

test('VQ_ADMIN_EMAILS 里的账号：接口认是管理员，对外报的 kind 也要是 admin', () => {
  const boss = auth.createUser({ email: 'boss@example.test', password: 'Passw0rd!demo', name: '老板' })
  const plain = auth.createUser({ email: 'staff@example.test', password: 'Passw0rd!demo', name: '员工' })
  assert.equal(auth.isAdmin(boss), true)
  assert.equal(auth.publicUser(boss).kind, 'admin', '邮箱授权的管理员，后台入口也要开')
  assert.equal(auth.publicUser(plain).kind, 'account')
  assert.equal(auth.publicUser(null), null)
})

test.after(() => {
  // Windows 上 SQLite 还开着句柄，直接删整个目录会 EPERM：重试几次，失败也不让用例变红
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch { /* 临时目录留给系统清 */ }
})
