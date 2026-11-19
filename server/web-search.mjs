// 联网搜索（r246）：平台自己搜，不再把「联网」这件事交给上游工具。
//
// 以前是把 deepseek_web_search 当服务端工具塞进请求：上游认这个工具才有搜索，不认就是整条 400
// （r219 的读链接已经因为同样的原因改成本地读）。现在和读链接同一套路：
//   1. 平台用自己的搜索服务搜一次（博查 / Tavily / 自建 JSON 接口），拿到标题、地址、摘要；
//   2. 再用 link-read 把前 3 条网页读成文字（内网防护、超时、字数上限都在那边）；
//   3. 搜索结果与正文一起进这一轮上下文，界面上把「搜了什么、读了哪几条」列出来给用户核对。
//
// 没有一个搜索服务时**不假装搜过**：searchView().configured 是 false，界面把开关禁用；
// 万一请求里还是带着 search=true，服务端也只往上下文里写一句「这轮没有联网搜索」，
// 让模型老实说不确定，而不是编一条「最新消息」。
//
// 为什么不用自己爬搜索引擎：那些结果的版权条款只允许「在 RSS 阅读器里给自己看」，
// 拿它做商业产品的一部分是踩线。要搜就接一个正经的搜索服务，Key 由管理员在后台填。
//
// r258：默认通道换成 DeepSeek 自己的搜索接口（POST {base}/tools/search，2026-11-13 随「全家桶应用 API」
// 一起开放）。它跟平台对话用**同一把 Key、同一份余额**，后台不用再填第二把 Key——这就是「联网搜索和对话共用
// 一个 Key」的做法。结构化的 title/url/summary 直接回来，来源卡片照旧，读前几条网页仍走我们自己的 link-read。
// 博查 / Tavily / 自建接口留着当备选：真有需要时在**同一张卡**里换，不另开一处配置。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { readLinks } from './link-read.mjs'
import { keyMaterial, listKeys } from './keyvault.mjs'

export const SEARCH_LIMITS = {
  // 一次最多回几条结果、真的去读前几条网页
  results: 6,
  readTop: 3,
  // 读完的网页正文合计上限（进上下文，会算进这一轮的 token）
  chars: 12000,
  pageChars: 8000,
  // 搜索服务返回的 JSON 上限，防一个发疯的响应把内存顶爆
  bytes: 512 * 1024,
  timeoutMs: 10000,
}

/** 默认通道：DeepSeek 的搜索接口，跟平台对话共用同一把 Key。 */
export const PLATFORM_PROVIDER = 'deepseek'

export const PROVIDERS = {
  [PLATFORM_PROVIDER]: { label: 'DeepSeek 搜索（跟平台对话共用一把 Key）', endpoint: '' },
  bocha: { label: '博查 Bocha', endpoint: 'https://api.bochaai.com/v1/web-search' },
  tavily: { label: 'Tavily', endpoint: 'https://api.tavily.com/search' },
  // 通用接口：POST {query,count} 回 {results:[{title,url,snippet}]}，给自建服务与本地 E2E 用
  generic: { label: '通用 JSON 接口（自建 / 本地测试）', endpoint: '' },
}

export const searchFile = () => path.join(config.dataDir, 'search.json')

/** 平台对话那把 Key 的地址（https://api.deepseek.com/v1）→ 搜索接口地址（…/v1/tools/search）。 */
export function deepseekEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  if (/\/tools\/search$/.test(base)) return base
  return base + '/tools/search'
}

function isDeepseekHost(baseUrl) {
  try {
    return /\.deepseek\.com$/i.test(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

/**
 * 平台自己那把 DeepSeek Key：联网搜索跟对话共用它，所以搜索不再单独存 Key。
 * 取法按「离对话最近」的顺序：
 *   1. Key 池里 provider 声明为 deepseek 的启用 Key（后台「模型与上游 → Key 池」）；
 *   2. Key 池里地址落在 api.deepseek.com 的启用 Key（有的部署只按地址建 Key）；
 *   3. 环境变量那份对话凭证（VISION_API_KEY + VISION_BASE_URL），且地址确实是 DeepSeek 官方。
 * 都没有就返回 null——界面据此说「先把平台对话那把 Key 加进去」，而不是让人再填一把。
 */
export function platformSearchConfig(options = {}) {
  const listImpl = options.listKeysImpl || listKeys
  const materialOf = options.materialOf || keyMaterial
  let items = options.items
  if (!items) {
    try {
      items = listImpl().items || []
    } catch {
      items = []
    }
  }
  const pick =
    items.find((item) => item.enabled && String(item.provider || '') === 'deepseek') ||
    items.find((item) => item.enabled && isDeepseekHost(item.baseUrl))
  if (pick) {
    const material = materialOf(pick.id)
    if (material?.apiKey && material.enabled !== false) {
      const endpoint = deepseekEndpoint(material.baseUrl || 'https://api.deepseek.com/v1')
      if (endpoint) {
        return {
          key: material.apiKey,
          endpoint,
          keyMasked: maskSearchKey(material.apiKey),
          source: 'pool',
          keyId: pick.id,
          keyName: pick.name || '',
          baseUrl: material.baseUrl || '',
        }
      }
    }
  }
  const envKey = String(options.envApiKey ?? config.vision.apiKey ?? '').trim()
  const envBase = String(options.envBaseUrl ?? config.vision.baseUrl ?? '').trim()
  if (envKey && isDeepseekHost(envBase)) {
    return {
      key: envKey,
      endpoint: deepseekEndpoint(envBase),
      keyMasked: maskSearchKey(envKey),
      source: 'env',
      keyId: '',
      keyName: '平台对话凭证（环境变量）',
      baseUrl: envBase,
    }
  }
  return null
}

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/** Key 是凭证：界面与日志只留前 3 后 2。 */
export function maskSearchKey(raw) {
  const value = String(raw || '')
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return value.slice(0, 3) + '••••' + value.slice(-2)
}

export async function readSearch() {
  try {
    const parsed = JSON.parse(await fsp.readFile(searchFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.provider || !PROVIDERS[parsed.provider]) return null
    return {
      provider: String(parsed.provider),
      key: String(parsed.key || ''),
      endpoint: String(parsed.endpoint || ''),
      enabled: parsed.enabled !== false,
      updatedAt: String(parsed.updatedAt || ''),
      updatedBy: String(parsed.updatedBy || ''),
    }
  } catch {
    return null
  }
}

async function persist(saved) {
  const target = searchFile()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = target + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, target)
  await fsp.chmod(target, 0o600).catch(() => {})
}

function cleanEndpoint(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  let url = null
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.toString()
}

export function validateSearch(input = {}) {
  const provider = String(input?.provider || '').trim()
  if (!provider) return { ok: false, error: '请选择搜索服务商' }
  if (!PROVIDERS[provider]) return { ok: false, error: '不认识的搜索服务商' }
  if (provider === PLATFORM_PROVIDER) {
    return { ok: true, value: { provider, endpoint: '', enabled: input?.enabled !== false } }
  }
  const endpoint = cleanEndpoint(input?.endpoint)
  if (endpoint === null) return { ok: false, error: '搜索服务地址要是 http/https 的网址' }
  if (provider === 'generic' && !endpoint) return { ok: false, error: '通用接口必须填地址' }
  return { ok: true, value: { provider, endpoint, enabled: input?.enabled !== false } }
}

/** 保存搜索服务：Key 留空表示沿用旧 Key（只改地址 / 服务商时不用重输）。 */
export async function saveSearch(input = {}, { by = '' } = {}) {
  const previous = await readSearch()
  const provider = String(input?.provider || '').trim()
  // 跟平台对话共用 Key：这里不存任何 Key，只记「用哪条通道 + 开没开」。
  // 平台那把 Key 还没有时直接拒绝，并说清去哪儿加——不要让人以为保存成功、结果搜不了。
  if (provider === PLATFORM_PROVIDER) {
    const platform = platformSearchConfig()
    if (!platform) {
      return { ok: false, error: '平台对话的 DeepSeek Key 还没配：先在「模型与上游 → Key 池」加一把 DeepSeek Key，再回来开通联网搜索' }
    }
    const saved = {
      provider: PLATFORM_PROVIDER,
      endpoint: '',
      key: '',
      enabled: input?.enabled !== false,
      updatedAt: new Date().toISOString(),
      updatedBy: String(by || '').slice(0, 120),
    }
    await persist(saved)
    return { ok: true, search: saved, keyKept: false, platformKeySource: platform.source }
  }
  const wantsKey = String(input?.key || '')
  const keepKey = !wantsKey && previous && previous.provider === provider ? previous.key : ''
  const checked = validateSearch({ provider, endpoint: String(input?.endpoint || '').trim() || (previous && previous.provider === provider ? previous.endpoint : ''), enabled: input?.enabled !== false })
  if (!checked.ok) return { ok: false, error: checked.error }
  const key = wantsKey || keepKey
  if (checked.value.provider !== 'generic' && !key) return { ok: false, error: '请填搜索服务的 API Key' }
  const saved = {
    ...checked.value,
    key,
    updatedAt: new Date().toISOString(),
    updatedBy: String(by || '').slice(0, 120),
  }
  await persist(saved)
  return { ok: true, search: saved, keyKept: !wantsKey && Boolean(keepKey) }
}

export async function clearSearch() {
  await fsp.rm(searchFile(), { force: true })
}

function fromEnv() {
  const env = config.search || {}
  const provider = String(env.provider || '').trim()
  if (!provider || !PROVIDERS[provider]) return null
  return {
    provider,
    key: String(env.key || ''),
    endpoint: String(env.endpoint || ''),
    enabled: true,
    updatedAt: '',
    updatedBy: '',
  }
}

/** 生效中的搜索服务：后台配置优先，其次环境变量；两处都没有 = 没接通。 */
export async function resolveSearch() {
  const saved = await readSearch()
  if (saved?.provider === PLATFORM_PROVIDER) {
    // 共用 Key：search.json 里没有 Key，调用前现从平台对话那把取。
    const platform = platformSearchConfig()
    if (!platform) return { source: 'none', search: { ...saved, key: '', endpoint: '' }, platform: null, reason: 'no-platform-key' }
    return {
      source: 'admin',
      search: { ...saved, key: platform.key, endpoint: platform.endpoint },
      platform,
      reason: '',
    }
  }
  if (saved?.provider) return { source: 'admin', search: saved, platform: platformSearchConfig() }
  const env = fromEnv()
  if (env && env.provider === PLATFORM_PROVIDER) {
    const platform = platformSearchConfig()
    if (platform) return { source: 'env', search: { ...env, key: platform.key, endpoint: platform.endpoint }, platform }
    return { source: 'none', search: null, platform: null, reason: 'no-platform-key' }
  }
  if (env) return { source: 'env', search: env, platform: platformSearchConfig() }
  return { source: 'none', search: null, platform: platformSearchConfig() }
}

/** 对外安全视图：Key 只给掩码与「有没有」。 */
export async function searchView() {
  const resolved = await resolveSearch()
  const saved = await readSearch()
  const search = resolved.search
  const platform = resolved.platform === undefined ? platformSearchConfig() : resolved.platform
  const configured = Boolean(search?.provider) && search.enabled !== false && (search.provider === 'generic' || Boolean(search.key))
  const usesPlatformKey = (search?.provider || saved?.provider || '') === PLATFORM_PROVIDER
  return {
    configured,
    provider: search?.provider || saved?.provider || '',
    providerLabel: PROVIDERS[search?.provider || saved?.provider || '']?.label || '',
    endpoint: search?.endpoint || '',
    keyMasked: maskSearchKey(search?.key || ''),
    hasKey: Boolean(search?.key),
    enabled: search ? search.enabled !== false : false,
    source: resolved.source,
    reason: resolved.reason || '',
    usesPlatformKey,
    // 卡片上「用哪把 Key」：共用的那把从 Key 池现取，只回掩码与来源。
    platformKey: platform
      ? { available: true, masked: platform.keyMasked, source: platform.source, name: platform.keyName, baseUrl: platform.baseUrl }
      : { available: false, masked: '', source: '', name: '', baseUrl: '' },
    defaultProvider: PLATFORM_PROVIDER,
    updatedAt: saved?.updatedAt || '',
    updatedBy: saved?.updatedBy || '',
    canEdit: resolved.source !== 'env',
    providers: Object.entries(PROVIDERS).map(([value, meta]) => ({ value, label: meta.label })),
  }
}

/** 真正发请求时用的完整配置（含 Key）；没接通或停用返回 null。 */
export async function searchForQuery() {
  const resolved = await resolveSearch()
  const search = resolved.search
  if (!search?.provider || search.enabled === false) return null
  if (search.provider !== 'generic' && !search.key) return null
  return resolved
}

/** 拿这句话去搜什么：去掉代码块、网址与 Markdown 记号，取前 N 个字。 */
export function buildQuery(text, max = 80) {
  let value = String(text || '')
  value = value.replace(/```[\s\S]*?```/g, ' ')
  value = value.replace(/https?:\/\/\S+/gi, ' ')
  value = value.replace(/[#>*_`~[\]()]/g, ' ')
  value = value.replace(/\s+/g, ' ').trim()
  value = value.replace(/^[，。！？、,.!?：:；;\s]+/, '')
  value = value.replace(/[，。！？、,.!?：:；;\s]+$/, '')
  if (value.length > max) value = value.slice(0, max).trim()
  return value
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function clip(value, max) {
  const text = String(value == null ? '' : value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

/** 各家返回的字段名不一样，统一成 {title,url,snippet,site}；只认 http/https 的地址。 */
export function normalizeResults(provider, payload, limit = SEARCH_LIMITS.results) {
  // DeepSeek 搜索接口回的是结构化结果：title / url / summary（长摘要）/ snippet / site_name。
  // summary 是给模型读的（600～800 字），snippet 是给界面看的；这里优先 summary、只截 320 字进上下文。
  if (provider === PLATFORM_PROVIDER) {
    const rows = payload && Array.isArray(payload.results) ? payload.results : []
    const out = []
    const seen = new Set()
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const url = String(row.url || '').trim()
      if (!/^https?:\/\//i.test(url)) continue
      const key = url.replace(/#.*$/, '')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        title: clip(row.title || row.site_name || hostOf(url), 120) || hostOf(url),
        url: key,
        site: clip(row.site_name || hostOf(url), 60),
        snippet: clip(row.summary || row.snippet || row.content || '', 320),
      })
      if (out.length >= limit) break
    }
    return out
  }
  let list = []
  if (provider === 'bocha') {
    const data = payload && typeof payload.data === 'object' && payload.data ? payload.data : payload
    const pages = data && (data.webPages || data.webpages)
    const rows = pages ? (pages.value || pages.items) : (data && (data.results || data.value))
    if (Array.isArray(rows)) list = rows
  } else {
    const rows = payload && (payload.results || (payload.data && (payload.data.results || payload.data.value)) || payload.items)
    if (Array.isArray(rows)) list = rows
  }
  const out = []
  const seen = new Set()
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const url = String(row.url || row.link || row.href || '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    const key = url.replace(/#.*$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      title: clip(row.title || row.name || row.heading || hostOf(url), 120) || hostOf(url),
      url: key,
      site: hostOf(url),
      snippet: clip(row.snippet || row.summary || row.content || row.description || row.text, 220),
    })
    if (out.length >= limit) break
  }
  return out
}

async function callSearch(provider, searchConfig, query, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = Number(options.timeoutMs) || SEARCH_LIMITS.timeoutMs
  const endpoint = String(
    searchConfig.endpoint ||
      (provider === PLATFORM_PROVIDER ? deepseekEndpoint('https://api.deepseek.com/v1') : PROVIDERS[provider].endpoint) ||
      '',
  ).trim()
  if (!endpoint) throw fail(500, 'SEARCH_ENDPOINT', '搜索服务没有地址')
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'VisionQA-Search/1.0' }
  let body = null
  if (provider === PLATFORM_PROVIDER) {
    // 跟平台对话同一把 Key：鉴权、余额、计费口径都在一起，不另存一份。
    headers.authorization = 'Bearer ' + searchConfig.key
    body = { query, count: Math.max(1, Math.min(50, SEARCH_LIMITS.results + 2)), need_content: false }
  } else if (provider === 'bocha') {
    headers.authorization = 'Bearer ' + searchConfig.key
    body = { query, count: SEARCH_LIMITS.results + 2, summary: false, freshness: 'noLimit' }
  } else if (provider === 'tavily') {
    body = { api_key: searchConfig.key, query, max_results: SEARCH_LIMITS.results + 2, search_depth: 'basic', include_answer: false, include_raw_content: false }
  } else {
    body = { query, count: SEARCH_LIMITS.results + 2 }
  }
  let response = null
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timedOut = String(error?.name || '') === 'TimeoutError' || /abort/i.test(String(error?.message || ''))
    throw fail(502, 'SEARCH_FETCH', timedOut
      ? '搜索服务 ' + Math.round(timeoutMs / 1000) + ' 秒内没有响应'
      : '搜索服务打不开：' + String(error?.message || error))
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) {
    if (provider === PLATFORM_PROVIDER) {
      if (response.status === 401) throw fail(401, 'SEARCH_KEY', '这把 DeepSeek Key 不能用于搜索（401）：搜索与对话共用同一把，去「模型与上游 → Key 池」核对')
      if (response.status === 402) throw fail(402, 'SEARCH_BALANCE', 'DeepSeek 账户余额不足（402）：联网搜索与对话共用同一份余额')
      if (response.status === 400) {
        let why = ''
        try { why = String(JSON.parse(raw)?.error?.message || '') } catch { why = '' }
        throw fail(400, 'SEARCH_REQUEST', '搜索请求被拒' + (why ? '：' + why.slice(0, 120) : '（400）'))
      }
    }
    let detail = ''
    try { const parsed = JSON.parse(raw); detail = parsed.error || parsed.message || parsed.msg || '' } catch { detail = '' }
    throw fail(502, 'SEARCH_STATUS', '搜索服务回了 HTTP ' + response.status + (detail ? '：' + String(detail).slice(0, 120) : ''))
  }
  if (raw.length > SEARCH_LIMITS.bytes) throw fail(502, 'SEARCH_SIZE', '搜索服务返回的内容过大')
  let payload = null
  try {
    payload = JSON.parse(raw)
  } catch {
    throw fail(502, 'SEARCH_JSON', '搜索服务返回的不是 JSON')
  }
  const code = Number(payload && payload.code)
  if (Number.isFinite(code) && code !== 0 && code !== 200) {
    throw fail(502, 'SEARCH_CODE', '搜索服务拒了这次查询：' + clip(payload.msg || payload.message || 'code ' + code, 120))
  }
  return payload
}

/**
 * 搜一次。永远不抛错：搜不到、没接通、服务报错都回 { ok:false, note }，
 * 由调用方决定「这次对话还要不要继续」——一次搜索失败不该让整个对话失败。
 */
export async function searchWeb(query, options = {}) {
  const q = buildQuery(query, Number(options.maxQuery) || 80)
  const labelOf = (provider) => (PROVIDERS[provider] ? PROVIDERS[provider].label : provider || '')
  if (!q) {
    return { ok: false, code: 'SEARCH_QUERY', query: '', provider: '', providerLabel: '', results: [], note: '这句话里没有能拿去搜的关键词' }
  }
  let resolved = null
  if (options.config) resolved = { source: 'inline', search: options.config }
  else resolved = await searchForQuery()
  if (!resolved || !resolved.search) {
    return { ok: false, code: 'SEARCH_OFF', query: q, provider: '', providerLabel: '', results: [], note: '平台还没接入搜索服务' }
  }
  const provider = resolved.search.provider
  try {
    const payload = await callSearch(provider, resolved.search, q, options)
    const results = normalizeResults(provider, payload, Number(options.limit) || SEARCH_LIMITS.results)
    if (!results.length) {
      return { ok: false, code: 'SEARCH_EMPTY', query: q, provider, providerLabel: labelOf(provider), results: [], note: '搜索服务这次没有返回结果' }
    }
    return { ok: true, code: 'OK', query: q, provider, providerLabel: labelOf(provider), results, note: '' }
  } catch (error) {
    return { ok: false, code: error?.code || 'SEARCH_FAIL', query: q, provider, providerLabel: labelOf(provider), results: [], note: String(error?.message || error) }
  }
}

/** 只给界面看的搜索结果：不带摘要正文（正文在上下文里给模型看，界面只列来源）。 */
export function publicSearch(search) {
  if (!search) return null
  return {
    ok: Boolean(search.ok),
    query: String(search.query || ''),
    provider: String(search.provider || ''),
    providerLabel: String(search.providerLabel || ''),
    note: String(search.note || ''),
    results: (Array.isArray(search.results) ? search.results : []).slice(0, SEARCH_LIMITS.results).map((row) => ({
      title: String(row.title || ''),
      url: String(row.url || ''),
      site: String(row.site || ''),
    })),
  }
}

/**
 * 搜一次 + 把前几条网页读成文字：这是「联网搜索」真正做的事。
 * 返回的 text 直接拼进这一轮上下文；search 与 links 存进消息，界面据此列出「搜了什么、读了哪几条」。
 */
export async function searchAndRead(query, options = {}) {
  const search = await searchWeb(query, options)
  if (!search.ok) {
    return {
      search,
      links: [],
      text: '【联网搜索没有成功：' + (search.note || '搜索服务不可用') + '。如果这个问题依赖最新信息，先说明你不确定，不要编造链接或数据。】',
      chars: 0,
    }
  }
  const readTop = Math.max(1, Number(options.readTop) || SEARCH_LIMITS.readTop)
  const top = search.results.slice(0, readTop)
  const read = await readLinks(top.map((row) => row.url), {
    fetchImpl: options.fetchImpl,
    lookup: options.lookup,
    maxLinks: top.length,
    maxChars: SEARCH_LIMITS.pageChars,
    budget: SEARCH_LIMITS.chars,
  })
  const list = search.results.map((row, index) => {
    const head = index + 1 + '. ' + row.title + '｜' + row.site + '｜' + row.url
    return row.snippet ? head + '\n   ' + row.snippet : head
  }).join('\n')
  const readBlock = read.links.length ? '\n\n【其中前 ' + top.length + ' 条的网页正文】\n' + read.text : ''
  const text = '【联网搜索：' + search.query + '（平台自己搜的，来源 ' + search.providerLabel + '）】\n' + list + readBlock
  return { search, links: read.links, text, chars: text.length }
}