// 运行水位：这台机器现在还能接多少活。
//
// 背景：单机 2 核 / 1.86 GB 内存，Node 堆上限 384 MB（systemd 里 NODE_OPTIONS=--max-old-space-size=384）。
// 一次复刻要同时跑 ffmpeg 子进程和逐帧视觉，一次画布运行要下载并分析多张图：两条重活并行就能把内存顶穿。
// 真被顶穿时进程会被内核或 V8 直接杀掉——所有人的会话一起断，正在跑的任务只能靠重启恢复退款，
// 钱是退回来了，但用户看到的是一句「任务被系统中断」。
//
// 所以这里只做四件很朴素的事：
//   量：读 /proc/meminfo 的 MemAvailable（含可回收缓存）与 V8 的真实堆用量，不拿 RSS 猜；
//   降：水位偏紧时把重活的并发上限压到 1，宁可慢一点，不要两条一起死；
//   限：全站（不分账号）同时在跑的重活有条数上限——按账号的并发管不住「两个账号各来两条」；
//   拒：真到红线、或全站重活已经满了，就在扣费之前拒绝，并说清「没扣积分、多久后再试」。
//
// 三条边界：
//   1) 只拦重活（复刻 / 评审 / 画布运行）；检索只是转发一个 HTTP、对话只有几十 KB 上下文，不跟着拦；
//   2) 阈值可用环境变量覆盖：写 0 等于关掉那一条，VQ_WATER_GUARD=0 只量不拦；
//   3) 判定是纯函数、读数是注入的——测试不依赖跑测试这台机器的内存大小。
import fs from 'node:fs'
import os from 'node:os'
import v8 from 'node:v8'
import { config } from './config.mjs'
import { recordAlert } from './alerts.mjs'
import { activeFor } from './gate.mjs'

const MB = 1048576
export const HEAVY_KINDS = ['replicate', 'review', 'flow_run']
const HEAVY = new Set(HEAVY_KINDS)
// 同一条红线 5 分钟内只记一条告警：拒绝可能连着来，告警队列不该被刷屏
const ALERT_GAP_MS = 5 * 60 * 1000
let lastAlertAt = 0
// 拒绝时告诉前端多久后再试：60 秒足够一条重活跑完或内存回落
const RETRY_AFTER_SEC = 60

const round = (value) => Math.round(Number(value) || 0)
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100

/** 系统内存：Linux 读 /proc/meminfo，其它平台退回 os 的读数（口径写在返回值里，别混着用）。 */
export function readMemoryFacts() {
  let totalMb = round(os.totalmem() / MB)
  let availableMb = round(os.freemem() / MB)
  let source = 'os'
  let swapTotalMb = 0
  let swapFreeMb = 0
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const pick = (key) => {
      const hit = text.match(new RegExp('^' + key + ':\\s+(\\d+) kB', 'm'))
      return hit ? Math.round(Number(hit[1]) / 1024) : null
    }
    const total = pick('MemTotal')
    const available = pick('MemAvailable')
    const sTotal = pick('SwapTotal')
    const sFree = pick('SwapFree')
    if (total) totalMb = total
    // MemAvailable 才是「还能给新活多少」：MemFree 会把可回收的页缓存算成不可用，误判成快满了
    if (available !== null) {
      availableMb = available
      source = 'proc'
    }
    if (sTotal) swapTotalMb = sTotal
    if (sFree !== null) swapFreeMb = sFree
  } catch {
    // 非 Linux（本机开发是 Windows）：用 os 的读数，口径记在 source 里
  }
  return { totalMb, availableMb, source, swapTotalMb, swapFreeMb, swapUsedMb: Math.max(0, swapTotalMb - swapFreeMb) }
}

/** 进程堆：上限取 V8 的真实值（跟着 --max-old-space-size 走），不是拿 RSS 猜。 */
export function readHeapFacts() {
  const usage = process.memoryUsage()
  const limitMb = round(v8.getHeapStatistics().heap_size_limit / MB)
  const heapUsedMb = round(usage.heapUsed / MB)
  return {
    rssMb: round(usage.rss / MB),
    heapUsedMb,
    heapTotalMb: round(usage.heapTotal / MB),
    heapLimitMb: limitMb,
    heapPercent: limitMb ? Math.round((heapUsedMb / limitMb) * 100) : 0,
  }
}

/** 生效中的阈值：环境变量漏配 / 写空都回到默认值，不会因为空值把闸门悄悄关掉。 */
export function thresholds() {
  const raw = config.waterline || {}
  const num = (value, fallback) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return {
    guard: raw.guard !== false,
    tightAvailableMb: num(raw.tightAvailableMb, 320),
    criticalAvailableMb: num(raw.criticalAvailableMb, 128),
    tightHeapPercent: num(raw.tightHeapPercent, 80),
    criticalHeapPercent: num(raw.criticalHeapPercent, 92),
  }
}

/** 纯判定：给两个读数 + 两个阈值，回答现在能不能接重活。 */
export function assessWaterline({ memory, heap } = {}, limits = thresholds()) {
  const availableMb = round(memory?.availableMb)
  const heapPercent = round(heap?.heapPercent)
  const critical = []
  if (Number(limits.criticalAvailableMb) > 0 && availableMb < Number(limits.criticalAvailableMb)) {
    critical.push('系统可用内存 ' + availableMb + ' MB，低于红线 ' + limits.criticalAvailableMb + ' MB')
  }
  if (Number(limits.criticalHeapPercent) > 0 && heapPercent >= Number(limits.criticalHeapPercent)) {
    critical.push('进程堆已用 ' + heapPercent + '%，接近 ' + round(heap?.heapLimitMb) + ' MB 上限')
  }
  if (critical.length) return { level: 'critical', reasons: critical, availableMb, heapPercent }
  const tight = []
  if (Number(limits.tightAvailableMb) > 0 && availableMb < Number(limits.tightAvailableMb)) {
    tight.push('系统可用内存 ' + availableMb + ' MB，低于警戒线 ' + limits.tightAvailableMb + ' MB')
  }
  if (Number(limits.tightHeapPercent) > 0 && heapPercent >= Number(limits.tightHeapPercent)) {
    tight.push('进程堆已用 ' + heapPercent + '%，超过 ' + limits.tightHeapPercent + '%')
  }
  return { level: tight.length ? 'tight' : 'ok', reasons: tight, availableMb, heapPercent }
}

/** 按水位折算并发上限：偏紧时重活只放一条（原来不限也收紧到 1），其余不动。 */
export function capacityFor(kind, max, level = 'ok') {
  const cap = Math.max(0, Math.round(Number(max) || 0))
  if (!HEAVY.has(kind)) return cap
  // 到红线时重活在入口就被拒（admit），这里回 0 是为了后台那一屏不自相矛盾
  if (level === 'critical') return 0
  if (level === 'tight') return cap > 0 ? Math.min(cap, 1) : 1
  return cap
}

/**
 * 全站重活上限（不分账号）：0 表示不限（配置写 0 即恢复旧行为）。
 * 水位偏紧时收紧到 2 条，到红线时由 admit 整体拒绝，这里回 0 只是为了让后台那一屏不矛盾。
 */
export function globalHeavyCap(level = 'ok') {
  const raw = Math.max(0, Math.round(Number(config.credits.globalHeavy) || 0))
  if (!raw) return 0
  if (level === 'critical') return 0
  if (level === 'tight') return Math.min(raw, 2)
  return raw
}

/** 给后台看的一屏：读数、判定、阈值、折算后的并发上限、全站正在跑几条。 */
export function waterlineReport() {
  const limits = thresholds()
  const memory = readMemoryFacts()
  const heap = readHeapFacts()
  const load = os.loadavg()
  const verdict = assessWaterline({ memory, heap }, limits)
  const capacity = {}
  const baseCapacity = {}
  for (const kind of HEAVY_KINDS) {
    baseCapacity[kind] = Math.max(0, Math.round(Number(config.credits.concurrency[kind]) || 0))
    // 守卫关掉时不做折算：那一屏要如实显示「现在会按几条放行」
    capacity[kind] = limits.guard ? capacityFor(kind, baseCapacity[kind], verdict.level) : baseCapacity[kind]
  }
  // 在跑的重活：跨账号的真实计数（来自并发闸门的进程内计数，不是任务表里的历史行）
  const active = activeFor(HEAVY_KINDS)
  const globalLimit = limits.guard ? globalHeavyCap(verdict.level) : 0
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    level: verdict.level,
    reasons: verdict.reasons,
    guard: limits.guard,
    heavy: {
      active: active.total,
      byKind: active.byKind,
      // limit = 0 表示不限：配置没开这一层，或者整条守卫被关掉
      limit: globalLimit,
      unlimited: globalLimit === 0,
      configLimit: Math.max(0, Math.round(Number(config.credits.globalHeavy) || 0)),
      full: globalLimit > 0 && active.total >= globalLimit,
    },
    memory,
    heap,
    cpu: { cores: os.cpus().length || 1, load1: round2(load[0]), load5: round2(load[1]), load15: round2(load[2]) },
    thresholds: limits,
    capacity,
    baseCapacity,
    retryAfterSec: RETRY_AFTER_SEC,
    heavyKinds: HEAVY_KINDS,
  }
}

function alertOnce(kind, verdict, reason) {
  const now = Date.now()
  if (now - lastAlertAt < ALERT_GAP_MS) return
  lastAlertAt = now
  // 只落站内队列 + 已有的外推链，不等它：这条拒绝的响应不该被告警网络拖慢
  recordAlert({
    kind: 'memory',
    level: 'warn',
    title: '内存到红线，已拒绝新任务',
    detail: '被拒：' + kind + '；' + reason,
    dedupeKey: 'memory-pressure',
  }).catch(() => {})
}

/** 扣费前的闸门：返回 ok 或一条可以直接回给前端的 503。 */
export function admit(kind) {
  const limits = thresholds()
  if (!limits.guard || !HEAVY.has(kind)) return { ok: true, level: 'ok' }
  const memory = readMemoryFacts()
  const heap = readHeapFacts()
  const verdict = assessWaterline({ memory, heap }, limits)
  if (verdict.level !== 'critical') {
    // 全站重活已满：这一单不接（走到这里说明内存还没到红线，只是同时在跑的活太多了）。
    // 检查与后面 enter() 的加一在同一段同步代码里，中间没有 await，
    // 所以单线程下不会出现两个请求都看见「还差一个空位」然后一起挤进去。
    const cap = globalHeavyCap(verdict.level)
    if (cap > 0) {
      const active = activeFor(HEAVY_KINDS)
      if (active.total >= cap) {
        const internal = config.ui.mode === 'internal'
        return {
          ok: false,
          level: verdict.level,
          status: 503,
          body: {
            error: internal
              ? '服务器正在同时跑 ' + active.total + ' 条重活（上限 ' + cap + ' 条），这条任务没有开始（没有扣积分）。等一分钟再试。'
              : '服务器正忙，这条任务没有开始（没有扣积分）；等一分钟再试，或者稍后挑个空的时候再跑。',
            code: 'SERVER_BUSY',
            level: verdict.level,
            active: active.total,
            limit: cap,
            retryAfterSec: RETRY_AFTER_SEC,
            ...(internal ? { busyKinds: active.byKind } : {}),
          },
        }
      }
    }
    return { ok: true, level: verdict.level }
  }
  const reason = verdict.reasons.join('；')
  alertOnce(String(kind), verdict, reason)
  const internal = config.ui.mode === 'internal'
  return {
    ok: false,
    level: 'critical',
    status: 503,
    body: {
      error: internal
        ? '服务器内存紧张，这条任务没有开始（没有扣积分）：' + reason + '。等一分钟再试。'
        : '服务器内存紧张，这条任务没有开始（没有扣积分）；等一分钟再试，或者稍后挑个空的时候再跑。',
      code: 'MEMORY_PRESSURE',
      level: 'critical',
      retryAfterSec: RETRY_AFTER_SEC,
      ...(internal ? { reasons: verdict.reasons, availableMb: verdict.availableMb, heapPercent: verdict.heapPercent } : {}),
    },
  }
}

/** 测试用：清掉告警节流，让下一次临界判定重新记一条。 */
export function resetWaterlineAlert() {
  lastAlertAt = 0
}
