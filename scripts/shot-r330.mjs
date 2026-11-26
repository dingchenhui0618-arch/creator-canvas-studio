// r330 取证：三件小事（提示条不吃点击 / 两个「按下去没反应」的按钮）
//
// 为什么单开一个脚本：r329 巡检时顺手记下三处，每条都只有一次观察，没有可复现的数字。
// 这一轮只做取证——同一份脚本跑 before（现在生产上那份 r329 构建）与 after，
// 把同一批数字并排放在 r330.json 里，谁都能照着复现。
//
// 骨架直接复用 r329（scripts/shot-r329.mjs）：
//   临时实例（真 SQLite、临时 DATA_DIR、临时账号 + cookie）、CDP 真输入、
//   --dist / --out / --only、把 --dist 那份构建挂进 stage 目录（绝不重新构建）。
//
// 三条纪律（与 r329 同一套）：
//   1) 0 次上游调用：VISION_BASE_URL 指到本机一个没人监听的端口；生成 / 评审 / 解析一概不点，
//      真要跳过就写「跳过：会扣费」。
//   2) 一律 CDP 真输入（Input.dispatchMouseEvent / dispatchKeyEvent），不用程序化 .click()。
//   3) 量不出来写 null 并写明原因，不猜、不把「接口 200」当界面对了。
//
// 用法：
//   node scripts/shot-r330.mjs --dist .shots330/dist-before --out .shots330/before
//   node scripts/shot-r330.mjs --dist .shots330/dist-before --out .shots330/before --only toast
//
// 产物：<out>/r330.json + <out>/*.png（1440x1000 为主；提示条那组在 390 宽再量一次几何）
//
// 六条 check（id 固定，before 该红就红）：
//   toast.hit-is-button               提示条在场时，按钮中心命中的必须是按钮本身
//   toast.no-overlap-footer           提示条矩形 ∩ 抽屉底栏矩形 的面积必须是 0（1440 与 390 各一次）
//   toast.second-click-reaches-button 连点两次，第二次的落点还得是按钮（第一次就成功则视为达成）
//   toast.zero-write-requests         第二次点击本身 0 次写请求（不许因为提示条多写一次）
//   promo-save.hover-changes          后台「保存运营位」悬停至少变一个属性
//   agx-card.press-changes            #/agents 预设卡按下至少变一个属性
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
// 在仓库根目录跑就行；不在根目录跑时按脚本位置往上找一层，别悄悄用错 dist。
const ROOT = fs.existsSync(path.join(process.cwd(), 'server', 'index.mjs')) ? process.cwd() : path.resolve(SCRIPT_DIR, '..')
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOTS_ROOT = path.join(ROOT, '.shots330')

function argOf(name, fallback) {
  const at = process.argv.indexOf('--' + name)
  if (at > 0 && process.argv[at + 1] && process.argv[at + 1].charAt(0) !== '-') return process.argv[at + 1]
  return fallback
}

const ONLY = String(argOf('only', '')).split(',').map((item) => item.trim()).filter(Boolean)
const OUT_DIR = path.resolve(ROOT, String(argOf('out', '.shots330/before')))
const DIST_DIR = path.resolve(ROOT, String(argOf('dist', '.shots330/dist-before')))
if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) throw new Error('dist 里没有 index.html：' + DIST_DIR)
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 SHOT_CHROME 指定）')
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(SHOTS_ROOT, { recursive: true })

const wantSection = (id) => !ONLY.length || ONLY.indexOf(id) >= 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const checks = []
function check(id, ok, detail) {
  checks.push({ id: id, ok: Boolean(ok), detail: detail === undefined ? null : detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + JSON.stringify(detail))
}
// 自检（脚本自己的可信度）：单独一组，混进那六条会让人分不清「界面有问题」还是「取证工具有问题」。
const selfProof = []
function proof(id, ok, detail) {
  selfProof.push({ id: id, ok: Boolean(ok), detail: detail === undefined ? null : detail })
  console.log((ok ? 'SELF-PASS ' : 'SELF-FAIL ') + id + ' :: ' + JSON.stringify(detail))
}
const notes = []
function note(text, detail) {
  notes.push({ text: text, detail: detail === undefined ? null : detail })
  console.log('NOTE ' + text + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

// 端口：避开这台机器上其它常驻服务（与 r329 同一份名单）。
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

// ---- 临时实例：真 SQLite、真账号、真 cookie，只有数据目录是新的（绝不碰真实数据）----
const dataDir = fs.mkdtempSync(path.join(SHOTS_ROOT, 'data-'))
const profile = fs.mkdtempSync(path.join(SHOTS_ROOT, 'profile-'))
process.env.DATA_DIR = dataDir

// 服务端用 process.cwd() 找 dist 与 package.json，所以给它一个「装着一份 dist」的舞台目录：
// 量的是 --dist 指的那份拷贝，别人之后重新构建也污染不到这份证据。
const stageDir = path.join(SHOTS_ROOT, 'stage')
fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir, { recursive: true })
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
// 舞台里的 package.json 用「这份 dist 自己的版本号」：拿源码树现在的版本顶上会让 /api/version 对不上。
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

// ---- 铺数据（都是真数据：模板一条、对话预设一个、后台账号一个）----
const AT = String.fromCharCode(64)
const PASSWORD = 'r330-probe-pass1'
// 一张真的 1x1 PNG：模板封面。这一轮不看图，只要求卡片照常渲染。
const COVER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const { createSession, createUser } = await import('../server/auth.mjs')
const { createAgent } = await import('../server/agents.mjs')
const { markComplete } = await import('../server/onboarding.mjs')
const { config: cfg } = await import('../server/config.mjs')

const admin = createUser({ email: 'r330-admin' + AT + 'shot.test', password: PASSWORD, name: '运维', kind: 'admin' })
const account = createUser({ email: 'r330probe' + AT + 'shot.test', password: PASSWORD, name: '取证员', kind: 'account' })
const token = createSession(account, {}).token
const adminToken = createSession(admin, {}).token
// 后台那一屏要的是运营位，不是引导，所以管理员先标成已完成——这一条会写进报告，不假装是点出来的。
markComplete(admin.id, { skipAssets: true })

const seeded = { account: account.id, admin: admin.id, template: '', agent: '', onboarding: '' }

const templateEntry = {
  id: 'tpl_r330_probe',
  kind: 'replica',
  title: '一分钟出片的那条',
  contentType: '口播',
  tags: ['取证'],
  platform: 'douyin',
  platformLabel: '抖音',
  sourceUrl: 'https://www.douyin.com/video/3300330',
  sourceId: 'dy_3300330',
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
  cover: COVER,
  video: { width: 1080, height: 1920, fps: 30, duration: 18 },
  origin: 'manual',
  reuseCount: 0,
  ownerId: account.id,
  createdAt: new Date().toISOString(),
  savedAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(dataDir, 'templates.json'), JSON.stringify([templateEntry], null, 2), 'utf8')
seeded.template = templateEntry.title

const agent = await createAgent({
  name: 'r330 口播拆解',
  category: '脚本分镜',
  role: '把一条口播拆成脚本与分镜',
  systemPrompt: '你负责把口播拆成分镜表：先给结果，再给步骤。看不清的地方标出来，不要编。',
}, account)
seeded.agent = agent.name

console.log('r330 取证 · dist=' + DIST_DIR + ' · 入口 ' + distEntry + ' · v' + distPkgVersion + ' · 端口 ' + API_PORT + ' · 数据目录 ' + dataDir)

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
    // 上游闸：模型 baseUrl 指向本机一个没人监听的端口，误触也打不到 OpenCodex。
    VISION_BASE_URL: BASE + '/dead-upstream/v1',
    VISION_API_KEY: 'r330-not-a-real-key',
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

// 找元素：一律「选择器 + 文本相等 + 第几个」。这几个函数会被 toString() 注入页面，
// 所以每个都要自包含（不互相调用），也不用 eval 字符串。
const q = (sel) => ({ sel: sel })
const byText = (text, sel) => ({ sel: sel || 'button', text: text })
const nthOf = (sel, index) => ({ sel: sel, index: index })
const selText = (F) => F.sel + (F.text ? '（文本 = ' + F.text + '）' : '') + (F.index ? '（第 ' + (F.index + 1) + ' 个）' : '')

function findRect(F) {
  let list = Array.prototype.slice.call(document.querySelectorAll(F.sel))
  if (F.text) list = list.filter(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim() === F.text })
  const el = list[F.index || 0]
  if (!el) return { missing: true, matched: list.length }
  // 视口只有 1000 高，长页面上大半按钮在屏外；鼠标事件落在屏外坐标上等于没点。
  // 只做「滚到眼前」，滚的是真滚动容器，不伪造点击。
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  return {
    cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
    l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    inViewport: r.top >= 4 && r.bottom <= window.innerHeight - 4 && r.left >= 0 && r.right <= window.innerWidth,
    scroller: (function () { let n = el.parentElement; while (n) { const s = getComputedStyle(n); if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return (n.className || n.tagName).toString().split(' ')[0] || 'div'; n = n.parentElement } return 'window' })(),
  }
}

function probeEl(F) {
  // 一个元素的样子：这一轮只关心「悬停 / 按下到底变没变」，所以把这几个属性一起读回来。
  let list = Array.prototype.slice.call(document.querySelectorAll(F.sel))
  if (F.text) list = list.filter(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim() === F.text })
  const el = list[F.index || 0]
  if (!el) return { missing: true, matched: list.length }
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  const cls = String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
  return {
    tag: el.tagName, cls: cls,
    cursor: cs.cursor,
    transform: cs.transform,
    borderColor: cs.borderColor,
    boxShadow: cs.boxShadow,
    backgroundColor: cs.backgroundColor,
    backgroundImage: cs.backgroundImage,
    color: cs.color,
    filter: cs.filter,
    opacity: cs.opacity,
    outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
    transition: cs.transitionProperty + ' ' + cs.transitionDuration,
    hover: el.matches(':hover'),
    active: el.matches(':active'),
    disabled: Boolean(el.disabled),
    text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 32),
    l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
  }
}

function installPathHelper() {
  window.__r330path = function (el) {
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

function installToastCounter() {
  // 「提示条出现」这件事本身要被数出来：vq-toast-in 是 animation-name（motion.css），
  // 挂上去那一帧会派发 animationstart，这里在文档最开头就把监听装上（走的是
  // Page.addScriptToEvaluateOnNewDocument），所以第一条提示条也数得到。
  // 另外用一个 32ms 的采样器记「.vq-toast 的数量变化」，动画被 reduce-motion 关掉时它是唯一的证据。
  if (!window.__r330) window.__r330 = {}
  const state = window.__r330
  state.toastIn = 0
  state.samples = []
  document.addEventListener('animationstart', function (event) {
    if (event.animationName === 'vq-toast-in') state.toastIn += 1
  }, true)
  let last = -1
  const timer = setInterval(function () {
    const n = document.querySelectorAll('.vq-toast').length
    if (n !== last) {
      last = n
      state.samples.push({ at: Math.round(performance.now()), count: n })
    }
    if (performance.now() > 60000) clearInterval(timer)
  }, 32)
  return true
}

function readToastCounter() {
  const state = window.__r330 || {}
  const samples = state.samples || []
  return {
    toastIn: state.toastIn || 0,
    appearances: samples.filter(function (row) { return row.count > 0 }).length,
    samples: samples.slice(-8),
    now: Math.round(performance.now()),
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }
}

function toastSceneProbe(BTN, TOAST, FOOT) {
  // 一次把这一组要的数字全取回来：按钮 / 提示条 / 底栏三个矩形、彼此的交集、
  // 以及「按钮中心那一点，鼠标真正落在谁身上」。
  function find(F) {
    const list = Array.prototype.slice.call(document.querySelectorAll(F.sel))
    if (F.text) return list.filter(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim() === F.text })[F.index || 0] || null
    return list[F.index || 0] || null
  }
  function box(el) {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom),
      w: Math.round(r.width), h: Math.round(r.height),
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
    }
  }
  function inter(a, b) {
    if (!a || !b) return null
    const w = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l))
    const h = Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t))
    return { w: w, h: h, area: w * h }
  }
  function hit(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return null
    const el = document.elementFromPoint(x, y)
    if (!el) return null
    const cs = getComputedStyle(el)
    const cls = String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
    return {
      tag: el.tagName, cls: cls, cursor: cs.cursor, pointerEvents: cs.pointerEvents,
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      path: window.__r330path ? window.__r330path(el) : el.tagName + (cls ? '.' + cls : ''),
    }
  }
  const btn = find(BTN)
  const toast = find(TOAST)
  const foot = find(FOOT)
  const bb = box(btn)
  const tb = box(toast)
  const fb = box(foot)
  const atBtn = bb ? document.elementFromPoint(bb.cx, bb.cy) : null
  const insideBtn = Boolean(atBtn && btn && (atBtn === btn || btn.contains(atBtn)))
  const tcs = toast ? getComputedStyle(toast) : null
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches },
    hash: String(location.hash || ''),
    drawerOpen: Boolean(document.querySelector('.drawer-backdrop')),
    btn: btn ? { box: bb, text: String(btn.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20), cursor: getComputedStyle(btn).cursor, disabled: Boolean(btn.disabled) } : null,
    toast: toast ? {
      box: tb,
      text: String(toast.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      position: tcs.position, bottom: tcs.bottom, zIndex: tcs.zIndex,
      pointerEvents: tcs.pointerEvents, animationName: tcs.animationName, opacity: tcs.opacity,
      leaving: toast.classList.contains('is-leaving'),
      role: String(toast.getAttribute('role') || ''),
      tone: String(toast.getAttribute('data-tone') || ''),
    } : null,
    foot: fb ? { box: fb, text: String(foot.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), buttons: foot.querySelectorAll('button').length } : null,
    overlap: { toastBtn: inter(tb, bb), toastFoot: inter(tb, fb) },
    hitAtButtonCenter: hit(bb ? bb.cx : null, bb ? bb.cy : null),
    hitInsideButton: insideBtn,
    hitAtToastCenter: tb ? hit(tb.cx, tb.cy) : null,
    toastCount: document.querySelectorAll('.vq-toast').length,
    btnCount: document.querySelectorAll(BTN.sel).length,
  }
}

function pageTextSlice(limit) {
  // 页面上看得见的文字压成一行——只有「锚点没找到」时才用得上。
  return String(document.body.innerText || '').replace(/\s+/g, ' ').slice(0, limit)
}

function sanitizeVisibleText() {
  // 截图里不该出现临时账号的邮箱：渲染完再抹掉，报告里写清抹了几处。
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

// ---- 真输入 ----
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
  const view = await evaluate('(' + findRect.toString() + ')(' + JSON.stringify(F) + ')')
  if (!view || view.missing) return null
  await clickAt(view.cx, view.cy, gap)
  return view
}
async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: false })
  await sleep(120)
}

// ---- 页面导航 ----
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
let lastAnchor = { anchor: '', found: true, text: '' }
async function goto(route, anchor, who = 'user') {
  await switchAccountCookie(route.indexOf('admin:') === 0 ? 'admin' : who)
  await cdp.send('Page.navigate', { url: routeUrl(route) })
  await sleep(650)
  // 外壳没挂上多半是一次没加载完（chunk 被换掉、首帧太慢）：重载一次再等，
  // 别把一次抖动写成「这一屏没量到」。
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
    anchor: anchor, found: found,
    text: found ? '' : String(await evaluate('(' + pageTextSlice.toString() + ')(400)')),
  }
  if (!found) console.log('ANCHOR-MISS ' + anchor + ' :: ' + lastAnchor.text.slice(0, 160))
  // 每一屏都装一遍路径助手：它只在当前文档里活着。
  await evaluate('(' + installPathHelper.toString() + ')()')
}

const overlayLog = []
let gateDone = false
async function dismissOverlays() {
  // 上手引导（vq-guide）：真点右上角那颗「关闭引导」。
  for (let i = 0; i < 3; i += 1) {
    if (!(await evaluate('Boolean(document.querySelector(".vq-guide"))'))) break
    const rect = await evaluate('(' + findRect.toString() + ')(' + JSON.stringify(q('.vq-guide [aria-label="关闭引导"]')) + ')')
    if (!rect || rect.missing) break
    await clickAt(rect.cx, rect.cy, 90)
    overlayLog.push({ what: '上手引导', how: '真点「关闭引导」（aria-label）', gone: !(await evaluate('Boolean(document.querySelector(".vq-guide"))')) })
    await sleep(200)
  }
  // 身份引导（vq-gate）：三步、没有关闭键，只能真点走完。
  // 走完这一步很关键：它把账号的引导标成「做完了，但一件资产都没有」，
  // 之后每次进页面才会弹那条「还没有自己的资产…」的提示条（这一轮的取证对象）。
  if (!gateDone && (await evaluate('Boolean(document.querySelector(".vq-gate"))'))) {
    const steps = []
    const pick = async (F) => {
      const rect = await evaluate('(' + findRect.toString() + ')(' + JSON.stringify(F) + ')')
      if (!rect || rect.missing) return false
      await clickAt(rect.cx, rect.cy, 80)
      return true
    }
    if (await pick(nthOf('.vq-gate-choice', 0))) steps.push('点第 1 个身份')
    if (await pick(byText('继续', '.vq-gate-foot button'))) steps.push('第 1 步「继续」')
    await sleep(800)
    if (await pick(nthOf('.vq-gate-kind', 0))) steps.push('点第 1 个类目')
    if (await pick(byText('继续', '.vq-gate-foot button'))) steps.push('第 2 步「继续」')
    await sleep(800)
    if (await pick(byText('以后再说', '.vq-gate-foot button'))) steps.push('第 3 步「以后再说」（跳过建资产）')
    await sleep(900)
    const gone = !(await evaluate('Boolean(document.querySelector(".vq-gate"))'))
    overlayLog.push({ what: '身份引导', how: steps.join(' → '), gone: gone })
    gateDone = gone
  }
  const know = await evaluate('(' + findRect.toString() + ')(' + JSON.stringify(q('[aria-label="知道了"]')) + ')')
  if (know && !know.missing) await clickAt(know.cx, know.cy, 70)
  return overlayLog
}

async function shot(name) {
  const captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = path.join(OUT_DIR, name)
  fs.writeFileSync(file, Buffer.from(captured.data, 'base64'))
  const size = await evaluate('({ w: window.innerWidth, h: window.innerHeight })')
  const bytes = fs.statSync(file).size
  console.log('SHOT ' + name + ' · ' + bytes + ' B · ' + (size ? size.w + 'x' + size.h : '?'))
  return { file: name, bytes: bytes, width: size ? size.w : null, height: size ? size.h : null }
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

const STYLE_PROPS = ['cursor', 'backgroundColor', 'backgroundImage', 'color', 'borderColor', 'boxShadow', 'transform', 'outline', 'filter', 'opacity']
function diffProps(base, now, props) {
  const changed = []
  for (const prop of props) {
    if (!base || !now) continue
    if (String(base[prop]) !== String(now[prop])) changed.push(prop + ': ' + String(base[prop]) + ' → ' + String(now[prop]))
  }
  return changed
}
const pickProps = (snapshot) => {
  const out = {}
  for (const prop of STYLE_PROPS) out[prop] = snapshot ? snapshot[prop] : null
  return out
}

const pageNotesProbe_ = function () {
  const sel = '[role="alert"], .vq-field-error, .vq-note--error, .vq-toast, .runs-note, .admin-note, .agx-failure'
  const out = []
  Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) out.push(text.slice(0, 90))
  })
  return out.slice(0, 6)
}
function withToastCounter() {
  return '(' + readToastCounter.toString() + ')()'
}

// =====================================================================
// ① 提示条 vs 抽屉底栏：「用它做作品」被提示条吃了 3.3 秒
// =====================================================================
const BTN = { sel: '.template-drawer button', text: '用它做作品' }
const TOAST = { sel: '.vq-toast' }
const FOOT = { sel: '.drawer-foot' }

async function toastScene(width, height, tag) {
  const entry = {
    tag: tag, viewport: { w: width, h: height },
    selector: selText(BTN), toastSelector: '.vq-toast', footerSelector: '.drawer-foot',
    attempts: [],
  }
  await setViewport(width, height)
  let scene = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const a = { attempt: attempt }
    entry.attempts.push(a)
    try {
      await goto('/templates', '.template-card')
      await dismissOverlays()
      // 真点第一张模板卡打开详情抽屉
      const card = await clickFr(nthOf('.template-card', 0), 70)
      if (!card) throw new Error('模板库一张卡都没有（templates.json 没铺上？）')
      a.cardClick = { cx: card.cx, cy: card.cy }
      await waitForExpr('Boolean(document.querySelector(".template-drawer"))', '模板详情抽屉', 20, 120)
      // 提示条是「引导做完但一件资产都没有」时进页面弹一次的：等它出现（它才是这一轮的取证对象）
      const seen = await waitForExpr('Boolean(document.querySelector(".vq-toast"))', '提示条出现', 12, 120).catch(() => false)
      a.toastSeen = Boolean(seen)
      if (!seen) { a.note = '这一次打开抽屉时提示条没出现（或已经消失），重来一次'; await sleep(200); continue }
      const first = await evaluate('(' + toastSceneProbe.toString() + ')(' + JSON.stringify(BTN) + ',' + JSON.stringify(TOAST) + ',' + JSON.stringify(FOOT) + ')')
      if (!first || !first.btn) { a.note = '抽屉里找不到「用它做作品」这颗按钮：' + selText(BTN); continue }
      a.geometry = first.overlap
      a.hitAtButtonCenter = first.hitAtButtonCenter
      a.toast = first.toast ? { box: first.toast.box, pointerEvents: first.toast.pointerEvents, bottom: first.toast.bottom, zIndex: first.toast.zIndex } : null
      entry.first = first
      const sanitized = await evaluate('(' + sanitizeVisibleText.toString() + ')()')
      a.sanitized = sanitized
      entry.screenshot = await shot('templates-toast' + (width === 1440 ? '' : '-' + width) + '.png')
      scene = first
      break
    } catch (error) {
      a.error = String((error && error.message) || error).slice(0, 240)
      console.log('ERROR toast/' + tag + ' attempt ' + attempt + ' :: ' + a.error)
    }
  }
  if (!scene) {
    entry.error = '三次都没能在提示条在场时把抽屉打开到可量的状态'
    return entry
  }

  const counter0 = await evaluate(withToastCounter())
  entry.toastCounterAtOpen = counter0

  // ---- 第一次点击：提示条在场 ----
  const net1 = cdp.requests.length
  const c1 = { at: 'while-toast', buttonCenter: { x: scene.btn.box.cx, y: scene.btn.box.cy } }
  c1.counterBefore = (await evaluate(withToastCounter())).toastIn
  await clickAt(scene.btn.box.cx, scene.btn.box.cy, 70)
  await sleep(700)
  const after1 = await evaluate('(' + toastSceneProbe.toString() + ')(' + JSON.stringify(BTN) + ',' + JSON.stringify(TOAST) + ',' + JSON.stringify(FOOT) + ')')
  c1.counterAfter = (await evaluate(withToastCounter())).toastIn
  c1.toastInDelta = c1.counterAfter - c1.counterBefore
  c1.stats = requestStats(net1, '/api/projects')
  c1.writes = c1.stats.writes
  c1.buttonPresent = Boolean(after1 && after1.btn)
  c1.toastPresent = Boolean(after1 && after1.toast)
  c1.drawerOpen = Boolean(after1 && after1.drawerOpen)
  c1.hash = after1 ? after1.hash : null
  c1.hitAfterClick = after1 && after1.btn ? after1.hitAtButtonCenter : null
  c1.notes = await evaluate('(' + pageNotesProbe_.toString() + ')()')
  entry.click1 = c1

  // ---- 第二次点击：同一个坐标再点一下（提示条还在时段内）----
  const c2 = { at: 'second', skipped: null }
  if (!after1 || !after1.btn) {
    // 修复之后第一次点击就成功：抽屉关了、跳到作品页，按钮随之消失——没有第二次可点。
    c2.skipped = '第一次点击之后按钮已经不在了（抽屉关闭 / 跳到作品页），没有第二次可点'
    c2.landedOnButton = null
  } else if (!after1.toast) {
    c2.skipped = '第二次点击前提示条已经消失（这一次的时序不可信）'
    c2.timingSuspect = true
    entry.timingSuspect = true
  } else {
    const net2 = cdp.requests.length
    c2.buttonCenter = { x: after1.btn.box.cx, y: after1.btn.box.cy }
    c2.counterBefore = (await evaluate(withToastCounter())).toastIn
    c2.hitAtClick = after1.hitAtButtonCenter
    c2.landedOnButton = Boolean(after1.hitInsideButton)
    await clickAt(after1.btn.box.cx, after1.btn.box.cy, 70)
    await sleep(800)
    const after2 = await evaluate('(' + toastSceneProbe.toString() + ')(' + JSON.stringify(BTN) + ',' + JSON.stringify(TOAST) + ',' + JSON.stringify(FOOT) + ')')
    c2.counterAfter = (await evaluate(withToastCounter())).toastIn
    c2.toastInDelta = c2.counterAfter - c2.counterBefore
    c2.stats = requestStats(net2, '/api/projects')
    c2.writes = c2.stats.writes
    c2.buttonPresent = Boolean(after2 && after2.btn)
    c2.toastPresent = Boolean(after2 && after2.toast)
    c2.drawerOpen = Boolean(after2 && after2.drawerOpen)
    c2.hash = after2 ? after2.hash : null
    c2.hitAfterClick = after2 && after2.btn ? after2.hitAtButtonCenter : null
    c2.notes = await evaluate('(' + pageNotesProbe_.toString() + ')()')
    c2.counterFinal = (await evaluate(withToastCounter())).toastIn
    entry.secondToast = c2.toastPresent ? await evaluate('String((document.querySelector(".vq-toast") || {}).textContent || "").trim().slice(0, 80)') : null
  }
  entry.click2 = c2

  // ---- 第三次点击：等提示条自己消失之后，同一颗按钮再点一次（按钮本身坏没坏）----
  const c3 = { at: 'after-toast-cleared', skipped: null }
  const cleared = await waitForExpr('Boolean(!document.querySelector(".vq-toast"))', '提示条消失', 40, 150).catch(() => false)
  c3.toastCleared = Boolean(cleared)
  if (!c3.toastCleared) {
    c3.skipped = '提示条一直没有消失（到 6 秒上限仍在），这一拍跳过'
  } else {
    const net3 = cdp.requests.length
    const pre3 = await evaluate('(' + toastSceneProbe.toString() + ')(' + JSON.stringify(BTN) + ',' + JSON.stringify(TOAST) + ',' + JSON.stringify(FOOT) + ')')
    if (!pre3 || !pre3.btn) {
      c3.skipped = '提示条消失时按钮已经不在页面上了'
    } else {
      c3.counterBefore = (await evaluate(withToastCounter())).toastIn
      c3.hitAtClick = pre3.hitAtButtonCenter
      c3.landedOnButton = Boolean(pre3.hitInsideButton)
      await clickAt(pre3.btn.box.cx, pre3.btn.box.cy, 70)
      await sleep(900)
      const post3 = await evaluate('(' + toastSceneProbe.toString() + ')(' + JSON.stringify(BTN) + ',' + JSON.stringify(TOAST) + ',' + JSON.stringify(FOOT) + ')')
      c3.counterAfter = (await evaluate(withToastCounter())).toastIn
      c3.toastInDelta = c3.counterAfter - c3.counterBefore
      c3.stats = requestStats(net3, '/api/projects')
      c3.writes = c3.stats.writes
      c3.drawerOpen = Boolean(post3 && post3.drawerOpen)
      c3.hash = post3 ? post3.hash : null
      c3.notes = await evaluate('(' + pageNotesProbe_.toString() + ')()')
      c3.screenshot = await shot('templates-toast-cleared' + (width === 1440 ? '' : '-' + width) + '.png')
    }
  }
  entry.click3 = c3
  entry.counterEnd = await evaluate(withToastCounter())
  console.log('TOAST ' + tag + ' · hit=' + JSON.stringify(scene.hitAtButtonCenter) + ' · 交集=' + JSON.stringify(scene.overlap.toastFoot) + ' · click1(' + c1.writes + ' 写/' + c1.toastInDelta + ' 提示条) · click2=' + JSON.stringify({ landed: c2.landedOnButton, writes: c2.writes, delta: c2.toastInDelta, skipped: c2.skipped }) + ' · click3=' + JSON.stringify({ landed: c3.landedOnButton, writes: c3.writes, delta: c3.toastInDelta, skipped: c3.skipped }))
  return entry
}

// =====================================================================
// ② 后台「保存运营位」：裸 .vq-button，悬停 0 个属性变化
// =====================================================================
async function promoSection() {
  const F = byText('保存运营位', '.admin-promo-actions button')
  const entry = { id: 'promo-save', label: '后台运营位「保存运营位」（裸 .vq-button，无语气）', route: 'admin:/admin/system', selector: selText(F) }
  await setViewport(1440, 1000)
  try {
    await goto('admin:/admin/system', '.admin-promo-actions', 'admin')
    await dismissOverlays()
    await sleep(200)
    const view = await evaluate('(' + findRect.toString() + ')(' + JSON.stringify(F) + ')')
    entry.anchor = lastAnchor
    if (!view || view.missing) throw new Error('找不到「保存运营位」：' + selText(F))
    entry.rect = { l: view.l, t: view.t, w: view.w, h: view.h, cx: view.cx, cy: view.cy }
    entry.inViewport = view.inViewport
    entry.scroller = view.scroller
    const sanitized = await evaluate('(' + sanitizeVisibleText.toString() + ')()')
    entry.sanitized = sanitized
    if (sanitized > 0) note('后台运营位：截图前替换了 ' + sanitized + ' 处邮箱', { count: sanitized })
    entry.screenshot = await shot('admin-promos.png')
    entry.toastPresent = await evaluate('Boolean(document.querySelector(".vq-toast"))')
    const idle = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(F) + ')')
    entry.idle = pickProps(idle)
    entry.idleText = idle.text
    entry.idleBox = { l: idle.l, t: idle.t, w: idle.w, h: idle.h }
    // ① 悬停：鼠标移到中心等 420ms（--dur-1 是 120ms，过渡得走完再读）
    await mouseTo(idle.cx, idle.cy)
    await sleep(420)
    const hover = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(F) + ')')
    entry.hover = pickProps(hover)
    entry.hoverMatched = Boolean(hover && hover.hover)
    entry.hoverChanged = diffProps(idle, hover, STYLE_PROPS)
    // ② 按下（附带证据，不在六条 check 里）：按下之后把鼠标挪开再松，别真触发一次保存
    const netPress = cdp.requests.length
    await mouseDown(idle.cx, idle.cy)
    const pressedNow = await evaluate('new Promise(function (done) { requestAnimationFrame(function () { requestAnimationFrame(function () { done((' + probeEl.toString() + ')(' + JSON.stringify(F) + ')) }) }) })')
    entry.pressImmediate = pickProps(pressedNow)
    entry.pressShot = await shot('admin-promos-press.png')
    await sleep(350)
    const pressedSettled = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(F) + ')')
    entry.pressSettled = pickProps(pressedSettled)
    entry.pressMatched = Boolean(pressedSettled && pressedSettled.active)
    entry.pressChanged = diffProps(idle, pressedSettled, STYLE_PROPS)
    // 松手落在按钮上方 48px（动作栏之外），浏览器就不会把这一串当成一次点击
    await mouseUp(idle.cx, Math.max(8, idle.cy - 48))
    await sleep(400)
    entry.writesDuringPress = requestStats(netPress, null)
    entry.hashAfter = await evaluate('location.hash')
  } catch (error) {
    entry.error = String((error && error.message) || error).slice(0, 300)
    console.log('ERROR promo-save :: ' + entry.error)
    try { await mouseUp(700, 500) } catch { /* 忽略 */ }
  }
  console.log('PROMO idle bg=' + (entry.idle ? entry.idle.backgroundColor : '?') + ' hover bg=' + (entry.hover ? entry.hover.backgroundColor : '?') + ' changed=' + JSON.stringify(entry.hoverChanged || null) + (entry.error ? ' ERROR=' + entry.error : ''))
  return entry
}

// =====================================================================
// ③ #/agents 预设卡「选择」：按下 0 个属性变化
// =====================================================================
async function agxSection() {
  const MAIN = q('.agx-card-main')
  const entry = { id: 'agx-card', label: '#/agents 预设卡「选择」（.agx-card-main）', route: '/agents', selector: '.agx-card-main' }
  await setViewport(1440, 1000)
  try {
    await goto('/agents', '.agx-send')
    await dismissOverlays()
    // 这一屏默认停在「平台对话」，带预设卡的列表在「对话预设」那个页签里：真点过去
    const tab = await clickFr(byText('对话预设', '.agx-surface-switch button'), 90)
    if (!tab) throw new Error('找不到「对话预设」页签（.agx-surface-switch button）')
    await waitForExpr('Boolean(document.querySelector(".agx-card-main"))', '预设卡片', 25, 150)
    entry.anchor = lastAnchor
    const view = await evaluate('(' + findRect.toString() + ')(' + JSON.stringify(MAIN) + ')')
    if (!view || view.missing) throw new Error('预设库里没有可点的「选择」按钮')
    entry.rect = { l: view.l, t: view.t, w: view.w, h: view.h, cx: view.cx, cy: view.cy }
    entry.inViewport = view.inViewport
    const sanitized = await evaluate('(' + sanitizeVisibleText.toString() + ')()')
    entry.sanitized = sanitized
    if (sanitized > 0) note('快捷创作：截图前替换了 ' + sanitized + ' 处邮箱', { count: sanitized })
    entry.screenshot = await shot('agents-preset.png')
    entry.toastPresent = await evaluate('Boolean(document.querySelector(".vq-toast"))')
    entry.cardCount = await evaluate('document.querySelectorAll(".agx-card-main").length')
    const idle = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(MAIN) + ')')
    entry.idle = pickProps(idle)
    entry.idleText = idle.text
    entry.idleBox = { l: idle.l, t: idle.t, w: idle.w, h: idle.h }
    // ① 悬停
    await mouseTo(idle.cx, idle.cy)
    await sleep(420)
    const hover = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(MAIN) + ')')
    entry.hover = pickProps(hover)
    entry.hoverMatched = Boolean(hover && hover.hover)
    entry.hoverChanged = diffProps(idle, hover, STYLE_PROPS)
    // ② 按下：两帧之后（过渡刚开始）与 350ms 之后（过渡走完）各读一次——
    //    修完之后这张卡有 background-color 的过渡，只读一帧会读到中间色，反而说不清。
    const netPress = cdp.requests.length
    await mouseDown(idle.cx, idle.cy)
    const pressedNow = await evaluate('new Promise(function (done) { requestAnimationFrame(function () { requestAnimationFrame(function () { done((' + probeEl.toString() + ')(' + JSON.stringify(MAIN) + ')) }) }) })')
    entry.pressImmediate = pickProps(pressedNow)
    entry.pressShot = await shot('agents-preset-press.png')
    await sleep(350)
    const pressedSettled = await evaluate('(' + probeEl.toString() + ')(' + JSON.stringify(MAIN) + ')')
    entry.pressSettled = pickProps(pressedSettled)
    entry.pressMatched = Boolean(pressedSettled && pressedSettled.active)
    entry.pressChanged = diffProps(idle, pressedSettled, STYLE_PROPS)
    // 松手落在卡片上方 48px，别真去选中（选中会换一张卡的 DOM）
    await mouseUp(idle.cx, Math.max(8, idle.cy - 48))
    await sleep(400)
    entry.writesDuringPress = requestStats(netPress, null)
    entry.hashAfter = await evaluate('location.hash')
  } catch (error) {
    entry.error = String((error && error.message) || error).slice(0, 300)
    console.log('ERROR agx-card :: ' + entry.error)
    try { await mouseUp(700, 500) } catch { /* 忽略 */ }
  }
  console.log('AGX idle bg=' + (entry.idle ? entry.idle.backgroundColor : '?') + ' hover bg=' + (entry.hover ? entry.hover.backgroundColor : '?') + ' press bg=' + (entry.pressSettled ? entry.pressSettled.backgroundColor : '?') + ' changed=' + JSON.stringify(entry.pressChanged || null) + (entry.error ? ' ERROR=' + entry.error : ''))
  return entry
}

// =====================================================================
// 跑起来
// =====================================================================
const screenshots = []
let toastI = null
let toastM = null
let promo = null
let agx = null
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
  await setViewport(1440, 1000)
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })
  // 「提示条出现过几次」从文档第一帧就开始数：必须在第一次导航之前装上。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: '(' + installToastCounter.toString() + ')();' + '(' + installPathHelper.toString() + ')();',
  })

  // 开场：新 profile 会先弹身份引导，真点走完（这一步同时把账号变成「引导做完、没有资产」，
  // 之后每次进页面才会弹那条提示条——这轮的取证对象就是它）。
  await goto('/overview', '.vq-next-cta')
  await sleep(700)
  await dismissOverlays()
  if (overlayLog.length) note('开场遮罩：真点关掉了', overlayLog)
  else note('开场遮罩：这一轮没有出现需要关的遮罩')
  const doneState = await fetch(BASE + '/api/onboarding', { headers: { cookie: cfg.auth.cookieName + '=' + token } }).then((r) => r.json()).catch(() => null)
  seeded.onboarding = doneState ? JSON.stringify(doneState).slice(0, 180) : '（读不到 /api/onboarding）'
  note('铺好的引导状态（决定提示条会不会弹）', doneState)
  // 之后每一屏重新加载都要干净：把「看过上手引导」按账号记进 localStorage。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1');localStorage.setItem('vq.edition','user')}catch(e){}",
  })

  if (wantSection('toast')) {
    console.log('---- ① 提示条 vs 抽屉底栏（1440x1000）')
    toastI = await toastScene(1440, 1000, 'd1440')
    console.log('---- ① 提示条 vs 抽屉底栏（390x844，只量几何）')
    toastM = await toastScene(390, 844, 'd390')
    for (const item of [toastI, toastM]) if (item && item.screenshot) screenshots.push(item.screenshot)
  }
  if (wantSection('promo-save')) {
    console.log('---- ② 后台「保存运营位」悬停')
    promo = await promoSection()
    if (promo && promo.screenshot) screenshots.push(promo.screenshot, promo.pressShot)
  }
  if (wantSection('agx-card')) {
    console.log('---- ③ #/agents 预设卡按下')
    agx = await agxSection()
    if (agx && agx.screenshot) screenshots.push(agx.screenshot, agx.pressShot)
  }

  // ---- 六条 check（id 固定）----
  const scene = toastI && toastI.first ? toastI.first : null
  const hitIsButton = Boolean(scene && scene.hitInsideButton)
  check('toast.hit-is-button', hitIsButton, {
    meaning: '提示条在场时，elementFromPoint(按钮中心) 必须落在按钮上（被 .vq-toast 挡住就是 bug）',
    viewport: scene ? scene.viewport : null,
    hit: scene ? scene.hitAtButtonCenter : null,
    buttonCenter: scene && scene.btn ? { x: scene.btn.box.cx, y: scene.btn.box.cy } : null,
    toastBox: scene && scene.toast ? scene.toast.box : null,
    toastPointerEvents: scene && scene.toast ? scene.toast.pointerEvents : null,
    hitAtToastCenter: scene ? scene.hitAtToastCenter : null,
    measured: Boolean(scene),
    error: toastI && toastI.error ? toastI.error : null,
  })

  const area = (item) => (item && item.first && item.first.overlap && item.first.overlap.toastFoot ? item.first.overlap.toastFoot.area : null)
  const areaI = area(toastI)
  const areaM = area(toastM)
  check('toast.no-overlap-footer', areaI === 0 && areaM === 0, {
    meaning: '提示条矩形 ∩ 抽屉底栏（.drawer-foot）矩形 的面积必须是 0；1440 与 390 各量一次，两次都要 0',
    area1440: areaI,
    area390: areaM,
    overlap1440: toastI && toastI.first ? toastI.first.overlap : null,
    overlap390: toastM && toastM.first ? toastM.first.overlap : null,
    toastBox1440: toastI && toastI.first && toastI.first.toast ? toastI.first.toast.box : null,
    footerBox1440: toastI && toastI.first && toastI.first.foot ? toastI.first.foot.box : null,
    toastBox390: toastM && toastM.first && toastM.first.toast ? toastM.first.toast.box : null,
    footerBox390: toastM && toastM.first && toastM.first.foot ? toastM.first.foot.box : null,
    toastBottom1440: toastI && toastI.first && toastI.first.toast ? toastI.first.toast.bottom : null,
    toastBottom390: toastM && toastM.first && toastM.first.toast ? toastM.first.toast.bottom : null,
  })

  const c1 = toastI ? toastI.click1 : null
  const c2 = toastI ? toastI.click2 : null
  // 第二次点击的落点还得是按钮；如果第一次点击就已经到达按钮（抽屉关掉、按钮随之消失），
  // 那这一条要证的事情已经发生，按达成算，并写清依据。
  const secondReached = Boolean(c2 && (c2.landedOnButton === true || (c2.skipped && c1 && c1.writes > 0)))
  check('toast.second-click-reaches-button', secondReached, {
    meaning: '提示条在场时连点两次，第二次的落点必须还是按钮；第一次点击如果已经到达按钮（按钮随之消失）也按达成算',
    secondClick: c2,
    firstClick: c1 ? { writes: c1.writes, toastInDelta: c1.toastInDelta, hit: c1.hitAfterClick, drawerOpen: c1.drawerOpen, hash: c1.hash } : null,
    toastInAtOpen: toastI ? toastI.toastCounterAtOpen : null,
  })

  const secondWrites = c2 && typeof c2.writes === 'number' ? c2.writes : 0
  check('toast.zero-write-requests', secondWrites === 0, {
    meaning: '第二次点击本身不许产生写请求（提示条不吃点击，也不能因为多按一下多建一次作品）',
    secondClickWrites: secondWrites,
    secondClickCounts: c2 ? c2.stats : null,
    firstClickWrites: c1 ? c1.writes : null,
    afterClearedWrites: toastI && toastI.click3 ? (typeof toastI.click3.writes === 'number' ? toastI.click3.writes : null) : null,
    note: c2 && c2.skipped ? c2.skipped : null,
  })

  check('promo-save.hover-changes', Boolean(promo && promo.hoverChanged && promo.hoverChanged.length > 0), {
    meaning: '后台「保存运营位」（裸 .vq-button）悬停至少要变一个属性',
    idleBackgroundColor: promo && promo.idle ? promo.idle.backgroundColor : null,
    hoverBackgroundColor: promo && promo.hover ? promo.hover.backgroundColor : null,
    idleColor: promo && promo.idle ? promo.idle.color : null,
    hoverColor: promo && promo.hover ? promo.hover.color : null,
    changed: promo ? promo.hoverChanged : null,
    hoverMatched: promo ? promo.hoverMatched : null,
    pressChanged: promo ? promo.pressChanged : null,
    error: promo && promo.error ? promo.error : null,
  })

  check('agx-card.press-changes', Boolean(agx && agx.pressChanged && agx.pressChanged.length > 0), {
    meaning: '#/agents 预设卡「选择」按下去至少要变一个属性（别的卡按下都会压暗一档）',
    idleBackgroundColor: agx && agx.idle ? agx.idle.backgroundColor : null,
    hoverBackgroundColor: agx && agx.hover ? agx.hover.backgroundColor : null,
    pressBackgroundColorImmediate: agx && agx.pressImmediate ? agx.pressImmediate.backgroundColor : null,
    pressBackgroundColorSettled: agx && agx.pressSettled ? agx.pressSettled.backgroundColor : null,
    changed: agx ? agx.pressChanged : null,
    hoverChanged: agx ? agx.hoverChanged : null,
    pressMatched: agx ? agx.pressMatched : null,
    error: agx && agx.error ? agx.error : null,
  })

  // ---- 自检：这份证据本身可不可信 ----
  await setViewport(1440, 1000)
  await goto('/overview', '.vq-next-cta')
  const bits = await evaluate('(() => { const list = Array.prototype.map.call(document.querySelectorAll("script[src]"), (n) => String(n.getAttribute("src")).split("/").pop()).filter((n) => n && n.indexOf("index-") === 0); const label = document.querySelector(".vq-version-label"); return { scripts: list, uiVersion: label ? String(label.textContent || "").trim() : null } })()')
  const apiVersion = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  proof('0.1 页面脚本来自这次指定的构建入口（' + distEntry + '）', Boolean(distEntry) && Boolean(bits) && (bits.scripts || []).indexOf(distEntry) >= 0, { loaded: bits ? bits.scripts : null, dist: distEntry })
  proof('0.2 /api/version 与这份 dist 的版本一致（v' + distPkgVersion + '）', Boolean(apiVersion) && apiVersion.version === distPkgVersion, { api: apiVersion && apiVersion.version, distVersion: distPkgVersion, sourcePackage: pkgJson.version })
  const upstream = cdp.requests.filter((row) => row.url.indexOf(BASE) !== 0 && /10100|seeapi|geteapi|redfox|api\.openai|generations|replicate/i.test(row.url))
  proof('6.1 这一轮没有打任何上游（0 次）', upstream.length === 0, { upstream: upstream.slice(0, 3) })
  proof('6.2 页面异常 0 条、console.error 0 条', cdp.exceptions.length === 0 && cdp.consoleErrors.length === 0, { exceptions: cdp.exceptions.slice(0, 3), consoleErrors: cdp.consoleErrors.slice(0, 3) })
  proof('6.3 三组都量到了（没有整组缺失）', Boolean(scene) && Boolean(promo && promo.idle) && Boolean(agx && agx.idle), { toast: Boolean(scene), promo: Boolean(promo && promo.idle), agx: Boolean(agx && agx.idle) })
} catch (error) {
  stopped = true
  proof('9.9 取证脚本自己没崩', false, { error: String((error && error.stack) || error).slice(0, 600) })
  if (serverLog) note('服务端日志尾部', serverLog.slice(-800))
}

const failed = checks.filter((item) => !item.ok)
const f1440 = toastI && toastI.first ? toastI.first : null
const f390 = toastM && toastM.first ? toastM.first : null
const out = {
  round: 'r330',
  at: new Date().toISOString(),
  dist: DIST_DIR,
  entry: distEntry,
  distVersion: distPkgVersion,
  packageVersion: pkgJson.version,
  port: API_PORT,
  dataDir: dataDir,
  outDir: OUT_DIR,
  seeded: seeded,
  overlays: overlayLog,
  toast: { d1440: toastI, d390: toastM },
  promo: promo,
  agx: agx,
  // 「先看这几行」：Lead 点名要的原始数字，别让他去嵌套结构里翻。
  headline: {
    toast: {
      hitAtButtonCenter1440: f1440 && f1440.hitAtButtonCenter ? f1440.hitAtButtonCenter.tag + '.' + (f1440.hitAtButtonCenter.cls || '') : null,
      hitAtButtonCenter390: f390 && f390.hitAtButtonCenter ? f390.hitAtButtonCenter.tag + '.' + (f390.hitAtButtonCenter.cls || '') : null,
      hitIsButton1440: f1440 ? f1440.hitInsideButton : null,
      hitIsButton390: f390 ? f390.hitInsideButton : null,
      buttonCenter1440: f1440 && f1440.btn ? { x: f1440.btn.box.cx, y: f1440.btn.box.cy } : null,
      toastBox1440: f1440 && f1440.toast ? f1440.toast.box : null,
      footerBox1440: f1440 && f1440.foot ? f1440.foot.box : null,
      intersectionArea1440: f1440 && f1440.overlap.toastFoot ? f1440.overlap.toastFoot.area : null,
      toastBox390: f390 && f390.toast ? f390.toast.box : null,
      footerBox390: f390 && f390.foot ? f390.foot.box : null,
      intersectionArea390: f390 && f390.overlap.toastFoot ? f390.overlap.toastFoot.area : null,
      toastPointerEvents: f1440 && f1440.toast ? f1440.toast.pointerEvents : null,
      toastZIndex: f1440 && f1440.toast ? f1440.toast.zIndex : null,
      toastBottom1440: f1440 && f1440.toast ? f1440.toast.bottom : null,
      toastBottom390: f390 && f390.toast ? f390.toast.bottom : null,
      toastInAfterFirstClick: toastI && toastI.click1 ? toastI.click1.toastInDelta : null,
      toastInAfterSecondClick: toastI && toastI.click2 ? toastI.click2.toastInDelta : null,
      toastInAfterThirdClick: toastI && toastI.click3 ? toastI.click3.toastInDelta : null,
      writesFirstClickWhileCovered: toastI && toastI.click1 ? toastI.click1.writes : null,
      writesSecondClick: toastI && toastI.click2 && typeof toastI.click2.writes === 'number' ? toastI.click2.writes : null,
      writesAfterToastCleared: toastI && toastI.click3 && typeof toastI.click3.writes === 'number' ? toastI.click3.writes : null,
      secondClickSkipped: toastI && toastI.click2 ? toastI.click2.skipped : null,
    },
    promo: {
      idleBackgroundColor: promo && promo.idle ? promo.idle.backgroundColor : null,
      hoverBackgroundColor: promo && promo.hover ? promo.hover.backgroundColor : null,
      hoverChangedCount: promo && promo.hoverChanged ? promo.hoverChanged.length : null,
      hoverChanged: promo ? promo.hoverChanged : null,
      pressChanged: promo ? promo.pressChanged : null,
    },
    agx: {
      idleBackgroundColor: agx && agx.idle ? agx.idle.backgroundColor : null,
      hoverBackgroundColor: agx && agx.hover ? agx.hover.backgroundColor : null,
      pressBackgroundColorImmediate: agx && agx.pressImmediate ? agx.pressImmediate.backgroundColor : null,
      pressBackgroundColorSettled: agx && agx.pressSettled ? agx.pressSettled.backgroundColor : null,
      pressChangedCount: agx && agx.pressChanged ? agx.pressChanged.length : null,
      pressChanged: agx ? agx.pressChanged : null,
    },
  },
  checks: checks,
  failed: failed.length,
  passed: checks.length - failed.length,
  selfProof: selfProof,
  selfProofFailed: selfProof.filter((item) => !item.ok).length,
  notes: notes,
  screenshots: screenshots,
  exceptions: cdp ? cdp.exceptions : [],
  consoleErrors: cdp ? cdp.consoleErrors : [],
}
fs.writeFileSync(path.join(OUT_DIR, 'r330.json'), JSON.stringify(out, null, 2))

// ---- 紧凑表格 ----
function pad(text, width) {
  const value = String(text === null || text === undefined ? '-' : text)
  let visible = 0
  for (const char of value) visible += char.charCodeAt(0) > 255 ? 2 : 1
  return value + ' '.repeat(Math.max(0, width - visible))
}
console.log('')
console.log('---- ① 提示条 vs 抽屉底栏 ----')
for (const item of [toastI, toastM]) {
  if (!item) continue
  const f = item.first
  if (!f) { console.log(pad(item.tag, 10) + '没量到：' + (item.error || '-')); continue }
  console.log(pad(item.tag, 10) + pad(item.viewport.w + 'x' + item.viewport.h, 11) +
    pad('命中 ' + (f.hitAtButtonCenter ? f.hitAtButtonCenter.tag + '.' + (f.hitAtButtonCenter.cls || '') : '-'), 34) +
    pad('toast ' + f.toast.box.w + 'x' + f.toast.box.h + ' @y' + f.toast.box.t + '-' + f.toast.box.b + ' bottom=' + f.toast.bottom, 40) +
    pad('footer @y' + f.foot.box.t + '-' + f.foot.box.b, 22) +
    pad('交集 ' + f.overlap.toastFoot.w + 'x' + f.overlap.toastFoot.h + '=' + f.overlap.toastFoot.area, 20) +
    'pointer-events=' + (f.toast ? f.toast.pointerEvents : '?'))
}
console.log('')
console.log('---- ② / ③ 两个按钮的三态 background-color ----')
for (const item of [promo, agx]) {
  if (!item) continue
  const fmt = (s) => (s ? String(s.backgroundColor) : 'null')
  const changed = item === promo ? item.hoverChanged : item.pressChanged
  console.log(pad(item.id, 12) + pad('idle ' + fmt(item.idle), 34) + pad('hover ' + fmt(item.hover), 34) + pad('press ' + fmt(item.pressSettled), 34) + (item === promo ? '悬停变 ' : '按下变 ') + (changed && changed.length ? changed.join(' | ') : '0 个属性'))
}
console.log('')
console.log('---- 六条 check ----')
for (const item of checks) {
  console.log((item.ok ? 'PASS ' : 'FAIL ') + pad(item.id, 34) + (item.detail && item.detail.meaning ? item.detail.meaning : ''))
}
console.log('')
console.log('---- 自检 ----')
for (const item of selfProof) console.log((item.ok ? 'PASS ' : 'FAIL ') + item.id)
console.log('')
console.log('---- r330 取证 · ' + out.passed + '/' + checks.length + ' 通过 · 自检 ' + (selfProof.length - out.selfProofFailed) + '/' + selfProof.length + ' · 证据 ' + path.join(path.relative(ROOT, OUT_DIR), 'r330.json') + ' ----')
console.log('after 跑法：node scripts/shot-r330.mjs --dist dist --out .shots330/after')

try { chrome.kill() } catch { /* 已经退出 */ }
try { server.kill() } catch { /* 已经退出 */ }
await sleep(400)
try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 同上 */ }
if (stopped || out.selfProofFailed > 0) process.exit(1)
process.exit(0)
