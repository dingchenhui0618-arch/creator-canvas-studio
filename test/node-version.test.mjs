// B9：Node 版本锁的判据。生产钉 22.12.0，CI 跑 22.12.0 与 24。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { assertSupportedNode, checkNodeVersion, compareVersions, parseNodeVersion } from '../server/node-version.mjs'

test('版本号解析：认 v 前缀，不认垃圾', () => {
  assert.deepEqual(parseNodeVersion('v22.12.0'), { major: 22, minor: 12, patch: 0, version: '22.12.0', raw: 'v22.12.0' })
  assert.equal(parseNodeVersion('24.15.0').major, 24)
  assert.equal(parseNodeVersion(''), null)
  assert.equal(parseNodeVersion('not-a-version'), null)
})

test('三段比较只比数字', () => {
  assert.equal(compareVersions('22.12.0', '22.12.0'), 0)
  assert.equal(compareVersions('v24.0.0', '22.12.0'), 1)
  assert.equal(compareVersions('22.11.9', '22.12.0'), -1)
  assert.equal(compareVersions('22.12', '22.12.0'), null)
})

test('生产版本就是下限：22.12.0 必须算通过', () => {
  const result = checkNodeVersion({ node: '22.12.0' })
  assert.equal(result.ok, true)
  assert.equal(result.level, 'supported')
  assert.equal(result.min, '22.12.0')
})

test('更低的版本标 too-old，别让它跑到 SQLite 才炸', () => {
  assert.equal(checkNodeVersion({ node: '22.11.9' }).level, 'too-old')
  assert.equal(checkNodeVersion({ node: '20.19.0' }).ok, false)
  assert.equal(checkNodeVersion({ node: '22.11.9' }).ok, false)
})

test('比验证过的更新：能跑但明确标未验证', () => {
  const result = checkNodeVersion({ node: '25.1.0' })
  assert.equal(result.ok, true)
  assert.equal(result.level, 'untested')
  assert.match(result.message, /没测过/)
})

test('读不出版本时不能当通过', () => {
  assert.equal(checkNodeVersion({}).ok, false)
  assert.equal(checkNodeVersion({ node: 'unknown' }).level, 'invalid')
})

test('assertSupportedNode 太旧时退出 78（EX_CONFIG），支持范围内直接返回', () => {
  assert.equal(assertSupportedNode({ node: '22.12.0' }).level, 'supported')
  // 太旧会真的 process.exit，所以起子进程验证，别把测试进程带走
  const moduleUrl = new URL('../server/node-version.mjs', import.meta.url).href
  const script = 'import { assertSupportedNode } from ' + JSON.stringify(moduleUrl) + "; assertSupportedNode({ node: '22.11.0' })"
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(child.status, 78)
  assert.match(child.stderr, /太旧/)
})
