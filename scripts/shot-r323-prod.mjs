// 生产真渲染（r323）：后台「系统 → 运营位」编辑卡在**已发布产物**上的样子。
//
// 与 shot-r322-prod.mjs 同一套做法：生产侧临时签一个管理员会话（令牌只写 0600 文件 → scp 回本机 →
// 脚本从文件读、不打印），拍完立刻跑 revoke 收尾。全程**只发 GET**：
// 不点保存、不点恢复默认、不在任何输入框里打字——生产上的运营位内容一个字都不改。
// （交互那四条由本地 scripts/shot-r323.mjs 在同一个产物上真点真量，这里只证「线上这份跑起来是对的」。）
//
// 要证明：
//   1) 线上加载的就是这一版产物（入口文件名 + 后台版本卡里都是 0.9.295）；
//   2) 运营位卡在线上渲染出来了，第 1 行的标题与 GET /api/promos 里权重最高的那条逐字一致；
//   3) 实时预览停在「第 1 条 · <位置>」、预览标题 = 第 1 行标题（r323 之前这里只会永远显示第 1 条，
//      所以真正要看的是「它是活的」——见 2) 的接口比对：只要两者一致，说明预览对的是真数据）；
//   4) 没动过的卡上不该出现「有未保存的改动」；1440 宽没有横向溢出；页面脚本报错 0。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.SHOT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SITE = process.env.LIVE_SITE || 'https://visionqa.wavisionai.cn'
const HOST = new URL(SITE).hostname
const TOKEN_FILE = process.env.LIVE_TOKEN_FILE || '.tmp-vq/prod-token'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// 版本与入口都只从本地产物读：写死的话下一次 bump 就变成假断言
const EXPECT_VERSION = process.env.SHOT_VERSION || JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const EXPECT_ENTRY = process.env.SHOT_ENTRY
  || (fs.readFileSync(path.join('dist', 'index.html'), 'utf8').match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1]
if (!EXPECT_ENTRY) throw new Error('读不出 dist/index.html 里的入口文件名')

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
if (!token) throw new Error('没有读到临时会话令牌')

const { config: cfg } = await import('../server/config.mjs')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shot323-prod-'))
const DEBUG_PORT = 9336

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

async function shoot(out) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('✔ ' + path.basename(out) + ' · ' + Math.round(fs.statSync(out).size / 1024) + ' KB')
}

try {
  // 1) 生产接口先回一次：页面上第 1 行是不是接口里权重最高的那条，靠这个比
  const api = await fetch(SITE + '/api/promos', { headers: { cookie: cfg.auth.cookieName + '=' + token } }).then((r) => r.json())
  const promos = api.promos || []
  if (!promos.length) throw new Error('生产 /api/promos 是空的')
  const top = [...promos].sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))[0]
  console.log('生产 /api/promos：' + JSON.stringify({ source: api.source, slots: promos.length, top: { id: top.id, title: top.title, placement: top.placement } }))

  const target = await waitFor(async () => {
    const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then((r) => r.json())
    return (Array.isArray(list) ? list : []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  }, 'Chrome 调试端口')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')

  // 2) 后台「系统」页的管理员会话 + 运营位卡
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Network.setCookie', { name: cfg.auth.cookieName, value: token, domain: HOST, path: '/', httpOnly: true, secure: true })
  await cdp.send('Page.navigate', { url: SITE + '/?shot=' + Date.now() + '&edition=admin#/admin/system' })
  await sleep(5000)
  const guided = await evaluate("(() => { const el = document.querySelector('.vq-welcome, .vq-guide'); if (!el) return false; const btn = el.querySelector('button'); if (btn) btn.click(); return true })()")
  if (guided) await sleep(600)
  await evaluate("(() => { const style = document.createElement('style'); style.textContent = '.vq-toast{display:none !important}'; document.head.appendChild(style); return true })()")
  await waitFor(async () => await evaluate("!!document.querySelector('.admin-promo-preview')"), '运营位编辑卡', 60)
  // 后台这一屏上还有别的卡片（复刻任务里是生产上别人的任务标题与邮箱、邮件/短信卡里是管理员的邮箱），
  // 它们都不该出现在要进公开仓库的图里。这里把运营位卡之外的兄弟卡整块隐藏，
  // 「上次保存」那行也一并隐掉（source=admin 时它会带管理员的邮箱）——只留运营位卡本身。
  await evaluate(`(() => {
    const card = document.querySelector('.admin-promo-preview').closest('section')
    const parent = card.parentElement
    const hidden = []
    for (const el of parent.querySelectorAll(':scope > section')) {
      if (el !== card) { el.style.display = 'none'; hidden.push(el.querySelector('.admin-label') ? el.querySelector('.admin-label').textContent : '(无标题)') }
    }
    for (const el of card.querySelectorAll('.admin-cell-sub')) {
      if (el.textContent.trim().startsWith('上次保存')) el.style.display = 'none'
    }
    return hidden
  })()`)
  await evaluate("(() => { const el = document.querySelector('.admin-promo-preview'); if (el) el.scrollIntoView({ block: 'end' }); return true })()")
  console.log('身份行遮盖：' + JSON.stringify(await maskIdentity()))
  await sleep(600)

  // 3) 只读地量一遍
  const state = await evaluate(`(() => {
    const card = document.querySelector('.admin-promo-preview').closest('section')
    const head = document.querySelector('.admin-promo-preview-head')
    const fieldValue = (row, label) => {
      const field = [...row.querySelectorAll('label.vq-field')].find((item) => (item.querySelector('span') || {}).textContent === label)
      const input = field ? field.querySelector('input') : null
      return input ? input.value : ''
    }
    const row1 = document.querySelector('.admin-promo-row')
    const actions = document.querySelector('.admin-promo-actions')
    return {
      entries: [...document.querySelectorAll('script[src]')].map((el) => (el.getAttribute('src') || '')).filter((src) => src.includes('index-')),
      versionLabel: ((document.querySelector('.vq-version-label') || {}).textContent || '').trim(),
      rows: document.querySelectorAll('.admin-promo-row').length,
      cardLabel: ((card || {}).querySelector ? card.querySelector('.admin-label').textContent : ''),
      pills: card ? [...card.querySelectorAll('.vq-pill')].map((el) => el.textContent.trim()) : [],
      // 只读左边那句；右边还有一句「改哪条就预览哪条」的提示，整块 textContent 会把它带进来
      previewHead: head ? ((head.querySelector('.admin-cell-sub') || {}).textContent || '') : '',
      previewTitle: ((document.querySelector('.admin-promo-preview .vq-promo-title') || {}).textContent || ''),
      previewCta: ((document.querySelector('.admin-promo-preview .vq-promo-cta') || {}).textContent || '').trim(),
      row1Title: row1 ? fieldValue(row1, '标题') : '',
      row1Id: row1 ? fieldValue(row1, 'ID') : '',
      // 位置下拉里选中的那一项：把接口里的 placement 值接到页面上显示的位置名，
      // 不用在脚本里写死一份「值 → 中文名」的对照表
      row1Placement: (() => {
        const field = row1 ? [...row1.querySelectorAll('label.vq-field')].find((item) => (item.querySelector('span') || {}).textContent === '位置') : null
        const select = field ? field.querySelector('select') : null
        if (!select) return { value: '', label: '' }
        const option = select.options[select.selectedIndex]
        return { value: select.value, label: option ? option.textContent : '' }
      })(),
      actionsText: actions ? actions.textContent : '',
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      previewRect: (() => { const el = document.querySelector('.admin-promo-preview'); const rect = el.getBoundingClientRect(); return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) } })(),
      innerHeight: window.innerHeight,
    }
  })()`)
  console.log('1440 生产后台运营位卡：' + JSON.stringify(state))

  const wantHead = '实时预览 · 第 1 条 · ' + state.row1Placement.label
  if (!state.entries.some((src) => src.includes(EXPECT_ENTRY))) throw new Error('线上加载的不是这一版入口 ' + EXPECT_ENTRY + '：' + JSON.stringify(state.entries))
  if (!state.versionLabel.includes(EXPECT_VERSION)) throw new Error('侧栏没显示 v' + EXPECT_VERSION + '：' + state.versionLabel)
  if (state.rows < 1) throw new Error('运营位卡上一行都没有：' + state.rows)
  if (state.row1Placement.value !== top.placement) throw new Error('第 1 行的位置与接口里权重最高的那条不一致：' + JSON.stringify(state.row1Placement) + ' vs ' + top.placement)
  if (state.previewHead.trim() !== wantHead) throw new Error('预览头不是「' + wantHead + '」：' + JSON.stringify(state.previewHead))
  if (state.previewTitle !== top.title) throw new Error('预览标题与接口里权重最高的那条不一致：' + JSON.stringify(state.previewTitle) + ' vs ' + JSON.stringify(top.title))
  if (state.row1Title !== top.title) throw new Error('第 1 行的标题与接口不一致：' + JSON.stringify(state.row1Title) + ' vs ' + JSON.stringify(top.title))
  if (state.actionsText.includes('有未保存的改动')) throw new Error('没动过的卡上出现了「有未保存的改动」')
  if (state.overflow > 1) throw new Error('1440 横向溢出：' + state.overflow)
  if (state.previewRect.top < 0 || state.previewRect.bottom > state.innerHeight) throw new Error('预览卡不在视口内，图会拍不到：' + JSON.stringify(state.previewRect))
  if (cdp.errors.length) throw new Error('页面抛异常：' + JSON.stringify(cdp.errors.slice(0, 3)))

  await shoot(path.join('docs', 'r323-prod-promo-editor-1440.png'))
  console.log('全部通过：页面脚本报错 0；只发过 GET，生产运营位内容未被修改')
} finally {
  if (cdp) cdp.close()
  try { chrome.kill() } catch { /* 已经退了 */ }
  await sleep(500)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
}
