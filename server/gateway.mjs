// 平台生成通道：把画布的出图 / 出视频请求，按「能力 → 模型 → 优先级 → 权重」选一把
// 平台 Key 转发到上游；一把失败就换下一把（最多 3 把），单把 Key 坏掉不该让整次生成失败。
// 协议按火山方舟（Ark）的公开形态实现，因为画布的出图 / 出视频节点用的就是这一套；
// 其它兼容 /images/generations 的供应商也能直接接。
//
// 与聊天链路的三点区别：
// 1. 鉴权用平台服务令牌（Bearer），不走用户会话 —— 调用方是画布服务，不是浏览器；
// 2. 出图是一次同步请求；出视频是「建任务 + 轮询」，轮询必须回到建任务的那把 Key，
//    所以任务 id 与 Key 的对应关系记在进程内（重启后丢失，画布会重新发起）；
// 3. 生成结果原样回给调用方（拿到 url 就够），不落本地磁盘 —— 备份是画布自己的事。
import crypto from 'node:crypto'
import { config } from './config.mjs'
import { listKeys, recordRoute, reportKey, resolveKeyCandidates, vaultModels } from './keyvault.mjs'

const JOB_TTL_MS = 2 * 60 * 60 * 1000

// 画布出图节点会发过来的真实模型名（来源：画布源码里的 CHANNEL_MODEL 常量，2026-11-11 核对）。
// 后台拿它做「画布要的模型现在有没有人接」的对账，避免 Key 加上了却因为模型名对不上而用不了。
export const CANVAS_IMAGE_MODELS = [
  { model: 'doubao-seedream-4-5-251128', label: 'Seedream 4.5' },
  { model: 'doubao-seedream-5-0-pro-260628', label: 'Seedream 5.0 Pro' },
  { model: 'doubao-seedream-5-0-flash-260915', label: 'Seedream 5.0 Flash' },
]

/**
 * 画布要的每个出图模型，现在有没有 Key 接得住。
 * 「留空 = 通用」的 Key 也算接得住，但要标明是靠通用 Key 接的 —— 否则管理员会以为模型名已经填对了。
 */
export function modelCoverage() {
  const imageKeys = listKeys().items.filter((key) => key.enabled && (key.capabilities || []).includes('image'))
  return CANVAS_IMAGE_MODELS.map((entry) => {
    const exact = imageKeys.filter((key) => (key.models || []).includes(entry.model))
    const generic = imageKeys.filter((key) => (key.models || []).length === 0)
    const hit = exact.length ? exact : generic
    return {
      model: entry.model,
      label: entry.label,
      capability: 'image',
      ready: hit.length > 0,
      coveredBy: exact.length ? 'model' : generic.length ? 'generic' : 'none',
      keys: hit.map((key) => ({ id: key.id, name: key.name, priority: key.priority })),
    }
  })
}
const jobs = new Map()

function nowIso() {
  return new Date().toISOString()
}

function gatewayError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra })
}

export function gatewayConfigured() {
  return Boolean(config.gateway.token)
}

/** 常量时间比对，避免令牌长度 / 前缀差异被计时探测。 */
export function gatewayTokenMatches(value) {
  const expected = config.gateway.token
  if (!expected || !value) return false
  const left = Buffer.from(String(value))
  const right = Buffer.from(String(expected))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/** 从 Authorization: Bearer xxx 取令牌；没开通道时回 503，别让调用方以为是自己写错了。 */
export function authorizeGateway(req) {
  if (!gatewayConfigured()) {
    return { ok: false, status: 503, code: 'GATEWAY_NOT_CONFIGURED', error: '生成通道还没开启：平台还没配置服务令牌' }
  }
  const header = String(req.headers.authorization || '')
  const token = (header.match(/^Bearer\s+(.+)$/i) || [])[1] || ''
  if (!gatewayTokenMatches(token.trim())) {
    return { ok: false, status: 401, code: 'GATEWAY_UNAUTHORIZED', error: '生成通道令牌不正确' }
  }
  return { ok: true }
}

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
}

function extractUrls(data) {
  const items = Array.isArray(data?.data) ? data.data : []
  const urls = []
  for (const item of items) {
    if (item?.url) urls.push(String(item.url))
    else if (item?.b64_json) urls.push('data:image/png;base64,' + String(item.b64_json))
  }
  if (!urls.length && data?.url) urls.push(String(data.url))
  return urls
}

function friendlyUpstream(status, text) {
  const suffix = status ? '（HTTP ' + status + '）' : ''
  const body = String(text || '')
  if (/insufficient|quota|balance|余额|额度/i.test(body)) return '上游额度不足' + suffix
  if (/invalid.*key|unauthorized|forbidden|401|403/i.test(body)) return '上游凭证无效' + suffix
  if (/rate.?limit|429/i.test(body)) return '上游限流' + suffix
  if (status >= 500) return '上游暂不可用' + suffix
  return '上游拒绝了这次生成' + suffix
}

/** fetch 抛出来的东西（fetch failed / ETIMEDOUT…）对管理员没信息量，翻成人话。 */
function friendlyNetwork(error) {
  const raw = String(error?.message || error || '')
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up/i.test(raw)) {
    return '网络不通或地址填错了'
  }
  if (error?.name === 'TimeoutError' || /timeout|timed out/i.test(raw)) return '上游超时'
  return raw.slice(0, 120)
}

async function postJson(url, apiKey, body, timeoutMs) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  return { response, text }
}

async function getJson(url, apiKey, timeoutMs) {
  const response = await fetch(url, {
    headers: { Authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  return { response, text }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const MAX_ATTEMPTS = 3

/**
 * 池里挑不出 Key 时的说法。要分得清两种情况：
 * 「一把都没有」和「有 Key，但没一把声明了这个模型」—— 后者才是接 Key 时最常见的坑
 * （画布发的是方舟真实模型名，管理员照着产品名填就匹配不上），
 * 所以给用户看的还是人话，具体模型名只写进后台路由日志。
 */
function missingKeyError(capability, model) {
  const label = capability === 'image' ? '出图' : '出视频'
  const known = vaultModels(capability)
  const mismatch = Boolean(model) && known.length > 0 && !known.includes(model)
  return gatewayError(
    503,
    capability === 'image' ? 'NO_IMAGE_KEY' : 'NO_VIDEO_KEY',
    mismatch
      ? '平台还没接入能出这个效果的模型，请联系管理员补一把' + label + ' Key'
      : '平台还没接入' + label + '模型，请联系管理员补一把' + label + ' Key',
    {
      detail: mismatch
        ? '池里没有声明模型 ' + model + ' 的' + label + ' Key；现有 Key 声明的模型：' + known.slice(0, 5).join(' / ')
        : '池里没有可用的' + label + ' Key',
    },
  )
}

/** 把「试了哪几把、最后一把为什么失败」讲成人话，后台与调用方都看得懂。 */
function failoverMessage(action, candidates, lastError) {
  const reason = lastError?.message || '上游拒绝了这次请求'
  return candidates.length > 1
    ? action + '失败：连续试了 ' + candidates.length + ' 把 Key 都没成，最后一把说 ' + reason
    : action + '失败：' + reason
}

/**
 * 一次出图尝试：选中的那把 Key 把请求原样转发到 {baseUrl}/images/generations。
 * 成功返回上游 data（画布按 data[].url 取图）。每次尝试都单独记一条路由，
 * 后台才看得出「第 1 把挂了、第 2 把接上」，而不是只留一条含糊的失败。
 */
async function attemptImage(key, requestBody, started, model) {
  let upstream
  try {
    upstream = await postJson(trimBase(key.baseUrl) + '/images/generations', key.apiKey, requestBody, config.gateway.imageTimeoutMs)
  } catch (error) {
    reportKey(key.id, false, String(error?.message || error))
    recordRoute({ capability: 'image', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: String(error?.message || error) })
    throw gatewayError(502, 'UPSTREAM_UNREACHABLE', '连不上出图上游：' + friendlyNetwork(error))
  }
  if (!upstream.response.ok) {
    const message = friendlyUpstream(upstream.response.status, upstream.text)
    reportKey(key.id, false, 'HTTP ' + upstream.response.status + ' ' + upstream.text.slice(0, 160))
    recordRoute({ capability: 'image', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: 'HTTP ' + upstream.response.status + ' ' + upstream.text.slice(0, 160) })
    throw gatewayError(502, 'UPSTREAM_REJECTED', message, { upstreamStatus: upstream.response.status, detail: upstream.text.slice(0, 300) })
  }
  const data = parseJson(upstream.text)
  if (!data) {
    reportKey(key.id, false, '上游返回的不是 JSON')
    recordRoute({ capability: 'image', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: '上游返回的不是 JSON' })
    throw gatewayError(502, 'UPSTREAM_BAD_PAYLOAD', '出图上游返回的内容无法解析')
  }
  const urls = extractUrls(data)
  if (!urls.length) {
    reportKey(key.id, false, '上游没有返回图片地址')
    recordRoute({ capability: 'image', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: '上游没有返回图片地址' })
    throw gatewayError(502, 'UPSTREAM_EMPTY', '出图上游没有返回图片地址')
  }
  reportKey(key.id, true)
  recordRoute({ capability: 'image', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: true })
  // 上游响应原样给调用方：画布就是按方舟的 { data: [{ url }] } 取图的，
  // 包一层 { data: {...} } 会让它「成功但 0 张图」。平台自己的元信息放在同级字段里。
  return { ...data, ok: true, urls, key: { id: key.id, name: key.name }, attempt: key.attempt, ms: Date.now() - started }
}

/**
 * 出图：按「优先级 → 权重」排出一串出图 Key，一把失败就换下一把（最多 3 把）。
 * 单把 Key 坏掉不该让整次生成失败，这就是「故障回退」。
 */
export async function generateImage(payload = {}) {
  const started = Date.now()
  const model = String(payload.model || '')
  const candidates = resolveKeyCandidates({ capability: 'image', model, limit: MAX_ATTEMPTS })
  if (!candidates.length) {
    const error = missingKeyError('image', model)
    recordRoute({ capability: 'image', model, source: 'none', reason: '池里没有可用的出图 Key', ms: Date.now() - started, ok: false, error: error.detail })
    throw error
  }
  let lastError = null
  for (const key of candidates) {
    const requestBody = { ...payload, model: payload.model || key.model }
    try {
      return await attemptImage(key, requestBody, started, model)
    } catch (error) {
      lastError = error
    }
  }
  throw gatewayError(lastError?.status || 502, lastError?.code || 'UPSTREAM_REJECTED', failoverMessage('出图', candidates, lastError), {
    ...(lastError?.upstreamStatus ? { upstreamStatus: lastError.upstreamStatus } : {}),
    ...(lastError?.detail ? { detail: lastError.detail } : {}),
    attempts: candidates.length,
  })
}

function pruneJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.at > JOB_TTL_MS) jobs.delete(id)
  }
}

/** 一次建视频任务的尝试：成功返回上游 body 与任务 id，失败抛 gatewayError 并单独记一条路由。 */
async function attemptVideoCreate(key, requestBody, started, model) {
  let upstream
  try {
    upstream = await postJson(trimBase(key.baseUrl) + '/contents/generations/tasks', key.apiKey, requestBody, config.gateway.videoTimeoutMs)
  } catch (error) {
    reportKey(key.id, false, String(error?.message || error))
    recordRoute({ capability: 'video', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: String(error?.message || error) })
    throw gatewayError(502, 'UPSTREAM_UNREACHABLE', '连不上出视频上游：' + friendlyNetwork(error))
  }
  if (!upstream.response.ok) {
    const message = friendlyUpstream(upstream.response.status, upstream.text)
    reportKey(key.id, false, 'HTTP ' + upstream.response.status + ' ' + upstream.text.slice(0, 160))
    recordRoute({ capability: 'video', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: 'HTTP ' + upstream.response.status + ' ' + upstream.text.slice(0, 160) })
    throw gatewayError(502, 'UPSTREAM_REJECTED', message, { upstreamStatus: upstream.response.status, detail: upstream.text.slice(0, 300) })
  }
  const data = parseJson(upstream.text)
  const taskId = String(data?.id || data?.task_id || '')
  if (!taskId) {
    reportKey(key.id, false, '上游没有返回任务 id')
    recordRoute({ capability: 'video', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: '上游没有返回任务 id' })
    throw gatewayError(502, 'UPSTREAM_EMPTY', '出视频上游没有返回任务 id')
  }
  reportKey(key.id, true)
  recordRoute({ capability: 'video', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: true })
  return { data, taskId }
}

/**
 * 出视频第一步：建任务。
 * 与出图一样支持换把重试；建成功后把「任务 id → 这把 Key」记下来，
 * 轮询必须回到同一把 Key —— 任务在上游是挂在某把 Key 的账号下的。
 */
export async function createVideoTask(payload = {}) {
  pruneJobs()
  const started = Date.now()
  const model = String(payload.model || '')
  const candidates = resolveKeyCandidates({ capability: 'video', model, limit: MAX_ATTEMPTS })
  if (!candidates.length) {
    const error = missingKeyError('video', model)
    recordRoute({ capability: 'video', model, source: 'none', reason: '池里没有可用的出视频 Key', ms: Date.now() - started, ok: false, error: error.detail })
    throw error
  }
  let lastError = null
  for (const key of candidates) {
    const requestBody = { ...payload, model: payload.model || key.model }
    let created
    try {
      created = await attemptVideoCreate(key, requestBody, started, model)
    } catch (error) {
      lastError = error
      continue
    }
    const createdAt = Date.now()
    jobs.set(created.taskId, { keyId: key.id, keyName: key.name, baseUrl: key.baseUrl, apiKey: key.apiKey, model: requestBody.model, createdAt, at: createdAt, recorded: false })
    return { ...(created.data && typeof created.data === 'object' ? created.data : {}), ok: true, id: created.taskId, key: { id: key.id, name: key.name }, attempt: key.attempt, ms: Date.now() - started }
  }
  throw gatewayError(lastError?.status || 502, lastError?.code || 'UPSTREAM_REJECTED', failoverMessage('出视频', candidates, lastError), {
    ...(lastError?.upstreamStatus ? { upstreamStatus: lastError.upstreamStatus } : {}),
    ...(lastError?.detail ? { detail: lastError.detail } : {}),
    attempts: candidates.length,
  })
}

/**
 * 出视频第二步：轮询任务。
 * 只在对账到终态（成功 / 失败）时再记一条路由，否则每 5 秒一次轮询会把日志刷满。
 */
export async function pollVideoTask(taskId) {
  pruneJobs()
  const id = String(taskId || '')
  const job = jobs.get(id)
  if (!job) {
    throw gatewayError(404, 'TASK_NOT_FOUND', '找不到这个视频任务：服务重启后需要重新发起生成')
  }
  let upstream
  try {
    upstream = await getJson(trimBase(job.baseUrl) + '/contents/generations/tasks/' + encodeURIComponent(id), job.apiKey, config.gateway.videoTimeoutMs)
  } catch (error) {
    reportKey(job.keyId, false, String(error?.message || error))
    throw gatewayError(502, 'UPSTREAM_UNREACHABLE', '连不上出视频上游：' + friendlyNetwork(error))
  }
  if (!upstream.response.ok) {
    const message = friendlyUpstream(upstream.response.status, upstream.text)
    reportKey(job.keyId, false, 'HTTP ' + upstream.response.status + ' ' + upstream.text.slice(0, 160))
    throw gatewayError(502, 'UPSTREAM_REJECTED', message, { upstreamStatus: upstream.response.status })
  }
  const data = parseJson(upstream.text) || {}
  const status = String(data.status || '').toLowerCase()
  if (status === 'succeeded' || status === 'failed') {
    if (!job.recorded) {
      job.recorded = true
      job.at = Date.now()
      recordRoute({
        capability: 'video',
        model: job.model,
        keyId: job.keyId,
        keyName: job.keyName,
        source: 'pool',
        reason: '任务完成回执',
        ms: Date.now() - job.createdAt,
        ok: status === 'succeeded',
        error: status === 'failed' ? String(data?.error?.message || '上游报告任务失败').slice(0, 160) : '',
      })
    }
  }
  return { ...data, ok: true, status, key: { id: job.keyId, name: job.keyName } }
}

/** 后台「生成通道」页读的运行时状态：只回计数与任务摘要，不回令牌与上游 Key。 */
export function gatewayStatus() {
  pruneJobs()
  const items = [...jobs.entries()]
    .map(([id, job]) => ({ id, keyName: job.keyName, model: job.model, ageSec: Math.round((Date.now() - job.at) / 1000) }))
    .sort((a, b) => a.ageSec - b.ageSec)
    .slice(0, 10)
  return {
    configured: gatewayConfigured(),
    activeTasks: jobs.size,
    recentTasks: items,
    endpoints: {
      images: 'POST /api/gateway/v1/images/generations',
      videoCreate: 'POST /api/gateway/v1/videos/generations',
      videoPoll: 'GET /api/gateway/v1/videos/generations/<id>',
    },
    baseUrl: trimBase(config.gateway.publicBaseUrl) + '/api/gateway/v1',
    checkedAt: nowIso(),
  }
}

export function resetGatewayJobs() {
  jobs.clear()
}
