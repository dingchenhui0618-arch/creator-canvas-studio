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
//   1) 只拦重活（复刻 / 评审 / 画布运行 / 画布出图）；检索只是转发一个 HTTP、对话只有几十 KB 上下文，不跟着拦；
//   2) 阈值可用环境变量覆盖：写 0 等于关掉那一条，VQ_WATER_GUARD=0 只量不拦；
//   3) 判定是纯函数、读数是注入的——测试不依赖跑测试这台机器的内存大小。
import fs from 'node:fs'
import os from 'node:os'
import v8 from 'node:v8'
import { config } from './config.mjs'
import { recordAlert } from './alerts.mjs'
import { activeFor } from './gate.mjs'
import { acquireHeavyLease, heavyLeaseStatus } from './heavy-lease.mjs'

const MB = 1048576
export const HEAVY_KINDS = ['replicate', 'review', 'flow_run', 'canvas_gen']
const HEAVY = new Set(HEAVY_KINDS)
// 没有账号可挂的重活（v0.9.79）：画布出图走平台令牌，请求里没有用户 id，
// 「每账号上限」对它用不上，所以它的按类型上限落到整机（见 kindLimitFor）。
const NO_USER_KINDS = new Set(['canvas_gen'])
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
  // 在跑的重活：整机的真实计数（v0.9.78 起来自共享目录的租约，跨两个实例；不是任务表里的历史行）
  const lease = heavyLeaseStatus()
  const active = lease.source === 'lease' ? { total: lease.total, byKind: lease.byKind } : activeFor(HEAVY_KINDS)
  const globalLimit = limits.guard ? globalHeavyCap(verdict.level) : 0
  // 按类型的整机上限（v0.9.79）：守卫关掉时如实显示「会按几条放行」，和 capacity 一个口径
  const kindLimits = {}
  for (const kind of NO_USER_KINDS) {
    const base = Math.max(0, Math.round(Number(config.credits.concurrency[kind]) || 0))
    kindLimits[kind] = limits.guard ? capacityFor(kind, base, verdict.level) : base
  }
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
      // 按类型的整机上限：目前只有画布出图（没有账号可挂的那一类）
      kindLimits,
      // 排队位（v0.9.80）：画布出图名额满时先排一会儿再拒——那一次「批量出图」还会不会整批失败，看这里
      queue: admissionQueueReport('canvas_gen'),
      // scope=lease 表示这个数整机共用（两个实例同一个数）；process 表示退回进程内计数
      scope: lease.source,
      lease,
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

/**
 * 这一类在整机上最多放几条（v0.9.79）。
 * 只有「没有账号可挂」的通道需要它：画布出图走平台令牌，每账号上限对它无从下手，
 * 所以 VQ_CONCURRENCY_CANVAS_GEN 是整机口径——一张画布点批量出图时，机器只放这么多张。
 * 守卫关掉时回 0：那一档是「只量不拦」。
 */
export function kindLimitFor(kind, level = 'ok', guard = true) {
  if (!guard) return 0
  if (!NO_USER_KINDS.has(kind)) return 0
  return capacityFor(kind, config.credits.concurrency[kind], level)
}

// ─── 画布出图的排队位（v0.9.80） ──────────────────────────────────────────────
// 一次「批量出图」会连发 8 张，整机只放 2 张。v0.9.79 是第 3 张起立刻 503，
// 画布上看到的就是「6 张失败」；可画布其实等得起（同步出图超时 1800 秒）。
// 所以名额满时先排一会儿：排到了照常出图，排不到才拒——拒绝仍然发生在调上游之前，
// 这一单不花钱。三件事刻意做成这样：
//   1) 只给没有账号可挂的那一类排队（现在只有画布出图）；其余重活有账号，客户端自己重试更合适；
//   2) 排队位是本进程的（两个实例各排各的），但占名额仍走共享租约——整机不会因此超放；
//   3) 内存到红线不排队：等一分钟也不会变好，直接拒（admit 已经记过告警）。
const QUEUE_TICK_MS = 350
const QUEUE_STARTED_AT = new Date().toISOString()
const queueWaiting = new Map()
const queueStats = new Map()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 等待时长写成好读的秒：0.4 秒 / 3.4 秒 / 90 秒——别把 400 毫秒写成「0 秒」
function waitText(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000
  return seconds >= 10 ? String(Math.round(seconds)) : String(Math.round(seconds * 10) / 10)
}

/** 这一类的排队位参数；0 表示不排队（立刻拒，v0.9.79 的行为）。 */
export function queueLimitsFor(kind) {
  const raw = (config.credits && config.credits.canvasQueue) || {}
  if (!HEAVY_KINDS.includes(kind) || !NO_USER_KINDS.has(kind)) return { waitMs: 0, maxWaiting: 0 }
  return {
    waitMs: Math.max(0, Math.round(Number(raw.waitMs) || 0)),
    maxWaiting: Math.max(0, Math.round(Number(raw.maxWaiting) || 0)),
  }
}

function queueStat(kind) {
  let stat = queueStats.get(kind)
  if (!stat) {
    stat = { entered: 0, served: 0, timedOut: 0, full: 0, abandoned: 0, maxWaitMs: 0 }
    queueStats.set(kind, stat)
  }
  return stat
}

/** 后台看的一行排队位：现在几条在等、这一轮排到了几条、超时/排满/客户端走了各几次。 */
export function admissionQueueReport(kind = 'canvas_gen') {
  const limits = queueLimitsFor(kind)
  return {
    kind,
    waitMs: limits.waitMs,
    maxWaiting: limits.maxWaiting,
    waiting: queueWaiting.get(kind) || 0,
    ...queueStat(kind),
    since: QUEUE_STARTED_AT,
  }
}

function queueGone(kind) {
  const stat = queueStat(kind)
  stat.abandoned += 1
}

/**
 * 带排队的名额申请：先试一次 admit（不排队时这就是全部），满了再按 tick 轮询到 deadline。
 * 返回和 admit 同形状，多三个字段：queued（排过队）、waitedMs（等了多久）、aborted（客户端已经走了）。
 * aborted 时调用方不要写响应、更不要调上游。
 */
export async function admitWaiting(kind, options = {}) {
  const first = admit(kind)
  const limits = queueLimitsFor(kind)
  if (first.ok) return { ...first, queued: false, waitedMs: 0 }
  // 排队关掉、或者内存到红线：立刻拒（红线再等也不会变好）
  if (!limits.waitMs || !limits.maxWaiting || first.level === 'critical') {
    return { ...first, queued: false, waitedMs: 0 }
  }
  const stat = queueStat(kind)
  const waiting = queueWaiting.get(kind) || 0
  if (waiting >= limits.maxWaiting) {
    // 排队位也满了：这一单直接拒，别把连接堆在这里
    stat.full += 1
    const body = first.body || {}
    const internal = config.ui.mode === 'internal'
    return {
      ...first,
      queued: false,
      waitedMs: 0,
      queueFull: true,
      body: {
        ...body,
        code: 'SERVER_BUSY',
        error: internal
          ? '排队位已经满了（' + waiting + ' / ' + limits.maxWaiting + ' 条在等），这次生成没有开始（没有产生费用）。少发几张，或者等一分钟再试。'
          : '这次生成没有开始（没有产生费用）：前面排的几张还没排到，这次排不进来了。少发几张，或者等一分钟再试。',
        retryAfterSec: RETRY_AFTER_SEC,
        ...(internal ? { queueWaiting: waiting, queueMax: limits.maxWaiting } : {}),
      },
    }
  }

  queueWaiting.set(kind, waiting + 1)
  stat.entered += 1
  const startedAt = Date.now()
  const deadline = startedAt + limits.waitMs
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false
  const tickMs = Math.max(20, Math.round(Number(options.tickMs) || QUEUE_TICK_MS))
  let last = first
  try {
    while (true) {
      if (isAborted()) {
        queueGone(kind)
        return { ok: false, aborted: true, status: 499, level: last.level, lease: null, queued: false, waitedMs: Date.now() - startedAt, body: { code: 'CLIENT_GONE', error: '客户端已经断开' } }
      }
      const left = deadline - Date.now()
      if (left <= 0) break
      // 抖动：同一刻进来的几条别每 350 毫秒一起去撞租约目录的锁
      await sleep(Math.min(left, tickMs + Math.round(Math.random() * 120)))
      if (isAborted()) {
        queueGone(kind)
        return { ok: false, aborted: true, status: 499, level: last.level, lease: null, queued: false, waitedMs: Date.now() - startedAt, body: { code: 'CLIENT_GONE', error: '客户端已经断开' } }
      }
      last = admit(kind)
      if (last.ok) {
        const waitedMs = Date.now() - startedAt
        stat.served += 1
        stat.maxWaitMs = Math.max(stat.maxWaitMs, waitedMs)
        return { ...last, queued: true, waitedMs }
      }
      // 排队期间水位掉到红线：别等了，直接把红线那条回给它
      if (last.level === 'critical') return { ...last, queued: false, waitedMs: Date.now() - startedAt }
    }
    const waitedMs = Date.now() - startedAt
    stat.timedOut += 1
    stat.maxWaitMs = Math.max(stat.maxWaitMs, waitedMs)
    const body = last.body || {}
    const internal = config.ui.mode === 'internal'
    return {
      ...last,
      ok: false,
      queued: true,
      timedOut: true,
      waitedMs,
      body: {
        ...body,
        code: 'SERVER_BUSY',
        error: internal
          ? '排队等了 ' + waitText(waitedMs) + ' 秒还没轮到（同时最多 ' + (last.kindLimit || 0) + ' 条），这次生成没有开始（没有产生费用）。少发几张，或者等一分钟再试。'
          : '这次生成没有开始（没有产生费用）：排队等了 ' + waitText(waitedMs) + ' 秒还没轮到。少发几张，或者等一分钟再试。',
        retryAfterSec: RETRY_AFTER_SEC,
        ...(internal ? { waitedMs, queueWaiting: queueWaiting.get(kind) || 0, kindActive: last.kindActive ?? null, kindLimit: last.kindLimit || null } : {}),
      },
    }
  } finally {
    queueWaiting.set(kind, Math.max(0, (queueWaiting.get(kind) || 1) - 1))
  }
}

/** 按类型的名额排满时回的那一条：和「整机排满」分开说，下一步动作不一样（等一分钟 vs 少发几张）。 */
function kindBusyBody(kind, got, cap, level) {
  const internal = config.ui.mode === 'internal'
  return {
    error: internal
      ? '这一类的任务已经在同时跑 ' + got.kindActive + ' 条（上限 ' + got.kindLimit + ' 条，整机合计 ' + got.active + ' 条），这条没有开始（没有产生费用）。等一分钟再试，或者少发几张。'
      : '这条任务没有开始（没有产生费用）：服务器正忙着处理同类请求，等一分钟再试，或者少发几张。',
    code: 'SERVER_BUSY',
    kind,
    level,
    active: got.active,
    limit: cap,
    retryAfterSec: RETRY_AFTER_SEC,
    ...(internal ? { busyKinds: got.byKind, kindActive: got.kindActive, kindLimit: got.kindLimit } : {}),
  }
}

/** 名额满时回给前端的那一条：生产口径不带内部读数，内部环境才给按类型的明细。 */
function busyBody(active, cap, level, extra = {}) {
  const internal = config.ui.mode === 'internal'
  return {
    error: internal
      ? '服务器正在同时跑 ' + active.total + ' 条重活（上限 ' + cap + ' 条），这条任务没有开始（没有扣积分）。等一分钟再试。'
      : '服务器正忙，这条任务没有开始（没有扣积分）；等一分钟再试，或者稍后挑个空的时候再跑。',
    code: 'SERVER_BUSY',
    level,
    active: active.total,
    limit: cap,
    retryAfterSec: RETRY_AFTER_SEC,
    ...(internal ? { busyKinds: active.byKind, ...extra } : {}),
  }
}

/**
 * 扣费前的闸门：返回 ok（带一个必须 release 的名额）或一条可以直接回给前端的 503。
 *
 * v0.9.78 起「数名额」和「占名额」是同一件事：重活在共享目录里占一条租约，
 * 两个实例（对外 + 内部版）看到的是同一个数。租约写不进去时退回进程内计数，
 * 行为和 v0.9.77 一样——宁可少一层保护，也不能因为目录权限把重活全拒了。
 */
export function admit(kind) {
  const limits = thresholds()
  if (!HEAVY.has(kind)) return { ok: true, level: 'ok', lease: null }
  let level = 'ok'
  let reasons = []
  if (limits.guard) {
    const memory = readMemoryFacts()
    const heap = readHeapFacts()
    const verdict = assessWaterline({ memory, heap }, limits)
    level = verdict.level
    if (level === 'critical') {
      const reason = verdict.reasons.join('；')
      alertOnce(String(kind), verdict, reason)
      const internal = config.ui.mode === 'internal'
      return {
        ok: false,
        level: 'critical',
        status: 503,
        lease: null,
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
    reasons = verdict.reasons
  }
  // 守卫关掉时也占租约：后台那一屏要能看见「整机在跑几条」，只是不拦
  const cap = limits.guard ? globalHeavyCap(level) : 0
  // 按类型的整机上限：目前只有画布出图用（见 kindLimitFor），其它重活靠每账号上限压
  const kindLimit = kindLimitFor(kind, level, limits.guard)
  const got = acquireHeavyLease(kind, { limit: cap, kindLimit })
  if (!got.ok) {
    // 两种「满」分开说：整机总名额满 = 等一会儿；同类排满 = 少发几张也是快的
    const byKindFull = got.kindFull && !got.full
    return {
      ok: false,
      level,
      status: 503,
      lease: null,
      scope: got.source,
      kindFull: byKindFull,
      kindActive: got.kindActive ?? null,
      kindLimit,
      body: byKindFull
        ? kindBusyBody(kind, got, cap, level)
        : busyBody({ total: got.active, byKind: got.byKind || {} }, cap, level, got.leases ? { busyLeases: got.leases.length } : {}),
    }
  }
  if (got.source !== 'lease' && (cap > 0 || kindLimit > 0)) {
    // 共享目录用不了：退回进程内的计数，也就是 v0.9.77 的判定（按类型的这一层也照样算）
    const active = activeFor(HEAVY_KINDS)
    const kindActive = activeFor([kind]).total
    const totalFull = cap > 0 && active.total >= cap
    const singleFull = kindLimit > 0 && kindActive >= kindLimit
    if (totalFull || singleFull) {
      got.lease.release()
      const body = singleFull && !totalFull
        ? kindBusyBody(kind, { kindActive, kindLimit, active: active.total, byKind: active.byKind }, cap, level)
        : busyBody(active, cap, level)
      return { ok: false, level, status: 503, lease: null, scope: got.source, kindFull: singleFull && !totalFull, kindActive, kindLimit, body }
    }
  }
  return { ok: true, level, reasons, lease: got.lease, active: got.active, kindActive: got.kindActive, kindLimit, scope: got.source }
}

/**
 * 后台的「现在能接一条重活吗」预检：走和真实请求完全一样的 admit，
 * 占到的名额立刻还回去，所以不扣积分、不调上游、不落记录。
 */
export function admissionCheck(kind) {
  const started = Date.now()
  const water = admit(kind)
  if (water.lease) water.lease.release()
  return {
    ok: water.ok,
    kind,
    level: water.level,
    status: water.ok ? 200 : water.status,
    code: water.ok ? '' : (water.body && water.body.code) || '',
    active: water.ok ? (water.active || 0) : water.body.active,
    limit: water.ok ? null : water.body.limit,
    scope: water.scope || (water.body && water.body.scope) || null,
    byKind: water.ok ? null : water.body.busyKinds || null,
    // 按类型的名额（v0.9.79）：画布出图排满时，整机总名额可能还没满——预检要说清是哪一层
    kindFull: Boolean(water.kindFull),
    kindActive: water.kindActive ?? null,
    kindLimit: water.kindLimit || null,
    ms: Date.now() - started,
    checkedAt: new Date().toISOString(),
  }
}

/** 测试用：清掉告警节流，让下一次临界判定重新记一条。 */
export function resetWaterlineAlert() {
  lastAlertAt = 0
}