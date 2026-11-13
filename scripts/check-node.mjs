#!/usr/bin/env node
// 打印当前 Node 是否在支持范围内；CI 与本地都用它自检，版本不对就退出 1。
// 真正拦启动的是 server/node-guard.mjs（退出 78），这里是给人看的一行结论。
import { checkNodeVersion, POLICY } from '../server/node-version.mjs'

const result = checkNodeVersion()
console.log('Node ' + result.node + ' · ' + POLICY + ' · ' + (result.level === 'supported' ? '通过' : result.level === 'untested' ? '未验证（可继续）' : '不在支持范围'))
if (result.message) console.log(result.message)
if (!result.ok) {
  console.error('启动要求见 deploy/production/visionqa.service（ExecStart 带 --experimental-sqlite）')
  process.exitCode = 1
}
