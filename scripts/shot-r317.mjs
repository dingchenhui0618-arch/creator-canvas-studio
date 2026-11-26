// 真实渲染截图（r317 1c）：平台智能体在房间里「正在写」→ 真回一句话。
//
// 与 r315/r316 同一套做法：临时实例 + 真账号 + 真 SQLite + 真渲染。
// 唯一的替身是模型本身：本脚本起一个本地假 /v1（OpenAI 兼容），
// 第一轮故意回一个 tools 调用、第二轮才回正文，所以截图里的回复是真的走了
// 「模型要工具 → 执行 templates.list → 再回答」这条路，但它不花钱、不出网。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
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

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8991))
const DEBUG_PORT = await freePort(API_PORT + 60)
const FAKE_PORT = await freePort(API_PORT + 120)
const BASE = 'http://127.0.0.1:' + API_PORT

const REPLY = '看过模板库了：现在是空的。先给我一条能当参照的爆款，我按它的结构拆成钩子 / 展开 / 收尾三段。'
const fakeCalls = []
const fake = http.createServer((req, res) => {
  if (String(req.url || '').endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', async () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch { /* 空请求体按第一轮处理 */ }
    const text = (payload.messages || []).map((item) => String(item.content || '')).join('\n')
    // 第二轮的工具结果长这样：「工具结果（templates.list）：」。
    // 不能只认「工具结果」四个字——工具说明本身也写着「拿到工具结果之后再给出…」。
    const toolRound = !text.includes('工具结果（')
    fakeCalls.push({ at: Date.now(), toolRound })
    await sleep(toolRound ? 2400 : 500)
    const content = toolRound ? '{"tool":"templates.list","args":{"limit":3}}' : REPLY
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'fake-' + fakeCalls.length,
      object: 'chat.completion',
      model: 'fake-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 },
    }))
  })
})
await new Promise((resolve) => fake.listen(FAKE_PORT, '127.0.0.1', resolve))

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot317-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot317-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const EMAIL = 'shot317-user' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')
const { createAgent } = await import('../server/agents.mjs')
const rooms = await import('../server/rooms.mjs')

const user = createUser({ email: EMAIL, password: PASSWORD, name: '林可' })
const token = createSession(user, {}).token
const writer = await createAgent(
  {
    name: '选题编辑',
    role: '从爆款里挑选题、定钩子',
    category: '内容复刻',
    systemPrompt: '你是选题编辑。先看模板库与房间里说过的内容，再给结论；不知道就说不确定。',
    tools: ['templates-read'],
  },
  user,
)
const room = rooms.createRoom({ userId: user.id, name: '双十一预热 · 保温杯', topic: '一条 15 秒竖屏', memberName: user.name })
rooms.addAgentMember({ roomId: room.id, userId: user.id, agent: writer })
for (const body of [
  '这条要投给 25 到 35 岁的通勤人群，卖点是「早上装的水，晚上还冒热气」。',
  '先别讲参数，开场就让人看见热气从杯口冒出来。',
]) rooms.appendMessage({ roomId: room.id, userId: user.id, body })

console.log('临时实例 · ' + dataDir + ' · 端口 ' + API_PORT + ' · 假模型 ' + FAKE_PORT + ' · 房间 ' + room.id)

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    API_PORT: String(API_PORT),
    VQ_REQUIRE_AUTH: '1',
    VQ_REDFOX_DISABLED: '1',
    VQ_ROOM_AGENT: '1',
    VISION_BASE_URL: 'http://127.0.0.1:' + FAKE_PORT + '/v1',
    VISION_MODEL: 'fake-model',
    LLM_MODEL: 'fake-model',
    VISION_API_KEY: 'fake-key-for-shot',
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
  // 新账号的「上手引导」会盖住整屏：真实用户第一眼也是它，但截图要看的是房间本身。
  // 这个标记就是「看过引导了」的那个键，先写进 localStorage 再进页面。
  const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + user.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}",
  })
  await cdp.send('Page.navigate', { url: BASE + '/?as=' + encodeURIComponent(user.id) + '&shot=' + Date.now() + '#/rooms' })
  await sleep(2600)
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier })
  await evaluate("(() => { document.querySelectorAll('.vq-toast').forEach((el) => el.remove()) })()")
  const guided = await evaluate("(() => Boolean(document.querySelector('.vq-welcome, .vq-guide')) ? (document.querySelector('.vq-welcome-close, .vq-guide-close, .vq-welcome button')?.click(), true) : false)()")
  if (guided) await sleep(400)
  const opened = await evaluate("(() => { const row = [...document.querySelectorAll('.rooms-row')].find((item) => item.textContent.includes('双十一预热')); if (row) row.click(); return Boolean(row) })()")
  if (!opened) throw new Error('房间列表里没有目标房间')
  await sleep(1200)
}

async function shoot(out) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB')
}

const typeAndSend = (text) => evaluate(
  "(() => { const ta = document.querySelector('.rooms-compose textarea'); if (!ta) return false; " +
  "const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; " +
  "setter.call(ta, " + JSON.stringify(text) + "); ta.dispatchEvent(new Event('input', { bubbles: true })); " +
  "const btn = document.querySelector('.rooms-compose-foot button'); if (btn) btn.click(); return Boolean(btn) })()",
)

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

  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')

  // 1) 1440：发一句话 → 出现「正在看并写回复」那一行
  await open({ width: 1440, height: 1000 })
  const hint = await evaluate("(() => (document.querySelector('.rooms-compose-foot span') || {}).textContent)()")
  console.log('输入框提示：' + hint)
  if (!String(hint || '').includes('每轮 1 积分')) throw new Error('输入框没写清每轮 1 积分：' + hint)
  await typeAndSend('模板库最近有什么？')
  const typing = await waitFor(() => evaluate("(() => { const el = document.querySelector('.rooms-typing'); return el ? el.textContent : '' })()"), '正在写回复', 40)
  console.log('打字提示：' + typing)
  if (!String(typing).includes('正在看并写回复')) throw new Error('打字提示文案不对：' + typing)
  await shoot(path.join('docs', 'r317-room-typing-1440.png'))

  // 2) 1440：等它真的回出来（走了「要工具 → 再回答」两轮）
  const reply = await waitFor(
    () => evaluate("(() => [...document.querySelectorAll('.rooms-msg')].map((el) => el.textContent).find((text) => text.includes('看过模板库了')) || '')()"),
    '智能体回复',
    120,
  )
  console.log('回复：' + String(reply).slice(0, 60))
  if (fakeCalls.length < 2) throw new Error('假模型只被调了 ' + fakeCalls.length + ' 次，工具那一轮没走通')
  const after = await evaluate("(() => ({ typing: Boolean(document.querySelector('.rooms-typing')), msgs: document.querySelectorAll('.rooms-msg').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, hint: (document.querySelector('.rooms-compose-foot span') || {}).textContent }))()")
  console.log('回完状态：' + JSON.stringify(after))
  if (after.typing) throw new Error('回复出来了，「正在写」还没收掉')
  if (after.msgs !== 4) throw new Error('应该是 4 条消息（2 句人 + 1 句人 + 1 条回复）：' + after.msgs)
  if (after.overflow > 1) throw new Error('1440 横向溢出：' + after.overflow)
  await shoot(path.join('docs', 'r317-room-reply-1440.png'))

  // 3) 390：按窄屏重新载入（不从 1440 缩），回复与提示都不溢出
  await open({ width: 390, height: 900 })
  const narrow = await evaluate("(() => ({ msgs: document.querySelectorAll('.rooms-msg').length, reply: [...document.querySelectorAll('.rooms-msg')].some((el) => el.textContent.includes('看过模板库了')), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, tools: (document.querySelector('.rooms-members-foot.is-tools') || {}).textContent }))()")
  console.log('390：' + JSON.stringify(narrow))
  if (!narrow.reply) throw new Error('390 重新载入后没看到那条回复')
  if (narrow.overflow > 1) throw new Error('390 横向溢出：' + narrow.overflow)
  if (!String(narrow.tools || '').includes('读模板库')) throw new Error('没显示平台智能体能用哪个工具：' + narrow.tools)
  // 打开房间应该落在最新一条：那条回复得真的出现在窗口里，用户不用自己往上翻
  const visible = await evaluate("(() => { const box = document.querySelector('.rooms-thread'); const node = [...document.querySelectorAll('.rooms-msg')].find((el) => el.textContent.includes('看过模板库了')); if (!box || !node) return null; const a = box.getBoundingClientRect(); const b = node.getBoundingClientRect(); return { scrollTop: Math.round(box.scrollTop), inside: b.top >= a.top - 1 && b.bottom <= a.bottom + 1 } })()")
  console.log('390 回复是否在窗口里：' + JSON.stringify(visible))
  if (!visible || !visible.inside) throw new Error('打开房间后没落在最新一条回复上：' + JSON.stringify(visible))
  await shoot(path.join('docs', 'r317-room-reply-390.png'))

  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
  const agentErrors = serverLog.split('\n').filter((line) => line.includes('[room-agent]') && line.includes('失败'))
  console.log('服务端回话失败行：' + (agentErrors.length ? agentErrors.join(' | ') : 'none'))
} finally {
  cdp?.close()
  chrome.kill()
  server.kill()
  fake.close()
  await sleep(300)
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* Windows 上句柄收得慢，留给系统 */
  }
}
