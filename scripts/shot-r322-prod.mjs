// 生产真渲染（r322）：充值页上的运营位 + 关掉它的动效。
//
// 生产侧临时签一个管理员会话（令牌只写文件 0600 → scp 回本机 → 脚本从文件读、不打印 →
// 拍完跑 prod-shot-session-revoke-once.mjs 收尾）。只在无头浏览器里看：
// 只发 GET，不写任何生产数据（点关闭只动这个临时浏览器配置里的 localStorage）。
//
// 要证明三件事：
//   1) 生产充值页真的显示了运营位，而且就是 GET /api/promos 里 placement=recharge 的那条
//      （生产还没在后台存过运营位，所以这一条来自默认内容，正是用户现在会看到的）；
//   2) 关掉它时是真的「先塌下去、淡出、再移除」：中间态在 DOM 里且高度在变小、opacity 在走；
//   3) 移除那一刻下面那张卡（余额卡）不跳——位置差不大于 1px。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SITE = process.env.LIVE_SITE || 'https://visionqa.wavisionai.cn'
const HOST = new URL(SITE).hostname
const TOKEN_FILE = process.env.LIVE_TOKEN_FILE || '.tmp-vq/prod-token'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// 版本号只从 package.json 读：写死在脚本里的话，下一次 bump 就会变成假断言
const EXPECT_VERSION = process.env.SHOT_VERSION || JSON.parse(fs.readFileSync('package.json', 'utf8')).version

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
if (!token) throw new Error('没有读到临时会话令牌')

const { config: cfg } = await import('../server/config.mjs')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot322-prod-'))
const DEBUG_PORT = 9334

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

async function waitFor(check, label, tries = 100) {
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
// 侧栏底部的账号行会把登录名显示出来（线上管理员的登录名就是手机号）：这是要进公开仓库的图，
// 拍照前把临时浏览器 DOM 里的 11 位手机号与邮箱换成占位符——只改浏览器里的渲染，不碰生产数据。
// 表达式写成多行模板字面量，并且断言返回值：先前用「一行行 + 拼」的写法时，continue 后面直接
// 跟了 const（少了行末分号）——SyntaxError，而 Runtime.evaluate 只安安静静回一个 undefined，
// 脚本照跑、截图照拍、手机号照在，日志里只有一句「身份行遮盖：undefined」。拿不到数字就抛。
async function maskIdentity() {
  const result = await evaluate(`(() => {
    const phone = new RegExp('1[3-9][0-9]{9}', 'g')
    const mail = new RegExp('[A-Za-z0-9._+-]+@[A-Za-z0-9-]+[.][A-Za-z0-9.]+', 'g')
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    let phones = 0
    let mails = 0
    while (node) {
      const text = node.nodeValue || ''
      const next = text.replace(phone, () => { phones += 1; return '138••••••••' }).replace(mail, () => { mails += 1; return 'masked@example.com' })
      if (next !== text) node.nodeValue = next
      node = walker.nextNode()
    }
    return { phones: phones, mails: mails }
  })()`)
  if (!result || typeof result.phones !== 'number') throw new Error('身份行遮盖没生效：' + JSON.stringify(result))
  return result
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result?.result?.value
}

async function open({ width, height, hash = '#/recharge' }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: HOST, path: '/', httpOnly: true, secure: true })
  await cdp.send('Page.navigate', { url: SITE + '/?shot=' + Date.now() + hash })
  await sleep(4500)
  const guided = await evaluate("(() => { const el = document.querySelector('.vq-welcome, .vq-guide'); if (!el) return false; const btn = el.querySelector('button'); if (btn) btn.click(); return true })()")
  if (guided) await sleep(500)
  // 提示条是 React 管的节点：只隐藏，别删（r319 删过一次，React 抛 removeChild 把整页卸成白屏）
  await evaluate("(() => { const style = document.createElement('style'); style.textContent = '.vq-toast{display:none !important}'; document.head.appendChild(style); window.scrollTo(0, 0); return true })()")
  console.log('身份行遮盖：' + JSON.stringify(await maskIdentity()))
}

async function waitForCount(selector, n, label, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const count = await evaluate('document.querySelectorAll(' + JSON.stringify(selector) + ').length')
    if (Number(count) >= n) return count
    await sleep(300)
  }
  throw new Error('等不到 ' + label + '（要 ' + n + ' 个）')
}

async function shoot(out) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB')
}

try {
  // 1) 生产接口先回一次：页面上那条是不是接口给的，靠这个比
  const api = await fetch(SITE + '/api/promos', { headers: { cookie: cfg.auth.cookieName + '=' + token } }).then((r) => r.json())
  const recharge = (api.promos || []).filter((item) => item.placement === 'recharge')
  console.log('生产 /api/promos：' + JSON.stringify({ slots: (api.promos || []).length, recharge: recharge.map((item) => ({ id: item.id, title: item.title, cta: item.cta })) }))
  if (recharge.length !== 1) throw new Error('生产的充值位不是一条：' + JSON.stringify(recharge.map((item) => item.id)))
  const expected = recharge[0]

  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')

  // 2) 1440 生产充值页：那条运营位在，内容与接口一致
  await open({ width: 1440, height: 1000 })
  await waitForCount('.vq-promos[data-placement="recharge"] .vq-promo', 1, '生产充值页运营位')
  const state = await evaluate("(() => { const slot = document.querySelector('.vq-promos[data-placement=\"recharge\"]'); const card = slot ? slot.querySelector('.vq-promo') : null; const ver = (document.querySelector('.vq-side-version, .vq-version') || {}).textContent || ''; return { title: document.title, slotClass: slot ? slot.className : '', titles: [...document.querySelectorAll('.vq-promos[data-placement=\"recharge\"] .vq-promo-title')].map((el) => el.textContent), cta: [...document.querySelectorAll('.vq-promos[data-placement=\"recharge\"] .vq-promo-cta')].map((el) => el.textContent.trim()), body: card ? card.querySelector('.vq-promo-body').textContent : '', kicker: card ? card.querySelector('.vq-promo-kicker').textContent : '', count: slot ? slot.querySelectorAll('.vq-promo').length : 0, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, version: ver.trim() } })()")
  console.log('1440 生产充值页：' + JSON.stringify(state))
  if (state.titles.length !== 1 || state.titles[0] !== expected.title) throw new Error('页面上的运营位不是接口给的那条：' + JSON.stringify(state.titles) + ' vs ' + expected.title)
  if (state.body !== expected.body) throw new Error('正文与接口不一致：' + JSON.stringify(state.body))
  if (!state.cta[0] || !state.cta[0].includes(expected.cta)) throw new Error('按钮与接口不一致：' + JSON.stringify(state.cta))
  if (!String(state.slotClass).includes('vq-stagger')) throw new Error('生产上运营位没走逐条进场：' + state.slotClass)
  if (state.overflow > 1) throw new Error('1440 横向溢出：' + state.overflow)
  if (!String(state.version).includes(EXPECT_VERSION)) throw new Error('侧栏没显示 v' + EXPECT_VERSION + '：' + state.version)
  await shoot(path.join('docs', 'r322-prod-recharge-default-1440.png'))

  // 3) 关掉它：中间态 + 淡出 + 移除那一刻下面那张卡不跳
  const probe = await evaluate(`(async () => {
    const slot = document.querySelector('.vq-promos[data-placement="recharge"]')
    const art = slot ? slot.querySelector('.vq-promo') : null
    const below = document.querySelector('.rg-balance')
    if (!art) return { ok: false, reason: 'no-card' }
    if (!below) return { ok: false, reason: 'no-below' }
    const before = art.offsetHeight
    const belowBefore = Math.round(below.getBoundingClientRect().top * 100) / 100
    const btn = art.querySelector('.vq-promo-close')
    if (!btn) return { ok: false, reason: 'no-close' }
    const t0 = performance.now()
    btn.click()
    const curve = []
    const sample = (ms) => new Promise((resolve) => setTimeout(() => {
      const live = art.isConnected
      const cs = live ? getComputedStyle(art) : null
      curve.push({
        ms: Math.round(performance.now() - t0),
        connected: live,
        height: live ? Math.round(art.offsetHeight) : 0,
        opacity: live && cs ? Number(cs.opacity) : null,
        belowTop: Math.round(below.getBoundingClientRect().top * 100) / 100,
      })
      resolve(curve[curve.length - 1])
    }, Math.max(0, ms - (performance.now() - t0))))
    for (let ms = 25; ms <= 500; ms += 25) await sample(ms)
    await sample(700)
    const live = curve.filter((row) => row.connected)
    const lastLive = live[live.length - 1] || null
    const firstGone = curve.find((row) => !row.connected) || null
    return {
      ok: true,
      before,
      belowBefore,
      curve,
      mid: live.find((row) => row.ms >= 100 && row.ms <= 150) || null,
      shrinking: live.filter((row) => row.height > 0 && row.height < before).length,
      minOpacity: live.reduce((min, row) => Math.min(min, row.opacity === null ? 1 : row.opacity), 1),
      lastLive,
      firstGone,
      at700: curve[curve.length - 1],
      dismissed: window.localStorage.getItem('vq_promos_dismissed'),
    }
  })()`)
  console.log('生产塌陷曲线（点后 ms:高度/透明度）：' + probe.curve.map((row) => row.ms + ':' + (row.connected ? row.height + '/' + row.opacity : 'gone')).join(' '))
  if (!probe.ok) throw new Error('关闭取证没跑起来：' + probe.reason)
  if (!(probe.before > 0)) throw new Error('点击前没量到高度')
  if (!probe.mid || !probe.mid.connected) throw new Error('100–150ms 时卡片已经不在 DOM（是一步消失）')
  if (!(probe.mid.height > 0) || !(probe.mid.height < probe.before * 0.9)) throw new Error('100–150ms 时高度没明显变小：' + JSON.stringify(probe.mid))
  if (probe.shrinking < 2) throw new Error('没有采到连续的塌陷中间态：' + probe.shrinking)
  if (!(probe.minOpacity < 0.5)) throw new Error('透明度没在走（淡出没生效）：' + probe.minOpacity)
  if (!probe.lastLive || probe.lastLive.height > 2) throw new Error('移除前高度还没收干净：' + JSON.stringify(probe.lastLive))
  if (!probe.firstGone) throw new Error('700ms 内没移除')
  // 下面那张卡在「卡片收拢过程中」必须是连续的：相邻两次采样（25ms）之间不能出现台阶。
  // 移除那一刻的最后一跳（运营位区整体消失：区外边距 24 + 页面栅格间距 16 = 40px）是**已知**的，
  // 这一屏只剩一条运营位时才会遇到，它没有说话算（见 docs/r322-promo-recharge-2026-11-26.md 的边界一节）：
  // 要让这 40px 也平滑，只能让空区块继续占位，代价是页面上永远留 16px 空隙，不划算。
  // 只看「相邻两步之差」是不够的：缓动本来就在开头走得最快（--ease-out 在 10% 处已经走了三分之一），
  // 25ms 一档完全可能采到 30px 以上的位移，那是动画快，不是台阶。
  // 真正要证的是「下面那张卡的位置，任何时候都能由卡片当前高度解释」——它不该自己动。
  const live = probe.curve.filter((row) => row.connected)
  const expectAt = (row) => probe.belowBefore - (probe.before - row.height)
  const drift = live.map((row) => Math.abs(row.belowTop - expectAt(row)))
  const maxDrift = drift.length ? Math.max(...drift) : 0
  const finalStep = Math.abs(probe.firstGone.belowTop - probe.lastLive.belowTop)
  console.log('生产移除前后：卡片 ' + probe.before + 'px → ' + probe.lastLive.height + 'px · opacity 最小 ' + probe.minOpacity + ' · 收拢过程中下面那张卡最大偏离「卡片高度解释的位置」 ' + maxDrift.toFixed(2) + 'px（' + live.length + ' 个采样）· 整段共上移 ' + (probe.belowBefore - probe.lastLive.belowTop).toFixed(2) + 'px · 移除那一刻的最后一跳 ' + finalStep.toFixed(2) + 'px · 700ms 时 ' + probe.at700.belowTop)
  if (maxDrift > 3) throw new Error('收拢过程中下面那张卡自己动了（偏离卡片高度解释的位置 ' + maxDrift.toFixed(2) + 'px）')
  if (probe.belowBefore - probe.lastLive.belowTop < 100) throw new Error('下面那张卡几乎没动，这条断言没意义：' + JSON.stringify({ before: probe.belowBefore, last: probe.lastLive.belowTop }))
  // 最后一跳是「运营位区整体消失」：区外边距 24 + 页面栅格间距 16 = 40。这里是**已知并记录**的边界，
  // 所以断言它就等于这个数（哪天把它做平滑了，这条会红，正好提醒回来改文档）。
  if (Math.abs(finalStep - 40) > 2) throw new Error('移除那一刻的最后一跳不是已知的 40px：' + finalStep.toFixed(2))
  if (Math.abs(probe.at700.belowTop - probe.firstGone.belowTop) > 1) throw new Error('移除之后下面那张卡位置又变了')
  if (!JSON.parse(probe.dismissed || '[]').length) throw new Error('关掉后本地没记下来')

  console.log('页面报错：' + (cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'none'))
  if (cdp.errors.length) throw new Error('生产页面上抛异常了：' + cdp.errors[0])
} finally {
  cdp?.close()
  chrome.kill()
  await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* Windows 句柄收得慢 */ }
}
