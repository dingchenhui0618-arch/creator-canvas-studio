// 上线验收脚本（只读）：按环境核对公开面、接口与生产语言。
// 用法：
//   VQ_COOKIE=<会话 cookie> node scripts/acceptance.mjs
//   VQ_SCOPE=internal VQ_BASE=http://127.0.0.1:8801 VQ_COOKIE=<cookie> node scripts/acceptance.mjs
// 不带 cookie 时只跑匿名检查；脚本不写任何数据，不发起扣费请求。
const scope = String(process.env.VQ_SCOPE || 'prod').toLowerCase()
const base = String(process.env.VQ_BASE || 'https://visionqa.wavisionai.cn').replace(/\/+$/, '')
// VQ_COOKIE 可以给整条 Cookie 头，也可以只给会话 token（脚本自动补 vq_session= 前缀）
const rawCookie = String(process.env.VQ_COOKIE || '').trim()
const cookie = rawCookie ? (rawCookie.startsWith('vq_session=') ? rawCookie : 'vq_session=' + rawCookie) : ''

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -> ' + detail : ''))
}
async function call(path, { withCookie = false, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' }
  if (body) headers['Content-Type'] = 'application/json'
  if (withCookie && cookie) headers.Cookie = cookie
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}
const has = (json, key) => Object.prototype.hasOwnProperty.call(json || {}, key)
const banned = (text) => ['deepseek', 'openai', 'anthropic', 'node v', 'sqlite', '127.0.0.1', '/var/lib/', 'pid ', 'http 5', 'http 4'].filter((word) => String(text || '').toLowerCase().includes(word))

async function runProd() {
  const anonModels = await call('/api/models')
  check('匿名拿不到模型清单', anonModels.status === 401 && anonModels.json?.loginRequired === true, String(anonModels.status))
  const anonVersion = await call('/api/version')
  check('匿名版本只回产品名与版本', anonVersion.status === 200 && anonVersion.json?.name === 'VisionQA' && !has(anonVersion.json, 'startedAt'), JSON.stringify(anonVersion.json))
  const anonHealth = await call('/api/health')
  check('匿名健康检查不含模型标识', anonHealth.status === 200 && !has(anonHealth.json, 'visionModel') && !has(anonHealth.json, 'llmModel'), JSON.stringify(anonHealth.json))
  const anonApp = await call('/api/app')
  check('环境口径为生产', anonApp.status === 200 && anonApp.json?.mode === 'prod' && anonApp.json?.internal === false, JSON.stringify(anonApp.json))

  if (!cookie) {
    console.log('（未提供 VQ_COOKIE，跳过登录后检查）')
    return
  }

  const models = await call('/api/models', { withCookie: true })
  const labels = (models.json?.models || []).map((item) => item.label)
  check('登录后模型清单可用且用产品名', models.status === 200 && labels.length > 0 && labels.every((label) => label.startsWith('VisionQA')), JSON.stringify(labels))
  const version = await call('/api/version', { withCookie: true })
  check('登录后版本带启动时间', version.status === 200 && typeof version.json?.startedAt === 'string', JSON.stringify(version.json))

  const credits = await call('/api/credits', { withCookie: true })
  check('积分接口返回余额与单价', credits.status === 200 && typeof credits.json?.balance === 'number' && credits.json?.prices?.chat >= 0, 'balance=' + credits.json?.balance)
  const preferences = await call('/api/preferences', { withCookie: true })
  check('模型偏好接口可用', preferences.status === 200, String(preferences.status))
  for (const [path, name, key] of [
    ['/api/templates', '模板库', 'items'],
    ['/api/agents', '智能体列表', 'items'],
    ['/api/flows', '画布流程', 'items'],
    ['/api/runs', '运行记录', 'items'],
    ['/api/reviews', '评审历史', 'items'],
  ]) {
    const res = await call(path + '?limit=1', { withCookie: true })
    check(name + '接口可用', res.status === 200 && Array.isArray(res.json?.[key]), String(res.status))
  }

  const billing = await call('/api/billing/overview', { withCookie: true })
  check('充值仍是未开通占位', billing.status === 200 && billing.json?.enabled === false && Array.isArray(billing.json?.plans) && billing.json.plans.length === 0, JSON.stringify(billing.json?.message))
  const orders = await call('/api/billing/orders', { withCookie: true })
  check('充值订单为空列表', orders.status === 200 && Array.isArray(orders.json?.items) && orders.json.items.length === 0, String(orders.status))
  const order = await call('/api/billing/orders', { withCookie: true, method: 'POST', body: { planId: 'qa' } })
  check('创建充值订单返回 501', order.status === 501 && order.json?.code === 'BILLING_NOT_CONFIGURED', String(order.status))
  const badOrder = await call('/api/billing/orders', { withCookie: true, method: 'POST', body: {} })
  check('缺少档位返回 400', badOrder.status === 400, String(badOrder.status))

  const health = await call('/api/system/health', { withCookie: true })
  const rows = health.json?.checks || []
  const labelsOk = rows.every((row) => !banned(JSON.stringify(row)).length)
  check('深度健康六项且全是产品语言', health.status === 200 && rows.length === 6 && labelsOk, rows.map((row) => row.label + '=' + row.status).join(' '))
  const service = await call('/api/system/service', { withCookie: true })
  const serviceKeys = Object.keys(service.json?.model || {})
  check('服务状态只回生产字段', service.status === 200 && serviceKeys.includes('available') && serviceKeys.includes('message') && serviceKeys.includes('retryAfterSec') && !serviceKeys.includes('detail') && !serviceKeys.includes('upstream') && !serviceKeys.includes('code'), serviceKeys.join(','))
  if (service.json?.model?.available) {
    check('服务状态文案用产品语言', !banned(service.json.model.message).length, service.json.model.message)
  }

  for (const [path, name] of [
    ['/api/admin/users?limit=1', '后台账号'],
    ['/api/admin/storage', '后台存储'],
    ['/api/admin/audit?limit=1', '后台操作日志'],
  ]) {
    const res = await call(path, { withCookie: true })
    check(name + '接口可用', res.status === 200, String(res.status))
  }
  const diagnostics = await call('/api/admin/diagnostics', { withCookie: true })
  check('生产排查接口返回 404', diagnostics.status === 404, String(diagnostics.status))
  const webRead = await call('/api/admin/tools/web-read', { withCookie: true, method: 'POST', body: { url: 'https://example.com' } })
  check('生产网页读取自检返回 404', webRead.status === 404, String(webRead.status))
  const bdc = await call('/api/bdc/status', { withCookie: true })
  check('画布服务状态可读', bdc.status === 200 && typeof bdc.json?.deployed === 'boolean', JSON.stringify(bdc.json))
}

async function runInternal() {
  const app = await call('/api/app')
  check('环境口径为内部测试', app.status === 200 && app.json?.mode === 'internal' && app.json?.internal === true, JSON.stringify(app.json))
  const models = await call('/api/models')
  check('内部匿名同样拿不到模型清单', models.status === 401, String(models.status))
  const version = await call('/api/version')
  check('内部匿名版本保留包名、不暴露启动时间', version.status === 200 && version.json?.name === 'creator-canvas-studio' && !has(version.json, 'startedAt'), JSON.stringify(version.json))
  const health = await call('/api/health')
  check('内部健康检查保留模型标识', health.status === 200 && typeof health.json?.visionModel === 'string', JSON.stringify(health.json))
  if (!cookie) {
    console.log('（未提供 VQ_COOKIE，跳过登录后检查）')
    return
  }
  const diagnostics = await call('/api/admin/diagnostics', { withCookie: true })
  check('内部排查信息可读', diagnostics.status === 200 && diagnostics.json?.process?.node && diagnostics.json?.config?.models?.chat, String(diagnostics.status))
  const service = await call('/api/system/service', { withCookie: true })
  const keys = Object.keys(service.json?.model || {})
  check('内部服务状态带排障字段', service.status === 200 && keys.includes('code') && keys.includes('detail') && keys.includes('upstream'), keys.join(','))
  const modelsAuth = await call('/api/models', { withCookie: true })
  check('内部登录后模型清单可用', modelsAuth.status === 200 && (modelsAuth.json?.models || []).length > 0, String(modelsAuth.status))
  const webRead = await call('/api/admin/tools/web-read', { withCookie: true, method: 'POST', body: { url: 'https://example.com' } })
  check('内部网页读取自检可用', webRead.status === 200 && webRead.json?.ok === true, JSON.stringify(webRead.json).slice(0, 160))
}

try {
  await (scope === 'internal' ? runInternal() : runProd())
} catch (error) {
  check('验收脚本执行', false, String(error?.message || error))
}
const failed = results.filter((item) => !item.ok)
console.log('SUMMARY ' + (results.length - failed.length) + '/' + results.length + (failed.length ? ' FAILED: ' + failed.map((item) => item.name).join(' | ') : ''))
process.exitCode = failed.length ? 1 : 0
