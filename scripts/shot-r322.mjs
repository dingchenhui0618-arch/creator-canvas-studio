// 真实渲染截图（r322）：充值页运营位 + 关闭动效取证。
//
// 与 r315–r320 同一套做法：临时实例 + 真账号 + 真 SQLite + 真渲染，0 次上游调用、0 积分。
// 这一轮要证明四件事，全都要有数字：
//   0) 生产现状那一版也拍：临时实例完全不 PUT，/api/admin/promos 回 source=default，
//      用户看到的就是默认内容里 placement=recharge 的那条（标题/按钮取响应字符串，不手写）；
//   1) 充值页真的挂上了运营位，而且内容是管理员经 PUT /api/admin/promos 写进去的（不是前端里正好写着）；
//   2) internal 那条普通账号看不到；配在 templates 上的那条不会跑到充值页；
//   3) 关一条是「先塌下去再移除」：100–150ms 时它还在 DOM、带 is-leaving、高度已变小但没到 0；
//      700ms 后不在 DOM，关掉的 id 落进 localStorage；刷新后仍然不出现；同位置的下一条补位。
//   4) 塌陷是「先收干净、再移除，下面那条不动」：移除前最后一个采样里第一张高度 ≤2px；
//      第二张（.vq-promo:nth-child(2)，同一个节点）的 getBoundingClientRect().top 在
//      「移除前最后采样 → 移除后第一次采样」以及 700ms 那次都相差 ≤1px。
//      间距若留在容器的 gap 上就收不掉，会在移除那一刻整条跳一下，这条断言就是抓它。
//
// 用法：node scripts/shot-r322.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 SHOT_CHROME 指定）')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const alive = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(400) }).then(() => true).catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口')
}

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8992))
const DEBUG_PORT = await freePort(API_PORT + 60)
const BASE = 'http://127.0.0.1:' + API_PORT

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot322-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot322-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const ADMIN_EMAIL = 'shot322-admin' + AT + 'shot.test'
const USER_EMAIL = 'shot322-user' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

const admin = createUser({ email: ADMIN_EMAIL, password: PASSWORD, name: '运营', kind: 'admin' })
const adminToken = createSession(admin, {}).token
const user = createUser({ email: USER_EMAIL, password: PASSWORD, name: '林可' })
const token = createSession(user, {}).token

// 运营位内容：这一份只是「管理员在后台填的东西」；页面上出现的每个字都要能对回 PUT 的响应
// （见下面的 DOM ↔ 响应比对），所以断言里一律用响应里的 id / title。
const PROMOS = [
  { id: 'r322-rc-a', placement: 'recharge', weight: 90, kicker: '新功能', title: '充值页运营位 A · 权重 90', body: '内容由后台写，刷新就生效；关掉一条，这个位置上的下一条会补位。', cta: '去看看', page: 'rooms' },
  { id: 'r322-rc-b', placement: 'recharge', weight: 70, kicker: 'Beta', title: '充值页运营位 B · 权重 70', body: '同位置按权重从大到小，一屏最多显示两条。', cta: '去看看', page: 'review' },
  { id: 'r322-rc-c', placement: 'recharge', weight: 50, kicker: '备位', title: '充值页运营位 C · 权重 50', body: '关掉 A 或 B 之后，这一条才会顶上来。', cta: '去看看', page: 'radar' },
  { id: 'r322-rc-internal', placement: 'recharge', weight: 100, kicker: '内部口径', title: '内部口径那条（普通账号看不到）', body: '权重最高，但 internal=true：公开接口按身份过滤，普通账号看不到。', cta: '去看看', page: 'rooms', internal: true },
  { id: 'r322-tpl-a', placement: 'templates', weight: 60, kicker: '模板库', title: '模板库那条（不该跑到充值页）', body: '位置只认 placement：配在模板库上的不会出现在充值页。', cta: '去检索', page: 'templates' },
]

console.log('临时实例 · ' + dataDir + ' · 端口 ' + API_PORT)

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
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

async function waitFor(check, label, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try { const value = await check(); if (value) return value } catch { /* 还没起来 */ }
    await sleep(300)
  }
  throw new Error('等待超时：' + label)
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.errors = []
    this.frames = []
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params?.exceptionDetails?.text || 'exception')
      // screencast 的每一帧都要 ack，否则浏览器只发一帧就停
      if (message.method === 'Page.screencastFrame' && message.params?.data) {
        this.frames.push({ at: Date.now(), bytes: message.params.data.length })
        this.send('Page.screencastFrameAck', { sessionId: message.params.sessionId }).catch(() => {})
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
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
  close() { try { this.ws.close() } catch { /* 已经关了 */ } }
}

let cdp = null
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result?.result?.value
}

/** 等页面上真的出现某个选择器（懒加载的页面 chunk 要时间）。 */
async function waitForSelector(selector, label, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const found = await evaluate('Boolean(document.querySelector(' + JSON.stringify(selector) + '))')
    if (found) return true
    await sleep(300)
  }
  throw new Error('等不到元素：' + label)
}

/** 等到某个选择器至少有 n 个：运营位是「请求回来才上屏」的，固定 sleep 会量到空气。 */
async function waitForCount(selector, n, label, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const count = await evaluate('document.querySelectorAll(' + JSON.stringify(selector) + ').length')
    if (Number(count) >= n) return Number(count)
    await sleep(300)
  }
  throw new Error('等不到 ' + n + ' 个 ' + label)
}

const RECHARGE_TITLES = "(() => [...document.querySelectorAll('.vq-promos[data-placement=\"recharge\"] .vq-promo-title')].map((el) => el.textContent))()"

/** 等到充值页运营位标题正好是这几条（关掉一条之后要等补位落下来）。 */
async function waitForTitles(expected, label, tries = 40) {
  let titles = []
  for (let i = 0; i < tries; i += 1) {
    titles = await evaluate(RECHARGE_TITLES)
    if (titles.join(' | ') === expected.join(' | ')) return titles
    await sleep(300)
  }
  throw new Error(label + '：等不到 ' + JSON.stringify(expected) + '，现在是 ' + JSON.stringify(titles))
}

async function open({ width, height, page = 'recharge', as = token, who = user }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: as, domain: '127.0.0.1', path: '/', httpOnly: true })
  // 提示条用样式藏起来，绝不手工移除节点：那些节点 React 还在管，
  // 手工 remove 之后 React 下一次更新会抛 NotFoundError removeChild，整棵树会当场卸掉（r320 实测白屏）。
  const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + who.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}"
      + "try{document.addEventListener('DOMContentLoaded',function(){var s=document.createElement('style');s.textContent='.vq-toast{display:none !important}';document.head.appendChild(s)})}catch(e){}",
  })
  await cdp.send('Page.navigate', { url: BASE + '/?as=' + encodeURIComponent(who.id) + '&shot=' + Date.now() + '#/' + page })
  await sleep(2600)
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier })
}

async function shoot(out) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB · ' + fs.statSync(out).size + ' B')
}

/**
 * 双 rAF 的落地延迟。headless 里如果没人消费帧，requestAnimationFrame 会被拖到下一次出帧
 * （实测 idle 时 ~110ms、screencast 常出帧时 ~33ms），组件里「钉住高度 → 下一帧收到 0」
 * 那一步也就跟着晚落地。量出来是为了让 100–150ms 的采样有参照。
 */
async function rafProbe() {
  return evaluate('(async () => { const t0 = performance.now(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); return Math.round(performance.now() - t0) })()')
}

/** screencast 让浏览器持续出帧：既是让 rAF 正常跑，也是「真渲染」的帧源。 */
async function startScreencast(width, height) {
  cdp.frames = []
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: width, maxHeight: height, everyNthFrame: 1 })
  await sleep(800)
}

async function stopScreencast() {
  try { await cdp.send('Page.stopScreencast') } catch { /* 已经停了 */ }
}

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const headers = { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token }
  const adminHeaders = { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + adminToken }



  const creditsBefore = await fetch(BASE + '/api/credits', { headers }).then((r) => r.json())
  console.log('跑之前余额：' + creditsBefore.balance)

  // 身份引导先收尾，否则充值页上会盖着引导
  const identity = await fetch(BASE + '/api/onboarding', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ identity: 'creator', category: '数码家电', direction: '充值页运营位' }),
  })
  if (!identity.ok) throw new Error('写身份失败：' + identity.status)
  const finished = await fetch(BASE + '/api/onboarding/complete', { method: 'POST', headers, body: JSON.stringify({ skipAssets: true }) })
  if (!finished.ok) throw new Error('收尾引导失败：' + finished.status)

  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')

  // 0) 先拍「生产现状」那张：这个实例从头到尾没 PUT 过，/api/admin/promos 回 source=default，
  //    也就是线上后台从没存过运营位时用户会看到的东西。标题与按钮一律取响应里的字符串，不手写。
  const defaultAdminView = await fetch(BASE + '/api/admin/promos', { headers: adminHeaders }).then((r) => r.json())
  const defaultPublic = await fetch(BASE + '/api/promos', { headers }).then((r) => r.json())
  const defaultRecharge = defaultPublic.promos.find((item) => item.placement === 'recharge')
  console.log('默认态：source=' + defaultAdminView.source + ' · promos.json 里有后台存过的那份吗 ' + fs.existsSync(path.join(dataDir, 'promos.json')) + ' · 公开 ' + defaultPublic.promos.length + ' 条 · 充值位 ' + JSON.stringify(defaultRecharge && { id: defaultRecharge.id, title: defaultRecharge.title, cta: defaultRecharge.cta }))
  if (defaultAdminView.source !== 'default') throw new Error('还没 PUT 就不是 default 了：' + defaultAdminView.source)
  if (fs.existsSync(path.join(dataDir, 'promos.json'))) throw new Error('临时实例里已经有一份后台存的运营位，拍不出默认态')
  if (!defaultRecharge) throw new Error('默认内容里没有 placement=recharge 的运营位')

  await open({ width: 1440, height: 1000 })
  await waitForSelector('.vq-promos[data-placement="recharge"]', '默认态充值页运营位')
  await waitForCount('.vq-promos[data-placement="recharge"] .vq-promo', 1, '默认态充值页运营位条数')
  await evaluate("(() => { window.scrollTo(0, 0); return true })()")
  await sleep(500)
  const defaultState = await evaluate('(() => ({ titles: ' + RECHARGE_TITLES + ', cta: [...document.querySelectorAll(".vq-promos[data-placement=\\"recharge\\"] .vq-promo-cta")].map((el) => el.textContent.trim()), body: (document.querySelector(".vq-promo-body") || {}).textContent, kicker: (document.querySelector(".vq-promo-kicker") || {}).textContent, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()')
  console.log('1440 默认态充值页：' + JSON.stringify(defaultState))
  if (!defaultState.titles.includes(defaultRecharge.title)) throw new Error('充值页显示的不是响应里 placement=recharge 的那条：' + JSON.stringify(defaultState.titles) + ' vs ' + defaultRecharge.title)
  if (defaultState.titles.length !== 1) throw new Error('默认态充值位只该有一条：' + JSON.stringify(defaultState.titles))
  if (!defaultState.cta.some((text) => text.includes(defaultRecharge.cta))) throw new Error('按钮文字对不上响应：' + JSON.stringify(defaultState.cta) + ' vs ' + defaultRecharge.cta)
  if (defaultState.overflow > 1) throw new Error('默认态 1440 横向溢出：' + defaultState.overflow)
  await shoot(path.join('docs', 'r322-recharge-default-1440.png'))

  // 0b) 接着才是「管理员经真接口写进去」的那一套
  // 0) 运营位必须由管理员经真接口写进去
  const savedRes = await fetch(BASE + '/api/admin/promos', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ promos: PROMOS }) })
  const savedBody = await savedRes.json()
  if (!savedRes.ok || !savedBody.ok) throw new Error('写运营位失败：' + savedRes.status + ' ' + JSON.stringify(savedBody).slice(0, 200))
  const saved = savedBody.promos
  console.log('后台写入（PUT /api/admin/promos）：' + savedRes.status + ' · ' + saved.length + ' 条 · source=' + savedBody.source + ' · updatedBy=' + savedBody.updatedBy)
  const byId = new Map(saved.map((item) => [item.id, item]))
  for (const promo of PROMOS) {
    if (!byId.has(promo.id)) throw new Error('响应里没有 ' + promo.id + '：' + JSON.stringify(saved.map((item) => item.id)))
  }
  if (saved.length !== PROMOS.length) throw new Error('后台存的条数不对：' + saved.length)

  // 普通账号从公开接口拿到的应该已经滤掉 internal 那条
  const publicView = await fetch(BASE + '/api/promos', { headers }).then((r) => r.json())
  const publicIds = publicView.promos.map((item) => item.id)
  console.log('普通账号 /api/promos：' + JSON.stringify(publicIds))
  if (publicIds.includes('r322-rc-internal')) throw new Error('公开接口把 internal 那条给了普通账号')
  if (publicIds.length !== PROMOS.length - 1) throw new Error('internal 那条没被滤掉：' + JSON.stringify(publicIds))

  const expectAB = [byId.get('r322-rc-a').title, byId.get('r322-rc-b').title]
  const expectBC = [byId.get('r322-rc-b').title, byId.get('r322-rc-c').title]

  // 1) 1440 充值页：两条来自服务端，internal 与 templates 的都不在
  await open({ width: 1440, height: 1000 })
  await waitForSelector('.vq-promos[data-placement="recharge"]', '充值页运营位')
  await waitForCount('.vq-promos[data-placement="recharge"] .vq-promo', 2, '充值页运营位条数')
  await evaluate("(() => { window.scrollTo(0, 0); return true })()")
  await sleep(500)
  const first = await evaluate('(() => ({ titles: ' + RECHARGE_TITLES + ', placements: [...document.querySelectorAll(".vq-promos")].map((el) => el.getAttribute("data-placement")), hasTemplatesSlot: Boolean(document.querySelector(".vq-promos[data-placement=\\"templates\\"]")), stagger: (document.querySelector(".vq-promos[data-placement=\\"recharge\\"]") || {}).className, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, pageClass: (document.querySelector(".page") || {}).className }))()')
  console.log('1440 充值页：' + JSON.stringify(first))
  if (first.titles.join(' | ') !== expectAB.join(' | ')) throw new Error('充值页显示的运营位不是服务端按权重给的两条：' + JSON.stringify(first.titles))
  if (!String(first.stagger).includes('vq-stagger')) throw new Error('运营位没有走逐条进场：' + first.stagger)
  if (first.placements.join(',') !== 'recharge') throw new Error('页面上有别的运营位位置：' + JSON.stringify(first.placements))
  if (first.hasTemplatesSlot) throw new Error('充值页上出现了 templates 的运营位容器')
  const pageText = String(await evaluate('document.body.innerText'))
  for (const promo of [byId.get('r322-rc-internal'), byId.get('r322-tpl-a'), byId.get('r322-rc-c')]) {
    if (pageText.includes(promo.title)) throw new Error('充值页上出现了不该显示的运营位：' + promo.title)
  }
  if (first.overflow > 1) throw new Error('1440 横向溢出：' + first.overflow)
  await shoot(path.join('docs', 'r322-recharge-promo-1440.png'))

  // 2) 关闭动效取证：100–150ms 采样 + 700ms 后落库
  const rafIdle = await rafProbe()
  await startScreencast(1440, 1000)
  const rafStreaming = await rafProbe()
  console.log('双 rAF 落地延迟：idle ' + rafIdle + 'ms → screencast 出帧中 ' + rafStreaming + 'ms')
  const closeProbe = await evaluate(`(async () => {
    const slot = document.querySelector('.vq-promos[data-placement="recharge"]')
    const art = slot ? slot.querySelector('.vq-promo') : null
    if (!art) return { ok: false, reason: 'no-card' }
    const title = (art.querySelector('.vq-promo-title') || {}).textContent || ''
    const before = art.offsetHeight
    // 下面那一条：关的是第一张，它全程不该被「移除」这件事挪动。
    const artB = slot.querySelector('.vq-promo:nth-child(2)')
    if (!artB) return { ok: false, reason: 'no-second-card' }
    const readTopB = () => (artB.isConnected ? Math.round(artB.getBoundingClientRect().top * 100) / 100 : null)
    const topBBefore = readTopB()
    const btn = art.querySelector('.vq-promo-close')
    if (!btn) return { ok: false, reason: 'no-close' }
    const t0 = performance.now()
    btn.click()
    const curve = []
    const sample = (ms) => new Promise((resolve) => setTimeout(() => {
      const live = art.isConnected
      curve.push({
        ms: Math.round(performance.now() - t0),
        connected: live,
        cls: live ? art.className : '',
        leaving: live ? art.className.includes('is-leaving') : false,
        height: live ? Math.round(art.offsetHeight) : 0,
        inlineMaxHeight: live ? art.style.maxHeight : '',
        computed: live ? (() => { const cs = getComputedStyle(art); return { boxSizing: cs.boxSizing, maxHeight: cs.maxHeight, cssHeight: cs.height, padTop: cs.paddingTop, padBottom: cs.paddingBottom, borderTop: cs.borderTopWidth, rectHeight: Math.round(art.getBoundingClientRect().height), display: cs.display, alignSelf: cs.alignSelf } })() : null,
        opacity: live ? Number(getComputedStyle(art).opacity) : null,
        topB: readTopB(),
      })
      resolve(curve[curve.length - 1])
    }, Math.max(0, ms - (performance.now() - t0))))
    for (let ms = 25; ms <= 500; ms += 25) await sample(ms)
    const at700 = await sample(700)
    const live = curve.filter((row) => row.connected)
    const shrinking = live.filter((row) => row.leaving && row.height > 0 && row.height < before)
    const lastLive = live[live.length - 1] || null
    const afterLast = lastLive ? curve[curve.indexOf(lastLive) + 1] || null : null
    return {
      ok: true,
      title,
      before,
      topBBefore,
      lastLive,
      afterLast,
      curve,
      window120: live.find((row) => row.ms >= 100 && row.ms <= 150) || null,
      firstShrink: shrinking[0] || null,
      shrinkingCount: shrinking.length,
      minHeight: live.reduce((min, row) => Math.min(min, row.height), before),
      minOpacity: live.reduce((min, row) => Math.min(min, row.opacity), 1),
      removedAtMs: (curve.find((row) => !row.connected) || {}).ms || null,
      at700,
      dismissed: window.localStorage.getItem('vq_promos_dismissed'),
    }
  })()`)
  console.log('塌陷曲线（点后 ms:高度）：' + closeProbe.curve.map((row) => row.ms + ':' + (row.connected ? row.height : 'gone')).join(' '))
  console.log('塌陷曲线（点后 ms:第二张 topB）：' + closeProbe.curve.map((row) => row.ms + ':' + (row.connected ? row.topB : 'gone')).join(' '))
  console.log('曲线细节（75–200ms 与最后有值的几个采样）：' + JSON.stringify(closeProbe.curve.filter((row) => row.connected && (row.ms <= 200 || row.height > 0)).map((row) => ({ ms: row.ms, h: row.height, c: row.computed })).slice(-8)))
  if (!closeProbe.ok) throw new Error('关闭取证没跑起来：' + closeProbe.reason)
  if (closeProbe.title !== byId.get('r322-rc-a').title) throw new Error('闭掉的不是权重最高的那条 A：' + closeProbe.title)
  if (!(closeProbe.before > 0)) throw new Error('点击前没量到高度')
  const mid120 = closeProbe.window120
  if (!mid120) throw new Error('100–150ms 这一档没采到')
  if (!mid120.connected) throw new Error('100–150ms 时卡片已经不在 DOM（是一步消失，不是塌下去）')
  if (!mid120.leaving) throw new Error('100–150ms 时没有 is-leaving：' + JSON.stringify(mid120))
  if (!(mid120.height > 0)) throw new Error('100–150ms 时高度已经到 0：' + JSON.stringify(mid120))
  if (!(mid120.height < closeProbe.before * 0.9)) throw new Error('100–150ms 时高度没明显变小：' + JSON.stringify(mid120) + ' · 点前 ' + closeProbe.before)
  if (closeProbe.shrinkingCount < 2) throw new Error('没有采到连续的塌陷中间态：' + closeProbe.shrinkingCount)
  if (!(closeProbe.minHeight < closeProbe.before)) throw new Error('整条曲线里高度从没变小过')
  if (closeProbe.at700.connected) throw new Error('700ms 后卡片还在 DOM：' + JSON.stringify(closeProbe.at700))
  if (!(closeProbe.removedAtMs > 0 && closeProbe.removedAtMs <= 700)) throw new Error('移除时间不在 0–700ms：' + closeProbe.removedAtMs)
  console.log('中间态：' + closeProbe.shrinkingCount + ' 个采样落在 0 < h < 点前 · 最小 ' + closeProbe.minHeight + 'px · 首个 ' + JSON.stringify(closeProbe.firstShrink) + ' · 移除于 ' + closeProbe.removedAtMs + 'ms · 撤下期间最小 opacity ' + closeProbe.minOpacity)
  // 本轮最关键的新证据：下面那条不能跳。第一张先收干净（≤2px）才被移除，
  // 移除前后第二张的 top 必须原地不动（≤1px）；但它整段确实跟着塌陷上移过（>50px），
  // 否则「不跳」是因为根本没动，这个断言就没意义。
  const lastLive = closeProbe.lastLive
  const afterLast = closeProbe.afterLast
  if (!lastLive) throw new Error('整段曲线里没有一个「还在 DOM」的采样')
  if (closeProbe.topBBefore === null) throw new Error('第二条卡没量到 top')
  if (!(lastLive.height <= 2)) throw new Error('移除前最后一个采样里第一张还没收干净：' + lastLive.height + 'px')
  if (!afterLast || afterLast.connected) throw new Error('拿不到「移除后的第一个采样」：' + JSON.stringify(afterLast))
  if (lastLive.topB === null || afterLast.topB === null || closeProbe.at700.topB === null) throw new Error('第二张的 top 采样丢了：' + JSON.stringify({ before: closeProbe.topBBefore, last: lastLive.topB, after: afterLast.topB, at700: closeProbe.at700.topB }))
  const jumpAtRemoval = Math.round(Math.abs(afterLast.topB - lastLive.topB) * 100) / 100
  const jumpAt700 = Math.round(Math.abs(closeProbe.at700.topB - lastLive.topB) * 100) / 100
  const travel = Math.round((closeProbe.topBBefore - lastLive.topB) * 100) / 100
  console.log('第二条卡 top：点前 ' + closeProbe.topBBefore + ' → 收起后（移除前最后采样 ' + lastLive.ms + 'ms，第一张 ' + lastLive.height + 'px）' + lastLive.topB + '，整段共上移 ' + travel + 'px')
  console.log('移除前后：' + lastLive.topB + '（' + lastLive.ms + 'ms，还在）→ ' + afterLast.topB + '（' + afterLast.ms + 'ms，已移除）差 ' + jumpAtRemoval + 'px · 700ms 时 ' + closeProbe.at700.topB + ' 差 ' + jumpAt700 + 'px')
  if (!(travel > 50)) throw new Error('第二条在整段塌陷里几乎没动（' + travel + 'px），「不跳」这条断言不算数')
  if (!(jumpAtRemoval <= 1)) throw new Error('移除那一刻第二条跳了 ' + jumpAtRemoval + 'px（> 1）')
  if (!(jumpAt700 <= 1)) throw new Error('700ms 时第二条相对移除前差了 ' + jumpAt700 + 'px（> 1）')

  const storedIds = JSON.parse(closeProbe.dismissed || '[]')
  if (storedIds.length !== 1 || storedIds[0] !== 'r322-rc-a') throw new Error('localStorage 里关掉的 id 不对：' + JSON.stringify(storedIds))

  // 3) 补位：A 走了，同位置的 C 顶上来
  const afterClose = await waitForTitles(expectBC, '关掉 A 之后补位')
  console.log('关掉 A 之后同屏：' + JSON.stringify(afterClose))
  const afterText = String(await evaluate('document.body.innerText'))
  if (afterText.includes(byId.get('r322-rc-a').title)) throw new Error('关掉的 A 还在页面上')

  // 4) 刷新后仍然不出现
  await open({ width: 1440, height: 1000 })
  const reloaded = await waitForTitles(expectBC, '刷新后仍然是 B / C')
  const reloadState = await evaluate("(() => ({ titles: " + RECHARGE_TITLES + ", dismissed: window.localStorage.getItem('vq_promos_dismissed') }))()")
  console.log('刷新后：' + JSON.stringify(reloadState))
  if (reloaded.includes(byId.get('r322-rc-a').title)) throw new Error('刷新后关掉的 A 又回来了')
  if (!JSON.parse(reloadState.dismissed || '[]').includes('r322-rc-a')) throw new Error('刷新后本地那份「关掉过」丢了')

  // 5) 390：窄屏无横向溢出
  await open({ width: 390, height: 900 })
  await waitForCount('.vq-promos[data-placement="recharge"] .vq-promo', 2, '充值页运营位（390）')
  await evaluate("(() => { window.scrollTo(0, 0); return true })()")
  await sleep(500)
  const narrow = await evaluate('(() => { const slot = document.querySelector(".vq-promos[data-placement=\\"recharge\\"]"); const art = slot ? slot.querySelector(".vq-promo") : null; return { titles: ' + RECHARGE_TITLES + ', docScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth, delta: document.documentElement.scrollWidth - document.documentElement.clientWidth, slotOverflow: slot ? slot.scrollWidth - slot.clientWidth : 0, cardOverflow: art ? art.scrollWidth - art.clientWidth : 0, body: (document.querySelector(".vq-promo-body") || {}).textContent, closeBox: (() => { const b = document.querySelector(".vq-promo-close"); if (!b) return null; const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) } })() } })()')
  console.log('390 充值页：' + JSON.stringify(narrow))
  if (narrow.docScrollWidth !== narrow.innerWidth) throw new Error('390 横向溢出：scrollWidth ' + narrow.docScrollWidth + ' !== innerWidth ' + narrow.innerWidth)
  if (narrow.delta > 1) throw new Error('390 横向溢出（clientWidth 口径）：' + narrow.delta)
  if (narrow.slotOverflow > 1 || narrow.cardOverflow > 1) throw new Error('运营位自身溢出：' + JSON.stringify(narrow))
  if (!narrow.body) throw new Error('390 上运营位正文没了')
  if (!narrow.closeBox || narrow.closeBox.right > narrow.innerWidth) throw new Error('390 上关闭按钮跑出屏幕：' + JSON.stringify(narrow.closeBox))
  await shoot(path.join('docs', 'r322-recharge-promo-390.png'))

  // 6) 关闭中间帧：点完立刻截，能看到卡片正在淡出/收拢
  const midProbe = "(() => { const el = document.querySelector('.vq-promos[data-placement=\"recharge\"] .vq-promo'); if (!el) return { connected: false }; const cs = getComputedStyle(el); return { connected: true, leaving: el.className.includes('is-leaving'), height: Math.round(el.offsetHeight), inlineMaxHeight: el.style.maxHeight, opacity: cs.opacity, transition: cs.transitionProperty } })()"
  let mid = null
  for (let attempt = 1; attempt <= 3 && !mid; attempt += 1) {
    await evaluate("(() => { window.localStorage.removeItem('vq_promos_dismissed'); return true })()")
    await open({ width: 1440, height: 1000 })
    await waitForCount('.vq-promos[data-placement="recharge"] .vq-promo', 2, '中间帧前的两条运营位')
    const before = await evaluate("(() => { const el = document.querySelector('.vq-promos[data-placement=\"recharge\"] .vq-promo'); return el ? el.offsetHeight : 0 })()")
    const t0 = Date.now()
    await evaluate("(() => { const el = document.querySelector('.vq-promos[data-placement=\"recharge\"] .vq-promo-close'); if (el) el.click(); return Boolean(el) })()")
    await sleep(attempt === 1 ? 0 : 40)
    // 截图本身要几十毫秒，落在图里的那一帧夹在「截图前」与「截图后」两次采样之间，
    // 所以两次都采：只要两次都是「还在 DOM / is-leaving / 高度在 0 与点前之间」，
    // 那张图就一定是收拢过程中的真渲染，不是靠事后采样替它说话。
    const pre = await evaluate(midProbe)
    await shoot(path.join('docs', 'r322-promo-dismiss-mid-1440.png'))
    const at = Date.now() - t0
    const state = await evaluate(midProbe)
    console.log('中间帧（第 ' + attempt + ' 次）：截图时点后约 ' + at + 'ms · 截图前 ' + JSON.stringify(pre) + ' · 截图后 ' + JSON.stringify(state) + ' · 点前高度 ' + before)
    if (pre.connected && pre.leaving && pre.height > 2 && pre.height < before && state.connected && state.leaving) mid = { before, at, pre, state }
  }
  if (!mid) throw new Error('三次都没截到正在收拢的中间帧')
  const pct = (h) => Math.round((h / mid.before) * 100) + '%'
  console.log('中间帧：点前 ' + mid.before + 'px → 截图前 ' + mid.pre.height + 'px（' + pct(mid.pre.height) + ' · opacity ' + mid.pre.opacity + '）→ 截图后 ' + mid.state.height + 'px（' + pct(mid.state.height) + ' · opacity ' + mid.state.opacity + '）· inline max-height ' + mid.state.inlineMaxHeight)
  // 这一版 CSS 已经给了目标值：is-leaving 把 max-height / opacity / transform 一起收到 0，
  // 中间帧里 opacity 应该已经小于 1（上一个版本这里恒为 1，只有塌陷在动）。
  console.log('中间帧 transition：' + mid.pre.transition)
  if (!String(mid.pre.transition).includes('max-height')) throw new Error('中间帧里没有 max-height 过渡：' + mid.pre.transition)
  if (!String(mid.pre.transition).includes('margin-bottom')) throw new Error('is-leaving 的过渡里没有 margin-bottom（间距没跟着卡片一起收）：' + mid.pre.transition)

  // 6b) 反证：把间距注回容器的 gap（就是改动前的写法），同一个探针必须量到「移除那一刻跳一下」。
  //     量不到跳变，说明上面那条「不跳」的断言是空转，拦不住任何东西。
  await open({ width: 1440, height: 1000 })
  await waitForCount('.vq-promos[data-placement="recharge"] .vq-promo', 2, '反证前的两条运营位')
  await evaluate("(() => { const s = document.createElement('style'); s.id = 'shot-repro-gap'; s.textContent = '.vq-promos{gap:var(--space-2) !important}'; document.head.appendChild(s); return true })()")
  const repro = await evaluate(`(async () => {
    const slot = document.querySelector('.vq-promos[data-placement="recharge"]')
    const art = slot && slot.querySelector('.vq-promo')
    const artB = slot && slot.querySelector('.vq-promo:nth-child(2)')
    if (!art || !artB) return { ok: false, reason: 'no-two-cards' }
    const before = art.offsetHeight
    const t0 = performance.now()
    art.querySelector('.vq-promo-close').click()
    let last = null
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      if (!art.isConnected) break
      last = { ms: Math.round(performance.now() - t0), h: art.offsetHeight, top: Math.round(artB.getBoundingClientRect().top * 100) / 100 }
    }
    const after = artB.isConnected ? Math.round(artB.getBoundingClientRect().top * 100) / 100 : null
    return { ok: true, before, last, after, jump: after === null || !last ? null : Math.round(Math.abs(after - last.top) * 100) / 100 }
  })()`)
  if (!repro.ok) throw new Error('反证没跑起来：' + repro.reason)
  if (!repro.last || !(repro.last.h <= 2)) throw new Error('反证里第一张没先收干净：' + JSON.stringify(repro.last))
  if (repro.after === null) throw new Error('反证里第二条不见了')
  console.log('反证（把 gap:var(--space-2) 注回容器）：第一张 ' + repro.before + 'px → ' + repro.last.h + 'px（' + repro.last.ms + 'ms 最后采样）· 第二张 top ' + repro.last.top + ' → ' + repro.after + '，移除那一刻跳 ' + repro.jump + 'px')
  if (!(repro.jump >= 6)) throw new Error('把 gap 注回去之后移除那一刻只跳了 ' + repro.jump + 'px（应 ≥6），新断言可能是空转')

  await stopScreencast()
  console.log('screencast 帧数：' + cdp.frames.length + '（关闭取证与中间帧期间一直在出帧）')

  // 7) 0 积分：跑完余额没动
  const creditsAfter = await fetch(BASE + '/api/credits', { headers }).then((r) => r.json())
  console.log('跑完余额：' + creditsAfter.balance)
  if (creditsAfter.balance !== creditsBefore.balance) throw new Error('积分变了：' + creditsBefore.balance + ' → ' + creditsAfter.balance)

  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
  if (cdp.errors.length) throw new Error('页面抛异常了，截图不算数：' + cdp.errors[0].split('\n')[0])
  const bad = serverLog.split('\n').filter((line) => line.includes('失败') && !line.includes('/api/bdc'))
  console.log('服务端失败行：' + (bad.length ? bad.slice(0, 3).join(' | ') : 'none'))
  console.log('四张图完成（真实例 / 真账号 / 真接口写入 / 真渲染 / 0 积分）')
} catch (error) {
  console.error('截图失败：' + String(error?.message || error))
  console.error(serverLog.slice(-1500))
  process.exitCode = 1
} finally {
  await stopScreencast()
  cdp?.close()
  chrome.kill()
  server.kill()
  await sleep(1200)
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* Chrome 偶尔还占着几个文件，留给系统 */
  }
  // 本进程自己还握着 auth.db（SQLite）的句柄，数据目录只能等它退出之后再删；
  // 直接在 finally 里删会静默失败，留一堆 vq-shot322-* 在临时目录里。
  const cleaner = spawn(process.execPath, ['-e', 'setTimeout(() => { try { require("fs").rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch (e) { console.warn("cleanup: " + e.message) } }, 2000)', dataDir], { detached: true, stdio: 'ignore' })
  cleaner.unref()
}
