// 密钥扫描器（B4）的单测：只喂字符串，不碰仓库。
// 关键不是「能报」，而是「只报该报的」——79 条噪音的版本没法进 CI。
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkEnvFile, isFixturePath, looksRandom, maskValue, scanText, shannonEntropy } from '../scripts/scan-secrets.mjs'

// 假 Key 拆开写：这样本文件被仓库扫描时不会命中，同时又能测到拼接后的真格式。
const AWS_KEY = 'AKIA' + 'QZ7XK9T2M4P8W1N3'
const PRIVATE_KEY = '-----BEGIN ' + 'RSA PRIVATE KEY-----'

test('云厂商 Key 与私钥：格式特殊，一出现就报', () => {
  const hits = scanText('const key = "' + AWS_KEY + '"', 'server/x.mjs')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].rule, 'aws-access-key')
  const pem = scanText(PRIVATE_KEY, 'server/y.mjs')
  assert.equal(pem[0].rule, 'private-key')
})

test('带引号的赋值：随机串报，表达式与占位符不报', () => {
  const real = scanText('const config = { apiKey: "9f3a7c11b2e84d6a9f0c3b5d7e1a2f48" }', 'server/a.mjs')
  assert.equal(real.length, 1)
  assert.equal(real[0].rule, 'assigned-secret')
  // 表达式不是 Key
  assert.deepEqual(scanText('const x = { password: hash(password, 10) }', 'server/b.mjs'), [])
  // 环境变量、占位符、夹具口令都不算
  assert.deepEqual(scanText('const k = { apiKey: process.env.VISION_API_KEY }', 'server/c.mjs'), [])
  assert.deepEqual(scanText("const k = { token: '<your-token-here>' }", 'server/d.mjs'), [])
  assert.deepEqual(scanText("const t = { token: 'test-secret-for-gateway' }", 'server/e.mjs'), [])
})

test('不带引号的 env 写法也认，但只认全大写变量名 + 随机串', () => {
  const hits = scanText('VQ_KEY_SECRET=8f14e45fceea167a5a36dedd4bea2543', '.env.production')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].rule, 'env-assignment')
  assert.deepEqual(scanText('MAX_BUFFER=33554432', 'server/f.mjs'), [])
})

test('连接串里的口令与 JWT', () => {
  assert.equal(scanText('const url = "postgres://app:s3cr3tP4ss@db.internal:5432/app"', 'server/g.mjs')[0].rule, 'url-credentials')
  const jwt = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  assert.equal(scanText(jwt, 'server/h.mjs')[0].rule, 'jwt')
})

test('测试与夹具目录豁免值类规则，但私钥不豁免', () => {
  assert.equal(isFixturePath('test/gateway.test.mjs'), true)
  assert.equal(isFixturePath('scripts/test-gateway.mjs'), true)
  assert.equal(isFixturePath('src/api/client.ts'), false)
  // 夹具里的假 sk- Key 不报
  assert.deepEqual(scanText('const key = "sk-canary-vision-key-0001"', 'test/gateway.test.mjs'), [])
  // 私钥在夹具里也照报：那基本就是真事故
  assert.equal(scanText(PRIVATE_KEY, 'test/leak.test.mjs').length, 1)
})

test('行尾 secret-scan:allow 可以豁免一行', () => {
  assert.deepEqual(scanText('const key = "' + AWS_KEY + '" // secret-scan:allow', 'server/i.mjs'), [])
})

test('输出只给首尾几位，不把 Key 再泄一次', () => {
  const masked = maskValue('sk-abcdefghijklmnopqrstuvwxyz012345')
  assert.equal(masked.startsWith('sk-a'), true)
  assert.equal(masked.includes('defghij'), false)
  assert.equal(masked.endsWith('345'), true)
})

test('熵与随机性判据', () => {
  assert.ok(shannonEntropy('9f3a7c11b2e84d6a9f0c3b5d7e1a2f48') > 3.5)
  assert.ok(shannonEntropy('passwordpassword') < 3)
  assert.equal(looksRandom('9f3a7c11b2e84d6a9f0c3b5d7e1a2f48'), true)
  // 手拼的英文词：长度够了，熵不够
  assert.equal(looksRandom('sk-canary-vision-key-0001'), false)
  assert.equal(looksRandom('my-password'), false)
  assert.equal(looksRandom('aaaaaaaaaaaaaaaaaaaa'), false)
})

test('被跟踪的 .env 文件本身就算命中，示例文件放行', () => {
  assert.equal(checkEnvFile('.env')?.rule, 'tracked-env-file')
  assert.equal(checkEnvFile('deploy/.env.production')?.rule, 'tracked-env-file')
  assert.equal(checkEnvFile('.env.example'), null)
  assert.equal(checkEnvFile('src/env.ts'), null)
})
