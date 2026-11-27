// r342 取证：对话框里的「生成设置」与右上角余额的实时性
//
// 三条纪律（与 r330 同一套）：
//   1) 0 次真实上游调用：出图 Key 的 baseUrl 指向本机假上游（127.0.0.1），绝不配真实 GeteAPI / SeeAPI；
//   2) 一律 CDP 真输入（Input.dispatchMouseEvent / dispatchKeyEvent / insertText），业务点击不用 .click()；
//   3) 量不出来就写 null 并写明原因，不猜。
//
// 用法（先 npm run build，脚本用现成的 dist，绝不重新构建）：
//   node scripts/shot-r342.mjs --dist dist --out .shots342
//
// 产物：<out>/r342.json + <out>/*.png（其中四张按约定复制进 docs/）
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = fs.existsSync(path.join(process.cwd(), 'server', 'index.mjs')) ? process.cwd() : path.resolve(SCRIPT_DIR, '..')
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOTS_ROOT = path.join(ROOT, '.shots342')

function argOf(name, fallback) {
  const at = process.argv.indexOf('--' + name)
  if (at > 0 && process.argv[at + 1] && process.argv[at + 1].charAt(0) !== '-') return process.argv[at + 1]
  return fallback
}
const DIST_DIR = path.resolve(ROOT, String(argOf('dist', 'dist')))
const OUT_DIR = path.resolve(ROOT, String(argOf('out', '.shots342')))
if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) throw new Error('dist 里没有 index.html：' + DIST_DIR)
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME)
fs.mkdirSync(SHOTS_ROOT, { recursive: true })
fs.mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const report = { at: new Date().toISOString(), dist: path.basename(DIST_DIR), fakeUpstreamHits: 0, checks: [], shots: [] }
function check(id, ok, detail) {
  report.checks.push({ id: id, ok: Boolean(ok), detail: detail === undefined ? null : detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + JSON.stringify(detail))
}

async function freePort(start, end) {
  for (let port = start; port <= end; port += 1) {
    const alive = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(300) }).then(() => true).catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口')
}

// ---- 假出图上游：只回一张 1x1 PNG，证明「真的发出去了」，不花一分钱 ----
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
)
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    report.fakeUpstreamHits += 1
    report.lastUpstreamPath = req.url
    report.lastUpstreamBody = Buffer.concat(chunks).toString('utf8').slice(0, 400)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: 'data:image/png;base64,' + TINY_PNG.toString('base64') }] }))
  })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const UPSTREAM_PORT = upstream.address().port
const UPSTREAM_BASE = 'http://127.0.0.1:' + UPSTREAM_PORT + '/v1'

const API_PORT = await freePort(8860, 8878)
const DEBUG_PORT = await freePort(8880, 8898)
const BASE = 'http://127.0.0.1:' + API_PORT

// ---- 临时实例 ----
const dataDir = fs.mkdtempSync(path.join(SHOTS_ROOT, 'data-'))
const profile = fs.mkdtempSync(path.join(SHOTS_ROOT, 'profile-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'r342-shot-key-secret'

const stageDir = path.join(SHOTS_ROOT, 'stage')
fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir, { recursive: true })
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const distEntry = (fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8').match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1]
const distVersion = (() => {
  try {
    const source = fs.readFileSync(path.join(DIST_DIR, 'assets', distEntry), 'utf8')
    const found = source.match(/0\.9\.\d{3}/)
    return found ? found[0] : pkgJson.version
  } catch { return pkgJson.version }
})()
fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify({ ...pkgJson, version: distVersion }, null, 2), 'utf8')
try { fs.symlinkSync(DIST_DIR, path.join(stageDir, 'dist'), 'junction') } catch { fs.cpSync(DIST_DIR, path.join(stageDir, 'dist'), { recursive: true }) }

const AT = String.fromCharCode(64)
const PASSWORD = 'r342-shot-pass1'
const { createSession, createUser } = await import('../server/auth.mjs')
const { markComplete } = await import('../server/onboarding.mjs')
const { grant } = await import('../server/credits.mjs')
const { createKey } = await import('../server/keyvault.mjs')
const { config: cfg } = await import('../server/config.mjs')

const account = createUser({ email: 'r342shot' + AT + 'shot.test', password: PASSWORD, name: 'r342 取证', kind: 'account' })
const token = createSession(account, {}).token
markComplete(account.id, { skipAssets: true })
grant(account.id, 60, { note: 'r342 取证起始余额' })
createKey({
  name: 'r342 假出图上游',
  provider: 'geteapi',
  baseUrl: UPSTREAM_BASE,
  apiKey: 'sk-r342-fake-upstream-123456',
  models: ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.6'],
  capabilities: ['image'],
  priority: 10,
  weight: 100,
})

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
    VISION_API_KEY: 'r342-not-a-real-key',
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

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
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
  close() { try { this.ws.close() } catch { /* 已关 */ } }
}

let cdp = null
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true })
  if (result && result.exceptionDetails) throw new Error('页面里求值失败：' + JSON.stringify(result.exceptionDetails).slice(0, 240))
  return result && result.result ? result.result.value : undefined
}
async function waitFor(fn, label, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try { const value = await fn(); if (value) return value } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('等待超时：' + label)
}
async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: false })
  await sleep(150)
}
async function rectOf(selector, text) {
  const payload = JSON.stringify({ sel: selector, text: text || '' })
  return evaluate('(function(input){var sel=input.sel,text=input.text;var list=Array.prototype.slice.call(document.querySelectorAll(sel));for(var i=0;i<list.length;i++){var el=list[i];if(text&&String(el.textContent||"").trim()!==text)continue;var r=el.getBoundingClientRect();if(!r.width||!r.height)continue;return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom};}return null;})(' + payload + ')')
}
async function clickAt(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none', clickCount: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 })
  await sleep(140)
}
async function clickSelector(selector, text) {
  const rect = await waitFor(() => rectOf(selector, text), '可点元素 ' + selector + (text ? '=' + text : ''))
  await clickAt(rect.x, rect.y)
  return rect
}
async function pressEnter() {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type: type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined })
  }
  await sleep(120)
}
async function selectAllAndType(text) {
  await evaluate('document.querySelector(".qc-input").focus()')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await cdp.send('Input.insertText', { text: text })
  await sleep(260)
}
async function shoot(file, clip) {
  const params = { format: 'png', captureBeyondViewport: false }
  if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
  const captured = await cdp.send('Page.captureScreenshot', params)
  fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(captured.data, 'base64'))
  report.shots.push(file)
  console.log('SHOT ' + file)
}
const chipText = () => evaluate('(function(){var el=document.querySelector(".vq-credit-chip");return el?String(el.textContent||"").trim():null;})()')
const chipRect = () => rectOf('.vq-credit-chip')

let exitCode = 0
try {
  await waitFor(async () => (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(800) })).ok, '临时实例 /api/health')
  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')

  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await setViewport(1440, 1000)
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1');localStorage.setItem('vq.edition','user')}catch(e){}",
  })

  console.log('r342 取证 · dist=' + DIST_DIR + ' · v' + distVersion + ' · 端口 ' + API_PORT + ' · 假上游 ' + UPSTREAM_BASE)
  await cdp.send('Page.navigate', { url: BASE + '/?n=1#/agents' })
  await waitFor(() => evaluate('Boolean(document.querySelector(".qc-input"))'), '快捷创作 · 平台对话输入框')
  await sleep(600)

  const balanceBefore = await chipText()
  report.balanceBefore = balanceBefore
  // 裁一块「账号区」（头像 + 名字 + 余额），只裁那颗 chip 的话字太小、看不出是哪一屏
  const beforeRect = await rectOf('.vq-topbar-account')
  await shoot('r342-credits-before.png', beforeRect ? { x: Math.max(0, beforeRect.left - 8), y: Math.max(0, beforeRect.top - 6), width: beforeRect.w + 16, height: beforeRect.h + 12 } : null)

  // ---- ① 图片指令：生成设置行出现，比例选 3:4、画质选高清 ----
  await selectAllAndType('/生图 3:4 白底产品图')
  await waitFor(() => evaluate('Boolean(document.querySelector(".qc-gen"))'), '生成设置行')
  const imageRow = await evaluate('(function(){var el=document.querySelector(".qc-gen-row");if(!el)return null;var r=el.getBoundingClientRect();return {w:r.width,scrollW:el.scrollWidth,children:el.children.length};})()')
  await clickSelector('.qc-gen-chip[aria-label="比例：跟随提示词"]')
  await sleep(200)
  await clickSelector('.qc-gen-opt', '3:4')
  await clickSelector('.qc-gen-chip[aria-label="画质：跟随默认"]')
  await sleep(200)
  await clickSelector('.qc-gen-opt', '高清')
  const picked = await evaluate('(function(){var chips=Array.prototype.slice.call(document.querySelectorAll(".qc-gen-chip"));return chips.map(function(el){return String(el.textContent||"").replace(/\\s+/g," ").trim();});})()')
  const composer = await rectOf('.qc-composer')
  await shoot('r342-gen-settings-image-1440.png', composer ? { x: Math.max(0, composer.left - 8), y: Math.max(0, composer.top - 8), width: composer.w + 16, height: composer.h + 16 } : null)
  check('gen-settings.visible-image', Boolean(composer), { row: imageRow, chips: picked })

  // ---- ② 发一条生成指令：余额必须当场变 ----
  // 刚才点的是下拉里的按钮，焦点还在那颗按钮上：先把焦点还给输入框，否则 Enter 只会再点一次那颗按钮
  await evaluate('document.querySelector(".qc-input").focus()')
  await sleep(120)
  await pressEnter()
  await waitFor(() => evaluate('Boolean(document.querySelector(".qc-gen")) === false'), '设置行收起（已发送）', 40).catch(() => null)
  const balanceAfter = await waitFor(async () => {
    const now = await chipText()
    return now && now !== balanceBefore ? now : null
  }, '右上角余额变化', 120).catch(() => null)
  report.balanceAfter = balanceAfter
  const afterRect = await rectOf('.vq-topbar-account')
  await shoot('r342-credits-after.png', afterRect ? { x: Math.max(0, afterRect.left - 8), y: Math.max(0, afterRect.top - 6), width: afterRect.w + 16, height: afterRect.h + 12 } : null)
  const taskCard = await waitFor(() => evaluate('Boolean(document.querySelector(".qc-media-card, .qc-media, [class*=qc-media]"))'), '生成结果卡片', 60).catch(() => null)
  const cardSpec = await evaluate('(function(){var el=document.querySelector("[class*=qc-media-spec]");return el?String(el.textContent||"").trim():null;})()')
  check('credits.changed', Boolean(balanceAfter), { before: balanceBefore, after: balanceAfter, card: cardSpec, taskCard: Boolean(taskCard) })
  check('upstream.used', report.fakeUpstreamHits > 0, { hits: report.fakeUpstreamHits, path: report.lastUpstreamPath })

  // ---- ③ 视频指令 ----
  await selectAllAndType('/生视频 16:9 8秒 720p 海边日落')
  await waitFor(() => evaluate('Boolean(document.querySelector(".qc-gen"))'), '生成设置行（视频）')
  const videoChips = await evaluate('(function(){var chips=Array.prototype.slice.call(document.querySelectorAll(".qc-gen-chip"));return chips.map(function(el){return String(el.textContent||"").replace(/\\s+/g," ").trim();});})()')
  const composerVideo = await rectOf('.qc-composer')
  await shoot('r342-gen-settings-video-1440.png', composerVideo ? { x: Math.max(0, composerVideo.left - 8), y: Math.max(0, composerVideo.top - 8), width: composerVideo.w + 16, height: composerVideo.h + 16 } : null)
  check('gen-settings.video-controls', videoChips.length >= 3, { chips: videoChips })

  // ---- ④ 390 窄屏：不横溢 ----
  await setViewport(390, 844)
  await sleep(500)
  const narrow = await evaluate('(function(){var row=document.querySelector(".qc-gen-row");var doc=document.documentElement;return {innerWidth:window.innerWidth,docScroll:doc.scrollWidth,rowW:row?row.clientWidth:null,rowScroll:row?row.scrollWidth:null};})()')
  const composerNarrow = await rectOf('.qc-composer')
  await shoot('r342-gen-settings-390.png', null)
  check('narrow.no-overflow', narrow.docScroll <= narrow.innerWidth && (narrow.rowScroll === null || narrow.rowScroll <= narrow.rowW), narrow)

  report.cardSpec = cardSpec
  report.narrow = narrow
  report.imageChips = picked
  report.videoChips = videoChips
} catch (error) {
  exitCode = 1
  report.error = String((error && error.message) || error)
  report.serverLogTail = serverLog.slice(-1200)
  console.log('ERROR ' + report.error)
} finally {
  try { if (cdp) cdp.close() } catch { /* ignore */ }
  try { chrome.kill() } catch { /* ignore */ }
  try { server.kill() } catch { /* ignore */ }
  upstream.close()
  fs.writeFileSync(path.join(OUT_DIR, 'r342.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log('---- 结论：' + report.checks.filter((item) => item.ok).length + '/' + report.checks.length + ' 通过；假上游被打了 ' + report.fakeUpstreamHits + ' 次')
}
process.exit(exitCode)
