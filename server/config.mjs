import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vaultHas } from './vault-state.mjs'

const root = process.cwd()

// 极简 .env 读取：只支持 KEY=VALUE 与 # 注释，不覆盖已存在的环境变量
function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(root, '.env'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const index = trimmed.indexOf('=')
      if (index < 1) continue
      const key = trimmed.slice(0, index).trim()
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '')
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch {
    // 没有 .env 就走真实环境变量
  }
}

loadDotEnv()

// 数字型环境变量：空字符串按「没配」处理。
// 以前直接 Number(process.env.X || 默认)，写一个空值会被当成 0，等于把闸门悄悄关掉。
const numEnv = (raw, fallback) => {
  const text = String(raw ?? '').trim()
  if (!text) return fallback
  const value = Number(text)
  return Number.isFinite(value) ? value : fallback
}

const dataDir = process.env.DATA_DIR || path.join(root, 'data')

function readLocalToken() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'))
    return auth?.tokens?.access_token ?? ''
  } catch {
    return ''
  }
}

const splitList = (value) =>
  String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)

// 文本与视觉共用同一个 OpenAI 兼容 baseUrl，换供应商只改环境变量
const visionBaseUrl = (process.env.VISION_BASE_URL || 'http://127.0.0.1:10100/v1').trim().replace(/\/+$/, '')
// 只有本机 OpenCodex 才允许拿 ~/.codex/auth.json 的 token 兜底；
// 换成远端 baseUrl 时绝不把本机凭证发出去。
const visionBaseIsLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(visionBaseUrl)

export const config = {
  port: Number(process.env.API_PORT || 8787),
  dataDir,
  framesDir: path.join(dataDir, 'frames'),
  videosDir: path.join(dataDir, 'videos'),
  templatesFile: path.join(dataDir, 'templates.json'),
  searchHistoryFile: path.join(dataDir, 'search-history.json'),
  // 前端异常上报（浏览器里炸的东西），后台「系统」页读它
  clientErrorsFile: path.join(dataDir, 'client-errors.json'),
  // 服务端日志：按天轮转 + 保留天数 / 总量上限（见 server/log-files.mjs）
  logs: {
    dir: (process.env.VQ_LOG_DIR || path.join(dataDir, 'logs')).trim(),
    retentionDays: Number(process.env.VQ_LOG_RETENTION_DAYS || 14),
    maxTotalMb: Number(process.env.VQ_LOG_MAX_MB || 200),
  },
  redfox: {
    key: (process.env.REDFOX_API_KEY || '').trim(),
    baseUrl: process.env.REDFOX_BASE_URL || 'https://redfox.hk',
    source: 'paperplane-radar/0.1',
  },
  // 纯文本：智能体对话、模板标题、画布节点这类只用文字的调用
  llm: {
    model: (process.env.LLM_MODEL || '').trim() || 'deepseek-flash',
    fallbacks: splitList(process.env.LLM_FALLBACKS),
  },
  // 多模态：抽帧评审必须能读图。文本模型和视觉模型分开配——
  // 便宜的快模型能聊天但看不了图，混用会静默失败。
  // 现在默认走官方 DeepSeek：deepseek-flash 的 input_modalities 是 text+image，
  // 一个模型同时能聊天和看帧；deepseek-v4-pro 只吃文本，只能当文本 fallback。
  vision: {
    baseUrl: visionBaseUrl,
    model: (process.env.VISION_MODEL || '').trim() || 'deepseek-flash',
    models: splitList(process.env.VISION_MODELS),
    fallbacks: splitList(process.env.VISION_FALLBACKS),
    timeoutMs: Number(process.env.VISION_TIMEOUT_MS || 300000),
    apiKey: (process.env.VISION_API_KEY || '').trim() || (visionBaseIsLocal ? readLocalToken() : ''),
  },
  // 画布账号互通：VisionQA 签短时票据，画布企业服务用同一把共享密钥校验后换自己的会话。
  // 没配 VQ_CANVAS_SHARED_SECRET 时整体关闭，画布仍用它的原生登录，不会意外免登录。
  canvas: {
    sharedSecret: (process.env.VQ_CANVAS_SHARED_SECRET || '').trim(),
    issuer: 'visionqa',
    audience: 'bd-canvas',
    ttlSec: Number(process.env.VQ_CANVAS_TICKET_TTL || 120),
    // 画布企业服务的内网地址：后台「画布身份」页从这里读，不经过公网 nginx
    adminUrl: (process.env.VQ_CANVAS_ADMIN_URL || 'http://127.0.0.1:5313').trim(),
  },
  // 平台生成通道：画布的出图 / 出视频请求走这里，按能力选平台 Key 再转发上游。
  // 令牌与画布互通密钥分开：一把给账号，一把给出图，泄露时能单独轮换。
  gateway: {
    token: (process.env.VQ_GATEWAY_TOKEN || '').trim(),
    // 渠道额度是否已开通：没开通时网关对生成请求直接 503 并说明原因，
    // 不让上游的 402 以「生成失败」的样子回到画布上。买了额度写 VQ_GATEWAY_OPEN=1。
    open: process.env.VQ_GATEWAY_OPEN === '1',
    imageTimeoutMs: Number(process.env.VQ_GATEWAY_IMAGE_TIMEOUT_MS || 120000),
    videoTimeoutMs: Number(process.env.VQ_GATEWAY_VIDEO_TIMEOUT_MS || 60000),
    publicBaseUrl: (process.env.VQ_PUBLIC_BASE_URL || 'https://visionqa.wavisionai.cn').trim().replace(/\/+$/, ''),
  },
  limits: {
    maxVideoMb: Number(process.env.MAX_VIDEO_MB || 160),
    maxFrames: Number(process.env.MAX_FRAMES || 18),
    // 下载/探活类外部请求的超时：以前完全没设，一个不响应的源就能把进程挂住
    downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS || 120000),
    probeTimeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 3000),
    // 封面代理（v0.9.90）：/api/cover 以前是纯透传——一屏模板库 40 张封面，翻两次页
    // 就是 80 次上游请求，每张最多 8MB 整段读进内存。现在同一张只抓一次，
    // 一个账号每分钟最多抓 120 次（缓存命中不算），整机同一刻最多 4 张在上游，
    // 满了先排 5 秒再拒。写 0 = 关掉对应那一层（退回旧的纯透传行为）。
    coverPerMinute: numEnv(process.env.VQ_COVER_PER_MINUTE, 120),
    coverConcurrency: numEnv(process.env.VQ_COVER_CONCURRENCY, 4),
    coverWaitMs: numEnv(process.env.VQ_COVER_WAIT_MS, 5000),
    coverCacheEntries: numEnv(process.env.VQ_COVER_CACHE_ENTRIES, 64),
    coverCacheMb: numEnv(process.env.VQ_COVER_CACHE_MB, 24),
    coverCacheTtlMs: numEnv(process.env.VQ_COVER_CACHE_TTL_MS, 10 * 60 * 1000),
    coverNegativeTtlMs: numEnv(process.env.VQ_COVER_NEGATIVE_TTL_MS, 60 * 1000),
  },
  // 智能体「网页读取」：只抓用户贴出来的公开网页，限制超时、体积与正文长度，
  // 避免一个超长页面把上下文顶爆或把请求挂住。
  webread: {
    timeoutMs: Number(process.env.WEB_READ_TIMEOUT_MS || 8000),
    maxBytes: Number(process.env.WEB_READ_MAX_BYTES || 400 * 1024),
    maxChars: Number(process.env.WEB_READ_MAX_CHARS || 6000),
  },
  // 积分制：检索 / 一键复刻 / 视觉评审 / 智能体对话按次扣积分。
  // 单价是「内部积分」不是钱，改价只改环境变量；充值通道与支付档位仍未接入（只留占位卡）。
  credits: {
    unit: process.env.VQ_CREDIT_UNIT || '积分',
    // 新账号初始额度：够试一轮检索 + 复刻，不至于一注册就卡住
    welcome: Number(process.env.VQ_CREDIT_WELCOME ?? 100),
    prices: {
      search: Number(process.env.VQ_CREDIT_SEARCH ?? 2),
      replicate: Number(process.env.VQ_CREDIT_REPLICATE ?? 10),
      review: Number(process.env.VQ_CREDIT_REVIEW ?? 5),
      chat: Number(process.env.VQ_CREDIT_CHAT ?? 1),
      // 画布整条流程跑一次（含模型调用）：按次计费，失败全额退回
      flow_run: Number(process.env.VQ_CREDIT_FLOW_RUN ?? 2),
    },
    // 同一账号同时能跑几个：防连点把上游配额一次打光
    concurrency: {
      search: Number(process.env.VQ_CONCURRENCY_SEARCH ?? 1),
      replicate: Number(process.env.VQ_CONCURRENCY_REPLICATE ?? 2),
      review: Number(process.env.VQ_CONCURRENCY_REVIEW ?? 1),
      chat: Number(process.env.VQ_CONCURRENCY_CHAT ?? 2),
      // 同账号同时只允许一条画布流程在跑，避免连点把上游配额打光
      flow_run: Number(process.env.VQ_CONCURRENCY_FLOW_RUN ?? 1),
      // 画布出图 / 出视频走的是平台令牌（/api/gateway，没有账号可挂），
      // 所以这一条不是「每账号」而是「整机」：同一时刻最多几张在生成。
      // 画布点「批量出图」会连发，8 张一起冲进来时整机只放 2 张，其余立刻拒（不碰上游、不花钱）。
      canvas_gen: Number(process.env.VQ_CONCURRENCY_CANVAS_GEN ?? 2),
    },
    // 画布出图的排队位（v0.9.80）：一次「批量出图」会连发 8 张，整机只放 2 张。
    // 以前第 3 张起立刻 503，画布上就是「6 张失败」；现在名额满时先排一会儿再拒。
    // 画布自己等得起：它的同步出图超时是 1800 秒（generation_image2.py:72），
    // 异步提交是 120 秒（:245）——所以这一档默认 90 秒，别把异步提交拖到超时。
    // waitMs 写 0（或 maxWaiting 写 0）= 关掉排队，退回 v0.9.79 的「立刻拒」。
    canvasQueue: {
      waitMs: numEnv(process.env.VQ_CANVAS_QUEUE_MS, 90000),
      maxWaiting: numEnv(process.env.VQ_CANVAS_QUEUE_MAX, 8),
    },
    // 全站（不分账号）同时在跑的重活条数上限（v0.9.70）。
    // 按账号的上限管不住「两个账号各来两条」：这台机器只有 2 核 / 1.86 GB，
    // 重活撞在一起就是 OOM，进程一死所有人的会话一起断。
    // 0 = 不限（写 0 就恢复旧行为）；偏紧时按水位再折到 2 条，到红线时重活整体拒绝。
    globalHeavy: numEnv(process.env.VQ_GLOBAL_HEAVY, 3),
  },
  // 界面口径：生产环境只讲产品语言（不出现模型标识、上游地址、环境变量）；
  // 内部测试环境显式设 VQ_UI_MODE=internal 后，后台保留完整技术详情用于排障。
  // 默认 prod：生产漏配也绝不会把技术细节亮给用户。
  ui: {
    mode: (process.env.VQ_UI_MODE || '').trim().toLowerCase() === 'internal' ? 'internal' : 'prod',
  },
  // 远端算力：给了 REPLICATE_REMOTE_URL 就把「解析/下载/抽帧」交给它，本地不跑 ffmpeg
  remote: {
    url: (process.env.REPLICATE_REMOTE_URL || '').trim(),
    get enabled() {
      return Boolean(this.url)
    },
    token: (process.env.REPLICATE_REMOTE_TOKEN || '').trim(),
    label: process.env.REPLICATE_REMOTE_LABEL || 'remote-worker',
    timeoutMs: Number(process.env.REPLICATE_REMOTE_TIMEOUT_MS || 180000),
  },
  // 站点信息：备案号与客服邮箱由环境变量给，代码里不写死、也不编造。
  // 没有配置就不显示（页脚不摆空链接，登录页不摆假邮箱）。
  site: {
    icp: (process.env.VQ_ICP || '').trim(),
    supportEmail: (process.env.VQ_SUPPORT_EMAIL || '').trim(),
    // 条款版本：注册时必须把「勾选同意的版本」记到账号上，改条款就改这个版本号
    // 2026-11-13：补 AI 生成内容标识与第三方处理者清单，版本跟着改（注册时记下同意的就是这一版）
    termsVersion: (process.env.VQ_TERMS_VERSION || '2026-11-13').trim(),
    termsUpdatedAt: (process.env.VQ_TERMS_UPDATED_AT || '2026-11-13').trim(),
    // 站点的对外地址：找回密码邮件里的链接要靠它拼；分享链接也用它。
    publicBaseUrl: (process.env.VQ_PUBLIC_BASE_URL || 'https://visionqa.wavisionai.cn').trim().replace(/\/+$/, ''),
  },
  // 告警：本站队列（后台「系统」页）永远可用。
  // 外推通道可以在后台直接配（存在数据目录的 alert-channel.json），环境变量只是兜底：
  // 老部署不改也能用；VQ_ALERT_SECRET 给环境变量通道加 HMAC 签名。
  alerts: {
    webhook: (process.env.VQ_ALERT_WEBHOOK || '').trim(),
    secret: (process.env.VQ_ALERT_SECRET || '').trim(),
    diskFreeMb: Number(process.env.VQ_ALERT_DISK_FREE_MB || 1024),
  },
  // 运行水位：这台机器还剩多少内存能接活（v0.9.69）。
  // 两条判定都来自真实读数：系统 MemAvailable（含可回收缓存）与 V8 堆占比。
  // 阈值可用环境变量覆盖，写 0 等于关掉那一条；VQ_WATER_GUARD=0 只量不拦（后台照样能看到数字）。
  waterline: {
    guard: process.env.VQ_WATER_GUARD !== '0',
    tightAvailableMb: numEnv(process.env.VQ_WATER_TIGHT_MB, 320),
    criticalAvailableMb: numEnv(process.env.VQ_WATER_CRITICAL_MB, 128),
    tightHeapPercent: numEnv(process.env.VQ_WATER_TIGHT_HEAP, 80),
    criticalHeapPercent: numEnv(process.env.VQ_WATER_CRITICAL_HEAP, 92),
  },
  // 评审发模型前先缩图（v0.9.74）：堆占用跟着「送审字节数」走——8 MB × 3 并发 = 27% 堆、
  // 8 MB × 10 并发 = 81%、17.9 MB × 10 直接 OOM（docs/load-test-2026-11-14.md）。
  // 默认缩到长边 1600px，超过 1.5 MB 才动；maxEdge 写 0 等于关掉缩图，minKb 写 0 等于所有图都重压。
  reviewImage: {
    maxEdge: numEnv(process.env.VQ_REVIEW_MAX_EDGE, 1600),
    minBytes: numEnv(process.env.VQ_REVIEW_SCALE_MIN_KB, 1536) * 1024,
    maxPixels: numEnv(process.env.VQ_REVIEW_MAX_PIXELS, 40 * 1000 * 1000),
    quality: numEnv(process.env.VQ_REVIEW_JPEG_Q, 4),
    timeoutMs: numEnv(process.env.VQ_REVIEW_SCALE_TIMEOUT_MS, 20000),
  },
  // 邮件通道（找回密码用）：后台「系统 → 邮件通道」保存后优先于环境变量；
  // 环境变量只是兜底，老部署不改也能用。口令只落在数据目录的 mail.json（0600）。
  mail: {
    host: (process.env.VQ_SMTP_HOST || '').trim(),
    port: Number(process.env.VQ_SMTP_PORT || 0),
    secure: process.env.VQ_SMTP_SECURE === '1',
    starttls: process.env.VQ_SMTP_STARTTLS !== '0',
    user: (process.env.VQ_SMTP_USER || '').trim(),
    pass: process.env.VQ_SMTP_PASS || '',
    fromName: (process.env.VQ_SMTP_FROM_NAME || '').trim(),
    fromAddress: (process.env.VQ_SMTP_FROM || '').trim(),
  },
  auth: {
    dbFile: path.join(dataDir, 'auth.db'),
    cookieName: 'vq_session',
    // 记住我 30 天，否则 7 天；服务端一律存哈希，cookie 只放随机 token
    rememberDays: Number(process.env.VQ_REMEMBER_DAYS || 30),
    sessionDays: Number(process.env.VQ_SESSION_DAYS || 7),
    // 生产必须为 1：走 HTTPS 时 cookie 带 Secure
    secureCookies: process.env.VQ_SECURE_COOKIES === '1',
    // 生产必须为 1：除 /api/auth/* 与健康检查外，所有 API 都要求登录
    requireAuth: process.env.VQ_REQUIRE_AUTH === '1',
    // 默认关闭（fail-closed）：只有显式写 VQ_REGISTRATION=1 才开放注册。
    // 以前是 !== '0'，环境变量漏配就变成任何人都能注册——公开站点上等于开了个免费入口。
    registrationEnabled: process.env.VQ_REGISTRATION === '1',
    // 管理员邮箱（逗号分隔）：这些账号可以看全部数据、发放积分。
    // 库里 kind='admin' 的账号等价；单账号部署启动时会自动把第一个账号提升为管理员。
    adminEmails: splitList(process.env.VQ_ADMIN_EMAILS).map((item) => item.toLowerCase()),
    // 部署引导账号：库里没有这个邮箱时建一条账号（还没有管理员时它是 kind=admin），只为「部署完能登录」。
    // 不叫演示账号了：口令不再下发给访客，界面上也没有任何演示标识。
    // 兼容旧键名 VQ_DEMO_*：老 .env 不用改也能继续用。
    seedAccount: Boolean((process.env.VQ_SEED_PASSWORD || process.env.VQ_DEMO_PASSWORD || '').trim()),
    seedEmail: (process.env.VQ_SEED_EMAIL || process.env.VQ_DEMO_EMAIL || '').trim().toLowerCase(),
    seedPassword: (process.env.VQ_SEED_PASSWORD || process.env.VQ_DEMO_PASSWORD || '').trim(),
    seedName: process.env.VQ_SEED_NAME || 'VisionQA 管理员',
  },
  // 邀请制：注册全局关闭时，持有有效邀请码的人仍可自助开号（内测不用管理员在线）。
  // 码是 bearer 凭证，只在签发那一次返回明文；库里存规范化后的码本身（不是高频敏感口令，不需要哈希）。
  invites: {
    defaultCredits: Number(process.env.VQ_INVITE_CREDITS ?? 100),
    defaultDays: Number(process.env.VQ_INVITE_DAYS ?? 7),
    defaultUses: Number(process.env.VQ_INVITE_USES ?? 1),
    // 反滥用：同一来源 24 小时内通过邀请码最多开几个号
    maxPerIp: Number(process.env.VQ_INVITE_IP_LIMIT ?? 3),
    ipWindowHours: 24,
  },
}

export const redfoxEnabled = () => Boolean(config.redfox.key)
// 模型是否已接入：环境变量里的旧凭证，或后台 Key 池里至少有一把 text/vision Key。
// Key 池是运行时增删的，所以这里每次调用都重新判断，不需要重启。
export const visionEnabled = () => Boolean(config.vision.apiKey) || vaultHas('text') || vaultHas('vision')
export const internalMode = () => config.ui.mode === 'internal'
