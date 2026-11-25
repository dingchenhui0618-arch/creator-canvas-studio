// 真实后端截图（r313）：导航与账户区改版之后长什么样。
//
// 与 r311/r312 同一套做法：临时实例 + 真账号 + 真会话 + 真渲染，不点任何生成（不花钱）。
// 这一轮要拍的东西多，脚本自己把数据铺好：
//   1) 模板带一张真实帧图（作品墙只认站内素材，不拿外链或示例图顶上）；
//   2) 积分账本写几条真实流水（工作流出图扣费、退款、充值、管理员发放），拍「积分记录」；
//   3) 普通账号 + 管理员两个身份：普通账号看不到工作流，管理员侧栏有 Beta 标。
//
// 用法：node scripts/shot-r313.mjs

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const alive = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(600) })
      .then(() => true)
      .catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口')
}

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8971))
const DEBUG_PORT = await freePort(API_PORT + 50)
const BASE = 'http://127.0.0.1:' + API_PORT

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot313-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot313-profile-'))
process.env.DATA_DIR = dataDir

const AT = String.fromCharCode(64)
const ADMIN_EMAIL = 'shot313-admin' + AT + 'shot.test'
const USER_EMAIL = 'shot313-user' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

// 模板帧直接用「效果示例」里的真图（public/works）：我的作品那一格要能看出是真的画面，
// 不能是一块纯色（1×1 PNG 铺满会变成一张纯粉色的卡，看着像坏了）。
const FRAME_JPEG = fs.readFileSync(path.join('public', 'works', 'burger-film.jpg'))

const TEMPLATE_ID = 'tpl_r313_demo'
const DEMO_TEMPLATE = {
  id: TEMPLATE_ID,
  title: '手冲咖啡 3 分钟：从磨豆到出杯',
  contentType: '美食教程',
  platform: 'douyin',
  platformLabel: '抖音',
  hook: '别再用错水温了：92 度是这条的关键',
  durationSec: 24,
  tags: ['咖啡', '手冲', '教程'],
  cover: '/media/frames/' + TEMPLATE_ID + '/frame-01.jpg',
  frames: [{ index: 1, url: '/media/frames/' + TEMPLATE_ID + '/frame-01.jpg' }],
  structure: [
    { beat: '开场', startSec: 0, endSec: 6, voiceover: '水温错了，再好的豆子也白搭。', expectedSec: 4.2 },
    { beat: '做法', startSec: 6, endSec: 16, voiceover: '先磨豆，中细研磨，粉水比一比十五。', expectedSec: 6.4 },
    { beat: '收尾', startSec: 16, endSec: 24, voiceover: '三分半出杯，趁热喝。', expectedSec: 5.1 },
  ],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 6, visual: '咖啡机特写，蒸汽升起', camera: '近景固定' },
    { shotNo: 2, startSec: 6, endSec: 12, visual: '咖啡倒进玻璃杯', camera: '中景跟手' },
  ],
  analysis: { reusableRules: ['先给结果再讲过程', '每个动作配一个特写'], reusableHooks: ['别再用错水温了'] },
  createdAt: '2026-11-25T10:00:00.000Z',
}

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

// 先建管理员：ensureAnAdmin 会把「库里唯一那个账号」提成管理员，顺序反了普通账号会变成 admin
const admin = createUser({ email: ADMIN_EMAIL, password: PASSWORD, name: '运营管理员', kind: 'admin' })
const user = createUser({ email: USER_EMAIL, password: PASSWORD, name: '林可' })
const adminToken = createSession(admin, {}).token
const userToken = createSession(user, {}).token

// 模板要在建号之后落盘（带 ownerId），并真的写一张帧图到 framesDir
fs.writeFileSync(
  path.join(dataDir, 'templates.json'),
  JSON.stringify([{ ...DEMO_TEMPLATE, ownerId: user.id }], null, 2),
)
fs.mkdirSync(path.join(dataDir, 'frames', TEMPLATE_ID), { recursive: true })
fs.writeFileSync(path.join(dataDir, 'frames', TEMPLATE_ID, 'frame-01.jpg'), FRAME_JPEG)

// 积分账本：真实写进 credit_ledger（与产品同一条路径，不是界面假数据）
const credits = await import('../server/credits.mjs')
credits.charge(user.id, 'image_gen', { ref: 'run:run_demo01:image-1', amount: 3, meta: { label: '工作流出图 · 手冲咖啡杯 主图' } })
credits.charge(user.id, 'image_gen', { ref: 'run:run_demo01:image-2', amount: 3, meta: { label: '工作流出图 · 手冲咖啡杯 场景图' } })
credits.refund(user.id, 'video_gen', { ref: 'run:run_demo02:video-1', amount: 28, meta: { label: '工作流出视频失败退款' } })
credits.charge(user.id, 'chat', { amount: 1, meta: { label: '对话 · 品类选题建议' } })
credits.grant(user.id, 100, { kind: 'recharge', note: '充值 · 体验版 100 积分' })

// 管理员自己也记两笔：积分记录页读的是「当前登录账号」的账本，
// 要让截图证明「扣在哪个节点」，就得让管理员这个账号也有带 run 引用的流水。
credits.grant(admin.id, 200, { kind: 'recharge', note: '充值 · 团队额度' })
credits.charge(admin.id, 'image_gen', { ref: 'run:run_demo01:image-1', amount: 3, meta: { label: '工作流出图 · 手冲咖啡杯 主图' } })
credits.charge(admin.id, 'image_gen', { ref: 'run:run_demo01:image-2', amount: 3, meta: { label: '工作流出图 · 手冲咖啡杯 场景图' } })

// 运行记录：账本行只有 run:<runId>:<nodeId> 这个 ref，节点名与流程名要从 runs.json 里读。
// 这里落两条真实形状的运行（节点标题就是产品里那两种叫法），截图才能证明「扣在哪个节点」。
const started = new Date(Date.now() - 6 * 60 * 1000).toISOString()
const finished = new Date(Date.now() - 5 * 60 * 1000).toISOString()
fs.writeFileSync(
  path.join(dataDir, 'runs.json'),
  JSON.stringify([
    {
      id: 'run_demo01',
      flowId: 'flow_demo_shots',
      flowName: '手冲咖啡 · 逐镜出图',
      status: 'success',
      ownerInstance: 'shot',
      queuedAt: null,
      startedAt: started,
      finishedAt: finished,
      durationMs: 52000,
      total: 6,
      output: '',
      ownerId: user.id,
      nodes: [
        { id: 'image-1', kind: 'image', title: '主图', status: 'success' },
        { id: 'image-2', kind: 'image', title: '场景图', status: 'success' },
      ],
      credits: { cost: 6, refunded: false },
    },
    {
      id: 'run_demo02',
      flowId: 'flow_demo_shots',
      flowName: '手冲咖啡 · 逐镜出图',
      status: 'failed',
      ownerInstance: 'shot',
      queuedAt: null,
      startedAt: started,
      finishedAt: finished,
      durationMs: 18000,
      total: 0,
      output: '',
      ownerId: user.id,
      nodes: [{ id: 'video-1', kind: 'video', title: '首帧视频', status: 'failed' }],
      credits: { cost: 28, refunded: true },
    },
  ], null, 2),
)

console.log('临时实例 · 数据目录 ' + dataDir + ' · 端口 ' + API_PORT)

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
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
  'about:blank',
], { stdio: 'ignore' })

async function waitFor(check, label) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if (await check()) return
    } catch {
      // 还没起来
    }
    await sleep(300)
  }
  throw new Error('等待超时：' + label)
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
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
  close() {
    try { this.ws.close() } catch { /* 已经关了 */ }
  }
}

let cdp = null

async function api(pathname, { method = 'GET', body, token = userToken } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: cfg.auth.cookieName + '=' + token },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.text() }
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result?.result?.value
}

async function clickSelector(selector) {
  const point = await evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return null; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null; return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()')
  if (!point) throw new Error('没找到要点的元素：' + selector)
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
  await sleep(700)
}

async function shoot({ route, out, width, height, token = userToken, userId = user.id, after }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Network.setCookie', {
    name: cfg.auth.cookieName,
    value: token,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
  })
  const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      "try{localStorage.setItem('vq_welcome_seen:" + userId + "','1');localStorage.setItem('vq_mobile_note_seen','1');localStorage.removeItem('visionqa.session.v1');sessionStorage.removeItem('visionqa.session.v1')}catch(e){}",
  })
  // 每次换一个 query：同地址只换 hash 走的是 SPA 路由，上一张图里打开的菜单会留到下一张
  await cdp.send('Page.navigate', { url: BASE + '/?as=' + encodeURIComponent(userId) + '&shot=' + Date.now() + '#/' + route })
  await sleep(2800)
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier })
  // 页面自己弹的提示条（「还没有自己的资产…」）会盖住要拍的内容：截图前摘掉，别把临时提示拍成界面
  await evaluate("(() => { document.querySelectorAll('.vq-toast').forEach((el) => el.remove()) })()")
  if (after) await after()
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + width + '×' + height + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB · #' + route)
}

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const me = await api('/api/auth/me')
  if (me.status !== 200) throw new Error('会话不被这个实例识别：' + me.status + ' ' + me.body.slice(0, 120))
  const meBody = JSON.parse(me.body)
  console.log('普通账号 features.workflow = ' + String(meBody.features?.workflow))

  let target = null
  await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    target = (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
    return Boolean(target)
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')

  // 引导做完（内容随便填）：不然后面的页面会被引导弹窗盖住
  const identity = await api('/api/onboarding', { method: 'PUT', body: { identity: 'commerce', category: '食品饮料', direction: '咖啡器具测评' } })
  if (identity.status !== 200) throw new Error('写身份失败：' + identity.status + ' ' + identity.body.slice(0, 160))
  const completed = await api('/api/onboarding/complete', { method: 'POST', body: { skipAssets: false } })
  if (completed.status !== 200) throw new Error('引导收尾失败：' + completed.status + ' ' + completed.body.slice(0, 160))

  // 先建一条作品：作品墙与作品页都要有真实的一条（模板已落盘，能直接建）
  const created = await api('/api/projects', { method: 'POST', body: { templateId: TEMPLATE_ID } })
  if (created.status !== 201) throw new Error('建作品失败：' + created.status + ' ' + created.body.slice(0, 200))
  const projectId = JSON.parse(created.body).project.id
  console.log('作品 ' + projectId)

  // 1) 工作台：四项能力 + 效果示例 + 我的作品 + 下一步主卡（r314）
  //    断言实拍：5 张示例卡都渲染出来、图都真的加载完了（naturalWidth > 0），不是空框
  await shoot({
    route: 'overview',
    out: path.join('docs', 'r314-overview-1440.png'),
    width: 1440,
    height: 1080,
    after: async () => {
      const state = await evaluate("(() => { const cards = [...document.querySelectorAll('.ov-showcase-card')]; return { cards: cards.length, loaded: cards.filter((card) => { const img = card.querySelector('img'); return Boolean(img && img.complete && img.naturalWidth > 0) }).length } })()")
      if (!state || state.cards !== 5) throw new Error('效果示例不是 5 张：' + JSON.stringify(state))
      if (state.loaded !== 5) throw new Error('效果示例有图没加载出来：' + state.loaded + '/5')
    },
  })
  await shoot({ route: 'overview', out: path.join('docs', 'r314-overview-390.png'), width: 390, height: 1000 })
  await shoot({
    route: 'overview',
    out: path.join('docs', 'r314-showcase-1440.png'),
    width: 1440,
    height: 900,
    after: async () => {
      await evaluate("(() => { const el = document.querySelector('.ov-showcase'); if (el) el.scrollIntoView({ block: 'start' }) })()")
      await sleep(600)
    },
  })
  await shoot({
    route: 'overview',
    out: path.join('docs', 'r314-showcase-390.png'),
    width: 390,
    height: 860,
    after: async () => {
      await evaluate("(() => { const el = document.querySelector('.ov-showcase'); if (el) el.scrollIntoView({ block: 'start' }) })()")
      await sleep(600)
    },
  })

  // 2) 右上角账户菜单（余额 + 充值 + 帮助）
  await shoot({
    route: 'overview',
    out: path.join('docs', 'r313-account-menu-1440.png'),
    width: 1440,
    height: 760,
    after: async () => { await clickSelector('.vq-topbar-account-trigger') },
  })

  // 3) 积分记录：每一笔扣费扣在哪、充值进了多少
  await shoot({ route: 'runs', out: path.join('docs', 'r313-runs-1440.png'), width: 1440, height: 900 })
  await shoot({ route: 'runs', out: path.join('docs', 'r313-runs-390.png'), width: 390, height: 900 })

  // 4) 帮助与协议（公开页，从侧栏底部与右上角菜单都能到）
  await shoot({ route: 'help', out: path.join('docs', 'r313-help-1440.png'), width: 1440, height: 960 })

  // 5) 管理员视角的积分记录：节点名与流程名都在（普通账号那一版没有这些行）
  await shoot({
    route: 'runs',
    out: path.join('docs', 'r313-runs-admin-1440.png'),
    width: 1440,
    height: 900,
    token: adminToken,
    userId: admin.id,
    after: async () => {
      const text = String(await evaluate('document.body.innerText'))
      if (!text.includes('节点 ·') || !text.includes('流程 ·')) {
        console.log('ADMIN_RUNS_TEXT>>>' + text.replace(/\n+/g, ' | ').slice(0, 700))
        throw new Error('管理员积分记录里没有节点/流程：截图证明不了扣在哪个节点')
      }
    },
  })

  // 6) 设置页的头像区块
  await shoot({
    route: 'settings',
    out: path.join('docs', 'r313-settings-avatar-1440.png'),
    width: 1440,
    height: 900,
    after: async () => {
      await evaluate("(() => { const el = [...document.querySelectorAll('h2')].find((n) => n.textContent.trim() === '头像'); if (el) el.scrollIntoView({ block: 'start' }) })()")
      await sleep(500)
    },
  })

  // 6) 作品详情：普通账号没有工作流入口，下一步是「送评审」
  await shoot({ route: 'projects/' + projectId, out: path.join('docs', 'r313-project-1440.png'), width: 1440, height: 980 })
  await shoot({ route: 'projects/' + projectId, out: path.join('docs', 'r313-project-390.png'), width: 390, height: 900 })

  // 7) 非管理员直连 #/canvas：落 Beta 页，不挂画布
  await shoot({
    route: 'canvas',
    out: path.join('docs', 'r313-workflow-beta-1440.png'),
    width: 1440,
    height: 780,
    after: async () => {
      const text = await evaluate('document.body.innerText')
      if (!String(text).includes('工作流还在 Beta')) throw new Error('Beta 页没有渲染出来')
    },
  })

  // 7) 管理员侧栏：工作流带 Beta 标，工具区完整
  await shoot({
    route: 'overview',
    out: path.join('docs', 'r313-admin-sidebar-1440.png'),
    width: 1440,
    height: 900,
    token: adminToken,
    userId: admin.id,
    after: async () => {
      const chip = await evaluate("(() => { const el = document.querySelector('.vq-nav-chip'); return el ? el.textContent.trim() : '' })()")
      if (chip !== 'Beta') throw new Error('管理员侧栏没有 Beta 标签：' + chip)
    },
  })

  console.log('全部截图完成（真实后端 / 真实会话 / 未调上游）')
} catch (error) {
  console.error('截图失败：' + String(error?.message || error))
  console.error(serverLog.slice(-1500))
  process.exitCode = 1
} finally {
  if (cdp) cdp.close()
  chrome.kill()
  server.kill()
  await sleep(1500)
  for (const dir of [profile, dataDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
    } catch {
      console.warn('临时目录没删干净：' + dir)
    }
  }
}