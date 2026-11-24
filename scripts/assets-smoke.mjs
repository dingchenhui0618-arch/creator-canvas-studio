// 资产链路端到端冒烟（r311）：起一个临时实例，真的走一遍
// 「登录 → 看引导 → 选身份 → 传图 → 建资产 → 列表 → 删资产」。
//
// 为什么需要它：单测只证明模块能读写文件，证明不了「路由挂在正确的前缀上、登录门挡得住、
// 上传的素材能被资产引用」。这几步恰好是最容易在拼装时错的地方。
//
// 硬边界：**这一步绝不点生成**（POST /generate 会真花钱调上游）。
// 生成要由用户在自己账号上点；这里只验到 draft 为止。
//
// 用法：node scripts/assets-smoke.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = Number(process.env.SMOKE_PORT || 8901)
const BASE = 'http://127.0.0.1:' + PORT
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-assets-smoke-'))
const EMAIL = 'smoke@visionqa.local'
const PASSWORD = 'smoke-pass-123'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const env = {
  ...process.env,
  DATA_DIR: dir,
  // 服务端认的是 API_PORT（config.mjs），不是 PORT：写错了会连上本机正在跑的那个实例
  API_PORT: String(PORT),
  VQ_SEED_EMAIL: EMAIL,
  VQ_SEED_PASSWORD: PASSWORD,
  VQ_REQUIRE_AUTH: '1',
  VQ_UI_MODE: 'internal',
  // 检索与网关都别碰真上游：这轮只验资产
  VQ_REDFOX_DISABLED: '1',
  VQ_GATEWAY_ENABLED: '0',
}

const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', (chunk) => { log += chunk })
child.stderr.on('data', (chunk) => { log += chunk })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) throw new Error(name + (detail ? ' → ' + detail : ''))
}

async function waitHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(BASE + '/api/health')
      if (res.ok) return
    } catch {
      // 还没起来
    }
    await sleep(300)
  }
  throw new Error('临时实例没起来：\n' + log.slice(-1500))
}

let cookie = ''
async function api(pathname, init = {}) {
  const res = await fetch(BASE + pathname, {
    ...init,
    headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) },
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, headers: res.headers }
}

try {
  await waitHealth()
  check('实例健康', true)

  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  check('登录 200', login.status === 200, String(login.status) + ' ' + JSON.stringify(login.body).slice(0, 200))
  cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  check('拿到会话 cookie', cookie.includes('vq_session'), cookie ? 'cookie 形状不对' : '没有 cookie')

  const before = await api('/api/onboarding')
  check('引导接口通', before.status === 200, String(before.status))
  check('新账号 done=false', before.body.done === false)
  check('新账号 needs.identity=true', before.body.needs.identity === true)

  const bad = await api('/api/onboarding', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: '不存在' }),
  })
  check('非法身份被拒 400', bad.status === 400 && bad.body.code === 'ONBOARDING_IDENTITY', String(bad.status))

  const identity = await api('/api/onboarding', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'commerce', category: '服装', direction: '穿搭口播' }),
  })
  check('选身份 200', identity.status === 200 && identity.body.identity === 'commerce', JSON.stringify(identity.body).slice(0, 200))
  check('类目与方向落库', identity.body.category === '服装' && identity.body.direction === '穿搭口播')

  const upload = await api('/api/media/assets?name=白底图.png&width=1&height=1', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG,
  })
  check('上传素材 200', upload.status === 200 && upload.body.asset?.id, String(upload.status) + ' ' + JSON.stringify(upload.body).slice(0, 200))
  const sourceId = upload.body.asset.id

  const greedy = await api('/api/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'product', name: '空手', sourceAssetIds: [] }),
  })
  check('没有素材建资产被拒 400', greedy.status === 400 && greedy.body.code === 'ASSET_SOURCES', String(greedy.status))

  const created = await api('/api/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'product', name: '烟雾测试羊毛开衫', category: '服装', sourceAssetIds: [sourceId] }),
  })
  check('建资产 200', created.status === 200 && created.body.asset?.id, String(created.status) + ' ' + JSON.stringify(created.body).slice(0, 300))
  const asset = created.body.asset
  check('建完是 draft 且 0 张图', asset.status === 'draft' && asset.refs.length === 0)
  check('来源图挂上了', asset.sources.length === 1 && asset.sources[0].id === sourceId)

  const list = await api('/api/assets?kind=product')
  check('列表能看到这一套', list.status === 200 && list.body.items.some((item) => item.id === asset.id))
  check('上限与单价下发', list.body.limits?.product === 6 && list.body.limits?.paidCreditsPerImage > 0, JSON.stringify(list.body.limits))

  const after = await api('/api/onboarding')
  check('建完资产后 needs.asset=false', after.body.needs.asset === false && after.body.counts.product === 1, JSON.stringify(after.body.counts))

  const ref = await api('/api/assets/' + asset.id + '/files/hero')
  check('没生成过读图 404', ref.status === 404, String(ref.status))

  const done = await api('/api/onboarding/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skipAssets: false }),
  })
  check('引导收尾 200', done.status === 200 && done.body.done === true)

  const removed = await api('/api/assets/' + asset.id, { method: 'DELETE' })
  check('删资产 200', removed.status === 200 && removed.body.ok === true)
  const empty = await api('/api/assets')
  check('删完列表为空', empty.body.items.length === 0)

  // 未登录一律 401：资产是私人的，不能匿名读
  cookie = ''
  const anon = await api('/api/assets')
  check('未登录读资产 401', anon.status === 401, String(anon.status))

  for (const row of results) console.log((row.ok ? '✔ ' : '✖ ') + row.name + (row.detail ? ' · ' + row.detail : ''))
  console.log('\n全部通过：' + results.length + ' 项')
} catch (error) {
  for (const row of results) console.log((row.ok ? '✔ ' : '✖ ') + row.name + (row.detail ? ' · ' + row.detail : ''))
  console.error('\n冒烟失败：' + String(error?.message || error))
  console.error('实例日志尾部：\n' + log.slice(-2000))
  process.exitCode = 1
} finally {
  child.kill()
  // SQLite 的 WAL 文件在进程退出前还开着：等它真的走完再删目录，否则 Windows 上 EPERM
  await sleep(800)
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
