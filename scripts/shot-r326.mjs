// r326 独立取证：运营位「整卡可点」与「关掉能撤」在真页面上到底成不成立。
//
// 与 shot-r325 同一套做法：临时 DATA_DIR + 真 SQLite + 真账号 + 空闲端口 + headless Chrome/CDP。
// 不碰 src/**、不重新 build：只量 dist 里已经构建好的那一份（入口从 dist/index.html 读、
// 版本从 package.json 读，所以「量的就是这一轮要发的那份」）。
//
// 量五件事：
//   1) 整卡可点：正文正中做命中测试落到的必须是 CTA 那层热区；真点一下要跳到那条运营位指的那一页
//      （另外用脚本点一次按钮做对照：能跳说明 onClick 没坏）
//   2) 点 ✕ 不会跳走：关的是这条卡片，不是「跑去那一页」
//   3) 关掉能撤：条子出现、文案「已关掉「标题」」、撤销之后卡片回到原位、本地记录也撤掉
//   4) 撤销窗口：槽里还有别的运营位时 8 秒后退场（光标停在上面期间不走）；
//      槽被关空了就一直留着——那时它是唯一的入口；刷新之后关掉的仍然不会自己回来
//   5) 390 同一件事成立且不横向溢出；全程 0 次上游调用
//
// 用法：node scripts/shot-r326.mjs
// 产物：.shots326/out.json + docs/r326-promo-hover-1440.png / -undo-1440.png / -undo-all-1440.png / -undo-all-390.png
// 退出码 1 = 有断言没过（数字照样写进 out.json）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, '.shots326')
const DOCS = path.join(ROOT, 'docs')
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 SHOT_CHROME 指定）')
fs.mkdirSync(OUT_DIR, { recursive: true })

const distHtml = fs.readFileSync(path.join(ROOT, 'dist', 'index.html'), 'utf8')
const distEntryMatch = distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
const distEntry = distEntryMatch ? distEntryMatch[1] : null
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const EXPECT_ENTRY = process.env.SHOT_ENTRY || distEntry
const EXPECT_VERSION = process.env.SHOT_VERSION || pkgVersion

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot326-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot326-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

// 先建管理员：库里没有管理员时服务启动会把第一个用户提成管理员，那会改掉普通账号这条路径
createUser({ email: 'shot326-admin' + AT + 'shot.test', password: PASSWORD, name: '运维', kind: 'admin' })
const account = createUser({ email: 'shot326-user' + AT + 'shot.test', password: PASSWORD, name: '取证账号', kind: 'account' })
const token = createSession(account, {}).token

console.log('临时实例 · ' + dataDir + ' · 端口 ' + API_PORT + ' · 入口 ' + EXPECT_ENTRY + ' · v' + EXPECT_VERSION)

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
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
        this.consoleErrors.push((message.params.args || []).map((arg) => String((arg && arg.value) || (arg && arg.description) || '')).join(' ').slice(0, 300))
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
  return evaluate('(() => { const el = (' + expression + '); if (!el) return null; const r = el.getBoundingClientRect(); return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } })()')
}
async function moveTo(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none' })
  await sleep(120)
}
async function clickExpr(expression, label) {
  await evaluate('(() => { const el = (' + expression + '); if (!el) return false; el.scrollIntoView({ block: "center", behavior: "instant" }); return true })()')
  await sleep(200)
  const rect = await rectOf(expression)
  if (!rect) throw new Error('点不到：' + (label || expression))
  await moveTo(rect.cx, rect.cy)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.cx, y: rect.cy, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.cx, y: rect.cy, button: 'left', clickCount: 1 })
  await sleep(140)
  return rect
}
async function shot(name, width, height) {
  const captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = path.join(DOCS, name)
  fs.writeFileSync(file, Buffer.from(captured.data, 'base64'))
  const bytes = fs.statSync(file).size
  console.log('SHOT ' + name + ' · ' + bytes + ' B · ' + width + 'x' + height)
  return { file: 'docs/' + name, bytes: bytes, width: width, height: height }
}

// ---- 页面里跑的只读探针（写成普通函数再 toString 注入，避免转义地狱）----
function readPromoBits() {
  const box = function (el) {
    const r = el.getBoundingClientRect()
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }
  }
  const hit = function (x, y) {
    const el = document.elementFromPoint(x, y)
    if (!el) return null
    if (el.closest('.vq-promo-cta')) return 'cta'
    if (el.closest('.vq-promo-close')) return 'close'
    if (el.closest('.vq-promo-copy')) return 'copy'
    if (el.closest('.vq-promo-undo')) return 'undo'
    return String(el.className || el.tagName)
  }
  const cards = Array.prototype.map.call(document.querySelectorAll('.vq-promo'), function (card) {
    const cta = card.querySelector('.vq-promo-cta')
    const close = card.querySelector('.vq-promo-close')
    const copy = card.querySelector('.vq-promo-copy')
    const title = card.querySelector('.vq-promo-title')
    const cr = box(copy)
    const kr = box(close)
    const after = getComputedStyle(cta, '::after')
    return {
      id: card.getAttribute('data-promo-id'),
      title: title ? title.textContent.trim() : null,
      leaving: card.classList.contains('is-leaving'),
      transform: getComputedStyle(card).transform,
      ctaTransform: getComputedStyle(cta).transform,
      card: box(card),
      copy: cr,
      close: kr,
      hotAtCopy: hit(cr.l + Math.round(cr.w / 2), cr.t + Math.round(cr.h / 2)),
      hotAtClose: hit(kr.l + Math.round(kr.w / 2), kr.t + Math.round(kr.h / 2)),
      afterPosition: after.position,
      afterTop: after.top,
      afterLeft: after.left,
    }
  })
  const bar = document.querySelector('.vq-promo-undo')
  const label = document.querySelector('.vq-promo-undo-text')
  const button = document.querySelector('.vq-promo-undo-button')
  return {
    cards: cards,
    bar: bar ? {
      text: String(bar.textContent || '').replace(/\s+/g, ' ').trim(),
      label: label ? label.textContent.trim() : null,
      role: label ? label.getAttribute('role') : null,
      leaving: bar.classList.contains('is-leaving'),
      box: box(bar),
      disabled: button ? Boolean(button.disabled) : null,
    } : null,
    dismissed: (function () {
      try { return JSON.parse(window.localStorage.getItem('vq_promos_dismissed') || '[]') } catch { return 'bad-json' }
    })(),
    hash: window.location.hash,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }
}

const screenshots = []

async function openPage(hashPath, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Page.navigate', { url: BASE + '/?shot=' + Date.now() + '#' + hashPath })
  await sleep(1700)
}
const CARDS = 'document.querySelectorAll(".vq-promo").length'
const COPY = 'document.querySelectorAll(".vq-promo")[0].querySelector(".vq-promo-copy")'
const UNDO_BTN = 'document.querySelector(".vq-promo-undo-button")'
const cardSel = (id) => 'document.querySelector(\'.vq-promo[data-promo-id="' + id + '"]\')'

async function closeAll(ids, label) {
  for (const id of ids) {
    await waitForExpr('Boolean(' + cardSel(id) + ')', label + '：' + id + ' 在', 120, 100)
    await clickExpr(cardSel(id) + '.querySelector(".vq-promo-close")', label + ' 关掉 ' + id)
    await waitForExpr('!' + cardSel(id), label + '：' + id + ' 收掉', 140, 60)
  }
}

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const headers = { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token }

  // 种子：引导做完但不建资产（工作台首屏会有上手引导遮罩，先按 r325 的做法标记已看）
  await fetch(BASE + '/api/onboarding', { method: 'PUT', headers: headers, body: JSON.stringify({ identity: 'creator', category: '美妆个护' }) })
  await fetch(BASE + '/api/onboarding/complete', { method: 'POST', headers: headers, body: JSON.stringify({ skipAssets: true }) })

  const served = await fetch(BASE + '/api/promos', { headers: headers }).then((response) => response.json())
  const overview = (served.promos || []).filter((item) => item.placement === 'overview' && !item.internal)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
  const top = overview[0]
  const second = overview[1]
  const shown = overview.slice(0, 2).map((item) => item.id)
  const total = overview.length
  note('服务端的工作台运营位（按权重）', { ids: overview.map((item) => item.id), top: top && top.id, page: top && top.page, total: total })

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
  // 记下每一个真的发生的 click：命中测试对不对，和「有没有派发 click」是两件事，分开看
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}" +
      "try{window.__clicks=[];document.addEventListener('click',function(e){var t=e.target;window.__clicks.push(String((t&&t.tagName)||'')+'.'+String((t&&t.className)||''))},true)}catch(e){}",
  })

  // ---- 1) 1440：整卡可点 ----
  await openPage('/overview', 1440, 1000)
  await waitForExpr(CARDS + ' === ' + shown.length, '工作台上运营位都渲染出来（' + shown.length + ' 张）', 100, 150)
  const copyRect = await rectOf(COPY)
  await moveTo(copyRect.cx, copyRect.cy)
  await sleep(320)
  const hovered = await evaluate('(' + readPromoBits.toString() + ')()')
  screenshots.push(await shot('r326-promo-hover-1440.png', 1440, 1000))
  note('光标停在卡片正文上', { transform: hovered.cards[0].transform, hotAtCopy: hovered.cards[0].hotAtCopy, after: [hovered.cards[0].afterPosition, hovered.cards[0].afterTop, hovered.cards[0].afterLeft] })

  // 按下但不松开：热区必须还在。r326 里「点了没反应」的根因就在这里——
  // 全站按钮的按下反馈是 1px 位移，而带 transform 的元素会成为绝对定位后代的包含块，
  // 于是按住的一瞬间 ::after 从「整张卡片」缩成「按钮自己」：
  //   mousedown → BUTTON（热区还在）· mouseup → H3.vq-promo-title（热区没了）· click → ARTICLE（共同祖先）
  const pressRect = await rectOf(COPY)
  await moveTo(pressRect.cx, pressRect.cy)
  await sleep(250)
  await evaluate('window.__clicks = []; true')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pressRect.cx, y: pressRect.cy, button: 'left', clickCount: 1 })
  await sleep(220)
  const pressed = await evaluate('(' + readPromoBits.toString() + ')()')
  note('按住不放时', { hotAtCopy: pressed.cards[0].hotAtCopy, ctaTransform: pressed.cards[0].ctaTransform })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pressRect.cx, y: pressRect.cy, button: 'left', clickCount: 1 })
  await sleep(600)
  const afterCardClick = await evaluate('(' + readPromoBits.toString() + ')()')
  const clickLog = await evaluate('window.__clicks.slice()')
  note('点卡片正文之后', { hash: afterCardClick.hash, expected: '#/' + top.page, clicks: clickLog })

  // 对照：脚本直接点按钮一次（绕过命中测试）。能跳说明 onClick 本身没坏，
  // 那这条链路要查的就只剩「热区有没有铺到正文上」。上一步已经跳到运营位指的那一页了，先回来。
  await openPage('/overview', 1440, 1000)
  await waitForExpr(CARDS + ' === ' + shown.length, '对照那一步之前先回工作台', 100, 150)
  await evaluate('window.__clicks = []; document.querySelector(".vq-promo-cta").click(); true')
  await sleep(700)
  const afterProgrammatic = await evaluate('({ hash: window.location.hash, clicks: window.__clicks.slice() })')
  note('脚本点 CTA 之后', afterProgrammatic)

  // ---- 2) 1440：点 ✕ 不会跳走，关掉之后能撤 ----
  await openPage('/overview', 1440, 1000)
  await waitForExpr(CARDS + ' === ' + shown.length, '回工作台还是一整排', 100, 150)
  await clickExpr(cardSel(top.id) + '.querySelector(".vq-promo-close")', '第一条的 ✕')
  const hashRightAfterClose = await evaluate('window.location.hash')
  await waitForExpr('(' + readPromoBits.toString() + ')().bar', '撤销条出现', 120, 60)
  await sleep(320)
  const undoOne = await evaluate('(' + readPromoBits.toString() + ')()')
  screenshots.push(await shot('r326-promo-undo-1440.png', 1440, 1000))
  note('关掉一条之后', { hash: hashRightAfterClose, bar: undoOne.bar, dismissed: undoOne.dismissed, cards: undoOne.cards.map((item) => item.id), shown: shown })

  await clickExpr(UNDO_BTN, '撤销')
  await waitForExpr(CARDS + ' === ' + shown.length, '撤销之后又是两条在位上', 120, 100)
  await waitForExpr('!document.querySelector(".vq-promo-undo")', '撤销条收掉', 120, 100)
  const afterUndo = await evaluate('(' + readPromoBits.toString() + ')()')
  note('撤销之后', { cards: afterUndo.cards.map((item) => item.id), dismissed: afterUndo.dismissed })

  // ---- 3) 1440：一条条关到空，条子也不走 ----
  await closeAll(overview.map((item) => item.id), '1440')
  await sleep(320)
  const allClosed = await evaluate('(' + readPromoBits.toString() + ')()')
  screenshots.push(await shot('r326-promo-undo-all-1440.png', 1440, 1000))
  const stickyWaitMs = 9500
  await sleep(stickyWaitMs)
  const stillThere = await evaluate('(' + readPromoBits.toString() + ')()')
  note('槽空了之后等了 ' + stickyWaitMs + 'ms', { bar: stillThere.bar && stillThere.bar.label, cards: stillThere.cards.length, dismissed: stillThere.dismissed })

  // ---- 4) 390：同一件事在窄屏上也成立 ----
  await evaluate('window.localStorage.removeItem("vq_promos_dismissed"); true')
  await openPage('/overview', 390, 844)
  await waitForExpr(CARDS + ' === ' + shown.length, '390 上运营位都在', 100, 150)
  await closeAll(overview.map((item) => item.id), '390')
  await sleep(350)
  const narrow = await evaluate('(' + readPromoBits.toString() + ')()')
  screenshots.push(await shot('r326-promo-undo-all-390.png', 390, 844))
  note('390 槽空了', { bar: narrow.bar && narrow.bar.label, scrollWidth: narrow.scrollWidth, clientWidth: narrow.clientWidth })

  // ---- 5) 撤销窗口：光标停在条上不走；移开之后 8 秒退场；刷新后关掉的仍然不在 ----
  await evaluate('window.localStorage.removeItem("vq_promos_dismissed"); true')
  await openPage('/overview', 1440, 1000)
  await waitForExpr(CARDS + ' === ' + shown.length, '最后一段：整排在位', 100, 150)
  await clickExpr(cardSel(top.id) + '.querySelector(".vq-promo-close")', '关掉一条（看窗口）')
  const windowBar = await waitForExpr('(' + readPromoBits.toString() + ')().bar', '撤销条出现（看窗口）', 120, 60)
  const barRect = windowBar.box
  await moveTo(barRect.l + Math.round(barRect.w / 2), barRect.t + Math.round(barRect.h / 2))
  const holdMs = 8500
  await sleep(holdMs)
  const heldBits = await evaluate('(' + readPromoBits.toString() + ')()')
  note('光标停在条上 ' + holdMs + 'ms', { bar: heldBits.bar && heldBits.bar.label, leaving: heldBits.bar && heldBits.bar.leaving })
  await moveTo(6, 6)
  const exitStart = Date.now()
  let autoExitMs = null
  try {
    await waitForExpr('!document.querySelector(".vq-promo-undo")', '条子自己退场', 90, 150)
    autoExitMs = Date.now() - exitStart
  } catch (error) {
    note('退场没等到', { error: String(error && error.message) })
  }
  const afterExit = await evaluate('(' + readPromoBits.toString() + ')()')
  await openPage('/overview', 1440, 1000)
  await waitForExpr(CARDS + ' >= ' + (shown.length - 1), '刷新之后', 100, 150)
  const afterReload = await evaluate('(' + readPromoBits.toString() + ')()')
  note('移开光标之后', { autoExitMs: autoExitMs, dismissed: afterExit.dismissed, cardsBeforeReload: afterExit.cards.length, cardsAfterReload: afterReload.cards.map((item) => item.id) })

  // ---- 断言 ----
  const versionBits = await evaluate('(() => { const scripts = Array.prototype.map.call(document.querySelectorAll("script[src]"), (n) => String(n.getAttribute("src")).split("/").pop()).filter((n) => n && n.indexOf("index-") === 0); const label = document.querySelector(".vq-version-label"); return { scripts: scripts, sidebarVersion: label ? label.textContent.trim() : null } })()')
  const versionApi = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  note('入口与版本', { loaded: versionBits.scripts, expected: EXPECT_ENTRY, api: versionApi && versionApi.version, sidebar: versionBits.sidebarVersion })
  check('0.1 页面脚本来自这一轮构建的入口（' + EXPECT_ENTRY + '）', Boolean(EXPECT_ENTRY) && (versionBits.scripts || []).indexOf(EXPECT_ENTRY) >= 0, { loaded: versionBits.scripts })
  check('0.2 侧栏版本号是 v' + EXPECT_VERSION + ' 且 /api/version 一致', versionBits.sidebarVersion === 'v' + EXPECT_VERSION && Boolean(versionApi) && versionApi.version === EXPECT_VERSION, { sidebar: versionBits.sidebarVersion, api: versionApi && versionApi.version })

  check('1.1 卡片正文正中间落到的是 CTA 热区（不是正文自己）', hovered.cards[0] && hovered.cards[0].hotAtCopy === 'cta', { hotAtCopy: hovered.cards[0] && hovered.cards[0].hotAtCopy })
  check('1.2 热区是铺满卡片的 ::after（absolute，四边贴住卡片）', hovered.cards[0] && hovered.cards[0].afterPosition === 'absolute' && hovered.cards[0].afterTop === '0px' && hovered.cards[0].afterLeft === '0px', {
    position: hovered.cards[0] && hovered.cards[0].afterPosition, top: hovered.cards[0] && hovered.cards[0].afterTop, left: hovered.cards[0] && hovered.cards[0].afterLeft,
  })
  check('1.3 卡片悬停仍然抬起 2px（热区没把抬起吃掉）', hovered.cards[0] && hovered.cards[0].transform === 'matrix(1, 0, 0, 1, 0, -2)', { transform: hovered.cards[0] && hovered.cards[0].transform })
  check('1.4 点卡片正文真的会跳页（' + top.id + ' → #/' + top.page + '），click 落在按钮上', afterCardClick.hash === '#/' + top.page && (clickLog || []).some((item) => String(item).indexOf('vq-promo-cta') >= 0), { hash: afterCardClick.hash, clicks: clickLog })
  check('1.6 按住不放时热区还在（按下时不会塌成按钮那么大——「点了没反应」的根因）', Boolean(pressed.cards[0]) && pressed.cards[0].hotAtCopy === 'cta' && pressed.cards[0].ctaTransform === 'none', {
    hotAtCopy: pressed.cards[0] && pressed.cards[0].hotAtCopy, ctaTransform: pressed.cards[0] && pressed.cards[0].ctaTransform,
  })
  check('1.5 脚本直接点 CTA 也会跳（onClick 本身没坏，坏的只可能是命中测试）', afterProgrammatic.hash === '#/' + top.page, afterProgrammatic)
  check('2.1 点 ✕ 不会跳走（地址仍是 #/overview）', hashRightAfterClose === '#/overview', { hash: hashRightAfterClose })
  check('2.2 关掉的那条从 DOM 里没了、后面那条补上来（' + shown.join(' / ') + ' → ' + undoOne.cards.map((item) => item.id).join(' / ') + '）', undoOne.cards.every((item) => item.id !== top.id) && undoOne.cards.length === shown.length && undoOne.cards[0].id === second.id, {
    cards: undoOne.cards.map((item) => item.id),
  })
  check('2.3 撤销条出现、文案是「已关掉「' + top.title + '」」、用 status 播报', Boolean(undoOne.bar) && undoOne.bar.label === '已关掉「' + top.title + '」' && undoOne.bar.role === 'status', {
    label: undoOne.bar && undoOne.bar.label, role: undoOne.bar && undoOne.bar.role,
  })
  check('2.4 关掉真的写进了本地（vq_promos_dismissed 里有 ' + top.id + '）', Array.isArray(undoOne.dismissed) && undoOne.dismissed.indexOf(top.id) >= 0, { dismissed: undoOne.dismissed })
  check('2.5 撤销之后卡片回到原位（第 1 条又是 ' + top.id + '），本地记录也清空、条子消失', afterUndo.cards.length === shown.length && afterUndo.cards[0].id === top.id && Array.isArray(afterUndo.dismissed) && afterUndo.dismissed.length === 0 && !afterUndo.bar, {
    cards: afterUndo.cards.map((item) => item.id), dismissed: afterUndo.dismissed,
  })
  check('3.1 一条条关到空：文案是「已关掉 ' + total + ' 条动态」、槽里一条不剩', Boolean(allClosed.bar) && allClosed.bar.label === '已关掉 ' + total + ' 条动态' && allClosed.cards.length === 0, {
    label: allClosed.bar && allClosed.bar.label, cards: allClosed.cards.length,
  })
  check('3.2 槽被关空了条子也不退场（等了 ' + stickyWaitMs + 'ms 后还在，这是唯一能撤销的时候）', Boolean(stillThere.bar) && stillThere.bar.leaving === false && stillThere.bar.label === '已关掉 ' + total + ' 条动态', {
    label: stillThere.bar && stillThere.bar.label, leaving: stillThere.bar && stillThere.bar.leaving,
  })
  check('4.1 390 上同样能关到槽空，条子还在、文案不变', Boolean(narrow.bar) && narrow.bar.label === '已关掉 ' + total + ' 条动态' && narrow.cards.length === 0, { label: narrow.bar && narrow.bar.label })
  check('4.2 390 上没有横向溢出（scrollWidth == clientWidth == 390）', narrow.scrollWidth === 390 && narrow.clientWidth === 390, { scrollWidth: narrow.scrollWidth, clientWidth: narrow.clientWidth })
  check('5.1 光标停在条上时不退场（按住 ' + holdMs + 'ms 后还在、没进入退场）', Boolean(heldBits.bar) && heldBits.bar.leaving === false && heldBits.bar.label === '已关掉「' + top.title + '」', {
    label: heldBits.bar && heldBits.bar.label, leaving: heldBits.bar && heldBits.bar.leaving,
  })
  check('5.2 光标移开之后条子自己退场（' + (autoExitMs === null ? '没等到' : autoExitMs + 'ms') + '，窗口 ' + 8000 + 'ms）', autoExitMs !== null && autoExitMs >= 8000 && autoExitMs <= 13000, { autoExitMs: autoExitMs })
  check('5.3 退场是「就这么算了」：关掉的仍记在本地、刷新也不会自己回来', Array.isArray(afterExit.dismissed) && afterExit.dismissed.indexOf(top.id) >= 0 && afterReload.cards.every((item) => item.id !== top.id) && afterReload.cards.length === shown.length, {
    dismissed: afterExit.dismissed, afterReload: afterReload.cards.map((item) => item.id),
  })
  check('6.1 页面异常 0 条、console.error 0 条', cdp.exceptions.length === 0 && cdp.consoleErrors.length === 0, {
    exceptions: cdp.exceptions.slice(0, 3), consoleErrors: cdp.consoleErrors.slice(0, 3),
  })
  const upstreamLines = serverLog.split(/\r?\n/).filter((line) => /redfox|gateway|upstream|geteapi|seeapi/i.test(line) && line.indexOf('"t":"listen"') < 0)
  check('6.2 这一轮没有打任何上游（日志里没有上游调用）', upstreamLines.length === 0, { lines: upstreamLines.slice(0, 3) })
  check('6.3 四张图都落进了 docs/', screenshots.length === 4 && screenshots.every((item) => fs.existsSync(path.join(ROOT, item.file))), {
    files: screenshots.map((item) => item.file),
  })
} catch (error) {
  check('9.9 取证脚本自己没崩', false, { error: String((error && error.stack) || error).slice(0, 400) })
  if (cdp) {
    check('9.8 崩之前页面异常 0 条', cdp.exceptions.length === 0 && cdp.consoleErrors.length === 0, { exceptions: cdp.exceptions.slice(0, 3), consoleErrors: cdp.consoleErrors.slice(0, 3) })
  }
  if (serverLog) note('服务端日志尾部', serverLog.slice(-800))
}

const failed = checks.filter((item) => !item.ok)
const out = {
  round: 'r326',
  at: new Date().toISOString(),
  entry: EXPECT_ENTRY,
  version: EXPECT_VERSION,
  checks: checks,
  failed: failed.length,
  passed: checks.length - failed.length,
  notes: notes,
  screenshots: screenshots,
  exceptions: cdp ? cdp.exceptions : [],
  consoleErrors: cdp ? cdp.consoleErrors : [],
}
fs.writeFileSync(path.join(OUT_DIR, 'out.json'), JSON.stringify(out, null, 2))
console.log('---- r326 取证：' + out.passed + '/' + checks.length + ' 通过 ----')

try { chrome.kill() } catch { /* 已经退出 */ }
try { server.kill() } catch { /* 已经退出 */ }
await sleep(300)
try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 同上 */ }
process.exit(failed.length ? 1 : 0)
