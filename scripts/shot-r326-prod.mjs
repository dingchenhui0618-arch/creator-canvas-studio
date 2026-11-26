// 生产真渲染（r326）：运营位「整卡可点」与「关掉能撤」在**已发布产物**上的样子。
//
// 与 shot-r325-prod.mjs 同一套做法：生产侧临时签一个管理员会话（令牌只写 0600 文件 → scp 回本机 →
// 脚本从文件读、不打印），拍完立刻跑 revoke 收尾。全程只发 GET：
//   - 卡片正文上按下/抬起各一次（这一下会跳到那条运营位指的那一页，只是导航）
//   - 点一次 ✕（关掉只写这台临时浏览器的 localStorage，不碰生产数据）
//   - 点一次「撤销」（把它还原，临时 profile 用完就删）
//
// 要证明：
//   1) 线上加载的就是这一版产物（入口文件名 + 侧栏版本号）；
//   2) 按住不放时热区还在（::after 没被按下时的 1px 位移换成「按钮自己」的包含块），
//      松开之后真的跳到了那条运营位指的那一页；
//   3) 关掉之后条子出现、文案是「已关掉「…」」、用 status 播报；撤销之后卡片回到原位、本地记录清空；
//   4) 交互期间没有任何写请求（只有 GET）；
//   5) 图里的身份行已遮（侧栏底部是登录名=手机号；同页其它内容不进这张图：只截运营位那一块）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SITE = process.env.LIVE_SITE || 'https://visionqa.wavisionai.cn'
const HOST = new URL(SITE).hostname
const TOKEN_FILE = process.env.LIVE_TOKEN_FILE || '.tmp-vq/prod-token-r326'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const EXPECT_VERSION = process.env.SHOT_VERSION || JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const EXPECT_ENTRY = process.env.SHOT_ENTRY
  || (fs.readFileSync(path.join('dist', 'index.html'), 'utf8').match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1]
if (!EXPECT_ENTRY) throw new Error('读不出 dist/index.html 里的入口文件名')

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
if (!token) throw new Error('没有读到临时会话令牌')

const { config: cfg } = await import('../server/config.mjs')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot326-prod-'))
const DEBUG_PORT = Number(process.env.LIVE_DEBUG_PORT || 9342)

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
    this.requests = []
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params && message.params.exceptionDetails ? message.params.exceptionDetails.text : 'exception')
      if (message.method === 'Network.requestWillBeSent') {
        const request = message.params && message.params.request
        if (request) this.requests.push({ method: String(request.method || ''), url: String(request.url || '') })
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
  const result = await cdp.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true })
  if (result && result.exceptionDetails) throw new Error('页面里求值失败：' + JSON.stringify(result.exceptionDetails).slice(0, 300))
  return result && result.result ? result.result.value : undefined
}
async function moveTo(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none' })
  await sleep(150)
}

// 这张图要进公开仓库。侧栏底部会显示登录名（线上管理员与普通账号都是手机号）：
// 拍照前把临时浏览器 DOM 里的 11 位手机号与邮箱换成占位符——只改渲染，不碰生产数据。
// 并且断言返回值：Runtime.evaluate 语法错时只回 undefined，脚本会照跑下去。
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
      const next = text.replace(phone, () => { phones += 1; return '138\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' }).replace(mail, () => { mails += 1; return '[EMAIL:PROD]' })
      if (next !== text) node.nodeValue = next
      node = walker.nextNode()
    }
    return { phones: phones, mails: mails }
  })()`)
  if (!result || typeof result.phones !== 'number' || typeof result.mails !== 'number') {
    throw new Error('身份遮盖没生效：' + JSON.stringify(result))
  }
  return result
}

async function shootClip(out) {
  // 只截运营位那一块：首屏其余区域是生产上别人的数据（作品、待评审队列），不进公开仓库的图。
  const slot = await evaluate(`(() => {
    const el = document.querySelector('.vq-promos')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: Math.round(r.left + window.scrollX), t: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  if (!slot) throw new Error('页面上没有运营位，截不了图')
  const clip = {
    x: Math.max(0, slot.l - 24),
    y: Math.max(0, slot.t - 24),
    width: slot.w + 48,
    height: slot.h + 48,
    scale: 1,
  }
  const captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: clip })
  fs.writeFileSync(out, Buffer.from(captured.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB · clip ' + JSON.stringify(clip))
  return clip
}

const CLIP_PROBE = '(() => { const el = document.querySelector(".vq-promos"); if (!el) return null; const cards = [...document.querySelectorAll(".vq-promo")]; const bar = document.querySelector(".vq-promo-undo"); const label = document.querySelector(".vq-promo-undo-text"); const first = cards[0] || null; const copy = first ? first.querySelector(".vq-promo-copy") : null; const cta = first ? first.querySelector(".vq-promo-cta") : null; const cr = copy ? copy.getBoundingClientRect() : null; const hit = cr ? document.elementFromPoint(Math.round(cr.left + cr.width / 2), Math.round(cr.top + cr.height / 2)) : null; return { cards: cards.map((card) => card.getAttribute("data-promo-id")), bar: bar ? String(label ? label.textContent : "").trim() : null, barRole: label ? label.getAttribute("role") : null, hotAtCopy: hit ? (hit.closest(".vq-promo-cta") ? "cta" : "other") : null, ctaTransform: cta ? getComputedStyle(cta).transform : null, dismissed: (function () { try { return JSON.parse(window.localStorage.getItem("vq_promos_dismissed") || "[]") } catch (e) { return "bad" } })(), hash: window.location.hash, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth } })()'

try {
  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: HOST, path: '/', httpOnly: true, secure: true })
  await cdp.send('Page.navigate', { url: SITE + '/?shot=' + Date.now() + '&edition=admin#/overview' })
  await sleep(6000)
  // 上手引导遮罩会挡住第一张卡片，先真点关掉（r323 踩过：不关掉，点到的全是遮罩）
  const guided = await evaluate("(() => { const el = document.querySelector('.vq-welcome, .vq-guide'); if (!el) return false; const btn = el.querySelector('button'); if (btn) btn.click(); return true })()")
  if (guided) await sleep(900)
  await waitFor(async () => await evaluate("document.querySelectorAll('.vq-promo').length >= 1"), '运营位渲染出来', 80)

  const initial = await evaluate(CLIP_PROBE)
  console.log('线上运营位：' + JSON.stringify(initial))
  const firstId = initial.cards[0]
  console.log('第一条的按钮文字：' + JSON.stringify(await evaluate("(() => { const card = document.querySelector('.vq-promo'); const cta = card.querySelector('.vq-promo-cta'); return cta ? cta.textContent.trim() : null })()")))

  // 交互开始：从这一刻起数写请求
  const requestMark = cdp.requests.length

  // 1) 按住不放：热区必须还在（r326 的根因就在这一步），松开之后要跳页
  const copyRect = await evaluate("(() => { const el = document.querySelector('.vq-promo .vq-promo-copy'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()")
  await moveTo(copyRect.x, copyRect.y)
  await sleep(250)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: copyRect.x, y: copyRect.y, button: 'left', clickCount: 1 })
  await sleep(250)
  const pressed = await evaluate(CLIP_PROBE)
  console.log('按住不放时：' + JSON.stringify({ hotAtCopy: pressed.hotAtCopy, ctaTransform: pressed.ctaTransform }))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: copyRect.x, y: copyRect.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  const afterCardClick = await evaluate('window.location.hash')
  console.log('松开之后地址：' + afterCardClick)

  // 2) 回工作台，点 ✕ 关掉一条 → 条子出现
  await cdp.send('Page.navigate', { url: SITE + '/?shot=' + Date.now() + '&edition=admin#/overview' })
  await sleep(5000)
  await waitFor(async () => await evaluate("document.querySelectorAll('.vq-promo').length >= 1"), '回工作台还有运营位', 80)
  const closeRect = await evaluate("(() => { const el = document.querySelector('.vq-promo .vq-promo-close'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()")
  await moveTo(closeRect.x, closeRect.y)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: closeRect.x, y: closeRect.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: closeRect.x, y: closeRect.y, button: 'left', clickCount: 1 })
  await sleep(900)
  const closed = await waitFor(async () => {
    const state = await evaluate(CLIP_PROBE)
    return state && state.bar ? state : null
  }, '撤销条出现', 60)
  console.log('关掉之后：' + JSON.stringify(closed))

  // 3) 拍照前遮身份，再截运营位那一块
  const masked = await maskIdentity()
  console.log('身份行遮盖：' + JSON.stringify(masked))
  const clip = await shootClip(path.join('docs', 'r326-prod-promo-undo-1440.png'))

  // 4) 撤销：卡片回到原位、本地记录清空（临时 profile 用完就删）
  const undoRect = await evaluate("(() => { const el = document.querySelector('.vq-promo-undo-button'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()")
  if (!undoRect) throw new Error('撤销按钮不在，撤不了')
  await moveTo(undoRect.x, undoRect.y)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: undoRect.x, y: undoRect.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: undoRect.x, y: undoRect.y, button: 'left', clickCount: 1 })
  await sleep(900)
  const afterUndo = await evaluate(CLIP_PROBE)
  console.log('撤销之后：' + JSON.stringify({ cards: afterUndo.cards, bar: afterUndo.bar, dismissed: afterUndo.dismissed }))

  const writes = cdp.requests.slice(requestMark).filter((row) => row.method !== 'GET' && row.url.indexOf('/api/') >= 0)
  console.log('交互期间的写请求：' + JSON.stringify(writes))

  if (!(initial.cards || []).length) throw new Error('线上工作台没有运营位，无法取证')
  if (pressed.hotAtCopy !== 'cta') throw new Error('按住不放时热区不在了（r326 那个「点了没反应」又回来了）：' + pressed.hotAtCopy)
  if (pressed.ctaTransform !== 'none') throw new Error('按下时 CTA 仍带 transform，热区会被缩成按钮那么大：' + pressed.ctaTransform)
  if (!afterCardClick || afterCardClick === '#/overview') throw new Error('点卡片正文没有跳页：' + afterCardClick)
  if (!/^已关掉「.+」$/.test(String(closed.bar || ''))) throw new Error('撤销条文案不对：' + JSON.stringify(closed.bar))
  if (closed.barRole !== 'status') throw new Error('撤销条不是用 status 播报：' + JSON.stringify(closed.barRole))
  if (!Array.isArray(closed.dismissed) || closed.dismissed.indexOf(firstId) < 0) throw new Error('关掉没写进本地：' + JSON.stringify(closed.dismissed))
  if (afterUndo.cards.indexOf(firstId) < 0) throw new Error('撤销之后第一条没回来：' + JSON.stringify(afterUndo.cards))
  if (afterUndo.bar !== null) throw new Error('撤销之后条子还在：' + JSON.stringify(afterUndo.bar))
  if (Array.isArray(afterUndo.dismissed) && afterUndo.dismissed.length) throw new Error('撤销之后本地记录没清空：' + JSON.stringify(afterUndo.dismissed))
  if (writes.length) throw new Error('交互期间出现了写请求，生产数据可能被改：' + JSON.stringify(writes.slice(0, 3)))
  if (masked.phones + masked.mails < 1) throw new Error('身份行没遮到任何东西（侧栏应该显示登录名）：' + JSON.stringify(masked))
  const entries = await evaluate("[...document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src') || '').filter((src) => src.includes('index-'))")
  const versionLabel = await evaluate("((document.querySelector('.vq-version-label') || {}).textContent || '').trim()")
  console.log('入口与版本：' + JSON.stringify({ entries: entries, versionLabel: versionLabel }))
  if (!entries.some((src) => src.indexOf(EXPECT_ENTRY) >= 0)) throw new Error('线上加载的不是这一版入口 ' + EXPECT_ENTRY + '：' + JSON.stringify(entries))
  if (versionLabel.indexOf(EXPECT_VERSION) < 0) throw new Error('侧栏没显示 v' + EXPECT_VERSION + '：' + versionLabel)
  if (cdp.errors.length) throw new Error('页面抛异常：' + JSON.stringify(cdp.errors.slice(0, 3)))

  console.log('全部通过：按住不放热区仍在、点正文真的跳页；关掉有「已关掉「…」· 撤销」、status 播报，撤销后卡片回到原位；交互期间 0 个写请求；图只截运营位那一块（' + clip.width + '×' + clip.height + '）')
} finally {
  if (cdp) cdp.close()
  try { chrome.kill() } catch { /* 已经退了 */ }
  await sleep(500)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
}
