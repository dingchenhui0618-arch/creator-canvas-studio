import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { config } from './config.mjs'

// 两个生产实例（8799 / 8800）共用一份 DATA_DIR：重启其中一个时，启动恢复会把另一个
// 还在跑的运行当成「上次进程没跑完」——标中断、退积分，那条运行跑完又写回成功，
// 等于白送一次模型调用。这个模块只回答一个问题：某条运行的主人是死是活。
//
// 判据不能只看心跳时间：进程刚崩、马上重启时旧心跳还很新（60 秒窗口），
// 只看时间就会把一条已经没人执行的记录当成「别人在跑」，永远没人收。
// 所以还要核对进程 pid 与这次开机（boot id）：心跳新 + pid 在 + 同一台机器同一次开机 = 活着。
// 生产两个实例以不同用户跑（visionqa / root），跨用户读 /proc 与 kill(pid, 0) 仍然可用。

const BEAT_MS = Math.max(1000, Number(process.env.VQ_INSTANCE_BEAT_MS || 10000) || 10000)
const DEFAULT_TTL_MS = 60000
const KEEP_DEAD_MS = 7 * 24 * 60 * 60 * 1000

let timer = null
let current = null
let lastError = ''

let cachedBootId = null
function bootId() {
  if (cachedBootId !== null) return cachedBootId
  try {
    cachedBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    // Windows / macOS 没有这个文件：退回空值，pid 判定仍然有效
    cachedBootId = ''
  }
  return cachedBootId
}

export function instanceBeatMs() {
  return BEAT_MS
}

export function instanceTtlMs() {
  const raw = Number(process.env.VQ_INSTANCE_TTL_MS)
  if (Number.isFinite(raw) && raw > 0) return Math.max(BEAT_MS * 2, raw)
  return Math.max(BEAT_MS * 3, DEFAULT_TTL_MS)
}

export function instancesDir() {
  const raw = process.env.VQ_INSTANCE_DIR
  return raw ? path.resolve(raw) : path.join(config.dataDir, 'instances')
}

/** 实例的身份是「哪个角色、哪个端口」：重启不换身份，才能认出自己上一次留下的记录。
 *  默认值不带主机名：运行记录会原样回给账号（/api/runs），没必要把内网主机名带出去。 */
export function currentInstanceId() {
  const explicit = String(process.env.VQ_INSTANCE_ID || '').trim()
  if (explicit) return explicit.slice(0, 120)
  return (config.ui.mode === 'internal' ? 'internal' : 'public') + ':' + config.port
}

/** 心跳文件路径：文件名只放 id 的哈希，id 本身写在文件里（运维脚本与用例也用它）。 */
export function instanceFilePath(id) {
  return path.join(instancesDir(), createHash('sha256').update(String(id)).digest('hex').slice(0, 16) + '.json')
}

function pidAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    // EPERM = 进程在，只是不归当前用户；ESRCH 才是真的没了
    return error && error.code === 'EPERM'
  }
}

function stateOf(entry, now) {
  const beatAt = Date.parse(String(entry.beatAt || ''))
  if (!Number.isFinite(beatAt)) return 'bad'
  const ageMs = Math.max(0, now - beatAt)
  if (ageMs > instanceTtlMs()) return 'stale'
  if (entry.host === os.hostname()) {
    const liveBoot = bootId()
    if (liveBoot && entry.bootId && entry.bootId !== liveBoot) return 'restarted'
    if (!pidAlive(entry.pid)) return 'dead'
  }
  return 'alive'
}

/** 写自己这一拍。失败不抛给调用方：心跳坏了不该让服务起不来，但要把原因留出来给后台看。 */
async function beat() {
  if (!current) return null
  try {
    const dir = instancesDir()
    await fsp.mkdir(dir, { recursive: true, mode: 0o777 })
    // 两个实例以不同用户跑：目录必须是双方都能写的，否则后启动的一边写不进自己的心跳
    await fsp.chmod(dir, 0o777).catch(() => {})
    const entry = { ...current, beatAt: new Date().toISOString() }
    const file = instanceFilePath(entry.id)
    const tmp = file + '.' + process.pid + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(entry), { mode: 0o666 })
    await fsp.rename(tmp, file)
    lastError = ''
    current = entry
    return entry
  } catch (error) {
    lastError = String(error && error.message ? error.message : error)
    console.error('[instances] 心跳写入失败（不影响服务，但恢复时会失去存活判据）：' + lastError)
    return null
  }
}

export function instanceHeartbeatError() {
  return lastError
}

/** 启动时先写第一拍，再做启动恢复：否则另一个实例恰好这时重启，会看不到我们。 */
export async function startInstanceHeartbeat() {
  if (!current) {
    current = {
      id: currentInstanceId(),
      pid: process.pid,
      host: os.hostname(),
      bootId: bootId(),
      startedAt: new Date().toISOString(),
    }
  }
  await beat()
  if (!timer) {
    timer = setInterval(() => {
      beat().catch(() => {})
    }, BEAT_MS)
    // 心跳不该拖住进程退出
    timer.unref?.()
  }
  // 清理失败不该挡住服务启动：心跳已经写进去了，剩下的只是磁盘卫生
  await pruneInstances().catch((error) => {
    console.error('[instances] 清理过期心跳失败：' + String(error && error.message ? error.message : error))
  })
  return current
}

export async function stopInstanceHeartbeat() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (current) {
    await fsp.rm(instanceFilePath(current.id), { force: true }).catch(() => {})
    current = null
  }
}

/** 只清掉「已经死了很久」的心跳文件：崩溃瞬间那几秒的旧心跳要留着给判据用。 */
export async function pruneInstances() {
  let removed = 0
  for (const entry of await readInstances()) {
    if (entry.alive || entry.ageMs < KEEP_DEAD_MS) continue
    await fsp.rm(entry.file, { force: true }).catch(() => {})
    removed += 1
  }
  return removed
}

async function readInstances() {
  const dir = instancesDir()
  let files = []
  try {
    files = (await fsp.readdir(dir)).filter((name) => name.endsWith('.json'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const now = Date.now()
  const list = []
  for (const name of files) {
    const file = path.join(dir, name)
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
      if (!parsed || typeof parsed.id !== 'string' || !parsed.id) continue
      const state = stateOf(parsed, now)
      list.push({
        id: parsed.id,
        pid: Number(parsed.pid) || 0,
        host: String(parsed.host || ''),
        startedAt: String(parsed.startedAt || ''),
        beatAt: String(parsed.beatAt || ''),
        ageMs: Number.isFinite(Date.parse(String(parsed.beatAt || ''))) ? Math.max(0, now - Date.parse(parsed.beatAt)) : null,
        state,
        alive: state === 'alive',
        self: parsed.id === currentInstanceId(),
        file,
      })
    } catch {
      // 半截文件（写到一半被杀）不参与判定
    }
  }
  list.sort((a, b) => (a.self === b.self ? a.id.localeCompare(b.id) : a.self ? -1 : 1))
  return list
}

/** 后台「执行实例」卡片用：带上每一台的年龄、状态与本进程的心跳错误。 */
export async function listInstances() {
  let items = []
  let readError = ''
  try {
    items = await readInstances()
  } catch (error) {
    readError = '读取心跳目录失败：' + String(error && error.message ? error.message : error)
  }
  return {
    self: currentInstanceId(),
    beatMs: BEAT_MS,
    ttlMs: instanceTtlMs(),
    heartbeatError: lastError || readError,
    items: items.map((entry) => ({
      id: entry.id,
      pid: entry.pid,
      host: entry.host,
      startedAt: entry.startedAt,
      beatAt: entry.beatAt,
      ageMs: entry.ageMs,
      state: entry.state,
      alive: entry.alive,
      self: entry.self,
    })),
  }
}

/** 启动恢复用：只有「心跳新 + 进程在 + 同一次开机」的实例才配保护自己的运行。 */
export async function liveInstanceIds() {
  try {
    return new Set((await readInstances()).filter((entry) => entry.alive).map((entry) => entry.id))
  } catch (error) {
    console.error('[instances] 读取实例心跳失败，按没有其他实例处理：' + String(error && error.message ? error.message : error))
    return new Set()
  }
}
