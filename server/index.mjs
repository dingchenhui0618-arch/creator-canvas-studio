import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, redfoxEnabled, visionEnabled } from './config.mjs'
import { searchMedia } from './redfox.mjs'
import { searchFixtures } from './fixtures.mjs'
import { startReplicate, getJob } from './jobs.mjs'
import {
  listTemplates,
  getTemplate,
  reuseTemplate,
  deleteTemplate,
  updateTemplate,
  templateStats,
  saveTemplateFromItem,
  createTemplateFromFlow,
  adoptUnowned as adoptUnownedTemplates,
} from './templates.mjs'
import { adoptUnowned as adoptUnownedAgents } from './agents.mjs'
import { adoptUnownedFlows, createFlow, getFlow } from './flows.mjs'
import { adoptUnowned as adoptUnownedReviews } from './reviews.mjs'
import { createBillingRouter } from './routes/billing.mjs'
import { createAgentsRouter } from './routes/agents.mjs'
import { createFlowsRouter } from './routes/flows.mjs'
import { createReviewRouter } from './routes/review.mjs'
import { createAuthRouter } from './routes/auth.mjs'
import { createCreditsRouter } from './routes/credits.mjs'
import { createAdminRouter } from './routes/admin.mjs'
import { createPreferencesRouter } from './routes/preferences.mjs'
import { createCanvasRouter } from './routes/canvas.mjs'
import { currentUser, listUsers, clientIp, isAdmin } from './auth.mjs'
import { charge, refund, ensureWelcomeCredits } from './credits.mjs'
import { enter, leave } from './gate.mjs'
import { installProcessGuards, logEvent, logRequestError, startAccess } from './log.mjs'
import { deepHealth } from './health.mjs'
import { clearModelBlock, modelServiceState } from './service-state.mjs'
import { fetchPublic } from './media.mjs'
import { bdcStatus, listCanvases, createCanvas, appendCanvasNote } from './bdc.mjs'
import { modelCatalog } from './models.mjs'

// 功能路由：每个模块自己处理 /api/<prefix> 下的请求，index.mjs 只管分发
// auth 放最前面：/api/auth/* 永远不需要登录就能访问
const featureRoutes = [
  createAuthRouter(),
  createAgentsRouter(),
  createFlowsRouter(),
  createReviewRouter(),
  createBillingRouter(),
  createCreditsRouter(),
  createAdminRouter(),
  createPreferencesRouter(),
  createCanvasRouter(),
]

// VQ_REQUIRE_AUTH=1 时，除少数公开端点外所有 /api/* 都要登录。
// 默认关闭，本地演示不受影响；生产必须打开。
// /api/models 会返回真实模型标识：只给登录后的界面用，匿名探针不该看到。
// 本地演示（VQ_REQUIRE_AUTH=0）不受影响，仍然公开。
const PUBLIC_API = ['/api/auth', '/api/health', '/api/version', '/api/app']
function needsLogin(pathname) {
  if (!config.auth.requireAuth) return false
  if (!pathname.startsWith('/api/')) return false
  return !PUBLIC_API.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))
}

const STARTED_AT = new Date().toISOString()

// 版本号只读一次：/api/version 与 /api/app 都用它，避免每次请求都读盘
const PKG = JSON.parse(await fsp.readFile(path.join(process.cwd(), 'package.json'), 'utf8'))

// woff2/woff 必须给字体 MIME，否则浏览器按 octet-stream 直接拒绝加载
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8' }

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
  try { return JSON.parse(text) } catch { return {} }
}

async function serveFile(res, file) {
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) return false
    const ext = path.extname(file).toLowerCase()
    // 入口 HTML 不缓存，避免用户拿到旧 bundle；带 hash 的静态资源长缓存
    const cache = ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=604800, immutable'
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': cache })
    res.end(await fsp.readFile(file))
    return true
  } catch {
    return false
  }
}

const IMAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122 Safari/537.36'

// 小红书 / 抖音的封面常以 http 下发，而 CDN 只认 https + 对应站点的 Referer（实测 http 直连 403、https 200）。
// 所以先按原样试，失败再把协议升到 https 重试，都失败才返回 404。
// 走 fetchPublic：内网地址直接拒，重定向逐跳校验，带超时。
async function fetchCoverImage(url) {
  const referer = /xhscdn|xiaohongshu/.test(url.host)
    ? 'https://www.xiaohongshu.com'
    : /douyinpic|douyin/.test(url.host)
      ? 'https://www.douyin.com'
      : url.origin
  const attempt = async (target) => {
    const { response } = await fetchPublic(target, {
      headers: { Referer: referer, 'User-Agent': IMAGE_UA },
      timeoutMs: 15000,
    })
    const type = response.headers.get('content-type') || ''
    if (!response.ok || !type.startsWith('image/')) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > 8 * 1024 * 1024) return null
    return { type, buffer }
  }
  const candidates = [url]
  if (url.protocol === 'http:') candidates.push(new URL('https://' + url.host + url.pathname + url.search))
  for (const candidate of candidates) {
    try {
      const hit = await attempt(candidate)
      if (hit) return hit
    } catch {
      // 换下一个候选
    }
  }
  return null
}

async function proxyImage(res, target) {
  try {
    const url = new URL(target)
    if (!/^https?:$/.test(url.protocol)) throw new Error('bad protocol')
    const hit = await fetchCoverImage(url)
    if (!hit) throw new Error('not an image')
    res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=86400' })
    res.end(hit.buffer)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('image unavailable')
  }
}

// ---- 积分与并发：一次「要花钱」的请求进来，先过并发闸门，再扣积分 ----
// 返回 { cost, release }；余额不足/并发超限时直接写响应并返回 null。
// 未登录（本地演示）时既不扣费也不限流。
function beginPaid(res, user, kind, ref) {
  if (!user?.id) return { cost: 0, release: () => {} }
  const max = Number(config.credits.concurrency[kind] || 0)
  if (!enter(user.id, kind, max)) {
    sendJson(res, 429, {
      error: '这个账号还有同类型任务在跑，等它结束再试',
      code: 'CONCURRENCY_LIMIT',
      limit: max,
    })
    return null
  }
  const paid = charge(user.id, kind, { ref })
  if (!paid.ok) {
    leave(user.id, kind)
    sendJson(res, 402, {
      error: '积分不足：本次需要 ' + paid.cost + ' 积分，当前余额 ' + paid.balance + ' 积分',
      code: 'CREDIT_INSUFFICIENT',
      balance: paid.balance,
      cost: paid.cost,
      needed: paid.needed,
    })
    return null
  }
  return {
    cost: paid.cost,
    balance: paid.balance,
    release: () => leave(user.id, kind),
    refund: () => { if (paid.cost > 0) refund(user.id, kind, { ref, amount: paid.cost }) },
  }
}

// 老数据没有归属：升级后把历史模板 / 智能体 / 画布认领给管理员，
// 否则「多用户隔离」一上线，所有人都会看不见自己升级前建的东西。
async function migrateOwnership() {
  try {
    const users = listUsers()
    const admin = users.find((item) => item.kind === 'admin') || users[0]
    if (!admin) return
    const templates = await adoptUnownedTemplates(admin.id)
    const agents = await adoptUnownedAgents(admin.id)
    const flows = await adoptUnownedFlows(admin.id)
    const reviews = await adoptUnownedReviews(admin.id)
    if (templates || agents || flows || reviews) {
      logEvent('migrate-ownership', { to: admin.email, templates, agents, flows, reviews })
    }
    const welcomed = ensureWelcomeCredits()
    if (welcomed) logEvent('welcome-credits', { accounts: welcomed, amount: config.credits.welcome })
  } catch (error) {
    logRequestError('', error, { scope: 'migrate-ownership' })
  }
}

const server = http.createServer(async (req, res) => {
  const trace = startAccess(req, res, { ip: clientIp(req) })
  // 管理动作审计要带上同一个请求 id，出问题时能从「操作日志」跳到「排查信息」
  req.vqTraceId = trace.traceId
  res.setHeader('X-Request-Id', trace.traceId)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)

  try {
    const user = currentUser(req)
    if (user) trace.userId = user.email

    // 登录门必须排在功能路由前面：featureRoutes 以前放在门之前，VQ_REQUIRE_AUTH=1 时
    // /api/agents、/api/flows、/api/billing 仍然匿名可读（实测线上 200），等于把智能体提示词和画布流程公开了。
    // /api/auth/* 已在 PUBLIC_API 里豁免，登录接口不受影响。
    if (needsLogin(pathname) && !user) {
      return sendJson(res, 401, { error: '未登录', loginRequired: true })
    }

    for (const route of featureRoutes) {
      const prefixes = [route.prefix, ...(route.extraPrefixes || [])]
      if (prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))) {
        const handled = await route.handle(req, res, url, pathname)
        if (handled !== false) return
      }
    }

    if (pathname === '/api/version') {
      // 真实的版本号：读本仓库 package.json；客户端拿它和自己的构建版本比对，用来发现「页面是旧的」。
      // 生产匿名探针只回产品名与版本；包名与启动时刻属于部署细节，登录后（后台系统页）才返回。
      const internal = config.ui.mode === 'internal'
      sendJson(res, 200, {
        ok: true,
        version: PKG.version,
        name: internal ? PKG.name : 'VisionQA',
        ...(user ? { startedAt: STARTED_AT } : {}),
      })
      return
    }

    if (pathname === '/api/app') {
      // 界面口径：生产环境只讲产品语言；内部测试环境（VQ_UI_MODE=internal）多显示排障详情。
      // 这个字段只影响展示，不参与权限判断，所以公开可读，登录页也能用。
      return sendJson(res, 200, {
        ok: true,
        mode: config.ui.mode,
        internal: config.ui.mode === 'internal',
        version: PKG.version,
      })
    }

    if (pathname === '/api/bdc/status') {
      sendJson(res, 200, await bdcStatus())
      return
    }

    // 画布 ↔ 工作台：列画布、建画布、往画布里落评审笔记（都走画布自己的 HTTP 接口，不碰它的文件）
    if (pathname === '/api/bdc/canvases' && req.method === 'GET') {
      return sendJson(res, 200, await listCanvases())
    }

    if (pathname === '/api/bdc/canvases' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        return sendJson(res, 200, await createCanvas(body.name))
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: String(error?.message || error).slice(0, 160) })
      }
    }

    if (pathname === '/api/bdc/canvases/note' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        return sendJson(res, 200, await appendCanvasNote(body.canvasId, body.text, body.title))
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: String(error?.message || error).slice(0, 160) })
      }
    }

    if (pathname === '/api/models') {
      // 模型清单只读：给界面提供「切换模型」的下拉选项，模型本体在服务端 .env 里配
      return sendJson(res, 200, { ok: true, ...modelCatalog() })
    }

    // /api/config 与 /api/config/probe 会把模型标识、上游地址和环境变量清单发给调用方，
    // 以前只要求登录，任何注册用户都能看到；现在收紧到管理员。
    if ((pathname === '/api/config' || pathname === '/api/config/probe') && !isAdmin(user)) {
      return sendJson(res, 403, { error: '只有管理员可以查看服务端配置', code: 'NOT_ADMIN' })
    }

    if (pathname === '/api/config') {
      // 只在登录后可见：凭证一律脱敏，只回答「配了什么、几位、末四位」
      const mask = (key) => {
        const value = String(key || '')
        if (!value) return ''
        if (value.length <= 8) return '****'
        return '****' + value.slice(-4) + ' · ' + value.length + ' 位'
      }
      return sendJson(res, 200, {
        ok: true,
        vision: {
          enabled: visionEnabled(),
          baseUrl: config.vision.baseUrl,
          model: config.vision.model,
          models: config.vision.models,
          fallbacks: config.vision.fallbacks,
          apiKeyMasked: mask(config.vision.apiKey),
          timeoutMs: config.vision.timeoutMs,
        },
        llm: { enabled: visionEnabled(), model: config.llm.model, fallbacks: config.llm.fallbacks },
        redfox: {
          enabled: redfoxEnabled(),
          baseUrl: config.redfox.baseUrl,
          apiKeyMasked: mask(config.redfox.key),
          source: config.redfox.source,
        },
        remote: { enabled: config.remote.enabled, label: config.remote.label },
        limits: { maxVideoMb: config.limits.maxVideoMb, maxFrames: config.limits.maxFrames },
        credits: {
          unit: config.credits.unit,
          welcome: config.credits.welcome,
          prices: config.credits.prices,
          concurrency: config.credits.concurrency,
        },
        // 「再接一个 key」只动这些环境变量，改完重启服务即可，代码里没有第二处要改
        envKeys: [
          { key: 'VISION_BASE_URL', purpose: '模型接口地址（OpenAI 兼容 /v1）', current: config.vision.baseUrl },
          { key: 'VISION_API_KEY', purpose: '模型密钥（文本与视觉共用）', current: mask(config.vision.apiKey) },
          { key: 'LLM_MODEL', purpose: '文本模型（智能体对话、模板标题）', current: config.llm.model },
          { key: 'VISION_MODEL', purpose: '多模态模型（抽帧评审，必须能读图）', current: config.vision.model },
          { key: 'VISION_MODELS', purpose: '界面上可选的模型清单（逗号分隔）', current: config.vision.models.join(',') },
          { key: 'VISION_FALLBACKS', purpose: '视觉调用失败时的降级链', current: config.vision.fallbacks.join(',') },
          { key: 'LLM_FALLBACKS', purpose: '文本调用失败时的降级链', current: config.llm.fallbacks.join(',') },
          { key: 'REDFOX_API_KEY', purpose: '检索服务密钥（抖音 / 小红书）', current: mask(config.redfox.key) },
          { key: 'REDFOX_BASE_URL', purpose: '检索服务地址', current: config.redfox.baseUrl },
          { key: 'REPLICATE_REMOTE_URL', purpose: '远端算力地址，不填就走本机 ffmpeg', current: config.remote.enabled ? '已配置' : '' },
          { key: 'MAX_VIDEO_MB', purpose: '单条视频体积上限', current: String(config.limits.maxVideoMb) },
          { key: 'MAX_FRAMES', purpose: '每条视频抽帧数上限', current: String(config.limits.maxFrames) },
          { key: 'VQ_CREDIT_SEARCH', purpose: '每次检索消耗的积分', current: String(config.credits.prices.search) },
          { key: 'VQ_CREDIT_REPLICATE', purpose: '每次一键复刻消耗的积分', current: String(config.credits.prices.replicate) },
          { key: 'VQ_CREDIT_REVIEW', purpose: '每次视觉评审消耗的积分', current: String(config.credits.prices.review) },
          { key: 'VQ_CREDIT_CHAT', purpose: '每次智能体对话消耗的积分', current: String(config.credits.prices.chat) },
          { key: 'VQ_CREDIT_WELCOME', purpose: '新账号初始积分', current: String(config.credits.welcome) },
          { key: 'VQ_ADMIN_EMAILS', purpose: '管理员邮箱（逗号分隔，可发放积分）', current: config.auth.adminEmails.join(',') },
        ],
      })
    }

    if (pathname === '/api/config/probe' && req.method === 'POST') {
      // 真实探活：拿当前 key 打一次上游 /models，回答「这个 key 现在能不能用」。只列模型，不产生推理费用。
      if (!visionEnabled()) return sendJson(res, 400, { ok: false, error: '未配置 VISION_API_KEY' })
      try {
        const response = await fetch(config.vision.baseUrl + '/models', {
          headers: { Authorization: 'Bearer ' + config.vision.apiKey },
          signal: AbortSignal.timeout(12000),
        })
        const text = await response.text()
        let ids = []
        try {
          ids = (JSON.parse(text).data || []).map((item) => item.id).filter(Boolean)
        } catch {
          ids = []
        }
        return sendJson(res, 200, {
          ok: response.ok,
          status: response.status,
          count: ids.length,
          models: ids.slice(0, 40),
          body: response.ok ? undefined : text.slice(0, 200),
        })
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: String(error?.message || error).slice(0, 200) })
      }
    }

    if (pathname === '/api/health') {
      // 浅检查：只回答「配了没配」，给探针用（不需要登录）。
      // 真实可用性看 /api/system/health（登录后可见，会真连上游）。
      const stats = await templateStats(user)
      // 公开探针只回答「配了没配」：生产环境连模型标识都不返回，
      // 模型名与降级链只在内部测试环境可见（后台「排查信息」/总览要用）。
      return sendJson(res, 200, {
        ok: true,
        redfox: redfoxEnabled(),
        vision: visionEnabled(),
        ...(config.ui.mode === 'internal' ? { visionModel: config.vision.model, llmModel: config.llm.model } : {}),
        llm: visionEnabled(),
        templates: stats.total,
        uptimeSec: Math.round(process.uptime()),
      })
    }

    if (pathname === '/api/system/health' && req.method === 'GET') {
      return sendJson(res, 200, await deepHealth({ force: url.searchParams.get('force') === '1' }))
    }

    // 模型服务是否真的能出结果（登录可见）：最近一次真实调用的结论。
    // 生产只返回「能不能用 + 一句产品说明」，上游报文、模型名、失败时间只在内部环境返回。
    if (pathname === '/api/system/service' && req.method === 'GET') {
      const state = modelServiceState()
      const model = {
        available: state.available,
        message: state.message,
        retryAfterSec: state.retryAfterSec,
        ...(config.ui.mode === 'internal'
          ? { code: state.code, detail: state.internalDetail, upstream: state.upstreamMessage, since: state.since, count: state.count, lastModel: state.lastModel, verified: state.verified, verifiedAt: state.verifiedAt }
          : {}),
      }
      return sendJson(res, 200, { ok: true, model })
    }

    // 管理员处理（充值 / 换 key）之后，由界面「重新检测」放行一次真实请求；
    // 成功会清掉状态，失败会重新记为不可用。
    if (pathname === '/api/system/service/recheck' && req.method === 'POST') {
      clearModelBlock()
      return sendJson(res, 200, { ok: true, cleared: true, model: { available: true } })
    }

    if (pathname === '/api/search') {
      const platform = url.searchParams.get('platform') || 'all'
      const keyword = url.searchParams.get('q') || ''
      const startDate = url.searchParams.get('start') || ''
      const endDate = url.searchParams.get('end') || ''
      const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') || 1)) || 1)
      // 排序由服务端按回传字段做，未知值回落点赞；加载更多时页码递增，排序规则不变
      const sort = url.searchParams.get('sort') || 'likes'
      if (!redfoxEnabled()) {
        const items = searchFixtures(keyword)
        return sendJson(res, 200, { mode: 'mock', items, total: items.length, page: 1, hasMore: false, sort, note: '检索服务未接入，当前展示示例数据（非真实平台数据）' })
      }
      // 检索按次扣积分：一次请求=一页结果。示例数据不扣费（上面已经返回）。
      const paid = beginPaid(res, user, 'search', keyword)
      if (!paid) return
      try {
        const result = await searchMedia({ platform, keyword, startDate, endDate, pageNum: page, pageSize: 24, sort })
        return sendJson(res, 200, {
          ...result,
          note: result.errors?.length ? result.errors.join('；') : '',
          credits: { cost: paid.cost, balance: paid.balance },
        })
      } catch (error) {
        // 上游失败/额度不足都退积分：用户没拿到真实数据就不该被扣
        paid.refund()
        if (error?.code === 'REDFOX_RATE') {
          return sendJson(res, 429, { error: '检索服务触发频率限制（抖音 10 次/秒、小红书 20 次/秒），请稍后重试', code: 'REDFOX_RATE' })
        }
        if (error?.code === 'REDFOX_DISABLED') {
          const items = searchFixtures(keyword)
          return sendJson(res, 200, {
            mode: 'mock',
            items,
            total: items.length,
            note: '检索服务返回 3105（凭证不可用），当前显示的是示例数据：请到后台确认检索凭证后再试。',
            quota: { code: 'REDFOX_DISABLED', message: error.message },
          })
        }
        if (error?.code === 'REDFOX_QUOTA') {
          // 有 Key 但积分不足：不伪装成真实数据，明确说明并给示例数据兜底
          const items = searchFixtures(keyword)
          return sendJson(res, 200, {
            mode: 'mock',
            items,
            total: items.length,
            note: 'VisionQA 检索服务已连通，但服务端额度不足（' + (error.quota?.amount ?? 0) + ' 元起充 / ' + (error.quota?.goodsName || '见服务后台') + '），当前显示的是示例数据。',
            quota: { code: 'REDFOX_QUOTA', message: error.message, goodsName: error.quota?.goodsName || '' },
          })
        }
        throw error
      } finally {
        paid.release()
      }
    }

    if (pathname === '/api/replicate' && req.method === 'POST') {
      const body = await readBody(req)
      const item = body.item || {}
      const paid = beginPaid(res, user, 'replicate', String(item.title || body.url || '').slice(0, 80))
      if (!paid) return
      try {
        const job = await startReplicate(item, body.url || '', {
          ownerId: user?.id || '',
          onSettled: (status) => {
            paid.release()
            if (status === 'error') paid.refund()
          },
        })
        // 连链接都没有时任务立刻失败，不再等回调
        if (job.status === 'error') {
          paid.release()
          paid.refund()
        }
        return sendJson(res, 200, { jobId: job.id, credits: { cost: paid.cost, balance: paid.balance } })
      } catch (error) {
        paid.release()
        paid.refund()
        throw error
      }
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([\w-]+)$/)
    if (jobMatch) {
      const job = getJob(jobMatch[1], user)
      if (!job) return sendJson(res, 404, { error: 'job not found' })
      return sendJson(res, 200, job)
    }

    // 模板库「复用此模板」：真的生成一张画布草稿（输入节点 + 复刻脚本节点），
    // 不再是只把 reuseCount +1 的假动作。生成后前端直接跳到画布。
    const applyMatch = pathname.match(/^\/api\/templates\/([\w-]+)\/apply$/)
    if (applyMatch && req.method === 'POST') {
      const template = await getTemplate(applyMatch[1], user)
      if (!template) return sendJson(res, 404, { error: '模板不存在' })
      const body = await readBody(req)
      // 画布模板：blueprint 里存的是真节点与连线，原样建回一张新画布
      if (template.kind === 'flow' && Array.isArray(template.blueprint?.nodes) && template.blueprint.nodes.length) {
        const flow = await createFlow(
          {
            name: String(body.name || template.title || '工作流').slice(0, 60),
            description: ('来自模板库 · 工作流 · ' + template.blueprint.nodes.length + ' 个节点').slice(0, 240),
            nodes: template.blueprint.nodes,
            edges: template.blueprint.edges || [],
          },
          user,
        )
        const updated = await reuseTemplate(template.id)
        return sendJson(res, 201, { ok: true, flow, template: updated })
      }
      const rules = (template.analysis?.reusableRules || []).join('；')
      const structureText = (template.structure || [])
        .map((item) => (typeof item === 'string' ? item : item?.title || ''))
        .filter(Boolean)
        .join(' → ')
      const prompt =
        '按模板结构复写一条同类型脚本：' +
        (structureText || template.contentType || '结构未标注') +
        '。' +
        (rules ? '可复用规则：' + rules + '。' : '') +
        '开头钩子参考：' +
        (template.hook || '未标注') +
        '。输出可以直接进入画布继续改。'
      const flow = await createFlow(
        {
          name: String(body.name || template.title || '模板复刻').slice(0, 60),
          description: ('来自模板库 · ' + (template.contentType || '未分类') + (template.sourceUrl ? ' · ' + template.sourceUrl : '')).slice(0, 240),
          nodes: [
            {
              id: 'n_input',
              type: 'input',
              position: { x: 80, y: 140 },
              data: { kind: 'input', title: '原始素材', config: { text: template.hook || template.title || '' } },
            },
            {
              id: 'n_llm',
              type: 'llm',
              position: { x: 420, y: 140 },
              data: { kind: 'llm', title: '复刻脚本', config: { systemPrompt: prompt } },
            },
          ],
          edges: [{ id: 'e_input_llm', source: 'n_input', target: 'n_llm' }],
        },
        user,
      )
      const updated = await reuseTemplate(template.id)
      return sendJson(res, 201, { ok: true, flow, template: updated })
    }

    // 爆款雷达 → 模板库：只落「链接 + 互动数据」，不下载视频、不抽帧（解析靠一键复刻）
    if (pathname === '/api/templates/from-radar' && req.method === 'POST') {
      const body = await readBody(req)
      const item = body.item || {}
      if (!item.url) return sendJson(res, 400, { error: '这条内容没有原链接，无法加入模板库' })
      const result = await saveTemplateFromItem({ item, user })
      return sendJson(res, result.created ? 201 : 200, { ...result, ...(await templateStats(user)) })
    }

    if (pathname === '/api/templates' && req.method === 'POST') {
      // 画布「另存为模板」：把当前流程存成工作流模板（带 blueprint，可在模板库套用回画布）
      const body = await readBody(req)
      const flowId = String(body.flowId || '')
      if (body.from !== 'flow' || !flowId) {
        return sendJson(res, 400, { error: '缺少来源：POST /api/templates 需要 { from: "flow", flowId }' })
      }
      const flow = await getFlow(flowId, user)
      if (!flow) return sendJson(res, 404, { error: '流程不存在' })
      if (!flow.nodes.length) return sendJson(res, 400, { error: '流程里没有节点，先拖入节点再存为模板' })
      const template = await createTemplateFromFlow({
        flow,
        title: body.title,
        contentType: body.contentType,
        tags: body.tags,
        user,
      })
      return sendJson(res, 201, { ok: true, template })
    }

    if (pathname === '/api/templates') {
      const stats = await templateStats(user)
      const list = await listTemplates({
        q: url.searchParams.get('q') || '',
        contentType: url.searchParams.get('type') || '',
        platform: url.searchParams.get('platform') || '',
        kind: url.searchParams.get('kind') || '',
      }, user)
      return sendJson(res, 200, { items: list, ...stats })
    }

    const tplMatch = pathname.match(/^\/api\/templates\/([\w-]+)(\/reuse)?$/)
    if (tplMatch) {
      const id = tplMatch[1]
      if (tplMatch[2]) {
        if (!(await getTemplate(id, user))) return sendJson(res, 404, { error: '模板不存在' })
        const updated = await reuseTemplate(id)
        if (!updated) return sendJson(res, 404, { error: '模板不存在' })
        return sendJson(res, 200, updated)
      }
      if (req.method === 'PATCH') {
        // 后台模板治理：改标题、内容类型、标签与原链接；权限在管理后台，接口这里再校验一次
        if (!isAdmin(user)) return sendJson(res, 403, { error: '只有管理员可以改模板', code: 'NOT_ADMIN' })
        const body = await readBody(req)
        const updated = await updateTemplate(id, body, user)
        if (!updated) return sendJson(res, 404, { error: '模板不存在' })
        return sendJson(res, 200, updated)
      }
      if (req.method === 'DELETE') {
        const done = await deleteTemplate(id)
        return sendJson(res, done ? 200 : 404, { ok: done })
      }
      const template = await getTemplate(id, user)
      if (!template) return sendJson(res, 404, { error: '模板不存在' })
      return sendJson(res, 200, template)
    }

    if (pathname === '/api/cover') {
      const target = url.searchParams.get('url') || ''
      return proxyImage(res, target)
    }

    const frameMatch = pathname.match(/^\/media\/frames\/([\w-]+)\/([\w.-]+)$/)
    if (frameMatch) {
      const file = path.join(config.framesDir, frameMatch[1], frameMatch[2])
      const ok = await serveFile(res, file)
      if (!ok) { res.writeHead(404); res.end('frame not found') }
      return
    }

    // 生产环境静态托管 dist
    const distDir = path.join(process.cwd(), 'dist')
    const candidate = pathname === '/' ? path.join(distDir, 'index.html') : path.join(distDir, pathname)
    if (await serveFile(res, candidate)) return
    if (await serveFile(res, path.join(distDir, 'index.html'))) return

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + pathname)
  } catch (error) {
    logRequestError(trace.traceId, error, { path: pathname, method: req.method })
    sendJson(res, 500, { error: String(error?.message || error), traceId: trace.traceId })
  }
})

installProcessGuards()
await migrateOwnership()

server.listen(config.port, '127.0.0.1', () => {
  logEvent('listen', { port: config.port, redfox: redfoxEnabled() ? 'on' : 'mock', vision: visionEnabled() ? config.vision.model : 'off', auth: config.auth.requireAuth ? 'on' : 'off' })
})
