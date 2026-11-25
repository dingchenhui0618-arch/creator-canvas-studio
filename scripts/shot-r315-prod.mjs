// 生产线上截图（r315）：聊天室在真实生产环境里长什么样。
//
// 与 scripts/shot-r315.mjs 的区别：那边是临时实例 + 临时数据；这里打的是
// https://visionqa.wavisionai.cn，会话来自生产侧临时的管理员会话（拍完即撤销），
// 令牌只从本机文件读，不打印、不进仓库。
//
// 用法：LIVE_TOKEN_FILE=.tmp-vq/live-token.txt LIVE_USER_ID=usr_xxx node scripts/shot-r315-prod.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.LIVE_BASE || 'https://visionqa.wavisionai.cn'
const HOST = new URL(BASE).hostname
const TOKEN_FILE = process.env.LIVE_TOKEN_FILE || '.tmp-vq/live-token.txt'
const USER_ID = process.env.LIVE_USER_ID || ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!fs.existsSync(TOKEN_FILE)) throw new Error('没有令牌文件：' + TOKEN_FILE)
const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
if (!token) throw new Error('令牌文件是空的')
if (!USER_ID) throw new Error('需要 LIVE_USER_ID')

const DEBUG_PORT = 9411
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-prod-profile-'))

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' })

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.errors = []
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params?.exceptionDetails?.text || 'exception')
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.errors.push((message.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 200))
      }
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

async function waitFor(check, label) {
  for (let i = 0; i < 80; i += 1) {
    try { if (await check()) return } catch { /* 还没起来 */ }
    await sleep(300)
  }
  throw new Error('等待超时：' + label)
}

try {
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
  await cdp.send('Runtime.enable')

  const cookieName = 'vq_session'
  const shots = [
    { width: 1440, height: 1000, out: 'docs/r315-prod-rooms-1440.png' },
    { width: 390, height: 900, out: 'docs/r315-prod-rooms-390.png' },
  ]

  let first = true
  for (const item of shots) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: item.width, height: item.height, deviceScaleFactor: 1, mobile: item.width < 600 })
    await cdp.send('Network.setCookie', { name: cookieName, value: token, domain: HOST, path: '/', httpOnly: true, secure: true })
    if (first) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: "try{localStorage.setItem('vq_welcome_seen:" + USER_ID + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}",
      })
    }
    await cdp.send('Page.navigate', { url: BASE + '/?r315=1&shot=' + Date.now() + '#/rooms' })
    await sleep(3600)
    // 有引导遮罩就点掉（跟真人一样找按钮，不是把元素删掉）
    await evaluate("(() => { const labels = ['跳过','知道了','关闭','开始使用']; const hit = [...document.querySelectorAll('button')].find((b) => labels.includes((b.textContent || '').trim())); if (hit) hit.click(); document.querySelectorAll('.vq-toast').forEach((el) => el.remove()); return true })()")
    await sleep(900)
    const state = await evaluate("(() => ({ hash: location.hash, title: (document.querySelector('.vq-page h1, .runs-page h1, h1') || {}).textContent, nav: [...document.querySelectorAll('.vq-nav a, .vq-nav-item')].map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 12), rows: document.querySelectorAll('.rooms-row').length, msgs: document.querySelectorAll('.rooms-msg').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, text: document.body.innerText.slice(0, 400) }))()")
    console.log('[' + item.width + '] ' + JSON.stringify(state).slice(0, 700))
    if (!state) throw new Error('页面没读到状态')
    if (state.hash !== '#/rooms') throw new Error('路由没落在聊天室：' + state.hash)
    if (state.overflow > 1) throw new Error(item.width + ' 横向溢出：' + state.overflow)
    if (!String(state.text).includes('聊天室')) throw new Error('页面里没有「聊天室」：' + state.text)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(item.out, Buffer.from(shot.data, 'base64'))
    console.log('✔ ' + path.basename(item.out) + ' · ' + item.width + '×' + item.height + ' · ' + Math.round(fs.statSync(item.out).size / 1024) + ' KB')
    first = false
  }
  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
} finally {
  cdp?.close()
  chrome.kill()
}
