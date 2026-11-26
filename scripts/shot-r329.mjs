// r329 取证：「按下去那一下，屏幕得有反应」——悬停 / 按下 / 进行中 / 完成，四拍逐条量数字。
//
// 为什么单开一个脚本：
//   以前每一轮都在量「功能对不对」，没人量过「按下去有没有反应」。这一轮把一套探针
//   （cursor / hover / press / busy / 重复提交 / 可点不可达）放到 8 屏主要动作上，
//   用真 Chrome + CDP 真输入跑一遍，先把 before 的数字如实记下来，改完用同一份脚本再跑一遍。
//
// 三条纪律（与 r328 同一套）：
//   1) 0 次上游调用：临时库不给模型 Key，且把 VISION_BASE_URL 指到本机一个没人监听的端口，
//      任何会走上游的按钮（生成图片 / 生成视频 / 开始评审 / 解析 / 检索）一律不点，报告里写「跳过：会扣费」。
//   2) 必须走真输入：悬停 / 按下 / 点击是 Input.dispatchMouseEvent，Tab 是 Input.dispatchKeyEvent，
//      打字是 Input.insertText 逐字符。程序化 .click() 一律不用。
//   3) 证据不撒谎：量不出来就写 null 并写明原因，不猜、不把「接口 200」当界面对了。
//
// 用法：
//   node scripts/shot-r329.mjs --dist .shots329/dist-before --out .shots329/before
//   node scripts/shot-r329.mjs --dist .shots329/dist-before --out .shots329/before --only templates,projects
//
// 产物：<out>/r329.json + <out>/<screen>.png（1440x1000）+ <out>/<screen>-press.png（按下那一刻）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = process.cwd()
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOTS_ROOT = path.join(ROOT, '.shots329')

function argOf(name, fallback) {
  const at = process.argv.indexOf('--' + name)
  if (at > 0 && process.argv[at + 1] && process.argv[at + 1].charAt(0) !== '-') return process.argv[at + 1]
  return fallback
}

const ONLY = String(argOf('only', '')).split(',').map((item) => item.trim()).filter(Boolean)
const OUT_DIR = path.resolve(ROOT, String(argOf('out', '.shots329/before')))
const DIST_DIR = path.resolve(ROOT, String(argOf('dist', '.shots329/dist-before')))
if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) throw new Error('dist 里没有 index.html：' + DIST_DIR)
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 SHOT_CHROME 指定）')
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(SHOTS_ROOT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const checks = []
function check(id, ok, detail) {
  checks.push({ id: id, ok: Boolean(ok), detail: detail === undefined ? null : detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + JSON.stringify(detail))
}
const notes = []
function note(text, detail) {
  notes.push({ text: text, detail: detail === undefined ? null : detail })
  console.log('NOTE ' + text + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

// 端口：避开这台机器上其它常驻服务（与 r328 同一份名单）。
const RESERVED = new Set([8799, 8800, 3210, 6677, 5312, 5313, 3080, 10100, 10086])
async function freePort(start, end) {
  for (let port = start; port <= end; port += 1) {
    if (RESERVED.has(port)) continue
    const alive = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(400) }).then(() => true).catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口：' + start + '-' + end)
}
const API_PORT = await freePort(8860, 8878)
const DEBUG_PORT = await freePort(8880, 8898)
const BASE = 'http://127.0.0.1:' + API_PORT

// ---- 临时实例：真 SQLite、真账号、真 cookie，只有数据目录是新的（绝不碰 /var/lib 与真实数据）----
const dataDir = fs.mkdtempSync(path.join(SHOTS_ROOT, 'data-'))
const profile = fs.mkdtempSync(path.join(SHOTS_ROOT, 'profile-'))
process.env.DATA_DIR = dataDir

// 服务端用 process.cwd() 找 dist 与 package.json，所以给它一个「装着一份 dist」的舞台目录：
// before 量的是 --dist 指的那份拷贝，Lead 之后重新构建也污染不到这份证据。
const stageDir = path.join(SHOTS_ROOT, 'stage')
fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir, { recursive: true })
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
// 舞台里的 package.json 用「这份 dist 自己的版本号」：dist-before 是旧构建，
// 拿源码树现在的 package.json 顶上会让 /api/version 与页面显示的版本号对不上。
const distPkgVersion = (function () {
  try {
    const entryName = (fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8').match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1]
    const source = fs.readFileSync(path.join(DIST_DIR, 'assets', entryName), 'utf8')
    const found = source.match(/0\.9\.\d{3}/)
    return found ? found[0] : pkgJson.version
  } catch {
    return pkgJson.version
  }
})()
fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify({ ...pkgJson, version: distPkgVersion }, null, 2), 'utf8')
try {
  fs.symlinkSync(DIST_DIR, path.join(stageDir, 'dist'), 'junction')
} catch (error) {
  console.log('NOTE junction 建不起来，退回复制：' + String(error && error.message))
  fs.cpSync(DIST_DIR, path.join(stageDir, 'dist'), { recursive: true })
}

const distHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8')
const distEntryMatch = distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
const distEntry = distEntryMatch ? distEntryMatch[1] : null
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

// ---- 一张真 PNG（不引依赖、不联网）：给模板封面与作品流卡片当缩略图 ----
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function makePng(width, height, shade) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x += 1) {
      const rgb = shade(x / width, y / height)
      const at = y * stride + 1 + x * 3
      raw[at] = rgb[0]
      raw[at + 1] = rgb[1]
      raw[at + 2] = rgb[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
// 灰底 + 一条斜向亮带：看得出是图，也不冒充产品素材。
const THUMB_SHADE = (x, y) => {
  const band = Math.max(0, 1 - Math.abs(x - y * 0.9 - 0.18) * 6)
  const base = 34 + Math.round(22 * y)
  const lift = Math.round(46 * band)
  return [base + lift, base + Math.round(lift * 0.7), base + Math.round(lift * 1.4)]
}
const thumbBuffer = makePng(640, 640, THUMB_SHADE)
const coverBuffer = makePng(960, 540, THUMB_SHADE)

// ---- 建号 + 铺数据（都是真数据：后台运营位、模板、作品、素材、对话预设）----
const AT = String.fromCharCode(64)
const PASSWORD = 'r329-probe-pass1'
const NEW_PASSWORD = 'r329-probe-pass2'
const { createSession, createUser } = await import('../server/auth.mjs')
const { savePromos } = await import('../server/promos.mjs')
const { createAgent } = await import('../server/agents.mjs')
const { createProject } = await import('../server/projects.mjs')
const { markComplete } = await import('../server/onboarding.mjs')
const { config: cfg } = await import('../server/config.mjs')

const admin = createUser({ email: 'r329-admin' + AT + 'shot.test', password: PASSWORD, name: '运维', kind: 'admin' })
const account = createUser({ email: 'r329probe' + AT + 'shot.test', password: PASSWORD, name: '取证员', kind: 'account' })
const token = createSession(account, {}).token
const adminToken = createSession(admin, {}).token
// 普通账号的第一屏是真点走引导的（见开场那段）；后台那一屏要的是运营位，不是引导，
// 所以管理员账号先标成已完成——这一条会写进报告，不假装是点出来的。
markComplete(admin.id, { skipAssets: true })

const seeded = { promos: '', agent: '', project: '', template: '', media: '', account: account.id, admin: admin.id }

const promoSeed = await savePromos([
  {
    id: 'r329-rooms',
    placement: 'overview',
    weight: 30,
    kicker: 'Beta · 聊天室',
    title: '把几个智能体放进同一个房间',
    body: '房间里你说一句，平台智能体接一句：起草、拆结构、找选题。每轮 1 积分，答不上来全额退回。',
    cta: '去聊天室',
    page: 'rooms',
  },
  {
    id: 'r329-review',
    placement: 'overview',
    weight: 20,
    kicker: '视觉评审',
    title: '按帧给结论，每条带证据',
    body: '抽帧逐条标出问题与像素锚点，评审结论可以回写到作品，作为封版依据。',
    cta: '去视觉评审',
    page: 'review',
  },
], { by: 'r329-seed' })
seeded.promos = promoSeed.ok ? promoSeed.items.length + ' 条' : '失败：' + promoSeed.error

const agent = await createAgent({
  name: 'r329 口播拆解',
  category: '脚本分镜',
  role: '把一条口播拆成脚本与分镜',
  systemPrompt: '你负责把口播拆成分镜表：先给结果，再给步骤。看不清的地方标出来，不要编。',
}, account)
seeded.agent = agent.name

const templateEntry = {
  id: 'tpl_r329_probe',
  kind: 'replica',
  title: '一分钟出片的那条',
  contentType: '口播',
  tags: ['取证'],
  platform: 'douyin',
  platformLabel: '抖音',
  sourceUrl: 'https://www.douyin.com/video/3290329',
  sourceId: 'dy_3290329',
  author: '原片作者',
  publishedAt: '2026-11-01',
  stats: { plays: 128000, likes: 9600, comments: 320, shares: 180, collects: 2400 },
  durationSec: 18,
  hook: '一分钟出一杯',
  hookType: '结果前置',
  structure: [
    { startSec: 0, endSec: 4, beat: '结果', voiceover: '一分钟，真的只要一分钟', onScreen: '出杯', purpose: '给结果' },
    { startSec: 4, endSec: 11, beat: '步骤', voiceover: '三件事：粉、水、时间', onScreen: '三步字卡', purpose: '拆步骤' },
    { startSec: 11, endSec: 18, beat: '收尾', voiceover: '照着做就行', onScreen: '成品', purpose: '收口' },
  ],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 4, frameIndex: 0, visual: '咖啡机出杯特写', camera: '近景', caption: '一分钟', audio: '环境音', purpose: '给结果' },
    { shotNo: 2, startSec: 4, endSec: 8, frameIndex: 1, visual: '手倒粉', camera: '俯拍', caption: '一勺', audio: '摩擦声', purpose: '拆步骤' },
    { shotNo: 3, startSec: 8, endSec: 18, frameIndex: 2, visual: '成品摆桌', camera: '中景', caption: '照做就行', audio: '轻音乐', purpose: '收口' },
  ],
  timing: { estimatedSec: 17, actualSec: 18, durationSec: 18, fit: 'tight', overSec: 0, tight: 1, loose: 0 },
  analysis: { pacing: '快', viralPoints: ['出杯瞬间'], reusableRules: ['先给结果'], targetAudience: '打工人' },
  frames: [],
  cover: 'data:image/png;base64,' + coverBuffer.toString('base64'),
  video: { width: 1080, height: 1920, fps: 30, duration: 18 },
  origin: 'manual',
  reuseCount: 0,
  ownerId: account.id,
  createdAt: new Date().toISOString(),
  savedAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(dataDir, 'templates.json'), JSON.stringify([templateEntry], null, 2), 'utf8')
seeded.template = templateEntry.title

const project = await createProject({ title: '一分钟出片的那条', templateId: templateEntry.id }, account)
seeded.project = project.title

// 作品流（创作成果）里的一条：真写一份任务记录 + 一张真 PNG，界面读的就是它。
const taskId = 'mgen_r329seed01'
const safeUser = String(account.id).replace(/[^A-Za-z0-9_-]/g, '_') || 'anonymous'
fs.mkdirSync(path.join(dataDir, 'media', 'tasks'), { recursive: true })
fs.mkdirSync(path.join(dataDir, 'media', safeUser), { recursive: true })
fs.writeFileSync(path.join(dataDir, 'media', safeUser, taskId + '.png'), thumbBuffer)
const nowIso = new Date().toISOString()
fs.writeFileSync(path.join(dataDir, 'media', 'tasks', taskId + '.json'), JSON.stringify({
  version: 1,
  id: taskId,
  userId: account.id,
  kind: 'image',
  status: 'succeeded',
  prompt: '一杯手冲咖啡的出杯瞬间',
  model: 'gpt-image-2',
  modelLabel: 'GPT Image 2',
  mode: 'text2image',
  ratio: '1:1',
  size: '1024x1024',
  progress: 100,
  createdAt: nowIso,
  updatedAt: nowIso,
  finishedAt: nowIso,
  error: '',
  file: { ext: 'png', mime: 'image/png', bytes: thumbBuffer.length },
  credits: { cost: 0, balance: 0 },
}, null, 2), 'utf8')
seeded.media = taskId

console.log('r329 取证 · dist=' + DIST_DIR + ' · 入口 ' + distEntry + ' · v' + pkgVersion + ' · 端口 ' + API_PORT + ' · 数据目录 ' + dataDir)

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
  cwd: stageDir,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    API_PORT: String(API_PORT),
    VQ_REQUIRE_AUTH: '1',
    VQ_SECURE_COOKIES: '0',
    VQ_DEMO_ACCOUNT: '0',
    VQ_REGISTRATION: '0',
    VQ_REDFOX_DISABLED: '1',
    NODE_ENV: 'production',
    // 上游闸：模型 baseUrl 指向本机一个没人监听的端口（服务端自己占着的 /dead-upstream 只会 404，
    // 不是模型服务的地址），误触也打不到 OpenCodex。
    VISION_BASE_URL: BASE + '/dead-upstream/v1',
    VISION_API_KEY: 'r329-not-a-real-key',
    LLM_MODEL: 'deepseek-flash',
    VQ_GATEWAY_OPEN: '0',
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

async function waitFor(fn, label, tries = 140) {
  for (let i = 0; i < tries; i += 1) {
    try { const value = await fn(); if (value) return value } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('等待超时：' + label)
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
    this.consoleErrors = []
    this.requests = []
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params && message.params.exceptionDetails
        this.exceptions.push(String((details && ((details.exception && details.exception.description) || details.text)) || 'exception').slice(0, 300))
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params && message.params.type === 'error') {
        this.consoleErrors.push((message.params.args || []).map((arg) => String((arg && arg.value) || (arg && arg.description) || '')).join(' ').slice(0, 300))
      }
      if (message.method === 'Network.requestWillBeSent' && message.params && message.params.request) {
        this.requests.push({ method: String(message.params.request.method || ''), url: String(message.params.request.url || ''), type: String(message.params.type || '') })
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(message.error.message))
        else entry.resolve(message.result)
      }
    })
    this.ready = new Promise((resolve) => this.ws.addEventListener('open', resolve))
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject: reject })
      this.ws.send(JSON.stringify({ id: id, method: method, params: params }))
    })
  }
  close() { try { this.ws.close() } catch { /* 已经关了 */ } }
}

let cdp = null
async function evaluate(expression) {
  let result
  try {
    result = await cdp.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true })
  } catch (error) {
    throw new Error('Runtime.evaluate 失败：' + String((error && error.message) || error) + ' :: ' + expression.slice(0, 160))
  }
  if (result && result.exceptionDetails) throw new Error('页面里求值失败：' + JSON.stringify(result.exceptionDetails).slice(0, 240) + ' :: ' + expression.slice(0, 160))
  return result && result.result ? result.result.value : undefined
}
async function waitForExpr(expression, label, tries = 60, gap = 150) {
  for (let i = 0; i < tries; i += 1) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(gap)
  }
  throw new Error('等不到：' + label)
}

// 找元素：一律「选择器 + 文本相等 + 第几个」，不在页面里 eval 字符串，
// 这样报告里写出来的也是别人能照着复现的选择器。
function frExpr(F) {
  let expr = 'Array.prototype.slice.call(document.querySelectorAll(' + JSON.stringify(F.sel) + '))'
  if (F.text) {
    expr = expr + '.filter(function (el) { return String(el.textContent || "").replace(/\\s+/g, " ").trim() === ' + JSON.stringify(F.text) + ' })'
  }
  return '(' + expr + ')[' + (F.index || 0) + ']'
}
const q = (sel) => ({ sel: sel })
const byText = (text, sel) => ({ sel: sel || 'button', text: text })
const nthOf = (sel, index) => ({ sel: sel, index: index })

async function rectOf(expression) {
  return evaluate('(() => { const el = (' + expression + '); if (!el) return null; const r = el.getBoundingClientRect(); return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), t: Math.round(r.top) } })()')
}
const rectOfFr = (F) => rectOf(frExpr(F))
async function mouseTo(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none' })
  await sleep(90)
}
async function mouseDown(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1 })
}
async function mouseUp(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', buttons: 0, clickCount: 1 })
}
async function clickAt(x, y, gap = 60) {
  await mouseTo(x, y)
  await mouseDown(x, y)
  await sleep(gap)
  await mouseUp(x, y)
  await sleep(gap)
}
async function clickFr(F, gap = 60) {
  const view = await evaluate('(' + bringIntoView.toString() + ')(' + JSON.stringify(F) + ')')
  if (!view || view.missing) return null
  await clickAt(view.cx, view.cy, gap)
  return view
}

async function pressKey(key, code, keyCode, modifiers = 0) {
  const params = { key: key, code: code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: modifiers }
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, params))
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, params))
  await sleep(80)
}
const pressTab = (shift = false) => pressKey('Tab', 'Tab', 9, shift ? 8 : 0)
async function pressEnter() {
  // 按钮的「回车 = 点一下」是字符事件，只发 rawKeyDown 不会激活它（实测过）。
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', text: '\r', unmodifiedText: '\r' }, base))
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base))
  await sleep(120)
}

// ---- 页面里跑的探针（普通函数 + toString 注入；元素靠 选择器+文本 自己找）----
function probeEl(F) {
  let list = Array.prototype.slice.call(document.querySelectorAll(F.sel))
  if (F.text) list = list.filter(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim() === F.text })
  const el = list[F.index || 0]
  if (!el) return { missing: true, matched: list.length }
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return {
    cursor: cs.cursor,
    transform: cs.transform,
    borderColor: cs.borderColor,
    boxShadow: cs.boxShadow,
    backgroundColor: cs.backgroundColor,
    color: cs.color,
    outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
    hover: el.matches(':hover'),
    active: el.matches(':active'),
    disabled: Boolean(el.disabled),
    ariaBusy: String(el.getAttribute('aria-busy') || ''),
    text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48),
    svg: el.querySelectorAll('svg').length,
    spin: document.querySelectorAll('.spin,.vq-spin,[aria-busy="true"]').length,
    l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
  }
}

function installWatch(F, BASE) {
  // 每 16ms 采一帧：先记「第一个可见的进行中信号」，再记它什么时候没了。
  // 时间基准优先用真 pointerdown 的那一刻（同一个 performance.now 时钟），
  // 这样毫秒数里不含 Node 与浏览器之间的那一两个来回。
  const state = { clickAt: null, first: null, end: null }
  window.__r329watch = state
  document.addEventListener('pointerdown', function () { if (!state.clickAt) state.clickAt = performance.now() }, true)
  const started = performance.now()
  const timer = setInterval(function () {
    let list = Array.prototype.slice.call(document.querySelectorAll(F.sel))
    if (F.text) list = list.filter(function (e) { return String(e.textContent || '').replace(/\s+/g, ' ').trim() === F.text })
    const el = list[F.index || 0]
    const now = performance.now()
    const parts = []
    const own = []
    if (el) {
      const text = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48)
      if (Boolean(el.disabled) !== BASE.disabled) own.push('disabled=' + Boolean(el.disabled))
      if (text !== BASE.text) own.push('text→"' + text.slice(0, 24) + '"')
      const svg = el.querySelectorAll('svg').length
      if (svg > BASE.svg) own.push('svg+' + (svg - BASE.svg))
      const ab = String(el.getAttribute('aria-busy') || '')
      if (ab !== BASE.ariaBusy) own.push('aria-busy=' + ab)
      const cls = String(el.getAttribute('class') || '')
      if (/(^|\s)is-(busy|loading|saving|pending)(\s|$)/.test(cls)) own.push('class-busy')
    }
    if (own.length) parts.push(own.join('; '))
    const spin = document.querySelectorAll('.spin,.vq-spin,[aria-busy="true"]').length
    if (spin > BASE.spin) parts.push('页面上多了转圈 +' + (spin - BASE.spin))
    if (parts.length && !state.first) {
      const base = state.clickAt || started
      state.first = { ms: Math.round(now - base), signal: parts.join('; '), scope: own.length ? 'element' : 'page', at: Math.round(now - started) }
    } else if (state.first && !parts.length && !state.end) {
      state.end = { at: Math.round(now - started) }
    }
    if (now - started > 2600) clearInterval(timer)
  }, 16)
  return true
}

function bringIntoView(F) {
  // 视口只有 1000 高，长页面上大部分按钮在屏外；鼠标事件落在屏外的坐标上等于没点。
  // 这里只做「滚到眼前」——滚的是真滚动容器（.vq-content / 抽屉里的可滚块），不伪造点击。
  let list = Array.prototype.slice.call(document.querySelectorAll(F.sel))
  if (F.text) list = list.filter(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim() === F.text })
  const el = list[F.index || 0]
  if (!el) return { missing: true, matched: list.length }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  return {
    cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
    l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    inViewport: r.top >= 4 && r.bottom <= window.innerHeight - 4 && r.left >= 0 && r.right <= window.innerWidth,
    scroller: (function () { let n = el.parentElement; while (n) { const s = getComputedStyle(n); if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return (n.className || n.tagName).toString().split(' ')[0] || 'div'; n = n.parentElement } return 'window' })(),
  }
}

function hitProbe(x, y) {
  // 「鼠标真的落在谁身上」——整卡可点靠的是按钮的 ::after 热区，
  // 所以卡片的 computed cursor 永远是 auto，只有命中元素才说得出这里到底是不是可点。
  const el = document.elementFromPoint(x, y)
  if (!el) return null
  const cs = getComputedStyle(el)
  const cls = String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
  const open = el.closest ? el.closest('.vq-card-open') : null
  return {
    tag: el.tagName,
    cls: cls,
    cursor: cs.cursor,
    path: window.__r329path ? window.__r329path(el) : el.tagName + (cls ? '.' + cls : ''),
    stretchedOpen: Boolean(open),
    disabled: Boolean(el.disabled),
    text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
  }
}

function blockedProbe(F, x, y) {
  // 中心点上「最上面那个元素」如果不在这颗按钮里面，说明它被盖住了——
  // 盖住它的东西要点出来（这一轮 before 里是一张 toast 压在抽屉页脚按钮上）。
  let list = Array.prototype.slice.call(document.querySelectorAll(F.sel))
  if (F.text) list = list.filter(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim() === F.text })
  const el = list[F.index || 0]
  if (!el) return null
  const hit = document.elementFromPoint(x, y)
  if (!hit) return null
  if (hit === el || el.contains(hit)) return null
  const cls = String(hit.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
  return { tag: hit.tagName, cls: cls, text: String(hit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) }
}

function boxProbe(F) {
  // 元素的盒模型与「往上四层」的 display / pointer-events / hidden：
  // 量不到的时候，问题几乎总是出在祖先上（zero-size 或 hidden）。
  let list = Array.prototype.slice.call(document.querySelectorAll(F.sel))
  if (F.text) list = list.filter(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim() === F.text })
  const el = list[F.index || 0]
  if (!el) return null
  const cs = getComputedStyle(el)
  const chain = []
  let node = el
  for (let i = 0; node && i < 4; i += 1) {
    const s = getComputedStyle(node)
    const cls = node.getAttribute('class') ? '.' + String(node.getAttribute('class')).split(/\s+/)[0] : ''
    chain.push(String(node.tagName).toLowerCase() + cls + '[display=' + s.display + ',pe=' + s.pointerEvents + (node.hasAttribute('hidden') ? ',hidden' : '') + ']')
    node = node.parentElement
  }
  return { display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents, chain: chain.join(' < ') }
}

function readWatch() {
  const s = window.__r329watch
  if (!s) return null
  return {
    clicked: s.clickAt !== null,
    busyMs: s.first ? s.first.ms : null,
    busySignal: s.first ? s.first.signal : null,
    busyScope: s.first ? s.first.scope : null,
    busyEndedMs: s.first && s.end ? s.end.at - s.first.at : null,
  }
}

function installPathHelper() {
  window.__r329path = function (el) {
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth += 1) {
      let piece = node.tagName.toLowerCase()
      const cls = String(node.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      if (cls) piece += '.' + cls
      const parent = node.parentElement
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName })
        if (same.length > 1) piece += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(piece)
      node = parent
    }
    return parts.join(' > ')
  }
  return true
}

function scanInteractive() {
  // 全局静音键：所有「看着能点」的元素里，cursor 不是 pointer 的有几个。
  const nodes = document.querySelectorAll('button, a[href], [role="button"], [onclick], input[type="submit"], input[type="button"]')
  const offenders = []
  let checked = 0
  let disabledNonPointer = 0
  for (const el of nodes) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (r.width < 2 || r.height < 2) continue
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
    checked += 1
    if (cs.cursor === 'pointer') continue
    if (el.disabled) { disabledNonPointer += 1; continue }
    offenders.push({ cursor: cs.cursor, text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24), html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 120), path: window.__r329path(el) })
  }
  return { checked: checked, nonPointerEnabled: offenders.length, disabledNonPointer: disabledNonPointer, offenders: offenders.slice(0, 5) }
}

function scanFakeClickable() {
  // 第二类：<article>/<div>/<li> 自己挂着 onClick（React 的 props 挂在 DOM 节点上），
  // 或者带 vq-lift 的 <article>——「看着能点」，但能不能 Tab 到是另一件事。
  const out = []
  const nodes = document.querySelectorAll('article, div, li')
  for (const el of nodes) {
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
    let hasClick = false
    for (const k of Object.keys(el)) {
      if (k.indexOf('__reactProps$') === 0) {
        const props = el[k]
        if (props && typeof props.onClick === 'function') hasClick = true
      }
    }
    if (typeof el.onclick === 'function') hasClick = true
    const liftArticle = el.tagName === 'ARTICLE' && el.classList.contains('vq-lift')
    if (!hasClick && !liftArticle) continue
    const cls = String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
    const rr = el.getBoundingClientRect()
    // cursor 要看「鼠标落在谁身上」：整卡可点靠按钮的 ::after 热区，卡片自己的 computed cursor 会骗人。
    const hit = document.elementFromPoint(Math.round(rr.left + rr.width / 2), Math.round(rr.top + rr.height / 2))
    const hitCls = hit ? String(hit.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''
    out.push({
      tag: el.tagName,
      cls: cls || String(el.id || '') || '(无类名)',
      size: Math.round(rr.width) + 'x' + Math.round(rr.height),
      cursorOwn: cs.cursor,
      cursor: hit ? getComputedStyle(hit).cursor : null,
      hitTag: hit ? hit.tagName : '',
      hitCls: hitCls,
      stretchedOpen: Boolean(hit && hit.closest && hit.closest('.vq-card-open')),
      openButtonInside: el.querySelectorAll('.vq-card-open').length,
      tabIndex: el.tabIndex,
      tabReachable: el.tabIndex >= 0,
      hasOnClick: hasClick,
      lift: liftArticle,
      innerButtons: el.querySelectorAll('button, a[href], [role="button"]').length,
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      path: window.__r329path(el),
    })
  }
  return out
}

function focusStep(F) {
  let list = Array.prototype.slice.call(document.querySelectorAll(F.sel))
  if (F.text) list = list.filter(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim() === F.text })
  const card = list[F.index || 0]
  const active = document.activeElement
  const raw = active && active.getAttribute && active.getAttribute('class')
  return {
    tag: active ? String(active.tagName || '') : 'null',
    cls: String(raw || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.'),
    text: active ? String(active.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) : '',
    onCard: Boolean(card && active === card),
    inCard: Boolean(card && active && card.contains(active)),
    isBody: active === document.body,
  }
}

function sanitizeVisibleText() {
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
  let count = 0
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const node of nodes) {
    const parent = node.parentElement
    if (!parent) continue
    const style = getComputedStyle(parent)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
    const before = node.nodeValue || ''
    const after = before.replace(emailRe, '<email>')
    if (after !== before) { node.nodeValue = after; count += 1 }
  }
  return count
}

// ---- 页面动作 ----
let navNonce = 0
function routeUrl(route) {
  navNonce += 1
  if (route.indexOf('admin:') === 0) return BASE + '/?edition=admin&n=' + navNonce + '#' + route.slice(6)
  return BASE + '/?n=' + navNonce + '#' + route
}
// 后台页只有管理员进得去：量到后台那一屏时把 cookie 换成管理员的，量完再换回来。
async function switchAccountCookie(which) {
  const value = which === 'admin' ? adminToken : token
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: value, domain: '127.0.0.1', path: '/', httpOnly: true })
}
let lastAnchor = { anchor: '', found: true, text: '' }
async function goto(route, anchor, who = 'user') {
  await switchAccountCookie(route.indexOf('admin:') === 0 ? 'admin' : who)
  await cdp.send('Page.navigate', { url: routeUrl(route) })
  await sleep(650)
  // 外壳没挂上多半是一次没加载完（chunk 被换掉、首帧太慢）：重载一次再等，别把一次抖动写成「这一屏没量到」。
  let shell = false
  for (let attempt = 0; attempt < 3 && !shell; attempt += 1) {
    shell = Boolean(await waitForExpr('Boolean(document.querySelector(".vq-content"))', '工作台外壳', 18, 250).catch(() => false))
    if (!shell) {
      console.log('SHELL-RETRY ' + route + ' attempt=' + (attempt + 1) + ' readyState=' + String(await evaluate('document.readyState').catch(() => '?')) + ' href=' + String(await evaluate('location.href').catch(() => '?')))
      await cdp.send('Page.reload', {})
      await sleep(1100)
    }
  }
  if (!shell) console.log('SHELL-DEAD ' + route + ' text=' + String(await evaluate('String(document.body.innerText || "").slice(0, 200)').catch(() => '')))
  let found = true
  try {
    await waitForExpr('Boolean(document.querySelector(' + JSON.stringify(anchor) + '))', '页面骨架 ' + anchor, 22, 150)
  } catch {
    // 骨架选择器可能写错了，也可能这一屏这次真的没渲染：不抛错，把页面上有什么记下来，
    // 让后面的动作自己失败并写清原因——「没量到」必须看得见，不能悄悄跳过。
    found = false
  }
  await sleep(180)
  lastAnchor = {
    anchor: anchor,
    found: found,
    text: found ? '' : String(await evaluate('String(document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 400)')),
  }
  if (!found) console.log('ANCHOR-MISS ' + anchor + ' :: ' + lastAnchor.text.slice(0, 160))
}

const overlayLog = []
let gateDone = false
async function dismissOverlays() {
  // 上手引导（vq-guide）：真点右上角那颗「关闭引导」。
  for (let i = 0; i < 3; i += 1) {
    if (!(await evaluate('Boolean(' + frExpr(q('.vq-guide')) + ')'))) break
    const rect = await rectOfFr({ sel: '.vq-guide [aria-label="关闭引导"]' })
    if (!rect) break
    await clickAt(rect.cx, rect.cy, 90)
    overlayLog.push({ what: '上手引导', how: '真点「关闭引导」（aria-label）', gone: !(await evaluate('Boolean(' + frExpr(q('.vq-guide')) + ')')) })
    await sleep(200)
  }
  // 身份引导（vq-gate）：三步、没有关闭键，只能真点走完。
  if (!gateDone && (await evaluate('Boolean(' + frExpr(q('.vq-gate')) + ')'))) {
    const steps = []
    const choice = await rectOfFr(nthOf('.vq-gate-choice', 0))
    if (choice) { await clickAt(choice.cx, choice.cy, 80); steps.push('点第 1 个身份') }
    const next1 = await rectOfFr(byText('继续', '.vq-gate-foot button'))
    if (next1) { await clickAt(next1.cx, next1.cy, 80); steps.push('第 1 步「继续」') }
    await sleep(800)
    const kind = await rectOfFr(nthOf('.vq-gate-kind', 0))
    if (kind) { await clickAt(kind.cx, kind.cy, 80); steps.push('点第 1 个类目') }
    const next2 = await rectOfFr(byText('继续', '.vq-gate-foot button'))
    if (next2) { await clickAt(next2.cx, next2.cy, 80); steps.push('第 2 步「继续」') }
    await sleep(800)
    const later = await rectOfFr(byText('以后再说', '.vq-gate-foot button'))
    if (later) { await clickAt(later.cx, later.cy, 90); steps.push('第 3 步「以后再说」') }
    await sleep(900)
    const gone = !(await evaluate('Boolean(' + frExpr(q('.vq-gate')) + ')'))
    overlayLog.push({ what: '身份引导', how: steps.join(' → '), gone: gone })
    gateDone = gone
  }
  const know = await rectOfFr({ sel: '[aria-label="知道了"]' })
  if (know) await clickAt(know.cx, know.cy, 70)
  return overlayLog
}

async function shot(name) {
  const captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = path.join(OUT_DIR, name)
  fs.writeFileSync(file, Buffer.from(captured.data, 'base64'))
  const bytes = fs.statSync(file).size
  console.log('SHOT ' + name + ' · ' + bytes + ' B')
  return { file: name, bytes: bytes, width: 1440, height: 1000 }
}

async function typeInto(F, text) {
  const rect = await evaluate('(' + bringIntoView.toString() + ')(' + JSON.stringify(F) + ')')
  if (!rect || rect.missing) throw new Error('找不到要打字的输入框：' + F.sel)
  if (!rect.inViewport) throw new Error('输入框滚不到视口里：' + F.sel)
  await clickAt(rect.cx, rect.cy, 54)
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await sleep(60)
  // 逐字符发真按键（Input.dispatchKeyEvent type=char），不用 insertText：
  // 口令框这种受控输入实测 insertText 只改了 DOM 的 value，React 的 state 没跟上，
  // 点提交时界面还说「请输入当前口令」——那就不是按钮没反应，是我们的打字方式不算真输入。
  for (const char of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: char, unmodifiedText: char, key: char })
    await sleep(14)
  }
  await sleep(80)
  return evaluate('(() => { const el = ' + frExpr(F) + '; return el ? String(el.value || "") : null })()')
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
function pathOf(url) {
  try { return new URL(url).pathname } catch { return String(url) }
}
function requestStats(since, expectPath) {
  const rows = cdp.requests.slice(since).map((row) => ({ method: row.method, path: pathOf(row.url) }))
  const writes = rows.filter((row) => WRITE_METHODS.has(row.method) && row.path.indexOf('/api/') === 0)
  const scoped = expectPath ? writes.filter((row) => row.path.indexOf(expectPath) === 0) : writes
  const counts = {}
  for (const row of scoped) counts[row.method + ' ' + row.path] = (counts[row.method + ' ' + row.path] || 0) + 1
  return { writes: scoped.length, counts: counts, apiCalls: rows.filter((row) => row.path.indexOf('/api/') === 0).length }
}

const STYLE_PROPS = ['transform', 'borderColor', 'boxShadow', 'backgroundColor', 'color', 'outline']
function diffProps(base, now, props) {
  const changed = []
  for (const prop of props) {
    if (!base || !now) continue
    if (String(base[prop]) !== String(now[prop])) changed.push(prop + ': ' + String(base[prop]) + ' → ' + String(now[prop]))
  }
  return changed
}

let preparedValues = null

async function measureAction(screen, action) {
  const entry = {
    screen: screen.id, screenLabel: screen.label, id: action.id, label: action.label,
    selector: action.fr.sel + (action.fr.text ? ' （文本 = ' + action.fr.text + '）' : ''),
    expect: action.expect || '', why: action.why || '',
  }
  if (action.skip) {
    entry.skipped = action.skip
    console.log('SKIP ' + screen.id + '/' + action.id + ' :: ' + action.skip)
    return entry
  }
  try {
    await goto(screen.route, screen.anchor, screen.who || 'user')
    await dismissOverlays()
    if (action.prepare) await action.prepare()
    await sleep(160)
    entry.anchor = lastAnchor
    if (preparedValues) { entry.prepared = preparedValues; preparedValues = null }
    const F = action.fr
    let view = await evaluate('(' + bringIntoView.toString() + ')(' + JSON.stringify(F) + ')')
    if (!view || view.missing) throw new Error('动作元素不在页面上：' + entry.selector)
    entry.rect = { l: view.l, t: view.t, w: view.w, h: view.h, cx: view.cx, cy: view.cy }
    entry.inViewport = view.inViewport
    entry.scroller = view.scroller
    if (!view.inViewport) throw new Error('滚到眼前之后仍然不在视口里（t=' + view.t + ', h=' + view.h + '），这一拍量不了')
    const base = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(F) + ')')
    if (!base || base.missing) throw new Error('动作元素不在页面上：' + entry.selector)
    entry.textBefore = base.text
    entry.cursorOwn = base.cursor
    entry.disabledBefore = base.disabled
    let blocked = await evaluate('(' + blockedProbe.toString() + ')(' + JSON.stringify(F) + ',' + view.cx + ',' + view.cy + ')')
    if (blocked) {
      // 落点被别的东西压住了：先如实记下是谁，再等它自己消失后量这颗按钮本身。
      const waitFrom = Date.now()
      entry.blockedBy = blocked
      await waitForExpr('Boolean(!document.querySelector(".vq-toast"))', 'toast 消失', 45, 200).catch(() => { /* 没消失就继续，下面还会再判一次 */ })
      await sleep(200)
      const again = await evaluate('(' + bringIntoView.toString() + ')(' + JSON.stringify(F) + ')')
      if (again && !again.missing) {
        view = again
        entry.rect = { l: view.l, t: view.t, w: view.w, h: view.h, cx: view.cx, cy: view.cy }
        entry.inViewport = view.inViewport
        blocked = await evaluate('(' + blockedProbe.toString() + ')(' + JSON.stringify(F) + ',' + view.cx + ',' + view.cy + ')')
        entry.waitedForBlockMs = Date.now() - waitFrom
        entry.stillBlockedBy = blocked || null
      }
    }
    const base2 = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(F) + ')')
    if (base2 && !base2.missing) Object.assign(base, base2)
    entry.hit = await evaluate('(' + hitProbe.toString() + ')(' + view.cx + ',' + view.cy + ')')
    entry.cursor = entry.hit ? entry.hit.cursor : null
    entry.cursorNote = entry.hit ? entry.hit.tag + (entry.hit.cls ? '.' + entry.hit.cls : '') + ' 的 cursor' + (entry.hit.stretchedOpen ? '（命中了 .vq-card-open 热区）' : '') : '命中元素读不到'
    entry.box = await evaluate('(' + boxProbe.toString() + ')(' + JSON.stringify(F) + ')')

    await evaluate('(' + installWatch.toString() + ')(' + JSON.stringify(F) + ',' + JSON.stringify({ disabled: base.disabled, text: base.text, svg: base.svg, spin: base.spin, ariaBusy: base.ariaBusy }) + ')')
    const segBefore = await evaluate('(String(location.hash || "").split("/")[1] || "")')
    const netMark = cdp.requests.length

    // ① 悬停：移到中心等 250ms
    await mouseTo(base.cx, base.cy)
    await sleep(250)
    const hover = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(F) + ')')
    entry.hover = { matched: Boolean(hover && hover.hover), changed: diffProps(base, hover, STYLE_PROPS) }

    // ② 按下：真 mousePressed，下一帧读同样这几个属性 + :active
    await mouseDown(base.cx, base.cy)
    const pressed = await evaluate('new Promise(function (done) { requestAnimationFrame(function () { requestAnimationFrame(function () { done((' + probeEl.toString() + ')(' + JSON.stringify(F) + ')) }) }) })')
    entry.press = { matched: Boolean(pressed && pressed.active), changed: diffProps(base, pressed, STYLE_PROPS) }
    if (action.pressShot) entry.pressShot = await shot(screen.id + '-press.png')

    // ③ 松开 → 每 16ms 采一帧，量「第一个可见进行中信号」
    await mouseUp(base.cx, base.cy)
    await sleep(24)
    // 进行中再真点两次；如果这一拍压根没有进行中态，也照点，报告里如实写「点的时候已经不在进行中」。
    const extra = []
    for (let i = 0; i < 2; i += 1) {
      const watch = await evaluate('(' + readWatch.toString() + ')()')
      extra.push({ nth: i + 1, busyAtClick: Boolean(watch && watch.busyMs !== null && watch.busyEndedMs === null), signal: watch ? watch.busySignal : null })
      await clickAt(base.cx, base.cy, 40)
    }
    await sleep(1400)
    const watch = await evaluate('(' + readWatch.toString() + ')()')
    entry.busyMs = watch ? watch.busyMs : null
    entry.busySignal = watch ? watch.busySignal : null
    entry.busyScope = watch ? watch.busyScope : null
    entry.busyWindowMs = watch ? watch.busyEndedMs : null
    // 点了就跳页的动作（例如工作台主卡）：那一跳里的毫秒数是「下一页同名元素出现」的时间，
    // 不是这一颗按钮的进行中态。原始数字留着，但不算数。
    const segAfter = await evaluate('(String(location.hash || "").split("/")[1] || "")')
    entry.routeBefore = segBefore
    entry.routeAfter = segAfter
    // 只有「整屏换了」（#/overview → #/radar）才算跳页；#/templates → #/templates/xxx 还是这一屏。
    entry.navigated = segBefore !== segAfter
    if (entry.navigated && entry.busyMs !== null) {
      entry.busyMsRaw = entry.busyMs
      entry.busyMs = null
      entry.busyNote = '点了就跳页（#/' + segBefore + ' → #/' + segAfter + '）：原始 ' + entry.busyMsRaw + 'ms 是下一页同名元素的渲染时间，不算进行中信号'
    }
    entry.pageNotes = await evaluate('(' + pageNotesProbe.toString() + ')()')
    if (action.afterProbe) entry.afterProbe = await evaluate(action.afterProbe)
    entry.extraClicks = extra
    const stats = requestStats(netMark, action.expect)
    entry.writes = stats.writes
    entry.writeCounts = stats.counts
    entry.apiCalls = stats.apiCalls
    entry.dupRequests = action.expect ? stats.writes : null
    entry.dupNote = action.expect
      ? (stats.writes > 1 ? '这个接口被打 ' + stats.writes + ' 次' : '这个接口被打 1 次')
      : '这个动作不发写请求（dupRequests 不适用）'
    const after = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(F) + ')')
    entry.textAfter = after && after.missing ? '(元素已经不在页面上了)' : (after ? after.text : null)
    entry.hashAfter = await evaluate('location.hash')
  } catch (error) {
    entry.error = String((error && error.message) || error).slice(0, 300)
    console.log('ERROR ' + screen.id + '/' + action.id + ' :: ' + entry.error)
    if (action.pressShot) { try { await mouseUp(entry.rect ? entry.rect.cx : 700, entry.rect ? entry.rect.cy : 500) } catch { /* 忽略 */ } }
  }
  return entry
}

// ---- 九屏：主要动作逐个量（每屏至少 2 个）----
const SCREENS = [
  {
    id: 'overview', label: '工作台', route: '/overview', anchor: '.vq-next-cta',
    actions: [
      { id: 'hero-cta', label: '主卡「下一步」主按钮', fr: q('.vq-next-cta'), pressShot: true, why: '点了会跳页（去检索 / 继续作品），跳走之后原节点卸载，所以进行中那一拍来不及拍' },
      { id: 'head-refresh', label: '页头「刷新」次要按钮', fr: byText('刷新', '.vq-head-actions button'), expect: '' },
    ],
  },
  {
    id: 'projects', label: '作品', route: '/projects', anchor: '.vq-project-page',
    actions: [
      {
        id: 'project-card', label: '作品卡片（.vq-project-card，<button>）', fr: q('.vq-project-card'), pressShot: true,
        expect: '', why: '默认进来是「创作成果」视图，先真点页头「作品项目」切过去',
        prepare: async () => {
          const hit = await clickFr(byText('作品项目', '.vq-head-actions button'), 80)
          if (!hit) throw new Error('找不到「作品项目」切换按钮')
          await waitForExpr('Boolean(' + frExpr(q('.vq-project-card')) + ')', '作品卡片')
        },
      },
      { id: 'work-card-action', label: '卡片上的次要按钮（.works-action「下载」）', fr: byText('下载', '.works-action'), expect: '', why: '卡片右下的次要按钮，点了会把成品存到本机（不发写请求）' },
    ],
  },
  {
    id: 'agents', label: '快捷创作', route: '/agents', anchor: '.agx-send',
    actions: [
      {
        id: 'send', label: '对话框「发送」（.agx-send）', fr: q('.agx-send'), pressShot: true,
        expect: '/api/agents/', why: '先真打一行字进去再点；模型上游指向本机死地址，只会走到本地那条失败路径',
        prepare: async () => {
          // 这一屏默认停在「平台对话」，带 .agx-send 的输入卡是 hidden 的（h=0）：
          // 先真点「对话预设」页签切过去，再选预设、再打字。
          const tab = await clickFr(byText('对话预设', '.agx-surface-switch button'), 90)
          if (!tab) throw new Error('找不到「对话预设」页签')
          await waitForExpr('Boolean(' + frExpr(q('.agx-card-main')) + ')', '预设卡片')
          const pick = await clickFr(q('.agx-card-main'), 90)
          if (!pick) throw new Error('预设库里没有可点的「选择」按钮')
          await waitForExpr('Boolean((' + frExpr(q('.agx-textarea')) + ').disabled === false)', '输入框解锁')
          await typeInto(q('.agx-textarea'), '把这条 30 秒口播拆成分镜表')
        },
      },
      {
        id: 'pick-agent', label: '预设卡片的「选择」按钮（.agx-card-main）', fr: q('.agx-card-main'), expect: '',
        why: '预设卡片本体是 <article>，真正能点的是里面这颗 button；卡片上有「当前」标记与模型/次数',
        prepare: async () => {
          const tab = await clickFr(byText('对话预设', '.agx-surface-switch button'), 90)
          if (!tab) throw new Error('找不到「对话预设」页签')
          await waitForExpr('Boolean(' + frExpr(q('.agx-card-main')) + ')', '预设卡片')
        },
      },
      { id: 'gen-image', label: '图片模式「生成图片」', fr: q('button[aria-label="生成图片"]'), skip: '跳过：会扣积分 / 走上游（本轮 0 次上游调用是硬要求）' },
    ],
  },
  {
    id: 'assets', label: '素材', route: '/assets', anchor: '.vq-assets-toolbar',
    actions: [
      { id: 'new-asset', label: '页头「新建产品资产」主按钮', fr: byText('新建产品资产', '.vq-head-actions button'), pressShot: true, expect: '', why: '点了打开建资产面板；面板里的「生成」会扣积分，本轮不点' },
      { id: 'refresh', label: '页头「刷新」次要按钮', fr: byText('刷新', '.vq-head-actions button'), expect: '' },
    ],
  },
  {
    id: 'templates', label: '模板库', route: '/templates', anchor: '.template-card',
    actions: [
      {
        id: 'apply', label: '详情抽屉「用它做作品」主按钮', fr: byText('用它做作品', '.template-drawer button'), pressShot: true,
        expect: '/api/projects', why: '先真点卡片（article + onClick）打开抽屉，再点这颗',
        prepare: async () => {
          const card = await clickFr(nthOf('.template-card', 0), 90)
          if (!card) throw new Error('模板库一条都没有')
          await waitForExpr('Boolean(' + frExpr(q('.template-drawer')) + ')', '模板详情抽屉')
        },
      },
      { id: 'card-adapt', label: '卡片上的次要按钮（.template-adapt「用这条改编」）', fr: q('.template-adapt'), expect: '', why: '卡片右下那颗小按钮（onClick 里 stopPropagation，但不改 button 语义）' },
    ],
  },
  {
    id: 'settings', label: '设置', route: '/settings', anchor: '.vq-settings-grid',
    actions: [
      {
        id: 'change-password', label: '「更新口令」主按钮（本页唯一会写盘的保存类按钮）', fr: byText('更新口令', 'button'), pressShot: true,
        expect: '/api/account', why: '本页没有叫「保存」的按钮；先真打三个口令框再点',
        afterProbe: '(function () { const f = document.querySelectorAll("#account-security .vq-password-form input"); return Array.prototype.map.call(f, function (el) { return String(el.value || "").length }) })()',
        prepare: async () => {
          const v1 = await typeInto(q('#account-security .vq-password-form .vq-field:nth-of-type(1) input'), PASSWORD)
          const v2 = await typeInto(q('#account-security .vq-password-form .vq-field:nth-of-type(2) input'), NEW_PASSWORD)
          const v3 = await typeInto(q('#account-security .vq-password-form .vq-field:nth-of-type(3) input'), NEW_PASSWORD)
          // 点完之后再看一眼三个框：受控组件若没收到 onChange，重渲染会把 DOM 里的字清回去。
          // 打了字要确认真的进去了：这里读回三个框的长度与当时的焦点，别把「脚本没写上」写成「按钮没反应」。
          const active = await evaluate('(() => { const el = document.activeElement; const cls = String(el && el.getAttribute("class") || ""); return { tag: el ? el.tagName : "null", cls: cls, type: el ? String(el.getAttribute("type") || "") : "" } })()')
          preparedValues = { lengths: [String(v1 || '').length, String(v2 || '').length, String(v3 || '').length], active: active }
        },
      },
      {
        id: 'credit-request', label: '「提交申请」主按钮（额度申请）', fr: byText('提交申请', 'button'), expect: '/api/credits', why: '先点「申请额度」展开表单（默认金额 200）',
        prepare: async () => {
          const open = await clickFr(byText('申请额度', 'button'), 80)
          if (!open) throw new Error('找不到「申请额度」按钮')
          await waitForExpr('Boolean(' + frExpr(byText('提交申请', 'button')) + ')', '额度申请表单')
        },
      },
    ],
  },
  {
    id: 'runs', label: '运行记录', route: '/runs', who: 'admin', anchor: '#runs-tab-credits',
    actions: [
      {
        id: 'tab-runs', label: '「工作流运行」页签（这一屏真正的运行记录入口）', fr: byText('工作流运行', 'button'), pressShot: true, expect: '',
        why: '这一屏（导航里叫「积分记录」）默认停在「积分明细」，运行记录在另一个页签里',
      },
      {
        id: 'refresh', label: '运行记录工具栏「刷新」', fr: byText('刷新', 'button'), expect: '',
        why: '空账号下这屏没有主按钮；「继续跑」会扣积分，跳过',
        prepare: async () => {
          const tab = await clickFr(byText('工作流运行', 'button'), 80)
          if (!tab) throw new Error('找不到「工作流运行」页签')
          await waitForExpr('Boolean(document.querySelector(".runs-stats"))', '运行记录骨架')
        },
      },
      { id: 'resume-run', label: '「继续跑」主按钮', fr: byText('继续跑', 'button'), skip: '跳过：会扣积分 / 走上游（空账号下这颗按钮本来也不在）' },
    ],
  },
  {
    id: 'review', label: '视觉评审', route: '/review', anchor: '.review-page',
    actions: [
      { id: 'picker-toggle', label: '「单独评这张画面」展开按钮（.review-picker-toggle）', fr: q('.review-picker-toggle'), expect: '', why: '这一屏的主按钮「开始评审」会扣积分，跳过；换成同一屏能安全点的展开按钮' },
      { id: 'review-run', label: '「开始评审」主按钮', fr: q('.review-actions .vq-button--primary, .vq-button--primary'), skip: '跳过：会扣积分 / 走上游' },
    ],
  },
  {
    id: 'admin-promos', label: '后台运营位', route: 'admin:/admin/system', anchor: '.admin-promo-actions',
    actions: [
      { id: 'save', label: '「保存运营位」主按钮', fr: byText('保存运营位', '.admin-promo-actions button'), pressShot: true, expect: '/api/admin/promos' },
      { id: 'add-row', label: '「新增一条」次要按钮', fr: byText('新增一条', 'button'), expect: '', why: '只往草稿里加一行，不落盘' },
    ],
  },
]

// ---- A/B：模板库卡片（article + onClick）对作品页卡片（button）----
async function cardPattern(kind, reachTabs) {
  const spec = kind === 'templates'
    ? { route: '/templates', anchor: '.template-card', card: q('.template-card'), view: '模板库', prepare: null }
    : { route: '/projects', anchor: '.vq-project-page', card: q('.vq-project-card'), view: '作品页', prepare: '作品项目' }
  const out = { kind: kind, screen: spec.view, selector: '.template-card / .vq-project-card'.split(' / ')[kind === 'templates' ? 0 : 1] }
  await goto(spec.route, spec.anchor)
  await dismissOverlays()
  if (spec.prepare) {
    const rect = await rectOfFr(byText(spec.prepare, '.vq-head-actions button'))
    if (rect) await clickAt(rect.cx, rect.cy, 80)
    await waitForExpr('Boolean(' + frExpr(spec.card) + ')', spec.view + '卡片')
  }
  const info = await evaluate('(' + cardHitProbe.toString() + ')(' + JSON.stringify(spec.card) + ')')
  out.tag = info ? info.tag : null
  out.cursorOwn = info ? info.cursorOwn : null
  out.cursor = info && info.hit ? info.hit.cursor : null
  out.hit = info ? info.hit : null
  out.openButtons = info ? info.openButtons : 0
  out.tabIndex = info ? info.tabIndex : null
  out.role = info ? info.role : null
  out.text = info && info.hit ? info.hit.text : null
  // Tab 能不能走到这张卡：先把焦点交回文档，再按 reachTabs 次 Tab，记每一步落点。
  await evaluate('(document.activeElement && document.activeElement.blur ? document.activeElement.blur() : null)')
  const steps = []
  let reached = false
  let reachedAt = null
  for (let i = 0; i < reachTabs; i += 1) {
    await pressTab(false)
    const step = await evaluate('(' + focusStep.toString() + ')(' + JSON.stringify(spec.card) + ')')
    step.index = i + 1
    steps.push(step)
    if (!reached && (step.onCard || step.inCard)) { reached = true; reachedAt = i + 1 }
  }
  out.tabReachable = reached
  out.reachedAt = reachedAt
  out.tabTrace = steps.map((s) => s.index + (s.onCard ? ':卡上' : s.inCard ? ':卡内' : ':' + s.tag + (s.cls ? '.' + s.cls : '')))
  // 卡中心真点一下，看有没有反应
  const before = await evaluate('({ hash: location.hash, drawer: Boolean(' + frExpr(q('.drawer-backdrop')) + ') })')
  const hit = await clickFr(spec.card, 90)
  out.rect = hit ? { l: hit.l, t: hit.t, w: hit.w, h: hit.h } : null
  await sleep(650)
  const after = await evaluate('({ hash: location.hash, drawer: Boolean(' + frExpr(q('.drawer-backdrop')) + '), cards: document.querySelectorAll(' + JSON.stringify(spec.card.sel) + ').length })')
  out.click = {
    hashBefore: before.hash, hashAfter: after.hash,
    drawerAfter: after.drawer, cardsAfter: after.cards,
    opened: before.hash !== after.hash || (after.drawer && !before.drawer) || after.cards !== 1,
  }
  out.screenshot = await shot('card-' + kind + '.png')
  return out
}

// ---- 页面侧：卡片正文落点 / 当前焦点 ----
function cardBodyProbe(F, ratio) {
  // 点「正文」不点按钮：卡片正文中心往上一截（避开底部那行动作按钮）。
  let list = Array.prototype.slice.call(document.querySelectorAll(F.sel))
  if (F.text) list = list.filter(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim() === F.text })
  const el = list[F.index || 0]
  if (!el) return { missing: true }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + r.height * ratio)
  const hit = document.elementFromPoint(x, y)
  const cls = hit ? String(hit.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''
  return {
    x: x, y: y,
    cardTop: Math.round(r.top), cardH: Math.round(r.height), cardW: Math.round(r.width),
    hasOpenButton: el.querySelectorAll('.vq-card-open').length,
    liftClass: el.classList.contains('vq-lift'),
    inViewport: r.top >= 4 && r.bottom <= window.innerHeight - 4,
    hit: hit ? {
      tag: hit.tagName, cls: cls, cursor: getComputedStyle(hit).cursor,
      path: window.__r329path ? window.__r329path(hit) : cls,
      stretchedOpen: Boolean(hit.closest && hit.closest('.vq-card-open')),
      insideCard: el.contains(hit),
      text: String(hit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
    } : null,
  }
}

function cardHitProbe(F) {
  // 卡片这一层：computed cursor 说的是 <article> 自己，鼠标真正落在谁身上要另看。
  const el = document.querySelector(F.sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + Math.min(40, r.height / 2))
  const hit = document.elementFromPoint(x, y)
  const hcs = hit ? getComputedStyle(hit) : null
  const hcls = hit ? String(hit.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''
  return {
    tag: el.tagName,
    cursorOwn: getComputedStyle(el).cursor,
    tabIndex: el.tabIndex,
    role: el.getAttribute('role'),
    openButtons: el.querySelectorAll('.vq-card-open').length,
    point: { x: x, y: y },
    hit: hit ? {
      tag: hit.tagName, cls: hcls, cursor: hcs.cursor,
      stretchedOpen: Boolean(hit.closest && hit.closest('.vq-card-open')),
      insideCard: el.contains(hit),
      text: String(hit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
    } : null,
  }
}

function pageNotesProbe() {
  // 点完之后页面上有没有留下话（报错 / 提示 / toast）：0 个写请求的时候，原因多半写在这里。
  const sel = '[role="alert"], .vq-field-error, .vq-note--error, .vq-password-ok, .vq-toast, .runs-note, .admin-note, .agx-failure'
  const out = []
  Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) out.push(text.slice(0, 90))
  })
  return out.slice(0, 6)
}

function pageTextProbe() {
  return { hash: location.hash, drawer: Boolean(document.querySelector('.drawer-backdrop')), text: String(document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 80) }
}

function activeProbe(TARGET, CARD) {
  // 当前焦点落在哪、以及它是不是「目标按钮 / 卡片里的东西」。
  const active = document.activeElement
  const raw = active && active.getAttribute && active.getAttribute('class')
  const cls = String(raw || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
  const target = active && active.closest ? active.closest(TARGET.sel) : null
  const card = active && active.closest ? active.closest(CARD.sel) : null
  return {
    desc: active ? String(active.tagName).toLowerCase() + (cls ? '.' + cls : '') : 'null',
    tag: active ? active.tagName : 'null',
    cls: cls,
    className: String(raw || ''),
    text: active ? String(active.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) : '',
    isBody: active === document.body,
    onTarget: Boolean(target),
    targetText: target ? String(target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16) : '',
    inCard: Boolean(card),
    cardTitle: card ? String(card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20) : '',
  }
}

// ---- ① 点卡片正文会不会跳（这一轮的正面证据）----
async function bodyClickSection() {
  const specs = [
    { id: 'ov-cap-1', screen: 'overview', route: '/overview', anchor: '.vq-next-cta', card: nthOf('.ov-cap', 0), label: '能力卡 01 找爆款', expect: 'radar', expectNav: true },
    { id: 'ov-cap-2', screen: 'overview', route: '/overview', anchor: '.vq-next-cta', card: nthOf('.ov-cap', 1), label: '能力卡 02 模板库', expect: 'templates', expectNav: true },
    { id: 'ov-cap-3', screen: 'overview', route: '/overview', anchor: '.vq-next-cta', card: nthOf('.ov-cap', 2), label: '能力卡 03 我的资产', expect: 'assets', expectNav: true },
    { id: 'ov-cap-4', screen: 'overview', route: '/overview', anchor: '.vq-next-cta', card: nthOf('.ov-cap', 3), label: '能力卡 04 快捷创作+视觉评审', expect: '不变', expectNav: false },
    { id: 'ov-promo-1', screen: 'overview', route: '/overview', anchor: '.vq-next-cta', card: nthOf('.vq-promo', 0), label: '运营位第 1 条', expect: '跳转', expectNav: true },
    { id: 'tpl-card-1', screen: 'templates', route: '/templates', anchor: '.template-card', card: nthOf('.template-card', 0), label: '模板卡片正文', expect: '抽屉打开', expectDrawer: true },
  ]
  const out = []
  for (const spec of specs) {
    const entry = { id: spec.id, screen: spec.screen, label: spec.label, expect: spec.expect, card: spec.card.sel + '[' + (spec.card.index || 0) + ']' }
    try {
      await goto(spec.route, spec.anchor)
      await dismissOverlays()
      await evaluate('(' + installPathHelper.toString() + ')()')
      await sleep(180)
      const point = await evaluate('(' + cardBodyProbe.toString() + ')(' + JSON.stringify(spec.card) + ',0.42)')
      if (!point || point.missing) throw new Error('卡片不在页面上')
      entry.point = { x: point.x, y: point.y, cardTop: point.cardTop, cardH: point.cardH }
      entry.hasOpenButton = point.hasOpenButton
      entry.liftClass = point.liftClass
      entry.inViewport = point.inViewport
      entry.hit = point.hit
      // 悬停：抬起（vq-lift）该不该有
      const before = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(spec.card) + ')')
      await mouseTo(point.x, point.y)
      await sleep(250)
      const hover = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(spec.card) + ')')
      entry.hoverLift = { hovered: Boolean(hover && hover.hover), changed: diffProps(before, hover, ['transform', 'boxShadow', 'borderColor']) }
      // 真点正文
      const pre = await evaluate('({ hash: location.hash, drawer: Boolean(document.querySelector(".drawer-backdrop")) })')
      await mouseDown(point.x, point.y)
      await sleep(60)
      await mouseUp(point.x, point.y)
      await sleep(800)
      const post = await evaluate('(' + pageTextProbe.toString() + ')()')
      entry.hashBefore = pre.hash
      entry.hashAfter = post.hash
      entry.hashChanged = pre.hash !== post.hash
      entry.drawerOpened = post.drawer && !pre.drawer
      entry.afterText = post.text
      entry.verdict = spec.expectDrawer
        ? (entry.drawerOpened ? '抽屉开了' : '点正文没开抽屉')
        : (entry.hashChanged ? '跳到了 ' + entry.hashAfter : '路由没变')
      await shot('card-body-' + spec.id + '.png')
    } catch (error) {
      entry.error = String((error && error.message) || error).slice(0, 200)
      console.log('ERROR body-click ' + spec.id + ' :: ' + entry.error)
    }
    console.log('BODY ' + spec.id + ' :: ' + JSON.stringify(entry.hit) + ' → ' + (entry.verdict || entry.error))
    out.push(entry)
  }
  return out
}

// ---- ② Tab 能不能到卡片 ----
async function tabWalkSection() {
  const specs = [
    { id: 'templates-tab', route: '/templates', anchor: '.template-card', card: q('.template-card'), target: q('.template-card'), steps: 30, label: '模板库：Tab 到卡片' },
    { id: 'overview-caps-tab', route: '/overview', anchor: '.vq-next-cta', card: nthOf('.ov-cap', 0), target: q('.ov-cap-action'), steps: 30, label: '工作台：Tab 到能力卡按钮' },
  ]
  const out = []
  for (const spec of specs) {
    const entry = { id: spec.id, label: spec.label, target: spec.target.sel }
    try {
      await goto(spec.route, spec.anchor)
      await dismissOverlays()
      await evaluate('(' + installPathHelper.toString() + ')()')
      await evaluate('(document.activeElement && document.activeElement.blur ? document.activeElement.blur() : null)')
      await sleep(120)
      const steps = []
      let reachedAt = null
      for (let i = 0; i < spec.steps; i += 1) {
        await pressTab(false)
        const step = await evaluate('(' + activeProbe.toString() + ')(' + JSON.stringify(spec.target) + ',' + JSON.stringify(spec.card) + ')')
        step.index = i + 1
        steps.push(step)
        if (!reachedAt && step.onTarget) { reachedAt = i + 1; break }
      }
      entry.steps = steps.length
      entry.trace = steps.map((s) => s.index + ':' + s.desc + (s.inCard ? '(卡内)' : '') + (s.onTarget ? '(目标)' : ''))
      entry.reachedAt = reachedAt
      entry.crossedCard = steps.some((s) => s.inCard)
      entry.insideDescs = Array.from(new Set(steps.filter((s) => s.inCard).map((s) => s.desc + ' "' + s.text + '"')))
      entry.cardOpenButtonCount = await evaluate('document.querySelectorAll(' + JSON.stringify(spec.card.sel + ' .vq-card-open') + ').length')
      entry.targetText = (steps.find((s) => s.onTarget) || {}).targetText || ''
      entry.fullTrace = steps.map((s) => s.index + ': <' + s.tag.toLowerCase() + ' class="' + s.className + '"> ' + s.text)
      const firstInside = steps.find((s) => s.inCard) || null
      entry.firstInside = firstInside
        ? { index: firstInside.index, tag: firstInside.tag, className: firstInside.className, text: firstInside.text }
        : null
      entry.firstInsideLabel = firstInside
        ? (/(^|\s)template-open(\s|$)/.test(firstInside.className)
            ? '.template-open（卡片标题那颗）'
            : /(^|\s)template-adapt(\s|$)/.test(firstInside.className)
              ? '.template-adapt（用这条改编）'
              : /(^|\s)ov-cap-action(\s|$)/.test(firstInside.className)
                ? '.ov-cap-action（能力卡上的动作）'
                : '（没有已知类名）' + firstInside.className)
        : 'Tab 这一串里没有落进卡片'
      entry.firstInsideHasCardOpen = Boolean(firstInside && /(^|\s)vq-card-open(\s|$)/.test(firstInside.className))
      // 焦点落在卡片里的按钮上时按回车：会不会真的打开
      if (reachedAt) {
        const pre = await evaluate('({ hash: location.hash, drawer: Boolean(document.querySelector(".drawer-backdrop")) })')
        await pressEnter()
        await sleep(900)
        const post = await evaluate('({ hash: location.hash, drawer: Boolean(document.querySelector(".drawer-backdrop")) })')
        entry.enter = {
          on: steps[steps.length - 1].desc,
          onClass: steps[steps.length - 1].className,
          hashBefore: pre.hash, hashAfter: post.hash,
          hashChanged: pre.hash !== post.hash,
          drawerBefore: pre.drawer, drawerAfter: post.drawer,
          drawerOpened: post.drawer && !pre.drawer,
        }
      } else {
        entry.enter = { skipped: 'Tab ' + spec.steps + ' 次都没落到目标按钮上' }
      }
      await shot('tab-' + spec.id + '.png')
    } catch (error) {
      entry.error = String((error && error.message) || error).slice(0, 200)
      console.log('ERROR tab-walk ' + spec.id + ' :: ' + entry.error)
    }
    console.log('TAB ' + spec.id + ' :: reachedAt=' + entry.reachedAt + ' crossedCard=' + entry.crossedCard + ' enter=' + JSON.stringify(entry.enter))
    out.push(entry)
  }
  return out
}

// ---- 跑起来 ----
const results = []
const screenshots = []
const screenScans = []
const cardPatterns = []
let bodyClicks = []
let tabWalks = []
let stopped = false

try {
  await waitFor(async () => {
    const response = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(800) })
    return response.ok
  }, '临时实例的 /api/health')

  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((response) => response.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')

  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('DOM.enable')
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })

  const active = SCREENS.filter((screen) => !ONLY.length || ONLY.indexOf(screen.id) >= 0)

  // 第一屏先真走一遍引导（新 profile 会挡屏），走了什么按钮全记进报告。
  const first = active.length ? active[0] : SCREENS[0]
  await goto(first.route, first.anchor, first.who || 'user')
  await sleep(700)
  await dismissOverlays()
  if (overlayLog.length) note('开场遮罩：真点关掉了', overlayLog)
  else note('开场遮罩：这一轮没有出现需要关的遮罩')
  // 之后每一屏重新加载都要干净：把「看过上手引导」按账号记进 localStorage。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1');localStorage.setItem('vq.edition','user')}catch(e){}",
  })

  for (const screen of active) {
    console.log('---- 屏：' + screen.id + ' · ' + screen.label)
    await goto(screen.route, screen.anchor, screen.who || 'user')
    await dismissOverlays()
    await evaluate('(' + installPathHelper.toString() + ')()')
    await sleep(200)
    const sanitized = await evaluate('(' + sanitizeVisibleText.toString() + ')()')
    const scan = await evaluate('(' + scanInteractive.toString() + ')()')
    const fakes = await evaluate('(' + scanFakeClickable.toString() + ')()')
    screenScans.push({ screen: screen.id, screenLabel: screen.label, anchor: lastAnchor, sanitized: sanitized, interactive: scan, fakeClickable: fakes })
    if (sanitized > 0) note(screen.label + '：截图前替换了 ' + sanitized + ' 处邮箱', { count: sanitized })
    screenshots.push(await shot(screen.id + '.png'))
    console.log('SCAN ' + screen.id + ' · 可点 ' + scan.checked + ' · cursor 不是 pointer 且可用 ' + scan.nonPointerEnabled + ' · 假可点 ' + fakes.length)
    for (const action of screen.actions) {
      const entry = await measureAction(screen, action)
      results.push(entry)
      console.log('MEASURE ' + screen.id + '/' + action.id + ' :: cursor=' + entry.cursor + ' hover=' + JSON.stringify(entry.hover ? entry.hover.changed : null) + ' press=' + JSON.stringify(entry.press ? entry.press.changed : null) + ' active=' + (entry.press ? entry.press.matched : null) + ' busyMs=' + entry.busyMs + ' writes=' + entry.writes + (entry.error ? ' ERROR=' + entry.error : '') + (entry.skipped ? ' SKIPPED' : ''))
    }
  }

  if (!ONLY.length || ONLY.indexOf('templates') >= 0 || ONLY.indexOf('projects') >= 0) {
    cardPatterns.push(await cardPattern('templates', 24))
    cardPatterns.push(await cardPattern('projects', 24))
    screenshots.push(cardPatterns[0].screenshot, cardPatterns[1].screenshot)
  }

  // ① 点卡片正文会不会跳 / ② Tab 能不能到卡片：overview 与 templates 两屏各跑一遍
  if (!ONLY.length || ONLY.indexOf('overview') >= 0 || ONLY.indexOf('templates') >= 0) {
    bodyClicks = await bodyClickSection()
    tabWalks = await tabWalkSection()
  }

  // ---- 版本面：截图必须来自 --dist 指的那份构建 ----
  await goto('/overview', '.vq-next-cta')
  const bits = await evaluate('(() => { const list = Array.prototype.map.call(document.querySelectorAll("script[src]"), (n) => String(n.getAttribute("src")).split("/").pop()).filter((n) => n && n.indexOf("index-") === 0); const label = document.querySelector(".vq-version-label"); return { scripts: list, uiVersion: label ? String(label.textContent || "").trim() : null } })()')
  const apiVersion = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  note('入口与版本', { loaded: bits.scripts, dist: distEntry, api: apiVersion && apiVersion.version, uiVersion: bits.uiVersion })
  check('0.1 页面脚本来自这次指定的构建入口（' + distEntry + '）', Boolean(distEntry) && (bits.scripts || []).indexOf(distEntry) >= 0, { loaded: bits.scripts })
  check('0.2 /api/version 与这份 dist 的版本一致（v' + distPkgVersion + '）', Boolean(apiVersion) && apiVersion.version === distPkgVersion, { api: apiVersion && apiVersion.version, distVersion: distPkgVersion, sourcePackage: pkgVersion })

  check('6.1 页面异常 0 条、console.error 0 条', cdp.exceptions.length === 0 && cdp.consoleErrors.length === 0, { exceptions: cdp.exceptions.slice(0, 3), consoleErrors: cdp.consoleErrors.slice(0, 3) })
  const upstream = cdp.requests.filter((row) => row.url.indexOf(BASE) !== 0 && /10100|seeapi|geteapi|redfox|api\.openai|generations|replicate/i.test(row.url))
  check('6.2 这一轮没有打任何上游（0 次）', upstream.length === 0, { upstream: upstream.slice(0, 3) })
  check('6.3 每个动作都有结论（量到数字、明确跳过、或写明错误）', results.every((row) => row.skipped || !row.error), { errors: results.filter((row) => row.error).map((row) => row.screen + '/' + row.id + ': ' + row.error) })
} catch (error) {
  stopped = true
  check('9.9 取证脚本自己没崩', false, { error: String((error && error.stack) || error).slice(0, 600) })
  if (serverLog) note('服务端日志尾部', serverLog.slice(-800))
}

const failed = checks.filter((item) => !item.ok)
const out = {
  round: 'r329',
  at: new Date().toISOString(),
  dist: DIST_DIR,
  entry: distEntry,
  version: pkgVersion,
  port: API_PORT,
  dataDir: dataDir,
  outDir: OUT_DIR,
  seeded: seeded,
  overlays: overlayLog,
  actions: results,
  screens: screenScans,
  cards: cardPatterns,
  bodyClicks: bodyClicks,
  tabWalks: tabWalks,
  checks: checks,
  failed: failed.length,
  passed: checks.length - failed.length,
  notes: notes,
  screenshots: screenshots,
  exceptions: cdp ? cdp.exceptions : [],
  consoleErrors: cdp ? cdp.consoleErrors : [],
  skipped: results.filter((row) => row.skipped).map((row) => ({ screen: row.screen, id: row.id, reason: row.skipped })),
}
fs.writeFileSync(path.join(OUT_DIR, 'r329.json'), JSON.stringify(out, null, 2))

// ---- 紧凑表格 ----
function pad(text, width) {
  const value = String(text === null || text === undefined ? '-' : text)
  let visible = 0
  for (const char of value) visible += char.charCodeAt(0) > 255 ? 2 : 1
  return value + ' '.repeat(Math.max(0, width - visible))
}
console.log('')
console.log(pad('屏 / 动作', 32) + pad('cursor', 10) + pad('hover', 24) + pad('press', 24) + pad(':active', 8) + pad('busyMs', 8) + pad('writes', 7) + '进行中信号')
console.log('-'.repeat(150))
for (const row of results) {
  const tag = row.screen + '/' + row.id
  if (row.skipped) { console.log(pad(tag, 32) + pad('-', 10) + pad('跳过', 24) + row.skipped); continue }
  if (row.error) { console.log(pad(tag, 32) + pad('ERROR', 10) + row.error); continue }
  console.log(
    pad(tag, 32) + pad(row.cursor, 10) +
    pad(row.hover && row.hover.changed.length ? row.hover.changed.join(',').slice(0, 22) : '无变化', 24) +
    pad(row.press && row.press.changed.length ? row.press.changed.join(',').slice(0, 22) : '无变化', 24) +
    pad(row.press ? String(row.press.matched) : '-', 8) +
    pad(row.busyMs === null ? 'null' : row.busyMs, 8) +
    pad(row.writes, 7) + String(row.busySignal || '(没有进行中信号)'),
  )
}
console.log('')
console.log('---- 卡片两种做法（A/B）----')
for (const card of cardPatterns) {
  console.log(pad(card.screen, 10) + pad(card.tag, 10) + pad('命中 ' + (card.hit ? card.hit.tag + '.' + (card.hit.cls || '') + ' cursor=' + card.cursor : '-'), 52) + pad('卡片 cursor=' + card.cursorOwn, 18) + pad('tabIndex=' + card.tabIndex, 13) + pad(card.tabReachable ? 'Tab 可达（第 ' + card.reachedAt + ' 下）' : 'Tab 不可达', 24) + (card.click && card.click.opened ? '点开有反应' : '点开无反应'))
}
console.log('')
console.log('---- 点卡片正文（不点按钮）----')
for (const row of bodyClicks) {
  const hit = row.hit ? row.hit.tag + (row.hit.cls ? '.' + row.hit.cls : '') + ' cursor=' + row.hit.cursor + (row.hit.stretchedOpen ? ' 热区' : '') : '(没读到)'
  console.log(pad(row.id, 16) + pad(hit.slice(0, 46), 48) + pad((row.hashBefore || '') + ' → ' + (row.hashAfter || ''), 34) + pad(row.drawerOpened ? '抽屉开' : '无抽屉', 10) + (row.verdict || row.error))
}
console.log('')
console.log('---- Tab 能不能到卡片 ----')
for (const row of tabWalks) {
  console.log(pad(row.id, 20) + pad(row.reachedAt ? '第 ' + row.reachedAt + ' 下' : '没落到', 10) + pad(row.firstInsideLabel || '-', 30) + pad(row.firstInsideHasCardOpen ? '有 .vq-card-open' : '无 .vq-card-open', 18) + (row.enter && row.enter.skipped ? row.enter.skipped : row.enter ? ('回车@' + row.enter.on + ' → ' + (row.enter.drawerOpened ? '抽屉开' : row.enter.hashChanged ? '跳到 ' + row.enter.hashAfter : '没反应')) : '-'))
}
console.log('')
console.log('---- 「看着能点却不可达」----')
for (const scan of screenScans) {
  console.log(pad(scan.screenLabel, 12) + 'cursor≠pointer 的可用元素 ' + scan.interactive.nonPointerEnabled + ' 个（禁用 ' + scan.interactive.disabledNonPointer + ' 个）· 假可点元素 ' + scan.fakeClickable.length + ' 个' + (scan.fakeClickable.length ? ' :: ' + scan.fakeClickable.map((f) => f.tag + '.' + (f.cls || '') + '(own=' + f.cursorOwn + ',命中=' + (f.hitTag || '') + '.' + (f.hitCls || '') + '=' + f.cursor + (f.stretchedOpen ? '热区' : '') + ',tab=' + (f.tabReachable ? '可' : '不可') + ')').join(' ') : ''))
}
console.log('')
console.log('---- r329 取证 · ' + out.passed + '/' + checks.length + ' 通过 · 证据 ' + path.join(path.relative(ROOT, OUT_DIR), 'r329.json') + ' ----')

try { chrome.kill() } catch { /* 已经退出 */ }
try { server.kill() } catch { /* 已经退出 */ }
await sleep(400)
try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 同上 */ }
if (stopped || failed.length) process.exit(1)
process.exit(0)
