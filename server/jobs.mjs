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

const jobs = new Map()
const MAX_JOBS = 40

export function getJob(id, user = null) {
  const job = jobs.get(id)
  if (!job) return null
  // 任务也归属到发起人：别人拿着 jobId 看不到你的进度和模板
  if (!canAccess(job, user)) return null
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    progress: Math.round(job.progress),
    logs: job.logs.slice(-40),
    error: job.error,
    templateId: job.templateId,
    createdAt: job.createdAt,
  }
}

function createJob() {
  const id = 'job_' + randomUUID().slice(0, 8)
  const job = {
    id, status: 'running', step: 'queued', progress: 0, logs: [], error: null,
    templateId: null, createdAt: new Date().toISOString(),
  }
  jobs.set(id, job)
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0]
    if (oldest && oldest.status !== 'running') jobs.delete(oldest.id)
  }
  return job
}

function step(job, name, progress, text) {
  job.step = name
  job.progress = progress
  if (text) job.logs.push({ at: new Date().toISOString(), text })
}

export async function startReplicate(item, overrideUrl, { ownerId = '', shared = false, onSettled = null } = {}) {
  const job = createJob()
  job.ownerId = ownerId || ''
  // 公共模板：运营账号跑出来的解析结果不给任何人「私有」，所有账号可见
  job.shared = Boolean(shared)
  const jobDir = path.join(config.dataDir, 'jobs', job.id)
  const targets = []
  if (overrideUrl) targets.push({ url: overrideUrl, label: '手动直链' })
  if (item?.url) targets.push({ url: item.url, label: item.platformLabel + '原链接' })
  if (!targets.length) {
    job.status = 'error'
    job.error = '这条内容没有可用的视频链接：示例数据不含真实链接，请先接入检索服务或粘贴视频直链。'
    return job
  }

  runPipeline(job, jobDir, item || {}, targets)
    .catch((error) => {
      job.status = 'error'
      job.error = String(error?.message || error)
      job.logs.push({ at: new Date().toISOString(), text: '失败：' + job.error })
    })
    // 成功和失败都要清：以前只在成功分支里删，失败一次就在盘上留一份最多 160MB 的源视频
    .finally(() => {
      fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
      // 结算回调：调用方用它释放并发闸门、失败退积分
      if (typeof onSettled === 'function') {
        try {
          onSettled(job.status)
        } catch {
          // 结算回调里的异常不该影响任务本身
        }
      }
    })
  return job
}

async function runPipeline(job, jobDir, item, targets) {
  const log = (text) => job.logs.push({ at: new Date().toISOString(), text })
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
  const analysis = await analyzeFrames({ frames, meta, sceneCuts, log: (text) => job.logs.push({ at: new Date().toISOString(), text }) })

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
  step(job, 'done', 100, '复刻完成，已存入模板库：' + template.title)
  job.status = 'done'
  await fsp.rm(path.join(jobDir), { recursive: true, force: true }).catch(() => {})
}
