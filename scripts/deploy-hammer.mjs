#!/usr/bin/env node
// 发版期间的可用性探针（B3「发布期间 0 个失败请求」的验收工具）。
//
// 做法：按固定间隔请求一个只读接口，把「连不上 / 超时 / 非 200」都算失败，
// 结束后打印总请求数、失败数、最长无响应间隔——部署脚本重启服务的那几秒会立刻暴露出来。
//
// 用法：
//   node scripts/deploy-hammer.mjs --url https://visionqa.wavisionai.cn/api/version --seconds 40
//   node scripts/deploy-hammer.mjs --url http://127.0.0.1:8799/api/version --seconds 20 --interval 50
//   node scripts/deploy-hammer.mjs ... --allow-failures   # 只观察，不因失败退出 1
//
// 断言口径：全部请求 200 = 通过；任何一条不是 200（含网络错误）= 失败，退出码 1。
// 两种写法都收：--url=https://... 与 --url https://...（后者更常见，别再被解析成 true）
const argv = process.argv.slice(2)
const args = {}
for (let index = 0; index < argv.length; index += 1) {
  const item = argv[index]
  if (!item.startsWith('--')) continue
  const eq = item.indexOf('=')
  if (eq > 0) {
    args[item.slice(2, eq)] = item.slice(eq + 1)
  } else {
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args[item.slice(2)] = next
      index += 1
    } else {
      args[item.slice(2)] = 'true'
    }
  }
}

if (!args.url || !/^https?:\/\//.test(args.url)) {
  console.error('用法：node scripts/deploy-hammer.mjs --url <接口地址> [--seconds 30] [--interval 100] [--allow-failures]')
  process.exit(2)
}
const url = args.url || 'http://127.0.0.1:8799/api/version'
const seconds = Number(args.seconds || 30)
const interval = Number(args.interval || 100)
const timeoutMs = Number(args.timeout || 5000)
const allowFailures = args['allow-failures'] === 'true'

const started = Date.now()
const deadline = started + seconds * 1000
const failures = []
let ok = 0
let total = 0
let lastOkAt = started
let longestGapMs = 0

async function once() {
  const at = new Date().toISOString()
  total += 1
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'cache-control': 'no-store' } })
    await res.text()
    if (res.status !== 200) {
      failures.push({ at, status: res.status })
      return
    }
    ok += 1
    const now = Date.now()
    longestGapMs = Math.max(longestGapMs, now - lastOkAt)
    lastOkAt = now
  } catch (error) {
    failures.push({ at, error: String(error?.name || error?.message || error) })
  } finally {
    clearTimeout(timer)
  }
}

while (Date.now() < deadline) {
  await once()
  await new Promise((resolve) => setTimeout(resolve, interval))
}

// 最后一段也算进「最长无响应」：如果结束时正好卡住，这里能看出来
longestGapMs = Math.max(longestGapMs, Date.now() - lastOkAt)

const summary = {
  url,
  seconds,
  interval,
  total,
  ok,
  failed: failures.length,
  longestGapMs,
  failures: failures.slice(0, 20),
}
console.log(JSON.stringify(summary, null, 2))
if (failures.length && !allowFailures) process.exit(1)
