// 生产线上截图（r317）：聊天室 1c 的「平台智能体会接话」在真实生产环境里长什么样。
//
// 打的是 https://visionqa.wavisionai.cn，会话来自生产侧临时的管理员会话（拍完即撤销），
// 令牌只从本机文件读，不打印、不进仓库。临时建的房间拍完解散，生产里不留样例房间。
// 不发消息、不调模型、0 积分（这一版只有界面与只读工具，发消息才会扣 1 积分）。
//
// 用法：LIVE_TOKEN_FILE=.tmp-vq/live-token.txt LIVE_USER_ID=usr_xxx node scripts/shot-r317-prod.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.LIVE_BASE || 'https://visionqa.wavisionai.cn'
const HOST = new URL(BASE).hostname
const TOKEN_FILE = process.env.LIVE_TOKEN_FILE || '.tmp-vq/live-token.txt'
const USER_ID = process.env.LIVE_USER_ID || ''
const ROOM_NAME = process.env.SHOT_ROOM_NAME || '发布验收（临时）'
const EXPECT_VERSION = process.env.SHOT_VERSION || '0.9.290'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!fs.existsSync(TOKEN_FILE)) throw new Error('没有令牌文件：' + TOKEN_FILE)
const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
if (!token) throw new Error('令牌文件是空的')
if (!USER_ID) throw new Error('需要 LIVE_USER_ID')

const DEBUG_PORT = 9417
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-prod-r317-'))

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
        const detail = message.params?.exceptionDetails
        const described = detail?.exception?.description || detail?.exception?.value || detail?.text || 'exception'
        this.errors.push(String(described).slice(0, 300))
      }
      if (message.method === 'Network.responseReceived') {
        const status = message.params?.response?.status || 0
        if (status >= 400) this.errors.push('HTTP ' + status + ' ' + message.params.response.url.slice(0, 140))
      }
      if (message.method === 'Network.loadingFailed') {
        this.errors.push('LOAD FAIL ' + (message.params?.errorText || '') + ' ' + String(message.params?.requestId || ''))
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

async function waitFor(check, label, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
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

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Network.setCookie', { name: 'vq_session', value: token, domain: HOST, path: '/', httpOnly: true, secure: true })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + USER_ID + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}",
  })
  await cdp.send('Page.navigate', { url: BASE + '/?r317=1&shot=' + Date.now() + '#/rooms' })
  await sleep(3800)
  await evaluate(clickByText(['跳过', '知道了', '关闭', '开始使用']))
  await sleep(600)
  await evaluate("document.querySelectorAll('.vq-toast').forEach((el) => el.remove()); true")

  // 落地必须真的把聊天室渲染出来（r316 的教训：白屏只有真开一次才看得见）
  const landing = await evaluate(`(() => ({
    hash: location.hash,
    hasNewInput: Boolean(document.getElementById('rooms-new-name')),
    hasShellInput: Boolean(document.querySelector('.rooms-list-new input')),
    hasBlank: Boolean(document.querySelector('.rooms-blank')),
    hasShell: Boolean(document.querySelector('.rooms-shell')),
    login: Boolean(document.querySelector('.auth-page, .login-page, form input[type=password]')),
    version: (document.body.innerText.match(/v?0\\.9\\.\\d+/g) || []).slice(0, 3).join(','),
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 260),
  }))()`)
  console.log('落地状态：' + JSON.stringify(landing))
  if (!landing.hasNewInput && !landing.hasShellInput && !landing.hasBlank && !landing.hasShell) {
    const html = await evaluate("document.documentElement.outerHTML.replace(/\\s+/g, ' ').slice(0, 400)")
    console.log('页面 HTML：' + html)
    console.log('报错：' + JSON.stringify(cdp.errors.slice(0, 5)))
    throw new Error('聊天室页面没渲染出来（白屏或没登录）')
  }
  if (!String(landing.version || '').includes(EXPECT_VERSION)) throw new Error('侧栏版本号不是 ' + EXPECT_VERSION + '：' + landing.version)

  // 建一个临时房间打开它（受控输入要用原生 setter + input 事件）
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
  await sleep(1600)

  const listed = await evaluate("fetch('/api/rooms', { credentials: 'include' }).then((r) => r.json()).then((d) => JSON.stringify((d.items || d.rooms || []).map((r) => ({ id: r.id, name: r.name }))))")
  const rooms = JSON.parse(listed || '[]')
  roomId = (rooms.find((r) => r.name === ROOM_NAME) || rooms[0])?.id || null
  console.log('临时房间：' + JSON.stringify({ id: roomId, count: rooms.length }))

  // 1c 的重点是「房间里有平台智能体时」那一面：加一个平台智能体（不发消息、不扣积分），刷新后再看
  const agentsRaw = await evaluate("fetch('/api/agents', { credentials: 'include' }).then((r) => r.json())")
  const agentList = (agentsRaw && (agentsRaw.agents || agentsRaw.items)) || []
  const pick = (agentList.find((a) => a.id === 'agt_replica01') || agentList[0] || {}).id || ''
  console.log('平台智能体样本：' + JSON.stringify(agentList.slice(0, 4).map((a) => ({ id: a.id, name: a.name || a.label }))))
  if (!pick) throw new Error('这个账号没有可加进房间的平台智能体')
  const added = await evaluate("fetch('/api/rooms/" + roomId + "/members', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: " + JSON.stringify(pick) + " }) }).then((r) => r.status)")
  console.log('加平台智能体 ' + pick + ' → HTTP ' + added)
  if (added !== 200) throw new Error('加平台智能体失败：HTTP ' + added)
  await cdp.send('Page.navigate', { url: BASE + '/?r317=1&shot=' + Date.now() + '#/rooms' })
  await sleep(3800)
  await evaluate(clickByText(['跳过', '知道了', '关闭', '开始使用']))
  await sleep(900)

  // 1c 该在的四处：输入框提示、自动接话开关、能用哪些工具、工具是不是只开了一个
  const surface = await evaluate(`(() => ({
    hint: (document.querySelector('.rooms-compose-foot span') || {}).textContent || '',
    auto: (document.querySelector('.rooms-auto') || {}).textContent || '',
    tools: (document.querySelector('.rooms-members-foot.is-tools') || {}).textContent || '',
    typing: Boolean(document.querySelector('.rooms-typing')),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))()`)
  console.log('1c 表面：' + JSON.stringify(surface))
  if (!String(surface.hint).includes('每轮 1 积分')) throw new Error('输入框没写清每轮 1 积分：' + surface.hint)
  if (!String(surface.hint).includes('平台智能体会接话')) throw new Error('输入框没写清谁会接话（房间里应该有平台智能体）：' + surface.hint)
  if (!String(surface.auto).includes('自动接话')) throw new Error('没找到自动接话开关：' + surface.auto)
  if (!String(surface.tools).includes('读模板库')) throw new Error('没写清能用哪个工具：' + surface.tools)
  if (!String(surface.tools).includes('另外 6 个还没开')) throw new Error('没写清另外 6 个没开：' + surface.tools)
  if (surface.typing) throw new Error('还没发消息就出现了打字提示')
  if (surface.overflow > 1) throw new Error('1440 横向溢出：' + surface.overflow)

  const shot1440 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync('docs/r317-prod-room-1440.png', Buffer.from(shot1440.data, 'base64'))
  console.log('✔ r317-prod-room-1440.png · ' + Math.round(fs.statSync('docs/r317-prod-room-1440.png').size / 1024) + ' KB')

  // 390：按窄屏重新载入（不从 1440 缩），房间与右栏都还在、不溢出
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true })
  await cdp.send('Page.navigate', { url: BASE + '/?r317=1&shot=' + Date.now() + '#/rooms' })
  await sleep(3600)
  const narrow = await evaluate(`(() => ({
    width: window.innerWidth,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    scrollLeft: Math.round(window.scrollX || 0),
    hasRoom: Boolean(document.querySelector('.rooms-main')),
    tools: (document.querySelector('.rooms-members-foot.is-tools') || {}).textContent || '',
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200),
  }))()`)
  console.log('390：' + JSON.stringify(narrow).slice(0, 460))
  if (narrow.overflow > 1) throw new Error('390 横向溢出：' + narrow.overflow)
  if (narrow.scrollLeft !== 0) throw new Error('390 页面被横向推走了：scrollX=' + narrow.scrollLeft)
  const shot390 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync('docs/r317-prod-room-390.png', Buffer.from(shot390.data, 'base64'))
  console.log('✔ r317-prod-room-390.png · ' + Math.round(fs.statSync('docs/r317-prod-room-390.png').size / 1024) + ' KB')

  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
} finally {
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
