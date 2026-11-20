// 设置页在手机与平板上的一条底线（r238）。
// 2026-11-19 量 390 / 768：这一页的小字停在 11.5–12.5px（卡头 mono、Tag/Pill、口令说明、
// 会话 IP、流水表头、价格标签、反馈时间、健康行），点按区停在 28–32px（按钮、图标按钮、
// 口令输入、帮助链接）。这里锁住抬上去的档位，以及「桌面（1081 起）一个像素没动」。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const settingsCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'settings.css'), 'utf8')
const creditsCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'credits.css'), 'utf8')
const shellCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'shell.css'), 'utf8')
const tokensCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
const settingsSource = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'SettingsPage.tsx'), 'utf8')

/** 取一段 @media 块（按花括号配对），可选再加一层「必须包含某个选择器」的过滤。 */
function mediaBlocks(css, query, mustContain) {
  const out = []
  let from = 0
  for (;;) {
    const start = css.indexOf('@media ' + query, from)
    if (start < 0) break
    let depth = 0
    const open = css.indexOf('{', start)
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      if (css[index] === '}') {
        depth -= 1
        if (depth === 0) {
          out.push(css.slice(open + 1, index))
          from = index + 1
          break
        }
      }
    }
    if (from <= start) break
  }
  return mustContain ? out.filter((block) => block.includes(mustContain)) : out
}

/** 把一段（没有嵌套 @media 的）规则拆成 { selectors, body }；组选择器按逗号拆开。 */
function rulesOf(block) {
  const out = []
  let index = 0
  while (index < block.length) {
    const open = block.indexOf('{', index)
    if (open < 0) break
    const close = block.indexOf('}', open)
    if (close < 0) break
    const head = block.slice(index, open).replace(/\/\*[\s\S]*?\*\//g, '').trim()
    const selectors = head.split(',').map((item) => item.trim()).filter(Boolean)
    out.push({ selectors, body: block.slice(open + 1, close) })
    index = close + 1
  }
  return out
}

/** 取某条选择器的声明体；组选择器里出现过就算命中。 */
function decls(block, selector) {
  assert.ok(block, '缺少这一段 @media')
  const hit = rulesOf(block).find((rule) => rule.selectors.includes(selector))
  assert.ok(hit, '缺少规则：' + selector)
  return hit.body
}

/** 文件里第一处同名规则（= 基样式，媒体查询里的覆盖都在后面）。 */
function firstRule(css, selector) {
  for (const suffix of [' {', ',']) {
    const index = css.indexOf(selector + suffix)
    if (index < 0) continue
    const open = css.indexOf('{', index)
    const close = css.indexOf('}', open)
    assert.ok(open > 0 && close > open, '缺少基样式：' + selector)
    return css.slice(open + 1, close)
  }
  assert.fail('缺少基样式：' + selector)
}

const band = mediaBlocks(settingsCss, '(max-width: 1080px)', '.vq-page--settings').at(-1)
const phone = mediaBlocks(settingsCss, '(max-width: 560px)', '.vq-page--settings').at(-1)

test('设置页根元素带 vq-page--settings，样式在 credits.css 之后加载', () => {
  assert.ok(settingsSource.includes('vq-page vq-page--settings'), '设置页根元素要带 vq-page--settings')
  const shellAt = settingsSource.indexOf("import '../styles/shell.css'")
  const creditsAt = settingsSource.indexOf("import '../styles/credits.css'")
  const settingsAt = settingsSource.indexOf("import '../styles/settings.css'")
  assert.ok(shellAt >= 0 && creditsAt >= 0 && settingsAt >= 0, '三个样式都要引入')
  assert.ok(settingsAt > creditsAt && creditsAt > shellAt, 'settings.css 要排在 credits.css 之后')
  assert.ok(band, 'settings.css 缺少 ≤1080 的规则')
  assert.ok(phone, 'settings.css 缺少 ≤560 的规则')
})

test('1080 以下：按钮两个档位 40px，胶囊与标签 14px', () => {
  const root = decls(band, '.vq-page--settings')
  assert.match(root, /--btn-h:\s*40px/)
  assert.match(root, /--btn-h-sm:\s*40px/)
  assert.match(root, /--chip-font:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-mono'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-tag'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-pill'), /font-size:\s*14px/)
})

test('1080 以下：表单与说明性小字都到 14px', () => {
  assert.match(decls(band, '.vq-page--settings .vq-field > span'), /font-size:\s*14px/)
  const input = decls(band, '.vq-page--settings .vq-input')
  assert.match(input, /height:\s*40px/)
  assert.match(input, /font-size:\s*15px/)
  assert.match(decls(band, '.vq-page--settings .vq-password-note'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-2fa-note'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-session-note'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-session-main small'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-session-ip'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-session-expire'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-ledger th'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-price-item span'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-feedback-row-time'), /font-size:\s*14px/)
  assert.match(decls(band, '.vq-page--settings .vq-health-row strong'), /font-size:\s*14px/)
})

test('1080 以下：帮助链接撑到 40px 点按区', () => {
  const link = decls(band, '.vq-page--settings .vq-help-link')
  assert.match(link, /display:\s*inline-flex/)
  assert.match(link, /align-items:\s*center/)
  assert.match(link, /min-height:\s*40px/)
})

test('手机（560 以下）：按钮与输入框 44px', () => {
  const root = decls(phone, '.vq-page--settings')
  assert.match(root, /--btn-h:\s*44px/)
  assert.match(root, /--btn-h-sm:\s*44px/)
  assert.match(decls(phone, '.vq-page--settings .vq-button--icon'), /width:\s*44px/)
  assert.match(decls(phone, '.vq-page--settings .vq-input'), /height:\s*44px/)
  assert.match(decls(phone, '.vq-page--settings .vq-help-link'), /min-height:\s*44px/)
})

test('新写的两段里没有比 14px 还小的字号', () => {
  for (const [label, block] of [['≤1080', band], ['≤560', phone]]) {
    for (const rule of rulesOf(block)) {
      const match = rule.body.match(/font-size:\s*([\d.]+)px/)
      if (!match) continue
      assert.ok(Number(match[1]) >= 13, label + ' 还有 ' + match[1] + 'px：' + rule.selectors.join(','))
    }
  }
})

test('桌面（1081 起）基样式一个像素没动', () => {
  assert.match(firstRule(creditsCss, '.vq-input'), /height:\s*32px/)
  assert.match(firstRule(creditsCss, '.vq-ledger td.time'), /font-size:\s*(?:11\.5px|var\(--text-2xs\))/)
  assert.match(firstRule(creditsCss, '.vq-price-item span'), /font-size:\s*(?:11\.5px|var\(--text-2xs\))/)
  assert.match(firstRule(creditsCss, '.vq-plan-note'), /font-size:\s*(?:11\.5px|var\(--text-2xs\))/)
  assert.match(firstRule(shellCss, '.vq-2fa-note'), /font-size:\s*(?:11\.5px|var\(--text-2xs\))/)
  assert.match(firstRule(shellCss, '.vq-session-ip'), /font-size:\s*(?:11\.5px|var\(--text-2xs\))/)
  assert.match(firstRule(shellCss, '.vq-button'), /height:\s*var\(--btn-h\)/)
  assert.match(firstRule(shellCss, '.vq-help-link'), /padding:\s*4px 12px/)
  assert.match(firstRule(tokensCss, ':root'), /--btn-h:\s*32px/)
  assert.match(firstRule(tokensCss, ':root'), /--chip-font:\s*14px/)
})
