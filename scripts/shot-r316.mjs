// 真实后端截图（r316）：接入我的智能体——配对码面板 + 房间里真的有一条智能体回话。
//
// 与 r315 同一套做法：临时实例 + 真账号 + 真 SQLite + 真令牌 + 真渲染，不点任何生成（不花钱）。
// 房间里的智能体消息是「先用配对码换令牌，再以那个成员的令牌身份发」的真消息。
//
// 用法：node scripts/shot-r316.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const alive = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(600) }).then(() => true).catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口')
}

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8987))
const DEBUG_PORT = await freePort(API_PORT + 50)
const BASE = 'http://127.0.0.1:' + API_PORT

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot316-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot316-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const EMAIL = 'shot316-user' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')
const { createAgent } = await import('../server/agents.mjs')
const rooms = await import('../server/rooms.mjs')
const access = await import('../server/agent-access.mjs')

const user = createUser({ email: EMAIL, password: PASSWORD, name: '林可' })
const token = createSession(user, {}).token

const writer = await createAgent({ name: '选题编辑', role: '从爆款里挑选题、定钩子', category: '内容复刻', systemPrompt: '你负责选题与钩子，先给三个方向再收敛到一个。' }, user)
const shot = await createAgent({ name: '分镜师', role: '把脚本拆成九宫格分镜', category: '脚本分镜', systemPrompt: '你负责把一句脚本拆成可拍的分镜，写清景别与时长。' }, user)

const room = rooms.createRoom({ userId: user.id, name: '双十一预热 · 保温杯', topic: '一条 15 秒竖屏', memberName: user.name })
rooms.addAgentMember({ roomId: room.id, userId: user.id, agent: writer })
const code = access.createPairCode({ roomId: room.id, userId: user.id })
const paired = access.pairWithCode({ code: code.code, name: '我的 codex', provider: 'codex' })
rooms.addAgentMember({ roomId: room.id, userId: user.id, agent: shot })

// 人说的三句 + 连接器那一边「真的以令牌身份」回的一句
for (const body of [
  '这条要投给 25 到 35 岁的通勤人群，卖点是「早上装的水，晚上还冒热气」。',
  '先别讲参数，开场就让人看见热气从杯口冒出来，第二秒才出现杯子。',
]) rooms.appendMessage({ roomId: room.id, userId: user.id, body })

const tokenMember = rooms.getRoom(room.id, user.id).agents.find((item) => item.name === '我的 codex')
rooms.appendMessageAs({
  roomId: room.id,
  room: rooms.requireRoom(room.id, user.id).room,
  member: { id: tokenMember.id, name: tokenMember.name },
  senderKind: 'agent',
  body: '收到。开场 0–2 秒只给热气与杯口的白雾，2 秒后才给杯身；结尾拧盖塞进包，字幕「明天早上还热」。',
})

console.log('临时实例 · 数据目录 ' + dataDir + ' · 端口 ' + API_PORT + ' · 房间 ' + room.id + ' · 令牌 ' + paired.token.slice(0, 8) + '…')

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
    try { if (await check()) return } catch { /* 还没起来 */ }
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

async function shoot({ route, out, width, height, after }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })
  const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + user.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}",
  })
  await cdp.send('Page.navigate', { url: BASE + '/?as=' + encodeURIComponent(user.id) + '&shot=' + Date.now() + '#/' + route })
  await sleep(2800)
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier })
  await evaluate("(() => { document.querySelectorAll('.vq-toast').forEach((el) => el.remove()) })()")
  if (after) await after()
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + width + '×' + height + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB')
}

async function openRoomWithMessages() {
  await evaluate("(() => { const row = [...document.querySelectorAll('.rooms-row')].find((item) => item.textContent.includes('双十一预热')); if (row) row.click(); return Boolean(row) })()")
  await sleep(1200)
}

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const identity = await fetch(BASE + '/api/onboarding', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token },
    body: JSON.stringify({ identity: 'commerce', category: '家居日用', direction: '保温杯短视频' }),
  })
  if (!identity.ok) throw new Error('写身份失败：' + identity.status)
  await fetch(BASE + '/api/onboarding/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token },
    body: JSON.stringify({ skipAssets: true }),
  })

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

  // 1) 房间里有一条智能体回话，成员行显示「已接入」
  await shoot({
    route: 'rooms',
    out: path.join('docs', 'r316-rooms-agent-1440.png'),
    width: 1440,
    height: 1000,
    after: async () => {
      await openRoomWithMessages()
      const state = await evaluate("(() => ({ msgs: document.querySelectorAll('.rooms-msg').length, agents: document.querySelectorAll('.rooms-member').length, dots: document.querySelectorAll('.rooms-member-dot').length, states: [...document.querySelectorAll('.rooms-member-state')].map((el) => el.textContent), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()")
      console.log('房间状态：' + JSON.stringify(state))
      if (state.msgs !== 3) throw new Error('消息应该是 3 条：' + JSON.stringify(state))
      if (state.dots < 1) throw new Error('没有「已接入」圆点：' + JSON.stringify(state))
      if (state.overflow > 1) throw new Error('1440 横向溢出：' + state.overflow)
      await sleep(300)
    },
  })

  // 2) 配对码面板：点开「接入我的智能体」，真码从后端来
  await shoot({
    route: 'rooms',
    out: path.join('docs', 'r316-rooms-pair-1440.png'),
    width: 1440,
    height: 1000,
    after: async () => {
      await openRoomWithMessages()
      await evaluate("(() => { const btn = document.querySelector('.rooms-member-add.is-quiet'); if (btn) btn.click(); return Boolean(btn) })()")
      await sleep(1200)
      const state = await evaluate("(() => ({ open: Boolean(document.querySelector('.rooms-pair')), code: (document.querySelector('.rooms-pair-code code') || {}).textContent, note: (document.querySelector('.rooms-pair-note') || {}).textContent, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()")
      console.log('配对面板：' + JSON.stringify(state))
      if (!state.open) throw new Error('配对面板没打开')
      if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(String(state.code || ''))) throw new Error('面板里的码不对：' + state.code)
      if (state.overflow > 1) throw new Error('1440 横向溢出：' + state.overflow)
      await sleep(300)
    },
  })

  // 3) 390：码与说明都不溢出
  await shoot({
    route: 'rooms',
    out: path.join('docs', 'r316-rooms-pair-390.png'),
    width: 390,
    height: 900,
    after: async () => {
      await openRoomWithMessages()
      await evaluate("(() => { const btn = document.querySelector('.rooms-member-add.is-quiet'); if (btn) btn.click(); return Boolean(btn) })()")
      await sleep(1200)
      // 390 是单列：面板在成员区，滚到它那里再拍，别拍一张看不到面板的空图
      await evaluate("(() => { const el = document.querySelector('.rooms-pair'); if (el) el.scrollIntoView({ block: 'center' }); return Boolean(el) })()")
      await sleep(500)
      const state = await evaluate("(() => ({ open: Boolean(document.querySelector('.rooms-pair')), code: (document.querySelector('.rooms-pair-code code') || {}).textContent, top: Math.round((document.querySelector('.rooms-pair') || { getBoundingClientRect: () => ({ top: -1 }) }).getBoundingClientRect().top), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()")
      console.log('390 配对面板：' + JSON.stringify(state))
      if (!state.open) throw new Error('390 配对面板没打开')
      if (state.overflow > 1) throw new Error('390 横向溢出：' + state.overflow)
      if (state.top < 0 || state.top > 900) throw new Error('390 面板不在视野里：' + state.top)
      await sleep(300)
    },
  })
  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
} finally {
  cdp?.close()
  chrome.kill()
  server.kill()
  await sleep(300)
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* Windows 上句柄收得慢，留给系统 */
  }
}
