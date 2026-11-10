#!/usr/bin/env node
// 积分制与多用户归属的端到端冒烟：本地起服务后跑一次，不消耗真实上游额度。
// 用法（需要 REDFOX_BASE_URL 指到 scripts/mock-redfox.mjs）：
//   BASE=http://127.0.0.1:18790 node scripts/test-credits.mjs
// 覆盖：注册即得初始积分 → 检索扣费 → 上游失败退款 → 余额不足 402 → 并发 429 →
//       模板归属隔离（A 存的 B 看不见）→ 管理员列表与发放积分 → 非管理员 403 →
//       SSRF 拦截（内网地址）→ 深度健康检查。
import http from 'node:http'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const BASE_URL = new URL(BASE)
const AT = String.fromCharCode(64)
const PASS = 'Abc12345'
const EMAIL1 = 'qa-credit-1' + AT + 'example.com'
const EMAIL2 = 'qa-credit-2' + AT + 'example.com'

let failed = 0
function check(name, ok, detail = '') {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  → ' + detail : ''))
}

function jar() {
  return { cookie: '' }
}

async function req(path, { method = 'GET', body, cookies } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookies?.cookie) headers.Cookie = cookies.cookie
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (cookies && typeof res.headers.getSetCookie === 'function') {
    const hit = res.headers.getSetCookie().find((item) => item.startsWith('vq_session='))
    if (hit) cookies.cookie = hit.split(';')[0]
  }
  return { status: res.status, json, text }
}

// fetch 会复用同一个 keep-alive 连接（等于串行），测不出并发闸门；并发用 node:http 各开一条连接
function rawGet(path, cookie) {
  return new Promise((resolve, reject) => {
    const options = {
      host: BASE_URL.hostname,
      port: BASE_URL.port,
      path,
      method: 'GET',
      headers: { Cookie: cookie, Connection: 'close' },
    }
    const request = http.request(options, (response) => {
      let body = ''
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        let json = null
        try {
          json = JSON.parse(body)
        } catch {
          json = null
        }
        resolve({ status: response.statusCode, json })
      })
    })
    request.on('error', reject)
    request.end()
  })
}

async function main() {
  const a = jar()
  const reg1 = await req('/api/auth/register', { method: 'POST', body: { email: EMAIL1, password: PASS, name: '积分一号' }, cookies: a })
  if (reg1.status === 409) {
    const relogin = await req('/api/auth/login', { method: 'POST', body: { email: EMAIL1, password: PASS }, cookies: a })
    check('账号已存在时可登录', relogin.status === 200, 'status=' + relogin.status)
  } else {
    check('注册成功并带初始积分', reg1.status === 201 && reg1.json?.user?.credits > 0, 'status=' + reg1.status + ' credits=' + reg1.json?.user?.credits)
  }

  const c0 = await req('/api/credits', { cookies: a })
  check('积分接口返回余额与单价', c0.status === 200 && typeof c0.json?.balance === 'number' && c0.json?.prices?.search > 0, 'balance=' + c0.json?.balance + ' search=' + c0.json?.prices?.search)
  const start = c0.json?.balance || 0
  const price = c0.json?.prices?.search || 0

  const s1 = await req('/api/search?q=' + encodeURIComponent('春季通勤') + '&platform=douyin', { cookies: a })
  check('检索成功并回传本次消耗', s1.status === 200 && s1.json?.credits?.cost === price, 'status=' + s1.status + ' cost=' + s1.json?.credits?.cost)
  check('检索后余额扣减', s1.json?.credits?.balance === start - price, 'before=' + start + ' after=' + s1.json?.credits?.balance)


  const item = { id: 'mock-1', url: 'https://www.douyin.com/video/1', title: 'mock 视频', platform: 'douyin', author: 'mock-author', stats: { plays: 1000, likes: 10, comments: 2, shares: 1, collects: 3 }, durationSec: 12 }
  const t1 = await req('/api/templates/from-radar', { method: 'POST', cookies: a, body: { item } })
  check('雷达加入模板库', t1.status === 201 || t1.status === 200, 'status=' + t1.status)
  const t1again = await req('/api/templates/from-radar', { method: 'POST', cookies: a, body: { item: { id: 'mock-1', url: 'https://www.douyin.com/video/1', title: 'mock 视频', platform: 'douyin' } } })
  check('同账号重复加入不新增', t1again.status === 200 && t1again.json?.created === false, 'status=' + t1again.status)

  const b2 = jar()
  const reg2 = await req('/api/auth/register', { method: 'POST', body: { email: EMAIL2, password: PASS, name: '积分二号' }, cookies: b2 })
  if (reg2.status === 409) await req('/api/auth/login', { method: 'POST', body: { email: EMAIL2, password: PASS }, cookies: b2 })
  const tplA = await req('/api/templates', { cookies: a })
  const tplB = await req('/api/templates', { cookies: b2 })
  check('模板按账号隔离', (tplA.json?.total || 0) >= 1 && (tplB.json?.total || 0) === 0, 'A=' + tplA.json?.total + ' B=' + tplB.json?.total)
  const tplIdA = tplA.json?.items?.[0]?.id
  const readB = await req('/api/templates/' + tplIdA, { cookies: b2 })
  check('跨账号读单条模板 404', readB.status === 404, 'status=' + readB.status)

  const usersB = await req('/api/admin/users', { cookies: b2 })
  check('非管理员访问管理接口 403', usersB.status === 403, 'status=' + usersB.status)
  const usersA = await req('/api/admin/users', { cookies: a })
  check('管理员能列真实账号', usersA.status === 200 && (usersA.json?.items || []).length >= 2, 'total=' + usersA.json?.total)
  const userB = (usersA.json?.items || []).find((item2) => item2.email === EMAIL2)
  check('账号列表带积分余额', Boolean(userB) && typeof userB.credits === 'number', 'credits=' + userB?.credits)

  const drain = await req('/api/admin/users/' + userB.id + '/credits', { method: 'POST', cookies: a, body: { amount: -((userB.credits || 0) - 1), note: '冒烟测试压到 1 分' } })
  check('管理员扣减积分', drain.status === 200 && drain.json?.balance === 1, 'balance=' + drain.json?.balance)
  const poor = await req('/api/search?q=' + encodeURIComponent('春季通勤'), { cookies: b2 })
  check('余额不足返回 402', poor.status === 402 && poor.json?.code === 'CREDIT_INSUFFICIENT', 'status=' + poor.status)
  const poorCredits = await req('/api/credits', { cookies: b2 })
  check('余额不足不扣费', poorCredits.json?.balance === 1, 'balance=' + poorCredits.json?.balance)

  const topup = await req('/api/admin/users/' + userB.id + '/credits', { method: 'POST', cookies: a, body: { amount: 50, note: '冒烟测试发放' } })
  check('管理员发放积分', topup.status === 200 && topup.json?.balance === 51, 'balance=' + topup.json?.balance)

  const burst = await Promise.all([
    rawGet('/api/search?q=slow', a.cookie),
    rawGet('/api/search?q=slow', a.cookie),
    rawGet('/api/search?q=slow', a.cookie),
  ])
  const limited = burst.filter((entry) => entry.status === 429).length
  check('并发闸门生效（至少 1 个 429）', limited >= 1, '429=' + limited + ' codes=' + burst.map((entry) => entry.status).join(','))

  const cover = await req('/api/cover?url=' + encodeURIComponent('http://127.0.0.1:18790/api/health'), { cookies: a })
  check('封面代理拒绝内网地址', cover.status === 404, 'status=' + cover.status)
  const beforeReview = (await req('/api/credits', { cookies: a })).json?.balance
  const review = await req('/api/review', { method: 'POST', cookies: a, body: { imageUrl: 'http://169.254.169.254/latest/meta-data/' } })
  const afterReview = (await req('/api/credits', { cookies: a })).json?.balance
  check('评审拒绝内网图片地址', review.status === 500 && /内网/.test(JSON.stringify(review.json)), 'status=' + review.status + ' err=' + String(review.json?.error || '').slice(0, 40))
  check('评审失败退积分', beforeReview === afterReview, 'before=' + beforeReview + ' after=' + afterReview)

  // 「Key 被禁用」这条放最后：红狐返回 3105 后，redfox.mjs 会全局冷却一段时间，
  // 提前跑会把后面所有检索都短路成示例数据，测不出真实扣费。
  const beforeDisabled = (await req('/api/credits', { cookies: a })).json?.balance
  const s2 = await req('/api/search?q=disabled', { cookies: a })
  const afterDisabled = (await req('/api/credits', { cookies: a })).json?.balance
  check('上游失败退积分', beforeDisabled === afterDisabled && /禁用/.test(String(s2.json?.note || '')), 'before=' + beforeDisabled + ' after=' + afterDisabled)

  const health = await req('/api/system/health', { cookies: a })
  const ids = (health.json?.checks || []).map((entry) => entry.id).join(',')
  check('深度健康检查返回逐项结果', health.status === 200 && (health.json?.checks || []).length >= 5, 'checks=' + ids)
  check('深度健康检查覆盖红狐与模型', (health.json?.checks || []).some((entry) => entry.id === 'redfox') && (health.json?.checks || []).some((entry) => entry.id === 'vision'), 'ids=' + ids)

  const ledger = await req('/api/credits?limit=50', { cookies: a })
  check('积分流水有检索与退款记录', (ledger.json?.ledger || []).length >= 2 && (ledger.json?.ledger || []).some((entry) => entry.kind === 'search-refund'), 'rows=' + (ledger.json?.ledger || []).length)

  console.log('')
  console.log(failed ? 'FAILED: ' + failed + ' 项' : 'ALL PASS')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error('冒烟脚本自身出错：' + (error?.stack || error))
  process.exit(2)
})
