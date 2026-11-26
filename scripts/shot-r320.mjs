// 真实渲染截图（r320）：运营位搬到服务端 + 动效铺到模板库 / 作品流。
//
// 与 r315–r319 同一套做法：临时实例 + 真账号 + 真 SQLite + 真渲染，0 次上游调用、0 积分。
// 这一轮不涉及模型，所以不起假 /v1——只证明「界面真的长这样、动效真的在跑」。
//
// 要证明的四件事：
//   1) 运营位的内容由服务端给（管理员改完保存，用户刷新就变），internal 那条普通账号看不到；
//   2) 关掉一条由下一条补位（位置上限两条），关掉的记录留在浏览器本地、刷新不回来；
//   3) 动效细则铺到模板库与作品流：逐条进场 + 悬停抬起，与工作台同一套；
//   4) 390 窄屏上这几屏都不横向溢出。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot320-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot320-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const ADMIN_EMAIL = 'shot320-admin' + AT + 'shot.test'
const USER_EMAIL = 'shot320-user' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

const admin = createUser({ email: ADMIN_EMAIL, password: PASSWORD, name: '运营', kind: 'admin' })
const adminToken = createSession(admin, {}).token
const user = createUser({ email: USER_EMAIL, password: PASSWORD, name: '林可' })
const token = createSession(user, {}).token

// 库里先放两条模板：一条解析过（能开作品）、一条只存了链接。
// 直接写文件，是因为这一轮要证明的是「前端渲染与服务端下发」，不是雷达解析链路。
// 归属必须显式写用户 id：库里没有管理员时服务端会把无主数据认领给首个账号（migrate-ownership），
// 那样普通账号就看不见这两条了。
const templates = [
  {
    id: 'tpl_r320demo1',
    title: '保温杯三条卖点 · 30 秒口播',
    kind: 'replica',
    platform: 'douyin',
    platformLabel: '抖音',
    contentType: '短视频',
    durationSec: 32,
    hook: '先给结论：这个杯子 60 度水能保温 12 小时',
    tags: ['r320', '保温杯'],
    cover: '',
    frames: [],
    ownerId: user.id,
    shared: false,
    createdAt: '2026-11-26T02:00:00.000Z',
    structure: [
      { beat: '钩子', text: '先给结论，别铺垫', seconds: 3 },
      { beat: '卖点', text: '一条一个卖点，配手上动作', seconds: 18 },
      { beat: '收口', text: '价格 + 行动', seconds: 9 },
    ],
    storyboard: [
      { index: 1, shot: '近景：拧盖出雾', seconds: 3 },
      { index: 2, shot: '中景：倒水到玻璃杯', seconds: 9 },
      { index: 3, shot: '特写：温度计读数', seconds: 9 },
    ],
    analysis: { reusableRules: ['前 3 秒必须给结论', '卖点一条一句'] },
  },
  {
    id: 'tpl_r320demo2',
    title: '只存了链接的那条（还没解析）',
    kind: 'saved',
    platform: 'xiaohongshu',
    platformLabel: '小红书',
    contentType: '图文',
    durationSec: 0,
    hook: '',
    tags: ['r320'],
    cover: '',
    frames: [],
    ownerId: user.id,
    shared: false,
    createdAt: '2026-11-26T01:00:00.000Z',
    structure: [],
    storyboard: [],
  },
]
fs.writeFileSync(path.join(dataDir, 'templates.json'), JSON.stringify(templates, null, 2))

// 运营位由管理员经真接口写进去——不是「前端文件里正好写着」。
const PROMOS = [
  { id: 'r320-internal', placement: 'overview', weight: 40, kicker: '内部', title: '内部口径那条（普通账号看不到）', body: '这条只在管理员登录时露出，用来证明 internal 真的生效。', cta: '去看', page: 'overview', internal: true },
  { id: 'r320-a', placement: 'overview', weight: 30, kicker: '新功能', title: '服务端运营位 A', body: '后台改完保存就生效，不用发版；关掉一条下一条补位。', cta: '去看看', page: 'rooms' },
  { id: 'r320-b', placement: 'overview', weight: 20, kicker: 'Beta', title: '服务端运营位 B', body: '排在第二条，权重比 A 低一档。', cta: '去看看', page: 'templates' },
  { id: 'r320-c', placement: 'overview', weight: 10, kicker: '备位', title: '服务端运营位 C', body: '关掉 A 之后，这一条会顶上来。', cta: '去看看', page: 'projects' },
  { id: 'r320-tpl', placement: 'templates', weight: 10, kicker: '模板库', title: '模板库顶上的那条运营位', body: '同一个组件换一个位置，内容由后台给。', cta: '去检索', page: 'radar' },
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
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params?.exceptionDetails?.text || 'exception')
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

/**
 * 等到某个选择器至少有 n 个：运营位是「请求回来才上屏」的，固定 sleep 会偶发量到空气
 * （r320 第一次跑就是读到 titles: [] 而缓存已经在本地了——不是没渲染，是量早了）。
 */
async function waitForCount(selector, n, label, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const count = await evaluate('document.querySelectorAll(' + JSON.stringify(selector) + ').length')
    if (Number(count) >= n) return Number(count)
    await sleep(300)
  }
  throw new Error('等不到 ' + n + ' 个 ' + label)
}

/** 等到运营位标题正好是这几条（关掉一条之后要等补位落下来）。 */
async function waitForTitles(expected, label, tries = 40) {
  let titles = []
  for (let i = 0; i < tries; i += 1) {
    titles = await evaluate("(() => [...document.querySelectorAll('.vq-promo-title')].map((el) => el.textContent))()")
    if (titles.join(' | ') === expected.join(' | ')) return titles
    await sleep(300)
  }
  throw new Error(label + '：等不到 ' + JSON.stringify(expected) + '，现在是 ' + JSON.stringify(titles))
}

async function open({ width, height, page = 'overview', as = token, who = user, edition = '' }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: as, domain: '127.0.0.1', path: '/', httpOnly: true })
  // 提示条用样式藏起来，绝不手工移除节点：那些节点 React 还在管，
  // 手工 remove 之后 React 下一次更新会抛 NotFoundError removeChild，整棵树会当场卸掉（r320 实测白屏）。
  const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + who.id + "','1');localStorage.setItem('vq_mobile_note_seen','1')}catch(e){}"
      + "try{document.addEventListener('DOMContentLoaded',function(){var s=document.createElement('style');s.textContent='.vq-toast{display:none !important}';document.head.appendChild(s)})}catch(e){}",
  })
  await cdp.send('Page.navigate', { url: BASE + '/?as=' + encodeURIComponent(who.id) + (edition ? '&edition=' + edition : '') + '&shot=' + Date.now() + '#/' + page })
  await sleep(2600)
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier })
}

async function shoot(out) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB')
}

/** 把鼠标真停到元素上，回算出来的 transform——抬起 2px 是算出来的，不是嘴说的。 */
async function hoverLift(selector) {
  const box = await evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()')
  if (!box) throw new Error('找不到要悬停的元素：' + selector)
  await sleep(400)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
  await sleep(500)
  return evaluate('(() => { const cs = getComputedStyle(document.querySelector(' + JSON.stringify(selector) + ')); return { transform: cs.transform, transition: cs.transitionProperty } })()')
}

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const headers = { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token }
  const adminHeaders = { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + adminToken }

  // 0) 运营位走后台真接口写进去
  const saved = await fetch(BASE + '/api/admin/promos', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ promos: PROMOS }) })
  if (!saved.ok) throw new Error('写运营位失败：' + saved.status + ' ' + (await saved.text()).slice(0, 200))
  const savedBody = await saved.json()
  console.log('后台写入：' + savedBody.promos.length + ' 条 · 来源 ' + savedBody.source)
  if (savedBody.promos.length !== PROMOS.length) throw new Error('后台存的条数不对：' + savedBody.promos.length)

  // 普通账号从 /api/promos 拿到的应该已经滤掉 internal 那条
  const publicView = await fetch(BASE + '/api/promos', { headers }).then((r) => r.json())
  const publicIds = publicView.promos.map((item) => item.id)
  console.log('普通账号拿到：' + JSON.stringify(publicIds))
  if (publicIds.length !== PROMOS.length - 1) throw new Error('internal 那条没被滤掉：' + JSON.stringify(publicIds))
  if (publicIds.includes('r320-internal')) throw new Error('普通账号拿到了 internal 那条')

  // 身份引导先收尾，否则工作台上会盖着引导
  const identity = await fetch(BASE + '/api/onboarding', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ identity: 'creator', category: '家居日用', direction: '保温杯短视频' }),
  })
  if (!identity.ok) throw new Error('写身份失败：' + identity.status)
  const finished = await fetch(BASE + '/api/onboarding/complete', {
    method: 'POST',
    headers,
    body: JSON.stringify({ skipAssets: true }),
  })
  if (!finished.ok) throw new Error('收尾引导失败：' + finished.status)

  // 两条作品：作品流要有卡才看得出「逐条进场」
  for (const title of ['保温杯三条卖点 · 复刻第一版', '保温杯三条卖点 · 换钩子']) {
    const created = await fetch(BASE + '/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ templateId: 'tpl_r320demo1', title }),
    })
    if (!created.ok) throw new Error('建作品失败：' + created.status + ' ' + (await created.text()).slice(0, 200))
  }

  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')

  // 1) 1440 工作台：两条运营位来自服务端（A、B），internal 那条不出现
  await open({ width: 1440, height: 1000 })
  await waitForCount('.vq-promo-title', 2, '工作台运营位')
  await evaluate("(() => { window.scrollTo(0, 0); return true })()")
  await sleep(500)
  const state = await evaluate("(() => ({ titles: [...document.querySelectorAll('.vq-promo-title')].map((el) => el.textContent), cache: window.localStorage.getItem('vq_promos_cache'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()")
  console.log('1440 工作台运营位：' + JSON.stringify(state))
  if (state.titles.length !== 2) throw new Error('工作台应该显示两条运营位，实际 ' + state.titles.length)
  if (state.titles[0] !== '服务端运营位 A' || state.titles[1] !== '服务端运营位 B') throw new Error('运营位不是服务端按权重给的那两条：' + JSON.stringify(state.titles))
  if (String(state.titles.join(' ')).includes('内部')) throw new Error('internal 那条露给了普通账号')
  if (!String(state.cache || '').includes('r320-a')) throw new Error('没有把服务端内容缓存到本地：' + String(state.cache).slice(0, 120))
  if (state.overflow > 1) throw new Error('1440 横向溢出：' + state.overflow)
  await shoot(path.join('docs', 'r320-workbench-served-1440.png'))

  // 2) 关掉第一条：下一条补位（仍是两条），关掉的记录进本地
  const closed = await evaluate("(() => { const btn = document.querySelector('.vq-promo-close'); const title = document.querySelector('.vq-promo-title'); if (!btn) return null; const text = title ? title.textContent : ''; btn.click(); return text })()")
  await waitForTitles(['服务端运营位 B', '服务端运营位 C'], '关掉一条后补位')
  const afterClose = await evaluate("(() => ({ titles: [...document.querySelectorAll('.vq-promo-title')].map((el) => el.textContent), stored: window.localStorage.getItem('vq_promos_dismissed') }))()")
  console.log('关掉「' + closed + '」后：' + JSON.stringify(afterClose))
  if (afterClose.titles.length !== 2) throw new Error('关掉一条后应该由下一条补位（仍是两条）：' + afterClose.titles.length)
  if (String(afterClose.titles.join(' ')).includes('服务端运营位 A')) throw new Error('关掉的那条 A 还在：' + JSON.stringify(afterClose.titles))
  if (!String(afterClose.titles.join(' ')).includes('服务端运营位 C')) throw new Error('没有补上第三条（C）：' + JSON.stringify(afterClose.titles))
  if (!String(afterClose.stored || '').includes('r320-a')) throw new Error('关掉的记录没写进本地：' + afterClose.stored)

  await open({ width: 1440, height: 1000 })
  const reloaded = await waitForTitles(['服务端运营位 B', '服务端运营位 C'], '刷新后仍然是 B / C')
  console.log('刷新后：' + JSON.stringify(reloaded))
  if (String(reloaded.join(' ')).includes('服务端运营位 A')) throw new Error('刷新后关掉的 A 又回来了')
  if (!String(reloaded.join(' ')).includes('服务端运营位 C')) throw new Error('刷新后补位的 C 也不见了')

  // 3) 模板库：位置换一个、同一个组件；网格与卡片走逐条进场 + 悬停抬起
  await open({ width: 1440, height: 1150, page: 'templates' })
  await waitForCount('.template-card', 2, '模板库卡片')
  await waitForTitles(['模板库顶上的那条运营位'], '模板库运营位')
  await sleep(500)
  const tpl = await evaluate("(() => { const grid = document.querySelector('.template-grid'); const card = document.querySelector('.template-card'); const cs = card ? getComputedStyle(card) : null; return { promo: [...document.querySelectorAll('.vq-promo-title')].map((el) => el.textContent), cards: document.querySelectorAll('.template-card').length, gridClass: grid ? grid.className : '', animation: cs ? cs.animationName : '', transition: cs ? cs.transitionProperty : '', overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth } })()")
  console.log('1440 模板库：' + JSON.stringify(tpl))
  if (tpl.promo.length !== 1 || tpl.promo[0] !== '模板库顶上的那条运营位') throw new Error('模板库顶上的运营位不对：' + JSON.stringify(tpl.promo))
  if (!String(tpl.gridClass).includes('vq-stagger')) throw new Error('模板网格没有逐条进场的类：' + tpl.gridClass)
  if (tpl.cards !== 2) throw new Error('模板卡片数不对：' + tpl.cards)
  if (tpl.animation !== 'vq-rise') throw new Error('模板卡片没有走逐条进场：' + tpl.animation)
  if (!String(tpl.transition).includes('transform')) throw new Error('模板卡片没有把 transform 放进过渡：' + tpl.transition)
  if (tpl.overflow > 1) throw new Error('模板库 1440 横向溢出：' + tpl.overflow)
  // 先按没滚动的样子拍（悬停那一步会把卡片滚到屏幕中间，拍出来就没有页头和运营位了）
  await evaluate("(() => { window.scrollTo(0, 0); return true })()")
  await sleep(500)
  await shoot(path.join('docs', 'r320-templates-promo-1440.png'))
  const tplHover = await hoverLift('.template-card')
  console.log('模板卡片悬停：' + JSON.stringify(tplHover))
  const tplLift = /matrix\(1, 0, 0, 1, 0, (-?\d+(\.\d+)?)\)/.exec(String(tplHover.transform))
  if (!tplLift || Number(tplLift[1]) >= -0.5) throw new Error('模板卡片悬停没抬起来：' + JSON.stringify(tplHover))

  // 4) 作品流：同一套动效
  // #/projects 默认落在「创作成果」那一栏，作品卡片在「作品项目」栏里——先真的点一下切过去
  await open({ width: 1440, height: 1000, page: 'projects' })
  const switched = await evaluate("(() => { const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '作品项目'); if (!btn) return false; btn.click(); return true })()")
  if (!switched) throw new Error('没找到「作品项目」这一栏的切换按钮')
  await waitForCount('.vq-project-card', 2, '作品卡片')
  await sleep(500)
  const projects = await evaluate("(() => { const grid = document.querySelector('.vq-projects-grid'); const card = document.querySelector('.vq-project-card'); const cs = card ? getComputedStyle(card) : null; return { cards: document.querySelectorAll('.vq-project-card').length, gridClass: grid ? grid.className : '', animation: cs ? cs.animationName : '', transition: cs ? cs.transitionProperty : '', overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth } })()")
  console.log('1440 作品流：' + JSON.stringify(projects))
  if (!String(projects.gridClass).includes('vq-stagger')) throw new Error('作品网格没有逐条进场的类：' + projects.gridClass)
  if (projects.cards < 2) throw new Error('作品卡片数不对：' + projects.cards)
  if (projects.animation !== 'vq-rise') throw new Error('作品卡片没有走逐条进场：' + projects.animation)
  if (!String(projects.transition).includes('transform')) throw new Error('作品卡片没有把 transform 放进过渡：' + projects.transition)
  if (projects.overflow > 1) throw new Error('作品流 1440 横向溢出：' + projects.overflow)
  const projHover = await hoverLift('.vq-project-card')
  console.log('作品卡片悬停：' + JSON.stringify(projHover))
  const projLift = /matrix\(1, 0, 0, 1, 0, (-?\d+(\.\d+)?)\)/.exec(String(projHover.transform))
  if (!projLift || Number(projLift[1]) >= -0.5) throw new Error('作品卡片悬停没抬起来：' + JSON.stringify(projHover))
  await shoot(path.join('docs', 'r320-projects-stagger-1440.png'))

  // 5) 390：按窄屏重新载入再量（缩下来的那一帧不算数）
  await open({ width: 390, height: 900, page: 'templates' })
  await waitForCount('.template-card', 2, '模板库卡片（390）')
  await waitForCount('.vq-promo-title', 1, '模板库运营位（390）')
  await sleep(500)
  await evaluate("(() => { window.scrollTo(0, 0); return true })()")
  await sleep(400)
  const narrow = await evaluate("(() => ({ promo: [...document.querySelectorAll('.vq-promo-title')].map((el) => el.textContent), body: (document.querySelector('.vq-promo-body') || {}).textContent, cta: (document.querySelector('.vq-promo-cta') || {}).textContent, cards: document.querySelectorAll('.template-card').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, gridOverflow: (() => { const g = document.querySelector('.template-grid'); return g ? g.scrollWidth - g.clientWidth : 0 })() }))()")
  console.log('390 模板库：' + JSON.stringify(narrow))
  if (narrow.overflow > 1) throw new Error('模板库 390 横向溢出：' + narrow.overflow)
  if (narrow.gridOverflow > 1) throw new Error('模板网格 390 横向溢出：' + narrow.gridOverflow)
  if (!narrow.body) throw new Error('390 上运营位正文没了')
  if (!narrow.cards) throw new Error('390 上模板卡片没了')
  await shoot(path.join('docs', 'r320-templates-promo-390.png'))

  // 6) 后台「系统 → 运营位」
  // 量横向溢出时排掉「自己就是横向滚动容器」的子孙（后台大表格按设计在容器里滚，不算页面溢出）
  function overflowProbe() {
    const vw = document.documentElement.clientWidth
    const scroller = (el) => { let p = el.parentElement; while (p && p !== document.body) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true; p = p.parentElement } return false }
    const out = []
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.right > vw + 1 || r.left < -1) { if (scroller(el)) continue; out.push({ cls: String(el.className || el.tagName).slice(0, 60), left: Math.round(r.left), right: Math.round(r.right) }) }
    }
    const page = document.querySelector('.admin-page') || document.body
    const boxes = [...page.querySelectorAll('.admin-card, .admin-tabs, .admin-head, .admin-page')]
    const measured = (el) => document.documentElement.scrollWidth - document.documentElement.clientWidth
    const hideTest = boxes.map((el) => {
      const shown = measured()
      el.style.display = 'none'
      const hidden = measured()
      el.style.display = ''
      const r = el.getBoundingClientRect()
      const label = (el.querySelector('.admin-label') || {}).textContent || ''
      const wideKids = [...el.querySelectorAll('*')].filter((k) => k.getBoundingClientRect().right > r.right + 1).slice(0, 6).map((k) => String(k.className || k.tagName).slice(0, 44) + '@' + Math.round(k.getBoundingClientRect().right))
      return { label, shown, hidden, right: Math.round(r.right), sw: el.scrollWidth - el.clientWidth, wideKids }
    }).filter((row) => row.hidden !== row.shown)
    return { before: measured(), hideTest }
  }
  // 6b) 管理员真的能在这里改（这一轮前端新写的卡）
  await open({ width: 1440, height: 1300, page: 'admin/system', as: adminToken, who: admin, edition: 'admin' })
  await waitForCount('.admin-promo-row', PROMOS.length, '后台运营位行')
  await evaluate("(() => { const list = document.querySelector('.admin-promo-list'); const card = list ? list.closest('.admin-card') : null; if (card) card.scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); return true })()")
  await sleep(600)
  const card = await evaluate("(() => ({ rows: document.querySelectorAll('.admin-promo-row').length, badge: [...document.querySelectorAll('.admin-block-head .vq-pill')].map((el) => el.textContent).join(' / '), ids: [...document.querySelectorAll('.admin-promo-row .admin-mono')].map((el) => el.textContent).filter(Boolean).slice(0, 5), preview: (document.querySelector('.admin-promo-preview .vq-promo-title') || {}).textContent, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()")
  console.log('1440 后台运营位卡：' + JSON.stringify(card))
  if (card.rows !== PROMOS.length) throw new Error('后台上显示的运营位条数不对：' + card.rows)
  if (!String(card.badge).includes('后台编辑')) throw new Error('后台没有标出「后台编辑」来源：' + card.badge)
  if (card.preview !== '内部口径那条（普通账号看不到）') throw new Error('实时预览没有按第 1 条渲染：' + card.preview)
  if (card.overflow > 1) throw new Error('后台 1440 横向溢出：' + card.overflow)
  await shoot(path.join('docs', 'r320-admin-promos-1440.png'))

  await open({ width: 390, height: 900, page: 'admin/system', as: adminToken, who: admin, edition: 'admin' })
  await waitForCount('.admin-promo-row', PROMOS.length, '后台运营位行（390）')
  await evaluate("(() => { const list = document.querySelector('.admin-promo-list'); const card = list ? list.closest('.admin-card') : null; if (card) card.scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); return true })()")
  await sleep(600)
  const narrowCard = await evaluate("(() => ({ rows: document.querySelectorAll('.admin-promo-row').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, rowOverflow: (() => { const row = document.querySelector('.admin-promo-row'); return row ? row.scrollWidth - row.clientWidth : 0 })() }))()")
  console.log('390 后台运营位卡：' + JSON.stringify(narrowCard))
  if (narrowCard.overflow > 1) {
    const wide = await evaluate('(' + overflowProbe.toString() + ')()')
    console.log('390 越界元素：' + JSON.stringify(wide))
    await shoot(path.join('docs', 'r320-admin-promos-390.png'))
    throw new Error('后台 390 横向溢出：' + narrowCard.overflow)
  }
  if (narrowCard.rowOverflow > 1) throw new Error('后台 390 单行溢出：' + narrowCard.rowOverflow)
  await shoot(path.join('docs', 'r320-admin-promos-390.png'))

  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
  if (cdp.errors.length) throw new Error('页面抛异常了，截图不算数：' + cdp.errors[0].split('\n')[0])
  const bad = serverLog.split('\n').filter((line) => line.includes('失败') && !line.includes('/api/bdc'))
  console.log('服务端失败行：' + (bad.length ? bad.slice(0, 3).join(' | ') : 'none'))
} finally {
  cdp?.close()
  chrome.kill()
  server.kill()
  await sleep(300)
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* Windows 上句柄收得慢，留给系统 */
  }
}
