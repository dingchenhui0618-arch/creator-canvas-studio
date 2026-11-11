// 平台模型 Key 池：管理员在后台随时增删改，改完立即生效，不需要重启进程。
//
// 设计要点：
// 1. Key 加密落盘（AES-256-GCM），密钥来自 VQ_KEY_SECRET 或数据目录里的随机 secret 文件；
//    列表接口只回脱敏值，任何日志与前端都拿不到明文。
// 2. 每把 Key 声明能力（text / vision / image / video）、可选模型白名单、优先级与权重，
//    调用时按「能力 → 模型匹配 → 优先级 → 权重」选一把；连续失败的 Key 冷却 60 秒。
// 3. 池里没有可用 Key 时调用方回落到环境变量里的旧凭证，保证升级不打断现有功能。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { setVaultCounts, vaultCounts } from './vault-state.mjs'

const CAPABILITIES = ['text', 'vision', 'image', 'video']
const CAPABILITY_ALIASES = {
  chat: 'text',
  llm: 'text',
  multimodal: 'vision',
  image2: 'image',
  video2: 'video',
}

// 后台表单的供应商预设：只用来带出 baseUrl，真实请求仍以管理员的输入为准。
export const PROVIDER_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'bailian', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'volcengine', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'custom', label: '自定义 / 中转', baseUrl: '' },
]

const keysFile = () => path.join(config.dataDir, 'model-keys.json')
const secretFile = () => path.join(config.dataDir, '.model-keys.secret')

let cachedSecret = ''

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest()
}

function secret() {
  if (cachedSecret) return cachedSecret
  const fromEnv = String(process.env.VQ_KEY_SECRET || '').trim()
  if (fromEnv) {
    cachedSecret = sha256(fromEnv).toString('hex')
    return cachedSecret
  }
  try {
    const stored = fs.readFileSync(secretFile(), 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(stored)) {
      cachedSecret = stored
      return cachedSecret
    }
  } catch {
    // 第一次启动：下面生成
  }
  cachedSecret = crypto.randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    fs.writeFileSync(secretFile(), cachedSecret, { mode: 0o600 })
  } catch (error) {
    console.error('[keys] 无法写入 secret 文件，本次重启后已存 Key 将无法解密：' + String(error?.message || error))
  }
  return cachedSecret
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(secret(), 'hex'), iv)
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['enc', 'v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':')
}

function decrypt(payload) {
  const parts = String(payload || '').split(':')
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') throw new Error('Key 密文格式不正确')
  const iv = Buffer.from(parts[2], 'base64')
  const tag = Buffer.from(parts[3], 'base64')
  const data = Buffer.from(parts[4], 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(secret(), 'hex'), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

function maskKey(plain) {
  const value = String(plain || '')
  if (value.length <= 8) return '••••'
  return value.slice(0, 4) + '••••' + value.slice(-4)
}

let state = null
const health = new Map()

function load() {
  if (state) return state
  try {
    const parsed = JSON.parse(fs.readFileSync(keysFile(), 'utf8'))
    state = { version: 1, keys: Array.isArray(parsed?.keys) ? parsed.keys : [] }
  } catch {
    state = { version: 1, keys: [] }
  }
  refreshCounts()
  return state
}

function refreshCounts() {
  const counts = { text: 0, vision: 0, image: 0, video: 0 }
  for (const key of load().keys) {
    if (!key.enabled) continue
    for (const capability of key.capabilities || []) {
      if (capability in counts) counts[capability] += 1
    }
  }
  setVaultCounts(counts)
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true })
  const tmp = keysFile() + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, keysFile())
  refreshCounts()
}

function usageOf(key) {
  const entry = health.get(key.id) || {}
  const cooldownSec = entry.until > Date.now() ? Math.ceil((entry.until - Date.now()) / 1000) : 0
  return {
    ok: entry.ok || 0,
    fail: entry.fail || 0,
    lastError: entry.lastError || '',
    lastErrorAt: entry.lastErrorAt || '',
    lastUsedAt: entry.lastUsedAt || '',
    cooldownSec,
  }
}

function publicKey(key) {
  const usage = usageOf(key)
  return {
    id: key.id,
    name: key.name,
    provider: key.provider,
    baseUrl: key.baseUrl,
    models: key.models || [],
    capabilities: key.capabilities || [],
    priority: key.priority,
    weight: key.weight,
    enabled: Boolean(key.enabled),
    masked: key.masked || (key.apiKey ? maskKey(safeDecrypt(key.apiKey)) : ''),
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
    lastTest: key.lastTest || null,
    cooling: usage.cooldownSec > 0,
    usage,
  }
}

function safeDecrypt(value) {
  try {
    return decrypt(value)
  } catch {
    return ''
  }
}

function normalizeCapabilities(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,，\s]+/)
  const result = []
  for (const item of raw) {
    const normalized = CAPABILITY_ALIASES[String(item).trim().toLowerCase()] || String(item).trim().toLowerCase()
    if (CAPABILITIES.includes(normalized) && !result.includes(normalized)) result.push(normalized)
  }
  return result.length ? result : ['text']
}

function normalizeModels(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,，\n]+/)
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))].slice(0, 30)
}

function normalizeBaseUrl(input) {
  const value = String(input || '').trim().replace(/\/+$/, '')
  if (!value) throw Object.assign(new Error('请填写接口地址（baseUrl）'), { status: 400, code: 'BAD_BASE_URL' })
  let url
  try {
    url = new URL(value)
  } catch {
    throw Object.assign(new Error('接口地址不是合法 URL'), { status: 400, code: 'BAD_BASE_URL' })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Object.assign(new Error('接口地址只支持 http/https'), { status: 400, code: 'BAD_BASE_URL' })
  }
  return value
}

function normalizePriority(input, fallback = 100) {
  const value = Number(input)
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(999, Math.round(value)))
}

function normalizeWeight(input, fallback = 100) {
  const value = Number(input)
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(1000, Math.round(value)))
}

export function listKeys() {
  const data = load()
  const items = data.keys.map(publicKey)
  return {
    items,
    summary: {
      total: items.length,
      enabled: items.filter((item) => item.enabled).length,
      cooling: items.filter((item) => item.cooling).length,
      usage: items.reduce(
        (sum, item) => ({ ok: sum.ok + item.usage.ok, fail: sum.fail + item.usage.fail }),
        { ok: 0, fail: 0 },
      ),
      counts: vaultCounts(),
    },
  }
}

export function createKey(input = {}) {
  const name = String(input.name || '').trim().slice(0, 40)
  if (!name) throw Object.assign(new Error('请填写 Key 名称'), { status: 400, code: 'BAD_NAME' })
  const provider = String(input.provider || 'custom').trim().slice(0, 30) || 'custom'
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const apiKey = String(input.apiKey || '').trim()
  if (apiKey.length < 8) throw Object.assign(new Error('API Key 太短，请粘贴完整 Key'), { status: 400, code: 'BAD_KEY' })
  const now = new Date().toISOString()
  const key = {
    id: 'k_' + crypto.randomBytes(6).toString('hex'),
    name,
    provider,
    baseUrl,
    apiKey: encrypt(apiKey),
    masked: maskKey(apiKey),
    models: normalizeModels(input.models),
    capabilities: normalizeCapabilities(input.capabilities),
    priority: normalizePriority(input.priority),
    weight: normalizeWeight(input.weight),
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    createdAt: now,
    updatedAt: now,
    lastTest: null,
  }
  load().keys.push(key)
  persist()
  return publicKey(key)
}

export function updateKey(id, patch = {}) {
  const key = load().keys.find((item) => item.id === id)
  if (!key) throw Object.assign(new Error('Key 不存在'), { status: 404, code: 'KEY_NOT_FOUND' })
  if (patch.name !== undefined) {
    const name = String(patch.name).trim().slice(0, 40)
    if (!name) throw Object.assign(new Error('请填写 Key 名称'), { status: 400, code: 'BAD_NAME' })
    key.name = name
  }
  if (patch.provider !== undefined) key.provider = String(patch.provider).trim().slice(0, 30) || 'custom'
  if (patch.baseUrl !== undefined) key.baseUrl = normalizeBaseUrl(patch.baseUrl)
  if (patch.apiKey !== undefined && String(patch.apiKey).trim()) {
    const apiKey = String(patch.apiKey).trim()
    if (apiKey.length < 8) throw Object.assign(new Error('API Key 太短，请粘贴完整 Key'), { status: 400, code: 'BAD_KEY' })
    key.apiKey = encrypt(apiKey)
    key.masked = maskKey(apiKey)
  }
  if (patch.models !== undefined) key.models = normalizeModels(patch.models)
  if (patch.capabilities !== undefined) key.capabilities = normalizeCapabilities(patch.capabilities)
  if (patch.priority !== undefined) key.priority = normalizePriority(patch.priority)
  if (patch.weight !== undefined) key.weight = normalizeWeight(patch.weight)
  if (patch.enabled !== undefined) key.enabled = Boolean(patch.enabled)
  key.updatedAt = new Date().toISOString()
  persist()
  return publicKey(key)
}

export function deleteKey(id) {
  const data = load()
  const index = data.keys.findIndex((item) => item.id === id)
  if (index < 0) throw Object.assign(new Error('Key 不存在'), { status: 404, code: 'KEY_NOT_FOUND' })
  const [removed] = data.keys.splice(index, 1)
  health.delete(id)
  persist()
  return publicKey(removed)
}

function weightedPick(items) {
  const total = items.reduce((sum, item) => sum + Math.max(1, item.weight || 1), 0)
  let ticket = Math.random() * total
  for (const item of items) {
    ticket -= Math.max(1, item.weight || 1)
    if (ticket <= 0) return item
  }
  return items[items.length - 1]
}

/**
 * 路由解释：把「为什么是这把 Key」拆成每把 Key 的状态，后台预演和排障都用它。
 * 真实调用（resolveKey）与预演（previewRoute）共用这一套判定，
 * 不允许出现「后台说走 A、实际走了 B」。
 */
export function planRoute({ capability = 'text', model = '' } = {}) {
  const rows = load().keys.map((key) => {
    const caps = key.capabilities || []
    const models = key.models || []
    const entry = health.get(key.id) || {}
    const coolingSec = entry.until > Date.now() ? Math.ceil((entry.until - Date.now()) / 1000) : 0
    let state = 'eligible'
    let reason = '可选'
    if (!key.enabled) {
      state = 'disabled'
      reason = '已停用'
    } else if (!caps.includes(capability)) {
      state = 'capability'
      reason = '没有「' + capability + '」能力'
    } else if (model && models.length && !models.includes(model)) {
      state = 'model'
      reason = '模型白名单里没有 ' + model
    } else if (coolingSec > 0) {
      state = 'cooling'
      reason = '冷却中，还需 ' + coolingSec + ' 秒'
    }
    return {
      id: key.id,
      name: key.name,
      provider: key.provider,
      priority: key.priority,
      weight: key.weight,
      state,
      reason,
    }
  })
  const eligible = rows.filter((row) => row.state === 'eligible')
  const priority = eligible.length ? Math.min(...eligible.map((row) => row.priority)) : null
  const group = eligible.filter((row) => row.priority === priority)
  const total = group.reduce((sum, row) => sum + Math.max(1, row.weight || 1), 0)
  const groupWithShare = group.map((row) => ({
    ...row,
    share: total ? Math.round((Math.max(1, row.weight || 1) / total) * 1000) / 10 : 0,
  }))
  // 同能力但优先级排在后面的 Key，也要在后台说清「它不是坏了，是排在后面」。
  const keys = rows.map((row) =>
    row.state === 'eligible' && row.priority !== priority
      ? { ...row, reason: '优先级 P' + row.priority + ' 排在 P' + priority + ' 之后' }
      : row,
  )
  return { capability, model, keys, eligible, group: groupWithShare, priority }
}

/**
 * 选一把当前可用的 Key。
 * - capability：text / vision / image / video
 * - model：给了就优先匹配声明了该模型的 Key；声明了模型白名单但都不匹配时，只用「通用 Key」
 * 没有任何可用 Key 时返回 null，调用方回落环境变量。
 */
export function resolveKey({ capability = 'text', model = '' } = {}) {
  const plan = planRoute({ capability, model })
  if (!plan.group.length) return null
  const picked = weightedPick(plan.group)
  const key = load().keys.find((item) => item.id === picked.id)
  if (!key) return null
  return {
    id: key.id,
    name: key.name,
    baseUrl: key.baseUrl,
    apiKey: safeDecrypt(key.apiKey),
    model: model || (key.models || [])[0] || '',
    priority: key.priority,
    weight: key.weight,
    candidates: plan.group.length,
    reason:
      plan.group.length > 1
        ? '同为优先级 P' + key.priority + ' 的 ' + plan.group.length + ' 把按权重随机（这把约 ' + picked.share + '%）'
        : '优先级 P' + key.priority + ' 里唯一可用的一把',
  }
}

/**
 * 故障回退：给出一串「按顺序去试」的 Key，第一把失败就换下一把。
 * 与 resolveKey 的区别：resolveKey 只回答「首选是谁」，这里把后备的也排出来，
 * 出图 / 建视频这类一次请求失败后还能换把重试的场景用它。
 * 排序规则与 planRoute 完全一致：优先级小的先试，同优先级按权重随机（不放回）。
 */
export function resolveKeyCandidates({ capability = 'text', model = '', limit = 3 } = {}) {
  const plan = planRoute({ capability, model })
  const cap = Math.max(1, Math.min(5, Number(limit) || 3))
  const eligible = plan.keys.filter((row) => row.state === 'eligible')
  const ordered = []
  const priorities = [...new Set(eligible.map((row) => row.priority))].sort((a, b) => a - b)
  for (const priority of priorities) {
    const pool = eligible.filter((row) => row.priority === priority)
    while (pool.length && ordered.length < cap) {
      const total = pool.reduce((sum, row) => sum + Math.max(1, row.weight || 1), 0)
      let ticket = Math.random() * total
      let index = 0
      for (; index < pool.length; index += 1) {
        ticket -= Math.max(1, pool[index].weight || 1)
        if (ticket <= 0) break
      }
      if (index >= pool.length) index = pool.length - 1
      ordered.push(pool.splice(index, 1)[0])
    }
    if (ordered.length >= cap) break
  }
  return ordered.map((row, index) => {
    const key = load().keys.find((item) => item.id === row.id)
    return {
      id: key.id,
      name: key.name,
      provider: key.provider,
      baseUrl: key.baseUrl,
      apiKey: safeDecrypt(key.apiKey),
      model: model || (key.models || [])[0] || '',
      priority: key.priority,
      weight: key.weight,
      attempt: index + 1,
      candidates: ordered.length,
      reason:
        ordered.length > 1
          ? '第 ' + (index + 1) + ' 把（' + (index === 0 ? '首选' : '失败后回退') + '，共 ' + ordered.length + ' 把候选）'
          : '唯一可用的一把',
    }
  })
}

/** 后台「预演」：现在调一次会不会有可用 Key、会落在哪一组，说明为什么不选别人。 */
export function previewRoute({ capability = 'text', model = '' } = {}) {
  const plan = planRoute({ capability, model })
  let description
  if (!plan.group.length) {
    description = '池里没有可用 Key：这次调用会回落到环境变量里的旧凭证；环境变量也没配就会直接报「未配置模型凭证」。'
  } else if (plan.group.length === 1) {
    description = '现在调用会用「' + plan.group[0].name + '」（优先级 P' + plan.group[0].priority + '）。'
  } else {
    description =
      '现在调用会从 ' + plan.group.length + ' 把里按权重随机选一把：' +
      plan.group.map((item) => item.name + ' ' + item.share + '%').join(' · ') +
      '。它们优先级同为 P' + plan.group[0].priority + '，权重只影响选中概率。'
  }
  return {
    ...plan,
    chosen: plan.group.length === 1 ? plan.group[0] : null,
    description,
  }
}

// ── 路由决策日志（内存环形缓冲，最近 200 次）────────────────────
// 后台要能回答「刚才那次调用到底走了哪把 Key、为什么、花多久、成没成」。
// 只记脱敏信息：Key id / 名称 / 来源，绝不记 Key 明文与请求正文。
const ROUTE_LIMIT = 200
const routes = []
let routeSeq = 0

// 路由日志里给管理员看的是人话，不是一段上游 JSON；原始报错留在 detail 里供悬停查看。
function friendlyError(raw) {
  const text = String(raw || '').slice(0, 200)
  const status = (text.match(/^HTTP (\d{3})/) || [])[1] || ''
  const suffix = status ? '（HTTP ' + status + '）' : ''
  if (/insufficient[_ ]?balance|insufficient_quota|余额不足/i.test(text)) return { error: '额度不足' + suffix, detail: text }
  if (/invalid[_ ]?api[_ ]?key|unauthorized|凭证|401|403/i.test(text)) return { error: '凭证无效' + suffix, detail: text }
  if (/rate.?limit|too many requests|429/i.test(text)) return { error: '上游限流' + suffix, detail: text }
  if (/finish_reason=length|截断/.test(text)) return { error: '输出被截断', detail: text }
  if (/^HTTP 5\d\d|overload|busy|timeout|aborted|fetch failed|ECONN/i.test(text)) return { error: '上游暂不可用' + suffix, detail: text }
  return { error: text, detail: '' }
}

export function recordRoute(input = {}) {
  const source = input.source === 'pool' ? 'pool' : input.source === 'env' ? 'env' : 'none'
  const friendly = friendlyError(input.error)
  const entry = {
    id: 'r' + String(++routeSeq),
    at: new Date().toISOString(),
    capability: String(input.capability || 'text'),
    model: String(input.model || ''),
    keyId: source === 'pool' ? String(input.keyId || '') : '',
    keyName: String(input.keyName || '').slice(0, 40),
    source,
    reason: String(input.reason || '').slice(0, 160),
    attempt: Number(input.attempt) || 1,
    ms: Math.max(0, Math.round(Number(input.ms) || 0)),
    ok: Boolean(input.ok),
    error: friendly.error,
    detail: friendly.detail,
  }
  routes.unshift(entry)
  if (routes.length > ROUTE_LIMIT) routes.length = ROUTE_LIMIT
  return entry
}

export function listRoutes(limit = 50) {
  const size = Math.max(1, Math.min(ROUTE_LIMIT, Number(limit) || 50))
  let ok = 0
  let fail = 0
  let msSum = 0
  let env = 0
  let none = 0
  const buckets = new Map()
  for (const item of routes) {
    if (item.ok) ok += 1
    else fail += 1
    msSum += item.ms
    if (item.source === 'env') env += 1
    if (item.source === 'none') none += 1
    const bucketKey = item.source === 'pool' ? item.keyId : item.source
    const bucket = buckets.get(bucketKey) || {
      keyId: item.keyId,
      keyName: item.keyName || (item.source === 'env' ? '环境变量旧凭证' : '没有可用 Key'),
      ok: 0,
      fail: 0,
      ms: 0,
      count: 0,
    }
    if (item.ok) bucket.ok += 1
    else bucket.fail += 1
    bucket.ms += item.ms
    bucket.count += 1
    buckets.set(bucketKey, bucket)
  }
  // 换 Key 成功：这次调用第一把失败、后面某把成功了 —— 后台用它证明「回退真的生效」。
  const failover = routes.filter((item) => item.ok && Number(item.attempt) > 1).length
  return {
    items: routes.slice(0, size),
    summary: {
      total: routes.length,
      ok,
      fail,
      env,
      none,
      failover,
      avgMs: routes.length ? Math.round(msSum / routes.length) : 0,
      lastAt: routes[0]?.at || '',
      byKey: [...buckets.values()]
        .map((bucket) => ({ ...bucket, avgMs: Math.round(bucket.ms / Math.max(1, bucket.count)) }))
        .sort((a, b) => b.count - a.count),
    },
  }
}

/** 调用结果回报：连续失败 3 次的 Key 冷却 60 秒，成功后立刻恢复。 */
export function reportKey(id, ok, error = '') {
  if (!id) return
  const now = Date.now()
  const entry = health.get(id) || { fails: 0, until: 0, ok: 0, fail: 0 }
  entry.lastUsedAt = new Date(now).toISOString()
  if (ok) {
    entry.ok = (entry.ok || 0) + 1
    entry.fails = 0
    entry.until = 0
    health.set(id, entry)
    return
  }
  entry.fail = (entry.fail || 0) + 1
  entry.fails += 1
  entry.lastError = String(error || '').slice(0, 200)
  entry.lastErrorAt = new Date(now).toISOString()
  if (entry.fails >= 3) {
    entry.until = now + 60_000
    entry.fails = 0
  }
  health.set(id, entry)
}

export function vaultModels(capability) {
  const models = []
  for (const key of load().keys) {
    if (!key.enabled) continue
    if (!(key.capabilities || []).includes(capability)) continue
    for (const model of key.models || []) if (!models.includes(model)) models.push(model)
  }
  return models
}

// 进程启动时就把能力快照打出来：否则重启后 visionEnabled() 会误判「没配模型」，
// 直到有人第一次打开后台或发起模型调用才恢复。
load()

/**
 * 后台「测试」：能真实调用的能力就打一次真实请求（max_tokens=1），
 * 不能安全真实调用的能力（出图 / 视频会产生费用）只探测凭证，并在结果里写明 mode，
 * 不让「/models 返回 200」冒充「模型可用」。
 */
export async function testKey(id) {
  const key = load().keys.find((item) => item.id === id)
  if (!key) throw Object.assign(new Error('Key 不存在'), { status: 404, code: 'KEY_NOT_FOUND' })
  const started = Date.now()
  const apiKey = safeDecrypt(key.apiKey)
  const capabilities = key.capabilities || []
  const declaredModel = (key.models || [])[0] || ''
  const realCallable = capabilities.some((item) => item === 'text' || item === 'vision')
  const probeNote = realCallable && !declaredModel ? '这把 Key 没有声明模型，只验证了凭证' : '出图 / 视频会产生费用，这里只验证凭证'

  if (realCallable && declaredModel) {
    let result
    try {
      const response = await fetch(key.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: declaredModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      const text = await response.text()
      let choices = 0
      let reply = ''
      let upstreamError = ''
      try {
        const parsed = JSON.parse(text)
        choices = Array.isArray(parsed?.choices) ? parsed.choices.length : 0
        reply = String(parsed?.choices?.[0]?.message?.content || '')
        if (!choices && parsed?.error) upstreamError = String(parsed.error.message || parsed.error)
      } catch {
        upstreamError = text.slice(0, 200)
      }
      result = {
        ok: response.ok && choices > 0,
        mode: 'real-call',
        model: declaredModel,
        status: response.status,
        ms: Date.now() - started,
        models: [],
        reply: reply.slice(0, 40),
        error: response.ok && choices > 0 ? '' : upstreamError || text.slice(0, 200),
      }
    } catch (error) {
      result = {
        ok: false,
        mode: 'real-call',
        model: declaredModel,
        status: 0,
        ms: Date.now() - started,
        models: [],
        reply: '',
        error: String(error?.message || error).slice(0, 200),
      }
    }
    key.lastTest = { ...result, at: new Date().toISOString() }
    key.updatedAt = new Date().toISOString()
    persist()
    return { ...result, key: publicKey(key) }
  }

  let result
  try {
    const response = await fetch(key.baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: AbortSignal.timeout(8000),
    })
    const text = await response.text()
    let models = []
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed?.data)) models = parsed.data.map((item) => String(item?.id || '')).filter(Boolean).slice(0, 50)
    } catch {
      // 网关不一定回 JSON，保留状态码就够了
    }
    result = {
      ok: response.ok,
      mode: 'credential-probe',
      note: probeNote,
      model: '',
      status: response.status,
      ms: Date.now() - started,
      models,
      reply: '',
      error: response.ok ? '' : text.slice(0, 200),
    }
  } catch (error) {
    result = {
      ok: false,
      mode: 'credential-probe',
      note: probeNote,
      model: '',
      status: 0,
      ms: Date.now() - started,
      models: [],
      reply: '',
      error: String(error?.message || error).slice(0, 200),
    }
  }
  key.lastTest = { ...result, at: new Date().toISOString() }
  key.updatedAt = new Date().toISOString()
  persist()
  return { ...result, key: publicKey(key) }
}
