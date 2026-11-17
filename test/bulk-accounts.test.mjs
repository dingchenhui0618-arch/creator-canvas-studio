// 批量建号解析（v0.9.167）：后台「账号与积分」一次粘贴多行建号。
// 这里钉四件事：用户名（手机号那种纯数字）与邮箱都能建；不合法的行逐条报错（不静默吞）；
// 行号对得回原文；一次最多 BULK_ACCOUNT_LIMIT 个。
//
// 注意：样例里的账号是拼出来的（AT / email()），不写成字面量——手机号与邮箱在工具往返里
// 会被脱敏替换，写死在测试里就变成了别人的占位符，测的就不是解析器了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { BULK_ACCOUNT_LIMIT, parseBulkAccounts } from '../src/domain/bulk-accounts.ts'

const AT = String.fromCharCode(64)
const email = (user, domain) => user + AT + domain
const PHONE_A = 'membera1'
const PHONE_B = 'memberb2'

test('纯数字用户名：姓名可省、可带空格，用户名统一小写', () => {
  const result = parseBulkAccounts(PHONE_A + ' mark@123 mark\n' + PHONE_B + ' zhangning@123 张 宁')
  assert.equal(result.problems.length, 0)
  assert.deepEqual(result.rows, [
    { line: 1, email: '', username: PHONE_A, password: 'mark@123', name: 'mark' },
    { line: 2, email: '', username: PHONE_B, password: 'zhangning@123', name: '张 宁' },
  ])
})

test('邮箱行：空格、Tab、中英文逗号都能当分隔符', () => {
  const MAIL_A = email('a', 'b.co')
  const MAIL_B = email('c', 'd.co')
  const result = parseBulkAccounts(MAIL_A + '\tmark@123\n' + MAIL_B + '，zhangning@123，Z')
  assert.equal(result.problems.length, 0)
  assert.deepEqual(
    result.rows.map((row) => [row.email, row.username, row.name]),
    [
      [MAIL_A, '', ''],
      [MAIL_B, '', 'Z'],
    ],
  )
})

test('不合法的行逐条报错，行号对得回原文', () => {
  const BAD_MAIL = email('a', 'nodot')
  const OK_MAIL = email('b', 'c.co')
  const lines = [
    PHONE_A,
    PHONE_A + ' short1',
    PHONE_A + ' mark@123',
    PHONE_A + ' mark@123',
    BAD_MAIL + ' badpass1',
    OK_MAIL + ' abcdefgh',
  ]
  const result = parseBulkAccounts(lines.join('\n'))
  assert.equal(result.rows.length, 1)
  assert.deepEqual(
    result.problems.map((problem) => [problem.line, problem.reason]),
    [
      [1, '每行至少要有「用户名或邮箱」和「口令」'],
      [2, '口令要 8-200 位'],
      [4, '这一行和前面重复了'],
      [5, '邮箱格式不正确'],
      [6, '口令要同时包含字母和数字'],
    ],
  )
})

test('空行与 # 注释跳过，行号仍按原文算', () => {
  const result = parseBulkAccounts('\n# 这两行是需求的备注\n\n' + PHONE_A + ' mark@123 mark\n')
  assert.deepEqual(result.problems, [])
  assert.deepEqual(result.rows, [{ line: 4, email: '', username: PHONE_A, password: 'mark@123', name: 'mark' }])
})

test('一次超过上限：只收前 ' + BULK_ACCOUNT_LIMIT + ' 行，多出来的报一行', () => {
  const lines = []
  for (let index = 0; index < BULK_ACCOUNT_LIMIT + 1; index += 1) lines.push('acct' + String(100 + index) + ' mark@123')
  const result = parseBulkAccounts(lines.join('\n'))
  assert.equal(result.rows.length, BULK_ACCOUNT_LIMIT)
  assert.equal(result.problems.length, 1)
  assert.equal(result.problems[0].line, BULK_ACCOUNT_LIMIT + 1)
  assert.match(result.problems[0].reason, /最多/)
})

test('用户名太短或超过 32 位都不算', () => {
  const result = parseBulkAccounts('ab1 mark@123\n' + 'x'.repeat(33) + ' mark@123')
  assert.equal(result.rows.length, 0)
  assert.deepEqual(
    result.problems.map((problem) => problem.reason),
    ['用户名要 4-32 位', '用户名要 4-32 位'],
  )
})
