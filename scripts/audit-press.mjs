// r331 巡检：「按下去有没有反应」——把页面上能点的东西逐个真按一遍，只记客观事实。
//
// 为什么做成巡检：r330 用真鼠标在 3 个元素上量出「按下去一点变化都没有」。这一轮把同一套探针
// 做成可复跑的一份脚本：同一批屏、同一批目标、同一套口径，before / after 各跑一次，比数字。
//
// 三条纪律（与 r329 / r330 同一套）：
//   1) 0 次上游调用：临时库不给模型 Key，VISION_BASE_URL 指到本机一个没人监听的端口。
//   2) 只走真输入：mouseMoved / mousePressed / mouseReleased 全是 CDP Input.dispatchMouseEvent。
//      按下之后**不在原地松开**——先挪到视口里的中性点再松，所以这一轮不会合成 click，
//      不给后台写请求、不跳页。后台写请求总数写在报告里。
//   3) 量不到就写「量不到」，绝不把「没量到」写成「无反馈」。
//   4) r332 起：判定仍按「按下两帧」那一拍（与 r331 的数字可比），但还按着再等 200ms 读一次终值
//      （pressedSettled / changedSettledVsHover）。过渡没走完的采样会被单列成 settledRescued，
//      不混进「真的没反应」——promo 卡上那几颗就是这么回事（r331 也记过一次）。
//   5) r333 起：除了元素自身的六个属性，还读它的 ::after（背景/阴影/位移/透明度，见 AFTER_PROPS）。
//      r326/r329 给「整卡可点」的按钮定的按下反馈就画在 ::after 上，量具以前看不见这一类，
//      把它们一律记成「无反馈」——那是量具的盲区，不是页面的问题。
//   6) r334 起：还读这一颗自己的 transition-property / -duration（元素与 ::after 各一份）。
//      「有反馈」只说按下会变，「变得走不走过渡」是另一件事：没声明过渡的就是啪一下到位（硬切）。
//      硬切清单写在产物 hardCuts 与汇总的「有反馈但还是硬切」一节里；判定只认 computed 声明，
//      不看两帧的读数等不等于终值（那是 settledRescued 的事，方向相反）。
//      名字匹配认全名也认简写：transition-property 记的是作者写的那个名字，写 `background` 时
//      Chrome 照样动画 background-color（见 SHORTHAND_COVERS）。
//   7) r335 起：hover 也按同一套判据量。按下之前本来就要把鼠标移到元素中心（② 那一拍就是 hover
//      基线），所以「划过有没有变化」（rest → hover）与「变化走不走过渡」两笔账落在同一趟里，
//      不用另开一趟鼠标移动。产物 hoverChangedVsRest + hoverHardCuts；与按下那一层的差别
//      只在「这一拍没有 :active」。桌面端鼠标划过是最常发生的一次状态变化，硬切同样看得出来。
//   8) r335 起：读写都带上**边框宽度**。没有可见边框（四边宽度全 0）时，computed 的 border-color
//      就是 currentColor —— color 一变它必然跟着变，元素写 border: 0 也一样。这条不是反馈，是一条
//      推导出来的值，以前被算成「变了、但没过渡 = 硬切」（0.9.306 上量出的 26 条里有 25 条是它）。
//      现在分开记：hoverDerived / derivedOnPress，不进 changed、不进硬切，只在汇总里报条数。
//   9) r336 起：加第四层——**键盘焦点**。加 --focus 就只跑这一层（不按鼠标、不跑运营位那几段），
//      用 CDP 真发 Tab（Input.dispatchKeyEvent），每按一次读 document.activeElement：
//      它自己 + 最多三层有 class 的祖先各读一份「看得见的焦点属性」，走完整条 Tab 链之后再回到
//      「没有焦点」的数一遍同一批选择器当 rest 基线，差出来就是「Tab 到这里看不看得出焦点在哪」。
//      与鼠标三层同一个口径：看得见的变化才叫反馈；变化了但不在 computed transition 表里就是硬切。
//      焦点这一层读的是**另一张属性表**（FOCUS_PROPS，多了 outline 四件套），不复用按下/划过那张：
//      输入框一拿到焦点 UA 就会画 outline，把它塞进 PROPS 会把 r331–r335 三层的读数改掉，不可比。
//      同样沿用 r335 的推导规则：outline-style 是 none / 宽度 0 时 computed outline-color 等于
//      currentColor，color 一变它必然跟着变，那不是焦点环。
//
//  10) r337 起：加第五层——**非按钮的可点表面**（行 / 卡片 / 链接），加 --links 只跑这一层。
//      按下那一层必须真按，而链接一按就跳页，所以链接、可点行、整卡这些从来没被量过。
//      这一层只划过、绝不按下（不合成 click、不发写请求）。表面 = computed cursor 是 pointer、可见、
//      面积 >= 8x8、不是 button/[role=button]、也不在按钮里；cursor 是继承属性，所以嵌套的只留最外层。
//      读元素自己 + 最多 12 个可见子孙：卡片划过时动的是里面的箭头/缩略图
//      （.vq-project-card:hover .go svg { transform }），只读元素自己会把这一类记成「划过没变化」。
//      属性表用 HOVER_PROPS = PROPS + 下划线两条；text-decoration-line 是离散属性，算反馈但不进硬切。
//      按钮那三层的读数一个字都不动（仍走 PROPS / AFTER_PROPS）。
//
// 用法（同一份脚本跑两份产物）：
//   node scripts/audit-press.mjs --dist .shots330/dist-after --out .shots331/press
//   node scripts/audit-press.mjs --dist .shots331/dist-after --out .shots331/press-after
//   node scripts/audit-press.mjs --only overview,admin-promos
//   node scripts/audit-press.mjs --only shell --shots all   # 每一颗按下都截图（before/after 对比图）
//   node scripts/audit-press.mjs --focus                   # 只跑键盘焦点那一层（Tab 走查）
//   node scripts/audit-press.mjs --links                   # 只跑非按钮表面那一层（划过，不按下）
//   node scripts/audit-press.mjs --only templates-drawer --links --shots all   # 划过那一拍也留一张局部图
//
// 产物：<out>/press.json + <out>/<page>-<n>-press.png（只给「按下无反馈候选」）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = process.cwd()
const CHROME = process.env.SHOT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

function argOf(name, fallback) {
  const at = process.argv.indexOf('--' + name)
  if (at > 0 && process.argv[at + 1] && process.argv[at + 1].charAt(0) !== '-') return process.argv[at + 1]
  return fallback
}
const ONLY = String(argOf('only', '')).split(',').map((item) => item.trim()).filter(Boolean)
const DIST_DIR = path.resolve(ROOT, String(argOf('dist', '.shots330/dist-after')))
const OUT_DIR = path.resolve(ROOT, String(argOf('out', '.shots331/press')))
// r332：--shots candidates（默认，只给「按下无反馈候选」截图）| all（每一颗按下都截一张，
// 用来做同一颗的 before/after 对比图）+ --shotsize N（方形窗口边长，默认 120）。
const SHOTS = String(argOf('shots', 'candidates'))
const SHOT_SIZE = Number(argOf('shotsize', '120')) || 120
// r336：--focus 只跑「键盘焦点」那一层。Tab 走查每个 pass 最多按这么多下（防跑飞）。
const FOCUS_MODE = process.argv.indexOf('--focus') > 0
const FOCUS_CAP = Number(argOf('focuscap', '40')) || 40
// r337：--links 只跑「划过非按钮的可点表面」那一层（行 / 卡片 / 链接）。只划过，绝不按下：
// 链接按下去会跳页，这一层里不许出现 click。
const LINK_MODE = process.argv.indexOf('--links') > 0
const HOVER_CAP = Number(argOf('hovercap', '20')) || 20
const WIDTH = 1440
const HEIGHT = 1000
if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) throw new Error('dist 里没有 index.html：' + DIST_DIR)
if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 SHOT_CHROME 指定）')
fs.mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const notes = []
function note(text, detail) {
  notes.push({ text: text, detail: detail === undefined ? null : detail })
  console.log('NOTE ' + text + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}
const anomalies = []
function anomaly(where, text, detail) {
  anomalies.push({ where: where, text: text, detail: detail === undefined ? null : detail })
  console.log('ANOMALY ' + where + ' :: ' + text + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

// ---- 真一条 PNG（不引依赖、不联网）：给模板封面与作品流卡片当缩略图 ----
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function makePng(width, height, shade) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x += 1) {
      const rgb = shade(x / width, y / height)
      const at = y * stride + 1 + x * 3
      raw[at] = rgb[0]
      raw[at + 1] = rgb[1]
      raw[at + 2] = rgb[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
const THUMB_SHADE = (x, y) => {
  const band = Math.max(0, 1 - Math.abs(x - y * 0.9 - 0.18) * 6)
  const base = 34 + Math.round(22 * y)
  const lift = Math.round(46 * band)
  return [base + lift, base + Math.round(lift * 0.7), base + Math.round(lift * 1.4)]
}
const thumbBuffer = makePng(640, 640, THUMB_SHADE)
const coverBuffer = makePng(960, 540, THUMB_SHADE)

function pngSize(buf) {
  if (buf.length < 24) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// ---- 端口：避开这台机器上其它常驻服务（与 r329 同一份名单；nav-shell 的实例靠探活避开）----
const RESERVED = new Set([8799, 8800, 3210, 6677, 5312, 5313, 3080, 10100, 10086])
async function freePort(start, end) {
  for (let port = start; port <= end; port += 1) {
    if (RESERVED.has(port)) continue
    const alive = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(400) }).then(() => true).catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口：' + start + '-' + end)
}
const API_PORT = await freePort(8860, 8878)
const DEBUG_PORT = await freePort(8900, 8918)
const BASE = 'http://127.0.0.1:' + API_PORT

// ---- 临时实例：真 SQLite、真账号、真 cookie，只有数据目录是新的（绝不碰真实数据）----
const dataDir = path.join(OUT_DIR, 'data')
const stageDir = path.join(OUT_DIR, 'stage')
const profile = path.join(OUT_DIR, 'profile')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir, { recursive: true })
fs.rmSync(profile, { recursive: true, force: true })
fs.mkdirSync(profile, { recursive: true })
process.env.DATA_DIR = dataDir

const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
// 舞台里的 package.json 用这份 dist 自己的版本号：dist 可能是旧构建，拿源码树现在的版本顶上，
// /api/version 与页面显示的版本号就对不上了。
const distPkgVersion = (function () {
  try {
    const entryName = (fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8').match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1]
    const source = fs.readFileSync(path.join(DIST_DIR, 'assets', entryName), 'utf8')
    const found = source.match(/0\.9\.\d{3}/)
    return found ? found[0] : pkgJson.version
  } catch {
    return pkgJson.version
  }
})()
fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify({ ...pkgJson, version: distPkgVersion }, null, 2), 'utf8')
try {
  fs.symlinkSync(DIST_DIR, path.join(stageDir, 'dist'), 'junction')
} catch (error) {
  console.log('NOTE junction 建不起来，退回复制：' + String(error && error.message))
  fs.cpSync(DIST_DIR, path.join(stageDir, 'dist'), { recursive: true })
}
const distHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8')
const distEntry = (distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1] || null

// ---- 建号 + 铺数据（都是真数据：后台运营位、智能体、模板、作品、作品流一条成品）----
const AT = String.fromCharCode(64)
const PASSWORD = 'r331-probe-pass1'
const { createSession, createUser } = await import('../server/auth.mjs')
const { savePromos } = await import('../server/promos.mjs')
const { createAgent } = await import('../server/agents.mjs')
const { createProject } = await import('../server/projects.mjs')
const { markComplete } = await import('../server/onboarding.mjs')
const { config: cfg } = await import('../server/config.mjs')

const admin = createUser({ email: 'r331-admin' + AT + 'shot.test', password: PASSWORD, name: '运维', kind: 'admin' })
const account = createUser({ email: 'r331press' + AT + 'shot.test', password: PASSWORD, name: '巡检员', kind: 'account' })
const token = createSession(account, {}).token
const adminToken = createSession(admin, {}).token
// 两个账号都标成已完成：新手引导（.vq-gate / .vq-guide）是一层全屏遮罩，真鼠标按下去落在遮罩上，
// 量出来的就不是按钮本身。这一步不写进界面逻辑、不改任何界面代码，只是让巡检从「已经看过引导」的状态开始；
// 代价是引导弹窗里的那几颗按钮这一轮不在清单里（它们不是这次要查的对象）。
markComplete(admin.id, { skipAssets: true })
markComplete(account.id, { skipAssets: true })

const seeded = { promos: '', agent: '', project: '', template: '', media: '', account: account.id, admin: admin.id }

const promoSeed = await savePromos([
  {
    id: 'r331-rooms',
    placement: 'overview',
    weight: 30,
    kicker: 'Beta · 聊天室',
    title: '把几个智能体放进同一个房间',
    body: '房间里你说一句，平台智能体接一句：起草、拆结构、找选题。每轮 1 积分，答不上来全额退回。',
    cta: '去聊天室',
    page: 'rooms',
  },
  {
    id: 'r331-review',
    placement: 'overview',
    weight: 20,
    kicker: '视觉评审',
    title: '按帧给结论，每条带证据',
    body: '抽帧逐条标出问题与像素锚点，评审结论可以回写到作品，作为封版依据。',
    cta: '去视觉评审',
    page: 'review',
  },
], { by: 'r331-seed' })
seeded.promos = promoSeed.ok ? promoSeed.items.length + ' 条' : '失败：' + promoSeed.error

const agent = await createAgent({
  name: 'r331 口播拆解',
  category: '脚本分镜',
  role: '把一条口播拆成脚本与分镜',
  systemPrompt: '你负责把口播拆成分镜表：先给结果，再给步骤。看不清的地方标出来，不要编。',
}, account)
seeded.agent = agent.name

const templateEntry = {
  id: 'tpl_r331_probe',
  kind: 'replica',
  title: '一分钟出片的那条',
  contentType: '口播',
  tags: ['巡检'],
  platform: 'douyin',
  platformLabel: '抖音',
  sourceUrl: 'https://www.douyin.com/video/3310331',
  sourceId: 'dy_3310331',
  author: '原片作者',
  publishedAt: '2026-11-01',
  stats: { plays: 128000, likes: 9600, comments: 320, shares: 180, collects: 2400 },
  durationSec: 18,
  hook: '一分钟出一杯',
  hookType: '结果前置',
  structure: [
    { startSec: 0, endSec: 4, beat: '结果', voiceover: '一分钟，真的只要一分钟', onScreen: '出杯', purpose: '给结果' },
    { startSec: 4, endSec: 11, beat: '步骤', voiceover: '三件事：粉、水、时间', onScreen: '三步字卡', purpose: '拆步骤' },
    { startSec: 11, endSec: 18, beat: '收尾', voiceover: '照着做就行', onScreen: '成品', purpose: '收口' },
  ],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 4, frameIndex: 0, visual: '咖啡机出杯特写', camera: '近景', caption: '一分钟', audio: '环境音', purpose: '给结果' },
    { shotNo: 2, startSec: 4, endSec: 8, frameIndex: 1, visual: '手倒粉', camera: '俯拍', caption: '一勺', audio: '摩擦声', purpose: '拆步骤' },
    { shotNo: 3, startSec: 8, endSec: 18, frameIndex: 2, visual: '成品摆桌', camera: '中景', caption: '照做就行', audio: '轻音乐', purpose: '收口' },
  ],
  timing: { estimatedSec: 17, actualSec: 18, durationSec: 18, fit: 'tight', overSec: 0, tight: 1, loose: 0 },
  analysis: { pacing: '快', viralPoints: ['出杯瞬间'], reusableRules: ['先给结果'], targetAudience: '打工人' },
  frames: [],
  cover: 'data:image/png;base64,' + coverBuffer.toString('base64'),
  video: { width: 1080, height: 1920, fps: 30, duration: 18 },
  origin: 'manual',
  reuseCount: 0,
  ownerId: account.id,
  createdAt: new Date().toISOString(),
  savedAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(dataDir, 'templates.json'), JSON.stringify([templateEntry], null, 2), 'utf8')
seeded.template = templateEntry.title

const project = await createProject({ title: '一分钟出片的那条', templateId: templateEntry.id }, account)
seeded.project = project.title

const taskId = 'mgen_r331seed01'
const safeUser = String(account.id).replace(/[^A-Za-z0-9_-]/g, '_') || 'anonymous'
fs.mkdirSync(path.join(dataDir, 'media', 'tasks'), { recursive: true })
fs.mkdirSync(path.join(dataDir, 'media', safeUser), { recursive: true })
fs.writeFileSync(path.join(dataDir, 'media', safeUser, taskId + '.png'), thumbBuffer)
const nowIso = new Date().toISOString()
fs.writeFileSync(path.join(dataDir, 'media', 'tasks', taskId + '.json'), JSON.stringify({
  version: 1,
  id: taskId,
  userId: account.id,
  kind: 'image',
  status: 'succeeded',
  prompt: '一杯手冲咖啡的出杯瞬间',
  model: 'gpt-image-2',
  modelLabel: 'GPT Image 2',
  mode: 'text2image',
  ratio: '1:1',
  size: '1024x1024',
  progress: 100,
  createdAt: nowIso,
  updatedAt: nowIso,
  finishedAt: nowIso,
  error: '',
  file: { ext: 'png', mime: 'image/png', bytes: thumbBuffer.length },
  credits: { cost: 0, balance: 0 },
}, null, 2), 'utf8')
seeded.media = taskId

console.log('r331 巡检 · dist=' + DIST_DIR + ' · 入口 ' + distEntry + ' · v' + distPkgVersion + ' · 端口 ' + API_PORT + ' · 数据目录 ' + dataDir)

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
    VISION_API_KEY: 'r331-not-a-real-key',
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
  '--window-size=' + WIDTH + ',' + HEIGHT,
  'about:blank',
], { stdio: 'ignore' })

async function waitFor(fn, label, tries = 140) {
  for (let i = 0; i < tries; i += 1) {
    try { const value = await fn(); if (value) return value } catch { /* 还没起来 */ }
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
    this.requests = []
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params && message.params.exceptionDetails
        this.exceptions.push(String((details && ((details.exception && details.exception.description) || details.text)) || 'exception').slice(0, 300))
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params && message.params.type === 'error') {
        this.consoleErrors.push((message.params.args || []).map((arg) => String((arg && arg.value) || (arg && arg.description) || '')).join(' ').slice(0, 300))
      }
      if (message.method === 'Network.requestWillBeSent' && message.params && message.params.request) {
        this.requests.push({ method: String(message.params.request.method || ''), url: String(message.params.request.url || ''), type: String(message.params.type || '') })
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
    throw new Error('Runtime.evaluate 失败：' + String((error && error.message) || error) + ' :: ' + String(expression).slice(0, 160))
  }
  if (result && result.exceptionDetails) throw new Error('页面里求值失败：' + JSON.stringify(result.exceptionDetails).slice(0, 240) + ' :: ' + String(expression).slice(0, 160))
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

async function mouseTo(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none' })
}
async function mouseDown(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1 })
}
async function mouseUp(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', buttons: 0, clickCount: 1 })
}
async function clickAt(x, y, gap = 60) {
  await mouseTo(x, y)
  await sleep(40)
  await mouseDown(x, y)
  await sleep(gap)
  await mouseUp(x, y)
  await sleep(gap)
}

// ---- 页面里跑的自足函数（普通函数 + toString 注入；不引外部依赖）----

function bringIntoView(selector) {
  // 视口只有 1000 高，长页面上大部分按钮在屏外；鼠标事件落在屏外坐标上等于没点。
  // 这里只做「滚到眼前」——滚的是真滚动容器，不伪造点击。
  const el = document.querySelector(selector)
  if (!el) return { missing: true }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  return {
    cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
    l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
    scroller: (function () { let n = el.parentElement; while (n) { const s = getComputedStyle(n); if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return (String(n.className || n.tagName).split(' ')[0]) || 'div'; n = n.parentElement } return 'window' })(),
  }
}

function readState(selector) {
  // 只读：computed style + :active / :hover + 落点。不点、不写。
  const el = document.querySelector(selector)
  if (!el) return { missing: true }
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + r.height / 2)
  const hit = document.elementFromPoint(x, y)
  return {
    missing: false,
    tag: el.tagName,
    text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
    active: el.matches(':active'),
    hover: el.matches(':hover'),
    focus: el === document.activeElement,
    disabled: Boolean(el.disabled),
    ariaDisabled: el.getAttribute('aria-disabled'),
    backgroundColor: cs.backgroundColor,
    borderColor: cs.borderColor,
    color: cs.color,
    boxShadow: cs.boxShadow,
    transform: cs.transform,
    opacity: cs.opacity,
    // r335：边框宽度也要读。没有可见边框时，computed 的 border-color 就是 currentColor——
    // color 一变它就跟着变（元素写 border: 0 也一样）。那不是一次反馈，是一条推导出来的值。
    borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
    // r334：这一次变化「走不走过渡」也要量。computed 的 transition-property / -duration 是权威答案——
    // 声明了过渡的按钮，按下去是「顺滑加深」；没声明的就是啪一下到位（硬切）。
    transitionProperty: cs.transitionProperty,
    transitionDuration: cs.transitionDuration,
    cursor: cs.cursor,
    rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    hitIsSelf: Boolean(hit && (hit === el || el.contains(hit))),
    hit: hit ? { tag: hit.tagName, cls: String(hit.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.'), cursor: getComputedStyle(hit).cursor } : null,
    // 伪元素也要读（r333）：r326/r329 起，「整卡可点」的按钮把按下反馈画在自己的 ::after 上
    // （给它加 transform 会毁掉 ::after 的包含块）——只看元素自身，这一类永远量成「无反馈」。
    after: (function () {
      const ps = getComputedStyle(el, '::after')
      return {
        content: ps.content,
        backgroundColor: ps.backgroundColor,
        boxShadow: ps.boxShadow,
        transform: ps.transform,
        opacity: ps.opacity,
        transitionProperty: ps.transitionProperty,
        transitionDuration: ps.transitionDuration,
      }
    })(),
  }
}

// ---- r336：键盘焦点那一层（自足页面函数，注入到页面里跑）----
function focusActive() {
  // 只读：现在谁拿着焦点 + 它的稳定选择器。不点、不写、不滚。
  function escapeIdent(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value)
    return String(value).replace(/[^A-Za-z0-9_-]/g, function (ch) { return '\\' + ch })
  }
  function stableClasses(node) {
    return Array.prototype.slice.call(node.classList).filter(function (c) { return c.indexOf('is-') !== 0 && c.length < 40 }).slice(0, 2)
  }
  function selectorOf(el) {
    const cls = stableClasses(el)
    const simple = el.tagName.toLowerCase() + (cls.length ? '.' + cls.map(escapeIdent).join('.') : '')
    try { if (document.querySelectorAll(simple).length === 1) return simple } catch { /* 选择器不合法就往下走 */ }
    const all = Array.prototype.slice.call(el.classList)
    if (all.length) {
      const full = el.tagName.toLowerCase() + '.' + all.map(escapeIdent).join('.')
      try { if (document.querySelectorAll(full).length === 1) return full } catch { /* 同上 */ }
    }
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      let part = node.tagName.toLowerCase()
      const c = stableClasses(node)
      if (c.length) part += '.' + c.map(escapeIdent).join('.')
      const parent = node.parentElement
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === node.tagName })
        part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      const sel = parts.join(' > ')
      try { if (document.querySelectorAll(sel).length === 1) return sel } catch { /* 同上 */ }
      node = parent
    }
    return parts.join(' > ')
  }
  const el = document.activeElement
  if (!el || el === document.body || el === document.documentElement) return { body: true }
  return {
    body: false,
    selector: selectorOf(el),
    tag: el.tagName,
    text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    cls: String(el.getAttribute('class') || ''),
    type: el.getAttribute('type'),
    focusVisible: el.matches(':focus-visible'),
    focusWithin: el.matches(':focus-within'),
  }
}
function readFocusState(selector) {
  // 只读：焦点相关的可见属性。元素自己 + 最多三层带 class 的祖先各一份（祖先按位置对齐，只记 tag/class）。
  function grab(node) {
    const cs = getComputedStyle(node)
    const ps = getComputedStyle(node, '::after')
    return {
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      outlineOffset: cs.outlineOffset,
      boxShadow: cs.boxShadow,
      borderColor: cs.borderColor,
      borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
      backgroundColor: cs.backgroundColor,
      color: cs.color,
      transform: cs.transform,
      opacity: cs.opacity,
      focus: node === document.activeElement,
      focusVisible: node.matches(':focus-visible'),
      hover: node.matches(':hover'),
      transitionProperty: cs.transitionProperty,
      transitionDuration: cs.transitionDuration,
      after: {
        content: ps.content,
        backgroundColor: ps.backgroundColor,
        boxShadow: ps.boxShadow,
        transform: ps.transform,
        opacity: ps.opacity,
        transitionProperty: ps.transitionProperty,
        transitionDuration: ps.transitionDuration,
      },
    }
  }
  const el = document.querySelector(selector)
  if (!el) return { missing: true }
  const chain = []
  chain.push(Object.assign({ selector: 'self', tag: el.tagName, cls: String(el.getAttribute('class') || '') }, grab(el)))
  let node = el.parentElement
  let depth = 0
  while (node && node !== document.body && depth < 3) {
    if (node.classList && node.classList.length) {
      chain.push(Object.assign({ selector: 'up' + depth, tag: node.tagName, cls: String(node.getAttribute('class') || '') }, grab(node)))
      depth += 1
    }
    node = node.parentElement
  }
  return { missing: false, tag: el.tagName, chain: chain }
}

function neutralPoint() {
  // 「松手的地方」：视口角落、非交互区域。按下之后不在原元素上松开，
  // 这样浏览器不会合成 click（click 只在按下与抬起的共同祖先上触发）。
  const w = window.innerWidth
  const h = window.innerHeight
  const candidates = [
    [4, 4], [w - 6, 4], [4, h - 6], [w - 6, h - 6],
    [Math.round(w / 2), h - 6], [Math.round(w / 2), 4], [4, Math.round(h / 2)],
  ]
  for (const point of candidates) {
    const el = document.elementFromPoint(point[0], point[1])
    if (!el) continue
    if (el.closest && el.closest('button, [role="button"], .vq-card-open, a[href], input, select, textarea, nav, aside, .vq-sidebar, header')) continue
    if (getComputedStyle(el).cursor === 'pointer') continue
    return { x: point[0], y: point[1], tag: el.tagName, cls: String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') }
  }
  return null
}

function collectTargets(scopeSel, limit) {
  // 页面上**所有可见的** button / [role=button] / .vq-card-open，按 DOM 顺序，截到 limit。
  function escapeIdent(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value)
    return String(value).replace(/[^A-Za-z0-9_-]/g, function (ch) { return '\\' + ch })
  }
  function stableClasses(node) {
    return Array.prototype.slice.call(node.classList).filter(function (c) { return c.indexOf('is-') !== 0 && c.length < 40 }).slice(0, 2)
  }
  function selectorFor(el) {
    const cls = stableClasses(el)
    const simple = el.tagName.toLowerCase() + (cls.length ? '.' + cls.map(escapeIdent).join('.') : '')
    try { if (document.querySelectorAll(simple).length === 1) return simple } catch { /* 选择器不合法就往下走 */ }
    const all = Array.prototype.slice.call(el.classList)
    if (all.length) {
      const full = el.tagName.toLowerCase() + '.' + all.map(escapeIdent).join('.')
      try { if (document.querySelectorAll(full).length === 1) return full } catch { /* 同上 */ }
    }
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      let part = node.tagName.toLowerCase()
      const c = stableClasses(node)
      if (c.length) part += '.' + c.map(escapeIdent).join('.')
      const parent = node.parentElement
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === node.tagName })
        part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      const sel = parts.join(' > ')
      try { if (document.querySelectorAll(sel).length === 1) return sel } catch { /* 同上 */ }
      node = parent
    }
    return parts.join(' > ')
  }
  function headHtml(el) {
    const clone = el.cloneNode(false)
    clone.innerHTML = ''
    return String(clone.outerHTML || '').replace(/\s+/g, ' ').slice(0, 120)
  }
  const roots = scopeSel ? Array.prototype.slice.call(document.querySelectorAll(scopeSel)) : [document]
  if (!roots.length) return { missingScope: true, total: 0, items: [] }
  const nodes = []
  const seen = new Set()
  for (const root of roots) {
    const found = root.querySelectorAll('button, [role="button"], .vq-card-open')
    for (const el of found) {
      if (seen.has(el)) continue
      seen.add(el)
      nodes.push(el)
    }
  }
  const visible = []
  for (const el of nodes) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (r.width < 2 || r.height < 2) continue
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
    visible.push(el)
  }
  const items = visible.slice(0, limit).map(function (el, index) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const selector = selectorFor(el)
    let resolved = -1
    try { resolved = document.querySelectorAll(selector).length } catch { resolved = -1 }
    return {
      n: index + 1,
      selector: selector,
      selectorMatches: resolved,
      tag: el.tagName,
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      html: headHtml(el),
      cls: String(el.getAttribute('class') || ''),
      disabled: Boolean(el.disabled),
      ariaDisabled: el.getAttribute('aria-disabled'),
      cursor: cs.cursor,
      type: el.getAttribute('type'),
      rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    }
  })
  return { missingScope: false, total: visible.length, items: items }
}

// ---- r337：「划过」这一层从按钮扩到**非按钮的可点表面**（行 / 卡片 / 链接）----
// 为什么单开一层：按下那一层必须真按，链接一按就跳页，所以链接、可点行、整卡这些从来没被量过。
// 这一层只划过、绝不按下（不合成 click、不发写请求），与前面三层同一个口径：
// 看得见的变化才叫反馈；变了但不在 computed transition 表里就是硬切。
// 两个新东西：
//   1) 反馈可能画在**子孙**身上（.vq-project-card:hover .go svg { transform }）——只读元素自己会把它
//      记成「划过没变化」。所以读元素自己 + 最多 12 个可见子孙，按位置对齐逐个比，挪位了就当读不到。
//   2) 下划线是链接最经典的反馈，而 text-decoration-line 是离散属性：算反馈，不进硬切（见 DISCRETE_HOVER_PROPS）。
// 页面函数必须自足（.toString() 注进页面里跑），所以选择器那三个小工具在这里再写一遍——与 collectTargets 同一份实现。
function readHoverState(selector) {
  const el = document.querySelector(selector)
  if (!el) return { missing: true }
  function snapshot(node) {
    const cs = getComputedStyle(node)
    const ps = getComputedStyle(node, '::after')
    return {
      tag: node.tagName,
      cls: String(node.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.'),
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      color: cs.color,
      boxShadow: cs.boxShadow,
      transform: cs.transform,
      opacity: cs.opacity,
      textDecorationLine: cs.textDecorationLine,
      textDecorationColor: cs.textDecorationColor,
      textUnderlineOffset: cs.textUnderlineOffset,
      borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
      transitionProperty: cs.transitionProperty,
      transitionDuration: cs.transitionDuration,
      cursor: cs.cursor,
      after: {
        content: ps.content,
        backgroundColor: ps.backgroundColor,
        boxShadow: ps.boxShadow,
        transform: ps.transform,
        opacity: ps.opacity,
        transitionProperty: ps.transitionProperty,
        transitionDuration: ps.transitionDuration,
      },
    }
  }
  const snapshots = [Object.assign({ where: 'self' }, snapshot(el))]
  const inner = el.querySelectorAll('*')
  let truncated = 0
  for (let i = 0; i < inner.length; i += 1) {
    if (snapshots.length >= 13) { truncated = inner.length - i; break }
    const node = inner[i]
    const r = node.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const cs = getComputedStyle(node)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    snapshots.push(Object.assign({ where: 'd' + i }, snapshot(node)))
  }
  const box = el.getBoundingClientRect()
  const x = Math.round(box.left + box.width / 2)
  const y = Math.round(box.top + box.height / 2)
  const hit = document.elementFromPoint(x, y)
  return {
    missing: false,
    snapshots: snapshots,
    truncated: truncated,
    hitInside: Boolean(hit && (hit === el || el.contains(hit))),
    hit: hit ? { tag: hit.tagName, cls: String(hit.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') } : null,
    rect: { l: Math.round(box.left), t: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
  }
}

function collectHoverSurfaces(scopeSel, limit) {
  // 「非按钮的可点表面」：computed cursor 是 pointer、可见、面积够看，且不是 button / [role=button]、
  // 也不在某个按钮里面。cursor 是继承属性，卡片里每个后代都跟着是 pointer——所以嵌套的只留最外层：
  // 划过一张卡片时，手感落在卡片这张「面」上（.vq-project-card 里那颗箭头不是另一张面）。
  function escapeIdent(value) { return window.CSS.escape(String(value)) }
  function stableClasses(node) {
    return Array.prototype.slice.call(node.classList).filter(function (c) { return c.indexOf('is-') !== 0 && c.length < 40 }).slice(0, 2)
  }
  function selectorFor(el) {
    const cls = stableClasses(el)
    const simple = el.tagName.toLowerCase() + (cls.length ? '.' + cls.map(escapeIdent).join('.') : '')
    try { if (document.querySelectorAll(simple).length === 1) return simple } catch { /* 选择器不合法就往下走 */ }
    const all = Array.prototype.slice.call(el.classList)
    if (all.length) {
      const full = el.tagName.toLowerCase() + '.' + all.map(escapeIdent).join('.')
      try { if (document.querySelectorAll(full).length === 1) return full } catch { /* 同上 */ }
    }
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      let part = node.tagName.toLowerCase()
      const c = stableClasses(node)
      if (c.length) part += '.' + c.map(escapeIdent).join('.')
      const parent = node.parentElement
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === node.tagName })
        part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      const sel = parts.join(' > ')
      try { if (document.querySelectorAll(sel).length === 1) return sel } catch { /* 同上 */ }
      node = parent
    }
    return parts.join(' > ')
  }
  const roots = scopeSel ? Array.prototype.slice.call(document.querySelectorAll(scopeSel)) : [document]
  if (!roots.length) return { missingScope: true, total: 0, items: [] }
  const nodes = []
  const seen = new Set()
  for (const root of roots) {
    // 两类都算「非按钮的可点表面」：
    //   ① 语义上就是可点的（链接 / 页签 / 选项 / 菜单项 / 开关 / 详情展开 / label）——不看 cursor，
    //      因为一条 <a href> 在很多设计里没被显式写成 cursor: pointer；
    //   ② computed cursor 是 pointer 的（全站绝大多数可点元素靠这条，卡片、行都在这类里）。
    // label 不收：它是控件的说明文字，点它是「把焦点送到那一格」，划过给反馈反而是噪音
    //（第一版把 label[for] 收进来，admin-promos 一屏 20 张面全是 <label>，真信号被埋了）。
    const found = Array.prototype.slice.call(root.querySelectorAll('a[href], [role="link"], [role="tab"], [role="option"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], summary, *'))
    for (const el of found) {
      if (seen.has(el)) continue
      const tag = el.tagName
      if (tag === 'BUTTON' || tag === 'HTML' || tag === 'BODY' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'PATH' || tag === 'CIRCLE' || tag === 'RECT' || tag === 'LINE') continue
      if (el.getAttribute('role') === 'button') continue
      if (el.closest('button, [role="button"]')) continue
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      const role = String(el.getAttribute('role') || '')
      const semantic = tag === 'SUMMARY' || ['link', 'tab', 'option', 'menuitem', 'switch', 'checkbox', 'radio'].indexOf(role) >= 0
      if (!semantic && cs.cursor !== 'pointer') continue
      seen.add(el)
      nodes.push({ el: el, why: semantic ? 'semantic:' + tag.toLowerCase() + (role ? '[' + role + ']' : '') : 'cursor:pointer' })
    }
  }
  // 嵌套的只留最外层（文档顺序里祖先先出现）
  const outer = []
  for (const item of nodes) {
    let nested = false
    for (const parent of outer) { if (parent.el.contains(item.el)) { nested = true; break } }
    if (!nested) outer.push(item)
  }
  const items = outer.slice(0, limit).map(function (entry, index) {
    const el = entry.el
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const selector = selectorFor(el)
    let resolved = -1
    try { resolved = document.querySelectorAll(selector).length } catch { resolved = -1 }
    return {
      n: index + 1,
      selector: selector,
      selectorMatches: resolved,
      tag: el.tagName,
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      cls: String(el.getAttribute('class') || ''),
      role: el.getAttribute('role'),
      href: el.getAttribute('href'),
      cursor: cs.cursor,
      why: entry.why,
      descCount: el.querySelectorAll('*').length,
      rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    }
  })
  return { missingScope: false, total: outer.length, items: items }
}

function installPromoAnimProbe() {
  // 听 .vq-promo-undo 上的 animationstart/animationend（1.2 秒窗口），并在同一个窗口里
  // 每 50ms 采一次它的 computed transform —— 「进场动画有没有留下 transform」要看得见过程，不只看结果。
  const state = { at: performance.now(), clickAt: null, events: [], all: [], samples: [], running: true }
  window.__r331anim = state
  document.addEventListener('pointerdown', function (event) {
    const target = event.target
    if (target && target.closest && target.closest('.vq-promo-close')) state.clickAt = performance.now()
  }, true)
  document.addEventListener('animationstart', function (event) {
    const el = event.target
    const isUndo = Boolean(el && el.classList && el.classList.contains('vq-promo-undo'))
    const row = { name: event.animationName, elapsed: Math.round(performance.now() - state.at), target: el ? el.tagName + '.' + String(el.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.') : '?' }
    state.all.push(row)
    if (isUndo) state.events.push(Object.assign({ phase: 'start' }, row))
  }, true)
  document.addEventListener('animationend', function (event) {
    const el = event.target
    if (el && el.classList && el.classList.contains('vq-promo-undo')) {
      state.events.push({ phase: 'end', name: event.animationName, elapsed: Math.round(performance.now() - state.at) })
    }
  }, true)
  const timer = setInterval(function () {
    const el = document.querySelector('.vq-promo-undo')
    state.samples.push({
      t: Math.round(performance.now() - state.at),
      present: Boolean(el),
      transform: el ? getComputedStyle(el).transform : null,
      animationName: el ? getComputedStyle(el).animationName : null,
      height: el ? Math.round(el.getBoundingClientRect().height) : null,
    })
    if (performance.now() - state.at > 1900) { clearInterval(timer); state.running = false }
  }, 50)
  return true
}

function readPromoAnimProbe() {
  const state = window.__r331anim
  if (!state) return { missing: true }
  const el = document.querySelector('.vq-promo-undo')
  const cs = el ? getComputedStyle(el) : null
  const anims = el && el.getAnimations ? el.getAnimations().map(function (a) {
    let name = '(无名)'
    try { name = a.animationName || (a.effect && a.effect.getKeyframes && 'keyframes') || '(无名)' } catch { name = '(读不到名字)' }
    return { name: name, playState: a.playState, currentTime: a.currentTime === null ? null : Math.round(Number(a.currentTime)) }
  }) : null
  return {
    missing: false,
    running: state.running,
    sinceInstallMs: Math.round(performance.now() - state.at),
    clickAtMs: state.clickAt === null ? null : Math.round(state.clickAt - state.at),
    undoEvents: state.events,
    allAnimationStarts: state.all,
    samples: state.samples,
    present: Boolean(el),
    undoText: el ? String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : null,
    undoRect: el ? (function () { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } })() : null,
    computed: cs ? {
      transform: cs.transform,
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      animationDelay: cs.animationDelay,
      animationFillMode: cs.animationFillMode,
      opacity: cs.opacity,
      position: cs.position,
    } : null,
    runningAnimations: anims,
    undoButtonPresent: Boolean(document.querySelector('.vq-promo-undo-button')),
  }
}

function promoLocalKeys() {
  const out = {}
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (/promo/i.test(String(key))) out[key] = String(localStorage.getItem(key) || '').slice(0, 200)
    }
  } catch (error) { return { error: String(error && error.message) } }
  return out
}

function measurePromoClose() {
  const el = document.querySelector('.vq-promo-close')
  if (!el) return { missing: true, promoCount: document.querySelectorAll('.vq-promo').length }
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return {
    missing: false,
    clientWidth: document.documentElement.clientWidth,
    winner: window.innerWidth,
    inlineSize: { width: cs.width, height: cs.height },
    rect: { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, l: Math.round(r.left), t: Math.round(r.top) },
    offset: { w: el.offsetWidth, h: el.offsetHeight },
    padding: cs.padding,
    borderWidth: cs.borderWidth,
    boxSizing: cs.boxSizing,
    flex: cs.flex,
    promoCount: document.querySelectorAll('.vq-promo').length,
  }
}

function adminPromoNumbers() {
  function cardOf() {
    const byToolbar = document.querySelector('.admin-card:has(.admin-promo-toolbar)')
    if (byToolbar) return byToolbar
    const list = document.querySelector('.admin-promo-list')
    return list && list.closest ? list.closest('.admin-card') : null
  }
  function findField(scope, labelText) {
    const labels = Array.prototype.slice.call(scope.querySelectorAll('label'))
    for (const label of labels) {
      const span = label.querySelector('span')
      if (span && String(span.textContent || '').trim() === labelText) return label
    }
    return null
  }
  const card = cardOf()
  const rows = card ? Array.prototype.slice.call(card.querySelectorAll('.admin-promo-row')) : []
  const weightRows = rows.map(function (row, index) {
    const field = findField(row, '权重')
    const input = field ? field.querySelector('input') : null
    const rowTitle = row.querySelector('.admin-promo-row-title')
    const foot = row.querySelector('.admin-promo-row-foot')
    return {
      row: index + 1,
      rowTitle: rowTitle ? String(rowTitle.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : null,
      control: input ? input.tagName.toLowerCase() + '[type=' + (input.getAttribute('type') || '(无)') + ']' : (field ? '不是 input：' + String(field.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '找不到「权重」这一栏'),
      shownNumber: input ? String(input.value) : null,
      step: input ? input.getAttribute('step') : null,
      readOnly: input ? Boolean(input.readOnly) : null,
      hintAtRowFoot: foot ? String(foot.textContent || '').replace(/\s+/g, ' ').trim() : null,
    }
  })
  const hintNodes = card ? Array.prototype.slice.call(card.querySelectorAll('.admin-cell-sub, .admin-hint')).map(function (n) { return String(n.textContent || '').replace(/\s+/g, ' ').trim() }) : []
  const weightHint = hintNodes.filter(function (t) { return t.indexOf('按行序重排权重') >= 0 })
  return {
    cardFound: Boolean(card),
    cardSelector: card ? (card.className || '') : null,
    pageNumberInputs: document.querySelectorAll('input[type="number"]').length,
    cardNumberInputs: card ? card.querySelectorAll('input[type="number"]').length : 0,
    promoRowCount: rows.length,
    weightRows: weightRows,
    weightHintPresent: weightHint.length > 0,
    weightHintText: weightHint[0] || null,
    cardButtons: card ? Array.prototype.slice.call(card.querySelectorAll('button')).length : 0,
  }
}

// ---- 页面动作 ----
let navNonce = 0
function routeUrl(route) {
  navNonce += 1
  if (route.indexOf('admin:') === 0) return BASE + '/?edition=admin&n=' + navNonce + '#' + route.slice(6)
  return BASE + '/?n=' + navNonce + '#' + route
}
async function switchAccountCookie(which) {
  const value = which === 'admin' ? adminToken : token
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: value, domain: '127.0.0.1', path: '/', httpOnly: true })
}

const overlayLog = []
let gateDone = false
async function dismissOverlays() {
  for (let i = 0; i < 3; i += 1) {
    if (!(await evaluate('Boolean(document.querySelector(".vq-guide"))'))) break
    const rect = await evaluate('(' + bringIntoView.toString() + ')(".vq-guide [aria-label=\\"关闭引导\\"]")')
    if (!rect || rect.missing) break
    await clickAt(rect.cx, rect.cy, 90)
    overlayLog.push({ what: '上手引导', how: '真点「关闭引导」', gone: !(await evaluate('Boolean(document.querySelector(".vq-guide"))')) })
    await sleep(200)
  }
  if (!gateDone && (await evaluate('Boolean(document.querySelector(".vq-gate"))'))) {
    const steps = []
    const choice = await evaluate('(' + bringIntoView.toString() + ')(".vq-gate-choice")')
    if (choice && !choice.missing) { await clickAt(choice.cx, choice.cy, 80); steps.push('点第 1 个身份') }
    const next1 = await evaluate('(' + bringIntoView.toString() + ')(".vq-gate-foot button")')
    if (next1 && !next1.missing) { await clickAt(next1.cx, next1.cy, 80); steps.push('第 1 步「继续」') }
    await sleep(700)
    const kind = await evaluate('(' + bringIntoView.toString() + ')(".vq-gate-kind")')
    if (kind && !kind.missing) { await clickAt(kind.cx, kind.cy, 80); steps.push('点第 1 个类目') }
    const next2 = await evaluate('(' + bringIntoView.toString() + ')(".vq-gate-foot button")')
    if (next2 && !next2.missing) { await clickAt(next2.cx, next2.cy, 80); steps.push('第 2 步「继续」') }
    await sleep(700)
    const foot = await evaluate('(' + bringIntoView.toString() + ')(".vq-gate-foot button:last-child")')
    if (foot && !foot.missing) { await clickAt(foot.cx, foot.cy, 90); steps.push('第 3 步最后一颗') }
    await sleep(800)
    const gone = !(await evaluate('Boolean(document.querySelector(".vq-gate"))'))
    overlayLog.push({ what: '身份引导', how: steps.join(' → '), gone: gone })
    gateDone = gone
  }
  const know = await evaluate('(' + bringIntoView.toString() + ')("[aria-label=\\"知道了\\"]")')
  if (know && !know.missing) await clickAt(know.cx, know.cy, 70)
  const toastClose = await evaluate('(' + bringIntoView.toString() + ')(".vq-toast [aria-label=\\"关闭\\"]")')
  if (toastClose && !toastClose.missing) await clickAt(toastClose.cx, toastClose.cy, 70)
  return overlayLog
}

let lastAnchor = { anchor: '', found: true, text: '' }
async function goto(route, anchor, who = 'user') {
  await switchAccountCookie(route.indexOf('admin:') === 0 ? 'admin' : who)
  await cdp.send('Page.navigate', { url: routeUrl(route) })
  await sleep(650)
  let shell = false
  for (let attempt = 0; attempt < 3 && !shell; attempt += 1) {
    shell = Boolean(await waitForExpr('Boolean(document.querySelector(".vq-content"))', '工作台外壳', 18, 250).catch(() => false))
    if (!shell) {
      console.log('SHELL-RETRY ' + route + ' attempt=' + (attempt + 1))
      await cdp.send('Page.reload', {})
      await sleep(1100)
    }
  }
  if (!shell) console.log('SHELL-DEAD ' + route + ' text=' + String(await evaluate('String(document.body.innerText || "").slice(0, 200)').catch(() => '')))
  let found = true
  try {
    await waitForExpr('Boolean(document.querySelector(' + JSON.stringify(anchor) + '))', '页面骨架 ' + anchor, 22, 150)
  } catch {
    found = false
  }
  await sleep(180)
  lastAnchor = {
    anchor: anchor,
    found: found,
    text: found ? '' : String(await evaluate('String(document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 400)')),
  }
  if (!found) console.log('ANCHOR-MISS ' + anchor + ' :: ' + lastAnchor.text.slice(0, 160))
}

const shots = []
async function shotClip(name, selector, size = 120, pad = null) {
  const box = await evaluate('(function () { var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height } })()')
  if (!box) return null
  // size = 以元素中心开的方形窗口；pad = 贴着元素外扩几像素（行式控件用它才看得全整行）
  let x, y, width, height
  if (pad === null) {
    const half = size / 2
    x = Math.max(0, box.x + box.w / 2 - half)
    y = Math.max(0, box.y + box.h / 2 - half)
    width = size
    height = size
  } else {
    x = Math.max(0, box.x - pad)
    y = Math.max(0, box.y - pad)
    width = box.w + pad * 2
    height = box.h + pad * 2
  }
  let captured
  try {
    captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: x, y: y, width: width, height: height, scale: 1 } })
  } catch (error) {
    return { file: null, error: String((error && error.message) || error) }
  }
  const buffer = Buffer.from(captured.data, 'base64')
  const file = path.join(OUT_DIR, name)
  fs.writeFileSync(file, buffer)
  const dim = pngSize(buffer)
  const row = { file: name, bytes: buffer.length, pixel: dim, clip: pad === null ? { x: Math.round(x), y: Math.round(y), size: size } : { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), pad: pad } }
  shots.push(row)
  console.log('SHOT ' + name + ' · ' + row.bytes + ' B · ' + (dim ? dim.width + 'x' + dim.height : '尺寸读不到'))
  return row
}

// ---- 按下探针 ----
const PROPS = [
  ['backgroundColor', 'background-color'],
  ['borderColor', 'border-color'],
  ['color', 'color'],
  ['boxShadow', 'box-shadow'],
  ['transform', 'transform'],
  ['opacity', 'opacity'],
]
// r333：::after 上的反馈单独一组。两边都读不到伪元素（content: none）时跳过——
// 不给页面上绝大多数没有 ::after 的按钮各添一条空 diff。
const AFTER_PROPS = [
  ['backgroundColor', '::after background-color'],
  ['boxShadow', '::after box-shadow'],
  ['transform', '::after transform'],
  ['opacity', '::after opacity'],
]
// r335：border-color 在「没有可见边框」时等于 currentColor，color 一变它必然跟着变（border: 0 也一样）。
// 四边宽度全是 0 就没有边框可画，这条变化看不见，不能算成一次「反馈」——它只是 color 的另一种写法。
function borderVisible(state) {
  const widths = (state && state.borderWidths) || []
  return widths.some((value) => parseFloat(String(value)) > 0)
}
function isDerivedProp(before, after, prop) {
  if (prop !== 'border-color') return false
  return !borderVisible(before) && !borderVisible(after)
}
function propDiffs(before, after, table) {
  const rows = []
  if (!before || !after || before.missing || after.missing) return rows
  for (const pair of (table || PROPS)) {
    if (String(before[pair[0]]) !== String(after[pair[0]])) {
      rows.push({ prop: pair[1], from: String(before[pair[0]]), to: String(after[pair[0]]), derived: isDerivedProp(before, after, pair[1]) })
    }
  }
  const bothAfter = before.after && after.after
  const hasAfter = Boolean(bothAfter) && (String(before.after.content) !== 'none' || String(after.after.content) !== 'none')
  if (hasAfter) {
    for (const pair of AFTER_PROPS) {
      if (String(before.after[pair[0]]) !== String(after.after[pair[0]])) {
        rows.push({ prop: pair[1], from: String(before.after[pair[0]]), to: String(after.after[pair[0]]), derived: false })
      }
    }
  }
  return rows
}
// 看得见的变化（判反馈、判硬切都用这一份）
function diffProps(before, after, table) {
  return propDiffs(before, after, table).filter((row) => !row.derived)
}
// 推导出来的变化（border-color 跟随 color、边框宽度 0）：单列出来如实记录，不混进上面那一份
function derivedDiffs(before, after) {
  return propDiffs(before, after).filter((row) => row.derived)
}
// ---- r337：「划过」扩到非按钮的可点表面（行 / 卡片 / 链接）时多用两条属性 ----
// 下划线是链接最经典的划过反馈，可它不在按下那一层的 PROPS 里（按钮不靠下划线说话）。
// 单开一张表、不改 PROPS：r331–r335 的按钮读数因此一个字都不动。
const HOVER_PROPS = PROPS.concat([
  ['textDecorationLine', 'text-decoration-line'],
  ['textDecorationColor', 'text-decoration-color'],
  ['textUnderlineOffset', 'text-underline-offset'],
])
function hoverPropDiffs(before, after) { return propDiffs(before, after, HOVER_PROPS) }
// 离散属性：算「有反馈」，但不进硬切——它们本来就不补间（跟 r336 的 outline-style 同一条规范规则）。
//   text-decoration-line：none ↔ underline 是离散的，下划线本来就会啪一下出来；
//   text-underline-offset：只有两边都是长度才插值，auto ↔ 长度也是离散的。
function isDiscreteHoverProp(prop, before, after) {
  if (prop === 'text-decoration-line') return true
  if (prop === 'text-underline-offset') return String(before.textUnderlineOffset) === 'auto' || String(after.textUnderlineOffset) === 'auto'
  return false
}
// text-decoration-color 是 border-color 那条规则的另一半：没显式给下划线颜色时，computed 的
// text-decoration-color 就是 currentColor。两种情形都算「推导出来的值」，不是一次反馈：
//   a) 这一张面压根没画线（text-decoration-line: none）—— 没有线可上色；
//   b) 它的 from→to 与 color 的 from→to 一模一样 —— 它只是跟着字色走。
// 这一条只用在 r337 这一层：r331–r335 的读数已经发布，不改它们（同 r335 的宽度 0 规则只加在 presses 那一层）。
function hoverDerivedDecor(before, after, rows) {
  const found = {}
  const colorRow = rows.filter((row) => row.prop === 'color')[0]
  for (const row of rows) {
    if (row.prop !== 'text-decoration-color') continue
    if (String(before.textDecorationLine) === 'none' && String(after.textDecorationLine) === 'none') { found[row.prop] = 'text-decoration-line 是 none（没有线可上色）'; continue }
    if (colorRow && colorRow.from === row.from && colorRow.to === row.to) found[row.prop] = '与 color 同一步（currentColor）'
  }
  return found
}
// ---- r334：这一次变化「走不走过渡」----
// 判据只有一条：computed 的 transition-property 里有没有这条属性、声明出来的 duration 是不是 0。
// 不拿「按下两帧就读到终值」当判据——那只说明「过渡很短」，说明不了「有没有过渡」；也不拿 settledRescued
// 反过来用（过渡没走完 ≠ 硬切），这一层与采样抖动无关。
// 属性名与 PROPS / AFTER_PROPS 的第二种写法一一对应：'background-color' 查元素，
// '::after background-color' 查伪元素自己的那张表（伪元素不继承元素的 transition）。
function cssDurationMs(text) {
  const value = String(text || '').trim().toLowerCase()
  const n = parseFloat(value)
  if (!isFinite(n)) return 0
  if (value.endsWith('ms')) return n
  if (value.endsWith('s')) return n * 1000
  return 0
}
// 简写也算覆盖（r334 实测出来的，不是防患于未然）：transition-property 里存的是**作者写下的名字**，
// Chrome 允许写简写（radar.css 的 .drawer-work 写的就是 `background`），并且会照简写展开后的长属性做动画。
// 只认全名的话，一条真在动的过渡会被报成硬切——与 r333 那次的 ::after 盲区是同一类错（量具的锅，不是页面的）。
const SHORTHAND_COVERS = {
  background: ['background-color'],
  border: ['border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-bottom': ['border-bottom-color'],
  'border-top': ['border-top-color'],
}
function transitionOf(state, after, prop) {
  const src = after ? (state.after || {}) : state
  const props = String(src.transitionProperty || 'none').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  const durs = String(src.transitionDuration || '0s').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  let at = props.indexOf(prop)
  if (at < 0) at = props.indexOf('all')
  if (at < 0) at = props.findIndex((name) => (SHORTHAND_COVERS[name] || []).indexOf(prop) >= 0)
  if (at < 0) return { declared: false, duration: '0s', ms: 0 }
  const duration = durs.length === props.length ? durs[at] : (durs.length === 1 ? durs[0] : durs[Math.min(at, durs.length - 1)])
  return { declared: true, duration: duration, ms: cssDurationMs(duration) }
}
function hardCutProps(changed, state) {
  const rows = []
  for (const item of changed) {
    const isAfter = item.prop.indexOf('::after ') === 0
    const prop = isAfter ? item.prop.slice(8) : item.prop
    const found = transitionOf(state, isAfter, prop)
    if (!found.declared || found.ms <= 0) rows.push({ prop: item.prop, declared: found.declared, duration: found.duration, from: item.from, to: item.to })
  }
  return rows
}
// ---- r336：键盘焦点那一层自己的属性表（与 PROPS / AFTER_PROPS 分开）----
// 为什么不并进 PROPS：焦点会改 outline（输入框一拿到焦点 UA 就画一道），把它塞进按下/划过那张表
// 会把 r331–r335 已经发布的读数改掉，那三层就不可比了。层与层之间宁可各读一张表。
const FOCUS_PROPS = [
  ['outlineWidth', 'outline-width'],
  ['outlineStyle', 'outline-style'],
  ['outlineColor', 'outline-color'],
  ['outlineOffset', 'outline-offset'],
  ['boxShadow', 'box-shadow'],
  ['borderColor', 'border-color'],
  ['backgroundColor', 'background-color'],
  ['color', 'color'],
  ['transform', 'transform'],
  ['opacity', 'opacity'],
]
// 焦点环画出来没有：outline-style 不是 none、宽度 > 0、颜色不是全透明，三条都成立才算。
// 「outline-color 变了」在没画出来的情况下就是 currentColor 的连带变化（r335 那条规则的另一半）。
function outlineVisible(state) {
  if (!state) return false
  if (String(state.outlineStyle) === 'none') return false
  if (!(parseFloat(String(state.outlineWidth)) > 0)) return false
  const rgba = String(state.outlineColor || '').match(/rgba?\(([^)]+)\)/)
  if (rgba) {
    const parts = rgba[1].split(',').map((item) => item.trim())
    if (parts.length === 4 && parseFloat(parts[3]) === 0) return false
  }
  return true
}
function focusIsDerived(before, after, prop) {
  if (prop === 'border-color') return !borderVisible(before) && !borderVisible(after)
  // 环没画出来（样式 none / 宽度 0 / 颜色全透明）时，outline 的四条都只是数字在变，屏幕上什么都没有：
  // 与 r335 的 border-color 是同一条规则的另一半。0.9.309 第一版只写了 outline-color ——
  // qc-input / agx-textarea 那两站就是这么被算成硬切的（width 3px→0、offset 0→2px，但环压根没画）。
  if (prop.indexOf('outline-') === 0) return !outlineVisible(after)
  return false
}
function focusPropDiffs(before, after) {
  const rows = []
  if (!before || !after || before.missing || after.missing) return rows
  for (const pair of FOCUS_PROPS) {
    if (String(before[pair[0]]) !== String(after[pair[0]])) {
      rows.push({ prop: pair[1], from: String(before[pair[0]]), to: String(after[pair[0]]), derived: focusIsDerived(before, after, pair[1]) })
    }
  }
  const bothAfter = before.after && after.after
  const hasAfter = Boolean(bothAfter) && (String(before.after.content) !== 'none' || String(after.after.content) !== 'none')
  if (hasAfter) {
    for (const pair of AFTER_PROPS) {
      if (String(before.after[pair[0]]) !== String(after.after[pair[0]])) {
        rows.push({ prop: pair[1], from: String(before.after[pair[0]]), to: String(after.after[pair[0]]), derived: false })
      }
    }
  }
  return rows
}
function focusChanged(before, after) { return focusPropDiffs(before, after).filter((row) => !row.derived) }
function focusDerivedDiffs(before, after) { return focusPropDiffs(before, after).filter((row) => row.derived) }
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
function pathOf(url) {
  try { return new URL(url).pathname } catch { return String(url) }
}
function writeStatsFrom(mark) {
  const rows = cdp.requests.slice(mark).map((row) => ({ method: row.method, path: pathOf(row.url) }))
  const writes = rows.filter((row) => WRITE_METHODS.has(row.method) && row.path.indexOf('/api/') === 0)
  const counts = {}
  for (const row of writes) counts[row.method + ' ' + row.path] = (counts[row.method + ' ' + row.path] || 0) + 1
  return { writes: writes.length, counts: counts, apiCalls: rows.filter((row) => row.path.indexOf('/api/') === 0).length }
}

// ---- r336：真 Tab（CDP 真键盘输入）+ 一趟键盘焦点走查 ----
async function tabKey() {
  // 真按一下 Tab：rawKeyDown + keyUp。合成不了焦点——焦点导航要浏览器自己处理这次按键。
  const base = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers: 0 }
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base))
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base))
  await sleep(90)
}
async function blurAll() {
  await evaluate('(function () { try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur() } catch (e) {} return true })()')
}
async function parkMouseNeutral() {
  const neutral = await evaluate('(' + neutralPoint.toString() + ')()')
  if (neutral) await mouseTo(neutral.x, neutral.y)
  return neutral
}
async function focusWalk(pageId, pageLabel) {
  const row = {
    id: pageId, label: pageLabel, cap: FOCUS_CAP, stops: [], capReached: false,
    endedAtBody: null, cycled: null, restMissing: 0, chainShifted: [], rings: 0, delegated: 0, holes: 0, readFailedStops: 0,
    hardCutStops: 0, focusVisibleOffStops: 0,
  }
  await blurAll()
  await evaluate('(function () { window.scrollTo(0, 0); return true })()')
  // r336：「一站都没走到」要先分清是「这一屏真的没有可 Tab 的东西」还是「走查没走起来」。
  // 先数一遍页面上看得见、tabIndex >= 0、没 disabled 的元素，走完对一遍再报异常（量不到 ≠ 没问题）。
  row.page = await evaluate('(function () { var list = Array.prototype.slice.call(document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")); var reach = list.filter(function (n) { if (n.disabled) return false; if (n.tabIndex < 0) return false; var r = n.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; var cs = getComputedStyle(n); return cs.display !== "none" && cs.visibility !== "hidden" }); return { hash: location.hash, reachable: reach.length, nodes: list.length } })()')
  await parkMouseNeutral()
  await sleep(60)
  const walk = []
  for (let i = 0; i < FOCUS_CAP; i += 1) {
    await tabKey()
    const at = await evaluate('(' + focusActive.toString() + ')()')
    if (!at || at.body) { row.endedAtBody = i + 1; break }
    if (walk.some((item) => item.selector === at.selector)) { row.cycled = i + 1; break }
    // 焦点这一拍。Tab 会把元素滚到视口中间，而鼠标停在角落——万一那一点正好压在它身上，
    // :hover 会混进这一拍（rest 那一趟是干净的，差出来就成了假反馈）。撞上了先把鼠标挪开再读一次。
    let state = await evaluate('(' + readFocusState.toString() + ')(' + JSON.stringify(at.selector) + ')')
    let hoverOverlap = false
    if (state && !state.missing && state.chain[0].hover) {
      hoverOverlap = true
      await parkMouseNeutral()
      await sleep(40)
      state = await evaluate('(' + readFocusState.toString() + ')(' + JSON.stringify(at.selector) + ')')
    }
    walk.push({ n: i + 1, selector: at.selector, tag: at.tag, text: at.text, cls: at.cls, type: at.type, focusVisible: at.focusVisible, focusWithin: at.focusWithin, hoverOverlap: hoverOverlap, focused: state })
  }
  if (walk.length >= FOCUS_CAP) row.capReached = true
  // rest 基线：焦点还回去、鼠标重新停到中性点，再读同一批选择器
  await blurAll()
  await parkMouseNeutral()
  await sleep(80)
  for (const stop of walk) {
    const focused = stop.focused
    const rest = await evaluate('(' + readFocusState.toString() + ')(' + JSON.stringify(stop.selector) + ')')
    const item = {
      n: stop.n, selector: stop.selector, tag: stop.tag, text: stop.text, cls: stop.cls, type: stop.type,
      focusVisible: stop.focusVisible, focusWithin: stop.focusWithin, hoverOverlap: stop.hoverOverlap,
      changed: [], derived: [], outlineDrawn: null, ringAppeared: null, outlineAppearProps: [], ancestorChanged: [], hardCuts: [], focusVisibleOff: [], verdict: null, error: null,
    }
    if (!focused || focused.missing) { item.verdict = 'read-failed'; item.error = '焦点那一拍读不到元素'; row.readFailedStops += 1; row.stops.push(item); continue }
    if (!rest || rest.missing) { item.verdict = 'read-failed'; item.error = 'rest 读不到元素（Tab 走完之后选择器对不上了）'; row.readFailedStops += 1; row.restMissing += 1; row.stops.push(item); continue }
    if (!stop.focusVisible) item.focusVisibleOff.push('拿到焦点了，但 :focus-visible 没匹配')
    const selfChanged = focusChanged(rest.chain[0], focused.chain[0])
    item.changed = selfChanged.map((pair) => pair.prop)
    item.derived = focusDerivedDiffs(rest.chain[0], focused.chain[0]).map((pair) => pair.prop)
    item.outlineDrawn = outlineVisible(focused.chain[0])
    // 焦点环「从无到有」这一下不算硬切：outline-style 是离散属性（none ↔ auto），规范里不做补间，
    // 浏览器给键盘焦点的默认环就是啪一下出来的 —— 那是平台行为，不是这一页的设计选择。
    // 只有「环本来就在、只是颜色或位置变了」才按硬切那套判（r335 的 currentColor 是同一种自我纠正：
    // 先把「这条变化根本不是设计」的情形摘出去，再谈走不走过渡）。
    const ringAppeared = outlineVisible(rest.chain[0]) !== outlineVisible(focused.chain[0])
    item.ringAppeared = ringAppeared
    item.outlineAppearProps = ringAppeared ? selfChanged.filter((pair) => pair.prop.indexOf('outline-') === 0).map((pair) => pair.prop) : []
    const cutCandidates = ringAppeared ? selfChanged.filter((pair) => pair.prop.indexOf('outline-') !== 0) : selfChanged
    item.hardCuts = cutCandidates.length ? hardCutProps(cutCandidates, focused.chain[0]) : []
    // 祖先这一路（:focus-within）：输入框把 UA 焦点框按掉、由外层容器给焦点提示时，反馈在祖先身上。
    // 按位置对齐并核对 tag/class，挪位了就当读不到，不硬凑。
    for (let k = 1; k < focused.chain.length; k += 1) {
      const up = focused.chain[k]
      const restUp = rest.chain[k]
      if (!restUp) continue
      if (restUp.tag !== up.tag || restUp.cls !== up.cls) { row.chainShifted.push(stop.selector + ' :: up' + (k - 1)); continue }
      const changed = focusChanged(restUp, up)
      if (!changed.length) continue
      item.ancestorChanged.push({ where: up.selector, tag: up.tag, cls: up.cls.slice(0, 80), changed: changed.map((pair) => pair.prop) })
      for (const cut of hardCutProps(changed, up)) item.hardCuts.push({ prop: 'up' + (k - 1) + ' ' + cut.prop, declared: cut.declared, duration: cut.duration, from: cut.from, to: cut.to })
    }
    item.verdict = item.changed.length ? 'ring' : (item.ancestorChanged.length ? 'delegated-ring' : 'no-visible-change')
    row.stops.push(item)
  }
  row.rings = row.stops.filter((item) => item.verdict === 'ring').length
  row.delegated = row.stops.filter((item) => item.verdict === 'delegated-ring').length
  row.holes = row.stops.filter((item) => item.verdict === 'no-visible-change').length
  row.hardCutStops = row.stops.filter((item) => item.hardCuts.length > 0).length
  row.focusVisibleOffStops = row.stops.filter((item) => item.focusVisibleOff.length > 0).length
  row.outlineAppearances = row.stops.filter((item) => item.ringAppeared).length
  if (row.page && row.page.reachable > 0 && row.stops.length === 0) anomaly(pageId, '这一屏有可 Tab 到的元素，但焦点走查一站都没走到', row.page)
  focusPages.push(row)
  console.log('FOCUS ' + row.id + ' · Tab 到 ' + row.stops.length + ' 站 · 自己有环 ' + row.rings + ' · 环在祖先 ' + row.delegated + ' · 看不出焦点 ' + row.holes + ' · 焦点硬切 ' + row.hardCutStops + ' · :focus-visible 没匹配 ' + row.focusVisibleOffStops + ' · 读不到 ' + row.readFailedStops + (row.capReached ? ' · 到上限 ' + FOCUS_CAP : '') + (row.endedAtBody ? ' · 第 ' + row.endedAtBody + ' 下回到 body' : '') + (row.cycled ? ' · 第 ' + row.cycled + ' 下回到开头' : ''))
  return row
}

async function hoverWalk(pageId, pageLabel, scope) {
  const row = {
    id: pageId, label: pageLabel, scope: scope || null, cap: HOVER_CAP, total: null, listed: 0,
    capReached: false, aborted: null, surfaces: [],
    feedback: 0, noChange: 0, discreteOnly: 0, hardCutSurfaces: 0, readFailed: 0,
  }
  const collected = await evaluate('(' + collectHoverSurfaces.toString() + ')(' + JSON.stringify(scope || null) + ',' + HOVER_CAP + ')')
  if (!collected || collected.missingScope) {
    row.aborted = 'scope 在收集划过表面时已经不见了：' + scope
    hoverPages.push(row)
    console.log('HOVER ' + pageId + ' :: ABORT ' + row.aborted)
    return row
  }
  row.total = collected.total
  row.listed = collected.items.length
  row.capReached = collected.total > collected.items.length
  if (row.capReached) note(pageId + '：非按钮的可点表面 ' + collected.total + ' 个，按文档顺序只量前 ' + HOVER_CAP + ' 个', { skipped: collected.total - collected.items.length })
  for (const item of collected.items) {
    const surface = {
      n: item.n, selector: item.selector, selectorMatches: item.selectorMatches, tag: item.tag, text: item.text,
      cls: item.cls.slice(0, 90), role: item.role, href: item.href, cursor: item.cursor, why: item.why, descCount: item.descCount,
      rect: item.rect, verdict: null, error: null, changed: [], derived: [], discrete: [], hardCuts: [], shifts: [],
      hitInside: null, truncated: 0, descRead: 0,
    }
    try {
      const view = await evaluate('(' + bringIntoView.toString() + ')(' + JSON.stringify(item.selector) + ')')
      if (!view || view.missing) { surface.error = '划过前元素已经不在页面上'; surface.verdict = 'read-failed'; row.readFailed += 1; row.surfaces.push(surface); continue }
      surface.rect = { l: view.l, t: view.t, w: view.w, h: view.h }
      if (!view.inViewport) { surface.error = '滚到眼前之后仍不在视口里（t=' + view.t + ', h=' + view.h + '），这一张量不了'; surface.verdict = 'read-failed'; row.readFailed += 1; row.surfaces.push(surface); continue }
      // ① 鼠标离开这一张面：rest 基线
      await parkMouseNeutral()
      await sleep(70)
      const rest = await evaluate('(' + readHoverState.toString() + ')(' + JSON.stringify(item.selector) + ')')
      if (!rest || rest.missing) { surface.error = 'rest 读不到这张面'; surface.verdict = 'read-failed'; row.readFailed += 1; row.surfaces.push(surface); continue }
      // ② 移到中心：划过去那一拍
      await mouseTo(view.cx, view.cy)
      await sleep(160)
      const hover = await evaluate('(' + readHoverState.toString() + ')(' + JSON.stringify(item.selector) + ')')
      if (!hover || hover.missing) { surface.error = '划过那一拍读不到这张面'; surface.verdict = 'read-failed'; row.readFailed += 1; row.surfaces.push(surface); continue }
      surface.hitInside = hover.hitInside
      surface.truncated = hover.truncated
      surface.descRead = hover.snapshots.length - 1
      if (!hover.hitInside) note('落点被盖住：' + item.selector, { hit: hover.hit, where: pageId + '#' + item.n })
      for (let i = 0; i < hover.snapshots.length; i += 1) {
        const after = hover.snapshots[i]
        const before = rest.snapshots[i]
        const where = i === 0 ? 'self' : 'self>' + (after.where || 'd' + i)
        if (!before || before.tag !== after.tag || before.cls !== after.cls) { surface.shifts.push(where); continue }
        const rows = hoverPropDiffs(before, after)
        if (!rows.length) continue
        const decor = hoverDerivedDecor(before, after, rows)
        for (const diff of rows) {
          if (diff.derived) { surface.derived.push(where + ' ' + diff.prop); continue }
          if (decor[diff.prop]) { surface.derived.push(where + ' ' + diff.prop + '（' + decor[diff.prop] + '）'); continue }
          surface.changed.push(where + ' ' + diff.prop)
          if (isDiscreteHoverProp(diff.prop, before, after)) { surface.discrete.push(where + ' ' + diff.prop + ': ' + diff.from + ' → ' + diff.to); continue }
          const found = transitionOf(after, false, diff.prop)
          if (!found.declared || found.ms <= 0) surface.hardCuts.push({ where: where, prop: diff.prop, declared: found.declared, duration: found.duration, from: diff.from, to: diff.to })
        }
      }
      surface.verdict = surface.changed.length ? 'hover-feedback' : 'hover-no-change'
      // 证据图：只给「划过有反馈」的面留一张（还划着的时候截），给的是这一张面的局部
      if (SHOTS === 'all' && surface.verdict === 'hover-feedback') {
        surface.screenshot = await shotClip(pageId + '-' + item.n + '-hover.png', item.selector, SHOT_SIZE, 8)
      }
    } catch (error) {
      surface.error = String((error && error.message) || error).slice(0, 300)
      surface.verdict = 'read-failed'
      row.readFailed += 1
      try { await parkMouseNeutral() } catch { /* 鼠标收不回来也要往下走 */ }
    }
    if (surface.verdict === 'hover-feedback') row.feedback += 1
    if (surface.verdict === 'hover-no-change') row.noChange += 1
    if (surface.hardCuts.length) row.hardCutSurfaces += 1
    if (surface.discrete.length && !surface.hardCuts.length) row.discreteOnly += 1
    row.surfaces.push(surface)
    console.log('HOVER ' + pageId + '#' + item.n + ' ' + (surface.verdict || '?') + ' :: ' + String(item.text).slice(0, 22) + ' :: ' + item.tag + (item.cls ? '.' + item.cls.split(' ')[0] : '') + ' changed=[' + surface.changed.join(',') + ']' + (surface.hardCuts.length ? ' HARD-CUT=' + surface.hardCuts.map((c) => c.where + ':' + c.prop).join(',') : '') + (surface.error ? ' ERROR=' + surface.error : ''))
  }
  hoverPages.push(row)
  console.log('HOVER-SUMMARY ' + row.id + ' · 非按钮表面 ' + row.listed + '/' + row.total + ' · 有反馈 ' + row.feedback + ' · 看不出变化 ' + row.noChange + ' · 有反馈但硬切 ' + row.hardCutSurfaces + ' · 只靠下划线 ' + row.discreteOnly + ' · 读不到 ' + row.readFailed + (row.capReached ? ' · 到上限 ' + HOVER_CAP : ''))
  return row
}

async function pressOne(pageId, pageLabel, item) {
  const out = {
    page: pageId, pageLabel: pageLabel, n: item.n,
    selector: item.selector, selectorMatches: item.selectorMatches,
    tag: item.tag, text: item.text, html: item.html, cls: item.cls,
    disabled: item.disabled, ariaDisabled: item.ariaDisabled, cursor: item.cursor, type: item.type,
    rect: item.rect,
    verdict: null, pressActive: null, changed: [], error: null,
  }
  try {
    const view = await evaluate('(' + bringIntoView.toString() + ')(' + JSON.stringify(item.selector) + ')')
    if (!view || view.missing) { out.error = '按下前元素已经不在页面上'; out.verdict = 'read-failed'; return out }
    out.rect = { l: view.l, t: view.t, w: view.w, h: view.h }
    out.scroller = view.scroller
    if (!view.inViewport) {
      out.error = '滚到眼前之后仍不在视口里（t=' + view.t + ', h=' + view.h + '），这一颗量不了'
      out.verdict = 'read-failed'
      return out
    }
    const neutral = await evaluate('(' + neutralPoint.toString() + ')()')
    if (!neutral) out.neutral = '找不到中性点（仍有落在交互元素上的风险）'
    out.hashBefore = await evaluate('location.hash')

    // ① 鼠标不在元素上：rest
    if (neutral) await mouseTo(neutral.x, neutral.y)
    await sleep(70)
    const rest = await evaluate('(' + readState.toString() + ')(' + JSON.stringify(item.selector) + ')')
    if (!rest || rest.missing) { out.error = 'rest 读不到元素'; out.verdict = 'read-failed'; return out }
    out.rest = { active: rest.active, backgroundColor: rest.backgroundColor, borderColor: rest.borderColor, color: rest.color, transform: rest.transform, opacity: rest.opacity, hitIsSelf: rest.hitIsSelf, hit: rest.hit }

    // ② 移到中心 = hover 基线（lead 口径：idle/hover 基线就是这一拍）
    await mouseTo(view.cx, view.cy)
    await sleep(160)
    const hover = await evaluate('(' + readState.toString() + ')(' + JSON.stringify(item.selector) + ')')
    if (!hover || hover.missing) { out.error = 'hover 读不到元素'; out.verdict = 'read-failed'; return out }
    out.hover = {
      active: hover.active, disabled: hover.disabled,
      backgroundColor: hover.backgroundColor, borderColor: hover.borderColor, color: hover.color,
      boxShadow: hover.boxShadow, transform: hover.transform, opacity: hover.opacity,
      transitionProperty: hover.transitionProperty, transitionDuration: hover.transitionDuration,
      cursor: hover.cursor, hitIsSelf: hover.hitIsSelf, hit: hover.hit,
      after: hover.after,
    }
    out.hoverChangedVsRest = diffProps(rest, hover)
    out.hoverDerived = derivedDiffs(rest, hover).map((row) => row.prop)
    // r335：同一套硬切判据用在 hover 上。过渡表读的是「划过之后」那一拍的 computed 值——
    // 规范里过渡取的是 after-change style（:hover 生效后的那份），所以这一拍才是权威的那一份。
    out.hoverHardCuts = hardCutProps(out.hoverChangedVsRest, hover)
    if (!hover.hitIsSelf) note('落点被盖住：' + item.selector, { hit: hover.hit, where: pageId + '#' + item.n })

    // ③ 真按下：mousePressed 之后两帧 rAF 读同一批属性 + matches(:active)
    await mouseDown(view.cx, view.cy)
    const pressed = await evaluate('new Promise(function (done) { requestAnimationFrame(function () { requestAnimationFrame(function () { done((' + readState.toString() + ')(' + JSON.stringify(item.selector) + ')) }) }) })')
    if (!pressed || pressed.missing) { out.error = '按下那一拍读不到元素'; out.verdict = 'read-failed'; return out }
    out.pressed = {
      active: pressed.active, disabled: pressed.disabled,
      backgroundColor: pressed.backgroundColor, borderColor: pressed.borderColor, color: pressed.color,
      boxShadow: pressed.boxShadow, transform: pressed.transform, opacity: pressed.opacity,
      transitionProperty: pressed.transitionProperty, transitionDuration: pressed.transitionDuration,
      cursor: pressed.cursor, hitIsSelf: pressed.hitIsSelf, hit: pressed.hit,
      after: pressed.after,
    }
    out.pressActive = Boolean(pressed.active)
    out.changed = diffProps(hover, pressed)
    out.derivedOnPress = derivedDiffs(hover, pressed).map((row) => row.prop)
    if (out.disabled) out.verdict = 'disabled'
    else if (out.changed.length) out.verdict = 'has-feedback'
    else if (out.pressActive) out.verdict = 'pressed-no-feedback'
    else out.verdict = 'active-not-matched'

    // ④ 按下那一刻的截图（还在按着）——只给「无反馈候选」
    if (SHOTS === 'all') {
      out.screenshot = await shotClip(pageId + '-' + item.n + '-press.png', item.selector, SHOT_SIZE, 8)
    } else if (out.verdict === 'pressed-no-feedback') {
      out.screenshot = await shotClip(pageId + '-' + item.n + '-press.png', item.selector, SHOT_SIZE)
    }

    // ④b 还按着，等过渡走完再看一眼终值。两帧只能看到 120ms ease 的中间值（实测 0.44px），
    //     「规则里声明了 1px、实际被谁盖掉 / 过渡永远走不完」只有稳态这一拍看得出来。
    //     判定仍按 ③ 的两帧口径（和 r331 的数字可比），这一拍作为附加证据进产物。
    await sleep(200)
    const settled = await evaluate('(' + readState.toString() + ')(' + JSON.stringify(item.selector) + ')')
    if (settled && !settled.missing) {
      out.pressedSettled = {
        active: settled.active,
        backgroundColor: settled.backgroundColor,
        borderColor: settled.borderColor,
        color: settled.color,
        boxShadow: settled.boxShadow,
        transform: settled.transform,
        opacity: settled.opacity,
        after: settled.after,
      }
      out.changedSettledVsHover = diffProps(hover, settled).map((pair) => pair.prop)
    }
    // r334：有反馈 ≠ 反馈走过渡。按下的每一项变化去查它对应的过渡表，查不到（或 duration 为 0）就是硬切。
    // 只对「两帧就看到了变化」的那些项算——disabled / 真的没反应的按钮不该出现在这一节里。
    if (out.changed.length) {
      out.hardCuts = hardCutProps(out.changed, out.pressed)
    }

    // ⑤ 不在原地松开：挪到中性点再松（不合成 click）
    if (neutral) await mouseTo(neutral.x, neutral.y)
    await mouseUp(neutral ? neutral.x : 3, neutral ? neutral.y : 3)
    await sleep(40)
    out.releasedAt = neutral ? { x: neutral.x, y: neutral.y, on: neutral.tag + (neutral.cls ? '.' + neutral.cls : '') } : null
    out.hashAfter = await evaluate('location.hash')
  } catch (error) {
    out.error = String((error && error.message) || error).slice(0, 300)
    out.verdict = 'read-failed'
    try {
      const neutral = await evaluate('(' + neutralPoint.toString() + ')()')
      if (neutral) { await mouseTo(neutral.x, neutral.y); await mouseUp(neutral.x, neutral.y) }
    } catch { /* 鼠标状态收不回来也要往下走 */ }
  }
  console.log('PRESS ' + pageId + '#' + item.n + ' ' + (out.verdict || '?') + ' :: ' + String(item.text).slice(0, 24) + ' :: active=' + out.pressActive + ' changed=' + out.changed.map((c) => c.prop).join(',') + ((out.hardCuts || []).length ? ' HARD-CUT=' + out.hardCuts.map((c) => c.prop).join(',') : '') + (out.error ? ' ERROR=' + out.error : ''))
  return out
}

// ---- 屏与趟 ----
// 每一趟的 scope 都是「这一屏的内容区」(.vq-content)，不是整页：
//   侧栏 18 个 + 顶栏 5 个按钮会先把 25 个名额吃光，页面上真正要看的东西（模板卡片、能力卡、预设卡）
//   就轮不上了。外壳单独一趟 shell 覆盖，两趟加起来才是整页所有可见 button。
const PASSES = [
  { id: 'shell', label: '外壳 · 侧栏与顶栏', route: '/overview', who: 'user', scope: '.vq-sidebar, .vq-topbar', ready: '.vq-content', note: '整页外壳上的按钮（侧栏导航、搜索、模型、账号、版本号）单独一趟，不占内容页的 25 个名额' },
  { id: 'overview', label: '工作台', route: '/overview', who: 'user', scope: '.vq-content', ready: '.vq-content', note: '内容区所有可见 button / [role=button] / .vq-card-open，按 DOM 顺序取前 25 个（含 PromoSlot 的按钮）' },
  { id: 'overview-cap', label: '工作台 · 四张能力卡', route: '/overview', who: 'user', scope: '.ov-capabilities', ready: '.ov-cap', note: '整屏内容区按钮超过 25 个，四张能力卡在 DOM 里排在运营位之后，单开一趟补齐（lead 点名的目标）' },
  { id: 'admin-promos', label: '后台 · 运营位卡', route: 'admin:/admin/system', who: 'admin', scope: '.admin-card:has(.admin-promo-toolbar)', ready: '.admin-promo-toolbar', note: '只量运营位这一张卡：保存运营位 / 恢复默认 / 新增一条 / 每行的上移、下移、删除' },
  { id: 'templates', label: '模板库', route: '/templates', who: 'user', scope: '.vq-content', ready: '.template-card', note: '模板卡片（.vq-card-open）与页面其它可点元素' },
  { id: 'templates-drawer', label: '模板库 · 详情抽屉底栏', route: '/templates', who: 'user', scope: '.template-drawer', prepare: 'open-drawer', ready: '.template-card' },
  { id: 'settings', label: '设置', route: '/settings', who: 'user', scope: '.vq-content', ready: '.vq-page--settings' },
  { id: 'projects', label: '作品流', route: '/projects', who: 'user', scope: '.vq-content', ready: '.vq-page' },
  { id: 'agents', label: '智能体', route: '/agents', who: 'user', scope: '.vq-content', ready: '.agx-surface-switch' },
  { id: 'agents-presets', label: '智能体 · 对话预设', route: '/agents', who: 'user', scope: '.vq-content', prepare: 'open-presets', ready: '.agx-surface-switch', note: '预设卡在「对话预设」页签里，先真点页签再量' },
  // r336：只跑键盘焦点那一层（不加进按下巡检：那样 136 颗的基线会变，三层读数就不可比了）。
  // 这一屏是静态门禁抓到的唯一一处真黑洞（.lw-composer textarea 把 UA 焦点框按掉又没补），
  // 加进来就是为了在真页面上量它一眼。
  { id: 'local-workspace', label: '本地工作区 · 输入框', route: '/local', who: 'user', scope: '.lw-composer', focusOnly: true, ready: '.vq-content', note: '静态门禁抓到的焦点黑洞所在屏（空状态里没有 .lw-composer，ready 用 .vq-content，不然这一趟连页都进不去）' },
]

async function preparePass(pass) {
  if (pass.prepare === 'open-drawer') {
    const card = await evaluate('(' + bringIntoView.toString() + ')(".template-card")')
    if (!card || card.missing) { note('模板库：没有 .template-card，抽屉这一趟量不了'); return false }
    await clickAt(card.cx, card.cy, 120)
    try {
      await waitForExpr('Boolean(document.querySelector(".template-drawer"))', '模板详情抽屉', 30, 150)
      return true
    } catch {
      note('模板库：点了卡片但抽屉没开，抽屉这一趟量不了', { hash: await evaluate('location.hash') })
      return false
    }
  }
  if (pass.prepare === 'open-presets') {
    const tab = await evaluate('(function () { var list = Array.prototype.slice.call(document.querySelectorAll(".agx-surface-switch button")); var el = list.filter(function (n) { return String(n.textContent || "").replace(/\\s+/g, " ").trim() === "对话预设" })[0]; if (!el) return { missing: true, found: list.map(function (n) { return String(n.textContent || "").replace(/\\s+/g, " ").trim() }) }; var r = el.getBoundingClientRect(); return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } })()')
    if (!tab || tab.missing) { note('智能体：找不到「对话预设」页签，预设卡这一趟量不了', tab); return false }
    await clickAt(tab.cx, tab.cy, 120)
    await sleep(300)
    return true
  }
  return true
}

const buttons = []
const passes = []
// r336：焦点那一层按「屏」记账（每屏一条 Tab 走查）
const focusPages = []
// r337：划过那一层按「屏」记账（每屏一趟非按钮表面）
const hoverPages = []
let totalPressCount = 0

async function runPass(pass) {
  const row = {
    id: pass.id, label: pass.label, route: pass.route, who: pass.who || 'user',
    scope: pass.scope || null, note: pass.note || '',
    anchor: null, scopePresent: null, total: null, measured: 0, truncated: false,
    aborted: null, writeRequests: 0, writeCounts: {}, pressCount: 0,
    candidates: [], feedback: 0, noFeedback: 0, activeNotMatched: 0, disabled: 0, readFailed: 0,
    extra: null,
  }
  const mark = cdp.requests.length
  try {
    await goto(pass.route, pass.ready || '.vq-content', pass.who || 'user')
    await dismissOverlays()
    row.anchor = lastAnchor
    const prepared = await preparePass(pass)
    row.prepared = prepared
    if (!prepared) { row.aborted = '这一趟的入口没能打开（见 notes）'; passes.push(row); return }
    // 刚打开的面板还在进场位移（抽屉从右边滑进来，运营位卡片从下往上浮）：
    // 这时候读到的 rect 是半路上的位置，鼠标按下去可能差几像素落在按钮外面——
    // 那不是「按下没反应」，是没按到。等进场动画跑完再量（0.26s 动画 + 一帧余量）。
    if (pass.prepare) await sleep(600)
    if (pass.scope) {
      const present = await evaluate('Boolean(document.querySelector(' + JSON.stringify(pass.scope) + '))')
      row.scopePresent = present
      if (!present) { row.aborted = 'scope 选择器在这页上找不到：' + pass.scope; passes.push(row); return }
    }
    // 额外量（后台运营位卡的权重控件）
    if (pass.id === 'admin-promos') {
      row.extra = await evaluate('(' + adminPromoNumbers.toString() + ')()')
      console.log('ADMIN-EXTRA ' + JSON.stringify(row.extra))
    }
    const collected = await evaluate('(' + collectTargets.toString() + ')(' + JSON.stringify(pass.scope || null) + ',25)')
    if (!collected || collected.missingScope) { row.aborted = 'scope 在收集时已经不在了：' + pass.scope; passes.push(row); return }
    row.total = collected.total
    row.truncated = collected.total > collected.items.length
    row.listed = collected.items.length
    if (row.truncated) note(pass.id + '：可见可点元素 ' + collected.total + ' 个，按 DOM 顺序只量前 25 个', { skipped: collected.total - collected.items.length })
    for (const item of collected.items) {
      // 趟里的元素可能因为上一颗的副作用消失：不存在就跳过并如实记一行
      const alive = await evaluate('Boolean(document.querySelector(' + JSON.stringify(item.selector) + '))')
      if (!alive) {
        buttons.push({ page: pass.id, pageLabel: pass.label, n: item.n, selector: item.selector, tag: item.tag, text: item.text, html: item.html, rect: item.rect, disabled: item.disabled, cursor: item.cursor, verdict: 'read-failed', error: '按下前元素已经不在页面上（上一颗的副作用）', changed: [] })
        row.readFailed += 1
        continue
      }
      const result = await pressOne(pass.id, pass.label, item)
      buttons.push(result)
      row.measured += 1
      row.pressCount += 1
      totalPressCount += 1
      if (result.verdict === 'has-feedback') row.feedback += 1
      else if (result.verdict === 'pressed-no-feedback') { row.noFeedback += 1; row.candidates.push({ n: item.n, selector: item.selector, text: item.text }) }
      else if (result.verdict === 'active-not-matched') row.activeNotMatched += 1
      else if (result.verdict === 'disabled') row.disabled += 1
      else row.readFailed += 1
      if (result.hashAfter && result.hashBefore !== undefined && result.hashAfter !== result.hashBefore) anomaly(pass.id, '按下之后地址变了（不该发生）', { after: result.hashAfter })
    }
    // 一趟结束时地址对不对：不对就记一条，不静默
    const hash = await evaluate('location.hash')
    row.hashAfterPass = hash
    const expectedHash = pass.route.indexOf('admin:') === 0 ? pass.route.slice(6) : pass.route
    const actualHash = String(hash || '').replace(/^#/, '')
    if (actualHash.indexOf(expectedHash) !== 0) {
      anomaly(pass.id, '一趟结束时地址不是这一屏', { hash: hash, expected: expectedHash })
    }
  } catch (error) {
    row.aborted = String((error && error.message) || error).slice(0, 300)
    console.log('PASS-ERROR ' + pass.id + ' :: ' + row.aborted)
  }
  const stats = writeStatsFrom(mark)
  row.writeRequests = stats.writes
  row.writeCounts = stats.counts
  row.apiCalls = stats.apiCalls
  passes.push(row)
  console.log('PASS ' + pass.id + ' · 可见可点 ' + row.total + ' · 量了 ' + row.measured + ' · 有反馈 ' + row.feedback + ' · 无反馈候选 ' + row.noFeedback + ' · active 没匹配 ' + row.activeNotMatched + ' · 禁用 ' + row.disabled + ' · 读不到 ' + row.readFailed + ' · 写请求 ' + row.writeRequests + (row.aborted ? ' · ABORTED ' + row.aborted : ''))
  return row
}

// ---- 主流程 ----
let stopped = false
const promo = { closeSizes: [], closePress: null, dismissUndo: null, adminWeights: null, localKeys: null }
try {
  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((response) => response.json()).catch(() => null)
    return list && list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('DOM.enable')
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: '127.0.0.1', path: '/', httpOnly: true })

  // 开场：先真走一遍引导（新 profile 会挡屏），之后把「看过上手引导」按账号记进 localStorage。
  await goto('/overview', '.vq-content')
  await sleep(700)
  await dismissOverlays()
  if (overlayLog.length) note('开场遮罩：真点关掉了', overlayLog)
  else note('开场遮罩：这一轮没有出现需要关的遮罩')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('vq_welcome_seen:" + account.id + "','1');localStorage.setItem('vq_mobile_note_seen','1');localStorage.setItem('vq.edition','user')}catch(e){}",
  })

  // r336：焦点那一层不碰鼠标，运营位这几段（尺寸 / 按下 / 撤销动画）只在按下巡检时跑。
  if (!FOCUS_MODE) {
  // ---- 运营位补量 ----
  await goto('/overview', '.vq-promos')
  await dismissOverlays()
  await waitForExpr('Boolean(document.querySelector(".vq-promo-close"))', '运营位关闭键', 30, 200).catch(() => note('工作台首页没有出现 .vq-promo-close（运营位没渲染出来）'))

  // 1) 四个宽度下的 .vq-promo-close 尺寸
  for (const width of [1440, 760, 560, 390]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
    await sleep(320)
    const measured = await evaluate('(' + measurePromoClose.toString() + ')()')
    promo.closeSizes.push({ width: width, height: HEIGHT, measured: measured })
    console.log('PROMO-SIZE ' + width + ' × ' + HEIGHT + ' :: ' + JSON.stringify(measured))
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await sleep(320)

  // 2) 真按下 .vq-promo-close（按下后两帧）
  {
    const view = await evaluate('(' + bringIntoView.toString() + ')(".vq-promo-close")')
    if (view && !view.missing) {
      const neutral = await evaluate('(' + neutralPoint.toString() + ')()')
      if (neutral) await mouseTo(neutral.x, neutral.y)
      await sleep(80)
      const idle = await evaluate('(' + readState.toString() + ')(".vq-promo-close")')
      await mouseTo(view.cx, view.cy)
      await sleep(180)
      const hover = await evaluate('(' + readState.toString() + ')(".vq-promo-close")')
      await mouseDown(view.cx, view.cy)
      const pressed = await evaluate('new Promise(function (done) { requestAnimationFrame(function () { requestAnimationFrame(function () { done((' + readState.toString() + ')(".vq-promo-close")) }) }) })')
      const pick = (state) => state && !state.missing ? {
        active: state.active, hover: state.hover,
        backgroundColor: state.backgroundColor, borderColor: state.borderColor,
        color: state.color, transform: state.transform, boxShadow: state.boxShadow, opacity: state.opacity,
      } : { missing: true }
      promo.closePress = {
        rect: view,
        idle: pick(idle),
        hover: pick(hover),
        pressed: pick(pressed),
        pressActive: pressed && !pressed.missing ? Boolean(pressed.active) : null,
        changedVsHover: diffProps(hover, pressed),
        changedVsIdle: diffProps(idle, pressed),
        changedIdleToHover: diffProps(idle, hover),
        verdict: null,
      }
      promo.closePress.verdict = promo.closePress.changedVsHover.length ? 'has-feedback' : (promo.closePress.pressActive ? 'pressed-no-feedback' : 'active-not-matched')
      console.log('PROMO-CLOSE-PRESS :: ' + JSON.stringify({ active: promo.closePress.pressActive, changed: promo.closePress.changedVsHover.map((c) => c.prop), idle: promo.closePress.idle, pressed: promo.closePress.pressed }))
      if (promo.closePress.verdict === 'pressed-no-feedback') {
        promo.closePress.screenshot = await shotClip('promo-close-press.png', '.vq-promo-close')
      }
      if (neutral) await mouseTo(neutral.x, neutral.y)
      await mouseUp(neutral ? neutral.x : 3, neutral ? neutral.y : 3)
      await sleep(60)
    } else {
      promo.closePress = { missing: true, note: '.vq-promo-close 不在页面上，这一条量不到' }
    }
  }

  // 3) 真点 ✕ → 撤销条 .vq-promo-undo 的进场动画 + 400ms 后的 transform
  {
    const mark = cdp.requests.length
    await goto('/overview', '.vq-promos')
    await dismissOverlays()
    const before = await evaluate('({ promos: document.querySelectorAll(".vq-promo").length, undo: Boolean(document.querySelector(".vq-promo-undo")) })')
    await evaluate('(' + installPromoAnimProbe.toString() + ')()')
    const view = await evaluate('(' + bringIntoView.toString() + ')(".vq-promo-close")')
    if (view && !view.missing) {
      const clickPoint = { x: view.cx, y: view.cy }
      await clickAt(clickPoint.x, clickPoint.y, 70)
      await sleep(1200)
      const during = await evaluate('(' + readPromoAnimProbe.toString() + ')()')
      await sleep(400)
      const after = await evaluate('(' + readPromoAnimProbe.toString() + ')()')
      const stats = writeStatsFrom(mark)
      const samples = (during.samples || []).filter((sample) => sample.present)
      const firstTransform = samples.find((sample) => sample.transform && sample.transform !== 'none')
      promo.dismissUndo = {
        before: before,
        during: during,
        after400ms: after,
        writeRequests: stats.writes,
        writeCounts: stats.counts,
        apiCalls: stats.apiCalls,
        animationCount: (during.undoEvents || []).filter((event) => event.phase === 'start').length,
        animationNames: (during.undoEvents || []).filter((event) => event.phase === 'start').map((event) => event.name),
        firstNonNoneTransformSample: firstTransform || null,
        transformAt400ms: after.computed ? after.computed.transform : null,
        samplesWithTransform: samples.filter((sample) => sample.transform && sample.transform !== 'none').map((sample) => ({ t: sample.t, transform: sample.transform, animationName: sample.animationName })),
        samplesCount: samples.length,
      }
      console.log('PROMO-UNDO :: ' + JSON.stringify({ anims: promo.dismissUndo.animationNames, transform400: promo.dismissUndo.transformAt400ms, writes: stats.writes, clicks: during.clickAtMs }))
      if (stats.writes > 0) anomaly('promo-undo', '真点 ✕ 之后出现了后台写请求（应该只有 localStorage）', stats.counts)
      // 量完撤销回来，别把这一轮的状态留在页面上
      const undoBtn = await evaluate('(' + bringIntoView.toString() + ')(".vq-promo-undo-button")')
      if (undoBtn && !undoBtn.missing) {
        const markUndo = cdp.requests.length
        await clickAt(undoBtn.cx, undoBtn.cy, 90)
        await sleep(400)
        promo.dismissUndo.undoClick = { restored: await evaluate('document.querySelectorAll(".vq-promo").length'), writeRequests: writeStatsFrom(markUndo).writes }
        console.log('PROMO-UNDO-RESTORE :: ' + JSON.stringify(promo.dismissUndo.undoClick))
      } else {
        promo.dismissUndo.undoClick = { error: '撤销按钮没找到，运营位的关掉状态留在浏览器里（只影响本地存储）' }
      }
      promo.localKeys = await evaluate('(' + promoLocalKeys.toString() + ')()')
    } else {
      promo.dismissUndo = { error: '关掉前找不到 .vq-promo-close，这一条量不到' }
    }
  }

  }

  // ---- 逐趟巡检 ----
  const active = PASSES.filter((pass) => !ONLY.length || ONLY.indexOf(pass.id) >= 0)
  if (FOCUS_MODE) {
    // r336：同一批屏，走键盘而不是鼠标。Tab 走查只读：不发写请求、不点任何东西。
    for (const pass of active) {
      console.log('---- 趟（焦点）：' + pass.id + ' · ' + pass.label)
      await goto(pass.route, pass.ready || '.vq-content', pass.who || 'user')
      await dismissOverlays()
      const prepared = await preparePass(pass)
      if (!prepared) { console.log('FOCUS-ABORT ' + pass.id + ' :: 这一趟的入口没能打开（见 notes）'); continue }
      if (pass.prepare) await sleep(600)
      await focusWalk(pass.id, pass.label)
    }
  } else if (LINK_MODE) {
    // r337：同一批屏，量非按钮的可点表面（行 / 卡片 / 链接）。只划过：不点、不写。
    for (const pass of active) {
      console.log('---- 趟（划过·非按钮表面）：' + pass.id + ' · ' + pass.label)
      await goto(pass.route, pass.ready || '.vq-content', pass.who || 'user')
      await dismissOverlays()
      const prepared = await preparePass(pass)
      if (!prepared) { console.log('HOVER-ABORT ' + pass.id + ' :: 这一趟的入口没能打开（见 notes）'); continue }
      if (pass.prepare) await sleep(600)
      await hoverWalk(pass.id, pass.label, pass.scope)
    }
  } else {
    for (const pass of active.filter((item) => !item.focusOnly)) {
      console.log('---- 趟：' + pass.id + ' · ' + pass.label)
      const row = await runPass(pass)
      if (pass.id === 'admin-promos' && row.extra) promo.adminWeights = row.extra
    }
  }

  // ---- 版本面 ----
  await goto('/overview', '.vq-content')
  const bits = await evaluate('(function () { var list = Array.prototype.map.call(document.querySelectorAll("script[src]"), function (n) { return String(n.getAttribute("src")).split("/").pop() }).filter(function (n) { return n && n.indexOf("index-") === 0 }); var label = document.querySelector(".vq-version-label"); return { scripts: list, uiVersion: label ? String(label.textContent || "").trim() : null } })()')
  const apiVersion = await fetch(BASE + '/api/version').then((response) => response.json()).catch(() => null)
  note('入口与版本', { loaded: bits.scripts, dist: distEntry, api: apiVersion && apiVersion.version, distVersion: distPkgVersion })
} catch (error) {
  stopped = true
  anomaly('script', '巡检脚本自己崩了', String((error && error.stack) || error).slice(0, 600))
  if (serverLog) note('服务端日志尾部', serverLog.slice(-800))
}

// ---- 汇总 ----
const allWrites = cdp ? cdp.requests.map((row) => ({ method: row.method, path: pathOf(row.url) })).filter((row) => WRITE_METHODS.has(row.method) && row.path.indexOf('/api/') === 0) : []
const writeCounts = {}
for (const row of allWrites) writeCounts[row.method + ' ' + row.path] = (writeCounts[row.method + ' ' + row.path] || 0) + 1
const candidates = buttons.filter((row) => row.verdict === 'pressed-no-feedback')
const upstream = cdp ? cdp.requests.filter((row) => row.url.indexOf(BASE) !== 0 && /10100|seeapi|geteapi|redfox|api\.openai|generations|replicate/i.test(row.url)) : []

const out = {
  round: 'r331',
  script: 'scripts/audit-press.mjs',
  at: new Date().toISOString(),
  dist: DIST_DIR,
  entry: distEntry,
  distVersion: distPkgVersion,
  outDir: OUT_DIR,
  port: API_PORT,
  dataDir: dataDir,
  viewport: WIDTH + 'x' + HEIGHT + '（只查「有没有反应」，不换尺寸）',
  probe: {
    baseline: 'idle/hover：鼠标先移到元素中心，读 computed style + el.matches(:active)',
    pressed: 'mousePressed 同一坐标，两帧 rAF 后读同一批属性 + matches(:active)',
    props: PROPS.map((pair) => pair[1]).concat(AFTER_PROPS.map((pair) => pair[1])),
    release: '不在原地 mouseReleased —— 先挪到视口里的中性点再松，不合成 click',
    candidate: 'pressActive=true 且 changed 为空 = 按下无反馈候选',
    settled: '判定按上面两帧那一拍（与 r331 的数字可比）；还按着再等 200ms 读一次叫 pressedSettled / changedSettledVsHover，用来区分「真的没反应」和「过渡还没走到」（后者算采样抖动）',
    hardCut: '变了、但这条属性不在 computed transition-property 里（或 duration 0）= 硬切。读元素与 ::after 各一份过渡表，属性名按 PROPS / AFTER_PROPS 对齐；简写（background / border）也算覆盖',
    derivedBorder: 'r335：边框宽度全 0 时 computed border-color = currentColor，color 一变它必然跟着变，不是反馈。单列成 hoverDerived / derivedOnPress，不进 changed、不进硬切',
    hoverHardCut: 'r335：同一套判据用在 hover 上。rest（鼠标在中性点）→ hover（鼠标移到元素中心）之间变了的属性，同样去查过渡表；产物 hoverChangedVsRest / hoverHardCuts。按下那一层的数字与 r331–r334 完全可比（这一层只多读两行，不改按下口径）',
    focusRing: 'r336：--focus 单独一层。CDP 真发 Tab（rawKeyDown/keyUp，Tab 必须由浏览器自己处理这次按键才动焦点），每站读元素自己 + 最多三层祖先的 FOCUS_PROPS（outline 四件套 + box-shadow + border-color + background + color + transform + opacity + ::after），走完整条链再 blur 回「没有焦点」读同一批选择器当 rest 基线。判定：自己变了 = ring，只有祖先变 = delegated-ring（输入框把 UA 环按掉、由 :focus-within 的容器给提示），都没有 = no-visible-change（键盘焦点黑洞）。outline-style 是 none / 宽度 0 / 颜色全透明时，computed outline-color 等于 currentColor —— 与 r335 的 border-color 是同一条规则的另一半，单列 derived 不进判定。',
    focusTable: 'r336：焦点这一层读的是 FOCUS_PROPS，与按下/划过那三层的 PROPS 分开 —— 焦点会改 outline，并进 PROPS 会把 r331–r335 的读数改掉，层与层之间就不可比了',
    hoverSurface: 'r337：--links 单独一层。只划过、绝不按下（链接一按就跳页）。表面 = computed cursor 是 pointer、可见、面积 >= 8x8、不是 button/[role=button]/也不在按钮里；cursor 是继承属性，所以嵌套的只留最外层（划过一张卡片时手感落在卡片这张面上）。读的是元素自己 + 最多 12 个可见子孙（反馈常常画在子孙身上，如 .vq-project-card:hover .go svg），按位置对齐逐个比，挪位了算读不到。',
    hoverSurfaceTable: 'r337：这一层用 HOVER_PROPS = PROPS + text-decoration-line/-color。下划线是链接最经典的反馈，而 text-decoration-line 是离散属性（none ↔ underline 不补间）：算反馈，不进硬切。按钮读数一个字都不动（r331–r335 仍走 PROPS / AFTER_PROPS）。',
  },
  seeds: seeded,
  overlays: overlayLog,
  passes: passes,
  buttons: buttons,
  focus: { mode: FOCUS_MODE, cap: FOCUS_CAP, pages: focusPages },
  hoverSurfaces: { mode: LINK_MODE, cap: HOVER_CAP, pages: hoverPages },
  candidates: candidates.map((row) => ({ page: row.page, pageLabel: row.pageLabel, n: row.n, text: row.text, selector: row.selector, tag: row.tag, disabled: row.disabled, pressActive: row.pressActive, changed: [], screenshot: row.screenshot ? row.screenshot.file : null })),
  promo: promo,
  writeRequests: { total: allWrites.length, counts: writeCounts },
  upstreamCalls: upstream.length,
  upstreamUrls: upstream.slice(0, 3).map((row) => row.url),
  exceptions: cdp ? cdp.exceptions : [],
  consoleErrors: cdp ? cdp.consoleErrors : [],
  anomalies: anomalies,
  notes: notes,
  screenshots: shots,
  summary: {
    passes: passes.length,
    passesAborted: passes.filter((row) => row.aborted).length,
    buttonsMeasured: buttons.length,
    pressed: totalPressCount,
    hasFeedback: buttons.filter((row) => row.verdict === 'has-feedback').length,
    candidates: candidates.length,
    activeNotMatched: buttons.filter((row) => row.verdict === 'active-not-matched').length,
    disabled: buttons.filter((row) => row.verdict === 'disabled').length,
    readFailed: buttons.filter((row) => row.verdict === 'read-failed').length,
    // 两帧那一拍是空的、但还按着等过渡走完后确实变了：说明反馈在，只是采样早了（别把它算成回归）
    settledRescued: candidates.filter((row) => (row.changedSettledVsHover || []).length > 0).length,
    // 有反馈、但变化的那条属性没有过渡（或 duration 0）：按下去是硬切（r334）
    hardCuts: buttons.filter((row) => (row.hardCuts || []).length > 0).length,
    // r335：同一套账用在鼠标划过上（rest → hover）
    hoverWithFeedback: buttons.filter((row) => (row.hoverChangedVsRest || []).length > 0).length,
    hoverHardCuts: buttons.filter((row) => (row.hoverHardCuts || []).length > 0).length,
    hoverHardCutProps: buttons.reduce((sum, row) => sum + (row.hoverHardCuts || []).length, 0),
    // r335：边框宽度为 0 时 border-color 跟随 color 的连带变化（两条腿各算一次，纯记录，不进判定）
    derivedBorderChanges: buttons.reduce((sum, row) => sum + (row.hoverDerived || []).length + (row.derivedOnPress || []).length, 0),
    // r336：焦点那一层（--focus 才跑）
    focusPages: focusPages.length,
    focusStops: focusPages.reduce((sum, row) => sum + row.stops.length, 0),
    focusRings: focusPages.reduce((sum, row) => sum + row.rings, 0),
    focusDelegated: focusPages.reduce((sum, row) => sum + row.delegated, 0),
    focusNoVisibleChange: focusPages.reduce((sum, row) => sum + row.holes, 0),
    focusHardCuts: focusPages.reduce((sum, row) => sum + row.hardCutStops, 0),
    focusVisibleNotMatched: focusPages.reduce((sum, row) => sum + row.focusVisibleOffStops, 0),
    focusReadFailed: focusPages.reduce((sum, row) => sum + row.readFailedStops, 0),
    focusDerivedOutline: focusPages.reduce((sum, row) => sum + row.stops.reduce((n, item) => n + (item.derived || []).length, 0), 0),
    // 环「从无到有」（outline none ↔ auto）的那一下：平台行为，不进硬切，单列出来报数
    focusOutlineAppearances: focusPages.reduce((sum, row) => sum + row.outlineAppearances, 0),
    // r337：划过那一层扩到非按钮的可点表面（--links 才跑）
    hoverSurfacePages: hoverPages.length,
    hoverSurfaces: hoverPages.reduce((sum, row) => sum + row.surfaces.length, 0),
    hoverFeedback: hoverPages.reduce((sum, row) => sum + row.feedback, 0),
    hoverNoChange: hoverPages.reduce((sum, row) => sum + row.noChange, 0),
    // 名字带 Surface：按钮那一层的 hoverHardCuts 就在上面 20 行，重名会把那一层的数字悄悄盖掉（oxlint 抓到的）
    hoverSurfaceHardCuts: hoverPages.reduce((sum, row) => sum + row.hardCutSurfaces, 0),
    hoverDiscreteOnly: hoverPages.reduce((sum, row) => sum + row.discreteOnly, 0),
    hoverReadFailed: hoverPages.reduce((sum, row) => sum + row.readFailed, 0),
    writeRequests: allWrites.length,
    upstreamCalls: upstream.length,
    anomalies: anomalies.length,
  },
}
fs.writeFileSync(path.join(OUT_DIR, 'press.json'), JSON.stringify(out, null, 2))

function pad(text, width) {
  const value = String(text === null || text === undefined ? '-' : text)
  let visible = 0
  for (const char of value) visible += char.charCodeAt(0) > 255 ? 2 : 1
  return value + ' '.repeat(Math.max(0, width - visible))
}
console.log('')
console.log('---- 按钮逐行（' + buttons.length + ' 个）----')
console.log(pad('屏', 18) + pad('#', 4) + pad('文本', 22) + pad('判定', 22) + pad('active', 8) + pad('按下变化', 40) + '选择器')
console.log('-'.repeat(150))
for (const row of buttons) {
  console.log(
    pad(row.page, 18) + pad(row.n, 4) + pad(String(row.text).slice(0, 18), 22) + pad(row.verdict, 22) +
    pad(String(row.pressActive), 8) + pad(row.changed.map((c) => c.prop).join(',') || '无', 40) + row.selector,
  )
}
console.log('')
console.log('---- 无反馈候选（' + candidates.length + ' 个）----')
for (const row of candidates) {
  console.log(pad(row.page, 18) + pad(String(row.text).slice(0, 20), 22) + pad(row.selector, 60) + 'active=' + row.pressActive + ' changed=[]' + (row.screenshot ? ' 截图=' + row.screenshot.file : ''))
}
console.log('')
const hardCutRows = buttons.filter((row) => (row.hardCuts || []).length > 0)
console.log('---- 有反馈但还是硬切（' + hardCutRows.length + ' 个）----')
for (const row of hardCutRows) {
  console.log(pad(row.page, 18) + pad(String(row.text).slice(0, 18), 22) + pad(row.hardCuts.map((c) => c.prop + '@' + (c.declared ? c.duration : '不在过渡表里')).join(' '), 56) + row.selector)
}
console.log('')
const hoverHardCutRows = buttons.filter((row) => (row.hoverHardCuts || []).length > 0)
console.log('---- 划过有变化但还是硬切（' + hoverHardCutRows.length + ' 个）----')
for (const row of hoverHardCutRows) {
  console.log(pad(row.page, 18) + pad(String(row.text).slice(0, 18), 22) + pad(row.hoverHardCuts.map((c) => c.prop + '@' + (c.declared ? c.duration : '不在过渡表里')).join(' '), 56) + row.selector)
}
console.log('')
if (FOCUS_MODE) {
  const focusStops = focusPages.reduce((list, row) => list.concat(row.stops.map((item) => Object.assign({ page: row.id }, item))), [])
  const holeRows = focusStops.filter((item) => item.verdict === 'no-visible-change')
  const delegatedRows = focusStops.filter((item) => item.verdict === 'delegated-ring')
  const focusCutRows = focusStops.filter((item) => (item.hardCuts || []).length > 0)
  const focusVisibleOff = focusStops.filter((item) => (item.focusVisibleOff || []).length > 0)
  console.log('')
  console.log('---- 键盘焦点：Tab 到但看不出焦点在哪（' + holeRows.length + ' 个）----')
  for (const item of holeRows) console.log(pad(item.page, 18) + pad(String(item.text).slice(0, 16), 20) + pad(item.tag, 10) + pad(String(item.cls).slice(0, 40), 42) + item.selector)
  console.log('')
  console.log('---- 焦点环画在祖先身上（:focus-within 那一路，' + delegatedRows.length + ' 个）----')
  for (const item of delegatedRows) console.log(pad(item.page, 18) + pad(String(item.text).slice(0, 16), 20) + pad(String(item.cls).slice(0, 30), 32) + item.selector + ' → ' + item.ancestorChanged.map((row) => row.cls.slice(0, 30) + '[' + row.changed.join(',') + ']').join(' '))
  console.log('')
  console.log('---- 焦点有变化但还是硬切（' + focusCutRows.length + ' 个）----')
  for (const item of focusCutRows) console.log(pad(item.page, 18) + pad(String(item.text).slice(0, 16), 20) + pad(item.hardCuts.map((cut) => cut.prop + '@' + (cut.declared ? cut.duration : '不在过渡表里')).join(' '), 56) + item.selector)
  console.log('')
  console.log('---- 拿到焦点但 :focus-visible 没匹配（' + focusVisibleOff.length + ' 个）----')
  for (const item of focusVisibleOff) console.log(pad(item.page, 18) + pad(String(item.text).slice(0, 16), 20) + item.selector)
  console.log('')
  console.log('---- per 屏焦点走查 ----')
  for (const row of focusPages) console.log(pad(row.id, 18) + pad('Tab 到 ' + row.stops.length, 12) + pad('自己有环 ' + row.rings, 14) + pad('环在祖先 ' + row.delegated, 14) + pad('看不出焦点 ' + row.holes, 16) + pad('硬切 ' + row.hardCutStops, 10) + pad('读不到 ' + row.readFailedStops, 12) + (row.capReached ? '到上限 ' + row.cap : '') + (row.endedAtBody ? ' 第 ' + row.endedAtBody + ' 下回到 body' : '') + (row.cycled ? ' 第 ' + row.cycled + ' 下回到开头' : ''))
}
if (LINK_MODE) {
  const surfaces = hoverPages.reduce((list, row) => list.concat(row.surfaces.map((item) => Object.assign({ page: row.id }, item))), [])
  const blankRows = surfaces.filter((item) => item.verdict === 'hover-no-change')
  const cutRows = surfaces.filter((item) => (item.hardCuts || []).length > 0)
  const discreteRows = surfaces.filter((item) => (item.discrete || []).length > 0 && !(item.hardCuts || []).length)
  console.log('')
  console.log('---- 非按钮表面：划过看不出任何变化（' + blankRows.length + ' 张）----')
  for (const item of blankRows) console.log(pad(item.page, 16) + pad(String(item.text).slice(0, 18), 20) + pad(item.tag, 8) + pad(String(item.cls).slice(0, 34), 36) + item.selector)
  console.log('')
  console.log('---- 非按钮表面：划过有变化但还是硬切（' + cutRows.length + ' 张）----')
  for (const item of cutRows) console.log(pad(item.page, 16) + pad(String(item.text).slice(0, 16), 18) + pad(item.hardCuts.map((cut) => cut.where + ':' + cut.prop + '@' + (cut.declared ? cut.duration : '不在过渡表里')).join(' '), 62) + item.selector)
  console.log('')
  console.log('---- 非按钮表面：只有下划线（离散属性，不算硬切，' + discreteRows.length + ' 张）----')
  for (const item of discreteRows) console.log(pad(item.page, 16) + pad(String(item.text).slice(0, 18), 20) + pad(item.discrete.join(' '), 40) + item.selector)
  console.log('')
  console.log('---- per 屏划过走查 ----')
  for (const row of hoverPages) console.log(pad(row.id, 16) + pad('表面 ' + row.listed + '/' + row.total, 16) + pad('有反馈 ' + row.feedback, 12) + pad('看不出变化 ' + row.noChange, 16) + pad('硬切 ' + row.hardCutSurfaces, 10) + pad('只靠下划线 ' + row.discreteOnly, 16) + pad('读不到 ' + row.readFailed, 12) + (row.capReached ? '到上限 ' + row.cap : '') + (row.aborted || ''))
  console.log('')
}
console.log('---- 趟汇总 ----')
for (const row of passes) {
  console.log(pad(row.id, 18) + pad('可见可点 ' + row.total, 14) + pad('量了 ' + row.measured, 10) + pad('有反馈 ' + row.feedback, 12) + pad('候选 ' + row.noFeedback, 10) + pad('active没匹配 ' + row.activeNotMatched, 18) + pad('禁用 ' + row.disabled, 10) + pad('读不到 ' + row.readFailed, 12) + pad('写请求 ' + row.writeRequests, 12) + (row.aborted || ''))
}
console.log('')
console.log('---- 按下巡检 · ' + out.summary.buttonsMeasured + ' 个按钮 / ' + passes.length + ' 趟 · 无反馈候选 ' + candidates.length + ' · 按下硬切 ' + hardCutRows.length + ' · 划过硬切 ' + hoverHardCutRows.length + ' · 连带变化（边框宽 0 的 border-color）' + out.summary.derivedBorderChanges + ' · 写请求 ' + allWrites.length + ' · 上游 ' + upstream.length + ' · 证据 ' + path.join(path.relative(ROOT, OUT_DIR), 'press.json') + ' ----')
if (FOCUS_MODE) {
  console.log('---- 焦点巡检 · ' + out.summary.focusPages + ' 屏 / Tab 到 ' + out.summary.focusStops + ' 站 · 自己有环 ' + out.summary.focusRings + ' · 环在祖先 ' + out.summary.focusDelegated + ' · 看不出焦点 ' + out.summary.focusNoVisibleChange + ' · 焦点硬切 ' + out.summary.focusHardCuts + ' · derived（outline 没画出来时的 outline-color）' + out.summary.focusDerivedOutline + ' · 环从无到有（不算硬切）' + out.summary.focusOutlineAppearances + ' · :focus-visible 没匹配 ' + out.summary.focusVisibleNotMatched + ' · 读不到 ' + out.summary.focusReadFailed + ' · 写请求 ' + allWrites.length + ' · 上游 ' + upstream.length + ' · 证据 ' + path.join(path.relative(ROOT, OUT_DIR), 'press.json') + ' ----')
}

if (LINK_MODE) {
  console.log('---- 划过巡检（非按钮表面）· ' + out.summary.hoverSurfacePages + ' 屏 / 量了 ' + out.summary.hoverSurfaces + ' 张 · 有反馈 ' + out.summary.hoverFeedback + ' · 看不出变化 ' + out.summary.hoverNoChange + ' · 有反馈但硬切 ' + out.summary.hoverSurfaceHardCuts + ' · 只靠下划线 ' + out.summary.hoverDiscreteOnly + ' · 读不到 ' + out.summary.hoverReadFailed + ' · 写请求 ' + allWrites.length + ' · 上游 ' + upstream.length + ' · 证据 ' + path.join(path.relative(ROOT, OUT_DIR), 'press.json') + ' ----')
}
try { chrome.kill() } catch { /* 已经退出 */ }
try { server.kill() } catch { /* 已经退出 */ }
await sleep(400)
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
if (stopped) process.exit(1)
process.exit(0)
