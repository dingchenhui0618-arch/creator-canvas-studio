// 作品（Project）：一条内容的主线对象。
//
// 默认只存引用：脚本留在绑定的模板上，画布在流程服务里，评审在 reviews.json 里。
// 唯一例外是**脚本的 copy-on-write**：用户在作品页改脚本时，才把脚本复制成作品自己的版本
// （见 project-script.mjs）。没改过的作品仍然跟着模板走，不会平白多一份过期副本。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { canAccess } from './owner.mjs'
import { normalizeStoredScript } from './project-script.mjs'

const projectsFile = path.join(config.dataDir, 'projects.json')
const MAX_PROJECTS = 200
const STATUSES = ['active', 'done']
// 一条作品最多保留 20 版：再多就不是「对照」而是流水账，旧版本也不该无限长下去
const MAX_VERSIONS = 20
export const PROJECT_VERSION_LIMIT = MAX_VERSIONS

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fsp.readFile(projectsFile, 'utf8'))
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  return cache
}

// 整文件读改写：写盘串成一条队列，避免两个请求共用一个 .tmp 互相 rename 掉对方。
function enqueueWrite(task) {
  const next = writeChain.then(task, task)
  writeChain = next.catch(() => {})
  return next
}

async function persist(list) {
  cache = list
  return enqueueWrite(async () => {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const tmp = projectsFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    await fsp.rename(tmp, projectsFile)
  })
}

const clip = (value, max) => String(value ?? '').slice(0, max)

function normalizeVersion(raw, fallbackN) {
  const n = Math.round(Number(raw?.n))
  return {
    n: Number.isFinite(n) && n > 0 ? n : fallbackN,
    flowId: String(raw?.flowId || ''),
    name: clip(raw?.name || '未命名画布', 60),
    archivedAt: String(raw?.archivedAt || ''),
  }
}

function normalize(item) {
  const versions = (Array.isArray(item.versions) ? item.versions : [])
    .filter((entry) => entry && entry.flowId)
    .map((entry, index) => normalizeVersion(entry, index + 1))
    .slice(-MAX_VERSIONS)
  // 版本号是作品自己的计数：没存过就按「归档几版 + 当前一版」推出来，老数据不会显示成 v0
  const derived = versions.length + (String(item.flowId || '') ? 1 : 0)
  const stored = Math.round(Number(item.version))
  const version = Number.isFinite(stored) ? Math.max(derived, Math.max(0, stored)) : derived
  return {
    id: String(item.id),
    ownerId: String(item.ownerId || ''),
    title: clip(item.title || '未命名作品', 80),
    templateId: String(item.templateId || ''),
    flowId: String(item.flowId || ''),
    // 第几版：0 表示还没开过画布，开出来就是 v1
    version,
    // 归档的旧版本只存指针：画布还在流程服务里，这里不复制节点
    versions,
    // 作品自己的脚本：只有用户动过才存在；没有就跟随模板（项目页读 scriptView）
    script: normalizeStoredScript(item.script),
    // 只读分享：token 本身就是凭证；没开就是 null。列表接口不返回它（projectBrief 会剥掉）
    share: item.shareToken
      ? { token: String(item.shareToken), createdAt: String(item.shareCreatedAt || '') }
      : null,
    status: STATUSES.includes(item.status) ? item.status : 'active',
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
  }
}

/** 列表：按最近改动排序。归属规则与模板/评审一致（管理员可见全部，未登录不过滤）。 */
export async function listProjects(user = null) {
  const list = await loadAll()
  return list
    .filter((item) => canAccess(item, user))
    .map(normalize)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export async function getProject(id, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  return found ? normalize(found) : null
}

export async function createProject({ title = '', templateId = '', flowId = '' } = {}, user = null) {
  const list = await loadAll()
  const now = new Date().toISOString()
  const project = {
    id: 'prj_' + randomUUID().slice(0, 8),
    // 作品必须归人：没有登录态就不建（不像模板那样允许公共条目，公共作品没有意义）
    ownerId: String(user?.id || ''),
    title: clip(title || '未命名作品', 80),
    templateId: String(templateId || ''),
    flowId: String(flowId || ''),
    version: 0,
    versions: [],
    // 先不复制模板脚本：复制发生在第一次保存脚本时（copy-on-write）
    script: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  await persist([project, ...list].slice(0, MAX_PROJECTS))
  return normalize(project)
}

const PATCHABLE = ['title', 'flowId', 'status']

/** 只允许改标题、绑定的画布、状态；模板绑定建好就不改（换模板等于换一条内容）。 */
export async function updateProject(id, patch = {}, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  let changed = false
  for (const key of PATCHABLE) {
    if (!(key in patch)) continue
    const value = key === 'status'
      ? (STATUSES.includes(patch.status) ? patch.status : found.status)
      : key === 'title'
        ? clip(patch.title, 80)
        : String(patch[key] || '')
    if (value === found[key]) continue
    found[key] = value
    changed = true
  }
  // 第一次绑上画布就是 v1：版本计数从这里开始，之后只有「开一版新的」才会加
  if (found.flowId && !Number(found.version)) {
    found.version = 1
    changed = true
  }
  if (changed) {
    found.updatedAt = new Date().toISOString()
    await persist(list)
  }
  return normalize(found)
}

/**
 * 保存作品自己的脚本（第一次保存就是把模板脚本复制过来）。
 * 只收已经归一化过的脚本；形状不对返回 null，调用方当作「没保存成功」。
 */
export async function saveProjectScript(id, script, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  const normalized = normalizeStoredScript(script)
  if (!found || !normalized) return null
  found.script = normalized
  found.updatedAt = new Date().toISOString()
  await persist(list)
  return normalize(found)
}

/** 恢复成「跟随模板」：删掉作品自己的脚本副本，模板改回来作品就跟着变。 */
export async function clearProjectScript(id, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  if (!found.script) return normalize(found)
  found.script = null
  found.updatedAt = new Date().toISOString()
  await persist(list)
  return normalize(found)
}

/** 只给「绑定画布」用：绑定后刷新时间，但不改标题/状态。 */
export async function bindProjectFlow(id, flowId, user = null) {
  return updateProject(id, { flowId: String(flowId || '') }, user)
}

/**
 * 开新版本：当前画布存成归档（只存 flowId 与名字，不复制节点），作品改指向新画布。
 * 复制画布本身由路由做——存储层只认指针，不碰流程服务。
 */
export async function archiveProjectVersion(id, { flowId = '', prevName = '' } = {}, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const current = normalize(found)
  if (!current.flowId) return null
  const now = new Date().toISOString()
  found.versions = [
    ...current.versions,
    { n: current.version, flowId: current.flowId, name: clip(prevName || '上一版画布', 60), archivedAt: now },
  ].slice(-MAX_VERSIONS)
  found.flowId = String(flowId || '')
  found.version = current.version + 1
  found.updatedAt = now
  await persist(list)
  return normalize(found)
}

export async function deleteProject(id, user = null) {
  const list = await loadAll()
  const index = list.findIndex((item) => item.id === id && canAccess(item, user))
  if (index < 0) return null
  const [removed] = list.splice(index, 1)
  await persist(list)
  return normalize(removed)
}

// ---------- 只读分享链接 ----------
// 分享给没有账号的人看（甲方、剪辑），所以链接本身就是凭证：24 字节随机 token。
// 与模板分享同一套规则：停止分享就把 token 清掉，旧链接当场失效；重新开启换一个新 token。
// 公开视图走 project-share.mjs 的白名单，不带归属、内部 id 与画布信息。
const SHARE_TOKEN_MIN = 16

function newShareToken() {
  return randomBytes(18).toString('base64url')
}

export async function enableProjectShare(id, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const token = newShareToken()
  const createdAt = new Date().toISOString()
  found.shareToken = token
  found.shareCreatedAt = createdAt
  found.shareBy = user?.id || ''
  await persist(list)
  return { token, createdAt }
}

export async function disableProjectShare(id, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  if (!found.shareToken) return true
  delete found.shareToken
  delete found.shareCreatedAt
  delete found.shareBy
  await persist(list)
  return true
}

/** 按分享 token 找作品：只认仍然开着分享的条目；长度不够的 token 不查盘。 */
export async function getProjectByShareToken(token) {
  if (!token || typeof token !== 'string' || token.length < SHARE_TOKEN_MIN) return null
  const list = await loadAll()
  const found = list.find((item) => item.shareToken === token)
  return found ? normalize(found) : null
}

/** 注销账号时用。 */
export async function deleteProjectsByOwner(ownerId) {
  if (!ownerId) return 0
  const list = await loadAll()
  const mine = list.filter((item) => item.ownerId === ownerId)
  if (!mine.length) return 0
  await persist(list.filter((item) => item.ownerId !== ownerId))
  return mine.length
}
