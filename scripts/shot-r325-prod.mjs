// 生产真渲染（r325）：提示条的语气在**已发布产物**上的样子。
//
// 与 shot-r324-prod.mjs 同一套做法：生产侧临时签一个管理员会话（令牌只写 0600 文件 → scp 回本机 →
// 脚本从文件读、不打印），拍完立刻跑 revoke 收尾。全程**只发 GET**：
// 工作流页只在「图与已存的不一样」时才自动保存，这里不编辑、不保存、不新建，
// 只按一次 Ctrl+Z——历史在内存里，进页面时是空的，所以只会弹一句「没有可撤销的操作」，不落盘。
//
// 要证明：
//   1) 线上加载的就是这一版产物（入口文件名 + 侧栏版本号都是 0.9.297）；
//   2) 这条「什么也没发生」的提示现在是 info 语气：图标是 ⓘ 不是对勾、颜色是半透明白；
//   3) 图标形状与颜色都不再是一种：读到的 SVG path 不再是那条对勾；
//   4) 这条不打断读屏（status），图标对读屏隐藏（听到的是文案本身）；
//   5) r324 的时长与收尾没被这一轮碰坏：停留 ≈ 2.4s + 60ms×8 字、收尾 ≈ 180ms；
//   6) 1440 宽没有横向溢出、页面脚本报错 0。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SITE = process.env.LIVE_SITE || 'https://visionqa.wavisionai.cn'
const HOST = new URL(SITE).hostname
const TOKEN_FILE = process.env.LIVE_TOKEN_FILE || '.tmp-vq/prod-token'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const EXPECT_VERSION = process.env.SHOT_VERSION || JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const EXPECT_ENTRY = process.env.SHOT_ENTRY
  || (fs.readFileSync(path.join('dist', 'index.html'), 'utf8').match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1]
if (!EXPECT_ENTRY) throw new Error('读不出 dist/index.html 里的入口文件名')

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
if (!token) throw new Error('没有读到临时会话令牌')

const { config: cfg } = await import('../server/config.mjs')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot325-prod-'))
const DEBUG_PORT = 9338

// 只看不点的提示条探针：什么时候挂上、什么时候加 is-leaving、什么时候摘掉，外加一串透明度采样
const WATCH_SOURCE = [
  '(function () {',
  '  window.__toastLog = [];',
  '  window.__toastFade = [];',
  '  window.__toastAnimations = 0;',
  '  var now = function () { return Math.round(performance.now()) };',
  '  var rec = function (kind, el) {',
  '    window.__toastLog.push({ kind: kind, at: now(), text: String(el.textContent || "").trim(), cls: String(el.className || ""), opacity: Number(getComputedStyle(el).opacity) });',
  '  };',
  '  var sample = function (el) {',
  '    if (!el || !el.isConnected) return;',
  '    window.__toastFade.push({ at: now(), opacity: Number(getComputedStyle(el).opacity) });',
  '    if (window.__toastFade.length < 60) requestAnimationFrame(function () { sample(el) });',
  '  };',
  '  document.addEventListener("animationstart", function (event) {',
  '    var target = event.target;',
  '    if (target && target.classList && target.classList.contains("vq-toast")) window.__toastAnimations += 1;',
  '  }, true);',
  '  var attach = function () {',
  '    if (!document.body) { setTimeout(attach, 20); return; }',
  '    var seen = new WeakSet();',
  '    var observer = new MutationObserver(function (records) {',
  '      for (var i = 0; i < records.length; i += 1) {',
  '        var record = records[i];',
  '        if (record.type === "childList") {',
  '          Array.prototype.forEach.call(record.addedNodes, function (node) {',
  '            if (node.nodeType === 1 && node.classList && node.classList.contains("vq-toast") && !seen.has(node)) { seen.add(node); rec("added", node) }',
  '          });',
  '          Array.prototype.forEach.call(record.removedNodes, function (node) {',
  '            if (node.nodeType === 1 && node.classList && node.classList.contains("vq-toast")) rec("removed", node)',
  '          });',
  '        } else if (record.type === "attributes") {',
  '          var el = record.target;',
  '          if (el && el.classList && el.classList.contains("vq-toast")) {',
  '            rec("class", el);',
  '            if (el.classList.contains("is-leaving") && window.__toastFade.length === 0) sample(el);',
  '          }',
  '        }',
  '      }',
  '    });',
  '    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });',
  '  };',
  '  attach();',
  '})();',
].join('\n')

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
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result && result.exceptionDetails) throw new Error('页面里求值失败：' + JSON.stringify(result.exceptionDetails).slice(0, 300))
  return result?.result?.value
}

// 侧栏底部的账号行会把登录名显示出来（线上管理员的登录名就是手机号）：这是要进公开仓库的图，
// 拍照前把临时浏览器 DOM 里的 11 位手机号与邮箱换成占位符——只改浏览器里的渲染，不碰生产数据。
// 表达式写成多行模板字面量，并且断言返回值（SyntaxError 时 Runtime.evaluate 只回 undefined，脚本照跑）。
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
      const next = text.replace(phone, () => { phones += 1; return '138\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' }).replace(mail, () => { mails += 1; return 'masked@example.com' })
      if (next !== text) node.nodeValue = next
      node = walker.nextNode()
    }
    return { phones: phones, mails: mails }
  })()`)
  if (!result || typeof result.phones !== 'number') throw new Error('身份行遮盖没生效：' + JSON.stringify(result))
  return result
}

async function shoot(out) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB')
}

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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_SOURCE })

  // 1) 打开生产的工作流页（只读：进页面不会自动保存，图与已存的一样）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: HOST, path: '/', httpOnly: true, secure: true })
  await cdp.send('Page.navigate', { url: SITE + '/?shot=' + Date.now() + '&edition=admin#/canvas' })
  await sleep(6000)
  const guided = await evaluate("(() => { const el = document.querySelector('.vq-welcome, .vq-guide'); if (!el) return false; const btn = el.querySelector('button'); if (btn) btn.click(); return true })()")
  if (guided) await sleep(800)
  await waitFor(async () => await evaluate("Boolean(document.querySelector('.cv-toolbar'))"), '工作流画布', 80)

  // 2) 只按一次 Ctrl+Z：历史在内存里、进页面时是空的，所以只会弹「没有可撤销的操作」，不落盘
  await evaluate('window.__toastLog = []; window.__toastFade = []; window.__toastAnimations = 0; true')
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 })
  }
  await waitFor(async () => await evaluate('window.__toastLog.some(function (row) { return row.kind === "added" })'), '提示条挂上', 60)
  await sleep(150)

  // 3) 拍照前遮身份，并量一遍提示条与页面
  const masked = await maskIdentity()
  console.log('身份行遮盖：' + JSON.stringify(masked))
  const state = await evaluate(`(() => {
    const el = document.querySelector('.vq-toast')
    const rect = el ? el.getBoundingClientRect() : null
    const cs = el ? getComputedStyle(el) : null
    const textNode = el ? el.lastChild : null
    let lines = null
    if (textNode && textNode.nodeType === 3) {
      const range = document.createRange()
      range.selectNodeContents(textNode)
      lines = Array.prototype.filter.call(range.getClientRects(), (box) => box.height > 2).length
    }
    return {
      entries: [...document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src') || '').filter((src) => src.includes('index-')),
      versionLabel: ((document.querySelector('.vq-version-label') || {}).textContent || '').trim(),
      toolbar: Boolean(document.querySelector('.cv-toolbar')),
      toast: el ? String(el.textContent || '').trim() : null,
      tone: el ? el.getAttribute('data-tone') : null,
      role: el ? el.getAttribute('role') : null,
      markHidden: el && el.querySelector('.vq-toast-mark') ? el.querySelector('.vq-toast-mark').getAttribute('aria-hidden') : null,
      markColor: el && el.querySelector('.vq-toast-mark') ? getComputedStyle(el.querySelector('.vq-toast-mark')).color : null,
      iconPath: el && el.querySelector('.vq-toast-mark svg path') ? String(el.querySelector('.vq-toast-mark svg path').getAttribute('d') || '') : null,
      shots: window.__toastAnimations,
      opacity: cs ? Number(cs.opacity) : null,
      maxWidth: cs ? cs.maxWidth : null,
      bottom: cs ? cs.bottom : null,
      lines: lines,
      rect: rect ? { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), w: Math.round(rect.width) } : null,
      inViewport: rect ? rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight : false,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      innerWidth: window.innerWidth,
    }
  })()`)
  console.log('1440 生产提示条：' + JSON.stringify(state))
  await shoot(path.join('docs', 'r325-prod-toast-1440.png'))

  // 4) 等它走完，算停留与收尾
  await waitFor(async () => await evaluate('document.querySelectorAll(".vq-toast").length === 0'), '提示条卸载', 120)
  const log = await evaluate('window.__toastLog')
  const fade = await evaluate('window.__toastFade')
  const added = log.filter((row) => row.kind === 'added')
  const leaving = log.filter((row) => row.kind === 'class' && row.cls.includes('is-leaving'))
  const removed = log.filter((row) => row.kind === 'removed')
  const hold = leaving.length && added.length ? leaving[0].at - added[0].at : null
  const exitMs = removed.length && leaving.length ? removed[removed.length - 1].at - leaving[leaving.length - 1].at : null
  const midFrames = (fade || []).filter((row) => row.opacity > 0.05 && row.opacity < 0.95).length
  const expected = Math.min(6000, 2400 + String(state.toast || '').trim().length * 60)
  console.log('线上提示条时间线：' + JSON.stringify({ hold, exitMs, midFrames, expected, added: added.length, leaving: leaving.length, removed: removed.length, fade: (fade || []).slice(0, 6) }))

  if (!state.entries.some((src) => src.includes(EXPECT_ENTRY))) throw new Error('线上加载的不是这一版入口 ' + EXPECT_ENTRY + '：' + JSON.stringify(state.entries))
  if (!state.versionLabel.includes(EXPECT_VERSION)) throw new Error('侧栏没显示 v' + EXPECT_VERSION + '：' + state.versionLabel)
  if (!state.toolbar) throw new Error('工作流画布没渲染出来，没地方按 Ctrl+Z')
  if (state.toast !== '没有可撤销的操作') throw new Error('提示条文案不对：' + JSON.stringify(state.toast))
  if (state.tone !== 'info') throw new Error('这条「什么也没发生」的提示不是 info 语气：' + JSON.stringify(state.tone))
  if (state.role !== 'status') throw new Error('info 语气不该打断读屏：' + JSON.stringify(state.role))
  if (state.iconPath !== 'M12 16v-4') throw new Error('图标不是 ⓘ：' + JSON.stringify(state.iconPath))
  if (state.markColor !== 'rgba(255, 255, 255, 0.72)') throw new Error('info 图标颜色不对：' + JSON.stringify(state.markColor))
  if (state.markHidden !== 'true') throw new Error('图标没对读屏隐藏：' + JSON.stringify(state.markHidden))
  if (hold === null || Math.abs(hold - expected) > 300) throw new Error('停留时间与 2.4 秒 + 60ms×字数 对不上：' + hold + ' vs ' + expected)
  if (hold <= 2400) throw new Error('还是固定 2.4 秒：' + hold)
  if (exitMs === null || exitMs < 120 || exitMs > 320) throw new Error('收尾不是约 180ms 的过渡：' + exitMs)
  if (midFrames < 1) throw new Error('没采样到 0<opacity<1 的帧，收尾可能是硬切：' + midFrames)
  if (!state.inViewport) throw new Error('提示条不在视口内：' + JSON.stringify(state.rect))
  if (state.overflow > 1) throw new Error('1440 横向溢出：' + state.overflow)
  if (cdp.errors.length) throw new Error('页面抛异常：' + JSON.stringify(cdp.errors.slice(0, 3)))

  console.log('全部通过：info 语气、status 播报、图标对读屏隐藏；时长与收尾仍是 r324 那套；只按过一次 Ctrl+Z，没保存、没新建，生产数据未被修改')
} finally {
  if (cdp) cdp.close()
  try { chrome.kill() } catch { /* 已经退了 */ }
  await sleep(500)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
}
