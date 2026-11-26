// 真实渲染截图（r319）：工作台的运营位 + 动效细则。
//
// 与 r315–r317 同一套做法：临时实例 + 真账号 + 真 SQLite + 真渲染，0 次上游调用、0 积分。
// 这一轮不涉及模型，所以不起假 /v1——只证明「界面真的长这样、动效真的在跑」。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const alive = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(400) }).then(() => true).catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口')
}

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8996))
const DEBUG_PORT = await freePort(API_PORT + 60)
const BASE = 'http://127.0.0.1:' + API_PORT

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot319-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot319-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const EMAIL = 'shot319-user' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

const user = createUser({ email: EMAIL, password: PASSWORD, name: '林可' })
const token = createSession(user, {}).token

console.log('临时实例 · ' + dataDir + ' · 端口 ' + API_PORT)

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    API_PORT: String(API_PORT),
    VQ_REQUIRE_AUTH: '1',
    VQ_REDFOX_DISABLED: '1',
  },
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
  '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore' })

async function waitFor(check, label, tries = 120) {
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
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })
  // 提示条用样式藏起来，绝不手工移除节点：那些节点 React 还在管，
  // 手工 remove 之后 React 下一次更新会抛 NotFoundError removeChild，整棵树会当场卸掉（r320 实测白屏）。
  const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + user.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}"
      + "try{document.addEventListener('DOMContentLoaded',function(){var s=document.createElement('style');s.textContent='.vq-toast{display:none !important}';document.head.appendChild(s)})}catch(e){}",
  })
  await cdp.send('Page.navigate', { url: BASE + '/?as=' + encodeURIComponent(user.id) + '&shot=' + Date.now() + '#/overview' })
  await sleep(2600)
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier })
}

async function shoot(out) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB')
}

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const headers = { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token }
  const identity = await fetch(BASE + '/api/onboarding', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ identity: 'creator', category: '家居日用', direction: '保温杯短视频' }),
  })
  if (!identity.ok) throw new Error('写身份失败：' + identity.status)
  const finished = await fetch(BASE + '/api/onboarding/complete', {
    method: 'POST',
    headers,
    body: JSON.stringify({ skipAssets: true }),
  })
  if (!finished.ok) throw new Error('收尾引导失败：' + finished.status)

  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')

  // 1) 1440：工作台顶上的两条运营位 + 四张能力卡（已按 24ms 依次进场）
  await open({ width: 1440, height: 1000 })
  await evaluate("(() => { window.scrollTo(0, 0); return true })()")
  await sleep(600)
  const state = await evaluate("(() => { const promos = [...document.querySelectorAll('.vq-promo')]; const card = document.querySelector('.ov-cap'); const cs = card ? getComputedStyle(card) : null; return { promoCount: promos.length, promoText: promos.map((el) => el.textContent).join(' | '), titles: promos.map((el) => { const t = el.querySelector('.vq-promo-title'); return t ? t.textContent : '' }), animation: cs ? cs.animationName : '', animationDuration: cs ? cs.animationDuration : '', transition: cs ? cs.transitionProperty : '', overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth } })()")
  console.log('1440 运营位：' + JSON.stringify(state))
  if (state.promoCount !== 2) throw new Error('工作台应该显示两条运营位，实际 ' + state.promoCount)
  if (!String(state.titles[0]).includes('聊天室') && !String(state.titles[0]).includes('房间')) throw new Error('第一条应该是聊天室那条：' + state.titles[0])
  if (!String(state.titles[1]).includes('模板')) throw new Error('第二条应该是复刻主线那条：' + state.titles[1])
  if (state.animation !== 'vq-rise') throw new Error('能力卡没有走逐条进场：' + state.animation)
  if (!String(state.transition).includes('transform')) throw new Error('能力卡没有把 transform 放进过渡：' + state.transition)
  if (state.overflow > 1) throw new Error('1440 横向溢出：' + state.overflow)
  await shoot(path.join('docs', 'r319-workbench-promo-1440.png'))

  // 2) 1440：鼠标真的停到第 2 张能力卡上——抬起 2px 是算出来的，不是嘴说的
  const box = await evaluate("(() => { const el = document.querySelectorAll('.ov-cap')[1]; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()")
  if (!box) throw new Error('没有第 2 张能力卡')
  await sleep(400)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
  await sleep(500)
  const hovered = await evaluate("(() => { const el = document.querySelectorAll('.ov-cap')[1]; const cs = getComputedStyle(el); return { transform: cs.transform, shadow: cs.boxShadow } })()")
  console.log('悬停：' + JSON.stringify(hovered))
  // matrix(1, 0, 0, 1, 0, -2) = 真的抬了 2px；identity 或 none 都算没抬起来
  const lift = /matrix\(1, 0, 0, 1, 0, (-?\d+(\.\d+)?)\)/.exec(String(hovered.transform))
  if (!lift || Number(lift[1]) >= -0.5) throw new Error('悬停没有抬起来：' + JSON.stringify(hovered))
  await shoot(path.join('docs', 'r319-workbench-hover-1440.png'))

  // 3) 关掉第一条：当场少一条，刷新后仍然不在（记录在浏览器本地）
  const closed = await evaluate("(() => { const btn = document.querySelector('.vq-promo-close'); const title = document.querySelector('.vq-promo-title'); if (!btn) return null; const text = title ? title.textContent : ''; btn.click(); return text })()")
  await sleep(400)
  // 关掉一条之后是「下一条补位」（位置最多两条），不是这一块变空——这正是运营位该有的行为
  const afterClose = await evaluate("(() => ({ count: document.querySelectorAll('.vq-promo').length, titles: [...document.querySelectorAll('.vq-promo-title')].map((el) => el.textContent), stored: window.localStorage.getItem('vq_promos_dismissed') }))()")
  console.log('关掉「' + closed + '」后：' + JSON.stringify(afterClose))
  if (afterClose.count !== 2) throw new Error('关掉一条后应该由下一条补位（仍是两条）：' + afterClose.count)
  if (String(afterClose.titles.join(' ')).includes('房间')) throw new Error('关掉的那条还在：' + JSON.stringify(afterClose.titles))
  if (!String(afterClose.titles.join(' ')).includes('按帧给结论')) throw new Error('没有补上第三条运营位：' + JSON.stringify(afterClose.titles))
  if (!String(afterClose.stored || '').includes('rooms-beta')) throw new Error('关掉的记录没写进本地：' + afterClose.stored)
  await open({ width: 1440, height: 1000 })
  const reloaded = await evaluate("(() => [...document.querySelectorAll('.vq-promo-title')].map((el) => el.textContent))()")
  console.log('刷新后：' + JSON.stringify(reloaded))
  if (String(reloaded.join(' ')).includes('房间')) throw new Error('刷新后关掉的那条又回来了：' + JSON.stringify(reloaded))
  if (!String(reloaded.join(' ')).includes('按帧给结论')) throw new Error('刷新后补位的那条也不见了：' + JSON.stringify(reloaded))

  // 4) 390：按窄屏重新载入，运营位与能力卡都不横向溢出
  await open({ width: 390, height: 900 })
  await evaluate("(() => { window.scrollTo(0, 0); return true })()")
  await sleep(600)
  const narrow = await evaluate("(() => ({ promos: document.querySelectorAll('.vq-promo').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, cta: (document.querySelector('.vq-promo-cta') || {}).textContent, body: (document.querySelector('.vq-promo-body') || {}).textContent }))()")
  console.log('390：' + JSON.stringify(narrow))
  if (narrow.overflow > 1) throw new Error('390 横向溢出：' + narrow.overflow)
  if (!narrow.body) throw new Error('390 上运营位正文没了')
  await shoot(path.join('docs', 'r319-workbench-promo-390.png'))

  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
  if (cdp.errors.length) throw new Error('页面抛异常了，截图不算数：' + cdp.errors[0].split('\n')[0])
  const bad = serverLog.split('\n').filter((line) => line.includes('失败') && !line.includes('/api/bdc'))
  console.log('服务端失败行：' + (bad.length ? bad.slice(0, 3).join(' | ') : 'none'))
} finally {
  cdp?.close()
  chrome.kill()
  server.kill()
  await sleep(300)
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* Windows 上句柄收得慢，留给系统 */
  }
}
