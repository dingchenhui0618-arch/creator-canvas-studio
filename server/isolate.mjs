// 重活隔离（v0.9.77）：评审这类「吃内存、可能被一张坏图或一段长回答顶穿」的工作，
// 放进独立 worker 线程，并且**只开固定几个 worker 反复用**（池），不是每个请求现开一个。
//
// 为什么是池而不是「一单一个 worker」：压测量过（docs/worker-isolation-2026-11-14.md）——
// 一单一个 worker 时，10 并发在 2 核机器上开 10 个 isolate，进程树 700 MB、健康探针 p95 986 ms；
// 同进程执行只要 449 MB / 159 ms。多出来的开销全在「每个 worker 都要重新加载模块、用自己的堆」。
// 池把并发压到全站重活上限（默认 3）那么多个 isolate，超出的人排队，内存与延迟才有天花板。
//
// 边界（别指望它解决所有事）：worker 与主线程同进程、同 cgroup，ffmpeg 子进程的内存仍算在这台
// 机器的总账里；它挡的是「堆被单个请求吃掉」，挡不了「整机内存不足」。池里的 worker 撞上限或
// 超时，只杀它自己，池会补一个新的，主线程照常接别人的请求。
import { Worker } from 'node:worker_threads'

export class IsolateError extends Error {
  constructor(code, message, { status = 503, detail = null } = {}) {
    super(message)
    this.name = 'IsolateError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

const clamp = (value, min, max, fallback) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

/** 隔离开关与池规格：都在环境变量里，线上出问题不用改代码就能退回去 */
export function reviewIsolateConfig(env = process.env) {
  return {
    enabled: String(env.VQ_REVIEW_ISOLATE ?? '1') !== '0',
    heapMb: clamp(env.VQ_REVIEW_WORKER_MB, 64, 1024, 192),
    workers: clamp(env.VQ_REVIEW_WORKERS, 1, 8, 3),
    timeoutMs: clamp(env.VQ_REVIEW_WORKER_TIMEOUT_MS, 5_000, 900_000, 240_000),
  }
}

// 只看数字：评审页/后台能用它确认「隔离到底有没有在跑」，不用真的发起一次评审
const stats = { runs: 0, ok: 0, failed: 0, lastFailure: '' }

export function isolateStatus(env = process.env) {
  const config = reviewIsolateConfig(env)
  const pool = reviewPool.peek()
  return {
    enabled: config.enabled,
    heapMb: config.heapMb,
    workers: config.workers,
    timeoutMs: config.timeoutMs,
    runs: stats.runs,
    ok: stats.ok,
    failed: stats.failed,
    lastFailure: stats.lastFailure,
    pool: pool ? pool.stats() : { size: config.workers, alive: 0, idle: 0, queued: 0 },
  }
}

/** 单测/排障用：清掉计数，不影响进程其它状态 */
export function resetIsolateStats() {
  stats.runs = 0
  stats.ok = 0
  stats.failed = 0
  stats.lastFailure = ''
}

/**
 * 有上限的 worker 池。任务按先来后到排队；同时最多 size 个 worker。
 * 入口契约很小：收到 { type:'job', id, payload }，用
 * { type:'done', id, result } / { type:'error', id, message, code, status } 回话，
 * 过程日志发 { type:'log', id, message }。
 */
export class WorkerPool {
  #entry
  #size
  #heapMb
  #timeoutMs
  #idle = []
  #slots = new Set()
  #queue = []
  #jobSeq = 0
  #closed = false

  constructor(entry, { size = 3, heapMb = 192, timeoutMs = 240_000 } = {}) {
    this.#entry = entry
    this.#size = Math.max(1, size)
    this.#heapMb = heapMb
    this.#timeoutMs = timeoutMs
  }

  stats() {
    return { size: this.#size, alive: this.#slots.size, idle: this.#idle.length, queued: this.#queue.length }
  }

  run(payload, { onLog = null, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new IsolateError('REVIEW_WORKER_DOWN', '评审进程池已关闭，这次评审没有开始'))
        return
      }
      // 已经在停的运行不必再排进池子：直接回「已中止」，调用方据此收尾
      if (signal?.aborted) {
        reject(new IsolateError('REVIEW_CANCELED', '运行已停止，这次评审没有开始'))
        return
      }
      this.#queue.push({ payload, onLog, resolve, reject, signal })
      this.#pump()
    })
  }

  close() {
    this.#closed = true
    for (const slot of this.#slots) slot.worker.terminate().catch(() => {})
    this.#slots.clear()
    this.#idle = []
    for (const task of this.#queue.splice(0)) task.reject(new IsolateError('REVIEW_WORKER_DOWN', '评审进程池已关闭，这次评审没有开始'))
  }

  #spawn() {
    const worker = new Worker(this.#entry, { resourceLimits: { maxOldGenerationSizeMb: this.#heapMb } })
    const slot = { worker, job: null, timer: null, onLog: null, dead: false }
    worker.on('message', (message) => this.#onMessage(slot, message))
    worker.on('error', (error) => this.#onCrash(slot, error))
    worker.on('exit', (code) => this.#onCrash(slot, new Error('worker exit ' + code)))
    // 空闲的 worker 不拖住事件循环：池里留着它是为了复用，不是为了把进程钉住
    worker.unref()
    this.#slots.add(slot)
    return slot
  }

  #pump() {
    while (this.#queue.length && !this.#closed) {
      let slot = this.#idle.pop()
      if (!slot) {
        if (this.#slots.size >= this.#size) return
        try {
          slot = this.#spawn()
        } catch (error) {
          const task = this.#queue.shift()
          task.reject(new IsolateError('REVIEW_WORKER_SPAWN', '评审进程没能启动（' + (error?.message || error) + '），这次评审没有开始', { detail: String(error?.code || '') }))
          continue
        }
      }
      this.#start(slot, this.#queue.shift())
    }
  }

  #start(slot, task) {
    slot.job = task
    slot.onLog = task.onLog
    slot.worker.ref()
    // 用户停止：终止这个 worker（它可能正卡在一次上游调用里），任务立刻以 REVIEW_CANCELED 收尾，
    // 池会补一个新的。只杀接了这一单的 worker，别的评审不受影响。
    if (task.signal) {
      slot.abort = () => this.#failSlot(slot, new IsolateError('REVIEW_CANCELED', '运行已停止，这次评审已中止'))
      if (task.signal.aborted) {
        slot.abort()
        return
      }
      task.signal.addEventListener('abort', slot.abort, { once: true })
    }
    const id = ++this.#jobSeq
    slot.timer = setTimeout(() => {
      this.#failSlot(slot, new IsolateError('REVIEW_TIMEOUT', '评审超过 ' + Math.round(this.#timeoutMs / 1000) + ' 秒还没回结果，已经中止；服务本身没受影响', { status: 504 }))
    }, this.#timeoutMs)
    try {
      slot.worker.postMessage({ type: 'job', id, payload: task.payload })
    } catch (error) {
      this.#failSlot(slot, new IsolateError('REVIEW_WORKER_DOWN', '评审任务没能送进 worker（' + (error?.message || error) + '），这次评审没有完成'))
    }
  }

  #onMessage(slot, message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'log') {
      if (slot.onLog) { try { slot.onLog(String(message.message || '')) } catch { /* 日志不能弄坏评审 */ } }
      return
    }
    if (!slot.job) return
    if (message.type === 'done') {
      const task = this.#takeJob(slot)
      task.resolve(message.result)
      this.#release(slot)
      return
    }
    if (message.type === 'error') {
      const error = new Error(String(message.message || '评审失败'))
      if (message.code) error.code = String(message.code)
      if (Number(message.status) >= 400) error.status = Number(message.status)
      const task = this.#takeJob(slot)
      task.reject(error)
      this.#release(slot)
    }
  }

  #onCrash(slot, error) {
    if (slot.dead) return
    const outOfMemory = String(error?.code || '').includes('OUT_OF_MEMORY')
    if (slot.job) {
      this.#failSlot(slot, new IsolateError(
        outOfMemory ? 'REVIEW_WORKER_OOM' : 'REVIEW_WORKER_DOWN',
        outOfMemory
          ? '这次评审撞到独立的 ' + this.#heapMb + ' MB 内存上限，已经中止（站点本身没有受影响）'
          : '评审进程异常退出（' + (error?.message || error) + '），这次评审没有完成',
        { detail: String(error?.code || error?.message || '') },
      ))
      return
    }
    // 空闲 worker 自己退出了：清掉它，需要时补新的
    slot.dead = true
    if (slot.timer) clearTimeout(slot.timer)
    this.#slots.delete(slot)
    slot.worker.terminate().catch(() => {})
    this.#pump()
  }

  #failSlot(slot, error) {
    const task = this.#takeJob(slot)
    slot.dead = true
    this.#slots.delete(slot)
    this.#idle = this.#idle.filter((item) => item !== slot)
    slot.worker.removeAllListeners()
    slot.worker.terminate().catch(() => {})
    if (task) task.reject(error)
    this.#pump()
  }

  #takeJob(slot) {
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null }
    const task = slot.job
    if (slot.abort) {
      try { task?.signal?.removeEventListener('abort', slot.abort) } catch { /* 已移除 */ }
      slot.abort = null
    }
    slot.job = null
    slot.onLog = null
    return task
  }

  #release(slot) {
    if (slot.dead || this.#closed) return
    slot.worker.unref()
    this.#idle.push(slot)
    this.#pump()
  }
}

// 生产用单例：第一次真正评审时建池，之后复用；没跑过评审就不会多占一个线程
const reviewPool = {
  current: null,
  peek() { return this.current },
  get(config) {
    if (this.current) return this.current
    this.current = new WorkerPool(new URL('./review-worker.mjs', import.meta.url), {
      size: config.workers,
      heapMb: config.heapMb,
      timeoutMs: config.timeoutMs,
    })
    return this.current
  },
  reset() {
    if (this.current) this.current.close()
    this.current = null
  },
}

/** 单测用：把池清掉 */
export function resetReviewPool() {
  reviewPool.reset()
}

/** 评审走隔离池；调用方只关心「有没有开」，怎么跑在这里 */
export async function runReviewIsolated(payload, { log = null, env = process.env, signal = null } = {}) {
  const config = reviewIsolateConfig(env)
  stats.runs += 1
  try {
    const result = await reviewPool.get(config).run(payload, { onLog: log, signal })
    stats.ok += 1
    return result
  } catch (error) {
    stats.failed += 1
    stats.lastFailure = String(error?.code || 'REVIEW_WORKER_DOWN')
    throw error
  }
}

/** 一次性的单 worker（测试与排障用；生产走池） */
export function runInWorker(entry, payload, { heapMb = 192, timeoutMs = 240_000, onLog = null } = {}) {
  const pool = new WorkerPool(entry, { size: 1, heapMb, timeoutMs })
  return pool.run(payload, { onLog }).finally(() => pool.close())
}
