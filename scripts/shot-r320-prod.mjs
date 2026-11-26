// 生产真渲染（r320）：运营位由服务端下发 + 后台能编辑 + 动效铺到模板库。
//
// 生产侧临时签一个管理员会话（令牌只写文件 0600 → scp 回本机 → 脚本从文件读、不打印 →
// 拍完 destroySession 并跑 prod-shot-session-revoke-once.mjs 收尾）。只在无头浏览器里看，
// 不改任何数据、不发消息、不调上游。
//
// 要证明三件事：
//   1) 工作台顶上的运营位内容来自 GET /api/promos（把接口回的标题与 DOM 里的逐条比）；
//   2) 后台「系统 → 运营位」这张卡在生产上真的在，能读出条数与实时预览；
//   3) 动效铺到了模板库：网格 vq-stagger、卡片 vq-rise、transform 在过渡里。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SITE = process.env.LIVE_SITE || 'https://visionqa.wavisionai.cn'
const HOST = new URL(SITE).hostname
const TOKEN_FILE = process.env.LIVE_TOKEN_FILE || '.tmp-vq/prod-token'
const USER_FILE = process.env.LIVE_USER_FILE || '.tmp-vq/prod-user'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// 版本号只从 package.json 读：写死在脚本里的话，下一次 bump 就会变成假断言
const EXPECT_VERSION = process.env.SHOT_VERSION || JSON.parse(fs.readFileSync('package.json', 'utf8')).version

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
const userId = fs.existsSync(USER_FILE) ? fs.readFileSync(USER_FILE, 'utf8').trim() : ''
if (!token) throw new Error('没有读到临时会话令牌')

const { config: cfg } = await import('../server/config.mjs')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot320-prod-'))
const DEBUG_PORT = 9333

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore' })

async function waitFor(check, label, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try { const value = await check(); if (value) return value } catch { /* 还没起来 */ }
    await sleep(300)
  }
  throw new Error('等待超时：' + label)
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.errors = []
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params?.exceptionDetails?.text || 'exception')
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
  close() { try { this.ws.close() } catch { /* 已经关了 */ } }
}

let cdp = null
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result?.result?.value
}

async function open({ width, height, hash = '#/overview' }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: HOST, path: '/', httpOnly: true, secure: true })
  await cdp.send('Page.navigate', { url: SITE + '/?shot=' + Date.now() + hash })
  await sleep(4500)
  const guided = await evaluate("(() => { const el = document.querySelector('.vq-welcome, .vq-guide'); if (!el) return false; const btn = el.querySelector('button'); if (btn) btn.click(); return true })()")
  if (guided) await sleep(500)
  // 提示条是 React 管的节点：只隐藏，别删（r319 删过一次，React 抛 removeChild 把整页卸成白屏）
  await evaluate("(() => { const style = document.createElement('style'); style.textContent = '.vq-toast{display:none !important}'; document.head.appendChild(style); window.scrollTo(0, 0); return true })()")
}

async function waitForCount(selector, n, label, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const count = await evaluate('document.querySelectorAll(' + JSON.stringify(selector) + ').length')
    if (Number(count) >= n) return count
    await sleep(300)
  }
  throw new Error('等不到 ' + label + '（要 ' + n + ' 个）')
}

async function shoot(out) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB')
}

try {
  // 生产接口先回一次：工作台上那两条是不是接口给的，靠这个比
  const api = await fetch(SITE + '/api/promos', { headers: { cookie: cfg.auth.cookieName + '=' + token } }).then((r) => r.json())
  // 接口回的字段就是 promos；工作台一个位置最多显示 2 条（与 PromoSlot 的 max 一致），按权重取前两条
  const apiTitles = (api.promos || []).filter((item) => item.placement === 'overview').slice(0, 2).map((item) => item.title)
  console.log('生产 /api/promos：' + JSON.stringify({ slots: (api.promos || []).length, overview: apiTitles }))
  if (apiTitles.length !== 2) throw new Error('生产接口没有下发工作台运营位：' + JSON.stringify(api).slice(0, 300))

  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')

  // 1) 1440：生产账号自己的工作台
  await open({ width: 1440, height: 1000 })
  await waitForCount('.vq-promo', 2, '工作台运营位')
  const state = await evaluate("(() => { const promos = [...document.querySelectorAll('.vq-promo')]; const card = document.querySelector('.ov-cap'); const cs = card ? getComputedStyle(card) : null; const ver = (document.querySelector('.vq-side-version, .vq-version') || {}).textContent || ''; return { title: document.title, promoTitles: promos.map((el) => { const t = el.querySelector('.vq-promo-title'); return t ? t.textContent : '' }), animation: cs ? cs.animationName : '', transition: cs ? cs.transitionProperty : '', overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, version: ver.trim() } })()")
  console.log('1440 生产工作台：' + JSON.stringify(state))
  if (JSON.stringify(state.promoTitles) !== JSON.stringify(apiTitles)) throw new Error('页面上的运营位不是接口给的那两条：' + JSON.stringify(state.promoTitles) + ' vs ' + JSON.stringify(apiTitles))
  if (state.animation !== 'vq-rise') throw new Error('生产上的能力卡没走入场动画：' + state.animation)
  if (!String(state.transition).includes('transform')) throw new Error('生产上的卡片没有 transform 过渡：' + state.transition)
  if (state.overflow > 1) throw new Error('1440 横向溢出：' + state.overflow)
  if (!String(state.version).includes(EXPECT_VERSION)) throw new Error('侧栏没显示 v' + EXPECT_VERSION + '：' + state.version)
  await shoot(path.join('docs', 'r320-prod-workbench-1440.png'))

  // 2) 1440：模板库顶上的运营位 + 逐条进场
  await open({ width: 1440, height: 1150, hash: '#/templates' })
  await waitForCount('.vq-promo', 1, '模板库运营位')
  const tpl = await evaluate("(() => { const grid = document.querySelector('.template-grid'); const card = document.querySelector('.template-card'); const cs = card ? getComputedStyle(card) : null; return { promo: [...document.querySelectorAll('.vq-promo-title')].map((el) => el.textContent), gridClass: grid ? grid.className : '', animation: cs ? cs.animationName : '', transition: cs ? cs.transitionProperty : '', overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth } })()")
  console.log('1440 生产模板库：' + JSON.stringify(tpl))
  if (!String(tpl.gridClass).includes('vq-stagger')) throw new Error('生产上模板网格没有逐条进场的类：' + tpl.gridClass)
  if (tpl.animation !== 'vq-rise') throw new Error('生产上模板卡没走逐条进场：' + tpl.animation)
  if (tpl.overflow > 1) throw new Error('模板库 1440 横向溢出：' + tpl.overflow)
  await shoot(path.join('docs', 'r320-prod-templates-1440.png'))

  // 3) 1440：后台「系统 → 运营位」这张卡
  const admin = await fetch(SITE + '/api/admin/promos', { headers: { cookie: cfg.auth.cookieName + '=' + token } }).then((r) => r.json())
  console.log('生产 /api/admin/promos：' + JSON.stringify({ source: admin.source, count: (admin.promos || []).length, limits: admin.limits, placements: (admin.placements || []).map((p) => p.value) }))
  if (!admin.ok || !(admin.promos || []).length) throw new Error('生产后台读不到运营位：' + JSON.stringify(admin).slice(0, 200))
  await open({ width: 1440, height: 1300, hash: '#/admin/system' })
  await waitForCount('.admin-promo-row', admin.promos.length, '后台运营位行')
  await evaluate("(() => { const list = document.querySelector('.admin-promo-list'); const card = list ? list.closest('.admin-card') : null; if (card) card.scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); return true })()")
  await sleep(700)
  const cardState = await evaluate("(() => ({ rows: document.querySelectorAll('.admin-promo-row').length, badge: [...document.querySelectorAll('.admin-block-head .vq-pill')].map((el) => el.textContent).join(' / '), preview: (document.querySelector('.admin-promo-preview .vq-promo-title') || {}).textContent, dirs: [...document.querySelectorAll('.admin-promo-empty, .vq-promo-title')].length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()")
  console.log('1440 生产后台运营位卡：' + JSON.stringify(cardState))
  if (cardState.rows !== admin.promos.length) throw new Error('后台行数与接口不一致：' + cardState.rows + ' vs ' + admin.promos.length)
  if (cardState.preview !== admin.promos[0].title) throw new Error('实时预览不是第 1 条：' + cardState.preview)
  if (cardState.overflow > 1) throw new Error('后台 1440 横向溢出：' + cardState.overflow)
  await shoot(path.join('docs', 'r320-prod-admin-1440.png'))

  // 4) 390：窄屏重新载入工作台
  await open({ width: 390, height: 900 })
  await waitForCount('.vq-promo', 1, '工作台运营位（390）')
  const narrow = await evaluate("(() => ({ promos: document.querySelectorAll('.vq-promo').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: (document.querySelector('.vq-promo-body') || {}).textContent || '' }))()")
  console.log('390 生产：' + JSON.stringify(narrow))
  if (narrow.overflow > 1) throw new Error('390 横向溢出：' + narrow.overflow)
  if (!narrow.body) throw new Error('390 上运营位正文没了')
  await shoot(path.join('docs', 'r320-prod-workbench-390.png'))

  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
  if (cdp.errors.length) throw new Error('生产页面上抛异常了：' + cdp.errors[0])
  console.log('用户 id：' + userId)
} finally {
  cdp?.close()
  chrome.kill()
  await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* Windows 句柄收得慢 */ }
}
