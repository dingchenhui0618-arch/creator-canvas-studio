// r331 取证：抽屉「比容器宽 6–15px」——测量假象还是真溢出
//
// 背景（Lead 的记录）：r330 在「提示条 ∩ 抽屉底栏」这条检查里量到 .drawer-foot 的右沿越过视口:
//   after（v0.9.302）：1440 视口 foot l=869 r=1448 w=579 → 右沿 +8；390 视口 l=16 r=405 w=389 → 右沿 +15
//   before（v0.9.301）：1440 r=1446 → +6；390 r=401 → +11（两次跑还差 2–4px）
// Lead 的假设：.template-drawer 的入场动画 drawer-in（App.css:410-412，translateX(24px) → none，
// 220ms ease，fill 默认 none）还没跑完就被量了；也可能是真溢出（包含块不是视口）。
//
// 这一轮只用同一颗抽屉、同一份脚本，量两套数字并二选一：
//   「动画中」= 自然首帧（MutationObserver 微任务里）+ 插入后每帧采样 + getAnimations() 定位到 currentTime=0
//   「稳态」  = 等 document.getAnimations() 的 finished 与 animationend 之后（不用固定 sleep 当判据）
// 判据：位移量是否恰好等于 computed transform 的 tx。真溢出不会有 tx，动画不会超出 24px。
//
// 骨架复用 r330（scripts/shot-r330.mjs）：临时 DATA_DIR + 真 SQLite + 临时账号 + 真 cookie、
// CDP 真输入、把 --dist 那份构建挂进 stage 目录（绝不重新构建、绝不碰生产数据与 dist）。
//
// 三条纪律（与 r329/r330 同一套）：
//   1) 0 次上游调用：VISION_BASE_URL 指到本机一个没人监听的端口；生成 / 评审 / 解析一概不点，
//      真要跳过就写「跳过：会扣费」。
//   2) 一律 CDP 真输入（Input.dispatchMouseEvent / dispatchKeyEvent），不用程序化 .click()。
//   3) 量不出来写 null 并写明原因，不猜、不把「没量到」写成通过。
//
// 用法：
//   node scripts/shot-r331-drawer.mjs
//   node scripts/shot-r331-drawer.mjs --dist .shots330/dist-after --out .shots331
//
// 产物：.shots331/drawer.json + drawer-<tag>-steady.png / drawer-<tag>-t0.png
//
// 退出码：0 = 结论 A（稳态不溢出）；2 = 结论 B（真溢出）；1 = 没量全 / 脚本自己崩。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = fs.existsSync(path.join(process.cwd(), 'server', 'index.mjs')) ? process.cwd() : path.resolve(SCRIPT_DIR, '..')
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOTS_ROOT = path.join(ROOT, '.shots331')

function argOf(name, fallback) {
  const at = process.argv.indexOf('--' + name)
  if (at > 0 && process.argv[at + 1] && process.argv[at + 1].charAt(0) !== '-') return process.argv[at + 1]
  return fallback
}

const OUT_DIR = path.resolve(ROOT, String(argOf('out', '.shots331')))
// 生产上那份（v0.9.302，入口 index-BdLqYHxS.js）。只读，绝不重新构建。
const DIST_DIR = path.resolve(ROOT, String(argOf('dist', '.shots330/dist-after')))
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

// ---- 临时实例：真 SQLite、真账号、真 cookie，只有数据目录是新的 ----
// 门窗自己一间的临时目录：.shots331 下可能有别人（Lead 的巡检脚本）同时在跑，
// 共用一个 stage / data 会互相拆台（r331 就撞过一次）。
const RUN_DIR = path.join(SHOTS_ROOT, 'run-' + process.pid)
fs.mkdirSync(RUN_DIR, { recursive: true })
const dataDir = fs.mkdtempSync(path.join(RUN_DIR, 'data-'))
const profile = fs.mkdtempSync(path.join(RUN_DIR, 'profile-'))
process.env.DATA_DIR = dataDir

const stageDir = path.join(RUN_DIR, 'stage')
fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir, { recursive: true })
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
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
console.log('r331 临时工作目录 ' + RUN_DIR)

const distHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8')
const distEntryMatch = distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
const distEntry = distEntryMatch ? distEntryMatch[1] : null

// ---- 铺数据：与 r330 同一颗模板（身份证一致，才谈得上「同一颗抽屉」）----
const AT = String.fromCharCode(64)
const PASSWORD = 'r331-probe-pass1'
const COVER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

const account = createUser({ email: 'r331probe' + AT + 'shot.test', password: PASSWORD, name: '取证员', kind: 'account' })
const token = createSession(account, {}).token

const seeded = { account: account.id, template: '', onboarding: '' }
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

console.log('r331 取证 · dist=' + DIST_DIR + ' · 入口 ' + distEntry + ' · v' + distPkgVersion + ' · 端口 ' + API_PORT + ' · 数据目录 ' + dataDir)

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
server.on('error', (error) => { console.log('SERVER-SPAWN-FAIL ' + String(error && error.message)) })

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  // 与 r330 同一套参数：没有经典滚动条，innerWidth == documentElement.clientWidth。
  '--hide-scrollbars',
  '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore' })
chrome.on('error', (error) => { console.log('CHROME-SPAWN-FAIL ' + String(error && error.message)) })

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

// 找元素：一律「选择器 + 文本相等 + 第几个」。会被 toString() 注入页面，所以每个都要自包含。
const q = (sel) => ({ sel: sel })
const nthOf = (sel, index) => ({ sel: sel, index: index })
const byText = (text, sel) => ({ sel: sel || 'button', text: text })

function findRect(F) {
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
  }
}

// =====================================================================
// 页面侧探针（全部 toString() 注入；每个都自包含，不用 eval 拼字符串）
// =====================================================================

function drawerGeom() {
  // 一颗抽屉的全景：视口 / 包含块链 / 抽屉与底栏与每个按钮的矩形 / computed transform / 动画列表。
  function box(el) {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      l: +r.left.toFixed(3), t: +r.top.toFixed(3), r: +r.right.toFixed(3), b: +r.bottom.toFixed(3),
      w: +r.width.toFixed(3), h: +r.height.toFixed(3),
    }
  }
  function cls(el) {
    return String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
  }
  function txOf(transform) {
    if (!transform || transform === 'none') return 0
    const found = String(transform).match(/matrix\(([^)]+)\)/)
    if (!found) return null
    const nums = found[1].split(',').map(Number)
    return nums.length === 6 ? +nums[4].toFixed(3) : null
  }
  function text(el) {
    return String(el.textContent || '').replace(/\s+/g, ' ').trim()
  }
  const drawer = document.querySelector('.template-drawer')
  const foot = document.querySelector('.drawer-foot')
  const backdrop = document.querySelector('.drawer-backdrop')
  const de = document.documentElement
  const se = document.scrollingElement || de
  const dcs = drawer ? getComputedStyle(drawer) : null
  const bcs = backdrop ? getComputedStyle(backdrop) : null
  const db = box(drawer)
  const fb = box(foot)
  const bb = box(backdrop)

  const buttons = foot ? Array.prototype.map.call(foot.querySelectorAll('button'), function (el) {
    const r = el.getBoundingClientRect()
    return {
      cls: cls(el), text: text(el).slice(0, 12), disabled: Boolean(el.disabled),
      box: box(el),
      rightMinusInnerWidth: +(r.right - window.innerWidth).toFixed(3),
      leftMinusZero: +r.left.toFixed(3),
      cut: r.right > window.innerWidth || r.left < 0,
    }
  }) : []

  // 包含块判断：.drawer-backdrop 的每个祖先上有 transform / filter / backdrop-filter / will-change / contain
  // 任意一项，fixed 定位的包含块就不再是视口——那才可能出现「真溢出」。
  const chain = []
  let node = backdrop ? backdrop.parentElement : null
  while (node) {
    const s = getComputedStyle(node)
    const creates = /matrix|translate|scale|rotate|perspective/.test(s.transform) ||
      (s.filter && s.filter !== 'none') ||
      (s.backdropFilter && s.backdropFilter !== 'none') ||
      (s.willChange && /transform|filter|perspective/.test(s.willChange)) ||
      (s.contain && /paint|layout|strict|content/.test(s.contain))
    chain.push({
      tag: node.tagName, cls: cls(node), position: s.position,
      transform: s.transform, filter: s.filter, backdropFilter: s.backdropFilter,
      willChange: s.willChange, contain: s.contain, overflowX: s.overflowX, overflowY: s.overflowY,
      box: box(node), createsContainingBlock: Boolean(creates),
    })
    node = node.parentElement
  }

  const anims = drawer ? drawer.getAnimations().map(function (a) {
    const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : null
    return {
      name: a.animationName || null, playState: a.playState,
      currentTime: a.currentTime, startTime: a.startTime,
      duration: timing ? timing.duration : null, fill: timing ? timing.fill : null, easing: timing ? timing.easing : null,
    }
  }) : []

  const toast = document.querySelector('.vq-toast')
  return {
    t: Math.round(performance.now()),
    viewport: {
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      docClientWidth: de.clientWidth, docClientHeight: de.clientHeight,
      scrollWidth: se.scrollWidth, scrollHeight: se.scrollHeight,
      hOverflow: se.scrollWidth > de.clientWidth,
      scrollbar: de.clientWidth - window.innerWidth,
      scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY),
      dpr: window.devicePixelRatio,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    },
    backdrop: backdrop ? {
      cls: cls(backdrop), box: bb,
      position: bcs.position, inset: bcs.top + '/' + bcs.right + '/' + bcs.bottom + '/' + bcs.left,
      width: bcs.width, transform: bcs.transform,
      backdropFilter: bcs.backdropFilter, filter: bcs.filter, overflowX: bcs.overflowX,
      rightMinusInnerWidth: +(bb.r - window.innerWidth).toFixed(3),
      backdropWidthMinusInnerWidth: +(bb.w - window.innerWidth).toFixed(3),
    } : null,
    drawer: drawer ? {
      cls: cls(drawer), box: db,
      parent: drawer.parentElement ? drawer.parentElement.tagName + '.' + cls(drawer.parentElement) : null,
      position: dcs.position, width: dcs.width, height: dcs.height,
      right: dcs.right, borderLeftWidth: dcs.borderLeftWidth, padding: dcs.padding,
      boxSizing: dcs.boxSizing, margin: dcs.margin,
      offsetWidth: drawer.offsetWidth, clientWidth: drawer.clientWidth,
      transform: dcs.transform, tx: txOf(dcs.transform), opacity: dcs.opacity,
      animationName: dcs.animationName, animationDuration: dcs.animationDuration,
      animationFillMode: dcs.animationFillMode, animationTimingFunction: dcs.animationTimingFunction,
      transitionProperty: dcs.transitionProperty, willChange: dcs.willChange,
      rightMinusInnerWidth: +(db.r - window.innerWidth).toFixed(3),
      leftMinusViewportLeft: +(db.l - 0).toFixed(3),
      animations: anims,
    } : null,
    foot: foot ? {
      cls: cls(foot), box: fb,
      display: getComputedStyle(foot).display, gridTemplateColumns: getComputedStyle(foot).gridTemplateColumns,
      flexWrap: getComputedStyle(foot).flexWrap, padding: getComputedStyle(foot).padding,
      margin: getComputedStyle(foot).margin, width: getComputedStyle(foot).width,
      boxSizing: getComputedStyle(foot).boxSizing, transform: getComputedStyle(foot).transform,
      offsetWidth: foot.offsetWidth, clientWidth: foot.clientWidth, scrollWidth: foot.scrollWidth,
      rightMinusInnerWidth: +(fb.r - window.innerWidth).toFixed(3),
      buttons: buttons,
    } : null,
    ancestors: chain,
    chainCreatesContainingBlock: chain.some(function (row) { return row.createsContainingBlock }),
    toast: toast ? { present: true, box: box(toast) } : { present: false },
    drawerCount: document.querySelectorAll('.template-drawer').length,
    backdropCount: document.querySelectorAll('.drawer-backdrop').length,
  }
}

function shortGeom() {
  // 稳态抖动检查用的轻量读数（只读矩形与 transform，不碰祖先链）。
  function box(el) {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: +r.left.toFixed(3), t: +r.top.toFixed(3), r: +r.right.toFixed(3), b: +r.bottom.toFixed(3), w: +r.width.toFixed(3), h: +r.height.toFixed(3) }
  }
  const drawer = document.querySelector('.template-drawer')
  const foot = document.querySelector('.drawer-foot')
  const se = document.scrollingElement || document.documentElement
  const cs = drawer ? getComputedStyle(drawer) : null
  return {
    t: Math.round(performance.now()),
    innerWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: se.scrollWidth,
    backdrop: box(document.querySelector('.drawer-backdrop')),
    drawer: box(drawer), foot: box(foot),
    transform: cs ? cs.transform : null, opacity: cs ? cs.opacity : null,
    anims: drawer ? drawer.getAnimations().map(function (a) { return String(a.animationName || '') + '|' + a.playState + '|ct=' + (a.currentTime === null ? 'null' : Math.round(Number(a.currentTime))) }) : [],
  }
}

function installWatcher() {
  // 「插入后的每一帧」从文档第一帧就开始记：MutationObserver 拿到第一颗 .template-drawer，
  // 在同一个微任务里读一次（这一读会触发样式解析 → 动画被创建），之后每帧读一次到 900ms。
  // 注意：addScriptToEvaluateOnNewDocument 跑在 document-start，这时 documentElement 还没有，
  // 所以观察 document 本身，不能观察 documentElement（r331 第一趟就栽在这里）。
  if (!window.__r331) window.__r331 = {}
  const st = window.__r331
  st.frames = []
  st.events = []
  st.animAtFirst = null
  st.animCaptured = null
  st.anim = null
  st.finish = null
  st.watched = 0
  st.armed = false
  st.insertAt = null
  if (st.installed) return true
  st.installed = true
  function txOf(transform) {
    if (!transform || transform === 'none') return 0
    const found = String(transform).match(/matrix\(([^)]+)\)/)
    if (!found) return null
    const nums = found[1].split(',').map(Number)
    return nums.length === 6 ? +nums[4].toFixed(3) : null
  }
  function compact(label) {
    let g = null
    try { g = window.__r331geom ? window.__r331geom() : null } catch (error) { return { label: label, error: String(error && error.message) } }
    if (!g) return { label: label, error: 'no-geom' }
    const drawerTransform = g.drawer ? g.drawer.transform : null
    return {
      label: label, t: g.t,
      innerWidth: g.viewport.innerWidth, scrollWidth: g.viewport.scrollWidth,
      backdropRight: g.backdrop ? g.backdrop.box.r : null,
      drawerRight: g.drawer ? g.drawer.box.r : null,
      footRight: g.foot ? g.foot.box.r : null,
      transform: drawerTransform, tx: txOf(drawerTransform),
      opacity: g.drawer ? g.drawer.opacity : null,
      footButtons: g.foot ? g.foot.buttons.length : null,
      anims: (g.drawer ? g.drawer.animations : []).map(function (a) {
        return String(a.name || '') + '|' + a.playState + '|ct=' + (a.currentTime === null ? 'null' : Math.round(Number(a.currentTime)))
      }),
    }
  }
  function captureAnim(why) {
    // 动画跑完之后 Element.getAnimations() 就会变空（fill:none 的动画不再是 relevant），
    // 所以「动画中」那一刻要顺手把 Animation 句柄留下来，后面才能定位到 currentTime。
    const drawer = document.querySelector('.template-drawer')
    if (!drawer) return null
    const live = drawer.getAnimations()
    if (!live.length) return null
    st.anim = live
    st.animCaptured = {
      why: why,
      atMsFromInsert: st.insertAt === null ? null : Math.round(performance.now() - st.insertAt),
      rows: live.map(function (a) {
        const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : null
        return {
          name: a.animationName || null, playState: a.playState, currentTime: a.currentTime, startTime: a.startTime,
          duration: timing ? timing.duration : null, fill: timing ? timing.fill : null, easing: timing ? timing.easing : null,
        }
      }),
    }
    return st.animCaptured
  }
  const observer = new MutationObserver(function () {
    if (!st.armed || st.watched > 0) return
    const drawer = document.querySelector('.template-drawer')
    if (!drawer) return
    st.watched = 1
    const first = compact('mutation-first')
    st.insertAt = first.t
    st.frames.push(first)
    st.animAtFirst = captureAnim('mutation-first')
    const started = performance.now()
    function tick() {
      st.frames.push(compact('raf'))
      if (!st.anim) captureAnim('raf-' + st.frames.length)
      if (st.frames.length < 90 && performance.now() - started < 900) requestAnimationFrame(tick)
      else st.loopDoneAt = Math.round(performance.now())
    }
    requestAnimationFrame(tick)
    drawer.getAnimations().forEach(function (a) {
      a.finished.then(function () {
        st.finish = { name: a.animationName || null, at: Math.round(performance.now()), fromInsertMs: st.insertAt === null ? null : Math.round(performance.now() - st.insertAt) }
      }, function () {
        st.finish = { name: a.animationName || null, at: Math.round(performance.now()), canceled: true }
      })
    })
  })
  observer.observe(document, { childList: true, subtree: true })
  document.addEventListener('animationstart', function (event) {
    st.events.push({ type: 'start', name: event.animationName, target: String((event.target && event.target.getAttribute && event.target.getAttribute('class')) || '').slice(0, 40), at: Math.round(performance.now()) })
  }, true)
  document.addEventListener('animationend', function (event) {
    st.events.push({ type: 'end', name: event.animationName, target: String((event.target && event.target.getAttribute && event.target.getAttribute('class')) || '').slice(0, 40), at: Math.round(performance.now()) })
  }, true)
  return true
}

function readWatch() {
  const st = window.__r331 || {}
  const rows = st.frames || []
  const trimmed = rows.slice(0, 60).map(function (r) {
    const out = {}
    for (const key in r) out[key] = r[key]
    return out
  })
  return {
    armed: Boolean(st.armed), watched: st.watched || 0,
    animAtFirst: st.animAtFirst || null, animCaptured: st.animCaptured || null, insertAt: st.insertAt || null,
    finish: st.finish || null, loopDoneAt: st.loopDoneAt || null,
    events: (st.events || []).slice(0, 14),
    frameCount: rows.length,
    frames: trimmed,
  }
}

function seekAnim(t) {
  // 把入场动画钉在某一刻再量：用 getAnimations() 定位，而不是靠 sleep 撞运气。
  // 动画跑完之后 Element.getAnimations() 会变空（fill:none 的动画不再是 relevant），
  // 这时退回第一帧抓下来的 Animation 句柄——它是同一个动画对象，改 currentTime 仍然生效。
  const drawer = document.querySelector('.template-drawer')
  if (!drawer) return { error: 'no-drawer', set: t }
  const live = drawer.getAnimations()
  const list = live.length ? live : ((window.__r331 && window.__r331.anim) || [])
  const source = live.length ? 'live' : 'captured-handle'
  if (!list.length) return { error: 'no-animation', set: t, note: '抽屉上 getAnimations() 是空的，第一帧也没抓到句柄' }
  function box(el) {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: +r.left.toFixed(3), r: +r.right.toFixed(3), w: +r.width.toFixed(3) }
  }
  function txOf(transform) {
    if (!transform || transform === 'none') return 0
    const found = String(transform).match(/matrix\(([^)]+)\)/)
    if (!found) return null
    const nums = found[1].split(',').map(Number)
    return nums.length === 6 ? +nums[4].toFixed(3) : null
  }
  list.forEach(function (a) {
    const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : null
    const end = timing ? Number(timing.duration) : 0
    a.pause()
    a.currentTime = t === null ? end : t
  })
  const cs = getComputedStyle(drawer)
  const db = box(drawer)
  const fb = box(document.querySelector('.drawer-foot'))
  const bb = box(document.querySelector('.drawer-backdrop'))
  return {
    set: t === null ? 'end' : t, source: source,
    innerWidth: window.innerWidth, scrollWidth: (document.scrollingElement || document.documentElement).scrollWidth,
    backdrop: bb, drawer: db, foot: fb,
    transform: cs.transform, tx: txOf(cs.transform), opacity: cs.opacity,
    playStates: list.map(function (a) {
      return { name: a.animationName || null, playState: a.playState, currentTime: a.currentTime, duration: a.effect && a.effect.getTiming ? a.effect.getTiming().duration : null }
    }),
  }
}

function inlineProbe(px) {
  // 等价平移的对照组：把同一根 transform: translateX(px) 直接写在抽屉上量一次，
  // 证明「右沿位移 = translateX」，跟宽度 / 包含块 / 滚动条都无关。量完立刻清掉内联样式。
  // 注意：真实动画还在 active 阶段时，CSS 动画的声明优先级高于内联样式，所以这一步要在动画结束后做。
  const drawer = document.querySelector('.template-drawer')
  if (!drawer) return { error: 'no-drawer', px: px }
  function box(el) {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: +r.left.toFixed(3), r: +r.right.toFixed(3), w: +r.width.toFixed(3) }
  }
  function txOf(transform) {
    if (!transform || transform === 'none') return 0
    const found = String(transform).match(/matrix\(([^)]+)\)/)
    if (!found) return null
    const nums = found[1].split(',').map(Number)
    return nums.length === 6 ? +nums[4].toFixed(3) : null
  }
  const animsBefore = drawer.getAnimations().map(function (a) { return String(a.animationName || '') + '|' + a.playState })
  drawer.style.transform = px === 0 ? '' : 'translateX(' + px + 'px)'
  const cs = getComputedStyle(drawer)
  const row = {
    px: px, transform: cs.transform, tx: txOf(cs.transform), opacity: cs.opacity,
    drawer: box(drawer), foot: box(document.querySelector('.drawer-foot')),
    backdrop: box(document.querySelector('.drawer-backdrop')),
    innerWidth: window.innerWidth,
    scrollWidth: (document.scrollingElement || document.documentElement).scrollWidth,
    animsBefore: animsBefore,
  }
  drawer.style.transform = ''
  row.clearedTo = getComputedStyle(drawer).transform
  row.clearedRight = box(drawer).r
  return row
}

function installPathHelper() {
  window.__r331path = function (el) {
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth += 1) {
      let piece = node.tagName.toLowerCase()
      const cls = String(node.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      if (cls) piece += '.' + cls
      parts.unshift(piece)
      node = node.parentElement
    }
    return parts.join(' > ')
  }
  return true
}

function pageTextSlice(limit) {
  return String(document.body.innerText || '').replace(/\s+/g, ' ').slice(0, limit)
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
  return BASE + '/?n=' + navNonce + '#' + route
}
async function switchAccountCookie() {
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })
}
let lastAnchor = { anchor: '', found: true, text: '' }
async function goto(route, anchor) {
  await switchAccountCookie()
  await cdp.send('Page.navigate', { url: routeUrl(route) })
  await sleep(650)
  let shell = false
  for (let attempt = 0; attempt < 3 && !shell; attempt += 1) {
    shell = Boolean(await waitForExpr('Boolean(document.querySelector(".vq-content"))', '工作台外壳', 18, 250).catch(() => false))
    if (!shell) {
      console.log('SHELL-RETRY ' + route + ' attempt=' + (attempt + 1) + ' readyState=' + String(await evaluate('document.readyState').catch(() => '?')))
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
    anchor: anchor, found: found,
    text: found ? '' : String(await evaluate('(' + pageTextSlice.toString() + ')(400)')),
  }
  if (!found) console.log('ANCHOR-MISS ' + anchor + ' :: ' + lastAnchor.text.slice(0, 160))
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
  // r330 走完这一步是为了让账号变成「引导做完、没有资产」→ 每次进页面弹一条提示条；
  // 这一轮照样走完，好让 r330Style 那次测量的时序与 r330 一致（不多不少等一条提示条）。
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
function requestStats(since) {
  const rows = cdp.requests.slice(since).map((row) => ({ method: row.method, path: pathOf(row.url) }))
  const writes = rows.filter((row) => WRITE_METHODS.has(row.method) && row.path.indexOf('/api/') === 0)
  const counts = {}
  for (const row of writes) counts[row.method + ' ' + row.path] = (counts[row.method + ' ' + row.path] || 0) + 1
  return { writes: writes.length, counts: counts, apiCalls: rows.filter((row) => row.path.indexOf('/api/') === 0).length }
}

// 二分：为「r330 量到的那个位移」找出入场动画里的那一毫秒。
// 位移随 currentTime 单调下降（tx: 24 → 0），所以二分是稳的；这一步不靠采样运气。
async function findShiftTime(target, duration, steadyDrawerRight, steadyFootRight) {
  const probe = async (at) => {
    const row = await evaluate('(' + seekAnim.toString() + ')(' + at + ')')
    if (!row || row.error) return { at: at, error: row ? row.error : 'no-result' }
    return {
      at: at, tx: row.tx, opacity: row.opacity,
      drawerShift: typeof steadyDrawerRight === 'number' && row.drawer ? +(row.drawer.r - steadyDrawerRight).toFixed(3) : null,
      footShift: typeof steadyFootRight === 'number' && row.foot ? +(row.foot.r - steadyFootRight).toFixed(3) : null,
      drawerRight: row.drawer ? row.drawer.r : null, footRight: row.foot ? row.foot.r : null,
      backdropRight: row.backdrop ? row.backdrop.r : null, innerWidth: row.innerWidth,
    }
  }
  let lo = 0
  let hi = duration
  let best = null
  for (let i = 0; i < 12; i += 1) {
    const mid = (lo + hi) / 2
    const row = await probe(mid)
    if (row.error || row.drawerShift === null) return { target: target, ok: false, error: row.error || 'no-shift', probes: best }
    if (!best || Math.abs(row.drawerShift - target) < Math.abs(best.drawerShift - target)) best = row
    if (Math.abs(row.drawerShift - target) <= 0.25) { best = row; break }
    if (row.drawerShift > target) lo = mid
    else hi = mid
  }
  const ok = Boolean(best && best.drawerShift !== null && Math.abs(best.drawerShift - target) <= 0.5 &&
    typeof best.tx === 'number' && Math.abs(best.tx - target) <= 0.5 &&
    Number(best.opacity) > 0.5 && Number(best.opacity) < 1 &&
    (best.footShift === null || Math.abs(best.footShift - target) <= 0.5))
  return { target: target, ok: ok, foundAtMs: best ? +best.at.toFixed(2) : null, found: best, duration: duration }
}

// =====================================================================
// 一场抽屉：r330 时序的一次测量 + 自然时间线 + 稳态 + 定位式三档
// =====================================================================
async function drawerScene(width, height, tag) {
  const entry = {
    tag: tag, viewport: { w: width, h: height },
    selectors: { drawer: '.template-drawer', foot: '.drawer-foot', backdrop: '.drawer-backdrop', card: '.template-card' },
    attempts: [],
  }
  await setViewport(width, height)
  for (let attempt = 1; attempt <= 3 && !entry.done; attempt += 1) {
    const a = { attempt: attempt }
    entry.attempts.push(a)
    try {
      await goto('/templates', '.template-card')
      await dismissOverlays()
      a.toastAtLoad = await evaluate('Boolean(document.querySelector(".vq-toast"))')
      // 记录器只对「这一次插入」负责
      await evaluate('(function(){var s=window.__r331||{};s.frames=[];s.events=[];s.animAtFirst=null;s.finish=null;s.watched=0;s.armed=true;window.__r331=s;return true})()')
      const card = await clickFr(nthOf('.template-card', 0), 70)
      if (!card) throw new Error('模板库一张卡都没有（templates.json 没铺上？）')
      a.cardClick = { cx: card.cx, cy: card.cy }
      a.drawerAppeared = await waitForExpr('Boolean(document.querySelector(".template-drawer"))', '模板详情抽屉', 20, 120).then(() => true).catch(() => false)
      // 抽屉出现后立刻量一次（一个往返）：这是「动画中」最小成本的复现点
      a.probeFast = await evaluate('(' + drawerGeom.toString() + ')()')
      // 与 r330 同一套时序：再等一条提示条，然后立刻量（r330 就是在这之后量的底栏）
      a.toastSeen = await waitForExpr('Boolean(document.querySelector(".vq-toast"))', '提示条', 12, 120).then(() => true).catch(() => false)
      a.r330Style = await evaluate('(' + drawerGeom.toString() + ')()')
      if (!a.r330Style || !a.r330Style.foot) a.note = '这一次 r330Style 时底栏还没渲染出来（detail 没回来），继续量稳态'
      // 底栏是 detail 回来之后才渲染的：先等它挂上，稳态那一组才有底栏与按钮可量
      a.footWait = await waitForExpr('Boolean(document.querySelector(".drawer-foot"))', '抽屉底栏', 25, 120).then(() => true).catch(() => false)

      // —— 稳态：等 getAnimations() 的 finished + animationend，再等两帧（不是 sleep 当判据）——
      const settle = await evaluate('(function(){var d=document.querySelector(".template-drawer");if(!d)return{error:"no-drawer"};var st0=window.__r331||{};var list=(st0.anim&&st0.anim.length)?st0.anim:d.getAnimations();return Promise.all(list.map(function(x){return x.finished.then(function(){return "finished"},function(e){return "rejected:"+String((e&&e.name)||e)})})).then(function(states){return new Promise(function(done){requestAnimationFrame(function(){requestAnimationFrame(function(){var st=window.__r331||{};done({states:states,count:list.length,playStates:list.map(function(x){return x.playState}),endEvents:(st.events||[]).filter(function(e){return e.type==="end"}).length,startEvents:(st.events||[]).filter(function(e){return e.type==="start"}).length})})})})})})()')
      a.settle = settle
      a.steady = await evaluate('(' + drawerGeom.toString() + ')()')

      const repeats = []
      for (let i = 0; i < 6; i += 1) {
        repeats.push(await evaluate('(' + shortGeom.toString() + ')()'))
        if (i < 5) await sleep(140)
      }
      a.steadyRepeat = repeats
      a.recorder = await evaluate('(' + readWatch.toString() + ')()')

      a.sanitized = await evaluate('(' + sanitizeVisibleText.toString() + ')()')
      a.steadyShot = await shot('drawer-' + tag + '-steady.png')

      // —— 定位式 A：把入场动画钉在 currentTime=0 / 一半 / 末尾（真动画，不是伪造 transform）——
      a.seek0 = await evaluate('(' + seekAnim.toString() + ')(0)')
      a.seek0Shot = await shot('drawer-' + tag + '-t0.png')
      a.seekMid = await evaluate('(' + seekAnim.toString() + ')(110)')
      a.seekEnd = await evaluate('(' + seekAnim.toString() + ')(null)')
      a.afterSeek = await evaluate('(' + drawerGeom.toString() + ')()')
      // 二分：为 r330 的 +6/+8/+11/+15 找出入场动画里的那一毫秒（确定性，不靠帧采样运气）
      const duration = (a.seek0 && a.seek0.playStates && a.seek0.playStates[0] && Number(a.seek0.playStates[0].duration)) || 220
      a.curveSearchAnim = []
      for (const target of [24, 15, 11, 8, 6]) {
        a.curveSearchAnim.push(await findShiftTime(target, duration, a.steady.drawer.box.r, a.steady.foot ? a.steady.foot.box.r : null))
      }
      // 二分把动画停在半途了：先把它放回末尾，否则 CSS 动画的声明会盖过内联 transform（对照组会假红）
      a.seekAfterCurve = await evaluate('(' + seekAnim.toString() + ')(null)')
      // —— 定位式 B：把同一根 translateX 直接写在抽屉上（对照：位移是纯平移，与布局无关）——
      a.curveSearchInline = []
      for (const px of [24, 15, 11, 8, 6]) {
        const row = await evaluate('(' + inlineProbe.toString() + ')(' + px + ')')
        const drawerShift = row && row.drawer ? +(row.drawer.r - a.steady.drawer.box.r).toFixed(3) : null
        const footShift = row && row.foot && a.steady.foot ? +(row.foot.r - a.steady.foot.box.r).toFixed(3) : null
        const backdropShift = row && row.backdrop && a.steady.backdrop ? +(row.backdrop.r - a.steady.backdrop.box.r).toFixed(3) : null
        a.curveSearchInline.push({
          px: px,
          ok: Boolean(row && !row.error && drawerShift !== null && Math.abs(drawerShift - px) <= 0.5 &&
            typeof row.tx === 'number' && Math.abs(row.tx - px) <= 0.5 &&
            (footShift === null || Math.abs(footShift - px) <= 0.5) &&
            (backdropShift === null || Math.abs(backdropShift) <= 0.5) &&
            row.scrollWidth === a.steady.viewport.scrollWidth),
          drawerShift: drawerShift, footShift: footShift, backdropShift: backdropShift,
          transform: row ? row.transform : null, tx: row ? row.tx : null,
          scrollWidth: row ? row.scrollWidth : null, clearedTo: row ? row.clearedTo : null, animsBefore: row ? row.animsBefore : null,
        })
      }
      a.afterInline = await evaluate('(' + inlineProbe.toString() + ')(0)')
      entry.done = true
    } catch (error) {
      a.error = String((error && error.stack) || error).slice(0, 400)
    }
  }
  return entry
}

// =====================================================================
// 跑起来
// =====================================================================
const screenshots = []
let s1440 = null
let s390 = null
let started = false

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
  // 抽屉时间线从文档第一帧就要能记录：必须在第一次导航之前装上。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__r331geom = ' + drawerGeom.toString() + ';' + '(' + installWatcher.toString() + ')();' + '(' + installPathHelper.toString() + ')();',
  })

  // 开场：走完身份引导（真点），之后每次进页面才会弹那条提示条——r330Style 那次测量等的就是它。
  await goto('/overview', '.vq-next-cta')
  await sleep(700)
  await dismissOverlays()
  if (overlayLog.length) note('开场遮罩：真点关掉了', overlayLog)
  else note('开场遮罩：这一轮没有出现需要关的遮罩')
  const doneState = await fetch(BASE + '/api/onboarding', { headers: { cookie: cfg.auth.cookieName + '=' + token } }).then((r) => r.json()).catch(() => null)
  seeded.onboarding = doneState ? JSON.stringify(doneState).slice(0, 180) : '（读不到 /api/onboarding）'
  note('铺好的引导状态（决定提示条会不会弹）', doneState)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1');localStorage.setItem('vq.edition','user')}catch(e){}",
  })
  started = true

  console.log('---- ① 1440x1000')
  s1440 = await drawerScene(1440, 1000, 'd1440')
  if (s1440 && s1440.done) screenshots.push(s1440.attempts[s1440.attempts.length - 1].steadyShot, s1440.attempts[s1440.attempts.length - 1].seek0Shot)
  console.log('---- ② 390x844')
  s390 = await drawerScene(390, 844, 'd390')
  if (s390 && s390.done) screenshots.push(s390.attempts[s390.attempts.length - 1].steadyShot, s390.attempts[s390.attempts.length - 1].seek0Shot)
  note('两把尺子：「动画第 N ms」是入场动画自己的 220ms 时钟（Chrome 在第一帧才解析 startTime，主线程忙时它还会停），「插入后第 N ms」是 DOM 插入时间；两边都写进 JSON 了（scene.recorderTiming + 逐帧 frames 的 t/tx）')
  const toastSeen = [s1440, s390].some((scene) => scene && scene.attempts && scene.attempts.some((att) => att.toastSeen))
  note(toastSeen
    ? '两屏都等到了提示条，「r330 序」那次探针的时序与 r330 一致（抽屉 → 等提示条 → 立刻量）'
    : '这一轮的账号不是「引导做完且没有资产」，所以没弹提示条：「r330 序」那次探针实际等满 1.44s（落点已在动画结束之后，tx=0）；「动画中」的证据由逐帧时间线 + getAnimations() 二分给出，不依赖运气')
} catch (error) {
  note('主流程中途断了（下面 9.9 会记一笔）', String((error && error.stack) || error).slice(0, 600))
  if (serverLog) note('服务端日志尾部', serverLog.slice(-800))
}

// =====================================================================
// 算账：位移 vs transform tx，稳态 vs 动画中
// =====================================================================
function lastAttempt(scene) {
  if (!scene || !scene.attempts || !scene.attempts.length) return null
  const done = scene.attempts.filter((a) => a.steady)
  return done.length ? done[done.length - 1] : scene.attempts[scene.attempts.length - 1]
}
function num(value) { return typeof value === 'number' && isFinite(value) ? value : null }

function analyse(scene) {
  const a = lastAttempt(scene)
  const steady = a && a.steady ? a.steady : null
  const rows = (a && a.recorder && a.recorder.frames) || []
  const steadyRight = steady && steady.drawer ? steady.drawer.box.r : null
  const steadyFootRight = steady && steady.foot ? steady.foot.box.r : null
  const innerWidth = steady && steady.viewport ? steady.viewport.innerWidth : null
  const mapped = rows.map(function (row) {
    const shift = steadyRight !== null && typeof row.drawerRight === 'number' ? +(row.drawerRight - steadyRight).toFixed(3) : null
    const footShift = steadyFootRight !== null && typeof row.footRight === 'number' ? +(row.footRight - steadyFootRight).toFixed(3) : null
    return {
      label: row.label, t: row.t, tx: num(row.tx), shift: shift, footShift: footShift,
      residualShiftMinusTx: shift !== null && typeof row.tx === 'number' ? +(shift - row.tx).toFixed(3) : null,
      residualFootMinusTx: footShift !== null && typeof row.tx === 'number' ? +(footShift - row.tx).toFixed(3) : null,
      opacity: row.opacity, backdropRight: row.backdropRight,
      drawerRight: row.drawerRight, footRight: row.footRight, footButtons: row.footButtons,
      anims: row.anims,
    }
  })
  const moving = mapped.filter((row) => typeof row.tx === 'number' && Math.abs(row.tx) >= 0.5)
  const residuals = moving.map((row) => Math.abs(row.residualShiftMinusTx === null ? 999 : row.residualShiftMinusTx))
  const footResiduals = moving.filter((row) => row.footShift !== null).map((row) => Math.abs(row.residualFootMinusTx === null ? 999 : row.residualFootMinusTx))
  const shifts = mapped.filter((row) => typeof row.shift === 'number').map((row) => row.shift)
  const backdropOffsets = mapped.filter((row) => typeof row.backdropRight === 'number' && innerWidth !== null).map((row) => +(row.backdropRight - innerWidth).toFixed(3))

  // 「r330 量到的那个数字，在这一根曲线上哪一帧」：找最接近的帧
  function nearest(target) {
    let best = null
    for (const row of mapped) {
      if (typeof row.shift !== 'number') continue
      const diff = Math.abs(row.shift - target)
      if (!best || diff < best.diff) best = { target: target, shift: row.shift, diff: +diff.toFixed(2), t: row.t, tx: row.tx, opacity: row.opacity, label: row.label, anims: row.anims }
    }
    return best
  }

  const seek0 = a ? a.seek0 : null
  const seekMid = a ? a.seekMid : null
  const seekEnd = a ? a.seekEnd : null
  const afterSeek = a ? a.afterSeek : null
  return {
    tag: scene.tag,
    viewport: scene.viewport,
    measured: Boolean(steady && steady.drawer),
    reason: steady ? null : (a && (a.error || a.note)) || '稳态没量到',
    viewportMetrics: steady ? steady.viewport : null,
    backdropAncestors: steady ? steady.ancestors : null,
    chainCreatesContainingBlock: steady ? steady.chainCreatesContainingBlock : null,
    settle: a ? a.settle : null,
    animationsAtFirstFrame: a && a.recorder ? (a.recorder.animAtFirst && a.recorder.animAtFirst.length ? a.recorder.animAtFirst : (a.recorder.animCaptured ? a.recorder.animCaptured.rows : null)) : null,
    animationCapture: a && a.recorder ? a.recorder.animCaptured : null,
    animationFinishSignal: a && a.recorder ? a.recorder.finish : null,
    animationEvents: a && a.recorder ? a.recorder.events : null,
    r330Style: a ? {
      at: a.r330Style ? a.r330Style.t : null,
      // r330 那次测量发生在「抽屉插进去之后多少毫秒」——时间线里第 0 帧的 t
      offsetFromInsertMs: a.r330Style && a.recorder && a.recorder.frames && a.recorder.frames.length ? +(a.r330Style.t - a.recorder.frames[0].t).toFixed(1) : null,
      footAppearedByMs: a.recorder && a.recorder.frames ? (function () {
        const hit = a.recorder.frames.find((row) => row.footButtons !== null && row.footButtons !== undefined)
        return hit ? hit.t - a.recorder.frames[0].t : null
      })() : null,
      innerWidth: a.r330Style && a.r330Style.viewport ? a.r330Style.viewport.innerWidth : null,
      drawer: a.r330Style && a.r330Style.drawer ? { box: a.r330Style.drawer.box, transform: a.r330Style.drawer.transform, tx: a.r330Style.drawer.tx, opacity: a.r330Style.drawer.opacity, animations: a.r330Style.drawer.animations } : null,
      foot: a.r330Style && a.r330Style.foot ? { box: a.r330Style.foot.box, rightMinusInnerWidth: a.r330Style.foot.rightMinusInnerWidth, transform: a.r330Style.foot.transform } : null,
      backdrop: a.r330Style && a.r330Style.backdrop ? a.r330Style.backdrop.box : null,
      note: a.r330Style && !a.r330Style.foot ? '底栏还没渲染' : null,
    } : null,
    probeFast: a && a.probeFast ? {
      at: a.probeFast.t,
      offsetFromInsertMs: a.recorder && a.recorder.insertAt ? +(a.probeFast.t - a.recorder.insertAt).toFixed(1) : null,
      drawer: a.probeFast.drawer ? { right: a.probeFast.drawer.box.r, tx: a.probeFast.drawer.tx, transform: a.probeFast.drawer.transform, opacity: a.probeFast.drawer.opacity, animations: a.probeFast.drawer.animations } : null,
      foot: a.probeFast.foot ? { right: a.probeFast.foot.box.r, buttons: a.probeFast.foot.buttons.length } : null,
    } : null,
    toastSeen: a ? a.toastSeen : null,
    recorderTiming: (function () {
      if (!a || !a.recorder) return null
      const rows = a.recorder.frames || []
      const insertAt = a.recorder.insertAt
      const footRow = rows.find((row) => row.footButtons !== null && row.footButtons !== undefined)
      const events = a.recorder.events || []
      const isDrawer = (row) => String(row.target || '').indexOf('template-drawer') >= 0
      const startRow = events.find((row) => row.type === 'start' && isDrawer(row))
      const endRow = events.find((row) => row.type === 'end' && isDrawer(row))
      return {
        insertAt: insertAt, frameCount: rows.length,
        footAppearedByMs: footRow && insertAt ? +(footRow.t - insertAt).toFixed(1) : null,
        animationStartLagMs: startRow && insertAt ? +(startRow.at - insertAt).toFixed(1) : null,
        animationEndedAtMs: endRow && insertAt ? +(endRow.at - insertAt).toFixed(1) : null,
        animCapturedAtMs: a.recorder.animCaptured ? a.recorder.animCaptured.atMsFromInsert : null,
        loopDoneAt: a.recorder.loopDoneAt || null,
      }
    })(),
    steady: steady ? {
      at: steady.t,
      innerWidth: steady.viewport.innerWidth,
      docClientWidth: steady.viewport.docClientWidth,
      scrollWidth: steady.viewport.scrollWidth,
      scrollbar: steady.viewport.scrollbar,
      hOverflow: steady.viewport.hOverflow,
      drawer: { box: steady.drawer.box, transform: steady.drawer.transform, tx: steady.drawer.tx, opacity: steady.drawer.opacity, width: steady.drawer.width, borderLeftWidth: steady.drawer.borderLeftWidth, boxSizing: steady.drawer.boxSizing, rightMinusInnerWidth: steady.drawer.rightMinusInnerWidth, animationName: steady.drawer.animationName, animations: steady.drawer.animations },
      foot: steady.foot ? { box: steady.foot.box, rightMinusInnerWidth: steady.foot.rightMinusInnerWidth, display: steady.foot.display, padding: steady.foot.padding, transform: steady.foot.transform, buttons: steady.foot.buttons } : null,
      backdrop: steady.backdrop,
      toast: steady.toast,
    } : null,
    steadyRepeat: a && a.steadyRepeat ? a.steadyRepeat.map((row) => ({ t: row.t, innerWidth: row.innerWidth, clientWidth: row.clientWidth, scrollWidth: row.scrollWidth, drawerRight: row.drawer ? row.drawer.r : null, footRight: row.foot ? row.foot.r : null, backdropRight: row.backdrop ? row.backdrop.r : null, transform: row.transform, anims: row.anims })) : null,
    timeline: mapped,
    timelineShape: {
      frameCount: mapped.length,
      framesWithMotion: moving.length,
      shiftMin: shifts.length ? Math.min.apply(null, shifts) : null,
      shiftMax: shifts.length ? Math.max.apply(null, shifts) : null,
      maxAbsResidualShiftMinusTx: residuals.length ? +Math.max.apply(null, residuals).toFixed(3) : null,
      maxAbsResidualFootMinusTx: footResiduals.length ? +Math.max.apply(null, footResiduals).toFixed(3) : null,
      framesWithFootVisible: mapped.filter((row) => row.footButtons !== null).length,
      framesWithFootAndMotion: mapped.filter((row) => row.footButtons !== null && typeof row.tx === 'number' && Math.abs(row.tx) >= 0.5).length,
      backdropOffsetFromInnerWidth: backdropOffsets.length ? { min: Math.min.apply(null, backdropOffsets), max: Math.max.apply(null, backdropOffsets) } : null,
      firstFrame: mapped.length ? { t: mapped[0].t, tx: mapped[0].tx, shift: mapped[0].shift, footShift: mapped[0].footShift, opacity: mapped[0].opacity, drawerRight: mapped[0].drawerRight, footRight: mapped[0].footRight } : null,
      lastFrame: mapped.length ? { t: mapped[mapped.length - 1].t, tx: mapped[mapped.length - 1].tx, shift: mapped[mapped.length - 1].shift, opacity: mapped[mapped.length - 1].opacity } : null,
      nearestTo6: nearest(6), nearestTo8: nearest(8), nearestTo11: nearest(11), nearestTo15: nearest(15), nearestTo24: nearest(24),
    },
    curveSearchAnim: a && a.curveSearchAnim ? a.curveSearchAnim : null,
    curveSearchInline: a && a.curveSearchInline ? a.curveSearchInline : null,
    afterInline: a && a.afterInline ? { transform: a.afterInline.transform, clearedTo: a.afterInline.clearedTo, drawerRight: a.afterInline.drawer && a.afterInline.drawer.r, footRight: a.afterInline.foot && a.afterInline.foot.r } : null,
    seek: {
      t0: seek0, mid: seekMid, end: seekEnd,
      restoredTransform: afterSeek && afterSeek.drawer ? afterSeek.drawer.transform : null,
      restoredDrawerRight: afterSeek && afterSeek.drawer ? afterSeek.drawer.box.r : null,
      matchesSteady: Boolean(afterSeek && afterSeek.drawer && steady && steady.drawer && Math.abs(afterSeek.drawer.box.r - steady.drawer.box.r) <= 0.5),
    },
  }
}

const A1440 = analyse(s1440)
const A390 = analyse(s390)

// ---- r330 两轮已记录的数字（只读引用，做对照；不改、不覆盖）----
const r330Recorded = { before: null, after: null }
for (const round of ['before', 'after']) {
  try {
    const file = path.join(ROOT, '.shots330', round, 'r330.json')
    if (!fs.existsSync(file)) continue
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const pick = (key) => {
      const first = j.toast && j.toast[key] && j.toast[key].first
      if (!first || !first.foot || !first.foot.box) return null
      return {
        innerWidth: first.viewport ? first.viewport.w : null,
        footBox: first.foot.box,
        footRightMinusInnerWidth: first.viewport && first.foot.box ? +(first.foot.box.r - first.viewport.w).toFixed(3) : null,
      }
    }
    r330Recorded[round] = { entry: j.entry || null, distVersion: j.distVersion || null, at: j.at || null, d1440: pick('d1440'), d390: pick('d390') }
  } catch (error) {
    r330Recorded[round] = { error: String((error && error.message) || error).slice(0, 200) }
  }
}

// ---- 判据 ----
function overflowFree(a) {
  if (!a || !a.steady) return null
  const drawer = a.steady.drawer
  const foot = a.steady.foot
  return Boolean(drawer.box.r <= a.steady.innerWidth + 0.5 && (!foot || foot.box.r <= a.steady.innerWidth + 0.5) && !a.steady.hOverflow && drawer.transform === 'none')
}
function shiftEqualsTx(a) {
  if (!a || !a.steady) return null
  const shape = a.timelineShape
  if (!shape || shape.framesWithMotion < 3) return null
  return shape.maxAbsResidualShiftMinusTx !== null && shape.maxAbsResidualShiftMinusTx <= 0.51 &&
    (shape.maxAbsResidualFootMinusTx === null || shape.maxAbsResidualFootMinusTx <= 0.51) &&
    Boolean(shape.firstFrame) && typeof shape.firstFrame.tx === 'number' && shape.firstFrame.tx >= 18
}
function eventsBracket(a) {
  if (!a || !a.steady || !a.settle || a.settle.error) return null
  const ended = (a.settle.endEvents || 0) >= 1 || Boolean(a.animationFinishSignal)
  const settled = a.settle.count === 0 || (a.settle.playStates || []).every((state) => state === 'finished')
  const firstAt = a.timelineShape && a.timelineShape.firstFrame ? a.timelineShape.firstFrame.t : null
  return Boolean(ended && settled && firstAt !== null && a.steady.at - firstAt > 260)
}
function onlyDrawerIn(a) {
  const list = a && a.animationsAtFirstFrame
  if (!list || !list.length) return null
  return list.every((row) => row.name === 'drawer-in')
}
function backdropAnchored(a) {
  if (!a || !a.timelineShape || !a.timelineShape.backdropOffsetFromInnerWidth) return null
  const span = a.timelineShape.backdropOffsetFromInnerWidth
  return Math.abs(span.min) <= 0.5 && Math.abs(span.max) <= 0.5
}
function chainClean(a) {
  if (!a || a.chainCreatesContainingBlock === null) return null
  return a.chainCreatesContainingBlock === false
}
function buttonsInside(a) {
  if (!a || !a.steady || !a.steady.foot || !a.steady.foot.buttons.length) return null
  return a.steady.foot.buttons.every((row) => row.box.r <= a.steady.innerWidth + 0.5 && row.box.l >= -0.5)
}
function steadyNoJitter(a) {
  const rows = a && a.steadyRepeat
  if (!rows || rows.length < 3) return null
  const same = (list) => list.every((value) => typeof value === 'number' && Math.abs(value - list[0]) <= 0.001)
  return same(rows.map((row) => row.drawerRight)) && same(rows.map((row) => row.footRight))
}
function seekAnimOk(a) {
  const rows = a && a.curveSearchAnim
  if (!rows || !rows.length) return null
  return rows.every((row) => row.ok === true)
}
function inlineOk(a) {
  const rows = a && a.curveSearchInline
  if (!rows || !rows.length) return null
  return rows.every((row) => row.ok === true)
}

const FREE = [overflowFree(A1440), overflowFree(A390)]
const SHIFT = [shiftEqualsTx(A1440), shiftEqualsTx(A390)]
const BRACKET = [eventsBracket(A1440), eventsBracket(A390)]
const ONLYIN = [onlyDrawerIn(A1440), onlyDrawerIn(A390)]
const BACKDROP = [backdropAnchored(A1440), backdropAnchored(A390)]
const CHAIN = [chainClean(A1440), chainClean(A390)]
const BUTTONS = [buttonsInside(A1440), buttonsInside(A390)]
const JITTER = [steadyNoJitter(A1440), steadyNoJitter(A390)]
const SEEKANIM = [seekAnimOk(A1440), seekAnimOk(A390)]
const INLINE = [inlineOk(A1440), inlineOk(A390)]
const measuredBoth = Boolean(A1440.measured && A390.measured)
const allTrue = (list) => list.every((value) => value === true)

let verdict = null
let verdictText = null
if (!measuredBoth) {
  verdict = null
  verdictText = '没量全：两个视口里至少有一个稳态没量到（' + [A1440.reason, A390.reason].filter(Boolean).join(' / ') + '），这一轮不给结论。'
} else if (FREE.some((value) => value === false)) {
  verdict = 'B'
  verdictText = '稳态下仍溢出：' + [A1440, A390].filter((a) => overflowFree(a) === false).map((a) => a.tag + ' 抽屉右沿 ' + a.steady.drawer.box.r + ' / 底栏右沿 ' + (a.steady.foot ? a.steady.foot.box.r : 'null') + ' vs innerWidth ' + a.steady.innerWidth + '（transform=' + a.steady.drawer.transform + '）').join('；') + '。'
} else if (allTrue(SHIFT) && allTrue(BRACKET) && allTrue(ONLYIN) && allTrue(BACKDROP) && allTrue(CHAIN) && allTrue(BUTTONS) && allTrue(JITTER) && (allTrue(SEEKANIM) || allTrue(INLINE))) {
  verdict = 'A'
  verdictText = '稳态下 .template-drawer 与 .drawer-foot 的右沿正好等于 innerWidth（transform: none、位移 0、scrollWidth == clientWidth、无横向溢出）；入场动画期间每一帧「右沿位移 === computed transform 的 tx」（24px → 0，220ms），r330 两轮量到的 +6/+8/+11/+15px 都能用 tx 精确复现——是 drawer-in 没跑完就量，属于测量方法的问题，布局没有溢出。'
} else {
  verdict = null
  verdictText = '稳态不溢出，但「位移 = transform tx」这组证据没凑齐，不给 A。缺口：' +
    [['位移=tx', SHIFT], ['动画事件夹住稳态', BRACKET], ['只有 drawer-in', ONLYIN], ['backdrop 锚在视口', BACKDROP], ['祖先链干净', CHAIN], ['按钮不切', BUTTONS], ['稳态无抖动', JITTER], ['动画二分', SEEKANIM], ['内联平移对照', INLINE]]
      .filter((pair) => !allTrue(pair[1])).map((pair) => pair[0] + '(' + pair[1].map((value) => String(value)).join('/') + ')').join('、')
}

// ---- checks ----
check('drawer.steady-not-wider-than-viewport', measuredBoth && allTrue(FREE), {
  meaning: '稳态（animationend / finished 之后）抽屉与底栏的右沿都必须 <= innerWidth，抽屉 transform 必须是 none，document 不能有横向溢出',
  d1440: A1440.steady ? { innerWidth: A1440.steady.innerWidth, drawerRight: A1440.steady.drawer.box.r, footRight: A1440.steady.foot ? A1440.steady.foot.box.r : null, drawerTransform: A1440.steady.drawer.transform, scrollWidth: A1440.steady.scrollWidth } : null,
  d390: A390.steady ? { innerWidth: A390.steady.innerWidth, drawerRight: A390.steady.drawer.box.r, footRight: A390.steady.foot ? A390.steady.foot.box.r : null, drawerTransform: A390.steady.drawer.transform, scrollWidth: A390.steady.scrollWidth } : null,
  passedPerViewport: { d1440: FREE[0], d390: FREE[1] },
})

check('drawer.animation-frames-shift-equals-tx', allTrue(SHIFT), {
  meaning: '插入后每一帧：抽屉（以及底栏）相对稳态的位移必须等于该帧 computed transform 的 tx（±0.5px），第一帧 tx 要接近 24px 的起点。对得上就说明那点位移是动画，不是布局',
  d1440: { framesWithMotion: A1440.timelineShape.framesWithMotion, firstFrame: A1440.timelineShape.firstFrame, maxAbsResidual: A1440.timelineShape.maxAbsResidualShiftMinusTx, footResidual: A1440.timelineShape.maxAbsResidualFootMinusTx, framesWithFootAndMotion: A1440.timelineShape.framesWithFootAndMotion },
  d390: { framesWithMotion: A390.timelineShape.framesWithMotion, firstFrame: A390.timelineShape.firstFrame, maxAbsResidual: A390.timelineShape.maxAbsResidualShiftMinusTx, footResidual: A390.timelineShape.maxAbsResidualFootMinusTx, framesWithFootAndMotion: A390.timelineShape.framesWithFootAndMotion },
})

check('drawer.animation-events-bracket-steady-measurement', allTrue(BRACKET), {
  meaning: '稳态那一组必须是「动画真的结束了」之后量的：animationend 或 finished 有记录、playState 全是 finished、且距插入第一帧 > 260ms——不是拿 sleep 当判据',
  d1440: { settle: A1440.settle, finish: A1440.animationFinishSignal, events: A1440.animationEvents, elapsedMs: A1440.timelineShape.firstFrame && A1440.steady ? A1440.steady.at - A1440.timelineShape.firstFrame.t : null },
  d390: { settle: A390.settle, finish: A390.animationFinishSignal, events: A390.animationEvents, elapsedMs: A390.timelineShape.firstFrame && A390.steady ? A390.steady.at - A390.timelineShape.firstFrame.t : null },
})

check('drawer.animation-is-only-drawer-in', allTrue(ONLYIN), {
  meaning: '抽屉上跑着的动画只有 drawer-in（220ms ease、fill:none），没有第二个 transform 来源',
  d1440: A1440.animationsAtFirstFrame, d390: A390.animationsAtFirstFrame,
  captures: { d1440: A1440.animationCapture, d390: A390.animationCapture },
})

check('drawer.backdrop-anchored-to-viewport', allTrue(BACKDROP) && allTrue(CHAIN), {
  meaning: '.drawer-backdrop（position:fixed; inset:0）每一帧右沿都等于 innerWidth，且祖先链上没有 transform / filter / backdrop-filter / will-change / contain——排除「包含块不是视口」这条真溢出通道',
  backdropOffset: { d1440: A1440.timelineShape.backdropOffsetFromInnerWidth, d390: A390.timelineShape.backdropOffsetFromInnerWidth },
  chainCreatesContainingBlock: { d1440: A1440.chainCreatesContainingBlock, d390: A390.chainCreatesContainingBlock },
  ancestors1440: A1440.backdropAncestors, ancestors390: A390.backdropAncestors,
})

check('drawer.delete-button-not-cut-steady', allTrue(BUTTONS), {
  meaning: '稳态下底栏每个按钮（含「删除」）的 right <= innerWidth 且 left >= 0——用稳态矩形判，不用动画中的',
  d1440: A1440.steady && A1440.steady.foot ? A1440.steady.foot.buttons.map((row) => ({ text: row.text, cls: row.cls, l: row.box.l, r: row.box.r, innerWidth: A1440.steady.innerWidth, cut: row.cut })) : null,
  d390: A390.steady && A390.steady.foot ? A390.steady.foot.buttons.map((row) => ({ text: row.text, cls: row.cls, l: row.box.l, r: row.box.r, innerWidth: A390.steady.innerWidth, cut: row.cut })) : null,
})

check('drawer.steady-has-no-jitter', allTrue(JITTER), {
  meaning: '稳态连量 6 次（间隔 140ms）：抽屉与底栏右沿必须一模一样——r330 那种 2–4px 抖动在稳态下应当消失',
  d1440: A1440.steadyRepeat ? A1440.steadyRepeat.map((row) => ({ t: row.t, drawerRight: row.drawerRight, footRight: row.footRight, transform: row.transform })) : null,
  d390: A390.steadyRepeat ? A390.steadyRepeat.map((row) => ({ t: row.t, drawerRight: row.drawerRight, footRight: row.footRight, transform: row.transform })) : null,
})

check('drawer.seek-by-animation', allTrue(SEEKANIM), {
  meaning: '在入场动画 0..duration 里二分：r330 的 +6/+8/+11/+15px 每个都能找到一个 currentTime 使「抽屉位移 = tx = 该数字」，底栏同步位移，且那一刻 opacity 在 (0.5,1)；t=0 时 tx=24。这样那四个数字就是同一段 220ms 动画的四个采样点',
  d1440: A1440.curveSearchAnim, d390: A390.curveSearchAnim,
  t0: { d1440: A1440.seek.t0, d390: A390.seek.t0 },
  source: { d1440: A1440.seek.t0 ? A1440.seek.t0.source : null, d390: A390.seek.t0 ? A390.seek.t0.source : null },
})

check('drawer.inline-translate-explains-numbers', allTrue(INLINE), {
  meaning: '对照实验：把同一根 transform: translateX(6/8/11/15/24px) 直接写在抽屉上（动画已结束），抽屉与底栏的右沿位移必须正好等于该 px，backdrop 与 scrollWidth 不变——证明这几个数字是纯平移，与宽度 / 包含块 / 滚动条无关',
  d1440: A1440.curveSearchInline, d390: A390.curveSearchInline,
})

// ---- 自检 ----
try {
  await setViewport(1440, 1000)
  await goto('/overview', '.vq-next-cta')
  const bits = await evaluate('(() => { const list = Array.prototype.map.call(document.querySelectorAll("script[src]"), (n) => String(n.getAttribute("src")).split("/").pop()).filter((n) => n && n.indexOf("index-") === 0); return { scripts: list } })()')
  const apiVersion = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  proof('0.1 页面脚本来自这次指定的构建入口（' + distEntry + '）', Boolean(distEntry) && Boolean(bits) && (bits.scripts || []).indexOf(distEntry) >= 0, { loaded: bits ? bits.scripts : null, dist: distEntry })
  proof('0.2 /api/version 与这份 dist 的版本一致（v' + distPkgVersion + '）', Boolean(apiVersion) && apiVersion.version === distPkgVersion, { api: apiVersion && apiVersion.version, distVersion: distPkgVersion, sourcePackage: pkgJson.version })
  const upstream = cdp.requests.filter((row) => row.url.indexOf(BASE) !== 0 && /10100|seeapi|geteapi|redfox|api\.openai|generations|replicate/i.test(row.url))
  proof('6.1 这一轮没有打任何上游（0 次）', upstream.length === 0, { upstream: upstream.slice(0, 3) })
  proof('6.2 页面异常 0 条、console.error 0 条', cdp.exceptions.length === 0 && cdp.consoleErrors.length === 0, { exceptions: cdp.exceptions.slice(0, 3), consoleErrors: cdp.consoleErrors.slice(0, 3) })
  const all = requestStats(0)
  const business = Object.keys(all.counts).filter((key) => key.indexOf('/api/client-errors') < 0)
  proof('6.4 这一轮 0 次业务写请求（没有建、没有删任何东西）', business.length === 0, { writes: all.writes, counts: all.counts, business: business })
  proof('6.3 两个视口都量到了稳态与时间线', measuredBoth && A1440.timeline.length > 0 && A390.timeline.length > 0, { d1440: { measured: A1440.measured, frames: A1440.timeline.length }, d390: { measured: A390.measured, frames: A390.timeline.length } })
  proof('9.9 取证脚本自己没崩', started, { started: started })
} catch (error) {
  proof('9.9 取证脚本自己没崩', false, { error: String((error && error.stack) || error).slice(0, 500) })
}

const failed = checks.filter((item) => !item.ok)
const selfFailed = selfProof.filter((item) => !item.ok)

const out = {
  round: 'r331',
  at: new Date().toISOString(),
  question: '「抽屉比容器宽 6–15px」是测量假象（入场动画还在跑），还是真溢出',
  dist: DIST_DIR,
  entry: distEntry,
  distVersion: distPkgVersion,
  packageVersion: pkgJson.version,
  port: API_PORT,
  dataDir: dataDir,
  outDir: OUT_DIR,
  seeded: seeded,
  overlays: overlayLog,
  method: {
    animationMid: 'MutationObserver 在拿到第一颗 .template-drawer 的同一微任务里读一次（顺带每帧采样到 900ms、抓下 Animation 句柄），再用 getAnimations()/句柄把 drawer-in 定位到 currentTime=0 / 110 / 末尾各量一次',
    steady: 'animationend + getAnimations().finished（playState 全 finished）之后再等两帧，然后连量 6 次（间隔 140ms）',
    shiftDefinition: '位移 = 该帧 getBoundingClientRect().right − 稳态 getBoundingClientRect().right；tx = 该帧 computed transform 的 matrix 平移分量',
    curveReconstruction: '在 0..duration 上二分 currentTime，使抽屉位移 == 目标 px（并检查那一刻 tx 与 opacity）；另有一组「内联 translateX」对照组',
    scrollbars: 'Chrome 与 r330 同一套参数（--hide-scrollbars），所以 documentElement.clientWidth == innerWidth；两个值都写进 JSON',
  },
  conclusion: { verdict: verdict, text: verdictText },
  r330Recorded: r330Recorded,
  headline: {
    d1440: { tag: A1440.tag, innerWidth: A1440.steady ? A1440.steady.innerWidth : null, clientWidth: A1440.steady ? A1440.steady.docClientWidth : null, scrollWidth: A1440.steady ? A1440.steady.scrollWidth : null, steady: A1440.steady ? { drawerRight: A1440.steady.drawer.box.r, footRight: A1440.steady.foot ? A1440.steady.foot.box.r : null, drawerTransform: A1440.steady.drawer.transform, opacity: A1440.steady.drawer.opacity } : null, animating: A1440.seek.t0, firstFrame: A1440.timelineShape.firstFrame, probeFast: A1440.probeFast, r330Style: A1440.r330Style, timelineShape: A1440.timelineShape, curveSearchAnim: A1440.curveSearchAnim, buttons: A1440.steady && A1440.steady.foot ? A1440.steady.foot.buttons : null },
    d390: { tag: A390.tag, innerWidth: A390.steady ? A390.steady.innerWidth : null, clientWidth: A390.steady ? A390.steady.docClientWidth : null, scrollWidth: A390.steady ? A390.steady.scrollWidth : null, steady: A390.steady ? { drawerRight: A390.steady.drawer.box.r, footRight: A390.steady.foot ? A390.steady.foot.box.r : null, drawerTransform: A390.steady.drawer.transform, opacity: A390.steady.drawer.opacity } : null, animating: A390.seek.t0, firstFrame: A390.timelineShape.firstFrame, probeFast: A390.probeFast, r330Style: A390.r330Style, timelineShape: A390.timelineShape, curveSearchAnim: A390.curveSearchAnim, buttons: A390.steady && A390.steady.foot ? A390.steady.foot.buttons : null },
  },
  scenes: { d1440: A1440, d390: A390 },
  raw: { d1440: s1440, d390: s390 },
  checks: checks,
  passed: checks.length - failed.length,
  failed: failed.length,
  selfProof: selfProof,
  selfProofFailed: selfFailed.length,
  notes: notes,
  screenshots: screenshots,
  exitPolicy: '0 = 结论 A（稳态不溢出且位移=动画 tx）；2 = 结论 B（真溢出）；1 = 没量全 / 脚本自己崩 / 自检红',
  exceptions: cdp ? cdp.exceptions : [],
  consoleErrors: cdp ? cdp.consoleErrors : [],
  serverLogTail: serverLog ? serverLog.slice(-600) : null,
}
fs.writeFileSync(path.join(OUT_DIR, 'drawer.json'), JSON.stringify(out, null, 2))

// ---- 报告 ----
function pad(text, width) {
  const value = String(text === null || text === undefined ? '-' : text)
  let visible = 0
  for (const char of value) visible += char.charCodeAt(0) > 255 ? 2 : 1
  return value + ' '.repeat(Math.max(0, width - visible))
}
console.log('')
console.log('==== 结论：' + (verdict || '未定') + ' ====')
console.log(verdictText)
console.log('')
console.log('---- r330 已经记下的数字（只读引用）----')
for (const round of ['before', 'after']) {
  const row = r330Recorded[round]
  if (!row || row.error) { console.log(pad(round, 8) + '没读到'); continue }
  for (const key of ['d1440', 'd390']) {
    const item = row[key]
    if (!item) { console.log(pad(round, 8) + pad(key, 7) + '没有底栏矩形'); continue }
    console.log(pad(round, 8) + pad(key, 7) + 'innerWidth=' + pad(item.innerWidth, 6) + 'foot r=' + pad(item.footBox.r, 9) + 'w=' + pad(item.footBox.w, 8) + '右沿 ' + (item.footRightMinusInnerWidth > 0 ? '+' : '') + item.footRightMinusInnerWidth + 'px')
  }
}
console.log('')
console.log('---- 动画中 vs 稳态 ----')
for (const a of [A1440, A390]) {
  if (!a.steady) { console.log(pad(a.tag, 8) + '没量到：' + a.reason); continue }
  const t0 = a.seek && a.seek.t0 && !a.seek.t0.error ? a.seek.t0 : null
  const first = a.timelineShape.firstFrame
  console.log(pad(a.tag, 8) + 'innerWidth=' + pad(a.steady.innerWidth, 5) + 'clientWidth=' + pad(a.steady.docClientWidth, 5) + 'scrollWidth=' + pad(a.steady.scrollWidth, 5))
  console.log('         动画中(t=0) drawer.r=' + pad(t0 ? t0.drawer.r : '-', 9) + 'foot.r=' + pad(t0 && t0.foot ? t0.foot.r : '-', 9) + 'tx=' + pad(t0 ? t0.tx : '-', 7) + 'opacity=' + pad(t0 ? t0.opacity : '-', 18) + 'source=' + (t0 ? t0.source : '-'))
  console.log('         第一帧      drawer.r=' + pad(first ? first.drawerRight : '-', 9) + 'foot.r=' + pad(first ? first.footRight : '-', 9) + 'tx=' + pad(first ? first.tx : '-', 7) + 'shift=' + pad(first ? first.shift : '-', 7) + 'opacity=' + pad(first ? first.opacity : '-', 18))
  console.log('         稳态        drawer.r=' + pad(a.steady.drawer.box.r, 9) + 'foot.r=' + pad(a.steady.foot ? a.steady.foot.box.r : '-', 9) + 'transform=' + String(a.steady.drawer.transform) + ' opacity=' + a.steady.drawer.opacity)
  console.log('         动画时钟    动画开始于插入后 ' + pad(a.recorderTiming ? a.recorderTiming.animationStartLagMs : '-', 7) + 'ms · animationend 在插入后 ' + pad(a.recorderTiming ? a.recorderTiming.animationEndedAtMs : '-', 7) + 'ms（主线程忙时动画自己的时钟会停，所以它比 220ms 长）')
  console.log('         底栏挂上    插入后 ' + pad(a.recorderTiming ? a.recorderTiming.footAppearedByMs : '-', 8) + 'ms · 快速探针(1 个往返) 插入后 ' + pad(a.probeFast ? a.probeFast.offsetFromInsertMs : '-', 8) + 'ms tx=' + pad(a.probeFast && a.probeFast.drawer ? a.probeFast.drawer.tx : '-', 7) + ' · r330 序探针 插入后 ' + pad(a.r330Style ? a.r330Style.offsetFromInsertMs : '-', 8) + 'ms tx=' + pad(a.r330Style && a.r330Style.drawer ? a.r330Style.drawer.tx : '-', 7) + '（这轮没弹提示条，所以它等到 1.4s 才量）')
  console.log('         时间线      帧 ' + pad(a.timelineShape.frameCount, 3) + ' 有运动 ' + pad(a.timelineShape.framesWithMotion, 3) + ' 位移 ' + pad(a.timelineShape.shiftMin + '…' + a.timelineShape.shiftMax, 14) + '|位移−tx|最大 ' + pad(a.timelineShape.maxAbsResidualShiftMinusTx, 7) + 'backdrop−innerWidth ' + JSON.stringify(a.timelineShape.backdropOffsetFromInnerWidth))
}
console.log('')
console.log('---- 二分：r330 的数字对应入场动画第几毫秒（真动画）----')
for (const a of [A1440, A390]) {
  if (!a.curveSearchAnim) { console.log(pad(a.tag, 8) + '没量到'); continue }
  for (const row of a.curveSearchAnim) {
    console.log(pad(a.tag, 8) + pad('+' + row.target + 'px', 7) + (row.ok ? 'ok ' : 'NO ') + '第 ' + pad(row.foundAtMs, 8) + 'ms · tx=' + pad(row.found ? row.found.tx : '-', 7) + 'opacity=' + pad(row.found ? row.found.opacity : '-', 18) + 'drawer.r=' + pad(row.found ? row.found.drawerRight : '-', 9) + 'foot.r=' + pad(row.found ? row.found.footRight : '-', 9) + (row.error ? ' error=' + row.error : ''))
  }
}
console.log('')
console.log('---- 对照：内联 translateX ----')
for (const a of [A1440, A390]) {
  if (!a.curveSearchInline) { console.log(pad(a.tag, 8) + '没量到'); continue }
  for (const row of a.curveSearchInline) {
    console.log(pad(a.tag, 8) + pad('+' + row.px + 'px', 7) + (row.ok ? 'ok ' : 'NO ') + 'drawer 位移=' + pad(row.drawerShift, 8) + 'foot 位移=' + pad(row.footShift, 8) + 'backdrop 位移=' + pad(row.backdropShift, 6) + 'tx=' + pad(row.tx, 8) + 'scrollWidth=' + row.scrollWidth)
  }
}
console.log('')
console.log('---- 底栏按钮（稳态）----')
for (const a of [A1440, A390]) {
  if (!a.steady || !a.steady.foot) continue
  for (const row of a.steady.foot.buttons) {
    console.log(pad(a.tag, 8) + pad(row.text, 12) + pad(row.cls, 36) + 'l=' + pad(row.box.l, 8) + 'r=' + pad(row.box.r, 9) + 'innerWidth=' + pad(a.steady.innerWidth, 5) + 'cut=' + row.cut)
  }
}
console.log('')
console.log('---- checks ----')
for (const item of checks) console.log((item.ok ? 'PASS ' : 'FAIL ') + pad(item.id, 44) + (item.detail && item.detail.meaning ? item.detail.meaning : ''))
console.log('')
console.log('---- 自检 ----')
for (const item of selfProof) console.log((item.ok ? 'PASS ' : 'FAIL ') + item.id)
console.log('')
console.log('---- r331 取证 · ' + out.passed + '/' + checks.length + ' 通过 · 自检 ' + (selfProof.length - out.selfProofFailed) + '/' + selfProof.length + ' · 证据 ' + path.join(path.relative(ROOT, OUT_DIR), 'drawer.json') + ' ----')

try { chrome.kill() } catch { /* 已经退出 */ }
try { server.kill() } catch { /* 已经退出 */ }
await sleep(400)
try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 同上 */ }
try { fs.rmSync(RUN_DIR, { recursive: true, force: true }) } catch { /* 同上 */ }
if (!started || selfFailed.length > 0 || verdict === null) process.exit(1)
if (verdict === 'B') process.exit(2)
process.exit(0)
