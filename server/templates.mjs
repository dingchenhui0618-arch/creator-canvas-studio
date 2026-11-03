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

async function persist(list) {
  cache = list
  await fsp.mkdir(config.dataDir, { recursive: true })
  const tmp = config.templatesFile + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await fsp.rename(tmp, config.templatesFile)
}

export async function listTemplates({ q = '', contentType = '', platform = '' } = {}) {
  const list = await loadAll()
  const keyword = q.trim()
  return list
    .filter((item) => (contentType ? item.contentType === contentType : true))
    .filter((item) => (platform ? item.platform === platform : true))
    .filter((item) => (keyword ? (item.title + item.hook + item.tags.join(' ') + item.analysis.reusableRules.join(' ')).includes(keyword) : true))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((item) => ({ ...item, thumb: item.frames?.[0]?.url || '' }))
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

  const template = {
    id,
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
    reuseCount: 0,
    createdAt: new Date().toISOString(),
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
  for (const item of list) byType[item.contentType] = (byType[item.contentType] || 0) + 1
  return { total: list.length, byType }
}
