import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { canAccess } from './owner.mjs'

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

export async function listTemplates({ q = '', contentType = '', platform = '', kind = '' } = {}, user = null) {
  const list = await loadAll()
  const keyword = q.trim()
  return list
    .filter((item) => canAccess(item, user))
    .filter((item) => !item.deletedAt)
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
export async function saveTemplateFromItem({ item, user = null, shared = false }) {
  const list = await loadAll()
  const sourceId = String(item?.id || '')
  // 去重只在同一账号内做：两个账号收藏同一条爆款，各自算各自的一条
  const existing = list.find(
    (entry) => entry.kind === 'saved' && entry.sourceId && entry.sourceId === sourceId && canAccess(entry, user),
  )
  if (existing) {
    // 运营把同一条内容再收一次「公共模板」：升级成公共，不再多占一格
    if (shared && (existing.ownerId || !existing.shared)) {
      existing.ownerId = ''
      existing.shared = true
      await persist(list)
    }
    return { template: existing, created: false }
  }
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
    timing: null,
    analysis: { pacing: '', viralPoints: [], reusableRules: [], targetAudience: '' },
    frames: [],
    cover: String(item?.cover || ''),
    video: { width: 0, height: 0, fps: 0, duration: Number(item?.durationSec) || 0 },
    origin: 'manual',
    reuseCount: 0,
    ownerId: shared ? '' : user?.id || '',
    ...(shared ? { shared: true } : {}),
    createdAt: now,
    savedAt: now,
  }
  list.unshift(template)
  await persist(list)
  return { template, created: true }
}



export async function getTemplate(id, user = null) {
  const list = await loadAll()
  return list.find((item) => item.id === id && canAccess(item, user)) || null
}

export async function createTemplate({ item, meta, analysis, frames, jobId, user = null, shared = false }) {
  const list = await loadAll()
  const id = 'tpl_' + randomUUID().slice(0, 8)
  const targetDir = path.join(config.framesDir, id)
  await fsp.mkdir(targetDir, { recursive: true })
  const sourceDir = path.dirname(frames[0].file)
  await fsp.cp(sourceDir, targetDir, { recursive: true })

  // 雷达里先「加入模板库」、后来才复刻的同一条内容：升级成已解析模板，不重复占两格
  const savedIndex = list.findIndex(
    (entry) => entry.kind === 'saved' && entry.sourceId && entry.sourceId === item?.id && canAccess(entry, user),
  )
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
    // 时长与台词对账结果：模板详情和「复用此模板」都靠它判断这条片子照不照得下来
    timing: analysis.timing || null,
    analysis: analysis.analysis,
    frames: frames.map((frame) => ({ index: frame.index, t: frame.t, url: '/media/frames/' + id + '/' + frame.name })),
    cover: frames[0] ? '/media/frames/' + id + '/' + frames[0].name : '',
    video: { width: meta.width, height: meta.height, fps: meta.fps, duration: meta.duration },
    origin: 'ai',
    reuseCount: saved?.reuseCount || 0,
    // 公共模板（运营种子内容）没有归属，所有账号都看得见；其余归创建人
    ownerId: shared ? '' : user?.id || saved?.ownerId || '',
    ...(shared || saved?.shared ? { shared: true } : {}),
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

// 画布「另存为模板」：把一张流程的节点/连线一起存成可复用的工作流模板。
// 与爆款模板不同，它没有视频、没有分镜，只在模板库里占一条「工作流」类型；
// blueprint 是恢复用的真节点与连线，套用时原样建回一张新画布。
export async function createTemplateFromFlow({ flow, title = '', contentType = '工作流', tags = [], user = null }) {
  if (!flow) return null
  const list = await loadAll()
  const now = new Date().toISOString()
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : []
  const edges = Array.isArray(flow.edges) ? flow.edges : []
  const prompts = nodes
    .filter((node) => node?.type === 'llm' && node?.data?.config?.systemPrompt)
    .map((node) => String(node.data.config.systemPrompt).slice(0, 200))
  const template = {
    id: 'tpl_' + randomUUID().slice(0, 8),
    kind: 'flow',
    title: String(title || flow.name || '未命名工作流').trim().slice(0, 120),
    contentType: String(contentType || '工作流').trim().slice(0, 40),
    tags: (Array.isArray(tags) ? tags : []).map((tag) => String(tag).trim()).filter(Boolean).slice(0, 12),
    platform: 'canvas',
    platformLabel: '画布',
    sourceUrl: '',
    sourceId: flow.id,
    author: '',
    publishedAt: '',
    stats: { plays: 0, likes: 0, comments: 0, shares: 0, collects: 0 },
    durationSec: 0,
    hook: '',
    hookType: '',
    structure: [],
    // 卡片/详情展示用：节点标题 + 类型，避免前端去解 blueprint 的完整结构
    flowNodes: nodes.slice(0, 30).map((node) => ({
      title: String(node?.data?.title || node?.type || '节点').slice(0, 80),
      kind: String(node?.type || 'input'),
    })),
    storyboard: [],
    analysis: { pacing: '', viralPoints: [], reusableRules: prompts.slice(0, 5), targetAudience: '' },
    frames: [],
    cover: '',
    video: { width: 0, height: 0, fps: 0, duration: 0 },
    blueprint: {
      nodes: JSON.parse(JSON.stringify(nodes)).slice(0, 60),
      edges: JSON.parse(JSON.stringify(edges)).slice(0, 120),
    },
    origin: 'canvas',
    reuseCount: 0,
    ownerId: user?.id || '',
    createdAt: now,
  }
  list.unshift(template)
  await persist(list)
  return template
}

// 后台治理与画布「另存为模板」共用：只允许改能决定展示与检索的字段
export async function updateTemplate(id, patch = {}, user = null) {
  const list = await loadAll()
  const index = list.findIndex((item) => item.id === id && canAccess(item, user))
  if (index < 0) return null
  const current = list[index]
  const next = { ...current }
  if (patch.title !== undefined) next.title = String(patch.title).trim().slice(0, 120) || current.title
  if (patch.contentType !== undefined) next.contentType = String(patch.contentType).trim().slice(0, 40)
  if (Array.isArray(patch.tags)) {
    next.tags = patch.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 12)
  }
  if (patch.sourceUrl !== undefined) next.sourceUrl = String(patch.sourceUrl).trim().slice(0, 1000)
  // 公共模板：运营放进来的示例，所有账号可见（ownerId 置空）；收回时重新归到管理员名下
  if (patch.shared !== undefined) {
    const shared = Boolean(patch.shared)
    next.shared = shared
    next.ownerId = shared ? '' : user?.id || current.ownerId || ''
  }
  next.updatedAt = new Date().toISOString()
  list[index] = next
  await persist(list)
  return next
}

// 删除先进回收站：一条解析过的模板要花 10 积分才拆得出来，误删不该只能重跑
const TRASH_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export async function deleteTemplate(id, user = null) {
  const list = await loadAll()
  const index = list.findIndex((item) => item.id === id && !item.deletedAt && canAccess(item, user))
  if (index < 0) return null
  const next = [...list]
  next[index] = { ...next[index], deletedAt: new Date().toISOString(), deletedBy: user?.id || '' }
  await persist(next)
  return next[index]
}

// 回收站里的条目 30 天后自动清掉：不额外起定时任务，列的时候顺手清
export async function listTrash(user = null) {
  const list = await loadAll()
  const now = Date.now()
  const expired = list.filter((item) => item.deletedAt && now - Date.parse(item.deletedAt) > TRASH_DAYS * DAY_MS)
  if (expired.length) {
    const ids = new Set(expired.map((item) => item.id))
    await persist(list.filter((item) => !ids.has(item.id)))
    for (const item of expired) await fsp.rm(path.join(config.framesDir, item.id), { recursive: true, force: true })
  }
  const fresh = await loadAll()
  return fresh
    .filter((item) => item.deletedAt && canAccess(item, user))
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
    .map((item) => ({ ...item, thumb: item.frames?.[0]?.url || item.cover || '' }))
}

export async function restoreTemplate(id, user = null) {
  const list = await loadAll()
  const index = list.findIndex((item) => item.id === id && item.deletedAt && canAccess(item, user))
  if (index < 0) return null
  const next = [...list]
  const copy = { ...next[index] }
  delete copy.deletedAt
  delete copy.deletedBy
  next[index] = copy
  await persist(next)
  return next[index]
}

export async function purgeTemplate(id, user = null) {
  const list = await loadAll()
  const target = list.find((item) => item.id === id && item.deletedAt && canAccess(item, user))
  if (!target) return false
  await persist(list.filter((item) => item.id !== id))
  await fsp.rm(path.join(config.framesDir, id), { recursive: true, force: true })
  return true
}

export async function templateStats(user = null) {
  const list = (await loadAll()).filter((item) => canAccess(item, user)).filter((item) => !item.deletedAt)
  const byType = {}
  for (const item of list) {
    if (item.kind === 'saved') continue
    byType[item.contentType] = (byType[item.contentType] || 0) + 1
  }
  return {
    total: list.length,
    // 已解析只算跑过复刻、真的有脚本与分镜的；画布工作流单独计数，不混进解析口径
    parsed: list.filter((item) => item.kind === 'replica').length,
    saved: list.filter((item) => item.kind === 'saved').length,
    flows: list.filter((item) => item.kind === 'flow').length,
    byType,
  }
}

// 启动迁移：升级前的老数据没有归属，认领给管理员，免得升级后所有人都「看不见自己的模板」
export async function adoptUnowned(ownerId) {
  if (!ownerId) return 0
  const list = await loadAll()
  // 公共模板（shared）本来就是「没有归属、所有人可见」，不能被启动迁移认领成管理员私有
  const pending = list.filter((item) => !item.ownerId && !item.shared)
  if (!pending.length) return 0
  for (const item of pending) item.ownerId = ownerId
  await persist(list)
  return pending.length
}
