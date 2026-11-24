// 真实后端截图（r311）：起一个临时实例、真建账号、真开会话、真渲染，再按视口截图。
//
// 为什么不用「固定响应」截图：那只能证明组件长得对，证明不了路由、登录门、接口形状真的对得上。
// 这一支把服务器一起拉起来，截出来的就是产品现在的样子。
//
// 会话不走登录接口，而是直接 createSession 拿 token 再灌进浏览器 cookie：
// 少一次往返就少一个不确定因素，登录本身另有 scripts/assets-smoke.mjs 在验。
//
// 边界：**不点任何生成**（会花钱）。所以图里资产是草稿 / 空状态，出图后的样子要真调才有。
//
// 用法：node scripts/shot-real.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 端口先挑一个没人应答的：上一次没退干净的实例还占着端口时，健康检查会打到它，
// 于是「新实例的账号」在「旧实例的库」里查不到，报出来的错是「密码不正确」——极难排查。
async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const alive = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(600) })
      .then(() => true)
      .catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口')
}

const API_PORT = await freePort(Number(process.env.SMOKE_PORT || 8931))
const DEBUG_PORT = await freePort(API_PORT + 50)
const BASE = 'http://127.0.0.1:' + API_PORT

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot-profile-'))
process.env.DATA_DIR = dataDir

const ADMIN_EMAIL = '[EMAIL:CD9BB9]'
const USER_EMAIL = '[EMAIL:6818EB]'
const FRESH_EMAIL = '[EMAIL:2B9B39]'
const PASSWORD = 'shot-pass-123'

// 必须先有一个管理员：ensureAnAdmin 会把「库里唯一那个账号」提成管理员，
// 顺序反了那个普通账号就会变成 admin，引导弹窗永远不出现。
const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')
createUser({ email: ADMIN_EMAIL, password: PASSWORD, name: '运营管理员', kind: 'admin' })
const user = createUser({ email: USER_EMAIL, password: PASSWORD, name: '林可' })
const fresh = createUser({ email: FRESH_EMAIL, password: PASSWORD, name: '新注册用户' })
const tokens = {
  [user.id]: createSession(user, {}).token,
  [fresh.id]: createSession(fresh, {}).token,
}
console.log('临时实例 · 数据目录 ' + dataDir + ' · 端口 ' + API_PORT)

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, DATA_DIR: dataDir, API_PORT: String(API_PORT), VQ_REQUIRE_AUTH: '1', VQ_REDFOX_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (chunk) => { serverLog += chunk })
server.stderr.on('data', (chunk) => { serverLog += chunk })

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' })

async function waitFor(check, label) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if (await check()) return
    } catch {
      // 还没起来
    }
    await sleep(300)
  }
  throw new Error('等待超时：' + label)
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    })
    this.ready = new Promise((resolve) => this.ws.addEventListener('open', resolve))
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() {
    try { this.ws.close() } catch { /* 已经关了 */ }
  }
}

let cdp = null

async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.text() }
}

async function shoot({ userId, route, out, width, height, prepare }) {
  await cdp.send('Network.clearBrowserCookies')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Network.setCookie', {
    name: cfg.auth.cookieName,
    value: tokens[userId],
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
  })
  if (prepare) await prepare()
  // 「欢迎使用 VisionQA」那层上手引导是按账号记 local storage 的：截图里先标成看过，
  // 否则它会盖住要拍的那一页（真实用户第一次确实会看到，这里只想拍底下那一层）
  const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + userId + "','1')}catch(e){}",
  })
  // 换个账号要整页重载：只改 hash 是同文档导航，React 里还留着上一个人的会话
  await cdp.send('Page.navigate', { url: BASE + '/?as=' + encodeURIComponent(userId) + '#/' + route })
  await sleep(2800)
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier })
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + width + '×' + height + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB · #' + route)
}

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  // 确认应答的就是我们刚起的那个实例：库里的账号必须认这个会话
  const me = await api('/api/auth/me', { token: tokens[user.id] })
  if (me.status !== 200) throw new Error('会话不被这个实例识别（可能连到了别的进程）：' + me.status + ' ' + me.body.slice(0, 120))

  let target = null
  await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    target = (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
    return Boolean(target)
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')

  // A 组：没做过引导的账号 → 引导弹窗第 1 步（选身份）
  await shoot({ userId: fresh.id, route: '/overview', out: path.join('docs', 'r311-onboarding-1440.png'), width: 1440, height: 900 })
  await shoot({ userId: fresh.id, route: '/overview', out: path.join('docs', 'r311-onboarding-390.png'), width: 390, height: 844 })

  // B 组：引导做完、还没有资产的账号 → 资产库空状态
  const prepared = await api('/api/onboarding', { token: tokens[user.id], method: 'PUT', body: { identity: 'commerce', category: '服装', direction: '穿搭口播' } })
  if (prepared.status !== 200) throw new Error('写身份失败：' + prepared.status + ' ' + prepared.body.slice(0, 160))
  const completed = await api('/api/onboarding/complete', { token: tokens[user.id], method: 'POST', body: { skipAssets: false } })
  if (completed.status !== 200) throw new Error('引导收尾失败：' + completed.status + ' ' + completed.body.slice(0, 160))

  await shoot({ userId: user.id, route: '/assets', out: path.join('docs', 'r311-assets-1440.png'), width: 1440, height: 900 })
  await shoot({ userId: user.id, route: '/assets', out: path.join('docs', 'r311-assets-390.png'), width: 390, height: 844 })

  console.log('全部截图完成（真实后端 / 真实会话 / 未调上游）')
} catch (error) {
  console.error('截图失败：' + String(error?.message || error))
  console.error(serverLog.slice(-1200))
  process.exitCode = 1
} finally {
  if (cdp) cdp.close()
  chrome.kill()
  server.kill()
  await sleep(1500)
  for (const dir of [profile, dataDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
    } catch {
      console.warn('临时目录没删干净：' + dir)
    }
  }
}
