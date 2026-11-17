import test from 'node:test'
import assert from 'node:assert/strict'
import { accountIdentifier, accountKindLabel } from '../src/domain/account-label.ts'

const AT = String.fromCharCode(64)
const DOMAIN = 'login.visionqa.local'

test('管理员与访客各有自己的称呼', () => {
  assert.equal(accountKindLabel('admin'), '管理员')
  assert.equal(accountKindLabel('guest'), '访客会话')
  assert.equal(accountKindLabel('demo'), '账号')
})

test('用户名登录的普通账号不再说「工作邮箱」', () => {
  assert.equal(accountKindLabel('account', 'membera1'), '登录账号')
  assert.equal(accountKindLabel('account', '  memberb2  '), '登录账号')
})

test('只有邮箱的普通账号仍是「工作邮箱」', () => {
  assert.equal(accountKindLabel('account'), '工作邮箱')
  assert.equal(accountKindLabel('account', ''), '工作邮箱')
  assert.equal(accountKindLabel('account', '   '), '工作邮箱')
})

test('管理员就算带用户名也显示管理员', () => {
  assert.equal(accountKindLabel('admin', 'membera1'), '管理员')
})

test('占位邮箱不露出来：有用户名显示用户名，没用户名显示姓名', () => {
  const placeholder = 'membera1' + AT + DOMAIN
  assert.equal(accountIdentifier({ name: '甲', email: placeholder }), '甲')
  assert.equal(accountIdentifier({ name: '甲', email: placeholder, username: 'membera1' }), 'membera1')
  assert.equal(accountIdentifier({ email: placeholder }), '账号')
})

test('真邮箱照旧显示，空白回落到姓名', () => {
  const real = 'someone' + AT + 'example.com'
  assert.equal(accountIdentifier({ name: '乙', email: real }), real)
  assert.equal(accountIdentifier({ name: '丙' }), '丙')
})
