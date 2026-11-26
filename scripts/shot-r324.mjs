// r324 独立取证：全局提示条（toast）四处改动的真渲染数字。
//
// 与 shot-r323 同一套做法：临时 DATA_DIR + 真 SQLite + 真账号 + 空闲端口 + headless Chrome/CDP。
// 不碰 src/**、不重新 build：只量 dist 里已经构建好的这一份。
//
// 量的四件事（都在真页面上，不是单测）：
//   1) 停留时间跟着文案字数走：29 字那条停 ~4.1 秒，6 字那条停 ~2.8 秒（原来固定 2.4 秒）
//   2) 收尾不是硬切：卸载之前有一段真过渡（采样到 0<opacity<1），持续约 180ms
//   3) 连按同一个动作动画重放、计时器重新起算（第二次点了以后不会按第一次的时间消失）
//   4) 系统开了「减弱动态效果」时没有收尾尾巴，停满就收
//   5) 窄屏 390：长文案换行、不越界、max-width 生效
//
// 用法：node scripts/shot-r324.mjs
// 产物：.shots324/out.json + docs/r324-toast-*.png。退出码 1 = 有断言没过（数字照样写进 out.json）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, '.shots324')
const DOCS = path.join(ROOT, 'docs')
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const EXPECT_ENTRY = process.env.SHOT_ENTRY || 'index-7khOa3Rv.js'
const EXPECT_VERSION = process.env.SHOT_VERSION || '0.9.296'
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 SHOT_CHROME 指定）')
fs.mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const startedAt = new Date().toISOString()

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

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const alive = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(400) }).then(() => true).catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口')
}

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8996))
const DEBUG_PORT = await freePort(API_PORT + 60)
const BASE = 'http://127.0.0.1:' + API_PORT

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot324-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot324-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const MAIL = 'shot324-user' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

// 先建一个管理员：库里没有管理员时服务启动会顺手把第一个用户提成管理员，
// 那会把「普通账号」这条路径（身份引导、进工作台的提示）改掉——本轮量的正是它。
createUser({ email: 'shot324-admin' + AT + 'shot.test', password: PASSWORD, name: '运维', kind: 'admin' })
const account = createUser({ email: MAIL, password: PASSWORD, name: '取证账号', kind: 'account' })
const token = createSession(account, {}).token

// 提示条自己的行为由这一小段只看不点的探针记下来：什么时候挂上、什么时候加 is-leaving、什么时候摘掉。
// 注入到每个新文档里（页面加载就挂上，这样连「进页面自动弹的那条」也抓得到）。
const WATCH_SOURCE = [
  '(function () {',
  '  window.__toastLog = [];',
  '  window.__toastAnimations = 0;',
  '  window.__toastFade = [];',
  '  var now = function () { return Math.round(performance.now()) };',
  '  var rec = function (kind, el) {',
  '    window.__toastLog.push({ kind: kind, at: now(), text: String(el.textContent || "").trim(), cls: String(el.className || ""), opacity: Number(getComputedStyle(el).opacity) });',
  '  };',
  '  var sample = function (el) {',
  '    if (!el || !el.isConnected) return;',
  '    window.__toastFade.push({ at: now(), opacity: Number(getComputedStyle(el).opacity) });',
  '    if (window.__toastFade.length < 60) requestAnimationFrame(function () { sample(el) });',
  '  };',
  '  document.addEventListener("animationstart", function (event) {',
  '    var target = event.target;',
  '    if (target && target.classList && target.classList.contains("vq-toast")) window.__toastAnimations += 1;',
  '  }, true);',
  '  var attach = function () {',
  '    if (!document.body) { setTimeout(attach, 20); return; }',
  '    var seen = new WeakSet();',
  '    var observer = new MutationObserver(function (records) {',
  '      for (var i = 0; i < records.length; i += 1) {',
  '        var record = records[i];',
  '        if (record.type === "childList") {',
  '          Array.prototype.forEach.call(record.addedNodes, function (node) {',
  '            if (node.nodeType === 1 && node.classList && node.classList.contains("vq-toast") && !seen.has(node)) { seen.add(node); rec("added", node) }',
  '          });',
  '          Array.prototype.forEach.call(record.removedNodes, function (node) {',
  '            if (node.nodeType === 1 && node.classList && node.classList.contains("vq-toast")) rec("removed", node)',
  '          });',
  '        } else if (record.type === "attributes") {',
  '          var el = record.target;',
  '          if (el && el.classList && el.classList.contains("vq-toast")) {',
  '            rec("class", el);',
  '            if (el.classList.contains("is-leaving") && window.__toastFade.length === 0) sample(el);',
  '          }',
  '        }',
  '      }',
  '    });',
  '    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });',
  '    window.__toastObserver = observer;',
  '  };',
  '  attach();',
  '})();',
].join('\n')

console.log('临时实例 · ' + dataDir + ' · 端口 ' + API_PORT)

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    API_PORT: String(API_PORT),
    VQ_REQUIRE_AUTH: '1',
    VQ_REDFOX_DISABLED: '1',
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

async function waitFor(checkFn, label, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try { const value = await checkFn(); if (value) return value } catch { /* 还没起来 */ }
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
    this.logErrors = []
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params && message.params.exceptionDetails
        this.exceptions.push(String(details && (details.exception && details.exception.description || details.text) || 'exception').slice(0, 300))
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params && message.params.type === 'error') {
        const args = message.params.args || []
        this.consoleErrors.push(args.map((arg) => String((arg && arg.value) || (arg && arg.description) || '')).join(' ').slice(0, 300))
      }
      if (message.method === 'Log.entryAdded' && message.params && message.params.entry && message.params.entry.level === 'error') {
        this.logErrors.push(String(message.params.entry.text || '').slice(0, 300))
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

async function waitForExpr(expression, label, tries = 60, gap = 150) {
  for (let i = 0; i < tries; i += 1) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(gap)
  }
  throw new Error('等不到：' + label)
}

async function rectOf(expression) {
  return evaluate('(() => { const el = (' + expression + '); if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } })()')
}

async function scrollToCenter(expression) {
  const found = await evaluate('(() => { const el = (' + expression + '); if (!el) return false; el.scrollIntoView({ block: "center", behavior: "instant" }); return true })()')
  await sleep(250)
  return found
}

async function clickExpr(expression, label) {
  await scrollToCenter(expression)
  const rect = await rectOf(expression)
  if (!rect) throw new Error('点不到：' + (label || expression))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.cx, y: rect.cy, button: 'none' })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.cx, y: rect.cy, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.cx, y: rect.cy, button: 'left', clickCount: 1 })
  await sleep(120)
  return rect
}

async function selectAll() {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: type, modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
    })
  }
  return evaluate('(() => { const el = document.activeElement; if (!el || typeof el.selectionStart !== "number") return null; return { start: el.selectionStart, end: el.selectionEnd, len: String(el.value).length } })()')
}

async function pressBackspace() {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type: type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  }
}

async function shot(name, width, height) {
  const captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = path.join(DOCS, name)
  fs.writeFileSync(file, Buffer.from(captured.data, 'base64'))
  const bytes = fs.statSync(file).size
  const entry = { file: 'docs/' + name, bytes: bytes, width: width, height: height }
  console.log('SHOT ' + name + ' · ' + bytes + ' B · ' + width + 'x' + height)
  return entry
}

// ---- 页面里跑的只读小探针（写成普通函数再 toString 注入，避免转义地狱）----
function readToastBox() {
  const el = document.querySelector('.vq-toast')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const textNode = el.lastChild
  let lines = null
  if (textNode && textNode.nodeType === 3) {
    const range = document.createRange()
    range.selectNodeContents(textNode)
    lines = Array.prototype.filter.call(range.getClientRects(), (box) => box.height > 2).length
  }
  return {
    text: el.textContent.trim(),
    rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) },
    opacity: Number(cs.opacity),
    maxWidth: cs.maxWidth,
    position: cs.position,
    bottom: cs.bottom,
    lines: lines,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    docScrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    inViewport: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
  }
}

function readVersionBits() {
  const scripts = Array.prototype.map.call(document.querySelectorAll('script[src]'), (node) => String(node.getAttribute('src')).split('/').pop()).filter((name) => name && name.indexOf('index-') === 0)
  const label = document.querySelector('.vq-version-label')
  return { scripts: scripts, sidebarVersion: label ? label.textContent.trim() : null, title: document.title }
}

const screenshots = []
const pageErrors = { exceptions: [], consoleErrors: [], logErrors: [] }

// 提示条该停多久：与 src/domain/toast.ts 同一条口径（这里现算一遍，用来对真渲染的数字）
function expectedHold(text) {
  const trimmed = String(text || '').trim()
  return Math.min(6000, 2400 + trimmed.length * 60)
}

function summarizeToastLog(log) {
  const added = log.filter((row) => row.kind === 'added')
  const removed = log.filter((row) => row.kind === 'removed')
  const classRows = log.filter((row) => row.kind === 'class')
  const leaving = classRows.filter((row) => row.cls.indexOf('is-leaving') >= 0)
  const fade = classRows.filter((row) => row.cls.indexOf('is-leaving') < 0 && row.cls.indexOf('vq-toast') >= 0)
  return {
    addedCount: added.length,
    removedCount: removed.length,
    added: added.map((row) => ({ at: row.at, text: row.text })),
    leaving: leaving.map((row) => ({ at: row.at, text: row.text })),
    classNames: classRows.map((row) => ({ at: row.at, cls: row.cls })),
    removed: removed.map((row) => ({ at: row.at })),
    firstAddedAt: added.length ? added[0].at : null,
    lastAddedAt: added.length ? added[added.length - 1].at : null,
    firstLeavingAt: leaving.length ? leaving[0].at : null,
    lastLeavingAt: leaving.length ? leaving[leaving.length - 1].at : null,
    removedAt: removed.length ? removed[removed.length - 1].at : null,
    extraClass: fade.length,
  }
}

async function resetWatch() {
  await evaluate('window.__toastLog = []; window.__toastFade = []; window.__toastAnimations = 0; true')
}

async function toastGrowing(label) {
  return waitForExpr('window.__toastLog.some(function (row) { return row.kind === "added" })', label, 120, 50)
}

/** 等屏幕上一条提示都不剩。连按那一段会先换 key（旧节点换新节点），只看「有 removed」会提前收工。 */
async function waitToastEmpty(label) {
  await waitForExpr('document.querySelectorAll(".vq-toast").length === 0', label, 300, 25)
  await sleep(120)
}

async function openPage(hashPath, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Page.navigate', { url: BASE + '/?edition=user&shot=' + Date.now() + '#' + hashPath })
  await sleep(1600)
}

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const headers = { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token }

  // 0) 种子：只发真接口的写请求（都落在临时数据目录里）——
  //    ① 引导做完但不建资产：进工作台时提示一次「还没有自己的资产」，这就是那条 29 字的提示
  const identity = await fetch(BASE + '/api/onboarding', { method: 'PUT', headers: headers, body: JSON.stringify({ identity: 'creator', category: '美妆个护' }) })
  const identityBody = await identity.json()
  if (!identity.ok) throw new Error('选身份失败：' + identity.status + ' ' + JSON.stringify(identityBody).slice(0, 200))
  const done = await fetch(BASE + '/api/onboarding/complete', { method: 'POST', headers: headers, body: JSON.stringify({ skipAssets: true }) })
  const doneBody = await done.json()
  if (!done.ok) throw new Error('引导完成失败：' + done.status + ' ' + JSON.stringify(doneBody).slice(0, 200))
  const onboarding = await fetch(BASE + '/api/onboarding', { headers: headers }).then((response) => response.json())
  console.log('引导状态：' + JSON.stringify(onboarding))
  note('引导状态', onboarding)

  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((response) => response.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')

  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })
  // 上手引导与窄屏提示要关掉（它们会盖住提示条），随后把只看不点的提示条探针挂上
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}"
      + WATCH_SOURCE,
  })

  // ---- 断言 1/2/3：29 字的提示（进工作台自动弹的那条）----
  await resetWatch()
  await openPage('/overview', 1440, 1000)
  await toastGrowing('长文案提示条')
  await sleep(250)
  const longBox = await evaluate('(' + readToastBox.toString() + ')()')
  screenshots.push(await shot('r324-toast-long-1440.png', 1440, 1000))
  const longExpected = expectedHold(longBox ? longBox.text : '')
  note('长文案停在屏上', { box: longBox, expectedHold: longExpected })

  const versionBits = await evaluate('(' + readVersionBits.toString() + ')()')
  const versionApi = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  note('入口', { loaded: versionBits.scripts, expected: EXPECT_ENTRY, apiVersion: versionApi && versionApi.version, sidebarVersion: versionBits.sidebarVersion })
  check('0.1 页面脚本来自本轮 dist（' + EXPECT_ENTRY + '）', (versionBits.scripts || []).indexOf(EXPECT_ENTRY) >= 0, { loaded: versionBits.scripts })
  check('0.2 侧栏版本号是 v' + EXPECT_VERSION + ' 且 /api/version 一致', versionBits.sidebarVersion === 'v' + EXPECT_VERSION && versionApi && versionApi.version === EXPECT_VERSION, { sidebar: versionBits.sidebarVersion, api: versionApi && versionApi.version })

  // 收尾那一段：等它开始淡出，抓一张半透明的帧
  await waitForExpr('window.__toastLog.some(function (row) { return row.kind === "class" && row.cls.indexOf("is-leaving") >= 0 })', '开始收尾', 200, 20)
  // 收尾只有 180ms，静帧要抢：一发现 is-leaving 就连拍两张，前后各读一次透明度，
  // 两帧里挑能看清的那张进 docs（这里不去暂停动画——App 的卸载计时器不看 CSS）。
  // 这一帧要把 180ms 的过渡按住才拍得到：直接拍，等截图的合成帧出来时它已经淡完/被摘掉了
  // （上一次实测：请求前读到 0.49，出来的帧里什么都没有）。
  // 暂停的是这条 CSS transition 本身，不是另画的：按住的透明度就是那一刻真实算出来的值。
  const frozen = await evaluate(
    '(() => { const el = document.querySelector(".vq-toast"); if (!el) return null;'
      + ' const anims = el.getAnimations(); anims.forEach(function (a) { a.pause() });'
      + ' return { count: anims.length, opacity: Number(getComputedStyle(el).opacity), cls: String(el.className) } })()',
  )
  screenshots.push(await shot('r324-toast-exit-1440.png', 1440, 1000))
  // 暂停那一瞬间读到的还是 1（同一帧里过渡还没往前走），按住的真实值要再读一次
  const frozenAfter = await evaluate('(() => { const el = document.querySelector(".vq-toast"); return el ? Number(getComputedStyle(el).opacity) : null })()')
  const midFade = { opacity: frozenAfter !== null ? frozenAfter : (frozen ? frozen.opacity : null), atPause: frozen ? frozen.opacity : null, cls: frozen ? frozen.cls : null, transitions: frozen ? frozen.count : null }
  await waitToastEmpty('长文案提示条卸载')

  const longLog = summarizeToastLog(await evaluate('window.__toastLog'))
  const longFade = await evaluate('window.__toastFade')
  const longHold = longLog.firstLeavingAt !== null && longLog.firstAddedAt !== null ? longLog.firstLeavingAt - longLog.firstAddedAt : null
  const longExit = longLog.removedAt !== null && longLog.lastLeavingAt !== null ? longLog.removedAt - longLog.lastLeavingAt : null
  const midFadeSamples = (longFade || []).filter((row) => row.opacity > 0.05 && row.opacity < 0.95).length
  note('长文案时间线', { log: longLog, fade: longFade, hold: longHold, exit: longExit, expectedHold: longExpected, midFade: midFade, midFadeSamples: midFadeSamples })
  note('收尾取帧', { 按下瞬间: midFade.atPause, 按住后透明度: (longFade || []).length ? (longFade || [])[(longFade || []).length - 1].opacity : null, 过渡条数: midFade.transitions, 采样: (longFade || []).slice(0, 6) })

  check('1.1 提示条文案就是「还没有自己的资产…」那条（29 字）', longLog.added[0] && longLog.added[0].text === longBox.text && longBox.text.indexOf('还没有自己的资产') >= 0, { text: longLog.added[0] && longLog.added[0].text, length: longBox.text.length })
  check('1.2 停留时间 = 2.4 秒 + 60ms×字数（±250ms）', longHold !== null && Math.abs(longHold - longExpected) <= 250, { hold: longHold, expected: longExpected })
  check('1.3 已经不是固定 2.4 秒：29 字这条停了 3.9 秒以上', longHold !== null && longHold > 3900, { hold: longHold })
  // 按住的透明度取页面自己那串采样（rAF 里读的 getComputedStyle，和合成器看到的同一份）。
  // Runtime.evaluate 里同步读到的还是 1：主线程那份计算值要等到下一次渲染步才更新。
  const fadeRows = longFade || []
  const frozenValue = fadeRows.length ? fadeRows[fadeRows.length - 1].opacity : null
  const frozenStable = fadeRows.length >= 2 && fadeRows[fadeRows.length - 1].opacity === fadeRows[fadeRows.length - 2].opacity
  check('2.1 收尾是一段真过渡：采样到 0<opacity<1 的帧，按住的这一帧也在半透明上', midFadeSamples >= 1 && frozenValue !== null && frozenValue > 0.1 && frozenValue < 0.9, { midFadeSamples: midFadeSamples, 按住后透明度: frozenValue, fade: fadeRows.slice(0, 12) })
  check('2.6 按住以后透明度不再变（冻结的是这条真过渡，不是另画的）', frozenStable, { fade: (longFade || []).slice(-4) })
  check('2.2 收尾时长约 180ms（120~320ms）后才卸载', longExit !== null && longExit >= 120 && longExit <= 320, { exit: longExit })
  check('2.3 卸载后 DOM 里没有提示条（这一条真的走完了）', (await evaluate('document.querySelectorAll(".vq-toast").length')) === 0, { left: await evaluate('document.querySelectorAll(".vq-toast").length') })
  check('2.4 1440 下超长文案有宽度上限 560px、单行不折断', longBox.maxWidth === '560px' && longBox.rect.w <= 560 && longBox.lines === 1, { maxWidth: longBox.maxWidth, w: longBox.rect.w, lines: longBox.lines })
  check('2.5 桌面右下角位置没变：fixed / bottom 24px', longBox.position === 'fixed' && longBox.bottom === '24px', { position: longBox.position, bottom: longBox.bottom })

  // ---- 断言 4：窄屏 390 的长文案 ----
  await resetWatch()
  await openPage('/overview', 390, 844)
  await toastGrowing('390 长文案提示条')
  await sleep(250)
  const narrowBox = await evaluate('(' + readToastBox.toString() + ')()')
  screenshots.push(await shot('r324-toast-390.png', 390, 844))
  note('390 长文案', { box: narrowBox })
  check('4.1 390 下长文案换行（≥2 行）且宽不超过 342px', narrowBox.lines >= 2 && narrowBox.rect.w <= 342, { lines: narrowBox.lines, w: narrowBox.rect.w, maxWidth: narrowBox.maxWidth })
  check('4.2 390 下 max-width 按视口收（342px = 390-48）', narrowBox.maxWidth === '342px', { maxWidth: narrowBox.maxWidth })
  check('4.3 390 下提示条整块在视口内、页面没有横向溢出', narrowBox.inViewport && narrowBox.docScrollWidth === narrowBox.clientWidth && narrowBox.docScrollWidth === 390, { rect: narrowBox.rect, scrollWidth: narrowBox.docScrollWidth, clientWidth: narrowBox.clientWidth })
  await waitToastEmpty('390 长文案卸载')
  const narrowLog = summarizeToastLog(await evaluate('window.__toastLog'))
  const narrowHold = narrowLog.firstLeavingAt !== null && narrowLog.firstAddedAt !== null ? narrowLog.firstLeavingAt - narrowLog.firstAddedAt : null
  note('390 时间线', { hold: narrowHold, log: narrowLog })
  check('4.4 390 下停留时间与桌面同一条口径（±250ms）', narrowHold !== null && Math.abs(narrowHold - expectedHold(narrowBox.text)) <= 250, { hold: narrowHold, expected: expectedHold(narrowBox.text) })

  // ---- 断言 5/6：短文案 + 连按两次 ----
  // ② 种子：先真上传一张素材图（原始字节，不是 JSON），再照它建一套产品资产。
  //    建资产要改名字才有那条 6 字的「名字不能为空」，而没素材图不让建（ASSET_SOURCES）。
  //    这张 1×1 的合法 PNG 与 test/assets.test.mjs 用的是同一串字节。
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const uploaded = await fetch(
    BASE + '/api/media/assets?name=' + encodeURIComponent('取证素材图') + '&width=1&height=1',
    { method: 'POST', headers: { cookie: cfg.auth.cookieName + '=' + token, 'Content-Type': 'image/png' }, body: PNG },
  )
  const uploadedBody = await uploaded.json()
  if (!uploaded.ok || !uploadedBody.ok) throw new Error('上传素材失败：' + uploaded.status + ' ' + JSON.stringify(uploadedBody).slice(0, 200))
  const created = await fetch(BASE + '/api/assets', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ kind: 'product', name: '取证用产品资产', category: '美妆个护', sourceAssetIds: [uploadedBody.asset.id] }),
  })
  const createdBody = await created.json()
  if (!created.ok || !createdBody.ok) throw new Error('建资产失败：' + created.status + ' ' + JSON.stringify(createdBody).slice(0, 200))
  console.log('素材已上传：' + uploadedBody.asset.id + ' · 资产已建：' + createdBody.asset.id + ' · ' + createdBody.asset.name)

  await openPage('/assets', 1440, 1000)
  await waitForExpr('Array.prototype.some.call(document.querySelectorAll("button"), function (b) { return b.textContent.trim() === "改名" })', '资产卡上的改名按钮', 80, 200)
  await clickExpr('Array.prototype.find.call(document.querySelectorAll("button"), function (b) { return b.textContent.trim() === "改名" })', '改名')
  await waitForExpr('Boolean(document.querySelector(".vq-asset-input"))', '改名弹窗', 60, 150)
  const cleared = await selectAll()
  await pressBackspace()
  await sleep(250)
  const clearedValue = await evaluate('(() => { const el = document.querySelector(".vq-asset-input"); return el ? el.value : null })()')
  note('改名输入框清空', { selection: cleared, value: clearedValue })
  check('5.0 改名框里的名字被真键盘清空了（点保存才是「名字不能为空」）', clearedValue === '', { value: clearedValue })

  const saveSelector = 'document.querySelector(".vq-assets-dialog-actions .vq-button--primary")'

  // 单次短提示：点一次「保存」（名字是空的）——只弹一条 6 字的提示
  await waitToastEmpty('起手先等屏幕上干净')
  await resetWatch()
  await clickExpr(saveSelector, '保存（单次）')
  await toastGrowing('短文案提示条')
  await sleep(200)
  const shortBox = await evaluate('(' + readToastBox.toString() + ')()')
  const shortExpected = expectedHold(shortBox ? shortBox.text : '')
  await waitToastEmpty('短文案卸载')
  const shortLog = summarizeToastLog(await evaluate('window.__toastLog'))
  const shortHold = shortLog.firstLeavingAt !== null && shortLog.firstAddedAt !== null ? shortLog.firstLeavingAt - shortLog.firstAddedAt : null
  const shortLife = shortLog.removedAt !== null && shortLog.firstAddedAt !== null ? shortLog.removedAt - shortLog.firstAddedAt : null
  note('短文案时间线', { box: shortBox, expected: shortExpected, log: shortLog, hold: shortHold, life: shortLife })

  check('5.1 短文案是「名字不能为空」（6 字）', shortLog.added[0] && shortLog.added[0].text === '名字不能为空', { text: shortLog.added[0] && shortLog.added[0].text })
  check('5.2 停留时间 = 2.4 秒 + 60ms×6 字（±250ms）', shortHold !== null && Math.abs(shortHold - shortExpected) <= 250, { hold: shortHold, expected: shortExpected })
  check('5.3 短文案明显比长文案停得短（差 ≥600ms）', longHold !== null && shortHold !== null && longHold - shortHold >= 600, { longHold: longHold, shortHold: shortHold, delta: longHold - shortHold })

  // ---- 断言 6：连按同一个动作 ----
  // 隔 1.3 秒再点一次：若计时器没有重新起算，第一条会在第一次点击后 2.76 秒就消失。
  await resetWatch()
  await clickExpr(saveSelector, '保存（连按第一次）')
  await toastGrowing('连按的第一条')
  await sleep(1300)
  const beforeSecond = await evaluate('document.querySelectorAll(".vq-toast").length')
  await clickExpr(saveSelector, '保存（连按第二次）')
  await sleep(250)
  const animationsAfterSecond = Number(await evaluate('window.__toastAnimations'))
  // 等两条都走完：第一条是被换 key 换掉的，第二条才是自己到点的
  await waitForExpr('window.__toastLog.filter(function (row) { return row.kind === "removed" }).length >= 2', '连按的两条都卸载', 300, 25)
  await sleep(120)

  const repeatLog = summarizeToastLog(await evaluate('window.__toastLog'))
  const secondHold = repeatLog.lastLeavingAt !== null && repeatLog.lastAddedAt !== null ? repeatLog.lastLeavingAt - repeatLog.lastAddedAt : null
  const firstToRemoval = repeatLog.removedAt !== null && repeatLog.firstAddedAt !== null ? repeatLog.removedAt - repeatLog.firstAddedAt : null
  note('连按时间线', { log: repeatLog, animations: animationsAfterSecond, beforeSecond: beforeSecond, secondHold: secondHold, firstToRemoval: firstToRemoval, secondExpected: shortExpected })

  check('6.1 连按同一个动作：提示条重新挂了一次（进场动画重放）', repeatLog.addedCount >= 2 && animationsAfterSecond >= 2, { addedCount: repeatLog.addedCount, animations: animationsAfterSecond })
  check('6.2 第二次点击时前一条还在（计时器没提前收）', beforeSecond === 1, { beforeSecond: beforeSecond })
  check('6.3 第二次点击后按新的一次重新计时（第二次挂上到收尾 ≈ 2.76 秒）', secondHold !== null && Math.abs(secondHold - shortExpected) <= 250, { secondHold: secondHold, expected: shortExpected })
  check('6.4 没有按第一次点击的时间消失：第一次挂上到全部走完 > 4.1 秒', firstToRemoval !== null && firstToRemoval > 4100, { firstToRemoval: firstToRemoval })

  // ---- 断言 7：系统开了「减弱动态效果」----
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await waitToastEmpty('减弱动态效果前先等屏幕上干净')
  await resetWatch()
  await clickExpr(saveSelector, '保存（减弱动态效果）')
  await toastGrowing('减弱动态效果下的提示条')
  const reducedFlags = await evaluate('({ reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches })')
  await waitToastEmpty('减弱动态效果下提示条卸载')
  const reducedLog = summarizeToastLog(await evaluate('window.__toastLog'))
  const reducedFade = await evaluate('window.__toastFade')
  const reducedLife = reducedLog.removedAt !== null && reducedLog.firstAddedAt !== null ? reducedLog.removedAt - reducedLog.firstAddedAt : null
  const reducedExit = reducedLog.removedAt !== null && reducedLog.lastLeavingAt !== null ? reducedLog.removedAt - reducedLog.lastLeavingAt : null
  note('减弱动态效果时间线', { flags: reducedFlags, log: reducedLog, fade: reducedFade, life: reducedLife, exit: reducedExit, expected: shortExpected })
  check('7.1 减弱动态效果生效（页面里读得到 media 查询）', reducedFlags && reducedFlags.reduced === true, reducedFlags)
  check('7.2 停满就收：整段生命 ≈ 停留时长（±250ms），没有 180ms 尾巴', reducedLife !== null && Math.abs(reducedLife - shortExpected) <= 250, { life: reducedLife, expected: shortExpected })
  check('7.3 收尾不是 180ms：卸载距离开收尾 ≤ 80ms', reducedExit === null || reducedExit <= 80, { exit: reducedExit, leavingSeen: reducedLog.lastLeavingAt })
  check('7.4 没有半透明帧（过渡只有 1ms）', (reducedFade || []).filter((row) => row.opacity > 0.05 && row.opacity < 0.95).length === 0, { fade: reducedFade })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })

  // ---- 断言 8：页面报错 ----
  pageErrors.exceptions = cdp.exceptions.slice()
  pageErrors.consoleErrors = cdp.consoleErrors.slice()
  pageErrors.logErrors = cdp.logErrors.slice()
  check('8.1 页面脚本报错数为 0（exception + console.error）', pageErrors.exceptions.length === 0 && pageErrors.consoleErrors.length === 0, { exceptions: pageErrors.exceptions.length, consoleErrors: pageErrors.consoleErrors.length, logErrors: pageErrors.logErrors.length })
  if (pageErrors.exceptions.length) note('页面异常', pageErrors.exceptions.slice(0, 3))
  if (pageErrors.consoleErrors.length) note('console.error', pageErrors.consoleErrors.slice(0, 3))
  if (pageErrors.logErrors.length) note('Log.entryAdded(level=error)', pageErrors.logErrors.slice(0, 5))

  // 只排掉启动那一行（里面就写着 "redfox":"on"，不是调用）
  const upstream = serverLog.split('\n').filter((line) => line.indexOf('"t":"listen"') < 0).filter((line) => /redfox|kling|replicate|openai|geteapi|seeapi|upstream/i.test(line))
  note('上游调用行', upstream.slice(0, 5))
  check('8.2 本轮没有真的打上游（日志里没有上游调用行）', upstream.length === 0, { lines: upstream.slice(0, 3) })
} catch (error) {
  check('脚本整体跑完', false, { error: String((error && error.message) || error) })
  console.error('脚本失败：' + String((error && error.stack) || error))
  console.error(serverLog.slice(-2000))
} finally {
  try {
    cdp?.close()
    chrome.kill()
    server.kill()
  } catch { /* 已经在退 */ }
  await sleep(1500)
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch { /* Chrome 偶尔还占着文件 */ }

  const failed = checks.filter((item) => !item.ok)
  const out = {
    startedAt: startedAt,
    finishedAt: new Date().toISOString(),
    base: BASE,
    dataDir: dataDir,
    expectEntry: EXPECT_ENTRY,
    expectVersion: EXPECT_VERSION,
    checks: checks,
    failed: failed.map((item) => item.id),
    screenshots: screenshots,
    pageErrors: pageErrors,
    notes: notes,
    serverFailLines: serverLog.split('\n').filter((line) => line.indexOf('失败') >= 0).slice(0, 5),
  }
  fs.writeFileSync(path.join(OUT_DIR, 'out.json'), JSON.stringify(out, null, 2))
  console.log('---')
  console.log('断言 ' + (checks.length - failed.length) + '/' + checks.length + ' 通过' + (failed.length ? '；失败：' + failed.map((item) => item.id).join(' | ') : ''))
  console.log('out.json 已写：' + path.join(OUT_DIR, 'out.json'))
  if (failed.length) process.exitCode = 1

  const cleaner = spawn(process.execPath, ['-e', 'setTimeout(() => { try { require("fs").rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch (e) { console.warn("cleanup: " + e.message) } }, 2000)', dataDir], { detached: true, stdio: 'ignore' })
  cleaner.unref()
}
