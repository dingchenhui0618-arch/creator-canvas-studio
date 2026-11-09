import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  vision: {
    baseUrl: visionBaseUrl,
    model: (process.env.VISION_MODEL || '').trim() || 'deepseek-v4-flash-vision-exp',
    models: splitList(process.env.VISION_MODELS),
    fallbacks: splitList(process.env.VISION_FALLBACKS),
    timeoutMs: Number(process.env.VISION_TIMEOUT_MS || 300000),
    apiKey: (process.env.VISION_API_KEY || '').trim() || (visionBaseIsLocal ? readLocalToken() : ''),
  },
  limits: {
    maxVideoMb: Number(process.env.MAX_VIDEO_MB || 160),
    maxFrames: Number(process.env.MAX_FRAMES || 18),
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
    registrationEnabled: process.env.VQ_REGISTRATION !== '0',
    // 部署引导账号：库里没有这个邮箱时建一条普通账号（kind=account），只为「部署完能登录」。
    // 不叫演示账号了：口令不再下发给访客，界面上也没有任何演示标识。
    // 兼容旧键名 VQ_DEMO_*：老 .env 不用改也能继续用。
    seedAccount: Boolean((process.env.VQ_SEED_PASSWORD || process.env.VQ_DEMO_PASSWORD || '').trim()),
    seedEmail: (process.env.VQ_SEED_EMAIL || process.env.VQ_DEMO_EMAIL || '').trim().toLowerCase(),
    seedPassword: (process.env.VQ_SEED_PASSWORD || process.env.VQ_DEMO_PASSWORD || '').trim(),
    seedName: process.env.VQ_SEED_NAME || 'VisionQA 管理员',
  },
}

export const redfoxEnabled = () => Boolean(config.redfox.key)
export const visionEnabled = () => Boolean(config.vision.apiKey)
