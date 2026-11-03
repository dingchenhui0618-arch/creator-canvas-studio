// BD Canvas 部署自检：只探测端口与后台登录接口，不写任何凭据
// 用法：node scripts/check-bdc.mjs   （可用 BDC_ADMIN_USER / BDC_ADMIN_PASS 顺带验证登录）
const WEB = process.env.BDC_WEB_URL || 'http://127.0.0.1:6677'
const ADMIN = process.env.BDC_ADMIN_URL || 'http://127.0.0.1:5313'
const API = process.env.BDC_API_URL || 'http://127.0.0.1:5312'

async function probe(label, url, timeout = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    return { label, url, ok: response.ok, status: response.status }
  } catch (error) {
    return { label, url, ok: false, status: 0, error: String(error?.message || error).slice(0, 60) }
  }
}

const rows = await Promise.all([
  probe('后端 5312', API),
  probe('后台管理 5313', ADMIN + '/admin/'),
  probe('网页入口 6677', WEB),
])

let loginOk = null
if (process.env.BDC_ADMIN_USER && process.env.BDC_ADMIN_PASS) {
  try {
    const response = await fetch(ADMIN + '/enterprise/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: process.env.BDC_ADMIN_USER, password: process.env.BDC_ADMIN_PASS }),
      signal: AbortSignal.timeout(4000),
    })
    const json = await response.json().catch(() => ({}))
    loginOk = { status: response.status, hasToken: Boolean(json?.token) }
  } catch (error) {
    loginOk = { status: 0, error: String(error?.message || error).slice(0, 60) }
  }
}

for (const row of rows) {
  console.log((row.ok ? '[ OK ]' : '[MISS]') + ' ' + row.label + '  ' + row.url + (row.ok ? '  HTTP ' + row.status : row.error ? '  ' + row.error : ''))
}
if (loginOk) console.log('[AUTH] admin login -> ' + JSON.stringify(loginOk))

const deployed = rows[0].ok || rows[2].ok
console.log('')
console.log(deployed ? 'BD Canvas 已在本机运行，工作台画布页会出现接入条。' : 'BD Canvas 未运行：需要先把源码包解压到 D:\\Projects\\bd-canvas 并按 docs/bd-canvas-integration.md 部署。')
process.exitCode = deployed ? 0 : 1
