// 跨进程重活租约（v0.9.78）：同一台机器上不止一个 Node 实例。
//
// 为什么要有它：生产机同时跑着 visionqa.service（对外，8799）和 visionqa-internal.service
// （内部版，8800，连 DATA_DIR 都是另一份）。两边的并发计数各在各自进程里，
// 于是「全站重活上限 3 条」实际是「每个进程 3 条」——两个实例叠起来就是 6 条重活压在
// 同一台 2 核 / 1.86 GB 上；而内存红线（waterline）看的是整机，只有一条线。
// 评审 worker 池也一样：每进程 3 个 192 MB 堆，两个实例就是 6 个。
//
// 做法很朴素，不引新依赖：
//   一条租约 = 共享目录里的一个文件（只用它做计数，不放任务内容）；
//   「数一下 + 占一个」放在 mkdir 出来的目录锁里做——跨进程这就是原子的；
//   进程被 SIGKILL 掉的租约靠 pid 已经不在来清（不用等超时）；
//   活着的租约每 15 秒摸一次 mtime，半小时没动静的按泄漏清掉；
//   目录写不了 / 拿不到锁时不硬扛：退回进程内计数（和 v0.9.77 一样），状态里标 degraded。
//
// 三条边界：
//   1) 租约只在同一台机器上互认——目录是本地 tmpfs/磁盘，多机部署要另外的协调者（没做）；
//   2) 目录权限是 0777：两个实例一个是 visionqa、一个是 root，得互相能写；
//      这台机器上只有这两个服务账号，信任边界写在部署文档里；
//   3) 只有重活（复刻 / 评审 / 画布运行）占租约：检索只是转发一个 HTTP、对话只有几十 KB。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 与 waterline 的 HEAVY_KINDS 同一份含义。分开写是为了不让 waterline 反过来依赖这里（会成环）。
// canvas_gen = 画布出图 / 出视频（平台令牌通道，没有账号可挂）：它同样要吃上游额度、
// 占这台机器的连接与内存，所以一样算重活（v0.9.79）。
const HEAVY = new Set(['replicate', 'review', 'flow_run', 'canvas_gen'])
const DIRNAME = 'visionqa-heavy-leases-v1'
const LOCK_NAME = '.lock'
// 租约文件名就三段：pid-时间戳36-序号36。前缀对不上的一律不当作租约（目录里将来放别的东西也不怕）。
const NAME_RE = /^\d+-[a-z0-9]+-[a-z0-9]+$/
const LOCK_STALE_MS = 2000
const DIR_RETRY_MS = 60000

const stats = {
  created: 0,
  released: 0,
  refused: 0,
  // 其中「总名额还有、只是这一类排满」的条数：后台能分开看是机器满了还是画布太挤
  kindRefused: 0,
  pruned: 0,
  lockMiss: 0,
  dirFail: 0,
  parseFail: 0,
  lastError: '',
}
// 目录状态按路径缓存：成功一次就一直用；失败后 60 秒再试，免得每次请求都去撞一个写不了的目录
const dirState = { path: '', ready: false, failedAt: 0, warned: false }
const sleepBuf = new Int32Array(new SharedArrayBuffer(4))
let seq = 0

const noopLease = { id: '', kind: '', release() {} }

function clampInt(value, fallback, min, max) {
  // 空字符串 / 没配 / 写错一律回到默认：环境变量最容易出问题的是「写了但写了空」
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** 生效中的租约配置：每次现读环境变量（测试与压测要能逐次改）。 */
export function leaseConfig() {
  return {
    enabled: process.env.VQ_HEAVY_LEASE !== '0',
    dir: String(process.env.VQ_HEAVY_LEASE_DIR || path.join(os.tmpdir(), DIRNAME)),
    ttlMs: clampInt(process.env.VQ_HEAVY_LEASE_TTL_MS, 30 * 60 * 1000, 200, 6 * 60 * 60 * 1000),
    heartbeatMs: clampInt(process.env.VQ_HEAVY_LEASE_HEARTBEAT_MS, 15000, 50, 60000),
    lockWaitMs: clampInt(process.env.VQ_HEAVY_LEASE_LOCK_MS, 400, 20, 5000),
  }
}

export function isHeavyLeaseKind(kind) {
  return HEAVY.has(String(kind || ''))
}

// 同步小睡：闸门是同步函数，拿锁时不能 await。1 到 2 ms 的忙等换来的是
// 「数名额 + 占名额」不会被另一个进程插进来——这几毫秒只在重活入口出现。
function sleepSync(ms) {
  try {
    Atomics.wait(sleepBuf, 0, 0, ms)
  } catch {
    // 极老的运行时没有 Atomics.wait：退化成忙等（这条分支正常情况下走不到）
    const until = Date.now() + ms
    while (Date.now() < until) { /* 忙等 */ }
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程在，只是不归我管（两个实例一个是 visionqa、一个是 root）
    return error && error.code === 'EPERM'
  }
}

function removeFile(file) {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

function ensureDir(dir) {
  if (dirState.path === dir) {
    if (dirState.ready) return true
    if (Date.now() - dirState.failedAt < DIR_RETRY_MS) return false
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 })
    try {
      fs.chmodSync(dir, 0o777)
    } catch {
      // 不是自己的目录：跟着现有权限走，能不能写由后面的 create 说话
    }
    dirState.path = dir
    dirState.ready = true
    dirState.failedAt = 0
    return true
  } catch (error) {
    dirState.path = dir
    dirState.ready = false
    dirState.failedAt = Date.now()
    stats.dirFail += 1
    stats.lastError = '租约目录不可用：' + String((error && (error.code || error.message)) || error)
    if (!dirState.warned) {
      dirState.warned = true
      console.warn('[heavy-lease] ' + stats.lastError + '，退回进程内计数')
    }
    return false
  }
}

function touch(file) {
  try {
    const now = new Date()
    fs.utimesSync(file, now, now)
  } catch {
    // 租约已经被别人当泄漏清掉了：心跳没有意义
  }
}

function readLease(dir, name, cfg, now) {
  const file = path.join(dir, name)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  if (now - stat.mtimeMs > cfg.ttlMs) {
    if (removeFile(file)) stats.pruned += 1
    return null
  }
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    if (removeFile(file)) stats.parseFail += 1
    return null
  }
  const pid = Number(data && data.pid)
  if (!pidAlive(pid)) {
    // 进程没了：名额立刻还回来，不用等 TTL
    if (removeFile(file)) stats.pruned += 1
    return null
  }
  const kind = String((data && data.kind) || '')
  if (!HEAVY.has(kind)) {
    if (removeFile(file)) stats.parseFail += 1
    return null
  }
  return {
    name,
    kind,
    pid,
    startedAt: Number(data.startedAt) || stat.mtimeMs,
    mtimeMs: stat.mtimeMs,
  }
}

function listLeases(dir, cfg) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const now = Date.now()
  const out = []
  for (const name of names) {
    if (!name.endsWith('.lease')) continue
    const bare = name.slice(0, -'.lease'.length)
    if (!NAME_RE.test(bare)) continue
    const item = readLease(dir, name, cfg, now)
    if (item) out.push(item)
  }
  return out
}

function countByKind(list) {
  const byKind = {}
  for (const item of list) byKind[item.kind] = (byKind[item.kind] || 0) + 1
  return byKind
}

function acquireLock(dir, waitMs) {
  const lockPath = path.join(dir, LOCK_NAME)
  const started = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o777 })
      return true
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return false
      try {
        const stat = fs.statSync(lockPath)
        // 锁只在「数名额 + 写租约」这一小段里拿着，没有心跳：超过 2 秒就等于拿锁的进程死在了中间
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockPath)
          continue
        }
      } catch {
        // 正好被放掉了：直接重试
      }
      if (Date.now() - started >= waitMs) return false
      sleepSync(2)
    }
  }
}

function releaseLock(dir) {
  try {
    fs.rmdirSync(path.join(dir, LOCK_NAME))
  } catch {
    // 已经被当陈旧锁清掉：无害
  }
}

/** 现在生效的共享目录（解析后）：租约与排队位用的是同一个目录，别各算一份。 */
export function leaseDirPath() {
  return path.resolve(leaseConfig().dir)
}

/** 目录或锁没拿到：调用方退回进程内（和 acquireHeavyLease 的降级同一个口径）。 */
export const LEASE_LOCK_MISS = Symbol('lease-lock-miss')

/**
 * 在共享目录的跨进程锁里跑一段**同步**逻辑（v0.9.93）。
 * 排队位的「数一下在等几条 + 登记自己」要和租约的「数一下在跑几条 + 占名额」用同一把锁：
 * 两个实例同时读、各自以为还有一个空位，就会一起放行——锁是唯一挡住这件事的东西。
 * 目录不可用 / 拿不到锁时返回 LEASE_LOCK_MISS，由调用方决定怎么降级。
 */
export function withLeaseDirLock(fn) {
  const cfg = leaseConfig()
  if (!cfg.enabled) return LEASE_LOCK_MISS
  const dir = path.resolve(cfg.dir)
  if (!ensureDir(dir)) return LEASE_LOCK_MISS
  if (!acquireLock(dir, cfg.lockWaitMs)) {
    stats.lockMiss += 1
    stats.lastError = '共享目录锁等待超时'
    return LEASE_LOCK_MISS
  }
  try {
    return fn({ dir, cfg })
  } finally {
    releaseLock(dir)
  }
}

function makeLease(dir, cfg, kind, name) {
  const file = path.join(dir, name + '.lease')
  const timer = setInterval(() => touch(file), cfg.heartbeatMs)
  if (typeof timer.unref === 'function') timer.unref()
  let released = false
  return {
    id: name,
    kind,
    file,
    get active() {
      return !released
    },
    release() {
      if (released) return
      released = true
      clearInterval(timer)
      if (removeFile(file)) stats.released += 1
    },
  }
}

/**
 * 占一个重活名额：ok=false 表示全站名额已满（调用方在扣费前拒绝）。
 * limit 写 0 = 不限条数：照样落租约（后台那一屏要能看见在跑几条），只是不拦。
 * source 说明这次计数来自哪里：lease=共享目录（跨进程）、memory=退回进程内、off=没开。
 */
export function acquireHeavyLease(kind, options = {}) {
  const cfg = leaseConfig()
  const wanted = String(kind || '')
  const fallback = { ok: true, lease: noopLease, source: cfg.enabled ? 'memory' : 'off', active: null, limit: 0, kindActive: null, kindLimit: 0 }
  if (!HEAVY.has(wanted)) return fallback
  if (!cfg.enabled) return fallback
  const limit = Math.max(0, Math.round(Number(options.limit) || 0))
  // 按类型的上限：只给「没有账号可限」的通道用（画布出图）。0 = 不看这一层。
  const kindLimit = Math.max(0, Math.round(Number(options.kindLimit) || 0))
  const dir = path.resolve(cfg.dir)
  if (!ensureDir(dir)) return { ...fallback, source: 'memory', degraded: true }
  if (!acquireLock(dir, cfg.lockWaitMs)) {
    stats.lockMiss += 1
    stats.lastError = '租约锁等待超时，退回进程内计数'
    return { ...fallback, source: 'memory', degraded: true }
  }
  try {
    const active = listLeases(dir, cfg)
    const byKind = countByKind(active)
    const kindActive = byKind[wanted] || 0
    // 两道闸：整机总名额（不分类型）+ 这一类的名额（只有令牌通道用得上）。
    // 被拒的时候两种原因要分开报：总名额满和「同类排满」给用户的下一步不是一回事。
    const full = limit > 0 && active.length >= limit
    const kindFull = kindLimit > 0 && kindActive >= kindLimit
    if (full || kindFull) {
      stats.refused += 1
      if (kindFull && !full) stats.kindRefused = (stats.kindRefused || 0) + 1
      return {
        ok: false,
        source: 'lease',
        active: active.length,
        limit,
        kindLimit,
        kindActive,
        kindFull,
        full,
        byKind,
        leases: active.map((item) => ({ pid: item.pid, kind: item.kind, ageSec: Math.round((Date.now() - item.startedAt) / 1000) })),
      }
    }
    seq += 1
    const name = process.pid + '-' + Date.now().toString(36) + '-' + seq.toString(36)
    const file = path.join(dir, name + '.lease')
    const body = JSON.stringify({
      pid: process.pid,
      kind: wanted,
      startedAt: Date.now(),
      owner: String(options.owner || '').slice(0, 40),
      host: os.hostname(),
    })
    fs.writeFileSync(file, body, { flag: 'wx', mode: 0o666 })
    stats.created += 1
    // active 报的是「这一单之前整机在跑几条」：调用方要知道的是它前面排了几个，不是含自己
    return { ok: true, source: 'lease', active: active.length, limit, kindActive, kindLimit, lease: makeLease(dir, cfg, wanted, name) }
  } catch (error) {
    stats.lastError = '租约写入失败：' + String((error && (error.code || error.message)) || error)
    return { ...fallback, source: 'memory', degraded: true }
  } finally {
    releaseLock(dir)
  }
}

/** 全机器视角的重活在跑数（含本进程自己的租约）。 */
export function heavyLeaseSnapshot(kinds) {
  const cfg = leaseConfig()
  if (!cfg.enabled) return { enabled: false, source: 'process', total: 0, byKind: {}, otherPids: [], leases: [] }
  const dir = path.resolve(cfg.dir)
  if (!ensureDir(dir)) {
    return { enabled: true, degraded: true, source: 'process', dir, total: 0, byKind: {}, otherPids: [], leases: [] }
  }
  const wanted = kinds && kinds.length ? new Set(kinds) : null
  const list = listLeases(dir, cfg).filter((item) => !wanted || wanted.has(item.kind))
  const pids = new Set(list.map((item) => item.pid))
  pids.delete(process.pid)
  return {
    enabled: true,
    degraded: false,
    source: 'lease',
    dir,
    total: list.length,
    byKind: countByKind(list),
    otherPids: [...pids],
    leases: list.map((item) => ({ pid: item.pid, kind: item.kind, ageSec: Math.round((Date.now() - item.startedAt) / 1000) })),
  }
}

/** 后台那一屏用的完整状态：配置、目录、在跑数、清理与降级计数。 */
export function heavyLeaseStatus() {
  const cfg = leaseConfig()
  const snapshot = heavyLeaseSnapshot()
  return {
    ...snapshot,
    enabled: cfg.enabled,
    dir: path.resolve(cfg.dir),
    ttlMs: cfg.ttlMs,
    heartbeatMs: cfg.heartbeatMs,
    lockWaitMs: cfg.lockWaitMs,
    stats: { ...stats },
  }
}

/** 测试用：清掉目录缓存与统计，让下一个用例从干净状态开始。 */
export function resetHeavyLeaseState() {
  dirState.path = ''
  dirState.ready = false
  dirState.failedAt = 0
  dirState.warned = false
  for (const key of Object.keys(stats)) {
    if (key === 'lastError') stats[key] = ''
    else stats[key] = 0
  }
}