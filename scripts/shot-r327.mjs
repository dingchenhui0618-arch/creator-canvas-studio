// r327 独立取证：注册后的第一屏（身份引导弹窗）的手感与可操作性。
//
// 背景：这个弹窗是「账号 + 引导没做完」时自己出现的整屏阻塞层——第一步没有关闭入口、
// Esc 也被拦掉，用户看到的第一个界面就是它。r326 的经验是「编译、样式、单测都看不出、
// 真在页面上按一下才知道」，所以这一轮同样只量真页面：
//
//   1) 进场：卡片与遮罩是不是「啪」一下就出现（别的弹窗都有进场，这一屏反而没有）
//   2) 焦点：打开之后焦点在哪；按 Tab 会不会走到遮罩后面的侧栏上（那时背景是点不动的）
//   3) 换步：点「继续」之后内容是淡上来还是硬切；打开时的第一步不该动两次
//   4) 窄屏 390：同一套还在、不横向溢出
//
// 动效怎么量（r325 的教训）：headless 里 rAF 只在「真有帧被产出」时才走（截图/输入会催帧），
// 按帧采样会时有时无。这里改用确定性的办法——把动画按 CSS 重来一次，立刻 pause()，
// 读的就是第 0 帧的计算值（卡片该是半透明、还在上浮 4px）。暂停完再 play() 放回去。
//
// 与 shot-r326 同一套做法：临时 DATA_DIR + 真 SQLite + 真账号 + 空闲端口 + headless Chrome/CDP。
// 不碰 src/**、不重新 build：只量 dist 里那份构建产物。
//
// 用法：node scripts/shot-r327.mjs
// 产物：.shots327/out.json + docs/r327-gate-frame0-1440.png / -1440.png / -step2-1440.png / -390.png
// 退出码 1 = 有断言没过（数字照样写进 out.json）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, '.shots327')
const DOCS = path.join(ROOT, 'docs')
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 SHOT_CHROME 指定）')
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(DOCS, { recursive: true })

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

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8997))
const DEBUG_PORT = await freePort(API_PORT + 60)
const BASE = 'http://127.0.0.1:' + API_PORT
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot327-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot327-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

// 先建管理员：库里没有管理员时服务启动会把第一个用户提成管理员，引导弹窗就只对账号弹了
createUser({ email: 'shot327-admin' + AT + 'shot.test', password: PASSWORD, name: '运维', kind: 'admin' })
const account = createUser({ email: 'shot327-user' + AT + 'shot.test', password: PASSWORD, name: '新账号', kind: 'account' })
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
  await sleep(160)
  const rect = await rectOf(expression)
  if (!rect) throw new Error('点不到：' + (label || expression))
  await moveTo(rect.cx, rect.cy)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.cx, y: rect.cy, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.cx, y: rect.cy, button: 'left', clickCount: 1 })
  await sleep(140)
  return rect
}
async function pressTab() {
  const params = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, params))
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, params))
  await sleep(110)
}
async function openPage(hash, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: BASE + '/' + (hash.charAt(0) === '#' ? hash : '#' + hash) })
  await sleep(700)
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
function readGate() {
  const card = document.querySelector('.vq-gate-card')
  const backdrop = document.querySelector('.vq-gate-backdrop')
  const body = document.querySelector('.vq-gate-body')
  const box = function (el) {
    const r = el.getBoundingClientRect()
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom) }
  }
  const describe = function (el) {
    if (!el) return null
    return String(el.tagName) + '.' + String(el.className || '').split(' ').slice(0, 2).join('.')
  }
  const inGate = function (el) {
    if (!el || !card) return false
    return el === card || card.contains(el)
  }
  const active = document.activeElement
  const current = document.querySelector('.vq-gate-step.is-current')
  return {
    visible: Boolean(card),
    card: card ? box(card) : null,
    backdropOpacity: backdrop ? getComputedStyle(backdrop).opacity : null,
    backdropAnimation: backdrop ? getComputedStyle(backdrop).animationName : null,
    cardAnimation: card ? getComputedStyle(card).animationName : null,
    stepBodyClass: body ? String(body.className) : null,
    cardFocused: Boolean(card && card === active),
    active: describe(active),
    activeInGate: inGate(active),
    bodyOverflow: document.body.style.overflow,
    step: current ? current.textContent.replace(/[0-9\s]/g, '') : null,
    identities: Array.prototype.map.call(document.querySelectorAll('.vq-gate-choice strong'), function (n) { return n.textContent.trim() }),
    step1PrimaryDisabled: (function () {
      const b = document.querySelector('.vq-gate-foot .vq-button--primary')
      return b ? b.disabled : null
    })(),
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    gateScrollWidth: card ? card.scrollWidth : null,
    gateClientWidth: card ? card.clientWidth : null,
  }
}

/**
 * 确定性地看某几个元素的「第 0 帧」：把动画按 CSS 重来一遍，立刻 pause()，
 * 这时 getComputedStyle 读到的就是动画起点（不是运行中途的随机一帧）。
 */
function frame0Probe(selectors) {
  const els = selectors.map(function (s) { return document.querySelector(s) }).filter(Boolean)
  const declared = els.map(function (el) {
    return { animation: getComputedStyle(el).animationName, opacity: getComputedStyle(el).opacity }
  })
  els.forEach(function (el) { el.style.animation = 'none' })
  void document.body.offsetWidth
  els.forEach(function (el) { el.style.animation = '' })
  els.forEach(function (el) {
    el.getAnimations().forEach(function (a) { a.pause() })
  })
  const at0 = els.map(function (el) {
    const cs = getComputedStyle(el)
    return {
      opacity: cs.opacity,
      transform: cs.transform,
      animations: el.getAnimations().map(function (a) { return a.animationName || 'anim' }),
    }
  })
  return { declared: declared, at0: at0 }
}

const RESUME = 'document.getAnimations().forEach(function (a) { a.play() })'

const screenshots = []
try {
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
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })
  // 上手引导（WelcomeGuide）与移动端提示都先标成看过：这一轮只量身份引导
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}",
  })

  // ---- 1) 1440：打开第一屏 ----
  await openPage('/overview', 1440, 1000)
  await waitForExpr('Boolean(document.querySelector(".vq-gate-card"))', '身份引导弹窗出现', 120, 150)
  await sleep(360)
  const opened = await evaluate('(' + readGate.toString() + ')()')
  const cardFrame0 = await evaluate('(' + frame0Probe.toString() + ')([".vq-gate-card", ".vq-gate-backdrop"])')
  screenshots.push(await shot('r327-gate-frame0-1440.png', 1440, 1000))
  await evaluate(RESUME)
  await sleep(320)
  screenshots.push(await shot('r327-gate-1440.png', 1440, 1000))
  note('打开之后', {
    step: opened.step, identities: opened.identities, active: opened.active, activeInGate: opened.activeInGate,
    cardAnimation: opened.cardAnimation, backdropAnimation: opened.backdropAnimation,
    stepBodyClass: opened.stepBodyClass, bodyOverflow: opened.bodyOverflow,
  })
  note('卡片与遮罩的第 0 帧（把动画重来一次后 pause 住读的）', cardFrame0)

  // ---- 2) 键盘：焦点在不在弹窗里，Tab 能不能跑出去 ----
  const tabTrail = []
  for (let i = 0; i < 10; i += 1) {
    await pressTab()
    const bits = await evaluate('(' + readGate.toString() + ')()')
    tabTrail.push(bits.active + ' | inGate=' + bits.activeInGate)
  }
  const tabState = await evaluate('(' + readGate.toString() + ')()')
  note('Tab 十次之后的焦点轨迹', tabTrail)

  // Esc 关不掉（这一步是设计如此：第一步没有关闭入口）
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await sleep(300)
  const afterEsc = await evaluate('(' + readGate.toString() + ')()')

  // Shift+Tab 从第一格往回也应该绕到最后一格（不是走到背景里）
  const shiftParams = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 8 }
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, shiftParams))
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, shiftParams))
  await sleep(150)
  const afterShiftTab = await evaluate('(' + readGate.toString() + ')()')
  note('Shift+Tab 一次之后', { active: afterShiftTab.active, activeInGate: afterShiftTab.activeInGate })

  // ---- 3) 选身份 → 继续：看第二步怎么进来 ----
  await clickExpr('document.querySelector(".vq-gate-choice")', '第一个身份')
  const chosen = await evaluate('(' + readGate.toString() + ')()')
  await clickExpr('document.querySelector(".vq-gate-foot .vq-button--primary")', '继续')
  await waitForExpr('(' + readGate.toString() + ')().step === "类目"', '走到第二步', 80, 150)
  await sleep(120)
  const stepBodyFrame0 = await evaluate('(' + frame0Probe.toString() + ')([".vq-gate-body"])')
  await evaluate(RESUME)
  await sleep(320)
  const stepTwo = await evaluate('(' + readGate.toString() + ')()')
  screenshots.push(await shot('r327-gate-step2-1440.png', 1440, 1000))
  note('第二步', { step: stepTwo.step, stepBodyClass: stepTwo.stepBodyClass, active: stepTwo.active, activeInGate: stepTwo.activeInGate })
  note('第二步内容的第 0 帧', stepBodyFrame0)

  // 第二步的键盘焦点也要留在弹窗里
  const tabTrail2 = []
  for (let i = 0; i < 12; i += 1) {
    await pressTab()
    const bits = await evaluate('(' + readGate.toString() + ')()')
    tabTrail2.push(bits.active + ' | inGate=' + bits.activeInGate)
  }
  note('第二步 Tab 十二次之后的焦点轨迹', tabTrail2)

  // ---- 4) 390：同一件事在窄屏成立 ----
  await openPage('/overview', 390, 844)
  await waitForExpr('Boolean(document.querySelector(".vq-gate-card"))', '390 上弹窗出现', 120, 150)
  await sleep(420)
  const narrow = await evaluate('(' + readGate.toString() + ')()')
  screenshots.push(await shot('r327-gate-390.png', 390, 844))
  note('390 上', { card: narrow.card, scrollWidth: narrow.scrollWidth, clientWidth: narrow.clientWidth, gateScrollWidth: narrow.gateScrollWidth, gateClientWidth: narrow.gateClientWidth })

  // ---- 断言 ----
  const versionBits = await evaluate('(() => { const scripts = Array.prototype.map.call(document.querySelectorAll("script[src]"), (n) => String(n.getAttribute("src")).split("/").pop()).filter((n) => n && n.indexOf("index-") === 0); return { scripts: scripts } })()')
  const versionApi = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  note('入口与版本', { loaded: versionBits.scripts, expected: EXPECT_ENTRY, api: versionApi && versionApi.version })
  check('0.1 页面脚本来自这一轮构建的入口（' + EXPECT_ENTRY + '）', Boolean(EXPECT_ENTRY) && (versionBits.scripts || []).indexOf(EXPECT_ENTRY) >= 0, { loaded: versionBits.scripts })
  check('0.2 /api/version 与 package.json 一致（v' + EXPECT_VERSION + '）', Boolean(versionApi) && versionApi.version === EXPECT_VERSION, { api: versionApi && versionApi.version })

  check('1.1 账号第一次进来就是第一步（身份），两个必需身份都在（自媒体创作者 / 电商产品生产）', opened.visible && opened.step === '身份' && opened.identities.indexOf('自媒体创作者') >= 0 && opened.identities.indexOf('电商产品生产') >= 0, { step: opened.step, identities: opened.identities })
  check('1.2 第一步的「继续」在没选身份时是禁用的（不给一个点了没反应的按钮）', opened.step1PrimaryDisabled === true, { disabled: opened.step1PrimaryDisabled })
  check('1.3 背景滚动被锁住（body overflow hidden）', opened.bodyOverflow === 'hidden', { bodyOverflow: opened.bodyOverflow })

  const cardAt0 = cardFrame0.at0[0]
  const backdropAt0 = cardFrame0.at0[1]
  check('2.1 卡片有进场：animation-name = ' + (cardFrame0.declared[0] && cardFrame0.declared[0].animation) + '，第 0 帧是半透明 + 上浮 4px', cardAt0 && cardAt0.animations.indexOf('vq-rise') >= 0 && Number(cardAt0.opacity) < 0.5 && String(cardAt0.transform).indexOf('4') >= 0, { at0: cardAt0 })
  check('2.2 遮罩是淡进来的：animation-name = ' + (cardFrame0.declared[1] && cardFrame0.declared[1].animation) + '，第 0 帧 opacity 0', backdropAt0 && backdropAt0.animations.indexOf('vq-fade') >= 0 && Number(backdropAt0.opacity) < 0.1, { at0: backdropAt0 })
  check('2.3 打开时的第一步内容不跟着放（不然卡片和内容两层一起上浮会显得晃）', Boolean(opened.stepBodyClass) && opened.stepBodyClass.indexOf('is-step-in') < 0, { stepBodyClass: opened.stepBodyClass })

  check('3.1 打开之后焦点就在弹窗里（落在卡片上，不是留在遮罩后面的页面上）', opened.activeInGate === true && opened.cardFocused === true, { active: opened.active, inGate: opened.activeInGate, cardFocused: opened.cardFocused })
  const escaped = tabTrail.filter((line) => line.indexOf('inGate=false') >= 0)
  check('3.2 连按 Tab 十次都不会跑到遮罩后面（跑出去 ' + escaped.length + ' 次）', escaped.length === 0 && tabState.activeInGate === true, { first: tabTrail.slice(0, 6), escaped: escaped.length })
  check('3.3 Shift+Tab 从第一格往回绕，也不出弹窗', afterShiftTab.activeInGate === true, { active: afterShiftTab.active })
  check('3.4 Esc 关不掉这一步（设计如此：第一步没有关闭入口）', afterEsc.visible === true, { visible: afterEsc.visible })
  check('3.5 选完身份之后焦点仍在弹窗里', chosen.activeInGate === true, { active: chosen.active })

  const stepAt0 = stepBodyFrame0.at0[0]
  check('4.1 点「继续」之后第二步内容是淡上来的，不是硬切（换到第二步后 .vq-gate-body 带 is-step-in，第 0 帧 opacity 0）', Boolean(stepTwo.stepBodyClass) && stepTwo.stepBodyClass.indexOf('is-step-in') >= 0 && stepAt0 && stepAt0.animations.indexOf('vq-rise') >= 0 && Number(stepAt0.opacity) < 0.5, { stepBodyClass: stepTwo.stepBodyClass, at0: stepAt0 })
  check('4.3 换步之后焦点不会掉到遮罩后面（点「继续」那颗按钮被换掉了，焦点要收回到卡片上）', stepTwo.activeInGate === true && stepTwo.cardFocused === true, { active: stepTwo.active, cardFocused: stepTwo.cardFocused })
  check('4.2 第二步按 Tab 也跑不出弹窗', tabTrail2.filter((line) => line.indexOf('inGate=false') >= 0).length === 0, { trail: tabTrail2.slice(0, 6) })
  check('5.1 390 上弹窗还在、卡片不超过视口', narrow.visible === true && Boolean(narrow.card) && narrow.card.l >= 0 && narrow.card.l + narrow.card.w <= 390, { card: narrow.card })
  check('5.2 390 上没有横向溢出（scrollWidth == clientWidth == 390）', narrow.scrollWidth === 390 && narrow.clientWidth === 390 && narrow.gateScrollWidth <= narrow.gateClientWidth + 1, { scrollWidth: narrow.scrollWidth, clientWidth: narrow.clientWidth, gateScrollWidth: narrow.gateScrollWidth, gateClientWidth: narrow.gateClientWidth })
  check('6.1 页面异常 0 条、console.error 0 条', cdp.exceptions.length === 0 && cdp.consoleErrors.length === 0, { exceptions: cdp.exceptions.slice(0, 3), consoleErrors: cdp.consoleErrors.slice(0, 3) })
  const upstreamLines = serverLog.split(/\r?\n/).filter((line) => /redfox|gateway|upstream|geteapi|seeapi/i.test(line) && line.indexOf('"t":"listen"') < 0)
  check('6.2 这一轮没有打任何上游（日志里没有上游调用）', upstreamLines.length === 0, { lines: upstreamLines.slice(0, 3) })
  check('6.3 四张图都落进了 docs/', screenshots.length === 4 && screenshots.every((item) => fs.existsSync(path.join(ROOT, item.file))), { files: screenshots.map((item) => item.file) })
} catch (error) {
  check('9.9 取证脚本自己没崩', false, { error: String((error && error.stack) || error).slice(0, 400) })
  if (cdp) {
    check('9.8 崩之前页面异常 0 条', cdp.exceptions.length === 0 && cdp.consoleErrors.length === 0, { exceptions: cdp.exceptions.slice(0, 3), consoleErrors: cdp.consoleErrors.slice(0, 3) })
  }
  if (serverLog) note('服务端日志尾部', serverLog.slice(-800))
}

const failed = checks.filter((item) => !item.ok)
const out = {
  round: 'r327',
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
console.log('---- r327 取证：' + out.passed + '/' + checks.length + ' 通过 ----')

try { chrome.kill() } catch { /* 已经退出 */ }
try { server.kill() } catch { /* 已经退出 */ }
await sleep(300)
try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 同上 */ }
process.exit(failed.length ? 1 : 0)
