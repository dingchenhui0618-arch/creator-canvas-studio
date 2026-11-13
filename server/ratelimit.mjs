// 进程内限流：按「IP + 桶」做滑动窗口。
// 为什么要它：积分限制的是账号余额，挡不住同一台机器换号刷；上游额度被打光时，
// 最先撑不住的是检索与模型渠道，所以对最贵的那几个入口单独限速。
import { clientIp } from './auth.mjs'

const WINDOW_MS = 60 * 1000
const buckets = new Map()

const RULES = [
  { method: 'POST', match: (p) => p === '/api/search', bucket: 'search', limit: 20 },
  { method: 'POST', match: (p) => p === '/api/replicate', bucket: 'replicate', limit: 6 },
  { method: 'POST', match: (p) => p === '/api/review', bucket: 'review', limit: 10 },
  { method: 'POST', match: (p) => p === '/api/agents', bucket: 'agents', limit: 30 },
  { method: 'POST', match: (p) => /^\/api\/flows\/[\w-]+\/run$/.test(p), bucket: 'flow_run', limit: 6 },
  { method: 'POST', match: (p) => p === '/api/credits/request', bucket: 'credit_request', limit: 3 },
  // 平台出图通道（v0.9.79）：调用方是画布服务端，一次批量出图会连发。
  // 名额闸门管的是「同时几张」，这一条管的是「一分钟最多几次」——令牌泄露或画布死循环时，
  // 决定烧多少钱的是后一条。20 次/分钟对正常批量够用，脚本刷会被 429 挡住。
  { method: 'POST', match: (p) => p.startsWith('/api/gateway/'), bucket: 'gateway', limit: 20 },
  // 前端异常上报是公开接口：一个坏页面一屏就能连发几十条，按 IP 压到每分钟 30 条
  { method: 'POST', match: (p) => p === '/api/client-errors', bucket: 'client_error', limit: 30 },
  // 举报同样公开：一分钟 5 条足够正常人用，脚本会被挡住
  { method: 'POST', match: (p) => p === '/api/reports', bucket: 'report', limit: 5 },
  // 反馈也是公开入口：写一条反馈是低频动作，一分钟 3 条足够，连续刷会被 429
  { method: 'POST', match: (p) => p === '/api/feedback', bucket: 'feedback', limit: 3 },
]

// 每 5 分钟清一次过期桶，避免长期运行时 Map 无限长
setInterval(() => {
  const now = Date.now()
  for (const [key, hits] of buckets) {
    const alive = hits.filter((at) => now - at < WINDOW_MS)
    if (alive.length) buckets.set(key, alive)
    else buckets.delete(key)
  }
}, 5 * 60 * 1000).unref?.()

export function rateLimit(req, pathname, ip = '') {
  const rule = RULES.find((item) => item.method === req.method && item.match(pathname))
  if (!rule) return null
  const key = rule.bucket + '|' + (ip || clientIp(req) || 'unknown')
  const now = Date.now()
  const hits = (buckets.get(key) || []).filter((at) => now - at < WINDOW_MS)
  if (hits.length >= rule.limit) {
    const oldest = hits[0] || now
    return { bucket: rule.bucket, limit: rule.limit, retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)) }
  }
  hits.push(now)
  buckets.set(key, hits)
  return null
}

export function rateLimitRules() {
  return RULES.map((item) => ({ method: item.method, bucket: item.bucket, limit: item.limit }))
}
