#!/usr/bin/env node
// 封存包巡检（v0.9.132）：把盘上每个封存包按偏移读一遍、逐条重算 CRC32，写一份报告。
//
//   node scripts/audit-packages.mjs                  # 用 DATA_DIR（默认 ./data）
//   node scripts/audit-packages.mjs --data /path     # 指定数据目录
//   node scripts/audit-packages.mjs --no-write       # 只算不落盘
//   node scripts/audit-packages.mjs --json           # 机器读的结论
//
// 由 systemd 定时任务每天跑一次（deploy/production/visionqa-package-audit.timer）。
// 退出码固定 0：某个包坏了是「结论」，不是「脚本失败」——坏没坏写在报告里，作品页会标出来。
// 参数要在 import 之前处理：config 在模块加载时就定下 dataDir。
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : ''
}
const dataDir = value('--data')
if (dataDir) process.env.DATA_DIR = dataDir
const write = !flag('--no-write')
const asJson = flag('--json')

const { runPackageAudit } = await import('../server/package-audits.mjs')
const { MAX_PACKAGE_BYTES } = await import('../server/zip-read.mjs')
const report = await runPackageAudit({ write })

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const when = report.at.replace('T', ' ').replace(/\.\d+Z?$/, ' UTC')
  console.log('巡检 ' + when + ' · ' + report.checked + ' 个封存包 · ' + (report.problems ? report.problems + ' 个有问题' : '都对得上') + ' · 用了 ' + report.ms + ' ms')
  for (const item of report.packages) {
    const label = item.state === 'ok' ? (item.ok ? '对得上' : '有问题') : item.state
    const detail =
      item.state === 'ok'
        ? item.passed + '/' + item.total + (item.skipped ? ' · ' + item.skipped + ' 条没走完' : '')
        : item.state === 'missing'
          ? '盘上那份不在了'
          : item.state === 'unreadable'
            ? '目录读不出来'
            : '包超过 ' + Math.round(MAX_PACKAGE_BYTES / (1024 * 1024)) + ' MB'
    console.log('  ' + item.projectId + ' v' + item.version + ' ' + item.deliveryId.slice(0, 8) + '  ' + label + '  ' + detail + (item.state === 'ok' ? '  · 读了 ' + item.readBytes + ' B / 包 ' + item.bytes + ' B' : ''))
  }
  if (write) console.log('报告已写：' + 'package-audits.json')
}
