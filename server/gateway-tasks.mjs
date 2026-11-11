// 生成任务台账（落盘）：出视频、SeeAPI 的异步出图都是「建任务 + 轮询」两段式，
// 任务在上游挂在建它那把 Key 的账号下，所以「任务 id → 那把 Key」这条对应关系
// 必须活过进程重启 —— 否则一次发版就让人白付一次钱（轮询 404，只能重新生成）。
//
// 落盘内容不含任何明文密钥：Key 用平台自己的 AES-256-GCM 再包一层（sealedKey），
// 只在轮询那一刻解开；Key 被删除后旧任务照样能查完，不会因为删 Key 丢掉已付费的成品。
import { config } from './config.mjs'
import fs from 'node:fs'
import path from 'node:path'

const RUNNING_TTL_MS = 2 * 60 * 60 * 1000
const KEEP_TTL_MS = 24 * 60 * 60 * 1000
const KEEP_LIMIT = 100

const tasksFile = () => path.join(config.dataDir, 'gateway-tasks.json')

let loaded = false
const tasks = new Map()

function persist() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    const rows = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP_LIMIT)
    const tmp = tasksFile() + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: rows }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, tasksFile())
  } catch (error) {
    console.error('[gateway] 任务台账写入失败：' + String(error?.message || error))
  }
}

function load() {
  if (loaded) return
  loaded = true
  try {
    const parsed = JSON.parse(fs.readFileSync(tasksFile(), 'utf8'))
    for (const row of Array.isArray(parsed?.tasks) ? parsed.tasks : []) {
      if (row?.id) tasks.set(String(row.id), row)
    }
  } catch {
    // 第一次启动或文件损坏：从空台账开始，不影响生成
  }
}

/** 建任务成功时记一行；sealedKey 是那一次调用用的密钥密文，轮询时用它回到同一把凭证。 */
export function rememberTask(input = {}) {
  load()
  const now = Date.now()
  const task = {
    id: String(input.id || ''),
    kind: input.kind === 'image' ? 'image' : 'video',
    keyId: String(input.keyId || ''),
    keyName: String(input.keyName || ''),
    baseUrl: String(input.baseUrl || ''),
    model: String(input.model || ''),
    sealedKey: String(input.sealedKey || ''),
    status: 'running',
    createdAt: now,
    updatedAt: now,
    terminalAt: 0,
  }
  if (!task.id) return task
  tasks.set(task.id, task)
  persist()
  return task
}

export function getTask(id) {
  load()
  const task = tasks.get(String(id || ''))
  if (!task) return null
  if (!task.terminalAt && Date.now() - task.updatedAt > RUNNING_TTL_MS) return null
  return task
}

/** 轮询拿到终态时把结果写回台账；后台「最近任务」显示的就是这份历史。 */
export function finishTask(id, patch = {}) {
  load()
  const task = tasks.get(String(id || ''))
  if (!task) return null
  Object.assign(task, patch, { updatedAt: Date.now(), terminalAt: Date.now() })
  persist()
  return task
}

export function touchTask(id) {
  load()
  const task = tasks.get(String(id || ''))
  if (!task) return null
  task.updatedAt = Date.now()
  return task
}

/** 清掉过期任务：跑着但 2 小时没动静的当失败收，终态任务留 24 小时给后台看。 */
export function pruneTasks() {
  load()
  const now = Date.now()
  let changed = false
  for (const [id, task] of tasks) {
    if (task.terminalAt ? now - task.terminalAt > KEEP_TTL_MS : now - task.updatedAt > RUNNING_TTL_MS) {
      tasks.delete(id)
      changed = true
    }
  }
  if (tasks.size > KEEP_LIMIT) {
    const extra = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(KEEP_LIMIT)
    for (const task of extra) tasks.delete(task.id)
    changed = true
  }
  if (changed) persist()
}

export function listTasks(limit = 10) {
  load()
  pruneTasks()
  const size = Math.max(1, Math.min(KEEP_LIMIT, Number(limit) || 10))
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, size)
}

export function countRunning() {
  load()
  pruneTasks()
  return [...tasks.values()].filter((task) => !task.terminalAt).length
}

/** 测试用：只清内存、保留磁盘 —— 模拟一次进程重启后从台账恢复。 */
export function forgetInMemoryForTest() {
  tasks.clear()
  loaded = false
}

/** 测试与本地重置用：清空内存与磁盘上的台账。 */
export function resetTaskStore() {
  tasks.clear()
  loaded = true
  try {
    fs.rmSync(tasksFile(), { force: true })
  } catch {
    // 忽略：文件本来就不存在
  }
}
