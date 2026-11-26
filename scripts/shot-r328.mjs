// r328 取证：全站弹窗的「焦点 / Tab / 背景滚动」三件事，改之前与改之后各量一次。
//
// 为什么单开一个脚本：
//   r327 只修了「身份引导」一个弹窗，验收标准（焦点进来、Tab 不外溢、背景不滚、关闭还焦）
//   是通用的，但全站二十来个浮层只有少数几个碰巧做到了。这一轮把同一套探针放到 4 个
//   都能用真界面点到的弹窗上，改之前先如实记一遍，改之后用同一份脚本再量一遍做对照。
//
// 三条纪律：
//   1) 只量界面，不碰上游。不点任何出图 / 出视频 / 解析 / 检索 / 评审按钮，临时库里也不给
//      模型与红狐 Key，所以这一轮是 0 次上游调用、0 费用。
//   2) 必须走 CDP 真输入：点击是 Input.dispatchMouseEvent（press/release），Tab / Esc / Ctrl+K
//      是 Input.dispatchKeyEvent，滚动是 Input.dispatchMouseEvent 的 mouseWheel。
//      只在「把焦点摆到入口按钮上」这一步用 DOM.focus —— 那是浏览器的真焦点，不是合成事件。
//   3) 证据不撒谎：before 阶段这些断言本来就是红的，红色就是证据；退出码 1 是正常的。
//
// 用法：
//   node scripts/shot-r328.mjs --phase before                 # 用 .shots328/dist-before 那份构建
//   node scripts/shot-r328.mjs --phase after                  # Lead 重新构建之后，用 dist
//   node scripts/shot-r328.mjs --phase before --dist <目录>    # 也可以指名哪份 dist
//
// 产物：.shots328/<phase>.json + docs/r328-<phase>-<弹窗>.png（1440x600）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, '.shots328')
const DOCS = path.join(ROOT, 'docs')
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

function argOf(name, fallback) {
  const at = process.argv.indexOf('--' + name)
  if (at > 0 && process.argv[at + 1] && process.argv[at + 1].charAt(0) !== '-') return process.argv[at + 1]
  return fallback
}

const ONLY = String(argOf('only', '')).split(',').map((item) => item.trim()).filter(Boolean)
const NARROW_ID = String(argOf('narrow', 'version'))
const PHASE = String(argOf('phase', 'before')).toLowerCase()
if (PHASE !== 'before' && PHASE !== 'after') throw new Error('--phase 只认 before 或 after，收到：' + PHASE)
const DIST_DIR = path.resolve(ROOT, String(argOf('dist', PHASE === 'before' ? '.shots328/dist-before' : 'dist')))
if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) throw new Error('dist 里没有 index.html：' + DIST_DIR)
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 SHOT_CHROME 指定）')
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(DOCS, { recursive: true })

const distHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8')
const distEntryMatch = distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
const distEntry = distEntryMatch ? distEntryMatch[1] : null
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

// 对照 before 那份快照：after 阶段如果入口 hash 没变，说明根本没重新构建，这一轮的对照不作数。
let beforeEntry = null
try {
  const html = fs.readFileSync(path.join(ROOT, '.shots328', 'dist-before', 'index.html'), 'utf8')
  const match = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
  beforeEntry = match ? match[1] : null
} catch { /* 没有快照就只记一条 note */ }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const checks = []
function check(id, ok, detail) {
  checks.push({ id: id, ok: Boolean(ok), detail: detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + JSON.stringify(detail))
  return Boolean(ok)
}
const notes = []
function note(text, detail) {
  notes.push({ text: text, detail: detail === undefined ? null : detail })
  console.log('NOTE ' + text + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

// 端口：只在这两段里挑，且避开这台机器上其它常驻服务占用的端口。
const RESERVED = new Set([8799, 8800, 3210, 6677, 5312, 5313, 3080, 10100, 10086])
async function freePort(start, end) {
  for (let port = start; port <= end; port += 1) {
    if (RESERVED.has(port)) continue
    const alive = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(400) }).then(() => true).catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口：' + start + '-' + end)
}
const API_PORT = await freePort(8820, 8840)
const DEBUG_PORT = await freePort(8860, 8880)
const BASE = 'http://127.0.0.1:' + API_PORT

// ---- 临时实例：真 SQLite、真账号、真 cookie，只是数据目录是新的 ----
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot328-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot328-profile-'))
process.env.DATA_DIR = dataDir

// 服务端用 process.cwd() 找 dist 与 package.json，所以给它一个「装着一份 dist」的舞台目录：
// 这样 before 阶段量的是 .shots328/dist-before，Lead 之后重新构建 dist 也污染不到这份证据。
const stageDir = path.join(OUT_DIR, 'stage-' + PHASE)
fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir, { recursive: true })
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(stageDir, 'package.json'))
try {
  fs.symlinkSync(DIST_DIR, path.join(stageDir, 'dist'), 'junction')
} catch (error) {
  console.log('NOTE junction 建不起来，退回复制：' + String(error && error.message))
  fs.cpSync(DIST_DIR, path.join(stageDir, 'dist'), { recursive: true })
}

const AT = String.fromCharCode(64)
const PASSWORD = 'r328-probe-pass'
const PROBE_NAME = 'r328probe'

const { createSession, createUser } = await import('../server/auth.mjs')
const { markComplete } = await import('../server/onboarding.mjs')
const { config: cfg } = await import('../server/config.mjs')

createUser({ email: 'r328-admin' + AT + 'shot.test', password: PASSWORD, name: '运维', kind: 'admin' })
const account = createUser({ email: 'r328probe' + AT + 'shot.test', password: PASSWORD, name: PROBE_NAME, kind: 'account' })
const token = createSession(account, {}).token
// 身份引导弹窗（r327）会盖住整屏，这一轮量的是别的弹窗：直接标成做完。
markComplete(account.id, { skipAssets: true })

console.log('r328 取证 · phase=' + PHASE + ' · dist=' + DIST_DIR + ' · 入口 ' + distEntry + ' · v' + pkgVersion + ' · 端口 ' + API_PORT)

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
  '--window-size=1440,600',
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
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params && message.params.exceptionDetails
        this.exceptions.push(String((details && ((details.exception && details.exception.description) || details.text)) || 'exception').slice(0, 300))
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params && message.params.type === 'error') {
        this.consoleErrors.push((message.params.args || []).map((arg) => String((arg && arg.value) || (arg && arg.description) || '')).join(' ').slice(0, 300))
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
    throw new Error('Runtime.evaluate 失败：' + String((error && error.message) || error) + ' :: ' + expression.slice(0, 200))
  }
  if (result && result.exceptionDetails) throw new Error('页面里求值失败：' + JSON.stringify(result.exceptionDetails).slice(0, 300) + ' :: ' + expression.slice(0, 200))
  return result && result.result ? result.result.value : undefined
}
async function waitForExpr(expression, label, tries = 70, gap = 140) {
  for (let i = 0; i < tries; i += 1) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(gap)
  }
  throw new Error('等不到：' + label)
}
// 选择器 → 页面表达式。只拼一次，避免把 ".cls" 当成表达式塞进括号里（那是语法错误）。
function sel(selector) {
  return 'document.querySelector(' + JSON.stringify(String(selector)) + ')'
}
async function rectOf(expression) {
  return evaluate('(() => { const el = (' + expression + '); if (!el) return null; const r = el.getBoundingClientRect(); return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), t: Math.round(r.top) } })()')
}
async function atPoint(x, y) {
  return evaluate('(() => { const el = document.elementFromPoint(' + x + ', ' + y + '); if (!el) return null; const cls = String(el.getAttribute && el.getAttribute("class") || "").split(/ +/).filter(Boolean).slice(0, 3).join("."); return String(el.tagName || "") + (cls ? "." + cls : "") })()')
}
async function mouseTo(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none' })
  await sleep(90)
}
async function mouseDown(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(60)
}
async function mouseUp(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(140)
}
async function pressKey(key, code, keyCode, modifiers = 0) {
  const params = { key: key, code: code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: modifiers }
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, params))
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, params))
  await sleep(110)
}
async function keyScrollProbe(spec) {
  // 键盘滚动：焦点在弹窗里时按 PageDown 不该滚到背景。CDP 真键，不用脚本改 scrollTop。
  const before = await evaluate('(' + scrollSnapshot.toString() + ')(' + JSON.stringify(spec.modal) + ')')
  await pressKey('PageDown', 'PageDown', 34, 0)
  await sleep(180)
  await pressKey('PageDown', 'PageDown', 34, 0)
  await sleep(280)
  const after = await evaluate('(' + scrollSnapshot.toString() + ')(' + JSON.stringify(spec.modal) + ')')
  let bgPx = 0
  let modalPx = 0
  const moved = []
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i]
    const a = after[i] || b
    const delta = a.top - b.top
    if (delta !== 0) {
      moved.push({ tag: b.tag, cls: b.cls, delta: delta, insideModal: b.insideModal })
      if (b.insideModal) modalPx = Math.max(modalPx, Math.abs(delta))
      else bgPx = Math.max(bgPx, Math.abs(delta))
    }
  }
  return { bgScrollPx: bgPx, modalScrollPx: modalPx, moved: moved.slice(0, 4) }
}

const pressTab = (shift = false) => pressKey('Tab', 'Tab', 9, shift ? 8 : 0)
const pressEsc = () => pressKey('Escape', 'Escape', 27, 0)
const pressCtrlK = () => pressKey('k', 'KeyK', 75, 2)

async function focusSelector(selector) {
  // DOM.focus 是浏览器自己的焦点动作（等同 el.focus()），用在「把焦点摆到入口按钮」这一步；
  // 之后所有会改变状态的操作仍然是 Input.* 真事件。
  const doc = await cdp.send('DOM.getDocument', { depth: 1 })
  const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: selector })
  if (!found || !found.nodeId) return false
  await cdp.send('DOM.focus', { nodeId: found.nodeId })
  await sleep(120)
  return true
}

async function openPage(hash, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: BASE + '/' + (hash.charAt(0) === '#' ? hash : '#' + hash) })
  await sleep(900)
}

// ---- 页面里跑的只读探针（写成普通函数再 toString 注入，免得转义地狱）----
function probeActive(modalSel) {
  const describe = function (el) {
    if (!el) return 'null'
    const tag = String(el.tagName || '')
    const raw = el.getAttribute && el.getAttribute('class')
    const cls = String(raw || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18)
    return tag + (cls ? '.' + cls : '') + (text ? ' "' + text + '"' : '')
  }
  const modal = document.querySelector(modalSel)
  const active = document.activeElement
  return {
    visible: Boolean(modal),
    active: describe(active),
    inModal: Boolean(modal && active && (active === modal || modal.contains(active))),
    modalRect: modal ? (function () { const r = modal.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } })() : null,
    bodyOverflow: document.body.style.overflow,
    htmlOverflow: document.documentElement.style.overflow,
    sameNode: Boolean(modal && active && modal.contains(active)),
  }
}

function probeFocusStep(modalSel) {
  const modal = document.querySelector(modalSel)
  const active = document.activeElement
  const raw = active && active.getAttribute && active.getAttribute('class')
  return {
    inModal: Boolean(modal && active && (active === modal || modal.contains(active))),
    tag: active ? String(active.tagName || '') : 'null',
    cls: String(raw || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.'),
    label: active ? String(active.getAttribute && (active.getAttribute('aria-label') || '') || '').slice(0, 24) : '',
    text: active ? String(active.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20) : '',
  }
}

function primeScroll() {
  // 先把背景滚到中段：视口只有 600 高，页面在顶端时「往下滚」没有空间，量不出差别。
  const doc = document.scrollingElement || document.documentElement
  const candidates = [document.querySelector('.vq-content'), document.querySelector('.vq-main'), doc]
  let room = 0
  for (const el of candidates) {
    if (!el) continue
    const max = el.scrollHeight - el.clientHeight
    room = Math.max(room, Math.round(max))
    if (max > 240) el.scrollTop = Math.min(160, max - 120)
  }
  return { room: room, top: Math.round(doc.scrollTop) }
}

function scrollSnapshot(modalSel) {
  const modal = document.querySelector(modalSel)
  const doc = document.scrollingElement || document.documentElement
  const rows = []
  const push = function (el, tag) {
    if (!el) return
    const raw = el.getAttribute && el.getAttribute('class')
    rows.push({
      tag: tag,
      cls: String(raw || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') || String(el.tagName || '').toLowerCase(),
      top: Math.round(el.scrollTop),
      max: Math.max(0, Math.round(el.scrollHeight - el.clientHeight)),
      insideModal: Boolean(modal && (el === modal || modal.contains(el))),
    })
  }
  push(doc, 'scrollingElement')
  push(document.body, 'body')
  push(document.querySelector('.vq-content'), 'vq-content')
  push(document.querySelector('.vq-main'), 'vq-main')
  const all = document.querySelectorAll('*')
  let seen = 0
  for (let i = 0; i < all.length && seen < 24; i += 1) {
    const el = all[i]
    if (el === doc || el === document.body) continue
    let style
    try { style = getComputedStyle(el) } catch { continue }
    if (!/auto|scroll/.test(style.overflowY)) continue
    if (el.scrollHeight - el.clientHeight <= 8) continue
    push(el, 'scrollable')
    seen += 1
  }
  return rows
}

function sanitizeVisibleText() {
  // 截图前的隐私兜底：可见文本里的邮箱 / 11 位手机号换成占位符。返回替换条数。
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
  const phoneRe = /(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)/g
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
    let after = before.replace(emailRe, '<email>').replace(phoneRe, function (all, head, tail) { return head + '<phone>' + tail })
    if (after !== before) {
      node.nodeValue = after
      count += 1
    }
  }
  return count
}

async function shot(name, width, height) {
  const captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = path.join(DOCS, name)
  fs.writeFileSync(file, Buffer.from(captured.data, 'base64'))
  const bytes = fs.statSync(file).size
  console.log('SHOT ' + name + ' · ' + bytes + ' B · ' + width + 'x' + height)
  return { file: 'docs/' + name, bytes: bytes, width: width, height: height }
}

// ---- 四个弹窗：入口都用真界面点到（选择器就是 src 里那几颗按钮）----
const MODALS = [
  {
    id: 'version',
    name: '版本信息',
    hash: '/overview',
    waitFor: '.vq-shell',
    modal: '.vq-update-modal:not(.vq-feedback-modal):not(.vq-report-modal)',
    open: { kind: 'click', find: 'document.querySelector(".vq-version-trigger")', desc: '侧栏 .vq-version-trigger' },
    closeButton: '.vq-update-modal:not(.vq-feedback-modal) [aria-label="关闭"]',
    neutral: '.vq-update-modal:not(.vq-feedback-modal) .vq-update-head div',
  },
  {
    id: 'palette',
    name: '命令面板',
    hash: '/overview',
    waitFor: '.vq-shell',
    modal: '.cp-panel',
    open: { kind: 'ctrlk', focus: '.vq-search--trigger', desc: 'Ctrl+K（焦点先摆到顶栏「跳转到…」按钮）' },
    closeButton: null,
    neutral: '.cp-field input',
  },
  {
    id: 'trash',
    name: '回收站',
    hash: '/projects',
    waitFor: '.vq-project-page',
    modal: '.trash-modal',
    open: {
      kind: 'click',
      find: "Array.prototype.find.call(document.querySelectorAll('button'), function (b) { return String(b.textContent || '').trim() === '回收站' })",
      desc: '#/projects 页头 ghost 按钮「回收站」',
    },
    closeButton: '.trash-modal [aria-label^="关闭"]',
    neutral: '.trash-head div',
  },
  {
    id: 'feedback',
    name: '反馈',
    hash: '/help',
    waitFor: '.vq-help-side-cta',
    modal: '.vq-feedback-modal',
    open: { kind: 'click', find: 'document.querySelector(".vq-help-side-cta")', desc: '#/help 页 .vq-help-side-cta' },
    closeButton: '.vq-feedback-modal [aria-label="关闭"]',
    neutral: '.vq-feedback-modal .vq-update-head div',
  },
]

const ACTIVE_MODALS = ONLY.length ? MODALS.filter((spec) => ONLY.indexOf(spec.id) >= 0) : MODALS
const results = []
const screenshots = []
let narrow = null

async function openModal(spec) {
  if (spec.open.kind === 'click') {
    let rect = await rectOf(spec.open.find)
    if (!rect) throw new Error('入口点不到：' + spec.open.desc)
    await mouseTo(rect.cx, rect.cy)
    await mouseDown(rect.cx, rect.cy)
    const before = await evaluate('(' + probeActive.toString() + ')(' + JSON.stringify(spec.modal) + ')')
    await mouseUp(rect.cx, rect.cy)
    await sleep(200)
    // 空态页面首帧可能还没稳定：没开就再点一次（还是真事件）
    if (!(await evaluate('Boolean(document.querySelector(' + JSON.stringify(spec.modal) + '))'))) {
      rect = await rectOf(spec.open.find) || rect
      await mouseTo(rect.cx, rect.cy)
      await mouseDown(rect.cx, rect.cy)
      await mouseUp(rect.cx, rect.cy)
    }
    try {
      await waitForExpr('Boolean(document.querySelector(' + JSON.stringify(spec.modal) + '))', spec.name + ' 打开')
    } catch {
      const hit = await atPoint(rect.cx, rect.cy)
      const buttons = await evaluate('Array.prototype.map.call(document.querySelectorAll("button"), function (b) { const r = b.getBoundingClientRect(); return String(b.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 12) + "@" + Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height) })')
      throw new Error('点了 ' + spec.open.desc + '（' + rect.cx + ',' + rect.cy + ' → ' + hit + '）但 ' + spec.modal + ' 没出来；按钮：' + JSON.stringify(buttons.slice(0, 12)))
    }
    await sleep(220)
    return { activeBeforeOpen: before.active, triggerRect: rect }
  }
  // Ctrl+K：先把焦点用真焦点摆到顶栏那颗入口按钮上，再按真键
  const focused = await focusSelector(spec.open.focus)
  if (!focused) throw new Error('找不到 Ctrl+K 之前的焦点落点：' + spec.open.focus)
  const before = await evaluate('(' + probeActive.toString() + ')(' + JSON.stringify(spec.modal) + ')')
  await pressCtrlK()
  await waitForExpr('Boolean(document.querySelector(' + JSON.stringify(spec.modal) + '))', spec.name + ' 打开')
  await sleep(220)
  return { activeBeforeOpen: before.active, triggerRect: await rectOf(sel(spec.open.focus)) }
}

async function closeModal(spec) {
  // 先按真 Esc；不行就点弹窗空白处把焦点收进来再 Esc；再不行才点关闭按钮。
  let phase = 'esc'
  await pressEsc()
  await sleep(220)
  let open = await evaluate('Boolean(document.querySelector(' + JSON.stringify(spec.modal) + '))')
  if (!open) return { via: 'esc', escClosed: true }
  await pressEsc()
  await sleep(200)
  open = await evaluate('Boolean(document.querySelector(' + JSON.stringify(spec.modal) + '))')
  if (!open) return { via: 'esc', escClosed: true }
  phase = 'neutral-esc'
  const neutral = await rectOf(sel(spec.neutral))
  if (neutral) {
    await mouseTo(neutral.cx, Math.min(neutral.cy, 580))
    await mouseDown(neutral.cx, Math.min(neutral.cy, 580))
    await mouseUp(neutral.cx, Math.min(neutral.cy, 580))
    await sleep(160)
  }
  await pressEsc()
  await sleep(240)
  open = await evaluate('Boolean(document.querySelector(' + JSON.stringify(spec.modal) + '))')
  if (!open) return { via: 'esc-after-refocus', escClosed: true }
  phase = 'button'
  if (spec.closeButton) {
    const rect = await rectOf(sel(spec.closeButton))
    if (rect) {
      await mouseTo(rect.cx, rect.cy)
      await mouseDown(rect.cx, rect.cy)
      await mouseUp(rect.cx, rect.cy)
      await sleep(240)
    }
  }
  open = await evaluate('Boolean(document.querySelector(' + JSON.stringify(spec.modal) + '))')
  if (open) {
    // 最后一招：点遮罩（两个遮罩都在 mousedown 上关自己）
    await mouseTo(12, 300)
    await mouseDown(12, 300)
    await mouseUp(12, 300)
    await sleep(260)
    open = await evaluate('Boolean(document.querySelector(' + JSON.stringify(spec.modal) + '))')
    return { via: 'backdrop', escClosed: false, stillOpen: open }
  }
  return { via: phase, escClosed: false }
}

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
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })
  // 上手引导与手机端提示都先标成看过：这一轮量的是这 4 个弹窗。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1');localStorage.setItem('vq.edition','user')}catch(e){}",
  })

  for (const spec of ACTIVE_MODALS) {
    const entry = { id: spec.id, name: spec.name, hash: spec.hash, modal: spec.modal, entry: spec.open.desc, ok: true }
    try {
      await openPage(spec.hash, 1440, 600)
      await waitForExpr('Boolean(document.querySelector(' + JSON.stringify(spec.waitFor) + '))', spec.name + ' 的页面骨架')
      await sleep(320)
      const primed = await evaluate('(' + primeScroll.toString() + ')()')
      const openedAt = await openModal(spec)
      const onOpen = await evaluate('(' + probeActive.toString() + ')(' + JSON.stringify(spec.modal) + ')')
      if (!onOpen.visible) throw new Error('弹窗没出现：' + spec.modal)
      entry.activeBeforeOpen = openedAt.activeBeforeOpen
      entry.activeOnOpen = onOpen.active
      entry.focusInsideOnOpen = onOpen.inModal === true
      entry.modalRect = onOpen.modalRect
      entry.bodyOverflow = onOpen.bodyOverflow
      entry.htmlOverflow = onOpen.htmlOverflow
      entry.scrollRoomPx = primed.room

      // ---- 顺序按 Lead 的要求：焦点 → Tab → 滚轮 → 截图（还开着）→ 关闭 ----

      // 1) Tab ×12 + Shift+Tab ×1：焦点会不会跑到遮罩后面的页面上
      const steps = []
      let escapes = 0
      const escapedTo = []
      for (let i = 0; i < 12; i += 1) {
        await pressTab(false)
        const step = await evaluate('(' + probeFocusStep.toString() + ')(' + JSON.stringify(spec.modal) + ')')
        step.index = i + 1
        step.key = 'Tab'
        steps.push(step)
        if (!step.inModal) {
          escapes += 1
          escapedTo.push(step.tag + (step.cls ? '.' + step.cls : '') + (step.text ? ' "' + step.text + '"' : ''))
        }
      }
      await pressTab(true)
      const shiftStep = await evaluate('(' + probeFocusStep.toString() + ')(' + JSON.stringify(spec.modal) + ')')
      shiftStep.index = 13
      shiftStep.key = 'Shift+Tab'
      steps.push(shiftStep)
      if (!shiftStep.inModal) {
        escapes += 1
        escapedTo.push(shiftStep.tag + (shiftStep.cls ? '.' + shiftStep.cls : '') + (shiftStep.text ? ' "' + shiftStep.text + '"' : ''))
      }
      entry.tabs = { escapes: escapes, escapedTo: escapedTo.slice(0, 6), steps: steps.map((s) => (s.key === 'Shift+Tab' ? 'S+' : '') + (s.inModal ? 'in' : 'OUT') + ':' + s.tag + (s.cls ? '.' + s.cls : '')) }

      // 2) 背景滚动：视口 1440x600，在弹窗正中派发一次真滚轮
      const before = await evaluate('(' + scrollSnapshot.toString() + ')(' + JSON.stringify(spec.modal) + ')')
      const center = onOpen.modalRect
        ? { x: onOpen.modalRect.l + Math.round(onOpen.modalRect.w / 2), y: Math.max(20, Math.min(560, onOpen.modalRect.t + Math.round(onOpen.modalRect.h / 2))) }
        : { x: 720, y: 300 }
      await mouseTo(center.x, center.y)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: 320, modifiers: 0 })
      await sleep(320)
      const after = await evaluate('(' + scrollSnapshot.toString() + ')(' + JSON.stringify(spec.modal) + ')')
      const moved = []
      let bgPx = 0
      let modalPx = 0
      for (let i = 0; i < before.length; i += 1) {
        const b = before[i]
        const a = after[i] || b
        const delta = a.top - b.top
        if (delta !== 0) {
          moved.push({ tag: b.tag, cls: b.cls, from: b.top, to: a.top, delta: delta, insideModal: b.insideModal })
          if (b.insideModal) modalPx = Math.max(modalPx, Math.abs(delta))
          else bgPx = Math.max(bgPx, Math.abs(delta))
        }
      }
      const wheelHit = await atPoint(center.x, center.y)
      const docRow = before.findIndex((row) => row.tag === 'scrollingElement')
      entry.scroll = {
        wheelAt: center,
        wheelHit: wheelHit,
        docDelta: docRow >= 0 ? ((after[docRow] || {}).top || 0) - before[docRow].top : 0,
        bgScrollPx: bgPx,
        modalScrollPx: modalPx,
        moved: moved.slice(0, 6),
        scrollRoomPx: primed.room,
      }

      // 2.1) 键盘滚动也量一次（键盘用户滚出背景同样算「背景跟着滚」）
      entry.keyScroll = primed.room >= 100 ? await keyScrollProbe(spec) : { skipped: '背景在 1440x600 下没有可滚空间（scrollRoomPx=' + primed.room + '）' }

      // 3) 截图：弹窗必须还开着（关掉之后拍的图说明不了问题）
      const stillOpen = await evaluate('Boolean(document.querySelector(' + JSON.stringify(spec.modal) + '))')
      if (!stillOpen) throw new Error('截图前弹窗已经不在了：' + spec.modal)
      const sanitized = await evaluate('(' + sanitizeVisibleText.toString() + ')()')
      entry.sanitizedCount = sanitized
      if (sanitized > 0) note(spec.name + ' · 截图前替换了 ' + sanitized + ' 处邮箱/手机号', { count: sanitized })
      const file = 'r328-' + PHASE + '-' + spec.id + '.png'
      entry.screenshot = await shot(file, 1440, 600)
      entry.screenshotWithModalOpen = true
      screenshots.push(entry.screenshot)

      // 4) 关闭：Esc（关不掉时逐级兜底，并如实记下来）
      const closed = await closeModal(spec)
      await sleep(260)
      const afterClose = await evaluate('(' + probeActive.toString() + ')(' + JSON.stringify(spec.modal) + ')')
      entry.close = {
        via: closed.via,
        escClosed: closed.escClosed,
        stillOpen: Boolean(closed.stillOpen) || afterClose.visible === true,
        activeAfterClose: afterClose.active,
        focusRestoredToOpener: sameFocusLabel(afterClose.active, entry.activeBeforeOpen),
      }
    } catch (error) {
      entry.ok = false
      entry.error = String((error && error.message) || error).slice(0, 300)
      console.log('ERROR ' + spec.name + ' · ' + entry.error)
    }
    results.push(entry)
  }

  // ---- 390 宽：同一个弹窗在窄屏下也不能横向溢出 ----
  const narrowSpec = ACTIVE_MODALS.find((spec) => spec.id === NARROW_ID) || ACTIVE_MODALS[0]
  if (narrowSpec) {
    try {
      await openPage(narrowSpec.hash, 390, 844)
      await waitForExpr('Boolean(document.querySelector(' + JSON.stringify(narrowSpec.waitFor) + '))', narrowSpec.name + ' 的窄屏页面骨架')
      await sleep(320)
      await openModal(narrowSpec)
      const state = await evaluate('(' + probeActive.toString() + ')(' + JSON.stringify(narrowSpec.modal) + ')')
      const widthInfo = await evaluate('({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })')
      const sanitizedNarrow = await evaluate('(' + sanitizeVisibleText.toString() + ')()')
      const file = 'r328-' + PHASE + '-' + narrowSpec.id + '-390.png'
      const photo = await shot(file, 390, 844)
      screenshots.push(photo)
      narrow = { id: narrowSpec.id, name: narrowSpec.name, modalVisible: state.visible === true, modalRect: state.modalRect, sanitized: sanitizedNarrow, screenshot: photo, width: widthInfo }
      await closeModal(narrowSpec)
    } catch (error) {
      narrow = { id: narrowSpec.id, error: String((error && error.message) || error).slice(0, 240) }
      console.log('ERROR 390 宽 ' + narrowSpec.name + ' · ' + narrow.error)
    }
  }

  // ---- 断言：这一套是「改完应该成立」的样子；before 阶段红的就是证据 ----
  const versionBits = await evaluate('(() => { const list = Array.prototype.map.call(document.querySelectorAll("script[src]"), (n) => String(n.getAttribute("src")).split("/").pop()).filter((n) => n && n.indexOf("index-") === 0); const label = document.querySelector(".vq-version-label"); return { scripts: list, uiVersion: label ? String(label.textContent || "").trim() : null } })()')
  const versionApi = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  note('入口与版本', { loaded: versionBits.scripts, dist: distEntry, before: beforeEntry, api: versionApi && versionApi.version, uiVersion: versionBits.uiVersion })
  check('0.1 页面脚本来自这次指定的构建入口（' + distEntry + '）', Boolean(distEntry) && (versionBits.scripts || []).indexOf(distEntry) >= 0, { loaded: versionBits.scripts, dist: DIST_DIR })
  check('0.2 /api/version 与 package.json 一致（v' + pkgVersion + '）', Boolean(versionApi) && versionApi.version === pkgVersion, { api: versionApi && versionApi.version })
  if (PHASE === 'after') {
    check('0.3 after 阶段用的是新构建（入口 hash 与 before 快照不同）', Boolean(distEntry) && Boolean(beforeEntry) && distEntry !== beforeEntry, { after: distEntry, before: beforeEntry })
  }

  for (const entry of results) {
    const tag = entry.name
    if (!entry.ok) {
      check(tag + ' · 这一段取证跑完了', false, { error: entry.error })
      continue
    }
    check(tag + ' · 打开后焦点在弹窗里', entry.focusInsideOnOpen === true, { activeOnOpen: entry.activeOnOpen, trigger: entry.activeBeforeOpen })
    check(tag + ' · Tab 跑不出弹窗（escapes 应为 0）', entry.tabs.escapes === 0, { escapes: entry.tabs.escapes, escapedTo: entry.tabs.escapedTo })
    check(tag + ' · 背景不跟着滚（body overflow hidden 且滚轮不动背景）', entry.bodyOverflow === 'hidden' && entry.scroll.bgScrollPx === 0, { bodyOverflow: entry.bodyOverflow, bgScrollPx: entry.scroll.bgScrollPx, scrollRoomPx: entry.scrollRoomPx })
    check(tag + ' · 关掉之后焦点回到打开它的那颗按钮', entry.close.focusRestoredToOpener === true, { activeAfterClose: entry.close.activeAfterClose, opener: entry.activeBeforeOpen, via: entry.close.via })
  }

  check('6.1 页面异常 0 条、console.error 0 条', cdp.exceptions.length === 0 && cdp.consoleErrors.length === 0, { exceptions: cdp.exceptions.slice(0, 3), consoleErrors: cdp.consoleErrors.slice(0, 3) })
  const upstreamLines = serverLog.split(/\r?\n/).filter((line) => /seeapi|geteapi|redfox|api\.openai|generations|replicate/i.test(line) && line.indexOf('"t":"listen"') < 0)
  check('6.2 这一轮没有打任何上游（日志里没有上游调用）', upstreamLines.length === 0, { lines: upstreamLines.slice(0, 3) })
  check('6.4 390 宽下弹窗在、没有横向溢出（scrollWidth === innerWidth）', Boolean(narrow) && !narrow.error && narrow.modalVisible === true && narrow.width.scrollWidth === narrow.width.innerWidth, { narrow: narrow && { id: narrow.id, width: narrow.width, error: narrow.error || null } })
  check('6.3 每个弹窗都落了一张图', screenshots.length === ACTIVE_MODALS.length + 1 && screenshots.every((item) => fs.existsSync(path.join(ROOT, item.file))), { files: screenshots.map((item) => item.file) })
} catch (error) {
  check('9.9 取证脚本自己没崩', false, { error: String((error && error.stack) || error).slice(0, 500) })
  if (serverLog) note('服务端日志尾部', serverLog.slice(-600))
}

function sameFocusLabel(after, before) {
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const a = norm(after)
  const b = norm(before)
  if (!a || !b) return false
  if (a === b) return true
  // 「关闭后回到入口按钮」的判定：标签里第一个类名一致就算（DOM 里 textContent 可能因为
  // 兄弟节点的空态文案变化而不同）。
  const clsOf = (value) => {
    const match = String(value).match(/^[A-Z]+\.[^\s"]+/)
    return match ? match[0] : ''
  }
  return clsOf(a) !== '' && clsOf(a) === clsOf(b)
}

const failed = checks.filter((item) => !item.ok)
const out = {
  round: 'r328',
  phase: PHASE,
  at: new Date().toISOString(),
  dist: DIST_DIR,
  entry: distEntry,
  beforeEntry: beforeEntry,
  version: pkgVersion,
  port: API_PORT,
  modals: results,
  narrow: narrow,
  skipped: [
    { id: 'lightbox', reason: '临时库里没有媒体条目，打开不了（不硬造数据）' },
    { id: 'assets-dialog', reason: '.vq-assets-dialog 要先有资产才能改名触发（不硬造数据）' },
  ],
  checks: checks,
  failed: failed.length,
  passed: checks.length - failed.length,
  notes: notes,
  screenshots: screenshots,
  exceptions: cdp ? cdp.exceptions : [],
  consoleErrors: cdp ? cdp.consoleErrors : [],
}
fs.writeFileSync(path.join(OUT_DIR, PHASE + '.json'), JSON.stringify(out, null, 2))

// ---- 紧凑表格 ----
function pad(text, width) {
  const value = String(text === null || text === undefined ? '-' : text)
  let visible = 0
  for (const char of value) visible += char.charCodeAt(0) > 255 ? 2 : 1
  return value + ' '.repeat(Math.max(0, width - visible))
}
console.log('')
console.log(pad('弹窗', 12) + pad('焦点进来', 10) + pad('Tab跑出', 9) + pad('bodyOverflow', 16) + pad('背景滚px', 10) + pad('关闭方式', 18) + pad('关闭后焦点', 34) + '打开时焦点')
console.log('-'.repeat(150))
for (const entry of results) {
  if (!entry.ok) {
    console.log(pad(entry.name, 12) + pad('ERROR', 10) + pad(entry.error, 60))
    continue
  }
  console.log(
    pad(entry.name, 12) +
    pad(entry.focusInsideOnOpen ? '是' : '否', 10) +
    pad(entry.tabs.escapes, 9) +
    pad(JSON.stringify(entry.bodyOverflow), 16) +
    pad(entry.scroll.bgScrollPx, 10) +
    pad(entry.close.via + (entry.close.escClosed ? '(esc)' : ''), 18) +
    pad(entry.close.activeAfterClose, 34) +
    String(entry.activeOnOpen || '')
  )
}
console.log('')
console.log('---- r328 取证 · phase=' + PHASE + ' · ' + out.passed + '/' + checks.length + ' 通过 · 证据 ' + path.join('.shots328', PHASE + '.json') + ' ----')

try { chrome.kill() } catch { /* 已经退出 */ }
try { server.kill() } catch { /* 已经退出 */ }
await sleep(300)
try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 同上 */ }
process.exit(failed.length ? 1 : 0)
