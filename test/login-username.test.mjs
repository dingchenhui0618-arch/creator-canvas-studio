// 用户名（手机号）登录：v0.9.166 起账号可以只有用户名、没有可用邮箱。
// 这里只测数据层（建号 / 按用户名查 / 按邮箱查 / 唯一约束），HTTP 登录路由薄薄一层，
// 用真实请求测会在测试进程里起服务，成本比收益高。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-login-'))
process.env.DATA_DIR = dir
process.env.VQ_CREDIT_WELCOME = '0'

const auth = await import('../server/auth.mjs')

test.after(() => {
  // Windows 上 sqlite 的 -wal 句柄在进程退出前仍被占着，删不掉不算测试失败
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // 留给系统清理临时目录
  }
})

test('只给用户名的账号：能按用户名查到，也能按占位邮箱查到', () => {
  const user = auth.createUser({
    email: '13800000000@login.visionqa.local',
    password: 'Mark12345',
    name: 'mark',
    loginName: '13800000000',
  })
  assert.ok(user.id)
  assert.equal(user.login_name, '13800000000')
  assert.equal(auth.findUserByLoginName('13800000000')?.id, user.id)
  // 大小写、前后空格不影响
  assert.equal(auth.findUserByLoginName('  13800000000  ')?.id, user.id)
  assert.equal(auth.findUserByLogin('13800000000')?.id, user.id)
  assert.equal(auth.findUserByLogin('13800000000@login.visionqa.local')?.id, user.id)
})

test('用户名唯一：同一个用户名不能再建一次', () => {
  assert.throws(() =>
    auth.createUser({
      email: 'other@login.visionqa.local',
      password: 'Mark12345',
      name: 'dup',
      loginName: '13800000000',
    }),
  )
})

test('没有用户名的老账号照旧按邮箱登录，不存在的账号返回 null', () => {
  const user = auth.createUser({ email: 'boss@example.com', password: 'Boss12345', name: 'boss', kind: 'admin' })
  assert.equal(auth.findUserByLogin('boss@example.com')?.id, user.id)
  assert.equal(auth.findUserByLogin('boss'), null)
  assert.equal(auth.findUserByLoginName(''), null)
  assert.equal(auth.findUserByLogin(''), null)
})

test('管理员建号：用户名入库，publicUser 不泄露口令哈希', () => {
  const user = auth.createUser({
    email: '19700000000@login.visionqa.local',
    password: 'Zhangning123',
    name: 'zhangning',
    loginName: '19700000000',
  })
  const pub = auth.publicUser(user)
  assert.equal(pub.email, '19700000000@login.visionqa.local')
  assert.equal(pub.kind, 'account')
  assert.equal('password_hash' in pub, false)
  assert.equal(JSON.stringify(pub).includes('scrypt'), false)
})
