// r343 取证：普通用户界面（不带 ?edition=admin 的所有页面）的上游厂牌与内部小字扫描。
//
// 做什么：
//   1) 起真实服务端（临时数据目录）+ vite dev（真编译 src，不碰 dist、不跑 build）；
//   2) 无头 Chrome 逐屏打开普通用户每一屏，抓「可见文案」与 title / aria-label /
//      placeholder / alt 属性文案，含浮层（模型切换、账号菜单、快速跳转、版本弹窗、
//      快捷创作侧栏与生成设置）与空状态、报错页；
//   3) 顺带抓 GET /api/models 与 /api/version 的返回体；
//   4) 按两档词表扫：
//        A 档＝上游厂牌 / 中转商名 + 内部模型 id（必须 0，退出码只看它）；
//        B 档＝自有产品标签（GPT Image 2 / Seedance 2.0 这类，允许存在，只统计不阻塞）；
//      内部术语小字单列，改后也要求 0。
//
// 用法：
//   node scripts/scan-copy.mjs                             # 人读摘要 + 退出码（A 档或内部术语>0 则 1）
//   node scripts/scan-copy.mjs --json .scan-copy/scan.json
//   node scripts/scan-copy.mjs --shots .scan-copy/shots    # 顺带留屏图（真实渲染）
//
// 计口径：每屏按「规则 + 命中词」去重后计 1 条，便于改前改后对比。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = fs.existsSync(path.join(process.cwd(), 'server', 'index.mjs')) ? process.cwd() : path.resolve(SCRIPT_DIR, '..')
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

function argOf(name, fallback) {
  const at = process.argv.indexOf('--' + name)
  if (at > 0 && process.argv[at + 1] && process.argv[at + 1].charAt(0) !== '-') return process.argv[at + 1]
  return fallback
}
// 默认落在 .tmp-scan-copy（.gitignore 里的 .tmp-*）：扫描产物不进仓库、不污染 lint
const OUT_DIR = path.resolve(ROOT, String(argOf('out', '.tmp-scan-copy')))
const JSON_PATH = argOf('json', '') ? path.resolve(ROOT, String(argOf('json', ''))) : path.join(OUT_DIR, 'scan.json')
const SHOTS_DIR = argOf('shots', '') ? path.resolve(ROOT, String(argOf('shots', ''))) : ''
const KEEP = process.argv.includes('--keep')

if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME)
fs.mkdirSync(OUT_DIR, { recursive: true })
if (SHOTS_DIR) fs.mkdirSync(SHOTS_DIR, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 词表：分 A / B 两档（口径见 docs/r343-copy-2026-11-27.md） ----
// A 档：上游厂牌 / 中转商名 + 内部模型 id。普通用户界面里必须为 0，退出码只看 A 档。
const BRAND_TIER_A = [
  { name: 'deepseek', re: /deepseek/gi },
  { name: 'geteapi', re: /geteapi/gi },
  { name: 'seeapi', re: /seeapi/gi },
  { name: 'cgcm', re: /cgcm/gi },
  { name: 'openai', re: /openai/gi },
  { name: 'anthropic', re: /anthropic/gi },
  { name: 'claude', re: /claude/gi },
  { name: 'gemini', re: /gemini/gi },
  { name: 'gpt', re: /\bgpt\b/gi },
  { name: 'gpt-型号', re: /\bgpt-[0-9a-z.]+/gi },
  { name: 'qwen', re: /qwen|通义/gi },
  { name: 'doubao', re: /doubao|豆包/gi },
  { name: 'volcengine', re: /volcengine|volces|火山引擎|火山方舟/gi },
  { name: 'moonshot', re: /moonshot/gi },
  { name: 'zhipu', re: /zhipu|\bglm-\d/gi },
  { name: 'minimax', re: /minimax/gi },
  { name: 'xai', re: /\bxai\b/gi },
  { name: 'grok', re: /\bgrok\b/gi },
  { name: 'sora', re: /\bsora\b/gi },
  { name: 'midjourney', re: /midjourney/gi },
  { name: 'stable-diffusion', re: /stable[\s-]?diffusion/gi },
  { name: 'nano-banana', re: /nano[\s-]?banana/gi },
  { name: 'seedream', re: /seedream/gi },
  { name: 'kling', re: /kling|可灵/gi },
  { name: 'hunyuan', re: /hunyuan|混元/gi },
  { name: 'ernie', re: /ernie|文心一言/gi },
  { name: 'codex', re: /codex/gi },
  { name: 'workbuddy', re: /workbuddy/gi },
  { name: 'model-id', re: /\b[a-z][a-z0-9]{2,}[-_](?:flash|pro|turbo|mini|max|lite|reasoner|thinking|vl|chat|preview)\b/gi },
]
// B 档：自有产品标签（列表页、画布节点小字、模型选择器本来就显示这些；本轮不改）。
// 不算泄露 —— 只统计、不阻塞；A 档匹配前先把它们挖空，免得「GPT Image 2」被判成 gpt。
const PRODUCT_LABELS = [
  { name: 'GPT Image N', re: /gpt\s*image\s*\d+(?:\.\d+)?/gi },
  { name: 'Seedance N', re: /seedance\s*[\d.]+/gi },
  { name: 'Seedream N', re: /seedream\s*[\d.]+/gi },
  { name: 'Kling N', re: /kling\s*[\d.]+/gi },
  { name: 'Wavision', re: /wavision/gi },
]
// 匹配前恒要挖空的：自己的品牌名，以及扫描机地址（版本信息弹窗的「站点」行，不是产品文案）
const BLANK_ALWAYS = [
  { name: 'VisionQA', re: /visionqa/gi },
  { name: '本机地址', re: /127\.0\.0\.1(?::\d+)?|localhost(?::\d+)?/gi },
]
// A 档与内部术语共用的掩码：产品标签 + 品牌名 + 本机地址
const MASK_A = [...BLANK_ALWAYS, ...PRODUCT_LABELS]
// 内部术语小字：提示级（第二类），改后应尽量为 0。
const INTERNAL_RULES = [
  { name: '上游', re: /上游/g },
  { name: '落盘', re: /落盘/g },
  { name: '契约', re: /契约/g },
  { name: '幂等', re: /幂等/g },
  { name: '兜底', re: /兜底/g },
  { name: '扣费口径', re: /扣费口径|计价口径|成本口径/g },
  { name: 'token', re: /\btokens?\b/gi },
  { name: '报文', re: /报文/g },
  { name: 'SSE', re: /\bSSE\b/g },
  { name: 'CDN', re: /\bCDN\b/g },
  { name: '缓存策略', re: /缓存策略/g },
  { name: '接口', re: /接口/g },
  { name: '5xx', re: /\b5xx\b|50[0-4]/g },
  { name: 'OOM', re: /\bOOM\b/g },
  // React 会把「v」和版本号渲染成两个相邻文本节点，所以也认不带 v 的 x.y.z
  { name: '内部编号', re: /\br\d{2,3}\b|\bv\d+\.\d+\.\d+\b|\b\d+\.\d+\.\d+\b/g },
]

function blankHits(text, rules) {
  let out = text
  for (const rule of rules) out = out.replace(rule.re, (m) => ' '.repeat(m.length))
  return out
}

function matchRules(text, rules, mask = MASK_A) {
  const clean = blankHits(text, mask)
  const hits = []
  for (const rule of rules) {
    rule.re.lastIndex = 0
    const found = clean.match(rule.re)
    if (!found) continue
    for (const word of new Set(found.map((item) => item.trim()))) hits.push({ rule: rule.name, word })
  }
  return hits
}

// A 档（厂牌 / 内部模型 id）：退出码只看它
function matchTierA(text) {
  return matchRules(text, BRAND_TIER_A)
}

// B 档（自有产品标签）：只统计，不挖空自己的原文
function matchTierB(text) {
  return matchRules(text, PRODUCT_LABELS, [])
}

// ---- 端口 ----
async function freePort(start, end) {
  for (let port = start; port <= end; port += 1) {
    const alive = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(300) }).then(() => true).catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口')
}

const API_PORT = await freePort(8890, 8908)
const VITE_PORT = await freePort(5193, 5208)
const DEBUG_PORT = await freePort(8910, 8928)
const BASE = 'http://127.0.0.1:' + API_PORT
const WEB = 'http://127.0.0.1:' + VITE_PORT

// ---- 临时实例 + 播种（临时数据目录，不碰真实 data/） ----
const dataDir = fs.mkdtempSync(path.join(OUT_DIR, 'data-'))
const profile = fs.mkdtempSync(path.join(OUT_DIR, 'profile-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'r343-scan-key-secret'
process.env.VQ_UI_MODE = 'prod'
// 故意配成真实上游 id：证明「服务端可以下发 id，界面只显示产品口径」
process.env.LLM_MODEL = 'deepseek-flash'
process.env.LLM_FALLBACKS = 'deepseek-v4-pro'
process.env.VISION_MODEL = 'deepseek-flash'
process.env.VISION_FALLBACKS = 'deepseek-v4-pro'

const AT = String.fromCharCode(64)
const PASSWORD = 'r343-scan-pass1'
const { createSession, createUser } = await import('../server/auth.mjs')
const { markComplete } = await import('../server/onboarding.mjs')
const { grant } = await import('../server/credits.mjs')
const { createProject } = await import('../server/projects.mjs')
const { createConversation, saveConversation } = await import('../server/chat-store.mjs')
const { createRoom, addAgentMember } = await import('../server/rooms.mjs')
const { config: cfg } = await import('../server/config.mjs')

const account = createUser({ email: 'copyscan' + AT + 'scan.test', password: PASSWORD, name: '文案扫描' })
const token = createSession(account, {}).token
markComplete(account.id, { skipAssets: true })
grant(account.id, 120, { note: '文案例行起始余额' })
const project = await createProject({ title: '新品口播拆解' }, account)
// 房间：带一个平台智能体成员，才会渲染「接进来的助手」与配对码那两段文案
const room = createRoom({ userId: account.id, name: '双十一口播', topic: '拆结构与分镜' })
addAgentMember({ roomId: room.id, userId: account.id, agent: { id: 'ag_scan', name: '分镜助手', role: '把脚本拆成分镜' } })
const conv = createConversation(account.id, { title: '口播拆分镜' })
saveConversation(account.id, {
  ...conv,
  messages: [
    { id: 'm1', role: 'user', content: '把这段口播拆成分镜', at: new Date().toISOString() },
    { id: 'm2', role: 'assistant', content: '1. 开场三秒给结果\n2. 中段演示上手\n3. 结尾给下一步', at: new Date().toISOString() },
  ],
})

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR: dataDir, API_PORT: String(API_PORT), VQ_UI_MODE: 'prod', VQ_KEY_SECRET: 'r343-scan-key-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (chunk) => { serverLog += chunk })
server.stderr.on('data', (chunk) => { serverLog += chunk })

const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(VITE_PORT), '--host', '127.0.0.1'], {
  cwd: ROOT,
  env: { ...process.env, API_TARGET: BASE },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let viteLog = ''
vite.stdout.on('data', (chunk) => { viteLog += chunk })
vite.stderr.on('data', (chunk) => { viteLog += chunk })

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-sync',
  '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore' })

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params && message.params.exceptionDetails
        this.exceptions.push(String((details && ((details.exception && details.exception.description) || details.text)) || 'exception').slice(0, 200))
      }
      if (message.method === 'Log.entryAdded') {
        const entry = message.params && message.params.entry
        if (entry && entry.level === 'error') this.exceptions.push('log: ' + String(entry.text || '').slice(0, 200))
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
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() { try { this.ws.close() } catch { /* 已关 */ } }
}

let cdp = null
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result && result.exceptionDetails) throw new Error('页面里求值失败：' + JSON.stringify(result.exceptionDetails).slice(0, 200))
  return result && result.result ? result.result.value : undefined
}
async function waitFor(fn, label, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try { const value = await fn(); if (value) return value } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('等待超时：' + label)
}
async function pressEscape() {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  }
  await sleep(200)
}
async function rectOf(selector) {
  return evaluate('(function(sel){var el=document.querySelector(sel);if(!el)return null;var r=el.getBoundingClientRect();if(!r.width||!r.height)return null;return {x:r.left+r.width/2,y:r.top+r.height/2};})(' + JSON.stringify(selector) + ')')
}
async function clickSelector(selector) {
  const rect = await waitFor(() => rectOf(selector), '可点元素 ' + selector)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', clickCount: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await sleep(320)
}
async function shoot(file) {
  if (!SHOTS_DIR) return
  const captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(SHOTS_DIR, file), Buffer.from(captured.data, 'base64'))
  console.log('SHOT ' + file)
}

// 抓页面里「看得见」的文案与属性文案，带最近几层选择器，便于回源码定位
const COLLECT = String.raw`(() => {
  const out = { texts: [], attrs: [], title: document.title || '' }
  const pathOf = (el) => {
    const parts = []
    let cur = el
    let n = 0
    while (cur && cur.nodeType === 1 && n < 4) {
      let s = cur.tagName.toLowerCase()
      if (cur.id) { parts.unshift(s + '#' + cur.id); break }
      const cls = (typeof cur.className === 'string' ? cur.className : '').split(/\s+/).filter(Boolean).slice(0, 2)
      if (cls.length) s += '.' + cls.join('.')
      parts.unshift(s)
      cur = cur.parentElement
      n += 1
    }
    return parts.join('>')
  }
  const shown = (el) => {
    if (!el) return false
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    if (el.closest('[aria-hidden="true"]')) return false
    const r = el.getBoundingClientRect()
    return r.width > 1 && r.height > 1
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const text = String(node.nodeValue || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const el = node.parentElement
    if (!el || !shown(el)) continue
    if (el.closest('script,style,noscript')) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    if (!range.getClientRects().length) continue
    out.texts.push({ t: text, sel: pathOf(el) })
  }
  for (const el of document.querySelectorAll('*')) {
    if (!shown(el)) continue
    for (const attr of ['title', 'aria-label', 'placeholder', 'alt', 'aria-description']) {
      const value = el.getAttribute(attr)
      if (value && value.trim()) out.attrs.push({ a: attr, t: value.trim().replace(/\s+/g, ' '), sel: pathOf(el) })
    }
  }
  return out
})()`

const report = {
  at: new Date().toISOString(),
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  screens: [],
  api: {},
  totals: { brand: 0, internal: 0, product: 0, texts: 0, attrs: 0 },
}

// origin：ui = 普通用户界面（要降到 0）；boundary = 已知边界（服务端回显 / 用户主动打开的版本号）；
// api = 接口返回体（服务端范围，本轮只报告不改）
function scanEntry(screenName, route, kind, item, origin) {
  const brand = matchTierA(item.t)
  const product = matchTierB(item.t)
  // 内部术语与 A 档共用掩码：产品标签里的「2.0」不能被当成内部编号
  const internal = matchRules(item.t, INTERNAL_RULES)
  if (!brand.length && !product.length && !internal.length) return
  report.screens.push({ screen: screenName, route, kind, origin: origin || 'ui', from: item.a ? item.a : 'text', sel: item.sel, text: item.t.slice(0, 220), brand, product, internal })
}

async function capture(screenName, route, label, origin) {
  const collected = await evaluate(COLLECT)
  report.totals.texts += collected.texts.length
  report.totals.attrs += collected.attrs.length
  for (const item of collected.texts) scanEntry(screenName, route, 'text' + (label ? '·' + label : ''), item, origin)
  for (const item of collected.attrs) scanEntry(screenName, route, 'attr:' + item.a + (label ? '·' + label : ''), item, origin)
  if (label) report.screens.push({ screen: screenName, route, kind: 'checked-overlay', from: label, sel: '', text: '（已抓取：' + collected.texts.length + ' 段 / ' + collected.attrs.length + ' 个属性）', brand: [], product: [], internal: [] })
}

let exitCode = 0
try {
  await waitFor(async () => (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(800) })).ok, '临时实例 /api/health')
  await waitFor(async () => (await fetch(WEB + '/', { signal: AbortSignal.timeout(1500) })).ok, 'vite dev')
  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')

  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1');localStorage.setItem('vq.edition','user')}catch(e){}",
  })

  // 单页内切 hash：路由本来就监听 hashchange，不重载页面；20 屏共用同一个页面上下文
  const go = async (hash, waitSelector) => {
    await evaluate('location.hash = ' + JSON.stringify(hash))
    await sleep(400)
    try {
      // vite dev 冷启动要把 App 整张模块图编译一遍（实测 ~48s），这里给足 100s；
      // 命中就立刻返回，不会白等
      await waitFor(() => evaluate('Boolean(document.querySelector(".vq-content") || document.querySelector(".vq-login"))'), '外壳 ' + hash, 500)
    } catch (error) {
      const dump = await evaluate('({href:location.href, title:document.title, body:String(document.body.innerHTML||"").slice(0,1200), text:String(document.body.innerText||"").slice(0,600)})').catch(() => null)
      console.error('--- 外壳等待失败现场 @' + hash + ' ---')
      console.error(JSON.stringify(dump))
      console.error('页面异常：' + JSON.stringify(cdp.exceptions.slice(-8)))
      const res = await evaluate('performance.getEntriesByType("resource").map(function(r){return r.name.slice(-60)+" "+(r.responseStatus||"")}).slice(-20)').catch(() => null)
      console.error('资源：' + JSON.stringify(res))
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).catch(() => null)
      if (shot) fs.writeFileSync(path.join(OUT_DIR, 'fail-' + hash.replace(/[^a-z0-9]+/gi, '-') + '.png'), Buffer.from(shot.data, 'base64'))
      throw error
    }
    if (waitSelector) await waitFor(() => evaluate('Boolean(document.querySelector(' + JSON.stringify(waitSelector) + '))'), '元素 ' + waitSelector + ' @ ' + hash, 60).catch(() => null)
    await sleep(1100)
  }

  await cdp.send('Page.navigate', { url: WEB + '/?n=' + Date.now() + '#/overview' })
  const SHELL_SCREENS = [
    { hash: '#/overview', name: '工作台' },
    { hash: '#/projects', name: '我的作品' },
    { hash: '#/projects/' + project.id, name: '作品详情' },
    { hash: '#/radar', name: '爆款雷达' },
    { hash: '#/templates', name: '模板库' },
    { hash: '#/rooms', name: '聊天室' },
    { hash: '#/agents', name: '快捷创作', sel: '.qc-input' },
    { hash: '#/agents/new', name: '对话预设编辑' },
    { hash: '#/runs', name: '积分记录' },
    { hash: '#/review', name: '视觉评审' },
    { hash: '#/assets', name: '我的资产' },
    { hash: '#/settings', name: '设置' },
    { hash: '#/recharge', name: '充值' },
    { hash: '#/board', name: '无限画布' },
  ]
  for (const screen of SHELL_SCREENS) {
    await go(screen.hash, screen.sel)
    await capture(screen.name, screen.hash, '')

    if (screen.name === '工作台') {
      await clickSelector('.vq-search--trigger').catch(() => null)
      await capture(screen.name, screen.hash, '快速跳转浮层')
      await pressEscape()
      await clickSelector('.vq-topbar-account-trigger').catch(() => null)
      await capture(screen.name, screen.hash, '账号菜单')
      await pressEscape()
      await clickSelector('.vq-model-trigger').catch(() => null)
      await capture(screen.name, screen.hash, '模型切换浮层')
      await pressEscape()
      await shoot('scan-overview.png')
    }
    if (screen.name === '设置') {
      await clickSelector('.vq-version-trigger').catch(() => null)
      // 版本信息弹窗由用户主动打开，里面就是要给他看的版本号：算已知边界，不算小字
      await capture(screen.name, screen.hash, '版本信息弹窗', 'boundary')
      await pressEscape()
    }
    if (screen.name === '快捷创作') {
      await clickSelector('.qc-side-toggle').catch(() => null)
      await capture(screen.name, screen.hash, '对话列表抽屉')
      await clickSelector('.qc-side-toggle').catch(() => null)
      await evaluate('(function(){var el=document.querySelector(".qc-input");if(el){el.focus();return true}return false})()')
      await cdp.send('Input.insertText', { text: '/生图 3:4 白底产品图' })
      await sleep(700)
      await capture(screen.name, screen.hash, '生成设置行')
      await shoot('scan-agents-gen.png')
      // r343：鼠标停到「画质」那一档上再截一张（原生 tooltip 在无头截图里不保证画出来，
      // 文案本身以 attr:title 命中为准；这张图用来給出生成设置行的真实渲染）
      const chip = await evaluate(
        '(function(){var els=document.querySelectorAll(".qc-gen-chip");for(var i=0;i<els.length;i++){if((els[i].textContent||"").indexOf("画质")>=0){var r=els[i].getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}}}return null})()',
      ).catch(() => null)
      if (chip && Number.isFinite(chip.x)) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chip.x, y: chip.y }).catch(() => null)
        await sleep(1500)
        await shoot('scan-agents-gen-tip.png')
      }
      // r343：把播种的那条对话点开——消息正文与助手标签「VisionQA 通用模型」也要扫到，
      // 顺便留一张真实渲染的对话截图（改前这一屏只有空状态，消息正文从来没被扫过）
      await clickSelector('.qc-side-toggle').catch(() => null)
      await clickSelector('.qc-conv-main').catch(() => null)
      await clickSelector('.qc-side-toggle').catch(() => null)
      await waitFor(() => evaluate('Boolean(document.querySelector(".qc-msg-meta"))'), '对话消息', 40).catch(() => null)
      await sleep(700)
      await capture(screen.name, screen.hash, '对话消息')
      await shoot('scan-chat-messages.png')
      await evaluate('(function(){var el=document.querySelector(".qc-input");if(el){el.focus();return true}return false})()')
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await sleep(200)
    }
  }

  // 报错页：不存在的作品 / 模板 / 只读分享链接 / 回执
  const ERROR_SCREENS = [
    { hash: '#/projects/no-such-project-x', name: '作品不存在' },
    { hash: '#/templates/no-such-template-x', name: '模板不存在' },
    { hash: '#/share/no-such-share-x', name: '分享链接失效' },
    // 服务端 404 原文直接回显（server/routes/projects.mjs），文案不在本轮范围：算已知边界
    { hash: '#/receipt/no-such-receipt-x', name: '回执链接失效', origin: 'boundary' },
  ]
  for (const screen of ERROR_SCREENS) {
    await evaluate('location.hash = ' + JSON.stringify(screen.hash))
    await sleep(2000)
    await capture(screen.name, screen.hash, '', screen.origin)
  }

  // 公开页（帮助中心与条款不挡人）
  const PUBLIC_SCREENS = [
    { hash: '#/help', name: '帮助中心' },
    { hash: '#/sources', name: '素材来源' },
    { hash: '#/legal/terms', name: '服务条款' },
    { hash: '#/legal/privacy', name: '隐私政策' },
  ]
  for (const screen of PUBLIC_SCREENS) {
    await evaluate('location.hash = ' + JSON.stringify(screen.hash))
    await sleep(1600)
    await capture(screen.name, screen.hash, '')
  }

  // 未登录：登录 / 注册入口
  await cdp.send('Network.clearBrowserCookies')
  await cdp.send('Page.navigate', { url: WEB + '/?n=' + Date.now() + '#/overview' })
  await sleep(2400)
  await capture('登录', '未登录', '')
  await shoot('scan-login.png')
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })

  // ---- 接口下发的厂牌名 ----
  for (const apiPath of ['/api/models', '/api/version']) {
    const response = await fetch(BASE + apiPath, { headers: { cookie: cfg.auth.cookieName + '=' + token } })
    const body = await response.text()
    const brand = matchTierA(body)
    report.api[apiPath] = { status: response.status, bytes: body.length, brand, body: body.slice(0, 2000) }
    for (const hit of brand) {
      report.screens.push({ screen: '接口 ' + apiPath, route: apiPath, kind: 'api-json', origin: 'api', from: 'body', sel: '', text: '（JSON 返回体）', brand: [hit], product: [], internal: [] })
    }
  }

  // 去重计数：每个桶按「屏 + 类别 + 规则 + 命中词」计 1 条
  const bucket = { uiBrand: new Set(), uiInternal: new Set(), uiProduct: new Set(), apiBrand: new Set(), boundary: new Set() }
  for (const item of report.screens) {
    for (const hit of item.brand) {
      const key = [item.screen, item.kind, hit.rule, hit.word.toLowerCase()].join('|')
      if (item.origin === 'api') bucket.apiBrand.add(key)
      else if (item.origin === 'boundary') bucket.boundary.add(key)
      else bucket.uiBrand.add(key)
    }
    for (const hit of item.internal) {
      const key = [item.screen, item.kind, hit.rule, hit.word.toLowerCase()].join('|')
      if (item.origin === 'boundary') bucket.boundary.add(key)
      else if (item.origin !== 'api') bucket.uiInternal.add(key)
    }
    // B 档只数普通用户界面：接口返回体 / 已知边界里的产品标签另有出处
    for (const hit of item.product || []) {
      if (item.origin !== 'ui') continue
      bucket.uiProduct.add([item.screen, item.kind, hit.rule, hit.word.toLowerCase()].join('|'))
    }
  }
  report.totals.brand = bucket.uiBrand.size
  report.totals.internal = bucket.uiInternal.size
  report.totals.product = bucket.uiProduct.size
  report.totals.apiBrand = bucket.apiBrand.size
  report.totals.boundary = bucket.boundary.size

  console.log('=== r343 文案扫描 · v' + report.version + ' ===')
  console.log('口径：A 档＝上游厂牌 / 内部模型 id（必须 0，退出码只看它）；B 档＝自有产品标签（只统计，不阻塞）')
  console.log('文案片段 ' + report.totals.texts + ' · 属性文案 ' + report.totals.attrs)
  console.log('A 档 · 普通用户界面：' + report.totals.brand + ' 条（要求 0） · 内部术语：' + report.totals.internal + ' 条（要求 0）')
  console.log('B 档 · 普通用户界面自有产品标签：' + report.totals.product + ' 条（允许存在，不算命中）')
  console.log('接口返回体（服务端范围）：A 档 ' + report.totals.apiBrand + ' 条')
  console.log('已知边界（不计入）：' + report.totals.boundary + ' 条')
  for (const item of report.screens) {
    if (item.origin === 'api') continue
    if (!item.brand.length && !item.internal.length) continue
    const tag = item.origin === 'boundary' ? 'BOUND ' : item.brand.length ? 'BRAND ' : 'SMALL '
    console.log(tag + '[' + item.screen + '] ' + item.route + ' · ' + item.kind + ' · ' + item.sel)
    const hits = [...item.brand, ...item.internal].map((hit) => hit.rule + '=' + hit.word).join(', ')
    console.log('       ' + hits + '  ::  ' + item.text.slice(0, 160))
  }
  const productHits = new Set()
  for (const item of report.screens) {
    if (item.origin !== 'ui') continue
    for (const hit of item.product || []) productHits.add(item.screen + ' · ' + hit.rule)
  }
  for (const line of productHits) console.log('PROD   ' + line)
  for (const apiPath of Object.keys(report.api)) {
    const entry = report.api[apiPath]
    if (entry.brand.length) console.log('API    ' + apiPath + ' :: ' + entry.brand.map((hit) => hit.rule + '=' + hit.word).join(', '))
  }
  exitCode = report.totals.brand > 0 || report.totals.internal > 0 ? 1 : 0
} catch (error) {
  console.error('扫描失败：' + (error && error.stack ? error.stack : error))
  console.error('--- server log ---\n' + serverLog.slice(-1500))
  console.error('--- vite log ---\n' + viteLog.slice(-1500))
  exitCode = 2
} finally {
  fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true })
  fs.writeFileSync(JSON_PATH, JSON.stringify(report, null, 2), 'utf8')
  console.log('JSON -> ' + JSON_PATH)
  try { cdp && cdp.close() } catch { /* 已关 */ }
  chrome.kill()
  vite.kill()
  server.kill()
  await sleep(1500)
  // 服务端可能还握着 sqlite/WAL 文件：删不掉就留着，别让清理失败盖掉扫描结论
  if (!KEEP) { try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { console.log('（临时数据目录没删掉：' + dataDir + '）') } }
}
process.exit(exitCode)
