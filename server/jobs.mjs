// 复刻任务：解析 → 抽帧 → 视觉分析 → 入库。
// 过去这一层只把任务放在内存 Map 里，而「已经扣掉的积分」是另一处事实：
// 进程一重启（发版、OOM、systemd 停服）任务就凭空消失，用户拿着 jobId 只能拿到 404，
// 扣掉的积分也没人退。现在每一步都落在 SQLite 的 replicate_jobs 里，启动时：
//   1) 上次没跑完（queued / running）的任务一律标成失败，失败原因写清「服务重启中断」；
//   2) 退款金额不看内存里的数字，按积分账本里这条任务的净扣款算，重复执行不会多退；
//   3) 顺手删掉崩溃时没来得及清理的临时目录（一次最多 160MB 的源视频）。
// SIGTERM / SIGINT 也会先走同一套收尾，再关服务退出。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { acquireVideo } from './media.mjs'
import { probeVideo, detectSceneCuts, planTimestamps, extractFrames } from './frames.mjs'
import { replicateRemote } from './remote.mjs'
import { analyzeFrames } from './vision.mjs'
import { createTemplate } from './templates.mjs'
import { canAccess } from './owner.mjs'
import { openDb } from './auth.mjs'
import { outstandingCharge, refund } from './credits.mjs'

const nowIso = () => new Date().toISOString()

// 内存只用来喂「正在跑的任务」和最近几条：重启后的真源是 replicate_jobs 表
const MAX_MEMORY_JOBS = 60
const MAX_DB_JOBS = 200
const jobs = new Map()

export function newJobId() {
  return 'job_' + randomUUID().slice(0, 8)
}

function rowToJob(row) {
  if (!row) return null
  let logs = []
  try {
    logs = JSON.parse(row.logs || '[]')
  } catch {
    logs = []
  }
  return {
    id: row.id,
    ownerId: row.user_id || '',
    status: row.status,
    step: row.step,
    progress: Number(row.progress || 0),
    logs: Array.isArray(logs) ? logs : [],
    error: row.error || null,
    templateId: row.template_id || null,
    label: row.label || '',
    shared: Boolean(row.shared),
    cost: Number(row.cost || 0),
    refunded: Boolean(row.refunded),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function readJobRecord(id) {
  if (!id) return null
  const row = openDb().prepare('SELECT * FROM replicate_jobs WHERE id = ?').get(String(id))
  return rowToJob(row)
}

function persist(job) {
  job.updatedAt = nowIso()
  openDb()
    .prepare(
      `INSERT INTO replicate_jobs (id, user_id, status, step, progress, logs, error, template_id, label, shared, cost, refunded, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         step = excluded.step,
         progress = excluded.progress,
         logs = excluded.logs,
         error = excluded.error,
         template_id = excluded.template_id,
         label = excluded.label,
         shared = excluded.shared,
         cost = excluded.cost,
         refunded = excluded.refunded,
         updated_at = excluded.updated_at`,
    )
    .run(
      job.id,
      job.ownerId || '',
      job.status,
      job.step,
      Math.round(Number(job.progress) || 0),
      JSON.stringify(job.logs.slice(-40)),
      job.error,
      job.templateId,
      job.label || '',
      job.shared ? 1 : 0,
      Math.round(Number(job.cost) || 0),
      job.refunded ? 1 : 0,
      job.createdAt,
      job.updatedAt,
    )
  if (jobs.size > MAX_MEMORY_JOBS) {
    const finished = [...jobs.values()]
      .filter((item) => item.status !== 'running' && item.status !== 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    for (const item of finished.slice(0, jobs.size - MAX_MEMORY_JOBS)) jobs.delete(item.id)
  }
}

// 任务表不该无限长：留最近 200 条给后台看（正在跑的永远留着）
function pruneJobs() {
  openDb()
    .prepare(
      `DELETE FROM replicate_jobs
       WHERE status NOT IN ('queued', 'running')
         AND id NOT IN (SELECT id FROM replicate_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    )
    .run(MAX_DB_JOBS)
}

// 扣费前先建草稿：万一进程在「已扣费、还没开始跑」之间退出，重启恢复能按账本把这笔退回去。
export function createJobDraft({ id = '', ownerId = '', shared = false, cost = 0, label = '' } = {}) {
  const job = {
    id: id || newJobId(),
    ownerId: ownerId || '',
    label: String(label || '').slice(0, 80),
    status: 'queued',
    step: 'queued',
    progress: 0,
    logs: [],
    error: null,
    templateId: null,
    shared: Boolean(shared),
    cost: Math.max(0, Math.round(Number(cost) || 0)),
    refunded: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  jobs.set(job.id, job)
  persist(job)
  pruneJobs()
  return job
}

// 并发闸门 / 积分校验没过：这条草稿没扣过钱，直接撤掉，不留空任务
export function dropJobDraft(id) {
  const job = jobs.get(id) || readJobRecord(id)
  if (!job || job.status !== 'queued') return false
  // 已经扣过钱的草稿不能删：交给重启恢复按账本退
  if (outstandingCharge(job.ownerId, 'replicate', job.id) > 0) return false
  jobs.delete(id)
  openDb().prepare('DELETE FROM replicate_jobs WHERE id = ?').run(String(id))
  return true
}

export function getJob(id, user = null) {
  const job = jobs.get(id) || readJobRecord(id)
  if (!job) return null
  // 任务也归属到发起人：别人拿着 jobId 看不到你的进度和模板
  if (!canAccess(job, user)) return null
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    progress: Math.round(Number(job.progress) || 0),
    logs: job.logs.slice(-40),
    error: job.error,
    templateId: job.templateId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    cost: job.cost,
    refunded: Boolean(job.refunded),
  }
}

// 退款金额以账本为准：这条任务实际扣了多少（净额）就退多少，重复调用不会多退。
// 之前是「调用方记得退」，一重启调用方自己都没了，钱就留在平台账上。
function refundJobCredits(job) {
  if (!job.ownerId) return false
  let owed = 0
  try {
    owed = outstandingCharge(job.ownerId, 'replicate', job.id)
  } catch (error) {
    job.logs.push({ at: nowIso(), text: '核对账本失败：' + String(error?.message || error) })
    return false
  }
  if (owed <= 0) return false
  try {
    refund(job.ownerId, 'replicate', { ref: job.id, amount: owed, meta: { label: job.label || '' } })
    job.refunded = true
    job.logs.push({ at: nowIso(), text: '已退回 ' + owed + ' 积分' })
    return true
  } catch (error) {
    job.logs.push({ at: nowIso(), text: '退款失败（' + owed + ' 积分）：' + String(error?.message || error) })
    return false
  }
}

function failJob(job, message) {
  job.status = 'error'
  job.error = String(message || '任务失败')
  job.logs.push({ at: nowIso(), text: '失败：' + job.error })
  refundJobCredits(job)
  persist(job)
  return job
}

// 外部调用（路由 catch）用：按 jobId 收尾，不会重复退款
export function abortJob(id, message = '任务没有启动') {
  const job = jobs.get(id) || readJobRecord(id)
  if (!job) return null
  if (job.status === 'error' || job.status === 'done') return job
  return failJob(job, message)
}

function step(job, name, progress, text) {
  job.step = name
  job.progress = progress
  if (text) job.logs.push({ at: nowIso(), text })
  persist(job)
}

export async function startReplicate(item, overrideUrl, { jobId = '', ownerId = '', shared = false, cost = 0, label = '', onSettled = null } = {}) {
  const job = jobs.get(jobId) || readJobRecord(jobId) || createJobDraft({ id: jobId, ownerId, shared, cost, label })
  job.ownerId = ownerId || job.ownerId || ''
  if (label) job.label = String(label).slice(0, 80)
  else if (!job.label) job.label = String(item?.title || overrideUrl || '').slice(0, 80)
  // 公共模板：运营账号跑出来的解析结果不给任何人「私有」，所有账号可见
  job.shared = Boolean(shared)
  if (cost) job.cost = Math.max(0, Math.round(Number(cost) || 0))
  job.aborted = false
  job.status = 'running'
  job.step = 'queued'
  persist(job)

  const settle = () => {
    persist(job)
    // 结算回调：调用方用它释放并发闸门（退款已经在任务层按账本做完）
    if (typeof onSettled === 'function') {
      try {
        onSettled(job.status)
      } catch {
        // 结算回调里的异常不该影响任务本身
      }
    }
  }

  const jobDir = path.join(config.dataDir, 'jobs', job.id)
  const targets = []
  if (overrideUrl) targets.push({ url: overrideUrl, label: '手动直链' })
  if (item?.url) targets.push({ url: item.url, label: item.platformLabel + '原链接' })
  if (!targets.length) {
    failJob(job, '这条内容没有可用的视频链接：示例数据不含真实链接，请先接入检索服务或粘贴视频直链。')
    settle()
    return job
  }

  runPipeline(job, jobDir, item || {}, targets)
    .catch((error) => {
      failJob(job, String(error?.message || error))
    })
    // 成功和失败都要清：以前只在成功分支里删，失败一次就在盘上留一份最多 160MB 的源视频
    .finally(() => {
      fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
      settle()
    })
  return job
}

async function runPipeline(job, jobDir, item, targets) {
  const log = (text) => job.logs.push({ at: nowIso(), text })
  let meta = null
  let sceneCuts = []
  let frames = []

  if (config.remote.enabled) {
    // 远端算力：解析 + 下载 + 探测 + 抽帧都在对方机器上完成，本地只收帧
    let lastError = null
    for (const target of targets) {
      try {
        step(job, 'remote', 8, '调用远端算力（' + config.remote.label + ' · ' + target.label + '）')
        const result = await replicateRemote({
          url: target.url,
          maxFrames: config.limits.maxFrames,
          jobDir,
          log,
        })
        meta = result.meta
        sceneCuts = result.sceneCuts
        frames = result.frames
        step(job, 'remote', 62, '远端算力返回 ' + frames.length + ' 帧')
        break
      } catch (error) {
        lastError = error
        log(target.label + ' 远端算力失败：' + String(error?.message || error))
      }
    }
    if (!frames.length) throw lastError || new Error('远端算力没有返回任何帧')
  } else {
    let acquired = null
    let lastError = null
    for (const target of targets) {
      try {
        step(job, 'resolve', 8, '解析视频地址（' + target.label + '）')
        acquired = await acquireVideo({ url: target.url, platform: item.platform }, jobDir, (ratio) => {
          job.progress = 10 + ratio * 20
        })
        break
      } catch (error) {
        lastError = error
        log(target.label + ' 获取失败：' + String(error?.message || error))
      }
    }
    if (!acquired) throw lastError || new Error('无法获取视频')

    step(job, 'probe', 34, '读取视频信息')
    meta = await probeVideo(acquired.file)
    if (!meta.duration) throw new Error('视频时长读取失败，可能不是有效的视频文件')
    log('视频 ' + meta.duration.toFixed(1) + 's · ' + meta.width + 'x' + meta.height + ' · ' + meta.fps + 'fps')

    step(job, 'scene', 42, '检测镜头切换')
    sceneCuts = await detectSceneCuts(acquired.file)
    log(sceneCuts.length ? ('检测到 ' + sceneCuts.length + ' 个切镜点') : '未检测到明显硬切')

    const timestamps = planTimestamps(meta.duration, sceneCuts, config.limits.maxFrames)
    step(job, 'frames', 48, 'FFmpeg 抽帧（' + timestamps.length + ' 帧）')
    frames = await extractFrames(acquired.file, path.join(jobDir, 'frames'), timestamps, (ratio) => {
      job.progress = 48 + ratio * 20
    })
    log('抽取 ' + frames.length + ' 帧：' + frames.map((f) => f.t.toFixed(1) + 's').join(', '))
  }

  if (!meta?.duration) throw new Error('视频时长读取失败，可能不是有效的视频文件')
  log('来源：' + (config.remote.enabled ? ('远端算力 ' + config.remote.label) : '本机 ffmpeg') + ' · ' + frames.length + ' 帧 · ' + meta.width + 'x' + meta.height)

  step(job, 'vision', 70, '逐帧分析脚本与分镜')
  const analysis = await analyzeFrames({ frames, meta, sceneCuts, log })

  // 停机收尾时已经按中断处理（状态落库、积分退回）：这时再建模板等于白送一份
  if (job.aborted) throw new Error('任务被中断：服务停止，已扣积分已退回')

  step(job, 'save', 94, '写入模板库')
  const template = await createTemplate({
    item,
    meta,
    analysis,
    frames,
    jobId: job.id,
    user: job.ownerId ? { id: job.ownerId } : null,
    shared: Boolean(job.shared),
  })
  job.templateId = template.id
  job.refunded = false
  step(job, 'done', 100, '复刻完成，已存入模板库：' + template.title)
  job.status = 'done'
  await fsp.rm(path.join(jobDir), { recursive: true, force: true }).catch(() => {})
}

// 重启恢复：上次进程没跑完的任务，标成失败并按账本退款；顺手清掉崩溃留下的临时目录。
// 这一步是「发一次版就漏一次钱」的止血点：以前重启后任务 404、积分照扣。
export function recoverInterruptedJobs() {
  const db = openDb()
  const rows = db.prepare("SELECT id FROM replicate_jobs WHERE status IN ('queued', 'running')").all()
  let recovered = 0
  let refunded = 0
  for (const row of rows) {
    const job = jobs.get(row.id) || rowToJob(db.prepare('SELECT * FROM replicate_jobs WHERE id = ?').get(row.id))
    if (!job) continue
    const wasRefunded = job.refunded
    failJob(job, '服务重启，任务中断（进程已退出）；' + (job.ownerId ? '已扣积分已退回，重新发起即可。' : '重新发起即可。'))
    if (!wasRefunded && job.refunded) refunded += 1
    recovered += 1
    fsp.rm(path.join(config.dataDir, 'jobs', job.id), { recursive: true, force: true }).catch(() => {})
  }
  return { recovered, refunded }
}

// 停机收尾：先标中断 + 退款，再让调用方关服务。重复调用无副作用。
export function interruptRunningJobs(reason = '服务停止') {
  let interrupted = 0
  for (const job of jobs.values()) {
    if (job.status !== 'running' && job.status !== 'queued') continue
    // 库里已经是终态的任务（例如刚跑完）不能被停机收尾改回失败：停机只收「还在跑」的
    let record = null
    try {
      record = readJobRecord(job.id)
    } catch {
      record = null
    }
    if (record && record.status !== 'running' && record.status !== 'queued') {
      job.status = record.status
      continue
    }
    job.aborted = true
    failJob(job, reason + '，任务中断；' + (job.ownerId ? '已扣积分已退回，重新发起即可。' : '重新发起即可。'))
    interrupted += 1
  }
  return interrupted
}

// 后台「复刻任务」列表：真源在库里，所以重启后历史还在
export function listJobs({ limit = 20, userId = null } = {}) {
  const size = Math.max(1, Math.min(100, Math.round(Number(limit) || 20)))
  const db = openDb()
  const rows = userId
    ? db.prepare('SELECT * FROM replicate_jobs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(String(userId), size)
    : db.prepare('SELECT * FROM replicate_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(size)
  const items = rows.map(rowToJob).map((job) => ({
    id: job.id,
    ownerId: job.ownerId,
    status: job.status,
    step: job.step,
    progress: Math.round(Number(job.progress) || 0),
    error: job.error,
    templateId: job.templateId,
    label: job.label,
    cost: job.cost,
    refunded: job.refunded,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }))
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM replicate_jobs GROUP BY status').all()
  const byStatus = {}
  for (const row of counts) byStatus[row.status] = Number(row.n || 0)
  return { items, counts: byStatus }
}