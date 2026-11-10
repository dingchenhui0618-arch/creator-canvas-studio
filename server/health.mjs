// 深度健康检查：回答「现在到底能不能干活」，而不是「环境变量有没有填」。
// 以前 /api/health 只看 key 在不在，key 过期、余额为 0、上游 DNS 挂了它都照样 ok:true。
// 这里逐项真探：数据库能查、数据目录能写、模板库能读、模型接口能连、红狐能连。
// 结果缓存 10 秒，避免界面刷新把上游探活打成刷屏。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, redfoxEnabled, visionEnabled } from './config.mjs'
import { openDb as getDb } from './auth.mjs'
import { templateStats } from './templates.mjs'

const CACHE_MS = 10000
let cached = null

const startedAt = Date.now()

async function timed(fn, { timeoutMs = 0 } = {}) {
  const started = Date.now()
  try {
    const detail = await fn()
    return { status: 'ok', detail, ms: Date.now() - started }
  } catch (error) {
    return { status: timeoutMs && error?.name === 'TimeoutError' ? 'warn' : 'fail', detail: String(error?.message || error), ms: Date.now() - started }
  }
}

function seconds(value) {
  return Math.round(value / 1000)
}

export async function deepHealth({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const checks = []

  checks.push({
    id: 'api',
    label: '服务进程',
    status: 'ok',
    detail: 'Node ' + process.version + ' · 已运行 ' + seconds(Date.now() - startedAt) + ' 秒 · 内存 ' + Math.round(process.memoryUsage().rss / 1048576) + 'MB',
    ms: 0,
  })

  checks.push({
    id: 'db',
    label: '账号与积分库',
    ...(await timed(async () => {
      const row = getDb().prepare('SELECT COUNT(*) AS users FROM users').get()
      const ledger = getDb().prepare('SELECT COUNT(*) AS rows FROM credit_ledger').get()
      return row.users + ' 个账号 · ' + ledger.rows + ' 条积分流水'
    })),
  })

  checks.push({
    id: 'disk',
    label: '数据目录读写',
    ...(await timed(async () => {
      await fsp.mkdir(config.dataDir, { recursive: true })
      const probe = path.join(config.dataDir, '.health-' + process.pid + '.tmp')
      await fsp.writeFile(probe, 'ok', 'utf8')
      await fsp.rm(probe, { force: true })
      let free = ''
      try {
        const stats = await fsp.statfs(config.dataDir)
        free = ' · 剩余 ' + Math.round((stats.bfree * stats.bsize) / 1073741824) + 'GB'
      } catch {
        free = ''
      }
      return config.dataDir + free
    })),
  })

  checks.push({
    id: 'templates',
    label: '模板库',
    ...(await timed(async () => {
      const stats = await templateStats()
      return '共 ' + stats.total + ' 条 · 已解析 ' + stats.parsed + ' · 待解析 ' + stats.saved
    })),
  })

  checks.push({
    id: 'vision',
    label: '模型接口',
    ...(visionEnabled()
      ? await timed(async () => {
          const response = await fetch(config.vision.baseUrl + '/models', {
            headers: { Authorization: 'Bearer ' + config.vision.apiKey },
            signal: AbortSignal.timeout(config.limits.probeTimeoutMs),
          })
          const text = await response.text()
          if (!response.ok) throw new Error('HTTP ' + response.status + ' · ' + text.slice(0, 120))
          let count = 0
          try {
            count = (JSON.parse(text).data || []).length
          } catch {
            count = 0
          }
          return config.vision.model + ' · 上游 ' + count + ' 个模型可用'
        })
      : { status: 'warn', detail: '未配置 VISION_API_KEY，评审与对话不可用', ms: 0 }),
  })

  checks.push({
    id: 'redfox',
    label: '红狐检索接口',
    ...(redfoxEnabled()
      ? await timed(async () => {
          const response = await fetch(config.redfox.baseUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(config.limits.probeTimeoutMs),
          })
          // 只要连上了（哪怕是 401/404）就说明 DNS/TLS/网络通路正常，key 是否有效由真实检索回报
          return config.redfox.baseUrl + ' · 可达（HTTP ' + response.status + '）'
        })
      : { status: 'warn', detail: '未配置 REDFOX_API_KEY，雷达走示例数据', ms: 0 }),
  })

  const failed = checks.filter((item) => item.status === 'fail').length
  const warned = checks.filter((item) => item.status === 'warn').length
  const value = {
    ok: failed === 0,
    status: failed ? 'fail' : warned ? 'warn' : 'ok',
    checkedAt: new Date().toISOString(),
    checks,
  }
  cached = { at: Date.now(), value }
  return value
}
