// r325 独立取证：提示条的语气（ok / fail / info）在真页面上长什么样。
//
// 与 shot-r324 同一套做法：临时 DATA_DIR + 真 SQLite + 真账号 + 空闲端口 + headless Chrome/CDP。
// 不碰 src/**、不重新 build：只量 dist 里已经构建好的那一份（入口从 dist/index.html 里读，
// 版本从 package.json 读，所以「量的就是这一轮要发的那份」）。
//
// 量三件事：
//   1) 三种语气都真出现过，而且**形状不同**（不是同一个对勾换颜色）：
//      ok → Check（白）· fail → X（浅红）· info → Info（半透明白）
//   2) 失败那条用 alert 播报、其余用 status；图标对读屏隐藏，读屏只听到文案本身
//   3) 失败色在 #111 底上的对比度够（自己按 WCAG 算一遍），窄屏下语气照旧、不越界
//
// 用法：node scripts/shot-r325.mjs
// 产物：.shots325/out.json + docs/r325-toast-ok-1440.png / -fail-1440.png / -info-1440.png / -fail-390.png
// 退出码 1 = 有断言没过（数字照样写进 out.json）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, '.shots325')
const DOCS = path.join(ROOT, 'docs')
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 SHOT_CHROME 指定）')
fs.mkdirSync(OUT_DIR, { recursive: true })

// 这一轮要发的那份产物：入口从 dist/index.html 里读，版本从 package.json 里读
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

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8998))
const DEBUG_PORT = await freePort(API_PORT + 60)
const BASE = 'http://127.0.0.1:' + API_PORT
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot325-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot325-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const MAIL = 'shot325-user' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

// 先建管理员：库里没有管理员时，服务启动会把第一个用户提成管理员，那会改掉普通账号这条路径
const adminUser = createUser({ email: 'shot325-admin' + AT + 'shot.test', password: PASSWORD, name: '运维', kind: 'admin' })
const account = createUser({ email: MAIL, password: PASSWORD, name: '取证账号', kind: 'account' })
const token = createSession(account, {}).token
const adminToken = createSession(adminUser, {}).token
// 390 那一段要的是「进工作台自动弹的那条长提示」，而它一个账号只会弹一次：
// 前两段已经把这条用掉了，所以窄屏单独开一个同样状态（引导做完、还没建资产）的账号。
const narrowAccount = createUser({ email: 'shot325-narrow' + AT + 'shot.test', password: PASSWORD, name: '窄屏取证', kind: 'account' })
const narrowToken = createSession(narrowAccount, {}).token

// 只看不点的探针：把每条提示挂上/收尾/卸载的时序记下来（进页面自动弹的那条也抓得到）
const WATCH_SOURCE = [
  '(function () {',
  '  window.__toastLog = [];',
  '  var now = function () { return Math.round(performance.now()) };',
  '  var rec = function (kind, el) {',
  '    window.__toastLog.push({ kind: kind, at: now(), text: String(el.textContent || "").trim(), cls: String(el.className || "") });',
  '  };',
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
  '        }',
  '      }',
  '    });',
  '    observer.observe(document.documentElement, { childList: true, subtree: true });',
  '  };',
  '  attach();',
  '})();',
].join('\n')

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
async function clickExpr(expression, label) {
  await evaluate('(() => { const el = (' + expression + '); if (!el) return false; el.scrollIntoView({ block: "center", behavior: "instant" }); return true })()')
  await sleep(200)
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
    await cdp.send('Input.dispatchKeyEvent', { type: type, modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  }
}
async function pressBackspace() {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type: type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  }
}
// Ctrl+Z：无限画布/工作流页的撤销（这一页的撤销栈在内存里，进页面时是空的）
async function pressCtrlZ() {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type: type, modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 })
  }
}
async function typeText(text) {
  await cdp.send('Input.insertText', { text: text })
  await sleep(150)
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
function readToastBits() {
  const el = document.querySelector('.vq-toast')
  if (!el) return null
  const mark = el.querySelector('.vq-toast-mark')
  const svg = mark ? mark.querySelector('svg') : null
  const path = svg ? svg.querySelector('path') : null
  const box = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const markStyle = mark ? getComputedStyle(mark) : null
  // 行数按文字节点自己的 rect 数：.vq-toast 有内边距，拿高度除行高会把一条单行文案算成两行
  let lines = null
  const textNode = el.lastChild
  if (textNode && textNode.nodeType === 3) {
    const range = document.createRange()
    range.selectNodeContents(textNode)
    lines = Array.prototype.filter.call(range.getClientRects(), (box) => box.height > 2).length
  }
  return {
    text: String(el.textContent || '').trim(),
    tone: el.getAttribute('data-tone'),
    role: el.getAttribute('role'),
    markAriaHidden: mark ? mark.getAttribute('aria-hidden') : null,
    iconTag: svg ? String(svg.getAttribute('class') || '') : null,
    iconPath: path ? String(path.getAttribute('d') || '') : null,
    iconColor: markStyle ? markStyle.color : null,
    background: cs.backgroundColor,
    maxWidth: cs.maxWidth,
    lines: lines,
    rect: { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom), w: Math.round(box.width), h: Math.round(box.height) },
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    docScrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    inViewport: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
  }
}
function readVersionBits() {
  const scripts = Array.prototype.map.call(document.querySelectorAll('script[src]'), (node) => String(node.getAttribute('src')).split('/').pop()).filter((name) => name && name.indexOf('index-') === 0)
  const label = document.querySelector('.vq-version-label')
  return { scripts: scripts, sidebarVersion: label ? label.textContent.trim() : null }
}

// WCAG 相对亮度与对比度：失败色压在近黑底上，自己算一遍，不靠眼睛
function relativeLuminance(rgb) {
  const channel = (value) => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}
function parseRgb(text) {
  const match = String(text || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}
function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  const light = Math.max(a, b)
  const dark = Math.min(a, b)
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
}

const screenshots = []

async function resetWatch() {
  await evaluate('window.__toastLog = []; true')
}
async function toastGrowing(label) {
  return waitForExpr('window.__toastLog.some(function (row) { return row.kind === "added" })', label, 200, 50)
}
async function waitToastEmpty(label) {
  await waitForExpr('document.querySelectorAll(".vq-toast").length === 0', label, 400, 25)
  await sleep(120)
}
async function openPage(hashPath, width, height, edition) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Page.navigate', { url: BASE + '/?edition=' + (edition || 'user') + '&shot=' + Date.now() + '#' + hashPath })
  await sleep(1600)
}

const RENAME = 'Array.prototype.find.call(document.querySelectorAll("button"), function (b) { return b.textContent.trim() === "改名" })'
const SAVE = 'document.querySelector(".vq-assets-dialog-actions .vq-button--primary")'

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const headers = { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token }

  // 0) 种子：引导做完但不建资产（进工作台时会弹那条 29 字的提示，390 那一段用它看换行）
  const identity = await fetch(BASE + '/api/onboarding', { method: 'PUT', headers: headers, body: JSON.stringify({ identity: 'creator', category: '美妆个护' }) })
  if (!identity.ok) throw new Error('选身份失败：' + identity.status)
  const done = await fetch(BASE + '/api/onboarding/complete', { method: 'POST', headers: headers, body: JSON.stringify({ skipAssets: true }) })
  if (!done.ok) throw new Error('引导完成失败：' + done.status)
  note('引导状态', await fetch(BASE + '/api/onboarding', { headers: headers }).then((response) => response.json()))

  // 真上传一张 1×1 的合法 PNG，再照它建一套产品资产（建资产没素材图不让建）
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const uploaded = await fetch(BASE + '/api/media/assets?name=' + encodeURIComponent('取证素材图') + '&width=1&height=1', {
    method: 'POST', headers: { cookie: cfg.auth.cookieName + '=' + token, 'Content-Type': 'image/png' }, body: PNG,
  })
  const uploadedBody = await uploaded.json()
  if (!uploaded.ok || !uploadedBody.ok) throw new Error('上传素材失败：' + uploaded.status)
  const created = await fetch(BASE + '/api/assets', {
    method: 'POST', headers: headers,
    body: JSON.stringify({ kind: 'product', name: '取证用产品资产', category: '美妆个护', sourceAssetIds: [uploadedBody.asset.id] }),
  })
  const createdBody = await created.json()
  if (!created.ok || !createdBody.ok) throw new Error('建资产失败：' + created.status)
  console.log('素材与资产都建好了：' + createdBody.asset.id)

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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_welcome_seen:" + adminUser.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}" + WATCH_SOURCE,
  })

  // ---- 1) 成功那条：改名成功 → ok 语气 ----
  await openPage('/assets', 1440, 1000)
  await waitForExpr('Boolean(' + RENAME + ')', '资产卡上的改名按钮', 100, 200)
  await clickExpr(RENAME, '改名')
  await waitForExpr('Boolean(document.querySelector(".vq-asset-input"))', '改名弹窗', 80, 150)
  await evaluate('(() => { const el = document.querySelector(".vq-asset-input"); el.focus(); el.setSelectionRange(0, el.value.length); return true })()')
  await selectAll()
  await typeText('取证改名')
  const typed = await evaluate('document.querySelector(".vq-asset-input").value')
  note('改名框里写进去的名字', { typed: typed })
  await waitToastEmpty('起手先等屏幕上干净')
  await resetWatch()
  await clickExpr(SAVE, '保存（成功）')
  await toastGrowing('成功提示条')
  await sleep(250)
  const okBits = await evaluate('(' + readToastBits.toString() + ')()')
  screenshots.push(await shot('r325-toast-ok-1440.png', 1440, 1000))
  note('成功那条', { bits: okBits })
  await waitToastEmpty('成功提示条卸载')

  // ---- 2) 失败那条：名字清空再保存 → fail 语气 ----
  await waitForExpr('Boolean(' + RENAME + ')', '改名按钮还在', 80, 200)
  await clickExpr(RENAME, '改名（清空）')
  await waitForExpr('Boolean(document.querySelector(".vq-asset-input"))', '改名弹窗（第二次）', 80, 150)
  await selectAll()
  await pressBackspace()
  await sleep(200)
  const cleared = await evaluate('document.querySelector(".vq-asset-input").value')
  await resetWatch()
  await clickExpr(SAVE, '保存（失败）')
  await toastGrowing('失败提示条')
  await sleep(250)
  const failBits = await evaluate('(' + readToastBits.toString() + ')()')
  screenshots.push(await shot('r325-toast-fail-1440.png', 1440, 1000))
  note('失败那条', { bits: failBits, cleared: cleared })
  await waitToastEmpty('失败提示条卸载')

  // ---- 3) 390：长文案换行时必须把图标那一列也算进去 ----
  const narrowHeaders = { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + narrowToken }
  await fetch(BASE + '/api/onboarding', { method: 'PUT', headers: narrowHeaders, body: JSON.stringify({ identity: 'creator', category: '美妆个护' }) })
  await fetch(BASE + '/api/onboarding/complete', { method: 'POST', headers: narrowHeaders, body: JSON.stringify({ skipAssets: true }) })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + narrowAccount.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}",
  })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: narrowToken, domain: '127.0.0.1', path: '/', httpOnly: true })
  await openPage('/overview', 390, 844)
  await toastGrowing('390 上的长文案提示条')
  await sleep(300)
  const narrowBits = await evaluate('(' + readToastBits.toString() + ')()')
  screenshots.push(await shot('r325-toast-long-390.png', 390, 844))
  note('390 长文案', { bits: narrowBits })

  // ---- 4) 什么也没发生那条：工作流页空撤销栈 → info 语气 ----
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: adminToken, domain: '127.0.0.1', path: '/', httpOnly: true })
  await waitToastEmpty('换会话前先等屏幕干净')
  await openPage('/canvas', 1440, 1000, 'admin')
  await waitForExpr("document.querySelectorAll('[class*=cv-]').length > 0", '工作流页挂上', 120, 200)
  await resetWatch()
  await pressCtrlZ()
  await toastGrowing('info 提示条')
  await sleep(250)
  const infoBits = await evaluate('(' + readToastBits.toString() + ')()')
  screenshots.push(await shot('r325-toast-info-1440.png', 1440, 1000))
  note('info 那条', { bits: infoBits })
  await waitToastEmpty('info 提示条卸载')

  // ---- 断言 ----
  const versionBits = await evaluate('(' + readVersionBits.toString() + ')()')
  const versionApi = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  note('入口与版本', { loaded: versionBits.scripts, expected: EXPECT_ENTRY, api: versionApi && versionApi.version, sidebar: versionBits.sidebarVersion })
  check('0.1 页面脚本来自这一轮构建的入口（' + EXPECT_ENTRY + '）', Boolean(EXPECT_ENTRY) && (versionBits.scripts || []).indexOf(EXPECT_ENTRY) >= 0, { loaded: versionBits.scripts })
  check('0.2 侧栏版本号是 v' + EXPECT_VERSION + ' 且 /api/version 一致', versionBits.sidebarVersion === 'v' + EXPECT_VERSION && Boolean(versionApi) && versionApi.version === EXPECT_VERSION, { sidebar: versionBits.sidebarVersion, api: versionApi && versionApi.version })

  check('1.1 三个语气都是真渲染出来的：ok / fail / info 各一条', okBits && okBits.tone === 'ok' && failBits && failBits.tone === 'fail' && infoBits && infoBits.tone === 'info', {
    ok: okBits && okBits.tone, fail: failBits && failBits.tone, info: infoBits && infoBits.tone,
  })
  check('1.2 三条文案分别是「名字已改 / 名字不能为空 / 没有可撤销的操作」', okBits.text === '名字已改' && failBits.text === '名字不能为空' && infoBits.text === '没有可撤销的操作', {
    ok: okBits.text, fail: failBits.text, info: infoBits.text,
  })
  const paths = [okBits.iconPath, failBits.iconPath, infoBits.iconPath]
  check('1.3 图标形状真的不一样（三个 SVG path 互不相同）', paths.every((p) => typeof p === 'string' && p.length > 0) && new Set(paths).size === 3, { paths: paths.map((p) => String(p).slice(0, 28)) })
  const failColor = parseRgb(failBits.iconColor)
  const failBg = parseRgb(failBits.background)
  const failContrast = failColor && failBg ? contrastRatio(failColor, failBg) : null
  check('1.4 失败图标是浅红且在深底上够清楚（对比度 ≥ 4.5:1）', failColor !== null && failContrast !== null && failContrast >= 4.5, { iconColor: failBits.iconColor, background: failBits.background, contrast: failContrast })
  check('1.5 成功图标仍然是白的、info 是半透明白（三种颜色分得开）', okBits.iconColor === 'rgb(255, 255, 255)' && infoBits.iconColor === 'rgba(255, 255, 255, 0.72)', {
    ok: okBits.iconColor, info: infoBits.iconColor,
  })
  check('1.6 失败用 alert 播报、成功与 info 用 status', failBits.role === 'alert' && okBits.role === 'status' && infoBits.role === 'status', {
    fail: failBits.role, ok: okBits.role, info: infoBits.role,
  })
  check('1.7 图标对读屏隐藏（差的是形状，读屏听到的是文案本身）', okBits.markAriaHidden === 'true' && failBits.markAriaHidden === 'true' && infoBits.markAriaHidden === 'true', {
    ok: okBits.markAriaHidden, fail: failBits.markAriaHidden, info: infoBits.markAriaHidden,
  })
  check('2.1 390 上长文案仍然换行、不越界：宽 ≤ 342px、行数 ≥ 2、整块在视口内', narrowBits.lines >= 2 && narrowBits.rect.w <= 342 && narrowBits.inViewport, {
    lines: narrowBits.lines, w: narrowBits.rect.w, text: narrowBits.text,
  })
  check('2.2 390 上没有横向溢出（页面 scrollWidth == clientWidth == 390）', narrowBits.docScrollWidth === 390 && narrowBits.clientWidth === 390, {
    scrollWidth: narrowBits.docScrollWidth, clientWidth: narrowBits.clientWidth,
  })
  check('3.1 页面异常 0 条、console.error 0 条', cdp.exceptions.length === 0 && cdp.consoleErrors.length === 0, {
    exceptions: cdp.exceptions.slice(0, 3), consoleErrors: cdp.consoleErrors.slice(0, 3),
  })
  const upstreamLines = serverLog.split(/\r?\n/).filter((line) => /redfox|gateway|upstream|geteapi|seeapi/i.test(line) && line.indexOf('"t":"listen"') < 0)
  check('3.2 这一轮没有打任何上游（日志里没有上游调用）', upstreamLines.length === 0, { lines: upstreamLines.slice(0, 3) })
  check('3.3 四张图都落进了 docs/', screenshots.length === 4 && screenshots.every((item) => fs.existsSync(path.join(ROOT, item.file))), {
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
  round: 'r325',
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
console.log('---- r325 取证：' + out.passed + '/' + checks.length + ' 通过 ----')

try { chrome.kill() } catch { /* 已经退出 */ }
try { server.kill() } catch { /* 已经退出 */ }
await sleep(300)
try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 同上 */ }
process.exit(failed.length ? 1 : 0)
