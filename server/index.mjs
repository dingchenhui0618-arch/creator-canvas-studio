// B9：第一个 import 是守门模块——Node 版本不对、或启动时漏了 --experimental-sqlite，
// 都在加载 config / storage / SQLite 之前带着明确提示退出（退出码 78），
// 不会变成一句看不懂的 ERR_UNKNOWN_BUILTIN_MODULE。
import './node-guard.mjs'
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, redfoxEnabled, visionEnabled } from './config.mjs'
import { searchMedia } from './redfox.mjs'
import { recordSearch, listSearchHistory, toggleSearchFavorite, clearSearchHistory } from './search-history.mjs'
import { searchFixtures } from './fixtures.mjs'
import {
  startReplicate,
  getJob,
  newJobId,
  createJobDraft,
  dropJobDraft,
  abortJob,
  recoverInterruptedJobs,
  interruptRunningJobs,
} from './jobs.mjs'
import {
  listTemplates,
  getTemplate,
  reuseTemplate,
  deleteTemplate,
  updateTemplate,
  templateStats,
  templateSource,
  parseTemplateSource,
  TEMPLATE_SOURCES,
  saveTemplateFromItem,
  createTemplateFromFlow,
  adaptTemplate,
  listTrash,
  restoreTemplate,
  purgeTemplate,
  listTemplateVersions,
  restoreTemplateVersion,
  enableTemplateShare,
  disableTemplateShare,
  getSharedTemplate,
  publicTemplateView,
  adoptUnowned as adoptUnownedTemplates,
} from './templates.mjs'
import { flattenTemplateWorks, projectsByTemplate, templateWorksView, totalProjectCount, withProjectCount } from './template-usage.mjs'
import { takenOrigins, ORIGIN_LIMIT } from './taken-origins.mjs'
import { originFootprint, libraryMarks } from './source-footprint.mjs'
import { listProjects } from './projects.mjs'
import { adoptUnowned as adoptUnownedAgents } from './agents.mjs'
import { adoptUnownedFlows, createFlow, getFlow, recoverInterruptedRuns, interruptRunningRuns } from './flows.mjs'
import { adoptUnowned as adoptUnownedReviews } from './reviews.mjs'
import { readJsonBody as readBody } from './body-reader.mjs'
import { refusalResponse } from './public-error.mjs'
import { createBillingRouter } from './routes/billing.mjs'
import { createAgentsRouter } from './routes/agents.mjs'
import { createFlowsRouter } from './routes/flows.mjs'
import { createReviewRouter } from './routes/review.mjs'
import { createAuthRouter } from './routes/auth.mjs'
import { createCreditsRouter } from './routes/credits.mjs'
import { createAdminRouter } from './routes/admin.mjs'
import { createPreferencesRouter } from './routes/preferences.mjs'
import { createFeedbackRouter } from './routes/feedback.mjs'
import { createCanvasRouter } from './routes/canvas.mjs'
import { createProjectsRouter } from './routes/projects.mjs'
import { createSharesRouter } from './routes/shares.mjs'
import { createDeliveriesRouter } from './routes/deliveries.mjs'
import { createProjectShareRouter } from './routes/project-share.mjs'
import { createGatewayRouter } from './routes/gateway.mjs'
import { createAccountRouter } from './routes/account.mjs'
import { createLocalAgentRouter } from './routes/local-agent.mjs'
import { createStorageRouter } from './routes/storage.mjs'
import { currentUser, listUsers, clientIp, isAdmin } from './auth.mjs'
import { recordClientError } from './client-errors.mjs'
import { createReport } from './reports.mjs'
import { charge, refund, priceOf, ensureWelcomeCredits } from './credits.mjs'
import { quotaRefusal } from './quota.mjs'
import { enter, leave } from './gate.mjs'
import { installProcessGuards, logEvent, logRequestError, startAccess } from './log.mjs'
import { startLogRetention } from './log-files.mjs'
import { rateLimit } from './ratelimit.mjs'
import { startAlertWatch } from './alerts.mjs'
import { deepHealth } from './health.mjs'
import { sitePublicView } from './site-info.mjs'
import { storageRoom } from './storage.mjs'
import { admit, capacityFor } from './waterline.mjs'
import { inheritedListenFd, listenMode } from './listen.mjs'
import { checkNodeVersion, MIN_NODE } from './node-version.mjs'
import { clearModelBlock, modelServiceState } from './service-state.mjs'
import { fetchPublic } from './media.mjs'
import { bdcStatus, canvasErrorMessage, listCanvases, createCanvas, appendCanvasNote } from './bdc.mjs'
import { modelCatalog } from './models.mjs'

// 功能路由：每个模块自己处理 /api/<prefix> 下的请求，index.mjs 只管分发
// auth 放最前面：/api/auth/* 永远不需要登录就能访问
const featureRoutes = [
  createAuthRouter(),
  // 作品只读分享：/api/share/project/* 在 PUBLIC_API 里，打开链接不需要登录
  createProjectShareRouter(),
  createAgentsRouter(),
  createFlowsRouter(),
  createReviewRouter(),
  createBillingRouter(),
  createCreditsRouter(),
  // 素材占用：设置页要看「自己的帧图占了多少盘」（v0.9.68）
  createStorageRouter(),
  createAdminRouter(),
  createPreferencesRouter(),
  createCanvasRouter(),
  createProjectsRouter(),
  createSharesRouter(),
  // 应用内反馈：提交不要求登录（登录页也要能求助），读自己的条目要登录
  createFeedbackRouter(),
  // 工作台的交付流水：跨作品把每一次交付摊成一条线（v0.9.32）
  createDeliveriesRouter(),
  createGatewayRouter(),
  createAccountRouter(),
  // 桌面端本地工作区的模型入口：密钥留在服务端，循环与工具在客户端
  createLocalAgentRouter(),
]

// VQ_REQUIRE_AUTH=1 时，除少数公开端点外所有 /api/* 都要登录。
// 默认关闭，本地演示不受影响；生产必须打开。
// /api/models 会返回真实模型标识：只给登录后的界面用，匿名探针不该看到。
// 本地演示（VQ_REQUIRE_AUTH=0）不受影响，仍然公开。
// /api/gateway 由平台服务令牌鉴权（画布服务端调用，没有浏览器会话），所以不走登录门；
// 路由内部每一步都先验令牌，未配置时回 503，不会变成匿名可用。
// /api/share 是只读分享链接：链接本身（24 字节随机 token）就是凭证，不需要登录态。
const PUBLIC_API = [
  '/api/auth',
  '/api/health',
  '/api/version',
  '/api/app',
  '/api/gateway',
  '/api/share',
  '/api/client-errors',
  // 举报侵权不要求登录：被侵权的人不一定有账号；靠 IP 限流 + 内容校验挡住滥用
  '/api/reports',
  // 反馈不要求登录：登录进不来时最需要它；匿名必须留联系方式，且按 IP 限流
  '/api/feedback',
]
// 前端异常上报要能在登录页、分享页也生效，所以不要求登录；靠 IP 限流 + 体积上限挡住滥用。
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

// 公开接口用：超过上限直接抛（调用方回 413），不把整包读进内存
async function readJsonLimited(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('payload too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
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
function beginPaid(res, user, kind, ref, { meta = null } = {}) {
  if (!user?.id) return { cost: 0, release: () => {} }
  // 运行水位（v0.9.69）：内存到红线时在扣费之前拒绝——这一单不扣积分、不调上游。
  // 水位偏紧时并发上限压到 1：宁可慢一点，也不要两条重活一起把进程顶穿。
  const water = admit(kind)
  if (!water.ok) {
    sendJson(res, water.status, water.body)
    return null
  }
  const max = capacityFor(kind, Number(config.credits.concurrency[kind] || 0), water.level)
  if (!enter(user.id, kind, max)) {
    sendJson(res, 429, {
      error: '这个账号还有同类型任务在跑，等它结束再试',
      code: 'CONCURRENCY_LIMIT',
      limit: max,
    })
    return null
  }
  const paid = charge(user.id, kind, { ref, meta })
  if (!paid.ok) {
    leave(user.id, kind)
    // 本月额度用完：429 + 一句能照着做的提示，不扣积分、不调上游
    if (paid.code === 'MONTHLY_QUOTA') {
      const refusal = quotaRefusal(paid)
      sendJson(res, refusal.status, refusal.body)
      return null
    }
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

    // 最贵的几个入口按 IP 限速：积分挡不住换号刷，上游额度才是真被烧的东西
    const limited = rateLimit(req, pathname, clientIp(req))
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfterSec))
      return sendJson(res, 429, {
        error: '操作太频繁了，请 ' + limited.retryAfterSec + ' 秒后再试',
        code: 'RATE_LIMITED',
        bucket: limited.bucket,
        retryAfterSec: limited.retryAfterSec,
      })
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
      // B9：运行时的 Node 版本跟启动时间一样属于部署细节，登录后的后台才看得到。
      // 版本掉出支持范围时后台直接显示「未验证 / 不支持」，不用登服务器查。
      const runtime = checkNodeVersion()
      sendJson(res, 200, {
        ok: true,
        version: PKG.version,
        name: internal ? PKG.name : 'VisionQA',
        ...(user
          ? {
              startedAt: STARTED_AT,
              runtime: { node: runtime.node, min: MIN_NODE, level: runtime.level, supported: runtime.ok },
            }
          : {}),
      })
      return
    }

    if (pathname === '/api/app') {
      // 界面口径：生产环境只讲产品语言；内部测试环境（VQ_UI_MODE=internal）多显示排障详情。
      // 这个字段只影响展示，不参与权限判断，所以公开可读，登录页也能用。
      const site = await sitePublicView()
      return sendJson(res, 200, {
        ok: true,
        mode: config.ui.mode,
        internal: config.ui.mode === 'internal',
        version: PKG.version,
        // 备案号与客服邮箱保留在顶层：老前端只认这两个字段，不能因为加了 site 对象就让它们消失
        icp: site.icp,
        supportEmail: site.supportEmail,
        // 公示信息（v0.9.67）：后台「系统 → 站点公示」填，环境变量兜底；没填就是空串，页面不摆空壳
        site,
        // 注册页要展示「同意的是哪一版」，条款改版只改服务端配置
        terms: { version: config.site.termsVersion, updatedAt: config.site.termsUpdatedAt },
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
        // 502 的 error 是会出现在界面上的那句话：翻成中文，原始串留在 detail（v0.9.42）
        return sendJson(res, 502, { ok: false, error: canvasErrorMessage(error), detail: String(error?.message || error).slice(0, 160) })
      }
    }

    if (pathname === '/api/bdc/canvases/note' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        return sendJson(res, 200, await appendCanvasNote(body.canvasId, body.text, body.title))
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: canvasErrorMessage(error), detail: String(error?.message || error).slice(0, 160) })
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
          // 邮件通道默认在后台「系统 → 邮件通道」配；这两条只是老部署的兜底
          { key: 'VQ_SMTP_HOST', purpose: '发信服务器（后台没配时用它兜底）', current: config.mail.host },
          { key: 'VQ_SMTP_USER', purpose: '发信账号', current: config.mail.user ? '已配置' : '' },
          { key: 'VQ_SMTP_FROM', purpose: '发件地址（收件人看到的）', current: config.mail.fromAddress },
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

    // 发现页开场：库里已经有哪些原片、哪一条已经开成作品（v0.9.36）。
    // 只读现算：模板上有原片链接与互动数据，作品那侧只有模板指针，两边都不复制。
    // 不按「来源」筛：官方示例也有原片（shared 照实标），筛掉就等于假装库里没有它们。
    // 不检索、不扣积分：这是看库，不是查平台。
    if (pathname === '/api/taken-origins') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      if (!user) return sendJson(res, 401, { error: '需要登录' })
      const limit = Number(url.searchParams.get('limit') || ORIGIN_LIMIT) || ORIGIN_LIMIT
      const [templates, projects] = await Promise.all([
        listTemplates({}, user),
        listProjects(user),
      ])
      return sendJson(res, 200, takenOrigins(templates, projects, { limit }))
    }

    // 这几条检索结果里，哪几条已经在库里（v0.9.38）。发现页每张卡片的「库里已有」问的就是这一句。
    // 只问「库里有没有」：不检索、不扣积分。认的是平台 id 而不是链接原文——链接会带分享参数。
    if (pathname === '/api/library/marks') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!user) return sendJson(res, 401, { error: '需要登录' })
      const body = await readBody(req)
      const asked = Array.isArray(body.items) ? body.items.slice(0, 200) : []
      const [templates, byTemplate] = await Promise.all([listTemplates({}, user), projectsByTemplate(user)])
      return sendJson(res, 200, { ok: true, ...libraryMarks(templates, flattenTemplateWorks(byTemplate), asked) })
    }

    // 检索历史与收藏：只存条件不存结果，点一下就填回表单（不自动检索，避免替用户扣积分）
    if (pathname === '/api/search/history' && req.method === 'GET') {
      if (!user) return sendJson(res, 401, { error: '需要登录' })
      const items = await listSearchHistory(user)
      return sendJson(res, 200, { items })
    }

    if (pathname === '/api/search/history' && req.method === 'DELETE') {
      if (!user) return sendJson(res, 401, { error: '需要登录' })
      const removedInfo = await clearSearchHistory(user)
      return sendJson(res, 200, { ok: true, ...removedInfo })
    }

    const favoriteMatch = pathname.match(/^\/api\/search\/history\/([A-Za-z0-9_-]+)\/favorite$/)
    if (favoriteMatch && req.method === 'POST') {
      if (!user) return sendJson(res, 401, { error: '需要登录' })
      const entry = await toggleSearchFavorite(user, favoriteMatch[1])
      if (!entry) return sendJson(res, 404, { error: '没有这条检索记录' })
      return sendJson(res, 200, { entry })
    }

    // 前端异常上报：浏览器里炸了的东西留一份给后台看。
    // 入参只取白名单字段，体积封顶 16KB；同一条错误由存储层按 10 分钟去重累加。
    if (pathname === '/api/client-errors' && req.method === 'POST') {
      let body = {}
      try {
        body = await readJsonLimited(req, 16 * 1024)
      } catch {
        return sendJson(res, 413, { error: '上报内容过大' })
      }
      const entry = await recordClientError({ payload: body, ip: clientIp(req), user })
      if (!entry) return sendJson(res, 202, { ok: true, stored: false })
      return sendJson(res, 202, { ok: true, stored: true, id: entry.id })
    }

    // 侵权 / 不当内容举报：分享页与公共模板都能报，不要求登录
    if (pathname === '/api/reports' && req.method === 'POST') {
      let body = {}
      try {
        body = await readJsonLimited(req, 8 * 1024)
      } catch {
        return sendJson(res, 413, { error: '举报内容过大' })
      }
      const result = await createReport({
        target: body.target || {},
        category: String(body.category || 'other'),
        detail: String(body.detail || ''),
        contact: String(body.contact || ''),
        user,
        ip: clientIp(req),
      })
      if (!result.ok) {
        if (result.code === 'DETAIL_TOO_SHORT') return sendJson(res, 400, { error: '请说明要举报的内容（至少 5 个字）', field: 'detail' })
        return sendJson(res, 400, { error: '缺少举报对象', field: 'target' })
      }
      logEvent('report-create', { category: result.report.category, target: result.report.target.id, duplicate: result.duplicate })
      return sendJson(res, 201, { ok: true, id: result.report.id, duplicate: result.duplicate })
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
        // 只记第一页：翻页是同一次检索的延续，逐页记会把历史刷满
        if (page === 1) {
          recordSearch({
            user,
            platform,
            keyword,
            range: url.searchParams.get('range') || '',
            sort,
            total: result.total,
          }).catch(() => {})
        }
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
      // 公共模板：只有管理员能落成「所有账号可见」的种子内容
      const shared = body.shared === true && isAdmin(user)
      // 先把任务草稿落库、再扣费：万一进程在「扣完费、还没开始跑」之间退出，
      // 下次启动的恢复逻辑能按积分账本把这笔退回去（只建内存任务时这笔钱就找不回来了）。
      // 账本里的 ref 用 jobId，退款金额也从这条 ref 的净扣款算，重复收尾不会多退。
      // 存储闸门（v0.9.68）：素材已经到上限时不再接新任务。
      // 放在扣费与上游调用之前——被拒的这一单不扣积分、不落任务、也不碰来源链接。
      const room = await storageRoom(user?.id)
      if (!room.ok) {
        sendJson(res, 429, {
          error: room.message,
          code: 'STORAGE_LIMIT',
          usedBytes: room.bytes,
          limitBytes: room.limitBytes,
          limitMb: room.limitMb,
        })
        return
      }
      const jobId = newJobId()
      // 说明列给用户看标题；账本 ref 留 jobId（唯一、可对账），两者都记下来
      const jobLabel = String(item.title || body.url || '').slice(0, 80)
      createJobDraft({ id: jobId, ownerId: user?.id || '', shared, cost: priceOf('replicate'), label: jobLabel })
      const paid = beginPaid(res, user, 'replicate', jobId, { meta: { label: jobLabel } })
      if (!paid) {
        dropJobDraft(jobId)
        return
      }
      try {
        const job = await startReplicate(item, body.url || '', {
          jobId,
          ownerId: user?.id || '',
          shared,
          cost: paid.cost,
          label: jobLabel,
          // 结算只负责放开并发闸门：退款在任务层按账本做，失败与中断走同一条路径
          onSettled: () => paid.release(),
        })
        return sendJson(res, 200, { jobId: job.id, credits: { cost: paid.cost, balance: paid.balance } })
      } catch (error) {
        abortJob(jobId, String(error?.message || error))
        paid.release()
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
      // 分镜时长按台词量估过：念不完的镜头在提示词里标出来，复刻时先删口播再加时长
      // 以「段落口播」为准：真正要念出来的是口播，镜头字幕往往只有三五个字
      const beatsWithTiming = (template.structure || []).filter((beat) => beat.expectedSec)
      const timingNote = beatsWithTiming.length
        ? beatsWithTiming
          .slice(0, 12)
          .map((beat, index) => '#' + (index + 1) + ' ' + (beat.startSec ?? 0) + 's–' + (beat.endSec ?? 0) + 's（这句要念 ' + beat.expectedSec + 's）：' + String(beat.voiceover || beat.beat || '').replace(/[。；;，,]+$/, ''))
          .join('；')
        : (template.storyboard || [])
          .filter((shot) => shot.expectedSec)
          .slice(0, 12)
          .map((shot) => '#' + shot.shotNo + ' ' + (shot.startSec ?? 0) + 's–' + (shot.endSec ?? 0) + 's（台词约需 ' + shot.expectedSec + 's）' + (shot.caption ? '：' + shot.caption : ''))
          .join('；')
      const timingLine = timingNote
        ? '口播与镜头时长对账：' + timingNote + '。镜头时长必须容得下台词（中文口播约 4.5 字/秒）。'
        : ''
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
        '。' +
        (timingLine ? timingLine : '') +
        '输出可以直接进入画布继续改。'
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
      const shared = body.shared === true && isAdmin(user)
      const result = await saveTemplateFromItem({ item, user, shared })
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

    // 改编：把一条模板改成本人的一版，存成新模板（不改原条目）
    const adaptMatch = pathname.match(/^\/api\/templates\/([\w-]+)\/adapt$/)
    if (adaptMatch && req.method === 'POST') {
      const source = await getTemplate(adaptMatch[1], user)
      if (!source) return sendJson(res, 404, { error: '模板不存在' })
      if (!Array.isArray(source.structure) || !source.structure.length) {
        return sendJson(res, 400, { error: '这条模板还没解析，先解析再改编' })
      }
      const body = await readBody(req)
      const template = await adaptTemplate({
        source,
        title: body.title,
        hook: body.hook,
        structure: body.structure,
        storyboard: body.storyboard,
        user,
      })
      if (!template) return sendJson(res, 400, { error: '改编内容不完整：至少保留一段脚本和一个镜头' })
      return sendJson(res, 201, { ok: true, template })
    }

    if (pathname === '/api/templates') {
      // 来源是模板库的第二排筛选（v0.9.33）：认不出来的来源直接 400，不静默退化成「全部」——
      // 否则链接里写错一个 key，用户看到的是整整一库模板，还以为筛过了。
      const { source, unknown } = parseTemplateSource(url.searchParams.get('source'))
      if (unknown) {
        return sendJson(res, 400, {
          error: '不认识的来源：' + unknown + '；可用：' + TEMPLATE_SOURCES.map((entry) => entry.key).join(' / '),
        })
      }
      // 卡片上那句「几条作品在用」现算：模板库与作品是两组数据，计数器（reuseCount）不会因为删作品而回落
      const [stats, list, byTemplate] = await Promise.all([
        templateStats(user, { source }),
        listTemplates({
          q: url.searchParams.get('q') || '',
          contentType: url.searchParams.get('type') || '',
          platform: url.searchParams.get('platform') || '',
          kind: url.searchParams.get('kind') || '',
          source,
        }, user),
        projectsByTemplate(user),
      ])
      return sendJson(res, 200, { items: withProjectCount(list, byTemplate), projectTotal: totalProjectCount(byTemplate), ...stats })
    }

    // 版本历史：每次改标题/类型/标签/原链接前留一版快照，最多 10 版，可回滚
    const versionsMatch = pathname.match(/^\/api\/templates\/([\w-]+)\/versions(?:\/([\w-]+)\/restore)?$/)
    if (versionsMatch) {
      const [, id, versionId] = versionsMatch
      if (!versionId && req.method === 'GET') {
        const versions = await listTemplateVersions(id, user)
        if (!versions) return sendJson(res, 404, { error: '模板不存在' })
        return sendJson(res, 200, { versions })
      }
      if (versionId && req.method === 'POST') {
        const restored = await restoreTemplateVersion(id, versionId, user)
        if (!restored) return sendJson(res, 404, { error: '没有这一版历史' })
        return sendJson(res, 200, { ok: true, template: restored })
      }
    }

    // 回收站：删除的模板留 30 天，可恢复；彻底删除时连同抽帧一起清掉
    if (pathname === '/api/templates/trash' && req.method === 'GET') {
      const items = await listTrash(user)
      return sendJson(res, 200, { items, days: 30 })
    }

    const trashMatch = pathname.match(/^\/api\/templates\/([\w-]+)\/(restore|purge)$/)
    if (trashMatch && req.method === 'POST') {
      const [, id, action] = trashMatch
      if (action === 'restore') {
        const restored = await restoreTemplate(id, user)
        if (!restored) return sendJson(res, 404, { error: '回收站里没有这条模板' })
        return sendJson(res, 200, { ok: true, template: restored })
      }
      const done = await purgeTemplate(id, user)
      if (!done) return sendJson(res, 404, { error: '回收站里没有这条模板' })
      return sendJson(res, 200, { ok: true })
    }

    // 分享管理：只有模板的可见者（归属账号 / 管理员 / 公共模板）能开和停
    const shareOwnerMatch = pathname.match(/^\/api\/templates\/([\w-]+)\/share$/)
    if (shareOwnerMatch) {
      const id = shareOwnerMatch[1]
      if (req.method === 'POST') {
        const result = await enableTemplateShare(id, user)
        if (!result) return sendJson(res, 404, { error: '模板不存在' })
        return sendJson(res, 200, { ok: true, token: result.token, createdAt: result.createdAt })
      }
      if (req.method === 'DELETE') {
        const done = await disableTemplateShare(id, user)
        if (!done) return sendJson(res, 404, { error: '模板不存在' })
        return sendJson(res, 200, { ok: true })
      }
    }

    // 只读分享：链接本身就是凭证，不需要登录；只能读，不能改、套用或删除。
    // 帧图和封面也走这里，/media/frames 与 /api/cover 是要登录的。
    const shareViewMatch = pathname.match(/^\/api\/share\/([\w-]+)(?:\/(frame)\/(\d+)|\/(cover))?$/)
    if (shareViewMatch && req.method === 'GET') {
      const [, token, frameKind, frameIndex, coverKind] = shareViewMatch
      const shared = await getSharedTemplate(token)
      if (!shared) return sendJson(res, 404, { error: '这个分享链接已失效，或分享者已停止分享', code: 'SHARE_NOT_FOUND' })
      if (coverKind) {
        const cover = String(shared.cover || '')
        if (!cover) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('no cover')
          return
        }
        if (cover.startsWith('/media/frames/')) {
          if (await serveFile(res, path.join(config.framesDir, shared.id, cover.split('/').pop()))) return
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('no cover')
          return
        }
        return proxyImage(res, cover)
      }
      if (frameKind) {
        const frame = (shared.frames || []).find((entry) => String(entry.index) === String(frameIndex))
        const file = frame ? path.join(config.framesDir, shared.id, String(frame.url || '').split('/').pop()) : ''
        if (file && (await serveFile(res, file))) return
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('no frame')
        return
      }
      return sendJson(res, 200, { template: publicTemplateView(shared, token), sharedAt: shared.shareCreatedAt || '' })
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
        // 归属校验：别人的模板不能删（getTemplate 只返回当前账号能看见的条目）
        if (!(await getTemplate(id, user))) return sendJson(res, 404, { error: '模板不存在' })
        const trashed = await deleteTemplate(id, user)
        return sendJson(res, trashed ? 200 : 404, { ok: Boolean(trashed), trashed: true })
      }
      const template = await getTemplate(id, user)
      if (!template) return sendJson(res, 404, { error: '模板不存在' })
      // 详情多给两段：用这条模板的作品（最近改过的排前面），和这条原片在库里的全貌
      // （同源改编版、跨模板开出的作品）。两块都现算，不落库。
      const [templates, byTemplate] = await Promise.all([listTemplates({}, user), projectsByTemplate(user)])
      // 来源跟着详情一起给：抽屉里那句「这条从哪来」与卡片、筛选胶囊用同一套口径
      return sendJson(res, 200, {
        ...template,
        source: templateSource(template),
        ...templateWorksView(byTemplate.get(id) || []),
        footprint: originFootprint(templates, flattenTemplateWorks(byTemplate), template),
      })
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
    // 我们主动拒掉的请求（请求体过大、图片格式/尺寸不对）不是服务端故障：
    // 状态码与文案由抛错处给，日志只记一行，不去触发 5xx 告警。
    const refusal = refusalResponse(error)
    if (refusal) {
      logEvent('request.refused', { path: pathname, method: req.method, status: refusal.status, code: refusal.body.code })
      return sendJson(res, refusal.status, refusal.body)
    }
    logRequestError(trace.traceId, error, { path: pathname, method: req.method })
    sendJson(res, 500, { error: String(error?.message || error), traceId: trace.traceId })
  }
})

installProcessGuards()
await migrateOwnership()
// 上次进程没跑完的复刻任务：标成中断并按积分账本退款（重复启动不会重复退），
// 顺手清掉崩溃时留下的任务临时目录。发版 = 重启 = 以前每次都可能白扣 10 积分。
const recoveredJobs = recoverInterruptedJobs()
if (recoveredJobs.recovered) logEvent('jobs.recovered', recoveredJobs)
// 画布运行同一套：上次没跑完的运行标中断，并按账本把已扣积分退回（重复启动不会多退）
const recoveredRuns = await recoverInterruptedRuns()
if (recoveredRuns.recovered) logEvent('runs.recovered', recoveredRuns)
// 启动先清一次过期日志（停机久了不会把过期文件一直留着），之后每小时最多再清一次
const prunedLogs = await startLogRetention()
if (prunedLogs.removed.length) logEvent('logs.prune', { removed: prunedLogs.removed.length, bytesFreed: prunedLogs.bytesFreed })

const listenFd = inheritedListenFd()
const onListening = () => {
  // 告警哨兵：磁盘水位每 5 分钟看一次（5xx 与上游失败是事件驱动，不用轮询）
  startAlertWatch()
  logEvent('listen', {
    port: config.port,
    // 有 socket 激活时端口由 systemd 握着，重启不断开——发版不再有几秒 502
    listen: listenMode(listenFd),
    redfox: redfoxEnabled() ? 'on' : 'mock',
    vision: visionEnabled() ? config.vision.model : 'off',
    auth: config.auth.requireAuth ? 'on' : 'off',
    // 运行时版本一起落到启动事件里：换 Node 之后翻日志就能看到当时跑的是哪个版本
    node: process.versions.node,
  })
}
if (listenFd === null) server.listen(config.port, '127.0.0.1', onListening)
else server.listen({ fd: listenFd }, onListening)

// 停机收尾：systemd 重启（发版）发的是 SIGTERM，以前进程立刻死掉，
// 在跑的任务连同已扣积分一起消失。现在先标中断 + 按账本退款，再关服务退出；
// 1.5 秒的兜底是给 keep-alive 连接留的，ffmpeg 子进程由 systemd 的 cgroup 一起收走。
let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  let interrupted = 0
  let runsInterrupted = 0
  try {
    interrupted = interruptRunningJobs(signal === 'SIGTERM' ? '服务重启' : '服务停止')
  } catch (error) {
    logRequestError('shutdown', error, { signal })
  }
  try {
    // 画布运行也要先标中断 + 退款再退进程：否则这条运行和它的积分一起消失
    runsInterrupted = await interruptRunningRuns(signal === 'SIGTERM' ? '服务重启' : '服务停止')
  } catch (error) {
    logRequestError('shutdown', error, { signal, kind: 'runs' })
  }
  logEvent('shutdown', { signal, interrupted, runsInterrupted })
  server.close(() => {})
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
