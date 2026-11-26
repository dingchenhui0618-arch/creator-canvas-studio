// r323 独立取证：后台「系统 → 运营位」编辑卡四处改动的真渲染数字 + 两条反证。
//
// 与 shot-r322 同一套做法：临时 DATA_DIR + 真 SQLite + 真账号 + 空闲端口 + headless Chrome/CDP。
// 不碰 src/**、不重新 build：只量 dist 里已经构建好的这份代码。
//
// 用法：node scripts/shot-r323.mjs
// 产物：.shots323/out.json + 三张 png。退出码 1 = 有断言没过（数字照样写进 out.json）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, '.shots323')
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const EXPECT_ENTRY = process.env.SHOT_ENTRY || 'index-3jw-5dtJ.js'
const EXPECT_VERSION = process.env.SHOT_VERSION || '0.9.295'
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

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8994))
const DEBUG_PORT = await freePort(API_PORT + 60)
const BASE = 'http://127.0.0.1:' + API_PORT

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot323-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot323-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const ADMIN_EMAIL = 'shot323-admin' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

const adminUser = createUser({ email: ADMIN_EMAIL, password: PASSWORD, name: '运维', kind: 'admin' })
const token = createSession(adminUser, {}).token

const SEED = [
  { id: 'r323-ov-one', placement: 'overview', weight: 30, kicker: '新功能', title: '工作台那条标题', body: '工作台说一句话：点进去能拿到什么。', cta: '去看看', page: 'rooms' },
  { id: 'r323-rc-two', placement: 'recharge', weight: 20, kicker: 'Beta', title: '充值那条标题', body: '充值页说一句话：扣多少、失败怎么办。', cta: '去充值', page: 'recharge' },
  { id: 'r323-tpl-three', placement: 'templates', weight: 10, kicker: '备位', title: '模板库那条标题', body: '模板库说一句话：点进去能拿到什么。', cta: '去检索', page: 'templates' },
]
const TYPED_TITLE = '第 2 条改过的标题'

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
    // 返回 DOM 节点会撞上 returnByValue 的序列化限制，报错时把表达式带出来才好定位
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

async function rowCount() {
  return Number(await evaluate('document.querySelectorAll(".admin-promo-row").length'))
}

async function waitRows(n, label) {
  for (let i = 0; i < 80; i += 1) {
    const count = await rowCount()
    if (count === n) return count
    await sleep(150)
  }
  const count = await rowCount()
  throw new Error((label || '等行数') + '：期望 ' + n + '，实际 ' + count)
}

async function rectOf(expression) {
  return evaluate('(() => { const el = (' + expression + '); if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } })()')
}

async function scrollToCenter(expression) {
  const found = await evaluate('(() => { const el = (' + expression + '); if (!el) return false; el.scrollIntoView({ block: "center", behavior: "instant" }); return true })()')
  await sleep(300)
  return found
}

async function clickExpr(expression, label) {
  await scrollToCenter(expression)
  const rect = await rectOf(expression)
  if (!rect) throw new Error('点不到：' + (label || expression))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.cx, y: rect.cy, button: 'none' })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.cx, y: rect.cy, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.cx, y: rect.cy, button: 'left', clickCount: 1 })
  await sleep(180)
  return rect
}

/** 真键盘 ctrl+a：先走 CDP 按键，选不中才退回 el.select()。 */
async function selectAll() {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: type, modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
    })
  }
  const viaKeyboard = await evaluate('(() => { const el = document.activeElement; if (!el || typeof el.selectionStart !== "number") return null; return { start: el.selectionStart, end: el.selectionEnd, len: String(el.value).length } })()')
  if (viaKeyboard && viaKeyboard.start === 0 && viaKeyboard.end === viaKeyboard.len && viaKeyboard.len > 0) {
    return { mode: 'keyboard ctrl+a', selection: viaKeyboard }
  }
  const fallback = await evaluate('(() => { const el = document.activeElement; if (!el || !el.select) return null; el.select(); return { start: el.selectionStart, end: el.selectionEnd, len: String(el.value).length } })()')
  return { mode: 'el.select() 兜底', selection: fallback }
}

/** 点进输入框 + 全选 + 逐字符 Input.insertText（one char per call，等价于人一个个打）。 */
async function typeInto(expression, text) {
  const rect = await clickExpr(expression)
  const select = await selectAll()
  for (const char of text) {
    await cdp.send('Input.insertText', { text: char })
    await sleep(14)
  }
  await sleep(220)
  return { rect: rect, select: select }
}

async function shot(name, width, height) {
  const captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = path.join(OUT_DIR, name)
  fs.writeFileSync(file, Buffer.from(captured.data, 'base64'))
  const bytes = fs.statSync(file).size
  const entry = { file: name, bytes: bytes, width: width, height: height }
  console.log('SHOT ' + name + ' · ' + bytes + ' B · ' + width + 'x' + height)
  return entry
}

// ---- 页面里跑的只读小探针（写成普通函数再 toString 注入，避免转义地狱）----
function readRowFields(index) {
  const li = document.querySelectorAll('.admin-promo-row')[index]
  if (!li) return null
  const labels = li.querySelectorAll('.admin-promo-fields .admin-promo-field')
  const pick = (name) => {
    for (let i = 0; i < labels.length; i += 1) {
      const span = labels[i].querySelector('span')
      if (span && span.textContent.trim() === name) {
        const el = labels[i].querySelector('input, select')
        return el ? el.value : null
      }
    }
    return null
  }
  const checkbox = li.querySelector('.admin-promo-check input')
  return {
    id: pick('ID'), placement: pick('位置'), page: pick('跳转页面'), weight: pick('权重'),
    kicker: pick('小标签'), cta: pick('按钮文字'), from: pick('起始日'), until: pick('截止日'),
    title: pick('标题'), body: pick('一句话说明'), internal: checkbox ? checkbox.checked : null,
  }
}

function readPreview() {
  const head = document.querySelector('.admin-promo-preview-head')
  const spans = head ? head.querySelectorAll('.admin-cell-sub') : []
  const title = document.querySelector('.admin-promo-preview .vq-promo-title')
  const body = document.querySelector('.admin-promo-preview .vq-promo-body')
  const kicker = document.querySelector('.admin-promo-preview .vq-promo-kicker')
  const cta = document.querySelector('.admin-promo-preview .vq-promo-cta')
  return {
    head: spans[0] ? spans[0].textContent.trim() : null,
    headAll: head ? head.textContent.trim() : null,
    title: title ? title.textContent : null,
    body: body ? body.textContent : null,
    kicker: kicker ? kicker.textContent : null,
    cta: cta ? cta.textContent.trim() : null,
  }
}

function readActions() {
  const box = document.querySelector('.admin-promo-actions')
  if (!box) return null
  return {
    text: box.textContent.trim(),
    dirty: box.textContent.indexOf('有未保存的改动') >= 0,
    buttons: Array.prototype.map.call(box.querySelectorAll('button'), (button) => button.textContent.trim()),
  }
}

function readRowHeads() {
  return Array.prototype.map.call(document.querySelectorAll('.admin-promo-row'), (li) => {
    const head = li.querySelector('.admin-promo-row-head')
    return head ? head.textContent.trim() : ''
  })
}

function readUndo() {
  const box = document.querySelector('.admin-promo-undo')
  if (!box) return null
  const status = box.querySelector('[role="status"]')
  const button = box.querySelector('button')
  return {
    present: true,
    text: status ? status.textContent.trim() : null,
    button: button ? button.textContent.trim() : null,
    rect: (() => { const r = box.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) } })(),
  }
}

function readActive() {
  const el = document.activeElement
  if (!el) return null
  const rows = Array.prototype.slice.call(document.querySelectorAll('.admin-promo-row'))
  const idInputs = rows.map((row) => row.querySelector('.admin-promo-field--id input'))
  const index = idInputs.indexOf(el)
  const rect = el.getBoundingClientRect()
  return {
    tag: el.tagName,
    cls: String(el.className || ''),
    value: el.value === undefined ? null : el.value,
    placeholder: el.placeholder === undefined ? null : el.placeholder,
    rowIndex: index,
    rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) },
  }
}

function readNewRow(index) {
  const li = document.querySelectorAll('.admin-promo-row')[index]
  if (!li) return null
  const r = li.getBoundingClientRect()
  const input = li.querySelector('.admin-promo-field--id input')
  const ir = input ? input.getBoundingClientRect() : null
  return {
    row: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) },
    input: ir ? { top: Math.round(ir.top), bottom: Math.round(ir.bottom) } : null,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    fullyInViewport: r.top >= 0 && r.bottom <= window.innerHeight,
    scrollY: Math.round(window.scrollY),
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }
}

function readScrollState() {
  const list = document.querySelector('.admin-promo-list')
  let node = list ? list.parentElement : null
  let scroller = null
  while (node) {
    const cs = getComputedStyle(node)
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 4) { scroller = node; break }
    node = node.parentElement
  }
  const target = scroller || document.scrollingElement
  const section = list ? list.closest('section') : null
  const rect = section ? section.getBoundingClientRect() : null
  return {
    scroller: scroller ? scroller.tagName + '.' + String(scroller.className || '').split(' ').slice(0, 2).join('.') : 'document.scrollingElement',
    scrollTop: Math.round(target.scrollTop),
    scrollHeight: target.scrollHeight,
    clientHeight: target.clientHeight,
    windowScrollY: Math.round(window.scrollY),
    sectionTop: rect ? Math.round(rect.top) : null,
  }
}

function readOverflow() {
  const root = document.documentElement
  const inner = window.innerWidth
  const list = document.querySelector('.admin-promo-list')
  const section = list ? list.closest('section') : null
  const result = { scrollWidth: root.scrollWidth, innerWidth: inner, clientWidth: root.clientWidth, delta: root.scrollWidth - root.clientWidth, offenders: [], worstRight: 0, worstLeft: 0, checked: 0 }
  if (section) {
    const all = section.querySelectorAll('*')
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i]
      const r = el.getBoundingClientRect()
      if (!r.width && !r.height) continue
      result.checked += 1
      const overRight = Math.round(r.right - inner)
      const overLeft = Math.round(-r.left)
      if (overRight > result.worstRight) result.worstRight = overRight
      if (overLeft > result.worstLeft) result.worstLeft = overLeft
      if ((overRight > 1 || overLeft > 1) && result.offenders.length < 6) {
        result.offenders.push({ cls: String(el.className || el.tagName).slice(0, 70), overRight: overRight, overLeft: overLeft })
      }
    }
  }
  const undo = document.querySelector('.admin-promo-undo')
  const head = document.querySelector('.admin-promo-preview-head')
  if (undo && head) {
    const a = undo.getBoundingClientRect()
    const b = head.getBoundingClientRect()
    const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    result.undoRect = { left: Math.round(a.left), top: Math.round(a.top), right: Math.round(a.right), bottom: Math.round(a.bottom) }
    result.previewHeadRect = { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) }
    result.undoPreviewOverlap = { x: Math.round(overlapX), y: Math.round(overlapY), area: Math.round(overlapX) * Math.round(overlapY) }
  }
  return result
}

function readVersionBits() {
  const scripts = Array.prototype.map.call(document.querySelectorAll('script[src]'), (node) => node.getAttribute('src'))
  const inline = document.querySelectorAll('.admin-value--inline')
  const values = Array.prototype.map.call(inline, (node) => node.textContent.trim())
  const label = document.querySelector('.vq-version-label')
  return { scripts: scripts, inlineValues: values, sidebarVersion: label ? label.textContent.trim() : null, title: document.title }
}

function findDeleteButton(index) {
  const row = document.querySelectorAll('.admin-promo-row')[index]
  if (!row) return null
  const buttons = row.querySelectorAll('.admin-promo-row-actions button')
  for (let i = 0; i < buttons.length; i += 1) {
    if (buttons[i].getAttribute('aria-label') === '删除这一条') return buttons[i]
  }
  return null
}

const screenshots = []
const pageErrors = { exceptions: [], consoleErrors: [], logErrors: [] }

async function openPage(hashPath, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Page.navigate', { url: BASE + '/?edition=admin&shot=' + Date.now() + '#' + hashPath })
  await sleep(1800)
}

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const adminHeaders = { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token }

  // 0) 种子：先经真接口写入 3 条（overview / recharge / templates 各一条，标题互不相同），再打开页面
  const put = await fetch(BASE + '/api/admin/promos', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ promos: SEED }) })
  const putBody = await put.json()
  if (!put.ok || !putBody.ok) throw new Error('种子写入失败：' + put.status + ' ' + JSON.stringify(putBody).slice(0, 300))
  const savedIds = (putBody.promos || []).map((row) => row.id)
  console.log('种子写入：' + put.status + ' · ' + savedIds.join(', ') + ' · source=' + putBody.source)

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
    source: "try{localStorage.setItem('vq_welcome_seen:" + adminUser.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}"
      + "try{document.addEventListener('DOMContentLoaded',function(){var s=document.createElement('style');s.textContent='.vq-toast{display:none !important}';document.head.appendChild(s)})}catch(e){}",
  })

  // 1) 打开 #/admin/system（1440）
  await openPage('/admin/system', 1440, 1000)
  await waitRows(3, '首屏三条运营位')
  await waitForExpr('Boolean(document.querySelector(".admin-promo-preview") && document.querySelector(".admin-promo-actions"))', '编辑卡渲染完')
  await sleep(500)

  const versionApi = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  const versionBits = await evaluate('(' + readVersionBits.toString() + ')()')
  const bundleName = (versionBits.scripts || []).map((src) => String(src).split('/').pop()).filter((name) => name && name.indexOf('index-') === 0)
  note('bundle', { loadedEntry: bundleName, expectedEntry: EXPECT_ENTRY, apiVersion: versionApi && versionApi.version })
  check('0.1 页面脚本来自本轮 dist（index-3jw-5dtJ.js）', bundleName.indexOf(EXPECT_ENTRY) >= 0, { loadedEntry: bundleName, expected: EXPECT_ENTRY })
  check('0.2 后台「当前版本」卡显示 v' + EXPECT_VERSION, (versionBits.inlineValues || []).indexOf('v' + EXPECT_VERSION) >= 0, { inlineValues: versionBits.inlineValues, apiVersion: versionApi && versionApi.version })
  check('0.3 GET /api/version 与 package.json 一致', Boolean(versionApi) && versionApi.version === EXPECT_VERSION, { apiVersion: versionApi && versionApi.version, expected: EXPECT_VERSION })

  const actionsAtOpen = await evaluate('(' + readActions.toString() + ')()')
  const rowsAtOpen = await evaluate('(' + readRowHeads.toString() + ')()')
  const previewAtOpen = await evaluate('(' + readPreview.toString() + ')()')
  const row1AtOpen = await evaluate('(' + readRowFields.toString() + ')(0)')
  note('打开时', { actions: actionsAtOpen, rows: rowsAtOpen, preview: previewAtOpen, row1: row1AtOpen })

  // ---- 断言 1：预览默认跟第 1 条 ----
  check('1.1 默认预览头是「实时预览 · 第 1 条 · 工作台」', previewAtOpen.head === '实时预览 · 第 1 条 · 工作台', { head: previewAtOpen.head })
  check('1.2 默认预览标题 = 第 1 条标题', previewAtOpen.title === row1AtOpen.title, { previewTitle: previewAtOpen.title, row1Title: row1AtOpen.title })
  check('1.3 默认第 1 行有「预览中」、其它行没有', rowsAtOpen[0].indexOf('预览中') >= 0 && rowsAtOpen[1].indexOf('预览中') < 0 && rowsAtOpen[2].indexOf('预览中') < 0, { rowHeads: rowsAtOpen })
  check('2.0 刚打开时 .admin-promo-actions 里没有「有未保存的改动」', actionsAtOpen && actionsAtOpen.dirty === false, { actionsText: actionsAtOpen && actionsAtOpen.text })

  // ---- 断言 1（续）+ 2：点进第 2 条的标题、真打字 ----
  const typing = await typeInto('document.querySelectorAll(".admin-promo-row")[1].querySelector(".admin-promo-field--title input")', TYPED_TITLE)
  const titleValueAfterTyping = await evaluate('document.querySelectorAll(".admin-promo-row")[1].querySelector(".admin-promo-field--title input").value')
  const previewAfterTyping = await evaluate('(' + readPreview.toString() + ')()')
  const rowsAfterTyping = await evaluate('(' + readRowHeads.toString() + ')()')
  const actionsAfterTyping = await evaluate('(' + readActions.toString() + ')()')
  note('打字后', { typed: TYPED_TITLE, titleValue: titleValueAfterTyping, preview: previewAfterTyping, rowHeads: rowsAfterTyping, actions: actionsAfterTyping, select: typing.select })

  check('1.4 打字内容逐字落进第 2 条标题框', titleValueAfterTyping === TYPED_TITLE, { expect: TYPED_TITLE, actual: titleValueAfterTyping, selectMode: typing.select.mode })
  check('1.5 预览头切到「第 2 条 · 充值 / 积分」', previewAfterTyping.head === '实时预览 · 第 2 条 · 充值 / 积分', { head: previewAfterTyping.head })
  check('1.6 预览标题逐字等于刚打进去的字', previewAfterTyping.title === TYPED_TITLE, { previewTitle: previewAfterTyping.title, typed: TYPED_TITLE })
  check('1.7 「预览中」徽标移到第 2 行、第 1 行不再有', rowsAfterTyping[1].indexOf('预览中') >= 0 && rowsAfterTyping[0].indexOf('预览中') < 0, { rowHeads: rowsAfterTyping })
  check('2.1 打字后出现「有未保存的改动」', Boolean(actionsAfterTyping) && actionsAfterTyping.dirty === true, { actionsText: actionsAfterTyping && actionsAfterTyping.text })

  // 1440 那张：未保存徽标 + 预览停在第 2 条
  await scrollToCenter('document.querySelector(".admin-promo-preview")')
  await evaluate('(() => { const el = document.querySelector(".admin-promo-preview"); if (!el) return false; el.scrollIntoView({ block: "center", behavior: "instant" }); return true })()')
  await sleep(400)
  const shot1440Rects = await evaluate('(() => { const a = document.querySelector(".admin-promo-actions"); const p = document.querySelector(".admin-promo-preview"); const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) } }; return { actions: box(a), preview: box(p), innerHeight: window.innerHeight } })()')
  const inView1440 = shot1440Rects.actions && shot1440Rects.preview && shot1440Rects.actions.top >= 0 && shot1440Rects.preview.bottom <= shot1440Rects.innerHeight
  check('S1 1440 图里同时看得到「未保存徽标」与预览', Boolean(inView1440), shot1440Rects)
  screenshots.push(await shot('r323-promo-editor-1440.png', 1440, 1000))

  // ---- 断言 2（续）：真点「保存运营位」，徽标消失、note 报已保存 3 条 ----
  const saveRect = await clickExpr('(() => { const buttons = Array.prototype.slice.call(document.querySelectorAll(".admin-promo-actions button")); return buttons.find((b) => b.textContent.indexOf("保存运营位") >= 0) || null })()', '保存运营位')
  const noteAfterSave = await waitForExpr('(() => { const status = document.querySelector(".admin-promo-actions") && document.querySelector("p[role=status]"); return status && status.textContent.indexOf("已保存") >= 0 ? status.textContent.trim() : null })()', '保存后的 note', 60, 200)
  await sleep(900)
  const actionsAfterSave = await evaluate('(' + readActions.toString() + ')()')
  const storedAfterSave = await fetch(BASE + '/api/admin/promos', { headers: adminHeaders }).then((response) => response.json())
  note('保存后', { note: noteAfterSave, actions: actionsAfterSave, serverSource: storedAfterSave.source, serverTitles: (storedAfterSave.promos || []).map((row) => row.title) })
  check('2.2 保存后 note 是「已保存 3 条运营位…」', String(noteAfterSave).indexOf('已保存 3 条运营位') === 0, { note: noteAfterSave })
  check('2.3 保存后「有未保存的改动」消失', actionsAfterSave && actionsAfterSave.dirty === false, { actionsText: actionsAfterSave && actionsAfterSave.text })
  check('2.4 服务端真的存下了改过的标题（真 PUT 生效）', (storedAfterSave.promos || []).some((row) => row.title === TYPED_TITLE), { serverTitles: (storedAfterSave.promos || []).map((row) => row.title) })
  note('保存按钮矩形', saveRect)

  // ---- 断言 3：新增一条 ----
  await evaluate('(() => { const list = document.querySelector(".admin-promo-list"); const section = list ? list.closest("section") : null; if (section) section.scrollIntoView({ block: "start", behavior: "instant" }); return true })()')
  await sleep(400)
  const scrollBeforeAdd = await evaluate('(' + readScrollState.toString() + ')()')
  await clickExpr('(() => { const buttons = Array.prototype.slice.call(document.querySelectorAll(".admin-promo-toolbar button")); return buttons.find((b) => b.textContent.indexOf("新增一条") >= 0) || null })()', '新增一条')
  const settle = await waitFor(async () => {
    const first = await evaluate('(() => { const li = document.querySelectorAll(".admin-promo-row")[3]; return li ? Math.round(li.getBoundingClientRect().top) : null })()')
    if (first === null) return null
    await sleep(220)
    const second = await evaluate('(() => { const li = document.querySelectorAll(".admin-promo-row")[3]; return li ? Math.round(li.getBoundingClientRect().top) : null })()')
    return first === second ? { top: second } : null
  }, '新增行滚动落定')
  const rowsAfterAdd = await rowCount()
  const activeAfterAdd = await evaluate('(' + readActive.toString() + ')()')
  const newRow = await evaluate('(' + readNewRow.toString() + ')(3)')
  const scrollAfterAdd = await evaluate('(' + readScrollState.toString() + ')()')
  const previewAfterAdd = await evaluate('(' + readPreview.toString() + ')()')
  const scrolledBy = scrollAfterAdd.scrollTop - scrollBeforeAdd.scrollTop
  note('新增后', { rows: rowsAfterAdd, active: activeAfterAdd, newRow: newRow, preview: previewAfterAdd, scrollBeforeAdd: scrollBeforeAdd, settle: settle })
  check('3.1 行数 3 → 4', rowsAfterAdd === 4, { rows: rowsAfterAdd })
  check('3.2 焦点在新那行的 ID 输入框（value 为空、placeholder 例如 rooms-beta）', Boolean(activeAfterAdd) && activeAfterAdd.rowIndex === 3 && activeAfterAdd.value === '' && activeAfterAdd.placeholder === '例如 rooms-beta', activeAfterAdd)
  check('3.3 新行整行都在视口内', Boolean(newRow) && newRow.fullyInViewport === true, newRow)
  check('3.4 预览切到新那条、标题显示占位「运营位标题」', previewAfterAdd.head === '实时预览 · 第 4 条 · 工作台' && previewAfterAdd.title === '运营位标题', { head: previewAfterAdd.head, title: previewAfterAdd.title })
  check('3.5 「滚到眼前」是真滚动带来的（编辑卡比视口高，容器 scrollTop 必须有位移）',
    scrolledBy > 0 && newRow && newRow.fullyInViewport === true,
    { scroller: scrollAfterAdd.scroller, scrollTopBefore: scrollBeforeAdd.scrollTop, scrollTopAfter: scrollAfterAdd.scrollTop, scrolledBy: scrolledBy, sectionTopBefore: scrollBeforeAdd.sectionTop, sectionTopAfter: scrollAfterAdd.sectionTop, scrollHeight: scrollAfterAdd.scrollHeight, clientHeight: scrollAfterAdd.clientHeight })

  // ---- 重载回 3 条（新增那条不保存，让第 4 条断言在干净的 3 行上做）----
  await openPage('/admin/system', 1440, 1000)
  await waitRows(3, '重载后三条')
  await waitForExpr('Boolean(document.querySelector(".admin-promo-preview"))', '编辑卡渲染完（重载）')
  await sleep(400)

  // ---- 断言 4：删第 2 条 + 撤销 ----
  const row2BeforeDelete = await evaluate('(' + readRowFields.toString() + ')(1)')
  const rowsBeforeDelete = await evaluate('(' + readRowHeads.toString() + ')()')
  const previewBeforeDelete = await evaluate('(' + readPreview.toString() + ')()')
  await clickExpr('(' + findDeleteButton.toString() + ')(1)', '第 2 条删除按钮')
  await waitRows(2, '删掉一条后两行')
  await sleep(400)
  const rowsAfterDelete = await rowCount()
  const idsAfterDelete = await evaluate('Array.prototype.map.call(document.querySelectorAll(".admin-promo-field--id input"), (el) => el.value)')
  const undoRow = await evaluate('(' + readUndo.toString() + ')()')
  const actionsAfterDelete = await evaluate('(' + readActions.toString() + ')()')
  note('删除后', { rows: rowsAfterDelete, ids: idsAfterDelete, undo: undoRow, actions: actionsAfterDelete, rowHeadsBefore: rowsBeforeDelete, previewBefore: previewBeforeDelete })
  check('4.1 行数 3 → 2', rowsAfterDelete === 2, { rows: rowsAfterDelete })
  check('4.2 反证：DOM 里真的没有那条（id 不在任何一行的 ID 框里）', idsAfterDelete.indexOf(row2BeforeDelete.id) < 0, { idsInDom: idsAfterDelete, deletedId: row2BeforeDelete.id })
  check('4.3 撤销行出现，文案是「已删掉第 2 条「原标题」，还没保存。」',
    Boolean(undoRow) && String(undoRow.text).indexOf('已删掉第 2 条') === 0 && String(undoRow.text).indexOf('「' + row2BeforeDelete.title + '」') >= 0 && String(undoRow.text).indexOf('还没保存') >= 0,
    { undoText: undoRow && undoRow.text, expectTitle: row2BeforeDelete.title })
  check('4.4 撤销行的按钮是「撤销删除」', Boolean(undoRow) && String(undoRow.button).indexOf('撤销删除') >= 0, { button: undoRow && undoRow.button })

  await scrollToCenter('document.querySelector(".admin-promo-undo")')
  await sleep(300)
  const undoShotRects = await evaluate('(() => { const u = document.querySelector(".admin-promo-undo"); const a = document.querySelector(".admin-promo-actions"); const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) } }; return { undo: box(u), actions: box(a), innerHeight: window.innerHeight } })()')
  note('撤销图取景', undoShotRects)
  screenshots.push(await shot('r323-promo-undo-1440.png', 1440, 1000))

  await clickExpr('(() => { const box = document.querySelector(".admin-promo-undo"); return box ? box.querySelector("button") : null })()', '撤销删除')
  await waitRows(3, '撤销后三行')
  await sleep(500)
  const row2AfterUndo = await evaluate('(' + readRowFields.toString() + ')(1)')
  const sameFields = JSON.stringify(row2AfterUndo) === JSON.stringify(row2BeforeDelete)
  const diffFields = Object.keys(row2BeforeDelete || {}).filter((key) => (row2BeforeDelete || {})[key] !== (row2AfterUndo || {})[key])
  const undoGone = await evaluate('Boolean(document.querySelector(".admin-promo-undo"))')
  const actionsAfterUndo = await evaluate('(' + readActions.toString() + ')()')
  note('撤销后', { rows: await rowCount(), row2: row2AfterUndo, undoRowGone: !undoGone, actions: actionsAfterUndo })
  check('4.5 撤销后行数回到 3', (await rowCount()) === 3, { rows: await rowCount() })
  check('4.6 撤销后第 2 行 10 个字段与删除前逐一相同', sameFields, { before: row2BeforeDelete, after: row2AfterUndo, diffFields: diffFields })
  check('4.7 撤销后撤销行消失', undoGone === false, { undoPresent: undoGone })

  // ---- 断言 5 / 反证二：改回原样，「有未保存的改动」应消失 ----
  const undoActionsDirty = actionsAfterUndo && actionsAfterUndo.dirty
  const originalTitle = row2BeforeDelete.title
  await typeInto('document.querySelectorAll(".admin-promo-row")[1].querySelector(".admin-promo-field--title input")', '临时改一下')
  const actionsAfterChange = await evaluate('(' + readActions.toString() + ')()')
  const titleAfterChange = await evaluate('document.querySelectorAll(".admin-promo-row")[1].querySelector(".admin-promo-field--title input").value')
  await typeInto('document.querySelectorAll(".admin-promo-row")[1].querySelector(".admin-promo-field--title input")', originalTitle)
  const actionsAfterRevert = await evaluate('(' + readActions.toString() + ')()')
  const titleAfterRevert = await evaluate('document.querySelectorAll(".admin-promo-row")[1].querySelector(".admin-promo-field--title input").value')
  note('改回原样', { undoStateDirty: undoActionsDirty, afterChange: actionsAfterChange, titleAfterChange: titleAfterChange, afterRevert: actionsAfterRevert, titleAfterRevert: titleAfterRevert, originalTitle: originalTitle })
  check('5.1 撤销后（内容与已保存一致）徽标不出现', undoActionsDirty === false, { actionsText: actionsAfterUndo && actionsAfterUndo.text })
  check('5.2 改成别的文案后徽标出现', Boolean(actionsAfterChange) && actionsAfterChange.dirty === true, { actionsText: actionsAfterChange && actionsAfterChange.text, title: titleAfterChange })
  check('5.3 反证二：逐字符改回原值后徽标消失（比的是内容不是「动过没有」）', Boolean(actionsAfterRevert) && actionsAfterRevert.dirty === false && titleAfterRevert === originalTitle, { actionsText: actionsAfterRevert && actionsAfterRevert.text, title: titleAfterRevert, originalTitle: originalTitle })

  // ---- 断言 6：390 整页重载 ----
  await openPage('/admin/system', 390, 900)
  await waitRows(3, '390 三条')
  await waitForExpr('Boolean(document.querySelector(".admin-promo-preview") && document.querySelector(".admin-promo-actions"))', '编辑卡渲染完（390）')
  await sleep(500)
  await clickExpr('(' + findDeleteButton.toString() + ')(1)', '390 删第 2 条')
  await waitRows(2, '390 删掉一条后两行')
  await sleep(500)
  const overflow = await evaluate('(' + readOverflow.toString() + ')()')
  note('390 溢出与重叠', overflow)
  check('6.1 390：documentElement.scrollWidth === innerWidth', overflow.scrollWidth === overflow.innerWidth, { scrollWidth: overflow.scrollWidth, innerWidth: overflow.innerWidth, delta: overflow.delta })
  check('6.2 390：编辑卡内没有元素越界', overflow.offenders.length === 0 && overflow.worstRight <= 1 && overflow.worstLeft <= 1, { offenders: overflow.offenders, worstRight: overflow.worstRight, worstLeft: overflow.worstLeft, checked: overflow.checked })
  check('6.3 390：撤销行与预览头不重叠', Boolean(overflow.undoPreviewOverlap) && overflow.undoPreviewOverlap.area === 0, { undoRect: overflow.undoRect, previewHeadRect: overflow.previewHeadRect, overlap: overflow.undoPreviewOverlap })

  await scrollToCenter('document.querySelector(".admin-promo-preview")')
  await sleep(300)
  const narrowRects = await evaluate('(() => { const u = document.querySelector(".admin-promo-undo"); const p = document.querySelector(".admin-promo-preview"); const i = document.querySelector(".admin-promo-preview-head"); const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) } }; return { undo: box(u), previewHead: box(i), preview: box(p), innerHeight: window.innerHeight } })()')
  note('390 取景', narrowRects)
  screenshots.push(await shot('r323-promo-editor-390.png', 390, 900))

  // ---- 版本号（用户版侧栏那一处）----
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: BASE + '/?edition=user&shot=' + Date.now() + '#/overview' })
  await sleep(2200)
  const sidebarVersion = await waitForExpr('(() => { const el = document.querySelector(".vq-version-label"); return el ? el.textContent.trim() : null })()', '用户版侧栏版本号', 40, 250)
  const bundleUser = await evaluate('Array.prototype.map.call(document.querySelectorAll("script[src]"), (node) => String(node.getAttribute("src")).split("/").pop()).filter((name) => name.indexOf("index-") === 0)')
  note('用户版侧栏', { label: sidebarVersion, bundle: bundleUser })
  check('0.4 用户版侧栏版本号是 v' + EXPECT_VERSION, sidebarVersion === 'v' + EXPECT_VERSION, { label: sidebarVersion, bundle: bundleUser })

  // ---- 断言 7：页面报错 ----
  const consoleErrorList = cdp.consoleErrors.slice()
  pageErrors.exceptions = cdp.exceptions.slice()
  pageErrors.consoleErrors = consoleErrorList
  pageErrors.logErrors = cdp.logErrors.slice()
  check('7.1 页面脚本报错数为 0（exception + console.error）', pageErrors.exceptions.length === 0 && consoleErrorList.length === 0, { exceptions: pageErrors.exceptions.length, consoleErrors: consoleErrorList.length, logErrors: pageErrors.logErrors.length })
  if (pageErrors.exceptions.length) note('页面异常', pageErrors.exceptions.slice(0, 3))
  if (consoleErrorList.length) note('console.error', consoleErrorList.slice(0, 3))
  if (pageErrors.logErrors.length) note('Log.entryAdded(level=error)', pageErrors.logErrors.slice(0, 5))

  // 0 次上游调用：服务端日志里不该出现上游供应商字样
  const upstream = serverLog.split('\n').filter((line) => /redfox|upstream|kling|replicate|openai|sora|geteapi|seeapi/i.test(line))
  note('上游调用行', upstream.slice(0, 5))
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
    seedIds: [],
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

  // 本进程还握着 auth.db，数据目录要等它退出后再删
  const cleaner = spawn(process.execPath, ['-e', 'setTimeout(() => { try { require("fs").rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch (e) { console.warn("cleanup: " + e.message) } }, 2000)', dataDir], { detached: true, stdio: 'ignore' })
  cleaner.unref()
}
