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
import { visitKey } from './share-visits.mjs'

const projectsFile = path.join(config.dataDir, 'projects.json')
const MAX_PROJECTS = 200
const STATUSES = ['active', 'done']
// 一条作品最多保留 20 版：再多就不是「对照」而是流水账，旧版本也不该无限长下去
const MAX_VERSIONS = 20
export const PROJECT_VERSION_LIMIT = MAX_VERSIONS
// 一条作品最多留 8 轮分享记录：更早的链接没人会回去看，留个上限免得作品记录无限长
const MAX_SHARE_HISTORY = 8
export const SHARE_HISTORY_LIMIT = MAX_SHARE_HISTORY
// 交付记录：一次「标记交付」= 哪一版、什么时候交出去。留 20 条，与版本上限对齐
const MAX_DELIVERIES = 20

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

// 开新版那一刻的脚本快照：版本之间唯一能对照的「这一版说了什么」。
// 脚本本身只有一份（作品级），归档时不留快照，历史版本的口播就永远找不回来了。
function normalizeVersionScript(raw) {
  if (!raw || typeof raw !== 'object') return null
  const structure = (Array.isArray(raw.structure) ? raw.structure : [])
    .filter((beat) => beat && typeof beat === 'object')
    .slice(0, 12)
    .map((beat) => ({
      beat: clip(beat.beat, 60),
      voiceover: clip(beat.voiceover, 600),
      onScreen: clip(beat.onScreen, 200),
      purpose: clip(beat.purpose, 200),
      startSec: Number(beat.startSec) || 0,
      endSec: Number(beat.endSec) || 0,
      expectedSec: Number(beat.expectedSec) || 0,
      fit: beat.fit === 'tight' || beat.fit === 'loose' ? beat.fit : '',
    }))
  if (!structure.length) return null
  return {
    hook: clip(raw.hook, 400),
    structure,
    // 这一版的脚本当时是「自己的」还是「跟随模板」：模板之后改了，快照仍然是当时的样子
    source: raw.source === 'template' ? 'template' : 'project',
    updatedAt: String(raw.updatedAt || ''),
  }
}

function normalizeVersion(raw, fallbackN) {
  const n = Math.round(Number(raw?.n))
  return {
    n: Number.isFinite(n) && n > 0 ? n : fallbackN,
    flowId: String(raw?.flowId || ''),
    name: clip(raw?.name || '未命名画布', 60),
    archivedAt: String(raw?.archivedAt || ''),
    script: normalizeVersionScript(raw?.script),
  }
}

// ---------- 分享历史 ----------
// 停用分享时 token 会被清掉（链接当场失效），但「那一轮被打开过几次」是发生过的事。
// 这里只留 token 的哈希前缀、开始与停用时间；记录键打不开链接，却能和打开记录对上。
function normalizeShareHistory(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      key: /^[0-9a-f]{16}$/.test(String(entry.key || '')) ? String(entry.key) : '',
      createdAt: String(entry.createdAt || ''),
      closedAt: String(entry.closedAt || ''),
    }))
    .filter((entry) => entry.key)
    .slice(0, MAX_SHARE_HISTORY)
}

// 交付记录：{ version, at }。老记录没有时间就写空串——照样是「这一版交过」，只是不知道什么时候。
function normalizeDeliveries(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({ version: Math.max(0, Math.round(Number(entry.version) || 0)), at: String(entry.at || '') }))
    .filter((entry) => entry.version > 0)
    .slice(-MAX_DELIVERIES)
}

/** 把当前这一轮分享归档进历史（停用、或换新 token 时调用），返回是否真的归档了。 */
function archiveShare(found, closedAt) {
  const key = visitKey(found.shareToken)
  if (!key) return false
  const history = normalizeShareHistory(found.shareHistory).filter((entry) => entry.key !== key)
  found.shareHistory = [{ key, createdAt: String(found.shareCreatedAt || ''), closedAt }, ...history].slice(0, MAX_SHARE_HISTORY)
  return true
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
    // 以前开过的链接：token 已清、地址打不开，只留哈希键与起止时间（打开记录按哈希键还对得上）
    shareHistory: normalizeShareHistory(item.shareHistory),
    status: STATUSES.includes(item.status) ? item.status : 'active',
    // 交付记录：标记交付时落一条；开新版不会把它清掉，旧版交过这件事仍然查得到
    deliveries: normalizeDeliveries(item.deliveries),
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
  const beforeStatus = found.status
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
  // 标记交付 = 记下「这一版交出去了」：版次与时间都落一条，之后开新版也不会覆盖；
  // 同一版重复标记只更新时间，不堆重复记录。
  if (patch.status === 'done') {
    const at = new Date().toISOString()
    const version = Math.max(1, Number(found.version) || 1)
    const rest = normalizeDeliveries(found.deliveries).filter((entry) => entry.version !== version)
    found.deliveries = [...rest, { version, at }].slice(-MAX_DELIVERIES)
    changed = true
  }
  // 重新打开 = 收回「这一版已交付」：撤掉当前这一版的交付记录，别的版本留着。
  // 交付是对某一版的宣布，撤销之后稿子与胶囊都回到「这一版还没交」，不留一条假记录。
  if (patch.status === 'active' && beforeStatus === 'done') {
    const version = Math.max(1, Number(found.version) || 1)
    const rest = normalizeDeliveries(found.deliveries).filter((entry) => entry.version !== version)
    if (rest.length !== normalizeDeliveries(found.deliveries).length) {
      found.deliveries = rest
      changed = true
    }
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
export async function archiveProjectVersion(id, { flowId = '', prevName = '', script = null } = {}, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const current = normalize(found)
  if (!current.flowId) return null
  const now = new Date().toISOString()
  found.versions = [
    ...current.versions,
    {
      n: current.version,
      flowId: current.flowId,
      name: clip(prevName || '上一版画布', 60),
      archivedAt: now,
      // 归档时把这一版的脚本一起存下来：之后改脚本也只影响新版本
      script: normalizeVersionScript(script) || undefined,
    },
  ].slice(-MAX_VERSIONS)
  // 开新版等于上一版收尾：标着交付的那一版先补一条交付记录（老记录没有时间就写空串），
  // 作品再放回「在做」——新版还没交，胶囊不能继续写着已交付。
  if (found.status === 'done') {
    const deliveries = normalizeDeliveries(found.deliveries)
    if (!deliveries.some((entry) => entry.version === current.version)) {
      deliveries.push({ version: current.version, at: '' })
    }
    found.deliveries = deliveries.slice(-MAX_DELIVERIES)
    found.status = 'active'
  }
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
  // 已经开着分享时又点了一次：先把上一轮归档，旧链接的打开记录不会跟着消失
  archiveShare(found, new Date().toISOString())
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
  archiveShare(found, new Date().toISOString())
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
