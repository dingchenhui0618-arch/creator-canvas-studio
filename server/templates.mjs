import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'

let cache = null

async function loadAll() {
  if (cache) return cache
  try {
    const text = await fsp.readFile(config.templatesFile, 'utf8')
    const parsed = JSON.parse(text)
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  return cache
}

// 所有写盘走一条队列：模板库是整文件读改写，两个请求同时下发时共用一个 .tmp
// 会互相 rename 掉对方（实测 30 并发有 26 次 ENOENT），并且后写覆盖先写、丢条目。
let writeChain = Promise.resolve()

function enqueueWrite(task) {
  const next = writeChain.then(task, task)
  writeChain = next.catch(() => {})
  return next
}

async function persist(list) {
  cache = list
  return enqueueWrite(async () => {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const tmp = config.templatesFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    await fsp.rename(tmp, config.templatesFile)
  })
}

export async function listTemplates({ q = '', contentType = '', platform = '', kind = '' } = {}) {
  const list = await loadAll()
  const keyword = q.trim()
  return list
    .filter((item) => (kind ? item.kind === kind : true))
    .filter((item) => (contentType ? item.contentType === contentType : true))
    .filter((item) => (platform ? item.platform === platform : true))
    .filter((item) =>
      keyword
        ? (item.title + item.hook + (item.tags || []).join(' ') + (item.analysis?.reusableRules || []).join(' ')).includes(keyword)
        : true,
    )
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    // 缩略图：解析过的模板用第一帧，只存链接的用平台封面（走 /api/cover 代理）
    .map((item) => ({ ...item, thumb: item.frames?.[0]?.url || item.cover || '' }))
}

// 只存「链接 + 互动数据」的条目：在爆款雷达点「加入模板库」立刻落库，
// 不下载视频、不抽帧、不建本地目录；解析（脚本/分镜）仍然靠「一键复刻」补上。
export async function saveTemplateFromItem({ item }) {
  const list = await loadAll()
  const sourceId = String(item?.id || '')
  const existing = list.find((entry) => entry.kind === 'saved' && entry.sourceId && entry.sourceId === sourceId)
  if (existing) return { template: existing, created: false }
  const now = new Date().toISOString()
  const template = {
    id: 'tpl_' + randomUUID().slice(0, 8),
    kind: 'saved',
    title: String(item?.title || '未命名条目'),
    contentType: '待解析',
    tags: [],
    platform: item?.platform || 'douyin',
    platformLabel: item?.platformLabel || '',
    sourceUrl: String(item?.url || ''),
    sourceId,
    author: String(item?.author || ''),
    publishedAt: String(item?.publishedAt || ''),
    stats: item?.stats || { plays: 0, likes: 0, comments: 0, shares: 0, collects: 0 },
    durationSec: Number(item?.durationSec) || 0,
    hook: '',
    hookType: '',
    structure: [],
    storyboard: [],
    analysis: { pacing: '', viralPoints: [], reusableRules: [], targetAudience: '' },
    frames: [],
    cover: String(item?.cover || ''),
    video: { width: 0, height: 0, fps: 0, duration: Number(item?.durationSec) || 0 },
    origin: 'manual',
    reuseCount: 0,
    createdAt: now,
    savedAt: now,
  }
  list.unshift(template)
  await persist(list)
  return { template, created: true }
}



export async function getTemplate(id) {
  const list = await loadAll()
  return list.find((item) => item.id === id) || null
}

export async function createTemplate({ item, meta, analysis, frames, jobId }) {
  const list = await loadAll()
  const id = 'tpl_' + randomUUID().slice(0, 8)
  const targetDir = path.join(config.framesDir, id)
  await fsp.mkdir(targetDir, { recursive: true })
  const sourceDir = path.dirname(frames[0].file)
  await fsp.cp(sourceDir, targetDir, { recursive: true })

  // 雷达里先「加入模板库」、后来才复刻的同一条内容：升级成已解析模板，不重复占两格
  const savedIndex = list.findIndex((entry) => entry.kind === 'saved' && entry.sourceId && entry.sourceId === item?.id)
  const saved = savedIndex >= 0 ? list.splice(savedIndex, 1)[0] : null
  const template = {
    id,
    kind: 'replica',
    jobId,
    title: analysis.title || item.title || '未命名模板',
    contentType: analysis.contentType,
    tags: analysis.tags,
    platform: item.platform,
    platformLabel: item.platformLabel,
    sourceUrl: item.url || '',
    sourceId: item.id,
    author: item.author || '',
    publishedAt: item.publishedAt || '',
    stats: item.stats || { likes: 0, comments: 0, shares: 0, collects: 0 },
    durationSec: Math.round(meta.duration),
    hook: analysis.hook,
    hookType: analysis.hookType,
    structure: analysis.structure,
    storyboard: analysis.storyboard.map((shot) => ({ ...shot, frameUrl: '/media/frames/' + id + '/frame-' + String(shot.frameIndex).padStart(2, '0') + '.jpg' })),
    analysis: analysis.analysis,
    frames: frames.map((frame) => ({ index: frame.index, t: frame.t, url: '/media/frames/' + id + '/' + frame.name })),
    cover: frames[0] ? '/media/frames/' + id + '/' + frames[0].name : '',
    video: { width: meta.width, height: meta.height, fps: meta.fps, duration: meta.duration },
    origin: 'ai',
    reuseCount: saved?.reuseCount || 0,
    createdAt: saved?.createdAt || new Date().toISOString(),
  }
  list.unshift(template)
  await persist(list)
  return template
}

export async function reuseTemplate(id) {
  const list = await loadAll()
  const target = list.find((item) => item.id === id)
  if (!target) return null
  target.reuseCount = (target.reuseCount || 0) + 1
  target.lastReusedAt = new Date().toISOString()
  await persist(list)
  return target
}

export async function deleteTemplate(id) {
  const list = await loadAll()
  const next = list.filter((item) => item.id !== id)
  if (next.length === list.length) return false
  await persist(next)
  await fsp.rm(path.join(config.framesDir, id), { recursive: true, force: true })
  return true
}

export async function templateStats() {
  const list = await loadAll()
  const byType = {}
  for (const item of list) {
    if (item.kind === 'saved') continue
    byType[item.contentType] = (byType[item.contentType] || 0) + 1
  }
  return {
    total: list.length,
    parsed: list.filter((item) => item.kind !== 'saved').length,
    saved: list.filter((item) => item.kind === 'saved').length,
    byType,
  }
}
