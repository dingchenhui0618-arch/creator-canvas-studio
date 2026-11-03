import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { acquireVideo } from './media.mjs'
import { probeVideo, detectSceneCuts, planTimestamps, extractFrames } from './frames.mjs'
import { analyzeFrames } from './vision.mjs'
import { createTemplate } from './templates.mjs'

const jobs = new Map()
const MAX_JOBS = 40

export function getJob(id) {
  const job = jobs.get(id)
  if (!job) return null
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

export async function startReplicate(item, overrideUrl) {
  const job = createJob()
  const jobDir = path.join(config.dataDir, 'jobs', job.id)
  const targets = []
  if (overrideUrl) targets.push({ url: overrideUrl, label: '手动直链' })
  if (item?.url) targets.push({ url: item.url, label: item.platformLabel + '原链接' })
  if (!targets.length) {
    job.status = 'error'
    job.error = '这条内容没有可用的视频链接：示例数据不含真实链接，请接入红狐 Key 或粘贴视频直链。'
    return job
  }

  runPipeline(job, jobDir, item || {}, targets).catch((error) => {
    job.status = 'error'
    job.error = String(error?.message || error)
    job.logs.push({ at: new Date().toISOString(), text: '失败：' + job.error })
  })
  return job
}

async function runPipeline(job, jobDir, item, targets) {
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
      job.logs.push({ at: new Date().toISOString(), text: target.label + ' 获取失败：' + String(error?.message || error) })
    }
  }
  if (!acquired) throw lastError || new Error('无法获取视频')

  step(job, 'probe', 34, '读取视频信息')
  const meta = await probeVideo(acquired.file)
  if (!meta.duration) throw new Error('视频时长读取失败，可能不是有效的视频文件')
  job.logs.push({ at: new Date().toISOString(), text: '视频 ' + meta.duration.toFixed(1) + 's · ' + meta.width + 'x' + meta.height + ' · ' + meta.fps + 'fps' })

  step(job, 'scene', 42, '检测镜头切换')
  const sceneCuts = await detectSceneCuts(acquired.file)
  job.logs.push({ at: new Date().toISOString(), text: sceneCuts.length ? ('检测到 ' + sceneCuts.length + ' 个切镜点') : '未检测到明显硬切' })

  const timestamps = planTimestamps(meta.duration, sceneCuts, config.limits.maxFrames)
  step(job, 'frames', 48, 'FFmpeg 抽帧（' + timestamps.length + ' 帧）')
  const frames = await extractFrames(acquired.file, path.join(jobDir, 'frames'), timestamps, (ratio) => {
    job.progress = 48 + ratio * 20
  })
  job.logs.push({ at: new Date().toISOString(), text: '抽取 ' + frames.length + ' 帧：' + frames.map((f) => f.t.toFixed(1) + 's').join(', ') })

  step(job, 'vision', 70, '逐帧分析脚本与分镜')
  const analysis = await analyzeFrames({ frames, meta, sceneCuts, log: (text) => job.logs.push({ at: new Date().toISOString(), text }) })

  step(job, 'save', 94, '写入模板库')
  const template = await createTemplate({ item, meta, analysis, frames, jobId: job.id })
  job.templateId = template.id
  step(job, 'done', 100, '复刻完成，已存入模板库：' + template.title)
  job.status = 'done'
  await fsp.rm(path.join(jobDir), { recursive: true, force: true }).catch(() => {})
}
