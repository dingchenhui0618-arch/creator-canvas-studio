// 生产线上截图（r316）：聊天室 1b 的「接入我的智能体」在真实生产环境里长什么样。
//
// 与 scripts/shot-r316.mjs 的区别：那边是临时实例 + 临时数据；这里打的是
// https://visionqa.wavisionai.cn，会话来自生产侧临时的管理员会话（拍完即撤销），
// 令牌只从本机文件读，不打印、不进仓库。
//
// 拍完会把临时建的房间解散（DELETE /api/rooms/<id>），生产里不留样例房间。
//
// 用法：LIVE_TOKEN_FILE=.tmp-vq/live-token.txt LIVE_USER_ID=usr_xxx node scripts/shot-r316-prod.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.LIVE_BASE || 'https://visionqa.wavisionai.cn'
const HOST = new URL(BASE).hostname
const TOKEN_FILE = process.env.LIVE_TOKEN_FILE || '.tmp-vq/live-token.txt'
const USER_ID = process.env.LIVE_USER_ID || ''
const ROOM_NAME = process.env.SHOT_ROOM_NAME || '接入验收（临时）'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!fs.existsSync(TOKEN_FILE)) throw new Error('没有令牌文件：' + TOKEN_FILE)
const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
if (!token) throw new Error('令牌文件是空的')
if (!USER_ID) throw new Error('需要 LIVE_USER_ID')

const DEBUG_PORT = 9413
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-prod-r316-'))

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
  for (let i = 0; i < 100; i += 1) {
    try { if (await check()) return } catch { /* 还没起来 */ }
    await sleep(300)
  }
  throw new Error('等待超时：' + label)
}

const clickByText = (labels) => `(() => {
  const labels = ${JSON.stringify(labels)};
  const hit = [...document.querySelectorAll('button')].find((b) => labels.includes((b.textContent || '').trim()));
  if (hit) { hit.click(); return hit.textContent.trim() }
  return null;
})()`

let roomId = null
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

  // 先把界面准备好（1440 视口），会话与引导遮罩一次性处理
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Network.setCookie', { name: 'vq_session', value: token, domain: HOST, path: '/', httpOnly: true, secure: true })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + USER_ID + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}",
  })
  await cdp.send('Page.navigate', { url: BASE + '/?r316=1&shot=' + Date.now() + '#/rooms' })
  await sleep(3600)
  await evaluate(clickByText(['跳过', '知道了', '关闭', '开始使用']))
  await sleep(600)
  await evaluate("document.querySelectorAll('.vq-toast').forEach((el) => el.remove()); true")

  // 1) 建一个临时房间（React 受控输入要用原生 setter + input 事件）
  const created = await evaluate(`(() => {
    const el = document.getElementById('rooms-new-name') || document.querySelector('.rooms-list-new input');
    if (!el) return { ok: false, why: '找不到输入框' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(ROOM_NAME)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`)
  if (!created?.ok) throw new Error('填房间名失败：' + JSON.stringify(created))
  await sleep(400)
  const clickedCreate = await evaluate(clickByText(['建房间']))
  if (!clickedCreate) throw new Error('没找到「建房间」按钮')
  await waitFor(async () => Boolean(await evaluate("Boolean(document.querySelector('.rooms-main'))")), '房间打开')
  await sleep(1200)

  // 2) 打开「接入我的智能体」，等真码出来
  const opened = await evaluate(clickByText(['接入我的智能体']))
  if (!opened) throw new Error('没找到「接入我的智能体」按钮')
  await waitFor(async () => Boolean(await evaluate("Boolean(document.querySelector('.rooms-pair-code code'))")), '配对码')
  await sleep(600)

  const panel = await evaluate(`(() => {
    const code = (document.querySelector('.rooms-pair-code code') || {}).textContent || '';
    const note = (document.querySelector('.rooms-pair-note') || {}).textContent || '';
    const hint = (document.querySelector('.rooms-pair-hint') || {}).textContent || '';
    return { code: code.trim(), note: note.trim(), hint: hint.trim() };
  })()`)
  console.log('配对面板：' + JSON.stringify(panel))
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(panel.code)) throw new Error('配对码格式不对：' + panel.code)
  if (!panel.note.includes('24 小时内有效')) throw new Error('面板文案不对：' + panel.note)

  // 记下房间 id，最后解散用
  const listed = await evaluate("fetch('/api/rooms', { credentials: 'include' }).then((r) => r.json()).then((d) => JSON.stringify((d.rooms || []).map((r) => ({ id: r.id, name: r.name }))))")
  const rooms = JSON.parse(listed || '[]')
  const mine = rooms.find((r) => r.name === ROOM_NAME) || rooms[0]
  roomId = mine?.id || null
  console.log('临时房间：' + JSON.stringify(mine))

  const shots = [
    { width: 1440, height: 1000, out: 'docs/r316-prod-rooms-1440.png', scroll: false },
    { width: 390, height: 900, out: 'docs/r316-prod-pair-390.png', scroll: true },
  ]
  for (const item of shots) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: item.width, height: item.height, deviceScaleFactor: 1, mobile: item.width < 600 })
    if (item.scroll) {
      await evaluate("(() => { const el = document.querySelector('.rooms-pair'); if (el) el.scrollIntoView({ block: 'center' }); return true })()")
      await sleep(700)
    } else {
      await evaluate("(() => { const el = document.querySelector('.rooms-pair'); if (el) el.scrollIntoView({ block: 'nearest' }); window.scrollTo(0, 0); return true })()")
      await sleep(400)
    }
    const state = await evaluate(`(() => ({
      hash: location.hash,
      width: window.innerWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pairTop: Math.round((document.querySelector('.rooms-pair') || { getBoundingClientRect: () => ({ top: -1 }) }).getBoundingClientRect().top),
      code: (document.querySelector('.rooms-pair-code code') || {}).textContent || '',
      text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 260),
    }))()`)
    console.log('[' + item.width + '] ' + JSON.stringify(state).slice(0, 520))
    if (state.overflow > 1) throw new Error(item.width + ' 横向溢出：' + state.overflow)
    if (!state.code) throw new Error(item.width + ' 截图里没有配对码')
    if (item.scroll && (state.pairTop < -8 || state.pairTop > 860)) throw new Error('390 面板不在视口里：top=' + state.pairTop)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(item.out, Buffer.from(shot.data, 'base64'))
    console.log('✔ ' + path.basename(item.out) + ' · ' + item.width + '×' + item.height + ' · ' + Math.round(fs.statSync(item.out).size / 1024) + ' KB')
  }
  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
} finally {
  // 生产里不留样例房间：解散（失败也要说清楚，不静默吞掉）
  if (roomId && cdp) {
    try {
      const out = await evaluate("fetch('/api/rooms/" + roomId + "', { method: 'DELETE', credentials: 'include' }).then((r) => r.status)")
      console.log('解散临时房间 ' + roomId + ' → HTTP ' + out)
    } catch (error) {
      console.log('解散失败（要人工清）：' + roomId + ' · ' + String(error).slice(0, 120))
    }
  }
  cdp?.close()
  chrome.kill()
}
