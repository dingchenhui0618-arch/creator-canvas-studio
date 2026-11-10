// 深度健康检查：回答「现在到底能不能干活」，而不是「环境变量有没有填」。
// 以前 /api/health 只看 key 在不在，key 过期、余额为 0、上游 DNS 挂了它都照样 ok:true。
// 这里逐项真探：数据库能查、数据目录能写、模板库能读、模型接口能连、红狐能连。
// 结果缓存 10 秒，避免界面刷新把上游探活打成刷屏。
//
// 生产环境这一页也会给普通用户看：同样的检查，但只输出产品语言（不带路径、Node 版本、
// 上游域名或原始报错）；内部测试环境保留原始信息用于排障。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, internalMode, redfoxEnabled, visionEnabled } from './config.mjs'
import { openDb as getDb } from './auth.mjs'
import { templateStats } from './templates.mjs'
import { modelServiceState } from './service-state.mjs'

const CACHE_MS = 10000
let cached = null

const startedAt = Date.now()
const isInternal = () => internalMode()
const pick = (internalText, prodText) => (isInternal() ? internalText : prodText)

async function timed(fn, { timeoutMs = 0, failure = '暂时不可用' } = {}) {
  const started = Date.now()
  try {
    const detail = await fn()
    return { status: 'ok', detail, ms: Date.now() - started }
  } catch (error) {
    const raw = String(error?.message || error)
    return {
      status: timeoutMs && error?.name === 'TimeoutError' ? 'warn' : 'fail',
      detail: isInternal() ? raw : failure,
      ms: Date.now() - started,
    }
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
    label: pick('服务进程', '服务运行'),
    status: 'ok',
    detail: pick(
      'Node ' + process.version + ' · 已运行 ' + seconds(Date.now() - startedAt) + ' 秒 · 内存 ' + Math.round(process.memoryUsage().rss / 1048576) + 'MB',
      '运行正常',
    ),
    ms: 0,
  })

  checks.push({
    id: 'db',
    label: pick('账号与积分库', '账号与积分'),
    ...(await timed(
      async () => {
        const row = getDb().prepare('SELECT COUNT(*) AS users FROM users').get()
        const ledger = getDb().prepare('SELECT COUNT(*) AS rows FROM credit_ledger').get()
        return pick(row.users + ' 个账号 · ' + ledger.rows + ' 条积分流水', '账号与积分数据可读')
      },
      { failure: '账号与积分数据暂时不可用' },
    )),
  })

  checks.push({
    id: 'disk',
    label: pick('数据目录读写', '数据存储'),
    ...(await timed(
      async () => {
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
        return pick(config.dataDir + free, '可读写' + free)
      },
      { failure: '存储暂时不可用' },
    )),
  })

  checks.push({
    id: 'templates',
    label: '模板库',
    ...(await timed(
      async () => {
        const stats = await templateStats()
        return pick(
          '共 ' + stats.total + ' 条 · 已解析 ' + stats.parsed + ' · 待解析 ' + stats.saved,
          '共 ' + stats.total + ' 条模板',
        )
      },
      { failure: '模板库暂时不可用' },
    )),
  })

  // 模型服务：/models 能连通只说明接口通，账号余额为 0 时真实调用仍然 402。
  // 先看最近一次真实调用的结果，再决定要不要探活——避免「显示可用、一用就失败」。
  const modelState = modelServiceState()
  if (visionEnabled() && !modelState.available) {
    checks.push({
      id: 'vision',
      label: pick('模型接口', '模型服务'),
      status: 'fail',
      detail: pick(modelState.internalDetail, '暂时不可用'),
      ...(isInternal() ? { code: modelState.code } : {}),
      ms: 0,
    })
  } else {
    checks.push({
      id: 'vision',
      label: pick('模型接口', '模型服务'),
      ...(visionEnabled()
        ? await timed(
            async () => {
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
              return pick('上游 ' + count + ' 个模型可用', count ? count + ' 个模型可用' : '模型服务可用')
            },
            { timeoutMs: config.limits.probeTimeoutMs, failure: '模型服务暂时不可用' },
          )
        : { status: 'warn', detail: pick('模型服务未接入，评审与对话不可用', '模型服务未开通'), ms: 0 }),
    })
  }

  checks.push({
    id: 'redfox',
    label: '检索服务',
    ...(redfoxEnabled()
      ? await timed(
          async () => {
            const response = await fetch(config.redfox.baseUrl, {
              method: 'GET',
              signal: AbortSignal.timeout(config.limits.probeTimeoutMs),
            })
            // 只要连上了（哪怕是 401/404）就说明 DNS/TLS/网络通路正常，key 是否有效由真实检索回报
            // 详情里不带上游域名：设置页是用户可见页面，只报「通不通」
            return pick('可达（HTTP ' + response.status + '）', '已连通')
          },
          { timeoutMs: config.limits.probeTimeoutMs, failure: '检索服务暂时不可用' },
        )
      : { status: 'warn', detail: pick('检索服务未接入，雷达走示例数据', '检索服务未开通'), ms: 0 }),
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
