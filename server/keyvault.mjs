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

function publicKey(key) {
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
    cooling: isCooling(key),
  }
}

function safeDecrypt(value) {
  try {
    return decrypt(value)
  } catch {
    return ''
  }
}

function isCooling(key) {
  const entry = health.get(key.id)
  return Boolean(entry && entry.until > Date.now())
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
 * 选一把当前可用的 Key。
 * - capability：text / vision / image / video
 * - model：给了就优先匹配声明了该模型的 Key；声明了模型白名单但都不匹配时，只用「通用 Key」
 * 没有任何可用 Key 时返回 null，调用方回落环境变量。
 */
export function resolveKey({ capability = 'text', model = '' } = {}) {
  const candidates = load().keys.filter((key) => key.enabled && (key.capabilities || []).includes(capability))
  if (!candidates.length) return null
  const modelMatched = model
    ? candidates.filter((key) => !(key.models || []).length || key.models.includes(model))
    : candidates
  const pool = (modelMatched.length ? modelMatched : candidates.filter((key) => !(key.models || []).length))
    .filter((key) => !isCooling(key))
  if (!pool.length) return null
  const minPriority = Math.min(...pool.map((key) => key.priority))
  const group = pool.filter((key) => key.priority === minPriority)
  const picked = weightedPick(group)
  return {
    id: picked.id,
    name: picked.name,
    baseUrl: picked.baseUrl,
    apiKey: safeDecrypt(picked.apiKey),
    model: model || (picked.models || [])[0] || '',
  }
}

/** 调用结果回报：连续失败 3 次的 Key 冷却 60 秒，成功后立刻恢复。 */
export function reportKey(id, ok, error = '') {
  if (!id) return
  if (ok) {
    health.delete(id)
    return
  }
  const entry = health.get(id) || { fails: 0, until: 0 }
  entry.fails += 1
  entry.lastError = String(error || '').slice(0, 200)
  if (entry.fails >= 3) {
    entry.until = Date.now() + 60_000
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

export async function testKey(id) {
  const key = load().keys.find((item) => item.id === id)
  if (!key) throw Object.assign(new Error('Key 不存在'), { status: 404, code: 'KEY_NOT_FOUND' })
  const started = Date.now()
  const apiKey = safeDecrypt(key.apiKey)
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
    result = { ok: response.ok, status: response.status, ms: Date.now() - started, models, error: response.ok ? '' : text.slice(0, 200) }
  } catch (error) {
    result = { ok: false, status: 0, ms: Date.now() - started, models: [], error: String(error?.message || error).slice(0, 200) }
  }
  key.lastTest = { ...result, at: new Date().toISOString() }
  key.updatedAt = new Date().toISOString()
  persist()
  return { ...result, key: publicKey(key) }
}
