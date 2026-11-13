// 按状态码统计访问日志（journald 导出的 JSON 行）。
//
// 为什么要有这个小脚本：以前是在服务器上用 grep 数 5xx，写的是 `grep -c -e ,s.:5`，
// 两个坑叠在一起——
//   1) 一条都匹配不到：真实字段是 `,"s":500`，模式里的逗号后面直接跟 s，
//      而真实内容是逗号 + 引号 + s，所以 `,s.:5` 命中 0 行，让人误以为「没有 5xx」；
//   2) 不许逗号的 `s.:5` 又会误命中耗时字段 `"ms":52`，把正常的慢请求数成 5xx。
// 结论：状态码这种结构化字段不要用正则数，解析 JSON 再数。
//
// 用法：
//   node scripts/log-status.mjs .tmp-qa/vq-log-36h.txt        # 统计并列出 5xx
//   node scripts/log-status.mjs log.txt --fail-on-5xx         # 有 5xx 时退出码 1（可挂 CI / 巡检）
//   node scripts/log-status.mjs log.txt --since 2026-11-13T18:20:00Z
import fs from 'node:fs'
import process from 'node:process'

const args = process.argv.slice(2)
const file = args.find((item) => !item.startsWith('--'))
const failOn5xx = args.includes('--fail-on-5xx')
const sinceIndex = args.indexOf('--since')
const since = sinceIndex >= 0 ? Date.parse(args[sinceIndex + 1]) : 0

if (!file) {
  console.error('用法：node scripts/log-status.mjs <journal 导出文件> [--since ISO] [--fail-on-5xx]')
  process.exit(2)
}

const lines = fs.readFileSync(file, 'utf8').split('\n')
const byStatus = {}
const slow = []
const fiveXx = []
let access = 0
let skipped = 0

for (const line of lines) {
  if (!line.trim()) continue
  let record
  try {
    record = JSON.parse(line)
  } catch {
    skipped += 1
    continue
  }
  if (record.t !== 'access') continue
  if (since && Date.parse(record.at) < since) continue
  access += 1
  const status = Number(record.s) || 0
  byStatus[status] = (byStatus[status] || 0) + 1
  if (status >= 500) fiveXx.push(record)
  else if (Number(record.ms) >= 3000) slow.push(record)
}

const keys = Object.keys(byStatus).map(Number).sort((a, b) => a - b)
console.log('访问记录 ' + access + ' 条' + (skipped ? '（另有 ' + skipped + ' 行不是 JSON，已跳过）' : ''))
for (const key of keys) console.log('  ' + key + ': ' + byStatus[key])
console.log('5xx: ' + fiveXx.length)
for (const item of fiveXx.slice(0, 30)) {
  console.log('  ' + item.at + ' ' + item.m + ' ' + item.p + ' → ' + item.s + '（' + item.ms + 'ms）')
}
// 3 秒以上的慢请求单独列：它们不是错误，但会先被人怀疑成错误
console.log('≥3s 的慢请求: ' + slow.length)
for (const item of slow.slice(0, 10)) {
  console.log('  ' + item.at + ' ' + item.m + ' ' + item.p + ' → ' + item.s + '（' + item.ms + 'ms）')
}

if (failOn5xx && fiveXx.length) process.exit(1)
