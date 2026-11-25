// 真实后端截图（r315）：聊天室（房间骨架 1a）长什么样。
//
// 与 r313/r314 同一套做法：临时实例 + 真账号 + 真会话 + 真渲染，不点任何生成（不花钱）。
// 房间里的消息是用 rooms.mjs 直接写进去的真数据，不是界面假数据。
//
// 用法：node scripts/shot-r315.mjs
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

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8973))
const DEBUG_PORT = await freePort(API_PORT + 50)
const BASE = 'http://127.0.0.1:' + API_PORT

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot315-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot315-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const EMAIL = 'shot315-user' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')
const { createAgent } = await import('../server/agents.mjs')
const rooms = await import('../server/rooms.mjs')

const user = createUser({ email: EMAIL, password: PASSWORD, name: '林可' })
const token = createSession(user, {}).token

// 三个真智能体：房间右栏要能看出「它们各自是干什么的」
const writer = await createAgent({ name: '选题编辑', role: '从爆款里挑选题、定钩子', category: '内容复刻', systemPrompt: '你负责选题与钩子，先给三个方向再收敛到一个。' }, user)
const shot = await createAgent({ name: '分镜师', role: '把脚本拆成九宫格分镜', category: '脚本分镜', systemPrompt: '你负责把一句脚本拆成可拍的分镜，写清景别与时长。' }, user)
const critic = await createAgent({ name: '投放审稿', role: '按平台规范挑毛病', category: '投放素材', systemPrompt: '你负责挑毛病：先说不合格的地方，再说怎么改。' }, user)

const room = rooms.createRoom({ userId: user.id, name: '双十一预热 · 保温杯', topic: '一条 15 秒竖屏', memberName: user.name })
rooms.addAgentMember({ roomId: room.id, userId: user.id, agent: writer })
rooms.addAgentMember({ roomId: room.id, userId: user.id, agent: shot })
rooms.addAgentMember({ roomId: room.id, userId: user.id, agent: critic })
const lines = [
  '这条要投给 25 到 35 岁的通勤人群，卖点是「早上装的水，晚上还冒热气」。',
  '先别讲参数，开场就让人看见热气从杯口冒出来，第二秒才出现杯子。',
  '收尾给一个动作：拧上盖子塞进包里，字幕写「明天早上还热」。',
]
for (const body of lines) rooms.appendMessage({ roomId: room.id, userId: user.id, body })
const second = rooms.createRoom({ userId: user.id, name: '新品开箱 · 咖啡器具', memberName: user.name })

console.log('临时实例 · 数据目录 ' + dataDir + ' · 端口 ' + API_PORT + ' · 房间 ' + room.id)

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

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const identity = await fetch(BASE + '/api/onboarding', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token },
    body: JSON.stringify({ identity: 'commerce', category: '家居日用', direction: '保温杯短视频' }),
  })
  if (!identity.ok) throw new Error('写身份失败：' + identity.status)
  const completed = await fetch(BASE + '/api/onboarding/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token },
    body: JSON.stringify({ skipAssets: true }),
  })
  if (!completed.ok) throw new Error('引导收尾失败：' + completed.status)

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

  await shoot({
    route: 'rooms',
    out: path.join('docs', 'r315-rooms-1440.png'),
    width: 1440,
    height: 1000,
    after: async () => {
      // 列表按最近活动排序：先点进那条有消息的房间（默认选中的是后建的空房间）
      await evaluate("(() => { const row = [...document.querySelectorAll('.rooms-row')].find((item) => item.textContent.includes('双十一预热')); if (row) row.click(); return Boolean(row) })()")
      await sleep(1200)
      const state = await evaluate("(() => ({ rows: document.querySelectorAll('.rooms-row').length, msgs: document.querySelectorAll('.rooms-msg').length, members: document.querySelectorAll('.rooms-member').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, hash: location.hash, text: document.body.innerText.slice(0, 240) }))()")
      if (!state || state.rows !== 2) {
        const shot0 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        fs.writeFileSync(path.join('docs', 'r315-debug.png'), Buffer.from(shot0.data, 'base64'))
        throw new Error('房间列表不是 2 条：' + JSON.stringify(state))
      }
      if (state.msgs !== 3) throw new Error('消息不是 3 条：' + JSON.stringify(state))
      if (state.members !== 4) throw new Error('成员不是 4 个（1 人 + 3 智能体）：' + JSON.stringify(state))
      if (state.overflow > 1) throw new Error('1440 横向溢出：' + state.overflow)
      await sleep(400)
    },
  })

  // 发一句真消息：证明 SSE 与输入区都通（写入的是真数据，会留在临时实例里）
  await evaluate("(() => { const box = document.querySelector('.rooms-compose textarea'); if (!box) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(box, '那就按「热气先出现」这条走。'); box.dispatchEvent(new Event('input', { bubbles: true })); return true })()")
  await sleep(200)
  await evaluate("(() => { const main = document.querySelector('.rooms-main'); const btn = main && main.querySelector('.rooms-compose-foot button'); if (btn) btn.click(); return Boolean(btn) })()")
  await sleep(1200)
  const afterSend = await evaluate("(() => ({ msgs: document.querySelectorAll('.rooms-msg').length, last: (document.querySelector('.rooms-msg:last-of-type p') || {}).textContent }))()")
  if (afterSend.msgs !== 4) throw new Error('发消息之后不是 4 条：' + JSON.stringify(afterSend))
  console.log('发消息后：' + JSON.stringify(afterSend))

  const shot4 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join('docs', 'r315-rooms-sent-1440.png'), Buffer.from(shot4.data, 'base64'))
  console.log('✔ r315-rooms-sent-1440.png')

  await shoot({
    route: 'rooms',
    out: path.join('docs', 'r315-rooms-390.png'),
    width: 390,
    height: 1000,
    after: async () => {
      await evaluate("(() => { const row = [...document.querySelectorAll('.rooms-row')].find((item) => item.textContent.includes('双十一预热')); if (row) row.click(); return Boolean(row) })()")
      await sleep(1200)
      const state = await evaluate("(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, rows: document.querySelectorAll('.rooms-row').length, msgs: document.querySelectorAll('.rooms-msg').length }))()")
      if (state.overflow > 1) throw new Error('390 横向溢出：' + state.overflow)
      if (state.rows !== 2) throw new Error('390 房间列表不是 2 条：' + JSON.stringify(state))
      await sleep(400)
    },
  })

  // 加智能体的选择面板：点开再拍，证明「选一个智能体进房间」是可点的
  await shoot({
    route: 'rooms',
    out: path.join('docs', 'r315-rooms-picker-1440.png'),
    width: 1440,
    height: 900,
    after: async () => {
      await evaluate("(() => { const btn = document.querySelector('.rooms-member-add'); if (btn) btn.click() })()")
      await sleep(900)
      const open = await evaluate("Boolean(document.querySelector('.rooms-picker'))")
      console.log('选择面板打开：' + open)
      await sleep(200)
    },
  })
  console.log('第二个房间：' + second.id)
  console.log('服务端日志末尾：' + serverLog.slice(-200).replace(/\n/g, ' '))
} finally {
  cdp?.close()
  chrome.kill()
  server.kill()
}
