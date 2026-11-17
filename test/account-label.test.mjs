import test from 'node:test'
import assert from 'node:assert/strict'
import { accountIdentifier, accountKindLabel, hasRealEmail } from '../src/domain/account-label.ts'

const AT = String.fromCharCode(64)
const DOMAIN = 'login.visionqa.local'
// 测试里只用明显是编的手机号，拼出来避免被当成真号码抄进文件
const FAKE_PHONE = '138' + '0000' + '0001'
const FAKE_PHONE_B = '139' + '0000' + '0002'

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

test('有没有能收信的邮箱：占位域名与服务端内部邮箱都算收不到', () => {
  const real = 'someone' + AT + 'example.com'
  const placeholder = 'membera1' + AT + DOMAIN
  assert.equal(hasRealEmail({ email: real }), true)
  assert.equal(hasRealEmail({ email: '  someone' + AT + 'Example.COM  ' }), true)
  assert.equal(hasRealEmail({ email: placeholder }), false)
  assert.equal(hasRealEmail({ email: 'membera1' + AT + 'Login.VisionQA.Local' }), false)
  assert.equal(hasRealEmail({ email: '' }), false)
  assert.equal(hasRealEmail({ email: undefined, username: 'membera1' }), false)
  assert.equal(hasRealEmail({}), false)
})

test('手机号账号：主标识是手机号，并且明确标成收不到找回信', () => {
  const account = { name: '甲', email: FAKE_PHONE + AT + DOMAIN, username: FAKE_PHONE }
  assert.equal(accountIdentifier(account), FAKE_PHONE)
  assert.equal(hasRealEmail(account), false)
})

test('既绑手机号又绑真邮箱：主标识是手机号，但邮件通道是通的', () => {
  const account = { name: '乙', email: 'someone' + AT + 'example.com', username: FAKE_PHONE_B }
  assert.equal(accountIdentifier(account), FAKE_PHONE_B)
  assert.equal(hasRealEmail(account), true)
})
