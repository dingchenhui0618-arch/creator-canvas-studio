// 平台生成通道：把画布的出图 / 出视频请求，按「能力 → 模型 → 优先级 → 权重」选一把
// 平台 Key 转发到上游；一把失败就换下一把（最多 3 把），单把 Key 坏掉不该让整次生成失败。
//
// 上游两种协议都接（2026-11-11 起），由 Key 的 baseUrl 自动判定，管理员贴地址时不用选协议：
//  - ark ：火山方舟 —— /images/generations、/contents/generations/tasks[/<id>]
//  - cgcm：SeeAPI —— /v1/images/generations[/async]、/v1/video/generations、/v1/tasks/<id>
// 画布的出图节点按方舟写法、出视频节点在 CGCM 渠道下按 SeeAPI 写法，两套都指向本通道。
//
// 与聊天链路的三点区别：
// 1. 鉴权用平台服务令牌（Bearer），不走用户会话 —— 调用方是画布服务，不是浏览器；
// 2. 出图是一次同步请求；出视频是「建任务 + 轮询」，轮询必须回到建任务的那把 Key，
//    所以任务 id 与 Key 的对应关系落盘（见 gateway-tasks.mjs）：发版重启后照样查得到结果，
//    不会让用户为同一段片子付两次钱；
// 3. 生成结果原样回给调用方（拿到 url 就够），不落本地磁盘 —— 备份是画布自己的事。
import crypto from 'node:crypto'
import { config } from './config.mjs'
import { countRunning, finishTask, getTask, listTasks, pruneTasks, rememberTask, resetTaskStore } from './gateway-tasks.mjs'
import { keyMaterial, listKeys, openSecret, recordRoute, reportKey, resolveKeyCandidates, sealSecret, vaultModels } from './keyvault.mjs'

// 画布出图节点会发过来的真实模型名（来源：画布源码里的 CHANNEL_MODEL 常量，2026-11-11 核对）。
// 后台拿它做「画布要的模型现在有没有人接」的对账，避免 Key 加上了却因为模型名对不上而用不了。
export const CANVAS_IMAGE_MODELS = [
  { model: 'doubao-seedream-4-5-251128', label: 'Seedream 4.5' },
  { model: 'doubao-seedream-5-0-pro-260628', label: 'Seedream 5.0 Pro' },
  { model: 'doubao-seedream-5-0-flash-260915', label: 'Seedream 5.0 Flash' },
]

// 画布按方舟的真实模型名发请求，SeeAPI 用的却是自己的叫法；同一款模型两个名字，
// 这里把「画布名 → SeeAPI 名」对上，既不用改画布，也不用让管理员两边各填一遍。
export const MODEL_ALIASES = {
  'doubao-seedream-5-0-pro-260628': 'seedream-5.0-pro',
}

function aliasOf(model) {
  return MODEL_ALIASES[String(model || '')] || ''
}

/** 这次请求可以接受的模型名：原名 + 别名（别名排后面，优先用原名）。 */
function acceptedModels(model) {
  const alias = aliasOf(model)
  return model ? (alias ? [model, alias] : [model]) : []
}

// 画布出视频节点在 CGCM 渠道下会发过来的模型名
// （来源：画布 generation_seedance.py 的 CGCM_VIDEO_MODEL_MAP，2026-11-11 核对）。
export const CANVAS_VIDEO_MODELS = [
  { model: 'seedance-2.0', label: 'Seedance 2.0' },
  { model: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast' },
  { model: 'seedance-2.0-mini', label: 'Seedance 2.0 Mini' },
  { model: 'seedance-2.5', label: 'Seedance 2.5' },
  { model: 'minimax-h3', label: 'MiniMax H3' },
  { model: 'wan3.0-video', label: 'Wan 3.0' },
  { model: 'wan3.0-video-prime', label: 'Wan 3.0 Prime' },
  { model: 'happy-horse-1.1', label: 'Happy Horse 1.1' },
]

/**
 * 上游协议由 Key 的 baseUrl 判定：SeeAPI / CGCM 的域名走 `cgcm` 形态，其余按火山方舟。
 * 只认域名特征，不要求管理员多填一个「协议」字段 —— 少一个能填错的地方。
 */
export function keyProtocol(key) {
  return /cgcm|seeapi/i.test(String(key?.baseUrl || '')) ? 'cgcm' : 'ark'
}

/** CGCM 的 base 允许写成 …/ 或 …/v1，两种都归到同一层再拼路径。 */
function protocolBase(key) {
  const base = trimBase(key?.baseUrl)
  return keyProtocol(key) === 'cgcm' ? base.replace(/\/v1$/i, '') : base
}

/** 同一个逻辑动作在两种上游协议下的真实地址。 */
export function upstreamUrl(key, kind, id = '') {
  const base = protocolBase(key)
  const cgcm = keyProtocol(key) === 'cgcm'
  if (kind === 'image') return base + (cgcm ? '/v1/images/generations' : '/images/generations')
  if (kind === 'imageAsync') return base + '/v1/images/generations/async'
  if (kind === 'videoCreate') return base + (cgcm ? '/v1/video/generations' : '/contents/generations/tasks')
  if (kind === 'task') {
    const tail = 'tasks/' + encodeURIComponent(id)
    return base + (cgcm ? '/v1/' + tail : '/contents/generations/' + tail)
  }
  throw new Error('上游动作不认识：' + kind)
}

/**
 * 画布会发的每个模型，现在有没有 Key 接得住（出图 + 出视频）。
 * 「留空 = 通用」的 Key 也算接得住，但要标明是靠通用 Key 接的 —— 否则管理员会以为模型名已经填对了。
 */
function coverageRows(capability, keys, entries) {
  return entries.map((entry) => {
    const alias = aliasOf(entry.model)
    const exact = keys.filter((key) => (key.models || []).includes(entry.model) || (alias && (key.models || []).includes(alias)))
    const generic = keys.filter((key) => (key.models || []).length === 0)
    const hit = exact.length ? exact : generic
    const aliasOnly = alias && exact.length > 0 && !exact.some((key) => (key.models || []).includes(entry.model))
    return {
      model: entry.model,
      label: entry.label,
      capability,
      ready: hit.length > 0,
      coveredBy: exact.length ? 'model' : generic.length ? 'generic' : 'none',
      // 靠改名接上的，要在后台说清楚「按哪个名字发」，不然管理员以为模型名已经填对了
      upstream: aliasOnly ? alias : '',
      keys: hit.map((key) => ({ id: key.id, name: key.name, priority: key.priority })),
    }
  })
}

export function modelCoverage() {
  const enabled = listKeys().items.filter((key) => key.enabled)
  const withCap = (capability) => enabled.filter((key) => (key.capabilities || []).includes(capability))
  return [
    ...coverageRows('image', withCap('image'), CANVAS_IMAGE_MODELS),
    ...coverageRows('video', withCap('video'), CANVAS_VIDEO_MODELS),
  ]
}
function nowIso() {
  return new Date().toISOString()
}

function gatewayError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra })
}

export function gatewayConfigured() {
  return Boolean(config.gateway.token)
}

/**
 * 画布现在能不能生成：三样同时在位才算通——平台额度开关（VQ_GATEWAY_OPEN）、
 * 服务令牌（VQ_GATEWAY_TOKEN）、至少一把声明了出图 / 出视频能力的 Key。
 * 后台与画布共用这一个判断，别再各自猜「配置了就是开了」：2026-11-13 后台就因此
 * 把「令牌已配、额度没开」显示成「通道已开启」，画布点生成却回 503。
 */
export function gatewayReadiness({ open, configured, image, video } = {}) {
  const missing = []
  if (!open) missing.push('open')
  if (!configured) missing.push('token')
  if (!Number(image) && !Number(video)) missing.push('keys')
  return { ready: missing.length === 0, missing }
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

async function postJson(url, apiKey, body, timeoutMs, extraHeaders = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, ...extraHeaders },
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

/** 这把 Key 该用哪个名字发出去：SeeAPI 形态、且它声明的正是别名时换成上游叫法。 */
function upstreamModelFor(key, model) {
  const alias = aliasOf(model)
  if (alias && keyProtocol(key) === 'cgcm' && (key.models || []).includes(alias)) return alias
  return model || key.model
}

/**
 * 一次出图尝试：选中的那把 Key 把请求原样转发到 {baseUrl}/images/generations。
 * 成功返回上游 data（画布按 data[].url 取图）。每次尝试都单独记一条路由，
 * 后台才看得出「第 1 把挂了、第 2 把接上」，而不是只留一条含糊的失败。
 */
async function attemptImage(key, requestBody, started, model) {
  let upstream
  try {
    upstream = await postJson(upstreamUrl(key, 'image'), key.apiKey, requestBody, config.gateway.imageTimeoutMs)
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
  const candidates = resolveKeyCandidates({ capability: 'image', model, acceptModels: acceptedModels(model), limit: MAX_ATTEMPTS })
  if (!candidates.length) {
    const error = missingKeyError('image', model)
    recordRoute({ capability: 'image', model, source: 'none', reason: '池里没有可用的出图 Key', ms: Date.now() - started, ok: false, error: error.detail })
    throw error
  }
  let lastError = null
  for (const key of candidates) {
    const requestBody = { ...payload, model: upstreamModelFor(key, model) }
    // SeeAPI 同步出图默认回 base64（一张图几 MB），画布要的是地址，所以不指定时按 url 要
    if (keyProtocol(key) === 'cgcm' && !requestBody.response_format) requestBody.response_format = 'url'
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

// 任务台账的清理由 gateway-tasks.mjs 负责（跑着的 2 小时、终态留 24 小时）。
function pruneJobs() {
  pruneTasks()
}

/**
 * 一次「建任务」的尝试（出视频、SeeAPI 的异步出图都是这个形态）：
 * 成功返回上游 body 与任务 id，失败抛 gatewayError 并单独记一条路由。
 * 协议差异只在 upstreamUrl 里，这里不用关心是方舟还是 SeeAPI。
 */
async function attemptTask(key, upstreamKind, requestBody, started, capability, model, label, extraHeaders = {}) {
  let upstream
  try {
    upstream = await postJson(upstreamUrl(key, upstreamKind), key.apiKey, requestBody, config.gateway.videoTimeoutMs, extraHeaders)
  } catch (error) {
    reportKey(key.id, false, String(error?.message || error))
    recordRoute({ capability, model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: String(error?.message || error) })
    throw gatewayError(502, 'UPSTREAM_UNREACHABLE', '连不上' + label + '上游：' + friendlyNetwork(error))
  }
  if (!upstream.response.ok) {
    const message = friendlyUpstream(upstream.response.status, upstream.text)
    reportKey(key.id, false, 'HTTP ' + upstream.response.status + ' ' + upstream.text.slice(0, 160))
    recordRoute({ capability, model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: 'HTTP ' + upstream.response.status + ' ' + upstream.text.slice(0, 160) })
    throw gatewayError(502, 'UPSTREAM_REJECTED', message, { upstreamStatus: upstream.response.status, detail: upstream.text.slice(0, 300) })
  }
  const data = parseJson(upstream.text)
  const taskId = String(data?.id || data?.task_id || '')
  if (!taskId) {
    reportKey(key.id, false, '上游没有返回任务 id')
    recordRoute({ capability, model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: '上游没有返回任务 id' })
    throw gatewayError(502, 'UPSTREAM_EMPTY', label + '上游没有返回任务 id')
  }
  reportKey(key.id, true)
  recordRoute({ capability, model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: true })
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
  const candidates = resolveKeyCandidates({ capability: 'video', model, acceptModels: acceptedModels(model), limit: MAX_ATTEMPTS })
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
      created = await attemptTask(key, 'videoCreate', requestBody, started, 'video', model, '出视频')
    } catch (error) {
      lastError = error
      continue
    }
    rememberTask({ id: created.taskId, kind: 'video', keyId: key.id, keyName: key.name, baseUrl: key.baseUrl, model: requestBody.model, sealedKey: sealSecret(key.apiKey) })
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
  const job = getTask(id)
  if (!job) {
    throw gatewayError(404, 'TASK_NOT_FOUND', '找不到这个生成任务：任务 id 对不上，或它已经超过两小时。请重新发起生成')
  }
  // 优先用建任务那一刻的凭证密文：上游任务挂在那把凭证的账号下，
  // 后来管理员换了 Key 的秘钥也不该拿新凭证去查旧任务。
  const apiKey = openSecret(job.sealedKey) || keyMaterial(job.keyId)?.apiKey || ''
  if (!apiKey) {
    throw gatewayError(409, 'TASK_KEY_GONE', '这个任务用的 Key 已经被删掉，上游结果取不回来了；请重新生成一次')
  }
  let upstream
  try {
    upstream = await getJson(upstreamUrl({ baseUrl: job.baseUrl }, 'task', id), apiKey, config.gateway.videoTimeoutMs)
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
  // SeeAPI 的终态比方舟多两个：refunded（失败已退款）与 canceled（已取消），都算没出片
  const terminal = ['succeeded', 'failed', 'refunded', 'canceled'].includes(status)
  if (terminal && !job.terminalAt) {
    finishTask(id, { status, error: status === 'succeeded' ? '' : String(data?.error?.message || '上游报告任务没出结果（' + status + '）').slice(0, 160) })
    recordRoute({
      capability: job.kind === 'image' ? 'image' : 'video',
      model: job.model,
      keyId: job.keyId,
      keyName: job.keyName,
      source: 'pool',
      reason: '任务完成回执',
      ms: Date.now() - job.createdAt,
      ok: status === 'succeeded',
      error: status === 'succeeded' ? '' : String(data?.error?.message || '上游报告任务没出结果（' + status + '）').slice(0, 160),
    })
  }
  return { ...data, ok: true, status, key: { id: job.keyId, name: job.keyName } }
}

/**
 * 出图（异步任务形态）：SeeAPI 的 /v1/images/generations/async 只回任务 id，
 * 画布拿 id 轮询 /v1/tasks/<id> 取成品；方舟是同步出图，走 generateImage 那条路，没有这一步。
 */
export async function createImageTask(payload = {}) {
  pruneJobs()
  const started = Date.now()
  const model = String(payload.model || '')
  const candidates = resolveKeyCandidates({ capability: 'image', model, acceptModels: acceptedModels(model), limit: MAX_ATTEMPTS })
  if (!candidates.length) {
    const error = missingKeyError('image', model)
    recordRoute({ capability: 'image', model, source: 'none', reason: '池里没有可用的出图 Key', ms: Date.now() - started, ok: false, error: error.detail })
    throw error
  }
  let lastError = null
  for (const key of candidates) {
    const requestBody = { ...payload, model: upstreamModelFor(key, model) }
    if (!requestBody.response_format) requestBody.response_format = 'url'
    let created
    try {
      // SeeAPI 的异步出图强制要 Idempotency-Key：调用方没给就按这次请求生成一个
      created = await attemptTask(key, 'imageAsync', requestBody, started, 'image', model, '出图', { 'Idempotency-Key': String(payload.idempotencyKey || crypto.randomUUID()) })
    } catch (error) {
      lastError = error
      continue
    }
    rememberTask({ id: created.taskId, kind: 'image', keyId: key.id, keyName: key.name, baseUrl: key.baseUrl, model: requestBody.model, sealedKey: sealSecret(key.apiKey) })
    return { ...(created.data && typeof created.data === 'object' ? created.data : {}), ok: true, id: created.taskId, key: { id: key.id, name: key.name }, attempt: key.attempt, ms: Date.now() - started }
  }
  throw gatewayError(lastError?.status || 502, lastError?.code || 'UPSTREAM_REJECTED', failoverMessage('出图', candidates, lastError), {
    ...(lastError?.upstreamStatus ? { upstreamStatus: lastError.upstreamStatus } : {}),
    ...(lastError?.detail ? { detail: lastError.detail } : {}),
    attempts: candidates.length,
  })
}

/**
 * 通道自己的模型目录（GET /api/gateway/v1/models，OpenAI 形态）。
 * 画布侧「测试 Key」会先探模型列表，指向本通道时用它判活；内容只来自平台 Key 池，
 * 不暴露上游地址与 Key 本身。
 */
export function listPoolModels(capability = '') {
  const want = String(capability || '').toLowerCase()
  const caps = want === 'image' || want === 'video' ? [want] : ['image', 'video']
  const ids = []
  for (const cap of caps) {
    for (const model of vaultModels(cap)) {
      if (model && !ids.includes(model)) ids.push(model)
    }
  }
  return {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', owned_by: 'visionqa' })),
  }
}

/** 后台「生成通道」页读的运行时状态：只回计数与任务摘要，不回令牌与上游 Key。 */
export function gatewayStatus() {
  pruneJobs()
  const items = listTasks(10).map((task) => ({
    id: task.id,
    kind: task.kind,
    keyName: task.keyName,
    model: task.model,
    status: task.terminalAt ? task.status : 'running',
    ageSec: Math.round((Date.now() - task.createdAt) / 1000),
  }))
  return {
    configured: gatewayConfigured(),
    activeTasks: countRunning(),
    recentTasks: items,
    endpoints: {
      images: 'POST /api/gateway/v1/images/generations',
      imagesAsync: 'POST /api/gateway/v1/images/generations/async',
      videoCreate: 'POST /api/gateway/v1/videos/generations',
      videoPoll: 'GET /api/gateway/v1/videos/generations/<id>',
      taskPoll: 'GET /api/gateway/v1/tasks/<id>',
    },
    baseUrl: trimBase(config.gateway.publicBaseUrl) + '/api/gateway/v1',
    checkedAt: nowIso(),
  }
}

export function resetGatewayJobs() {
  resetTaskStore()
}
