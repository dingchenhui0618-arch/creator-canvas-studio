// package.json 的读法（r316 白屏事故的回归测试）。
//
// 2026-11-26：用 PowerShell 的 Set-Content -Encoding utf8 改版本号，文件被写上 BOM；
// 构建把 ?raw 原文塞进 bundle，首屏执行 JSON.parse 直接抛错——服务端 /api/version 正常，
// 用户看到的是全白页面。这里钉两件事：文件本身不带 BOM；解析函数抹 BOM 且永不抛。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { readPackageVersion } = await import('../src/lib/package-version.ts')

test('package.json 不带 BOM：构建会把它原样塞进前端 bundle', () => {
  const bytes = fs.readFileSync(path.join(root, 'package.json'))
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'package.json 开头有 UTF-8 BOM')
  assert.equal(bytes.subarray(0, 1).toString('utf8'), '{', 'package.json 第一个字符应该是 {')
  const raw = bytes.toString('utf8')
  assert.doesNotThrow(() => JSON.parse(raw), '直接 JSON.parse 就该成功，前端不会被逼着先抹 BOM')
})

test('版本号：干净原文能读，带 BOM 也能读，坏了只回空串', () => {
  assert.equal(readPackageVersion('{"name":"x","version":"1.2.3"}'), '1.2.3')
  assert.equal(readPackageVersion('\uFEFF{"name":"x","version":"1.2.3"}'), '1.2.3')
  assert.equal(readPackageVersion('{"name":"x"}'), '')
  assert.equal(readPackageVersion('{"version":42}'), '')
  assert.equal(readPackageVersion(''), '')
  assert.equal(readPackageVersion('not json'), '')
  assert.equal(readPackageVersion('\uFEFF'), '')
})

test('真实 package.json 读出来的版本与服务端一致（同一个字段，不各写一份）', () => {
  const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  const version = readPackageVersion(raw)
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.equal(version, JSON.parse(raw).version)
})
