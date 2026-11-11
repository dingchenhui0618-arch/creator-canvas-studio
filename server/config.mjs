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
  limits: {
    maxVideoMb: Number(process.env.MAX_VIDEO_MB || 160),
    maxFrames: Number(process.env.MAX_FRAMES || 18),
    // 下载/探活类外部请求的超时：以前完全没设，一个不响应的源就能把进程挂住
    downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS || 120000),
    probeTimeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 3000),
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
    },
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
}

export const redfoxEnabled = () => Boolean(config.redfox.key)
// 模型是否已接入：环境变量里的旧凭证，或后台 Key 池里至少有一把 text/vision Key。
// Key 池是运行时增删的，所以这里每次调用都重新判断，不需要重启。
export const visionEnabled = () => Boolean(config.vision.apiKey) || vaultHas('text') || vaultHas('vision')
export const internalMode = () => config.ui.mode === 'internal'
