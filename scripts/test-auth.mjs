// 账号体系端到端自检：起一个临时实例（独立端口 + 独立 DATA_DIR），跑完真实 HTTP 流程再清理。
// 用法：node scripts/test-auth.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 8799
const BASE = 'http://127.0.0.1:' + PORT
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-auth-'))
let child = null
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -> ' + detail : ''))
}

async function waitHealth(timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE + '/api/health')
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

function cookieFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  const first = raw.find((c) => c.startsWith('vq_session=')) || ''
  return first.split(';')[0]
}

async function call(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (cookie) headers.Cookie = cookie
  const res = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, json, cookie: cookieFrom(res) }
}

async function main() {
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(PORT),
      DATA_DIR: dataDir,
      VQ_REQUIRE_AUTH: '1',
      VQ_DEMO_ACCOUNT: '1',
      VQ_REGISTRATION: '1',
      VQ_SECURE_COOKIES: '0',
    },
    stdio: 'ignore',
  })

  const up = await waitHealth()
  record('服务启动 /api/health', up)
  if (!up) throw new Error('服务没起来')

  const cfg = await call('/api/auth/config')
  record('GET /api/auth/config 200 且带演示账号', cfg.status === 200 && cfg.json?.demoAccount?.email, JSON.stringify(cfg.json?.demoAccount?.email || ''))

  // 未登录访问受保护接口
  const gated = await call('/api/templates')
  record('未登录访问 /api/templates 返回 401', gated.status === 401 && gated.json?.loginRequired === true, 'status=' + gated.status)

  // 演示账号真登录
  const demo = cfg.json.demoAccount
  const demoLogin = await call('/api/auth/login', { method: 'POST', body: { email: demo.email, password: demo.password, remember: false } })
  record('演示账号能真登录', demoLogin.status === 200 && !!demoLogin.cookie, 'status=' + demoLogin.status)

  // 错误密码
  const bad = await call('/api/auth/login', { method: 'POST', body: { email: demo.email, password: 'wrong-password-1' } })
  record('错误密码返回 401 且 field=form', bad.status === 401 && bad.json?.field === 'form', 'status=' + bad.status + ' field=' + bad.json?.field)

  // 邮箱不存在不泄露
  const unknown = await call('/api/auth/login', { method: 'POST', body: { email: 'nobody-here@example.com', password: 'whatever-123' } })
  record('不存在的邮箱与密码错同样 401', unknown.status === 401 && unknown.json?.field === 'form')

  // 注册
  const email = 'e2e-' + Date.now() + '@example.com'
  const reg = await call('/api/auth/register', { method: 'POST', body: { email, password: 'good-password-9', name: '端到端' } })
  record('注册返回 201 并直接下发会话', reg.status === 201 && !!reg.cookie && reg.json?.user?.email === email, 'status=' + reg.status)

  const dup = await call('/api/auth/register', { method: 'POST', body: { email, password: 'good-password-9' } })
  record('重复注册返回 409 field=email', dup.status === 409 && dup.json?.field === 'email', 'status=' + dup.status)

  const weak = await call('/api/auth/register', { method: 'POST', body: { email: 'weak-' + Date.now() + '@example.com', password: '123' } })
  record('弱密码被拒 400 field=password', weak.status === 400 && weak.json?.field === 'password', 'status=' + weak.status)

  // 带 cookie 访问受保护接口
  const me = await call('/api/auth/me', { cookie: reg.cookie })
  record('GET /api/auth/me 用注册 cookie 返回用户', me.status === 200 && me.json?.user?.email === email, 'status=' + me.status)

  const allowed = await call('/api/templates', { cookie: reg.cookie })
  record('登录后访问 /api/templates 放行', allowed.status === 200, 'status=' + allowed.status)

  // 登出
  const out = await call('/api/auth/logout', { method: 'POST', cookie: reg.cookie })
  record('登出返回 204', out.status === 204, 'status=' + out.status)
  const afterOut = await call('/api/auth/me', { cookie: reg.cookie })
  record('登出后旧 cookie 失效', afterOut.status === 401, 'status=' + afterOut.status)

  // 会话在库里的形态：只存哈希，不存明文 token。
  // 注意 SQLite 开了 WAL，新写入先落在 auth.db-wal，所以要把整套文件一起看。
  const token = decodeURIComponent(reg.cookie.replace('vq_session=', ''))
  const dbBlob = ['auth.db', 'auth.db-wal', 'auth.db-shm']
    .map((name) => {
      try {
        return fs.readFileSync(path.join(dataDir, name))
      } catch {
        return Buffer.alloc(0)
      }
    })
    .reduce((acc, buf) => Buffer.concat([acc, buf]), Buffer.alloc(0))
  const asText = dbBlob.toString('latin1')

  record('数据库里查不到明文会话 token', !dbBlob.includes(Buffer.from(token)), 'token 长度 ' + token.length)
  record('数据库里没有明文密码 good-password-9', !asText.includes('good-password-9'))
  record('口令用 scrypt 存储', asText.includes('scrypt$'))
}

try {
  await main()
} catch (error) {
  record('未捕获异常', false, String(error?.message || error))
} finally {
  if (child) child.kill()
  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
  } catch {}
  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(failed.length === 0 ? '全部通过：' + results.length + ' 项' : '失败 ' + failed.length + ' / ' + results.length + ' 项')
  process.exit(failed.length === 0 ? 0 : 1)
}
