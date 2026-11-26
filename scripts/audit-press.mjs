// r331 巡检：「按下去有没有反应」——把页面上能点的东西逐个真按一遍，只记客观事实。
//
// 为什么做成巡检：r330 用真鼠标在 3 个元素上量出「按下去一点变化都没有」。这一轮把同一套探针
// 做成可复跑的一份脚本：同一批屏、同一批目标、同一套口径，before / after 各跑一次，比数字。
//
// 三条纪律（与 r329 / r330 同一套）：
//   1) 0 次上游调用：临时库不给模型 Key，VISION_BASE_URL 指到本机一个没人监听的端口。
//   2) 只走真输入：mouseMoved / mousePressed / mouseReleased 全是 CDP Input.dispatchMouseEvent。
//      按下之后**不在原地松开**——先挪到视口里的中性点再松，所以这一轮不会合成 click，
//      不给后台写请求、不跳页。后台写请求总数写在报告里。
//   3) 量不到就写「量不到」，绝不把「没量到」写成「无反馈」。
//   4) r332 起：判定仍按「按下两帧」那一拍（与 r331 的数字可比），但还按着再等 200ms 读一次终值
//      （pressedSettled / changedSettledVsHover）。过渡没走完的采样会被单列成 settledRescued，
//      不混进「真的没反应」——promo 卡上那几颗就是这么回事（r331 也记过一次）。
//   5) r333 起：除了元素自身的六个属性，还读它的 ::after（背景/阴影/位移/透明度，见 AFTER_PROPS）。
//      r326/r329 给「整卡可点」的按钮定的按下反馈就画在 ::after 上，量具以前看不见这一类，
//      把它们一律记成「无反馈」——那是量具的盲区，不是页面的问题。
//
// 用法（同一份脚本跑两份产物）：
//   node scripts/audit-press.mjs --dist .shots330/dist-after --out .shots331/press
//   node scripts/audit-press.mjs --dist .shots331/dist-after --out .shots331/press-after
//   node scripts/audit-press.mjs --only overview,admin-promos
//   node scripts/audit-press.mjs --only shell --shots all   # 每一颗按下都截图（before/after 对比图）
//
// 产物：<out>/press.json + <out>/<page>-<n>-press.png（只给「按下无反馈候选」）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = process.cwd()
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

function argOf(name, fallback) {
  const at = process.argv.indexOf('--' + name)
  if (at > 0 && process.argv[at + 1] && process.argv[at + 1].charAt(0) !== '-') return process.argv[at + 1]
  return fallback
}
const ONLY = String(argOf('only', '')).split(',').map((item) => item.trim()).filter(Boolean)
const DIST_DIR = path.resolve(ROOT, String(argOf('dist', '.shots330/dist-after')))
const OUT_DIR = path.resolve(ROOT, String(argOf('out', '.shots331/press')))
// r332：--shots candidates（默认，只给「按下无反馈候选」截图）| all（每一颗按下都截一张，
// 用来做同一颗的 before/after 对比图）+ --shotsize N（方形窗口边长，默认 120）。
const SHOTS = String(argOf('shots', 'candidates'))
const SHOT_SIZE = Number(argOf('shotsize', '120')) || 120
const WIDTH = 1440
const HEIGHT = 1000
if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) throw new Error('dist 里没有 index.html：' + DIST_DIR)
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 SHOT_CHROME 指定）')
fs.mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const notes = []
function note(text, detail) {
  notes.push({ text: text, detail: detail === undefined ? null : detail })
  console.log('NOTE ' + text + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}
const anomalies = []
function anomaly(where, text, detail) {
  anomalies.push({ where: where, text: text, detail: detail === undefined ? null : detail })
  console.log('ANOMALY ' + where + ' :: ' + text + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

// ---- 真一条 PNG（不引依赖、不联网）：给模板封面与作品流卡片当缩略图 ----
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
const THUMB_SHADE = (x, y) => {
  const band = Math.max(0, 1 - Math.abs(x - y * 0.9 - 0.18) * 6)
  const base = 34 + Math.round(22 * y)
  const lift = Math.round(46 * band)
  return [base + lift, base + Math.round(lift * 0.7), base + Math.round(lift * 1.4)]
}
const thumbBuffer = makePng(640, 640, THUMB_SHADE)
const coverBuffer = makePng(960, 540, THUMB_SHADE)

function pngSize(buf) {
  if (buf.length < 24) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// ---- 端口：避开这台机器上其它常驻服务（与 r329 同一份名单；nav-shell 的实例靠探活避开）----
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
const DEBUG_PORT = await freePort(8900, 8918)
const BASE = 'http://127.0.0.1:' + API_PORT

// ---- 临时实例：真 SQLite、真账号、真 cookie，只有数据目录是新的（绝不碰真实数据）----
const dataDir = path.join(OUT_DIR, 'data')
const stageDir = path.join(OUT_DIR, 'stage')
const profile = path.join(OUT_DIR, 'profile')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir, { recursive: true })
fs.rmSync(profile, { recursive: true, force: true })
fs.mkdirSync(profile, { recursive: true })
process.env.DATA_DIR = dataDir

const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
// 舞台里的 package.json 用这份 dist 自己的版本号：dist 可能是旧构建，拿源码树现在的版本顶上，
// /api/version 与页面显示的版本号就对不上了。
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
const distEntry = (distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1] || null

// ---- 建号 + 铺数据（都是真数据：后台运营位、智能体、模板、作品、作品流一条成品）----
const AT = String.fromCharCode(64)
const PASSWORD = 'r331-probe-pass1'
const { createSession, createUser } = await import('../server/auth.mjs')
const { savePromos } = await import('../server/promos.mjs')
const { createAgent } = await import('../server/agents.mjs')
const { createProject } = await import('../server/projects.mjs')
const { markComplete } = await import('../server/onboarding.mjs')
const { config: cfg } = await import('../server/config.mjs')

const admin = createUser({ email: 'r331-admin' + AT + 'shot.test', password: PASSWORD, name: '运维', kind: 'admin' })
const account = createUser({ email: 'r331press' + AT + 'shot.test', password: PASSWORD, name: '巡检员', kind: 'account' })
const token = createSession(account, {}).token
const adminToken = createSession(admin, {}).token
// 两个账号都标成已完成：新手引导（.vq-gate / .vq-guide）是一层全屏遮罩，真鼠标按下去落在遮罩上，
// 量出来的就不是按钮本身。这一步不写进界面逻辑、不改任何界面代码，只是让巡检从「已经看过引导」的状态开始；
// 代价是引导弹窗里的那几颗按钮这一轮不在清单里（它们不是这次要查的对象）。
markComplete(admin.id, { skipAssets: true })
markComplete(account.id, { skipAssets: true })

const seeded = { promos: '', agent: '', project: '', template: '', media: '', account: account.id, admin: admin.id }

const promoSeed = await savePromos([
  {
    id: 'r331-rooms',
    placement: 'overview',
    weight: 30,
    kicker: 'Beta · 聊天室',
    title: '把几个智能体放进同一个房间',
    body: '房间里你说一句，平台智能体接一句：起草、拆结构、找选题。每轮 1 积分，答不上来全额退回。',
    cta: '去聊天室',
    page: 'rooms',
  },
  {
    id: 'r331-review',
    placement: 'overview',
    weight: 20,
    kicker: '视觉评审',
    title: '按帧给结论，每条带证据',
    body: '抽帧逐条标出问题与像素锚点，评审结论可以回写到作品，作为封版依据。',
    cta: '去视觉评审',
    page: 'review',
  },
], { by: 'r331-seed' })
seeded.promos = promoSeed.ok ? promoSeed.items.length + ' 条' : '失败：' + promoSeed.error

const agent = await createAgent({
  name: 'r331 口播拆解',
  category: '脚本分镜',
  role: '把一条口播拆成脚本与分镜',
  systemPrompt: '你负责把口播拆成分镜表：先给结果，再给步骤。看不清的地方标出来，不要编。',
}, account)
seeded.agent = agent.name

const templateEntry = {
  id: 'tpl_r331_probe',
  kind: 'replica',
  title: '一分钟出片的那条',
  contentType: '口播',
  tags: ['巡检'],
  platform: 'douyin',
  platformLabel: '抖音',
  sourceUrl: 'https://www.douyin.com/video/3310331',
  sourceId: 'dy_3310331',
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

const taskId = 'mgen_r331seed01'
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

console.log('r331 巡检 · dist=' + DIST_DIR + ' · 入口 ' + distEntry + ' · v' + distPkgVersion + ' · 端口 ' + API_PORT + ' · 数据目录 ' + dataDir)

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
    VISION_BASE_URL: BASE + '/dead-upstream/v1',
    VISION_API_KEY: 'r331-not-a-real-key',
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
  '--window-size=' + WIDTH + ',' + HEIGHT,
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
    throw new Error('Runtime.evaluate 失败：' + String((error && error.message) || error) + ' :: ' + String(expression).slice(0, 160))
  }
  if (result && result.exceptionDetails) throw new Error('页面里求值失败：' + JSON.stringify(result.exceptionDetails).slice(0, 240) + ' :: ' + String(expression).slice(0, 160))
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

async function mouseTo(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none' })
}
async function mouseDown(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1 })
}
async function mouseUp(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', buttons: 0, clickCount: 1 })
}
async function clickAt(x, y, gap = 60) {
  await mouseTo(x, y)
  await sleep(40)
  await mouseDown(x, y)
  await sleep(gap)
  await mouseUp(x, y)
  await sleep(gap)
}

// ---- 页面里跑的自足函数（普通函数 + toString 注入；不引外部依赖）----

function bringIntoView(selector) {
  // 视口只有 1000 高，长页面上大部分按钮在屏外；鼠标事件落在屏外坐标上等于没点。
  // 这里只做「滚到眼前」——滚的是真滚动容器，不伪造点击。
  const el = document.querySelector(selector)
  if (!el) return { missing: true }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  return {
    cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
    l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
    scroller: (function () { let n = el.parentElement; while (n) { const s = getComputedStyle(n); if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return (String(n.className || n.tagName).split(' ')[0]) || 'div'; n = n.parentElement } return 'window' })(),
  }
}

function readState(selector) {
  // 只读：computed style + :active / :hover + 落点。不点、不写。
  const el = document.querySelector(selector)
  if (!el) return { missing: true }
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + r.height / 2)
  const hit = document.elementFromPoint(x, y)
  return {
    missing: false,
    tag: el.tagName,
    text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
    active: el.matches(':active'),
    hover: el.matches(':hover'),
    focus: el === document.activeElement,
    disabled: Boolean(el.disabled),
    ariaDisabled: el.getAttribute('aria-disabled'),
    backgroundColor: cs.backgroundColor,
    borderColor: cs.borderColor,
    color: cs.color,
    boxShadow: cs.boxShadow,
    transform: cs.transform,
    opacity: cs.opacity,
    outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
    cursor: cs.cursor,
    rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    hitIsSelf: Boolean(hit && (hit === el || el.contains(hit))),
    hit: hit ? { tag: hit.tagName, cls: String(hit.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.'), cursor: getComputedStyle(hit).cursor } : null,
    // 伪元素也要读（r333）：r326/r329 起，「整卡可点」的按钮把按下反馈画在自己的 ::after 上
    // （给它加 transform 会毁掉 ::after 的包含块）——只看元素自身，这一类永远量成「无反馈」。
    after: (function () {
      const ps = getComputedStyle(el, '::after')
      return {
        content: ps.content,
        backgroundColor: ps.backgroundColor,
        boxShadow: ps.boxShadow,
        transform: ps.transform,
        opacity: ps.opacity,
      }
    })(),
  }
}

function neutralPoint() {
  // 「松手的地方」：视口角落、非交互区域。按下之后不在原元素上松开，
  // 这样浏览器不会合成 click（click 只在按下与抬起的共同祖先上触发）。
  const w = window.innerWidth
  const h = window.innerHeight
  const candidates = [
    [4, 4], [w - 6, 4], [4, h - 6], [w - 6, h - 6],
    [Math.round(w / 2), h - 6], [Math.round(w / 2), 4], [4, Math.round(h / 2)],
  ]
  for (const point of candidates) {
    const el = document.elementFromPoint(point[0], point[1])
    if (!el) continue
    if (el.closest && el.closest('button, [role="button"], .vq-card-open, a[href], input, select, textarea, nav, aside, .vq-sidebar, header')) continue
    if (getComputedStyle(el).cursor === 'pointer') continue
    return { x: point[0], y: point[1], tag: el.tagName, cls: String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') }
  }
  return null
}

function collectTargets(scopeSel, limit) {
  // 页面上**所有可见的** button / [role=button] / .vq-card-open，按 DOM 顺序，截到 limit。
  function escapeIdent(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value)
    return String(value).replace(/[^A-Za-z0-9_-]/g, function (ch) { return '\\' + ch })
  }
  function stableClasses(node) {
    return Array.prototype.slice.call(node.classList).filter(function (c) { return c.indexOf('is-') !== 0 && c.length < 40 }).slice(0, 2)
  }
  function selectorFor(el) {
    const cls = stableClasses(el)
    const simple = el.tagName.toLowerCase() + (cls.length ? '.' + cls.map(escapeIdent).join('.') : '')
    try { if (document.querySelectorAll(simple).length === 1) return simple } catch { /* 选择器不合法就往下走 */ }
    const all = Array.prototype.slice.call(el.classList)
    if (all.length) {
      const full = el.tagName.toLowerCase() + '.' + all.map(escapeIdent).join('.')
      try { if (document.querySelectorAll(full).length === 1) return full } catch { /* 同上 */ }
    }
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      let part = node.tagName.toLowerCase()
      const c = stableClasses(node)
      if (c.length) part += '.' + c.map(escapeIdent).join('.')
      const parent = node.parentElement
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === node.tagName })
        part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      const sel = parts.join(' > ')
      try { if (document.querySelectorAll(sel).length === 1) return sel } catch { /* 同上 */ }
      node = parent
    }
    return parts.join(' > ')
  }
  function headHtml(el) {
    const clone = el.cloneNode(false)
    clone.innerHTML = ''
    return String(clone.outerHTML || '').replace(/\s+/g, ' ').slice(0, 120)
  }
  const roots = scopeSel ? Array.prototype.slice.call(document.querySelectorAll(scopeSel)) : [document]
  if (!roots.length) return { missingScope: true, total: 0, items: [] }
  const nodes = []
  const seen = new Set()
  for (const root of roots) {
    const found = root.querySelectorAll('button, [role="button"], .vq-card-open')
    for (const el of found) {
      if (seen.has(el)) continue
      seen.add(el)
      nodes.push(el)
    }
  }
  const visible = []
  for (const el of nodes) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (r.width < 2 || r.height < 2) continue
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
    visible.push(el)
  }
  const items = visible.slice(0, limit).map(function (el, index) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const selector = selectorFor(el)
    let resolved = -1
    try { resolved = document.querySelectorAll(selector).length } catch { resolved = -1 }
    return {
      n: index + 1,
      selector: selector,
      selectorMatches: resolved,
      tag: el.tagName,
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      html: headHtml(el),
      cls: String(el.getAttribute('class') || ''),
      disabled: Boolean(el.disabled),
      ariaDisabled: el.getAttribute('aria-disabled'),
      cursor: cs.cursor,
      type: el.getAttribute('type'),
      rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    }
  })
  return { missingScope: false, total: visible.length, items: items }
}

function installPromoAnimProbe() {
  // 听 .vq-promo-undo 上的 animationstart/animationend（1.2 秒窗口），并在同一个窗口里
  // 每 50ms 采一次它的 computed transform —— 「进场动画有没有留下 transform」要看得见过程，不只看结果。
  const state = { at: performance.now(), clickAt: null, events: [], all: [], samples: [], running: true }
  window.__r331anim = state
  document.addEventListener('pointerdown', function (event) {
    const target = event.target
    if (target && target.closest && target.closest('.vq-promo-close')) state.clickAt = performance.now()
  }, true)
  document.addEventListener('animationstart', function (event) {
    const el = event.target
    const isUndo = Boolean(el && el.classList && el.classList.contains('vq-promo-undo'))
    const row = { name: event.animationName, elapsed: Math.round(performance.now() - state.at), target: el ? el.tagName + '.' + String(el.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.') : '?' }
    state.all.push(row)
    if (isUndo) state.events.push(Object.assign({ phase: 'start' }, row))
  }, true)
  document.addEventListener('animationend', function (event) {
    const el = event.target
    if (el && el.classList && el.classList.contains('vq-promo-undo')) {
      state.events.push({ phase: 'end', name: event.animationName, elapsed: Math.round(performance.now() - state.at) })
    }
  }, true)
  const timer = setInterval(function () {
    const el = document.querySelector('.vq-promo-undo')
    state.samples.push({
      t: Math.round(performance.now() - state.at),
      present: Boolean(el),
      transform: el ? getComputedStyle(el).transform : null,
      animationName: el ? getComputedStyle(el).animationName : null,
      height: el ? Math.round(el.getBoundingClientRect().height) : null,
    })
    if (performance.now() - state.at > 1900) { clearInterval(timer); state.running = false }
  }, 50)
  return true
}

function readPromoAnimProbe() {
  const state = window.__r331anim
  if (!state) return { missing: true }
  const el = document.querySelector('.vq-promo-undo')
  const cs = el ? getComputedStyle(el) : null
  const anims = el && el.getAnimations ? el.getAnimations().map(function (a) {
    let name = '(无名)'
    try { name = a.animationName || (a.effect && a.effect.getKeyframes && 'keyframes') || '(无名)' } catch { name = '(读不到名字)' }
    return { name: name, playState: a.playState, currentTime: a.currentTime === null ? null : Math.round(Number(a.currentTime)) }
  }) : null
  return {
    missing: false,
    running: state.running,
    sinceInstallMs: Math.round(performance.now() - state.at),
    clickAtMs: state.clickAt === null ? null : Math.round(state.clickAt - state.at),
    undoEvents: state.events,
    allAnimationStarts: state.all,
    samples: state.samples,
    present: Boolean(el),
    undoText: el ? String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : null,
    undoRect: el ? (function () { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } })() : null,
    computed: cs ? {
      transform: cs.transform,
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      animationDelay: cs.animationDelay,
      animationFillMode: cs.animationFillMode,
      opacity: cs.opacity,
      position: cs.position,
    } : null,
    runningAnimations: anims,
    undoButtonPresent: Boolean(document.querySelector('.vq-promo-undo-button')),
  }
}

function promoLocalKeys() {
  const out = {}
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (/promo/i.test(String(key))) out[key] = String(localStorage.getItem(key) || '').slice(0, 200)
    }
  } catch (error) { return { error: String(error && error.message) } }
  return out
}

function measurePromoClose() {
  const el = document.querySelector('.vq-promo-close')
  if (!el) return { missing: true, promoCount: document.querySelectorAll('.vq-promo').length }
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return {
    missing: false,
    clientWidth: document.documentElement.clientWidth,
    winner: window.innerWidth,
    inlineSize: { width: cs.width, height: cs.height },
    rect: { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, l: Math.round(r.left), t: Math.round(r.top) },
    offset: { w: el.offsetWidth, h: el.offsetHeight },
    padding: cs.padding,
    borderWidth: cs.borderWidth,
    boxSizing: cs.boxSizing,
    flex: cs.flex,
    promoCount: document.querySelectorAll('.vq-promo').length,
  }
}

function adminPromoNumbers() {
  function cardOf() {
    const byToolbar = document.querySelector('.admin-card:has(.admin-promo-toolbar)')
    if (byToolbar) return byToolbar
    const list = document.querySelector('.admin-promo-list')
    return list && list.closest ? list.closest('.admin-card') : null
  }
  function findField(scope, labelText) {
    const labels = Array.prototype.slice.call(scope.querySelectorAll('label'))
    for (const label of labels) {
      const span = label.querySelector('span')
      if (span && String(span.textContent || '').trim() === labelText) return label
    }
    return null
  }
  const card = cardOf()
  const rows = card ? Array.prototype.slice.call(card.querySelectorAll('.admin-promo-row')) : []
  const weightRows = rows.map(function (row, index) {
    const field = findField(row, '权重')
    const input = field ? field.querySelector('input') : null
    const rowTitle = row.querySelector('.admin-promo-row-title')
    const foot = row.querySelector('.admin-promo-row-foot')
    return {
      row: index + 1,
      rowTitle: rowTitle ? String(rowTitle.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : null,
      control: input ? input.tagName.toLowerCase() + '[type=' + (input.getAttribute('type') || '(无)') + ']' : (field ? '不是 input：' + String(field.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '找不到「权重」这一栏'),
      shownNumber: input ? String(input.value) : null,
      step: input ? input.getAttribute('step') : null,
      readOnly: input ? Boolean(input.readOnly) : null,
      hintAtRowFoot: foot ? String(foot.textContent || '').replace(/\s+/g, ' ').trim() : null,
    }
  })
  const hintNodes = card ? Array.prototype.slice.call(card.querySelectorAll('.admin-cell-sub, .admin-hint')).map(function (n) { return String(n.textContent || '').replace(/\s+/g, ' ').trim() }) : []
  const weightHint = hintNodes.filter(function (t) { return t.indexOf('按行序重排权重') >= 0 })
  return {
    cardFound: Boolean(card),
    cardSelector: card ? (card.className || '') : null,
    pageNumberInputs: document.querySelectorAll('input[type="number"]').length,
    cardNumberInputs: card ? card.querySelectorAll('input[type="number"]').length : 0,
    promoRowCount: rows.length,
    weightRows: weightRows,
    weightHintPresent: weightHint.length > 0,
    weightHintText: weightHint[0] || null,
    cardButtons: card ? Array.prototype.slice.call(card.querySelectorAll('button')).length : 0,
  }
}

// ---- 页面动作 ----
let navNonce = 0
function routeUrl(route) {
  navNonce += 1
  if (route.indexOf('admin:') === 0) return BASE + '/?edition=admin&n=' + navNonce + '#' + route.slice(6)
  return BASE + '/?n=' + navNonce + '#' + route
}
async function switchAccountCookie(which) {
  const value = which === 'admin' ? adminToken : token
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: value, domain: '127.0.0.1', path: '/', httpOnly: true })
}

const overlayLog = []
let gateDone = false
async function dismissOverlays() {
  for (let i = 0; i < 3; i += 1) {
    if (!(await evaluate('Boolean(document.querySelector(".vq-guide"))'))) break
    const rect = await evaluate('(' + bringIntoView.toString() + ')(".vq-guide [aria-label=\\"关闭引导\\"]")')
    if (!rect || rect.missing) break
    await clickAt(rect.cx, rect.cy, 90)
    overlayLog.push({ what: '上手引导', how: '真点「关闭引导」', gone: !(await evaluate('Boolean(document.querySelector(".vq-guide"))')) })
    await sleep(200)
  }
  if (!gateDone && (await evaluate('Boolean(document.querySelector(".vq-gate"))'))) {
    const steps = []
    const choice = await evaluate('(' + bringIntoView.toString() + ')(".vq-gate-choice")')
    if (choice && !choice.missing) { await clickAt(choice.cx, choice.cy, 80); steps.push('点第 1 个身份') }
    const next1 = await evaluate('(' + bringIntoView.toString() + ')(".vq-gate-foot button")')
    if (next1 && !next1.missing) { await clickAt(next1.cx, next1.cy, 80); steps.push('第 1 步「继续」') }
    await sleep(700)
    const kind = await evaluate('(' + bringIntoView.toString() + ')(".vq-gate-kind")')
    if (kind && !kind.missing) { await clickAt(kind.cx, kind.cy, 80); steps.push('点第 1 个类目') }
    const next2 = await evaluate('(' + bringIntoView.toString() + ')(".vq-gate-foot button")')
    if (next2 && !next2.missing) { await clickAt(next2.cx, next2.cy, 80); steps.push('第 2 步「继续」') }
    await sleep(700)
    const foot = await evaluate('(' + bringIntoView.toString() + ')(".vq-gate-foot button:last-child")')
    if (foot && !foot.missing) { await clickAt(foot.cx, foot.cy, 90); steps.push('第 3 步最后一颗') }
    await sleep(800)
    const gone = !(await evaluate('Boolean(document.querySelector(".vq-gate"))'))
    overlayLog.push({ what: '身份引导', how: steps.join(' → '), gone: gone })
    gateDone = gone
  }
  const know = await evaluate('(' + bringIntoView.toString() + ')("[aria-label=\\"知道了\\"]")')
  if (know && !know.missing) await clickAt(know.cx, know.cy, 70)
  const toastClose = await evaluate('(' + bringIntoView.toString() + ')(".vq-toast [aria-label=\\"关闭\\"]")')
  if (toastClose && !toastClose.missing) await clickAt(toastClose.cx, toastClose.cy, 70)
  return overlayLog
}

let lastAnchor = { anchor: '', found: true, text: '' }
async function goto(route, anchor, who = 'user') {
  await switchAccountCookie(route.indexOf('admin:') === 0 ? 'admin' : who)
  await cdp.send('Page.navigate', { url: routeUrl(route) })
  await sleep(650)
  let shell = false
  for (let attempt = 0; attempt < 3 && !shell; attempt += 1) {
    shell = Boolean(await waitForExpr('Boolean(document.querySelector(".vq-content"))', '工作台外壳', 18, 250).catch(() => false))
    if (!shell) {
      console.log('SHELL-RETRY ' + route + ' attempt=' + (attempt + 1))
      await cdp.send('Page.reload', {})
      await sleep(1100)
    }
  }
  if (!shell) console.log('SHELL-DEAD ' + route + ' text=' + String(await evaluate('String(document.body.innerText || "").slice(0, 200)').catch(() => '')))
  let found = true
  try {
    await waitForExpr('Boolean(document.querySelector(' + JSON.stringify(anchor) + '))', '页面骨架 ' + anchor, 22, 150)
  } catch {
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

const shots = []
async function shotClip(name, selector, size = 120, pad = null) {
  const box = await evaluate('(function () { var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height } })()')
  if (!box) return null
  // size = 以元素中心开的方形窗口；pad = 贴着元素外扩几像素（行式控件用它才看得全整行）
  let x, y, width, height
  if (pad === null) {
    const half = size / 2
    x = Math.max(0, box.x + box.w / 2 - half)
    y = Math.max(0, box.y + box.h / 2 - half)
    width = size
    height = size
  } else {
    x = Math.max(0, box.x - pad)
    y = Math.max(0, box.y - pad)
    width = box.w + pad * 2
    height = box.h + pad * 2
  }
  let captured
  try {
    captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: x, y: y, width: width, height: height, scale: 1 } })
  } catch (error) {
    return { file: null, error: String((error && error.message) || error) }
  }
  const buffer = Buffer.from(captured.data, 'base64')
  const file = path.join(OUT_DIR, name)
  fs.writeFileSync(file, buffer)
  const dim = pngSize(buffer)
  const row = { file: name, bytes: buffer.length, pixel: dim, clip: pad === null ? { x: Math.round(x), y: Math.round(y), size: size } : { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), pad: pad } }
  shots.push(row)
  console.log('SHOT ' + name + ' · ' + row.bytes + ' B · ' + (dim ? dim.width + 'x' + dim.height : '尺寸读不到'))
  return row
}

// ---- 按下探针 ----
const PROPS = [
  ['backgroundColor', 'background-color'],
  ['borderColor', 'border-color'],
  ['color', 'color'],
  ['boxShadow', 'box-shadow'],
  ['transform', 'transform'],
  ['opacity', 'opacity'],
]
// r333：::after 上的反馈单独一组。两边都读不到伪元素（content: none）时跳过——
// 不给页面上绝大多数没有 ::after 的按钮各添一条空 diff。
const AFTER_PROPS = [
  ['backgroundColor', '::after background-color'],
  ['boxShadow', '::after box-shadow'],
  ['transform', '::after transform'],
  ['opacity', '::after opacity'],
]
function diffProps(before, after) {
  const changed = []
  if (!before || !after || before.missing || after.missing) return changed
  for (const pair of PROPS) {
    if (String(before[pair[0]]) !== String(after[pair[0]])) {
      changed.push({ prop: pair[1], from: String(before[pair[0]]), to: String(after[pair[0]]) })
    }
  }
  const bothAfter = before.after && after.after
  const hasAfter = Boolean(bothAfter) && (String(before.after.content) !== 'none' || String(after.after.content) !== 'none')
  if (hasAfter) {
    for (const pair of AFTER_PROPS) {
      if (String(before.after[pair[0]]) !== String(after.after[pair[0]])) {
        changed.push({ prop: pair[1], from: String(before.after[pair[0]]), to: String(after.after[pair[0]]) })
      }
    }
  }
  return changed
}
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
function pathOf(url) {
  try { return new URL(url).pathname } catch { return String(url) }
}
function writeStatsFrom(mark) {
  const rows = cdp.requests.slice(mark).map((row) => ({ method: row.method, path: pathOf(row.url) }))
  const writes = rows.filter((row) => WRITE_METHODS.has(row.method) && row.path.indexOf('/api/') === 0)
  const counts = {}
  for (const row of writes) counts[row.method + ' ' + row.path] = (counts[row.method + ' ' + row.path] || 0) + 1
  return { writes: writes.length, counts: counts, apiCalls: rows.filter((row) => row.path.indexOf('/api/') === 0).length }
}

async function pressOne(pageId, pageLabel, item) {
  const out = {
    page: pageId, pageLabel: pageLabel, n: item.n,
    selector: item.selector, selectorMatches: item.selectorMatches,
    tag: item.tag, text: item.text, html: item.html, cls: item.cls,
    disabled: item.disabled, ariaDisabled: item.ariaDisabled, cursor: item.cursor, type: item.type,
    rect: item.rect,
    verdict: null, pressActive: null, changed: [], error: null,
  }
  try {
    const view = await evaluate('(' + bringIntoView.toString() + ')(' + JSON.stringify(item.selector) + ')')
    if (!view || view.missing) { out.error = '按下前元素已经不在页面上'; out.verdict = 'read-failed'; return out }
    out.rect = { l: view.l, t: view.t, w: view.w, h: view.h }
    out.scroller = view.scroller
    if (!view.inViewport) {
      out.error = '滚到眼前之后仍不在视口里（t=' + view.t + ', h=' + view.h + '），这一颗量不了'
      out.verdict = 'read-failed'
      return out
    }
    const neutral = await evaluate('(' + neutralPoint.toString() + ')()')
    if (!neutral) out.neutral = '找不到中性点（仍有落在交互元素上的风险）'
    out.hashBefore = await evaluate('location.hash')

    // ① 鼠标不在元素上：rest
    if (neutral) await mouseTo(neutral.x, neutral.y)
    await sleep(70)
    const rest = await evaluate('(' + readState.toString() + ')(' + JSON.stringify(item.selector) + ')')
    if (!rest || rest.missing) { out.error = 'rest 读不到元素'; out.verdict = 'read-failed'; return out }
    out.rest = { active: rest.active, backgroundColor: rest.backgroundColor, borderColor: rest.borderColor, color: rest.color, transform: rest.transform, opacity: rest.opacity, hitIsSelf: rest.hitIsSelf, hit: rest.hit }

    // ② 移到中心 = hover 基线（lead 口径：idle/hover 基线就是这一拍）
    await mouseTo(view.cx, view.cy)
    await sleep(160)
    const hover = await evaluate('(' + readState.toString() + ')(' + JSON.stringify(item.selector) + ')')
    if (!hover || hover.missing) { out.error = 'hover 读不到元素'; out.verdict = 'read-failed'; return out }
    out.hover = {
      active: hover.active, disabled: hover.disabled,
      backgroundColor: hover.backgroundColor, borderColor: hover.borderColor, color: hover.color,
      boxShadow: hover.boxShadow, transform: hover.transform, opacity: hover.opacity,
      cursor: hover.cursor, hitIsSelf: hover.hitIsSelf, hit: hover.hit,
      after: hover.after,
    }
    out.hoverChangedVsRest = diffProps(rest, hover)
    if (!hover.hitIsSelf) note('落点被盖住：' + item.selector, { hit: hover.hit, where: pageId + '#' + item.n })

    // ③ 真按下：mousePressed 之后两帧 rAF 读同一批属性 + matches(:active)
    await mouseDown(view.cx, view.cy)
    const pressed = await evaluate('new Promise(function (done) { requestAnimationFrame(function () { requestAnimationFrame(function () { done((' + readState.toString() + ')(' + JSON.stringify(item.selector) + ')) }) }) })')
    if (!pressed || pressed.missing) { out.error = '按下那一拍读不到元素'; out.verdict = 'read-failed'; return out }
    out.pressed = {
      active: pressed.active, disabled: pressed.disabled,
      backgroundColor: pressed.backgroundColor, borderColor: pressed.borderColor, color: pressed.color,
      boxShadow: pressed.boxShadow, transform: pressed.transform, opacity: pressed.opacity,
      cursor: pressed.cursor, hitIsSelf: pressed.hitIsSelf, hit: pressed.hit,
      after: pressed.after,
    }
    out.pressActive = Boolean(pressed.active)
    out.changed = diffProps(hover, pressed)
    if (out.disabled) out.verdict = 'disabled'
    else if (out.changed.length) out.verdict = 'has-feedback'
    else if (out.pressActive) out.verdict = 'pressed-no-feedback'
    else out.verdict = 'active-not-matched'

    // ④ 按下那一刻的截图（还在按着）——只给「无反馈候选」
    if (SHOTS === 'all') {
      out.screenshot = await shotClip(pageId + '-' + item.n + '-press.png', item.selector, SHOT_SIZE, 8)
    } else if (out.verdict === 'pressed-no-feedback') {
      out.screenshot = await shotClip(pageId + '-' + item.n + '-press.png', item.selector, SHOT_SIZE)
    }

    // ④b 还按着，等过渡走完再看一眼终值。两帧只能看到 120ms ease 的中间值（实测 0.44px），
    //     「规则里声明了 1px、实际被谁盖掉 / 过渡永远走不完」只有稳态这一拍看得出来。
    //     判定仍按 ③ 的两帧口径（和 r331 的数字可比），这一拍作为附加证据进产物。
    await sleep(200)
    const settled = await evaluate('(' + readState.toString() + ')(' + JSON.stringify(item.selector) + ')')
    if (settled && !settled.missing) {
      out.pressedSettled = {
        active: settled.active,
        backgroundColor: settled.backgroundColor,
        borderColor: settled.borderColor,
        color: settled.color,
        boxShadow: settled.boxShadow,
        transform: settled.transform,
        opacity: settled.opacity,
        after: settled.after,
      }
      out.changedSettledVsHover = diffProps(hover, settled).map((pair) => pair.prop)
    }

    // ⑤ 不在原地松开：挪到中性点再松（不合成 click）
    if (neutral) await mouseTo(neutral.x, neutral.y)
    await mouseUp(neutral ? neutral.x : 3, neutral ? neutral.y : 3)
    await sleep(40)
    out.releasedAt = neutral ? { x: neutral.x, y: neutral.y, on: neutral.tag + (neutral.cls ? '.' + neutral.cls : '') } : null
    out.hashAfter = await evaluate('location.hash')
  } catch (error) {
    out.error = String((error && error.message) || error).slice(0, 300)
    out.verdict = 'read-failed'
    try {
      const neutral = await evaluate('(' + neutralPoint.toString() + ')()')
      if (neutral) { await mouseTo(neutral.x, neutral.y); await mouseUp(neutral.x, neutral.y) }
    } catch { /* 鼠标状态收不回来也要往下走 */ }
  }
  console.log('PRESS ' + pageId + '#' + item.n + ' ' + (out.verdict || '?') + ' :: ' + String(item.text).slice(0, 24) + ' :: active=' + out.pressActive + ' changed=' + out.changed.map((c) => c.prop).join(',') + (out.error ? ' ERROR=' + out.error : ''))
  return out
}

// ---- 屏与趟 ----
// 每一趟的 scope 都是「这一屏的内容区」(.vq-content)，不是整页：
//   侧栏 18 个 + 顶栏 5 个按钮会先把 25 个名额吃光，页面上真正要看的东西（模板卡片、能力卡、预设卡）
//   就轮不上了。外壳单独一趟 shell 覆盖，两趟加起来才是整页所有可见 button。
const PASSES = [
  { id: 'shell', label: '外壳 · 侧栏与顶栏', route: '/overview', who: 'user', scope: '.vq-sidebar, .vq-topbar', ready: '.vq-content', note: '整页外壳上的按钮（侧栏导航、搜索、模型、账号、版本号）单独一趟，不占内容页的 25 个名额' },
  { id: 'overview', label: '工作台', route: '/overview', who: 'user', scope: '.vq-content', ready: '.vq-content', note: '内容区所有可见 button / [role=button] / .vq-card-open，按 DOM 顺序取前 25 个（含 PromoSlot 的按钮）' },
  { id: 'overview-cap', label: '工作台 · 四张能力卡', route: '/overview', who: 'user', scope: '.ov-capabilities', ready: '.ov-cap', note: '整屏内容区按钮超过 25 个，四张能力卡在 DOM 里排在运营位之后，单开一趟补齐（lead 点名的目标）' },
  { id: 'admin-promos', label: '后台 · 运营位卡', route: 'admin:/admin/system', who: 'admin', scope: '.admin-card:has(.admin-promo-toolbar)', ready: '.admin-promo-toolbar', note: '只量运营位这一张卡：保存运营位 / 恢复默认 / 新增一条 / 每行的上移、下移、删除' },
  { id: 'templates', label: '模板库', route: '/templates', who: 'user', scope: '.vq-content', ready: '.template-card', note: '模板卡片（.vq-card-open）与页面其它可点元素' },
  { id: 'templates-drawer', label: '模板库 · 详情抽屉底栏', route: '/templates', who: 'user', scope: '.template-drawer', prepare: 'open-drawer', ready: '.template-card' },
  { id: 'settings', label: '设置', route: '/settings', who: 'user', scope: '.vq-content', ready: '.vq-page--settings' },
  { id: 'projects', label: '作品流', route: '/projects', who: 'user', scope: '.vq-content', ready: '.vq-page' },
  { id: 'agents', label: '智能体', route: '/agents', who: 'user', scope: '.vq-content', ready: '.agx-surface-switch' },
  { id: 'agents-presets', label: '智能体 · 对话预设', route: '/agents', who: 'user', scope: '.vq-content', prepare: 'open-presets', ready: '.agx-surface-switch', note: '预设卡在「对话预设」页签里，先真点页签再量' },
]

async function preparePass(pass) {
  if (pass.prepare === 'open-drawer') {
    const card = await evaluate('(' + bringIntoView.toString() + ')(".template-card")')
    if (!card || card.missing) { note('模板库：没有 .template-card，抽屉这一趟量不了'); return false }
    await clickAt(card.cx, card.cy, 120)
    try {
      await waitForExpr('Boolean(document.querySelector(".template-drawer"))', '模板详情抽屉', 30, 150)
      return true
    } catch {
      note('模板库：点了卡片但抽屉没开，抽屉这一趟量不了', { hash: await evaluate('location.hash') })
      return false
    }
  }
  if (pass.prepare === 'open-presets') {
    const tab = await evaluate('(function () { var list = Array.prototype.slice.call(document.querySelectorAll(".agx-surface-switch button")); var el = list.filter(function (n) { return String(n.textContent || "").replace(/\\s+/g, " ").trim() === "对话预设" })[0]; if (!el) return { missing: true, found: list.map(function (n) { return String(n.textContent || "").replace(/\\s+/g, " ").trim() }) }; var r = el.getBoundingClientRect(); return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } })()')
    if (!tab || tab.missing) { note('智能体：找不到「对话预设」页签，预设卡这一趟量不了', tab); return false }
    await clickAt(tab.cx, tab.cy, 120)
    await sleep(300)
    return true
  }
  return true
}

const buttons = []
const passes = []
let totalPressCount = 0

async function runPass(pass) {
  const row = {
    id: pass.id, label: pass.label, route: pass.route, who: pass.who || 'user',
    scope: pass.scope || null, note: pass.note || '',
    anchor: null, scopePresent: null, total: null, measured: 0, truncated: false,
    aborted: null, writeRequests: 0, writeCounts: {}, pressCount: 0,
    candidates: [], feedback: 0, noFeedback: 0, activeNotMatched: 0, disabled: 0, readFailed: 0,
    extra: null,
  }
  const mark = cdp.requests.length
  try {
    await goto(pass.route, pass.ready || '.vq-content', pass.who || 'user')
    await dismissOverlays()
    row.anchor = lastAnchor
    const prepared = await preparePass(pass)
    row.prepared = prepared
    if (!prepared) { row.aborted = '这一趟的入口没能打开（见 notes）'; passes.push(row); return }
    // 刚打开的面板还在进场位移（抽屉从右边滑进来，运营位卡片从下往上浮）：
    // 这时候读到的 rect 是半路上的位置，鼠标按下去可能差几像素落在按钮外面——
    // 那不是「按下没反应」，是没按到。等进场动画跑完再量（0.26s 动画 + 一帧余量）。
    if (pass.prepare) await sleep(600)
    if (pass.scope) {
      const present = await evaluate('Boolean(document.querySelector(' + JSON.stringify(pass.scope) + '))')
      row.scopePresent = present
      if (!present) { row.aborted = 'scope 选择器在这页上找不到：' + pass.scope; passes.push(row); return }
    }
    // 额外量（后台运营位卡的权重控件）
    if (pass.id === 'admin-promos') {
      row.extra = await evaluate('(' + adminPromoNumbers.toString() + ')()')
      console.log('ADMIN-EXTRA ' + JSON.stringify(row.extra))
    }
    const collected = await evaluate('(' + collectTargets.toString() + ')(' + JSON.stringify(pass.scope || null) + ',25)')
    if (!collected || collected.missingScope) { row.aborted = 'scope 在收集时已经不在了：' + pass.scope; passes.push(row); return }
    row.total = collected.total
    row.truncated = collected.total > collected.items.length
    row.listed = collected.items.length
    if (row.truncated) note(pass.id + '：可见可点元素 ' + collected.total + ' 个，按 DOM 顺序只量前 25 个', { skipped: collected.total - collected.items.length })
    for (const item of collected.items) {
      // 趟里的元素可能因为上一颗的副作用消失：不存在就跳过并如实记一行
      const alive = await evaluate('Boolean(document.querySelector(' + JSON.stringify(item.selector) + '))')
      if (!alive) {
        buttons.push({ page: pass.id, pageLabel: pass.label, n: item.n, selector: item.selector, tag: item.tag, text: item.text, html: item.html, rect: item.rect, disabled: item.disabled, cursor: item.cursor, verdict: 'read-failed', error: '按下前元素已经不在页面上（上一颗的副作用）', changed: [] })
        row.readFailed += 1
        continue
      }
      const result = await pressOne(pass.id, pass.label, item)
      buttons.push(result)
      row.measured += 1
      row.pressCount += 1
      totalPressCount += 1
      if (result.verdict === 'has-feedback') row.feedback += 1
      else if (result.verdict === 'pressed-no-feedback') { row.noFeedback += 1; row.candidates.push({ n: item.n, selector: item.selector, text: item.text }) }
      else if (result.verdict === 'active-not-matched') row.activeNotMatched += 1
      else if (result.verdict === 'disabled') row.disabled += 1
      else row.readFailed += 1
      if (result.hashAfter && result.hashBefore !== undefined && result.hashAfter !== result.hashBefore) anomaly(pass.id, '按下之后地址变了（不该发生）', { after: result.hashAfter })
    }
    // 一趟结束时地址对不对：不对就记一条，不静默
    const hash = await evaluate('location.hash')
    row.hashAfterPass = hash
    const expectedHash = pass.route.indexOf('admin:') === 0 ? pass.route.slice(6) : pass.route
    const actualHash = String(hash || '').replace(/^#/, '')
    if (actualHash.indexOf(expectedHash) !== 0) {
      anomaly(pass.id, '一趟结束时地址不是这一屏', { hash: hash, expected: expectedHash })
    }
  } catch (error) {
    row.aborted = String((error && error.message) || error).slice(0, 300)
    console.log('PASS-ERROR ' + pass.id + ' :: ' + row.aborted)
  }
  const stats = writeStatsFrom(mark)
  row.writeRequests = stats.writes
  row.writeCounts = stats.counts
  row.apiCalls = stats.apiCalls
  passes.push(row)
  console.log('PASS ' + pass.id + ' · 可见可点 ' + row.total + ' · 量了 ' + row.measured + ' · 有反馈 ' + row.feedback + ' · 无反馈候选 ' + row.noFeedback + ' · active 没匹配 ' + row.activeNotMatched + ' · 禁用 ' + row.disabled + ' · 读不到 ' + row.readFailed + ' · 写请求 ' + row.writeRequests + (row.aborted ? ' · ABORTED ' + row.aborted : ''))
  return row
}

// ---- 主流程 ----
let stopped = false
const promo = { closeSizes: [], closePress: null, dismissUndo: null, adminWeights: null, localKeys: null }
try {
  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((response) => response.json()).catch(() => null)
    return list && list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('DOM.enable')
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })

  // 开场：先真走一遍引导（新 profile 会挡屏），之后把「看过上手引导」按账号记进 localStorage。
  await goto('/overview', '.vq-content')
  await sleep(700)
  await dismissOverlays()
  if (overlayLog.length) note('开场遮罩：真点关掉了', overlayLog)
  else note('开场遮罩：这一轮没有出现需要关的遮罩')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1');localStorage.setItem('vq.edition','user')}catch(e){}",
  })

  // ---- 运营位补量 ----
  await goto('/overview', '.vq-promos')
  await dismissOverlays()
  await waitForExpr('Boolean(document.querySelector(".vq-promo-close"))', '运营位关闭键', 30, 200).catch(() => note('工作台首页没有出现 .vq-promo-close（运营位没渲染出来）'))

  // 1) 四个宽度下的 .vq-promo-close 尺寸
  for (const width of [1440, 760, 560, 390]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
    await sleep(320)
    const measured = await evaluate('(' + measurePromoClose.toString() + ')()')
    promo.closeSizes.push({ width: width, height: HEIGHT, measured: measured })
    console.log('PROMO-SIZE ' + width + ' × ' + HEIGHT + ' :: ' + JSON.stringify(measured))
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await sleep(320)

  // 2) 真按下 .vq-promo-close（按下后两帧）
  {
    const view = await evaluate('(' + bringIntoView.toString() + ')(".vq-promo-close")')
    if (view && !view.missing) {
      const neutral = await evaluate('(' + neutralPoint.toString() + ')()')
      if (neutral) await mouseTo(neutral.x, neutral.y)
      await sleep(80)
      const idle = await evaluate('(' + readState.toString() + ')(".vq-promo-close")')
      await mouseTo(view.cx, view.cy)
      await sleep(180)
      const hover = await evaluate('(' + readState.toString() + ')(".vq-promo-close")')
      await mouseDown(view.cx, view.cy)
      const pressed = await evaluate('new Promise(function (done) { requestAnimationFrame(function () { requestAnimationFrame(function () { done((' + readState.toString() + ')(".vq-promo-close")) }) }) })')
      const pick = (state) => state && !state.missing ? {
        active: state.active, hover: state.hover,
        backgroundColor: state.backgroundColor, borderColor: state.borderColor,
        color: state.color, transform: state.transform, boxShadow: state.boxShadow, opacity: state.opacity,
      } : { missing: true }
      promo.closePress = {
        rect: view,
        idle: pick(idle),
        hover: pick(hover),
        pressed: pick(pressed),
        pressActive: pressed && !pressed.missing ? Boolean(pressed.active) : null,
        changedVsHover: diffProps(hover, pressed),
        changedVsIdle: diffProps(idle, pressed),
        changedIdleToHover: diffProps(idle, hover),
        verdict: null,
      }
      promo.closePress.verdict = promo.closePress.changedVsHover.length ? 'has-feedback' : (promo.closePress.pressActive ? 'pressed-no-feedback' : 'active-not-matched')
      console.log('PROMO-CLOSE-PRESS :: ' + JSON.stringify({ active: promo.closePress.pressActive, changed: promo.closePress.changedVsHover.map((c) => c.prop), idle: promo.closePress.idle, pressed: promo.closePress.pressed }))
      if (promo.closePress.verdict === 'pressed-no-feedback') {
        promo.closePress.screenshot = await shotClip('promo-close-press.png', '.vq-promo-close')
      }
      if (neutral) await mouseTo(neutral.x, neutral.y)
      await mouseUp(neutral ? neutral.x : 3, neutral ? neutral.y : 3)
      await sleep(60)
    } else {
      promo.closePress = { missing: true, note: '.vq-promo-close 不在页面上，这一条量不到' }
    }
  }

  // 3) 真点 ✕ → 撤销条 .vq-promo-undo 的进场动画 + 400ms 后的 transform
  {
    const mark = cdp.requests.length
    await goto('/overview', '.vq-promos')
    await dismissOverlays()
    const before = await evaluate('({ promos: document.querySelectorAll(".vq-promo").length, undo: Boolean(document.querySelector(".vq-promo-undo")) })')
    await evaluate('(' + installPromoAnimProbe.toString() + ')()')
    const view = await evaluate('(' + bringIntoView.toString() + ')(".vq-promo-close")')
    if (view && !view.missing) {
      const clickPoint = { x: view.cx, y: view.cy }
      await clickAt(clickPoint.x, clickPoint.y, 70)
      await sleep(1200)
      const during = await evaluate('(' + readPromoAnimProbe.toString() + ')()')
      await sleep(400)
      const after = await evaluate('(' + readPromoAnimProbe.toString() + ')()')
      const stats = writeStatsFrom(mark)
      const samples = (during.samples || []).filter((sample) => sample.present)
      const firstTransform = samples.find((sample) => sample.transform && sample.transform !== 'none')
      promo.dismissUndo = {
        before: before,
        during: during,
        after400ms: after,
        writeRequests: stats.writes,
        writeCounts: stats.counts,
        apiCalls: stats.apiCalls,
        animationCount: (during.undoEvents || []).filter((event) => event.phase === 'start').length,
        animationNames: (during.undoEvents || []).filter((event) => event.phase === 'start').map((event) => event.name),
        firstNonNoneTransformSample: firstTransform || null,
        transformAt400ms: after.computed ? after.computed.transform : null,
        samplesWithTransform: samples.filter((sample) => sample.transform && sample.transform !== 'none').map((sample) => ({ t: sample.t, transform: sample.transform, animationName: sample.animationName })),
        samplesCount: samples.length,
      }
      console.log('PROMO-UNDO :: ' + JSON.stringify({ anims: promo.dismissUndo.animationNames, transform400: promo.dismissUndo.transformAt400ms, writes: stats.writes, clicks: during.clickAtMs }))
      if (stats.writes > 0) anomaly('promo-undo', '真点 ✕ 之后出现了后台写请求（应该只有 localStorage）', stats.counts)
      // 量完撤销回来，别把这一轮的状态留在页面上
      const undoBtn = await evaluate('(' + bringIntoView.toString() + ')(".vq-promo-undo-button")')
      if (undoBtn && !undoBtn.missing) {
        const markUndo = cdp.requests.length
        await clickAt(undoBtn.cx, undoBtn.cy, 90)
        await sleep(400)
        promo.dismissUndo.undoClick = { restored: await evaluate('document.querySelectorAll(".vq-promo").length'), writeRequests: writeStatsFrom(markUndo).writes }
        console.log('PROMO-UNDO-RESTORE :: ' + JSON.stringify(promo.dismissUndo.undoClick))
      } else {
        promo.dismissUndo.undoClick = { error: '撤销按钮没找到，运营位的关掉状态留在浏览器里（只影响本地存储）' }
      }
      promo.localKeys = await evaluate('(' + promoLocalKeys.toString() + ')()')
    } else {
      promo.dismissUndo = { error: '关掉前找不到 .vq-promo-close，这一条量不到' }
    }
  }

  // ---- 逐趟巡检 ----
  const active = PASSES.filter((pass) => !ONLY.length || ONLY.indexOf(pass.id) >= 0)
  for (const pass of active) {
    console.log('---- 趟：' + pass.id + ' · ' + pass.label)
    const row = await runPass(pass)
    if (pass.id === 'admin-promos' && row.extra) promo.adminWeights = row.extra
  }

  // ---- 版本面 ----
  await goto('/overview', '.vq-content')
  const bits = await evaluate('(function () { var list = Array.prototype.map.call(document.querySelectorAll("script[src]"), function (n) { return String(n.getAttribute("src")).split("/").pop() }).filter(function (n) { return n && n.indexOf("index-") === 0 }); var label = document.querySelector(".vq-version-label"); return { scripts: list, uiVersion: label ? String(label.textContent || "").trim() : null } })()')
  const apiVersion = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  note('入口与版本', { loaded: bits.scripts, dist: distEntry, api: apiVersion && apiVersion.version, distVersion: distPkgVersion })
} catch (error) {
  stopped = true
  anomaly('script', '巡检脚本自己崩了', String((error && error.stack) || error).slice(0, 600))
  if (serverLog) note('服务端日志尾部', serverLog.slice(-800))
}

// ---- 汇总 ----
const allWrites = cdp ? cdp.requests.map((row) => ({ method: row.method, path: pathOf(row.url) })).filter((row) => WRITE_METHODS.has(row.method) && row.path.indexOf('/api/') === 0) : []
const writeCounts = {}
for (const row of allWrites) writeCounts[row.method + ' ' + row.path] = (writeCounts[row.method + ' ' + row.path] || 0) + 1
const candidates = buttons.filter((row) => row.verdict === 'pressed-no-feedback')
const upstream = cdp ? cdp.requests.filter((row) => row.url.indexOf(BASE) !== 0 && /10100|seeapi|geteapi|redfox|api\.openai|generations|replicate/i.test(row.url)) : []

const out = {
  round: 'r331',
  script: 'scripts/audit-press.mjs',
  at: new Date().toISOString(),
  dist: DIST_DIR,
  entry: distEntry,
  distVersion: distPkgVersion,
  outDir: OUT_DIR,
  port: API_PORT,
  dataDir: dataDir,
  viewport: WIDTH + 'x' + HEIGHT + '（只查「有没有反应」，不换尺寸）',
  probe: {
    baseline: 'idle/hover：鼠标先移到元素中心，读 computed style + el.matches(:active)',
    pressed: 'mousePressed 同一坐标，两帧 rAF 后读同一批属性 + matches(:active)',
    props: PROPS.map((pair) => pair[1]).concat(AFTER_PROPS.map((pair) => pair[1])),
    release: '不在原地 mouseReleased —— 先挪到视口里的中性点再松，不合成 click',
    candidate: 'pressActive=true 且 changed 为空 = 按下无反馈候选',
    settled: '判定按上面两帧那一拍（与 r331 的数字可比）；还按着再等 200ms 读一次叫 pressedSettled / changedSettledVsHover，用来区分「真的没反应」和「过渡还没走到」（后者算采样抖动）',
  },
  seeds: seeded,
  overlays: overlayLog,
  passes: passes,
  buttons: buttons,
  candidates: candidates.map((row) => ({ page: row.page, pageLabel: row.pageLabel, n: row.n, text: row.text, selector: row.selector, tag: row.tag, disabled: row.disabled, pressActive: row.pressActive, changed: [], screenshot: row.screenshot ? row.screenshot.file : null })),
  promo: promo,
  writeRequests: { total: allWrites.length, counts: writeCounts },
  upstreamCalls: upstream.length,
  upstreamUrls: upstream.slice(0, 3).map((row) => row.url),
  exceptions: cdp ? cdp.exceptions : [],
  consoleErrors: cdp ? cdp.consoleErrors : [],
  anomalies: anomalies,
  notes: notes,
  screenshots: shots,
  summary: {
    passes: passes.length,
    passesAborted: passes.filter((row) => row.aborted).length,
    buttonsMeasured: buttons.length,
    pressed: totalPressCount,
    hasFeedback: buttons.filter((row) => row.verdict === 'has-feedback').length,
    candidates: candidates.length,
    activeNotMatched: buttons.filter((row) => row.verdict === 'active-not-matched').length,
    disabled: buttons.filter((row) => row.verdict === 'disabled').length,
    readFailed: buttons.filter((row) => row.verdict === 'read-failed').length,
    // 两帧那一拍是空的、但还按着等过渡走完后确实变了：说明反馈在，只是采样早了（别把它算成回归）
    settledRescued: candidates.filter((row) => (row.changedSettledVsHover || []).length > 0).length,
    writeRequests: allWrites.length,
    upstreamCalls: upstream.length,
    anomalies: anomalies.length,
  },
}
fs.writeFileSync(path.join(OUT_DIR, 'press.json'), JSON.stringify(out, null, 2))

function pad(text, width) {
  const value = String(text === null || text === undefined ? '-' : text)
  let visible = 0
  for (const char of value) visible += char.charCodeAt(0) > 255 ? 2 : 1
  return value + ' '.repeat(Math.max(0, width - visible))
}
console.log('')
console.log('---- 按钮逐行（' + buttons.length + ' 个）----')
console.log(pad('屏', 18) + pad('#', 4) + pad('文本', 22) + pad('判定', 22) + pad('active', 8) + pad('按下变化', 40) + '选择器')
console.log('-'.repeat(150))
for (const row of buttons) {
  console.log(
    pad(row.page, 18) + pad(row.n, 4) + pad(String(row.text).slice(0, 18), 22) + pad(row.verdict, 22) +
    pad(String(row.pressActive), 8) + pad(row.changed.map((c) => c.prop).join(',') || '无', 40) + row.selector,
  )
}
console.log('')
console.log('---- 无反馈候选（' + candidates.length + ' 个）----')
for (const row of candidates) {
  console.log(pad(row.page, 18) + pad(String(row.text).slice(0, 20), 22) + pad(row.selector, 60) + 'active=' + row.pressActive + ' changed=[]' + (row.screenshot ? ' 截图=' + row.screenshot.file : ''))
}
console.log('')
console.log('---- 趟汇总 ----')
for (const row of passes) {
  console.log(pad(row.id, 18) + pad('可见可点 ' + row.total, 14) + pad('量了 ' + row.measured, 10) + pad('有反馈 ' + row.feedback, 12) + pad('候选 ' + row.noFeedback, 10) + pad('active没匹配 ' + row.activeNotMatched, 18) + pad('禁用 ' + row.disabled, 10) + pad('读不到 ' + row.readFailed, 12) + pad('写请求 ' + row.writeRequests, 12) + (row.aborted || ''))
}
console.log('')
console.log('---- 按下巡检 · ' + out.summary.buttonsMeasured + ' 个按钮 / ' + passes.length + ' 趟 · 无反馈候选 ' + candidates.length + ' · 写请求 ' + allWrites.length + ' · 上游 ' + upstream.length + ' · 证据 ' + path.join(path.relative(ROOT, OUT_DIR), 'press.json') + ' ----')

try { chrome.kill() } catch { /* 已经退出 */ }
try { server.kill() } catch { /* 已经退出 */ }
await sleep(400)
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
if (stopped) process.exit(1)
process.exit(0)
