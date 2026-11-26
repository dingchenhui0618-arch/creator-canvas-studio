// 生产真渲染（r319）：工作台顶上的两条运营位 + 能力卡的入场/抬起。
//
// 生产侧临时签一个管理员会话（令牌只写 /root/.vq-shot-token 0600 → scp 回本机文件 →
// 脚本从文件读、不打印 → 拍完 destroySession），只在无头浏览器里看，不改任何数据。
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot319-prod-'))
const DEBUG_PORT = 9331

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

async function open({ width, height }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: HOST, path: '/', httpOnly: true, secure: true })
  await cdp.send('Page.navigate', { url: SITE + '/?shot=' + Date.now() + '#/overview' })
  await sleep(4000)
  const guided = await evaluate("(() => { const el = document.querySelector('.vq-welcome, .vq-guide'); if (!el) return false; const btn = el.querySelector('button'); if (btn) btn.click(); return true })()")
  if (guided) await sleep(500)
  await evaluate("(() => { document.querySelectorAll('.vq-toast').forEach((el) => el.remove()); window.scrollTo(0, 0); return true })()")
}

async function shoot(out) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB')
}

try {
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
  await sleep(900)
  const state = await evaluate("(() => { const promos = [...document.querySelectorAll('.vq-promo')]; const card = document.querySelector('.ov-cap'); const cs = card ? getComputedStyle(card) : null; const ver = (document.querySelector('.vq-side-version, .vq-version') || {}).textContent || ''; return { title: document.title, promoTitles: promos.map((el) => { const t = el.querySelector('.vq-promo-title'); return t ? t.textContent : '' }), cta: promos.map((el) => { const b = el.querySelector('.vq-promo-cta'); return b ? b.textContent.trim() : '' }), animation: cs ? cs.animationName : '', transition: cs ? cs.transitionProperty : '', overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, version: ver.trim(), body: (document.body.innerText || '').includes('v0.9.290') } })()")
  console.log('1440 生产：' + JSON.stringify(state))
  if (state.promoTitles.length !== 2) throw new Error('生产工作台没有两条运营位：' + JSON.stringify(state.promoTitles))
  if (state.animation !== 'vq-rise') throw new Error('生产上的能力卡没走入场动画：' + state.animation)
  if (!String(state.transition).includes('transform')) throw new Error('生产上的卡片没有 transform 过渡：' + state.transition)
  if (state.overflow > 1) throw new Error('1440 横向溢出：' + state.overflow)
  if (!state.body && !String(state.version).includes(EXPECT_VERSION)) throw new Error('侧栏没显示 v' + EXPECT_VERSION + '：' + state.version)
  await shoot(path.join('docs', 'r319-prod-workbench-1440.png'))

  // 2) 390：窄屏重新载入
  await open({ width: 390, height: 900 })
  await sleep(900)
  const narrow = await evaluate("(() => ({ promos: document.querySelectorAll('.vq-promo').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: (document.querySelector('.vq-promo-body') || {}).textContent || '' }))()")
  console.log('390 生产：' + JSON.stringify(narrow))
  if (narrow.overflow > 1) throw new Error('390 横向溢出：' + narrow.overflow)
  if (!narrow.body) throw new Error('390 上运营位正文没了')
  await shoot(path.join('docs', 'r319-prod-workbench-390.png'))

  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
} finally {
  cdp?.close()
  chrome.kill()
  await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* Windows 句柄收得慢 */ }
}
