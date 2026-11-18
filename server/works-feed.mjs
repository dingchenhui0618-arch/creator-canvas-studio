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
import { listCanvases } from './bdc.mjs'

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
    })
  }
  return rows
}

async function runItems(user) {
  const { items } = await listRuns({ ownerId: user.id, limit: 50 })
  return items.map((run) => ({
    id: 'run:' + run.id,
    kind: 'run',
    title: String(run.flowName || '一次工作流运行').slice(0, 42),
    aspect: 'unknown',
    thumbUrl: null,
    previewUrl: null,
    at: Date.parse(run.finishedAt || run.startedAt) || Date.parse(run.createdAt || '') || 0,
    source: '工作流',
    detailUrl: '#/runs',
    status: run.status,
  }))
}

async function canvasItems() {
  const result = await listCanvases()
  if (!result.ok) return []
  return result.canvases.map((canvas) => ({
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
}

/** 三种来源合并、按时间倒序；游标是上一页最后一条的 `at:id`，不用时间戳比较（同毫秒会漏）。 */
export function mergeWorks({ media = [], runs = [], canvases = [], kind = 'all', limit = DEFAULT_LIMIT, before = '' } = {}) {
  const wanted = String(kind || 'all')
  if (!WORKS_KINDS.includes(wanted)) return { error: 'WORKS_KIND' }
  const size = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT))
  let items = [...media, ...runs, ...canvases]
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
  return { items: page, total: items.length, cursor }
}

export async function listWorks(user, options = {}) {
  const [media, canvases] = await Promise.all([mediaItems(user.id), canvasItems()])
  return mergeWorks({ media, runs: await runItems(user), canvases, ...options })
}

export function publicWork(item) {
  return { ...item, id: safeId(item.id) }
}
