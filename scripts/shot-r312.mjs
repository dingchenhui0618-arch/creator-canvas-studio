// 真实后端截图（r312）：资产引用接进「工作台 / 作品分镜 / 画布节点」之后长什么样。
//
// 与 r311 的 shot-real.mjs 同一套做法：临时实例 + 真账号 + 真会话 + 真渲染，
// 只是这一轮要拍的三处都需要「有资产、有作品、有工作流」，所以脚本自己把这三样建出来：
//   1) 预写一份带分镜的模板（模板库为空时作品页没东西可拍）；
//   2) 在数据目录里造一套「已出图」的产品资产（不是假接口，读的就是真实资产目录）；
//   3) 按接口建作品、挂参考资产、开工作流，再从画布上点中一个出图节点。
//
// 边界：**不点任何生成**（会花钱）。资产图是预先写进目录的占位 PNG，只为了让选择器有选项。
//
// 用法：node scripts/shot-r312.mjs

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

const API_PORT = await freePort(Number(process.env.SHOT_PORT || 8961))
const DEBUG_PORT = await freePort(API_PORT + 50)
const BASE = 'http://127.0.0.1:' + API_PORT

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot312-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot312-profile-'))
process.env.DATA_DIR = dataDir

// 邮箱拼出来：源码里直接写完整邮箱会被某些工具的脱敏层替换成占位符，脚本就跑不起来了
const AT = String.fromCharCode(64)
const ADMIN_EMAIL = 'shot312-admin' + AT + 'shot.test'
const USER_EMAIL = 'shot312-user' + AT + 'shot.test'
const PASSWORD = 'shot-pass-123'

// 1×1 PNG：资产预览与选择器只认文件存在与 mime，截图里不显示缩略图
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// 模板先落盘：模板库为空时 POST /api/projects 会 404，作品页也就没东西可拍
const TEMPLATE_ID = 'tpl_r312_demo'
const DEMO_TEMPLATE = {
  id: TEMPLATE_ID,
  title: '手冲咖啡 3 分钟：从磨豆到出杯',
  contentType: '美食教程',
  platform: 'douyin',
  platformLabel: '抖音',
  hook: '别再用错水温了：92 度是这条的关键',
  durationSec: 24,
  tags: ['咖啡', '手冲', '教程'],
  structure: [
    { beat: '开场', startSec: 0, endSec: 6, voiceover: '水温错了，再好的豆子也白搭。', expectedSec: 4.2 },
    { beat: '做法', startSec: 6, endSec: 16, voiceover: '先磨豆，中细研磨，粉水比一比十五。', expectedSec: 6.4 },
    { beat: '收尾', startSec: 16, endSec: 24, voiceover: '三分半出杯，趁热喝。', expectedSec: 5.1 },
  ],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 6, visual: '咖啡机特写，蒸汽升起', camera: '近景固定' },
    { shotNo: 2, startSec: 6, endSec: 12, visual: '咖啡倒进玻璃杯', camera: '中景跟手' },
    { shotNo: 3, startSec: 12, endSec: 18, visual: '手冲壶绕圈注水', camera: '俯拍特写' },
    { shotNo: 4, startSec: 18, endSec: 24, visual: '成品放在木桌上', camera: '固定机位' },
  ],
  analysis: { reusableRules: ['先给结果再讲过程', '每个动作配一个特写'], reusableHooks: ['别再用错水温了'] },
  createdAt: '2026-11-24T10:00:00.000Z',
}
fs.mkdirSync(dataDir, { recursive: true })

const { createSession, createUser } = await import('../server/auth.mjs')
const { config: cfg } = await import('../server/config.mjs')

// 先建管理员：ensureAnAdmin 会把「库里唯一那个账号」提成管理员，顺序反了普通账号会变成 admin
createUser({ email: ADMIN_EMAIL, password: PASSWORD, name: '运营管理员', kind: 'admin' })
const user = createUser({ email: USER_EMAIL, password: PASSWORD, name: '林可' })
const token = createSession(user, {}).token

// 模板必须在账号建好之后再落盘：要带 ownerId。不带的话启动时的归属迁移会把它认领给管理员，
// 普通账号打 POST /api/projects 只会拿到 404「模板不存在或不属于当前账号」。
fs.writeFileSync(
  path.join(dataDir, 'templates.json'),
  JSON.stringify([{ ...DEMO_TEMPLATE, ownerId: user.id }], null, 2),
)

// 造一套「已出图」的产品资产：写的就是真实资产目录（与 server/assets.mjs 同一形状）
const ASSET_ID = 'asst_' + Date.now().toString(36) + '_a1b2c3d4'
const assetDir = path.join(dataDir, 'assets', user.id, ASSET_ID)
fs.mkdirSync(assetDir, { recursive: true })
const now = new Date().toISOString()
const assetRefs = [
  { slot: 'hero', label: '白底主图' },
  { slot: 'scene', label: '场景图' },
  { slot: 'detail', label: '细节特写' },
].map((slot) => {
  const file = slot.slot + '.png'
  fs.writeFileSync(path.join(assetDir, file), TINY_PNG)
  return { slot: slot.slot, label: slot.label, file, mime: 'image/png', width: 1024, height: 1024, bytes: TINY_PNG.length, createdAt: now }
})
fs.writeFileSync(path.join(assetDir, 'meta.json'), JSON.stringify({
  version: 1,
  id: ASSET_ID,
  ownerId: user.id,
  kind: 'product',
  name: '美式咖啡机',
  category: '家电',
  status: 'partial',
  progress: { done: 3, total: 4 },
  sources: [],
  refs: assetRefs,
  error: '',
  free: true,
  createdAt: now,
  updatedAt: now,
}, null, 2))

const ASSET_REF = ASSET_ID + ':hero'
console.log('临时实例 · 数据目录 ' + dataDir + ' · 端口 ' + API_PORT + ' · 资产 ' + ASSET_REF)

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

async function api(pathname, { method = 'GET', body } = {}) {
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

/** 在一次截图里点中画布上的某个节点：React Flow 只认真实指针事件，所以走 CDP 派发。 */
async function clickNodeByText(text) {
  const point = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.react-flow__node')]
    const node = nodes.find((item) => item.textContent.includes(${JSON.stringify(text)}))
    if (!node) return null
    const rect = node.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 3) }
  })()`)
  if (!point) throw new Error('画布上没找到节点：' + text)
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
  await sleep(900)
}

async function shoot({ route, out, width, height, after }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Network.setCookie', {
    name: cfg.auth.cookieName,
    value: token,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
  })
  const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + user.id + "','1')}catch(e){}",
  })
  await cdp.send('Page.navigate', { url: BASE + '/?as=' + encodeURIComponent(user.id) + '#/' + route })
  await sleep(3000)
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier })
  if (after) await after()
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + width + '×' + height + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB · #' + route)
}

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, '实例健康')
  const me = await api('/api/auth/me')
  if (me.status !== 200) throw new Error('会话不被这个实例识别：' + me.status + ' ' + me.body.slice(0, 120))

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
  const identity = await api('/api/onboarding', { method: 'PUT', body: { identity: 'commerce', category: '家电', direction: '家电测评口播' } })
  if (identity.status !== 200) throw new Error('写身份失败：' + identity.status + ' ' + identity.body.slice(0, 160))
  const completed = await api('/api/onboarding/complete', { method: 'POST', body: { skipAssets: false } })
  if (completed.status !== 200) throw new Error('引导收尾失败：' + completed.status + ' ' + completed.body.slice(0, 160))

  // 作品 → 挂参考资产 → 开工作流（分镜出图节点会继承这条引用）
  const created = await api('/api/projects', { method: 'POST', body: { templateId: TEMPLATE_ID } })
  if (created.status !== 201) throw new Error('建作品失败：' + created.status + ' ' + created.body.slice(0, 200))
  const projectId = JSON.parse(created.body).project.id
  const patched = await api('/api/projects/' + projectId, { method: 'PATCH', body: { assetRef: ASSET_REF } })
  if (patched.status !== 200) throw new Error('挂参考资产失败：' + patched.status + ' ' + patched.body.slice(0, 200))
  const flow = await api('/api/projects/' + projectId + '/canvas', { method: 'POST' })
  // 第一次开工作流回 201（新建），已经有工作流时回 200（复用）：两种都算成
  if (flow.status !== 200 && flow.status !== 201) throw new Error('开工作流失败：' + flow.status + ' ' + flow.body.slice(0, 200))
  const flowId = JSON.parse(flow.body).flow.id
  console.log('作品 ' + projectId + ' · 工作流 ' + flowId + ' · 参考资产 ' + ASSET_REF)

  // 1) 工作台：常驻建资产提示（产品 1 套 · 数字人 0 套 → 还在）
  await shoot({ route: 'overview', out: path.join('docs', 'r312-overview-1440.png'), width: 1440, height: 900 })
  await shoot({
    route: 'overview',
    out: path.join('docs', 'r312-overview-390.png'),
    width: 390,
    height: 844,
    after: async () => {
      await evaluate("(() => { const el = document.querySelector('.vq-asset-nudge'); if (el) el.scrollIntoView({ block: 'center' }) })()")
      await sleep(500)
    },
  })

  // 2) 作品页：分景区里那一行「出图参考资产」
  await shoot({
    // 作品页的地址是 #/projects/<作品 id>（不是 #/project/…），拼错会落回工作台
    route: 'projects/' + projectId,
    out: path.join('docs', 'r312-project-1440.png'),
    width: 1440,
    height: 900,
    after: async () => {
      await evaluate("(() => { const el = document.querySelector('.vq-shot-asset'); if (el) el.scrollIntoView({ block: 'center' }) })()")
      await sleep(600)
    },
  })

  await shoot({
    route: 'projects/' + projectId,
    out: path.join('docs', 'r312-project-390.png'),
    width: 390,
    height: 844,
    after: async () => {
      await evaluate("(() => { const el = document.querySelector('.vq-shot-asset'); if (el) el.scrollIntoView({ block: 'center' }) })()")
      await sleep(500)
    },
  })

  // 3) 画布：点中「第 01 镜 · 出图」，检查器里的「参考资产」显示这一套
  await shoot({
    route: 'canvas/' + flowId,
    out: path.join('docs', 'r312-canvas-1440.png'),
    width: 1440,
    height: 900,
    after: async () => {
      await clickNodeByText('第 01 镜')
      // 检查器内容比一屏长：把「参考资产」这一行滚到可视区里再拍，否则拍到的是提示词框
      await evaluate("(() => { const el = document.querySelector('.cv-inspector .vq-assetref'); if (el) el.scrollIntoView({ block: 'center' }) })()")
      await sleep(500)
      const shown = await evaluate("(() => { const el = document.querySelector('.cv-inspector .vq-assetref-select'); return el ? el.value : '' })()")
      console.log('检查器里的参考资产：' + (shown || '（没读到）'))
      if (shown !== ASSET_REF) throw new Error('画布检查器没有显示继承来的参考资产：' + shown)
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
