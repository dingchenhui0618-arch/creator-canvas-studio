// 作品流（r213）：把「快捷创作」「工作流」「无限画布」三处产物收成一条能翻的流。
//
// 为什么放在服务端：三个来源各写一套扫描，前端就会算出三个不一样的「共几条」；
// 而且权限（谁能看哪条）本来就在服务端——前端只负责画。
//
// 口径：
//  - 只列成功产出：快捷创作取 status=succeeded 的任务（失败的不进作品流，它们留在「最近生成」里看原因）；
//  - 工作流取已完成/被停止的运行（error 的运行也有产物，但这里只当「做过」，用状态徽标说明）；
//  - 无限画布是同一台机器上的独立应用，它自己的作品存在画布 workspace 里，
//    这里只列它有哪些画布（名称 / 节点数 / 更新时间），点开进无限画布看内容——
//    不把画布内部节点假造成「作品」，也不读取其它账号在画布里的东西。
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { listRuns } from './flows.mjs'
import { listCanvases, loadCanvasNodes } from './bdc.mjs'
import { visibleCanvases } from './canvas-owner.mjs'

export const WORKS_KINDS = ['all', 'image', 'video', 'run', 'canvas']
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 48
const TASK_SCAN = 400

function taskDir() {
  return path.join(config.dataDir, 'media', 'tasks')
}

function safeId(value) {
  return String(value || '')
}

async function mediaItems(userId) {
  let names = []
  try {
    names = await fs.promises.readdir(taskDir())
  } catch {
    return []
  }
  const rows = []
  for (const name of names.slice(0, TASK_SCAN)) {
    if (!name.endsWith('.json')) continue
    let task = null
    try {
      task = JSON.parse(await fs.promises.readFile(path.join(taskDir(), name), 'utf8'))
    } catch {
      continue
    }
    if (!task || String(task.userId) !== String(userId)) continue
    if (task.status !== 'succeeded' || !task.file) continue
    if (task.kind !== 'image' && task.kind !== 'video') continue
    rows.push({
      id: 'media:' + task.id,
      kind: task.kind,
      title: String(task.prompt || '').slice(0, 42) || (task.kind === 'image' ? '一张图' : '一条视频'),
      aspect: task.kind === 'video' ? (task.ratio || '9:16') : (task.ratio || '1:1'),
      thumbUrl: '/api/media/tasks/' + task.id + '/file',
      previewUrl: '/api/media/tasks/' + task.id + '/file',
      at: Date.parse(task.createdAt) || 0,
      source: '快捷创作',
      detailUrl: '#/agents',
      model: modelLabel(task.model),
    })
  }
  return rows
}

// 一次运行在作品流里能给出的东西：它跑了哪条流程、成没成、花了多久，以及**最后一段文本输出**。
// 不把每个节点的输出都铺开（那是运行详情的事），只留一句能认出「这条跑出了什么」的摘要。
/** 卡片上的一句话：去掉 markdown 记号与纯地址行（图片地址已经在封面里了）。 */
function cleanSummary(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(\/|https?:\/\/)\S+$/.test(line))
    .map((line) => line.replace(/^#{1,6}\s*/, ''))
    .join(' ')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96)
}

function runSummaryText(run) {
  const nodes = Array.isArray(run.nodes) ? run.nodes : []
  // 有出图节点时，用那张图的说明做摘要：比输出节点汇总的 markdown 更像人话
  const cover = [...nodes].reverse().find((node) => node?.output && (
    (typeof node.output.imageUrl === 'string' && node.output.imageUrl) ||
    (typeof node.output.videoUrl === 'string' && node.output.videoUrl)
  ))
  if (cover?.output?.text) {
    const text = cleanSummary(cover.output.text)
    if (text) return text
  }
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const text = cleanSummary(nodes[index]?.output?.text)
    if (text) return text
  }
  return ''
}

// 工作流里的生成节点：这张作品卡的封面优先用真画出来的那张图，没有图再用出的那段视频。
// 只认服务端给的自有地址（/api/runs/<id>/assets/...），不做任何跨站直连。
function runCover(run) {
  const nodes = Array.isArray(run.nodes) ? run.nodes : []
  let video = null
  for (const node of nodes) {
    const output = node?.output
    if (!output) continue
    if (typeof output.imageUrl === 'string' && output.imageUrl.startsWith('/api/runs/')) return { output, kind: 'image' }
    if (!video && typeof output.videoUrl === 'string' && output.videoUrl.startsWith('/api/runs/')) video = output
  }
  return video ? { output: video, kind: 'video' } : null
}

/**
 * 一次运行在作品流里的一张卡（r266）。
 *
 * 以前的毛病：运行卡有封面（那张真画出来的图）却把 previewUrl 写成 null，
 * 于是点缩略图不是看大图，而是整页跳到运行视图——同一张图，在作品流的图片卡上点开是看大图，
 * 在运行卡上点开是换页面，两套行为。现在封面同时当预览，跳转收进浮层里的显式按钮。
 *
 * 还在跑 / 排队的运行不进作品流：作品流回答的是「做过什么」，没成品的进去只会被当成「已停止」。
 */
export function runWorkItem(run) {
  if (!run || run.status === 'running' || run.status === 'queued') return null
  const cover = runCover(run)
  const coverOutput = cover ? cover.output : null
  const coverUrl = coverOutput ? (cover.kind === 'video' ? coverOutput.videoUrl : coverOutput.imageUrl) : null
  return {
    id: 'run:' + run.id,
    kind: 'run',
    title: String(run.flowName || '一次工作流运行').slice(0, 42),
    aspect: coverOutput ? (String(coverOutput.ratio || '') || '1:1') : 'unknown',
    // 封面是图还是视频：卡片用不同的元素画（视频出第一帧，点开才是播放）
    mediaKind: cover ? cover.kind : '',
    thumbUrl: coverUrl,
    previewUrl: coverUrl,
    at: Date.parse(run.finishedAt || run.startedAt) || Date.parse(run.createdAt || '') || 0,
    source: '工作流',
    // 没有产物时才退化成「打开这次运行」；有产物时跳转是浮层里的一个按钮，不再抢缩略图
    detailUrl: run.flowId
      ? '#/canvas/' + encodeURIComponent(run.flowId) + '/run/' + encodeURIComponent(run.id)
      : '#/runs',
    status: run.status,
    summary: runSummaryText(run),
    durationMs: Number(run.durationMs) || 0,
    flowId: run.flowId || '',
    // 模型名已经在摘要里（「出图完成：GPT Image 2」），这里不再重复占一行宽度
  }
}

async function runItems(user) {
  const { items } = await listRuns({ ownerId: user.id, limit: 50 })
  return items.map((run) => runWorkItem(run)).filter(Boolean)
}

// 界面上的模型名：用产品叫法，不把内部 id（尤其带上游前缀的）原样端给用户。
const MODEL_LABELS = {
  'gpt-image-2': 'GPT Image 2',
  'seedance-2.0': 'Seedance 2.0',
  'seedance-2.0-fast': 'Seedance 2.0 · 极速',
  'cgcm-seedance-2-0': 'Seedance 2.0',
  'image-2-pro': 'GPT Image 2',
}

function modelLabel(id) {
  const raw = String(id || '').trim()
  if (!raw) return ''
  return MODEL_LABELS[raw.toLowerCase()] || raw.replace(/^cgcm-/i, '')
}

const RATIO_ALIAS = new Set(['1:1', '9:16', '16:9', '4:3', '3:4'])

// 画布里的生成节点：只有真的出过东西的才算作品。
// 口径（2026-11-18 在生产画布 JSON 上核对过）：type=ai-image / ai-video，
// params._generationStatus='done'，成品在 output（形如 /api/workspace/file/...，由画布自己的 6677 提供）。
function canvasNodeRatio(node, kind) {
  const params = node.params || {}
  const ratio = String(params.aspectRatio || '').trim()
  if (RATIO_ALIAS.has(ratio)) return ratio
  const width = Number(params._genPixelW) || 0
  const height = Number(params._genPixelH) || 0
  if (width > 0 && height > 0) {
    if (width === height) return '1:1'
    if (height > width) return '9:16'
    return '16:9'
  }
  return kind === 'video' ? '16:9' : '1:1'
}

function canvasNodeItems(canvas, nodes) {
  const rows = []
  for (const node of nodes) {
    if (!node || (node.type !== 'ai-image' && node.type !== 'ai-video')) continue
    const params = node.params || {}
    if (params._generationStatus !== 'done' && node.status !== 'done') continue
    const output = String(node.output || '')
    // 只代理画布自己的 workspace 地址：别的地址（外链、签名 url）不替它出流量
    if (!output.startsWith('/api/workspace/') || output.includes('..')) continue
    const kind = node.type === 'ai-image' ? 'image' : 'video'
    const prompt = String(node.prompt || '').trim()
    const query = '/api/works/canvas-file?canvas=' + encodeURIComponent(canvas.id) + '&node=' + encodeURIComponent(String(node.id || ''))
    rows.push({
      id: 'canvas-node:' + canvas.id + ':' + String(node.id || ''),
      kind,
      title: prompt.slice(0, 42) || (kind === 'image' ? '画布里的一张图' : '画布里的一条视频'),
      aspect: canvasNodeRatio(node, kind),
      // 视频也把代理地址给缩略图：卡片用 <video preload="metadata"> 出第一帧，点开才是播放
      thumbUrl: query,
      previewUrl: query,
      at: Number(params._generationSubmittedAt) || Number(canvas.updatedAt) || 0,
      source: '无限画布',
      detailUrl: '#/board/' + canvas.id,
      status: 'succeeded',
      canvasId: canvas.id,
      model: modelLabel(params._generationModel),
    })
  }
  return rows
}

async function canvasItems(user) {
  const result = await listCanvases()
  if (!result.ok) return []
  const mine = visibleCanvases(user, result.canvases)
  const cards = mine.map((canvas) => ({
    id: 'canvas:' + canvas.id,
    kind: 'canvas',
    title: String(canvas.name || '未命名无限画布').slice(0, 42),
    aspect: '16:9',
    thumbUrl: null,
    previewUrl: null,
    at: Number(canvas.updatedAt) || 0,
    source: '无限画布',
    detailUrl: '#/board/' + canvas.id,
    nodeCount: canvas.nodeCount,
  }))
  // 只为前 12 块画布读节点：作品流不是画布的备份，读太多会把一次请求拖成扫盘
  const nodes = await Promise.all(mine.slice(0, 12).map((canvas) => loadCanvasNodes(canvas.id).catch(() => null)))
  const media = []
  nodes.forEach((loaded, index) => {
    if (!loaded) return
    media.push(...canvasNodeItems(mine[index], loaded.nodes).slice(0, 24))
  })
  return [...cards, ...media]
}

/**
 * 三种来源合并、按时间倒序；游标是上一页最后一条的 `at:id`，不用时间戳比较（同毫秒会漏）。
 *
 * counts（r272）：**先数全部、再筛**，所以筛到「视频」时，界面仍然知道另外几类各有几条。
 * 以前只回一个按筛选后算的 total，「视频这一栏是空的」与「账号下一条作品都没有」在界面上
 * 长成一模一样的一句话——空状态只好猜，猜成「还没有作品」，把人指去重新生成。
 */
export function mergeWorks({ media = [], runs = [], canvases = [], kind = 'all', limit = DEFAULT_LIMIT, before = '' } = {}) {
  const wanted = String(kind || 'all')
  if (!WORKS_KINDS.includes(wanted)) return { error: 'WORKS_KIND' }
  const size = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT))
  const merged = [...media, ...runs, ...canvases]
  const counts = { all: merged.length, image: 0, video: 0, run: 0, canvas: 0 }
  for (const item of merged) {
    if (item && Object.prototype.hasOwnProperty.call(counts, item.kind) && item.kind !== 'all') counts[item.kind] += 1
  }
  let items = merged
  if (wanted !== 'all') items = items.filter((item) => item.kind === wanted)
  items.sort((a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id)))
  let start = 0
  if (before) {
    const index = items.findIndex((item) => item.at + ':' + item.id === before)
    // 游标那一条已经不在列表里：不猜位置，让界面刷新，而不是悄悄跳一页
    if (index < 0) return { error: 'WORKS_CURSOR' }
    start = index + 1
  }
  const page = items.slice(start, start + size)
  const cursor = start + size < items.length && page.length ? page[page.length - 1].at + ':' + page[page.length - 1].id : null
  return { items: page, total: items.length, cursor, counts }
}

export async function listWorks(user, options = {}) {
  const [media, canvases] = await Promise.all([mediaItems(user.id), canvasItems(user)])
  return mergeWorks({ media, runs: await runItems(user), canvases, ...options })
}

export function publicWork(item) {
  return { ...item, id: safeId(item.id) }
}
