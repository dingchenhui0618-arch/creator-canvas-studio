// 快捷创作页在手机与平板上的一条底线（r241 / v0.9.225）。
// 2026-11-19 量 390 / 768 / 1024 / 320，四个状态（平台对话 / 对话预设 + 历史弹层 / 图片 / 视频）：
// 12px 与 11.5px 的元信息 5–30 处、不到 40px 的点按区 11–26 处；
// 顺带量出三处真问题：预设分类条在 390 宽的内容列里要 397px 而容器只有 290px（最后两个分类够不着）、
// 历史弹层挂在左边按钮上、right: 0 把 352px 的弹层推到屏幕外（390 左边缘 −187px）、
// 对话数为 0 时左栏在「新对话」和「历史对话」之间孤零零显示一个「0」。
// 这一页只在 ≤1080 / ≤560 两段里改，桌面（1081 起）一条规则都不进。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const agentsCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'agents.css'), 'utf8')
const pageSource = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'AgentsPage.tsx'), 'utf8')
const chatSource = fs.readFileSync(path.join(ROOT, 'src', 'components', 'QuickChat.tsx'), 'utf8')

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

/** 取某条选择器的全部声明体（同一段里可能先有一条组规则、后面再补一条）。 */
function decls(block, selector) {
  assert.ok(block, '缺少这一段 @media')
  const hits = rulesOf(block).filter((rule) => rule.selectors.includes(selector))
  assert.ok(hits.length, '缺少规则：' + selector)
  return hits.map((rule) => rule.body).join(' ')
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

const band = mediaBlocks(agentsCss, '(max-width: 1080px)', '.agx-page').at(-1)
const phone = mediaBlocks(agentsCss, '(max-width: 560px)', '.agx-page').at(-1)

test('快捷创作的窄屏规则只在 ≤1080 / ≤560 两段里，根元素仍是 agx-page', () => {
  assert.ok(pageSource.includes('page agx-page'), '快捷创作页根元素要还是 agx-page')
  assert.ok(band, 'agents.css 缺少 ≤1080 的快捷创作页规则')
  assert.ok(phone, 'agents.css 缺少 ≤560 的快捷创作页规则')
  const outside = agentsCss.slice(0, agentsCss.indexOf('@media (max-width: 1080px)', agentsCss.length - 12000))
  assert.ok(!outside.includes('.agx-page .agx-mono'), '13px 的 mono 规则要在 ≤1080 里')
})

test('1080 以下：小字统一 13px（mono / 标签 / 计数 / 胶囊）', () => {
  const root = decls(band, '.agx-page')
  assert.match(root, /--btn-h:\s*40px/)
  assert.match(root, /--btn-h-sm:\s*40px/)
  assert.match(root, /--chip-font:\s*13px/)
  assert.match(root, /--text-mono:\s*13px/)
  // .agx-mono 的 12px 写死在 agents.css 里，不吃 --text-mono，所以要逐个点名
  for (const selector of [
    '.agx-page .agx-mono',
    '.agx-page .agx-library-meta',
    '.agx-page .agx-tabs em',
    '.agx-page .agx-card-current',
    '.agx-page .agx-msg-meta',
    '.agx-page .agx-credit-line',
    '.agx-page .qc-count',
    '.agx-page .qc-credit',
    '.agx-page .qc-tool',
    '.agx-page .qc-preview-head',
  ]) {
    assert.match(decls(band, selector), /font-size:\s*13px/, selector + ' 要 13px')
  }
  assert.match(decls(band, '.agx-page .agx-capsule > span'), /font-size:\s*13px/)
  assert.match(decls(band, '.agx-page .agx-capsule-trigger em'), /font-size:\s*13px/)
  assert.match(decls(band, '.agx-page .agx-surface-note'), /font-size:\s*13px/)
  assert.match(decls(band, '.agx-page .agx-surface-switch button'), /font-size:\s*13px/)
})

test('1080 以下：28–32px 的点按区抬到 40px', () => {
  assert.match(decls(band, '.agx-page .agx-mode-tabs button'), /min-height:\s*40px/)
  assert.match(decls(band, '.agx-page .agx-surface-switch button'), /min-height:\s*40px/)
  assert.match(decls(band, '.agx-page .agx-tabs button'), /min-height:\s*40px/)
  assert.match(decls(band, '.agx-page .agx-popover-tabs button'), /height:\s*40px/)
  assert.match(decls(band, '.agx-page .agx-send'), /width:\s*40px/)
  assert.match(decls(band, '.agx-page .qc-new'), /min-height:\s*40px/)
  assert.match(decls(band, '.agx-page .qc-side-toggle'), /min-height:\s*40px/)
  assert.match(decls(band, '.agx-page .qc-tool'), /height:\s*40px/)
  assert.match(decls(band, '.agx-page .agx-capsule-trigger'), /min-width:\s*40px/)
})

test('胶囊写 42 / 46：它自带 1px 边框，里面那枚按钮只有 height−2（写 40 就只剩 38）', () => {
  assert.match(decls(band, '.agx-page .agx-capsule'), /height:\s*42px/)
  assert.match(decls(phone, '.agx-page .agx-capsule'), /height:\s*46px/)
  assert.match(decls(phone, '.agx-page .agx-capsule-trigger'), /min-width:\s*44px/)
})

test('560 以下：同一批点按区再抬到 44px', () => {
  const root = decls(phone, '.agx-page')
  assert.match(root, /--btn-h:\s*44px/)
  assert.match(root, /--btn-h-sm:\s*44px/)
  for (const selector of [
    '.agx-page .agx-mode-tabs button',
    '.agx-page .agx-surface-switch button',
    '.agx-page .agx-tabs button',
    '.agx-page .agx-popover-tabs button',
    '.agx-page .qc-new',
    '.agx-page .qc-side-toggle',
    '.agx-page .qc-tool',
  ]) {
    const body = decls(phone, selector)
    assert.match(body, /(min-)?height:\s*44px/, selector + ' 要 44px')
  }
  assert.match(decls(phone, '.agx-page .agx-send'), /width:\s*44px/)
})

test('560 以下：预设分类条换行，不再靠横向滚动藏住最后两个分类', () => {
  // nav.css 的 .vq-content .agx-tabs 是 nowrap + overflow-x:auto（0,2,0），这里要盖过它
  const tabs = decls(phone, '.vq-content .agx-page .agx-tabs')
  assert.match(tabs, /flex-wrap:\s*wrap/)
  assert.match(tabs, /overflow-x:\s*visible/)
  // 换行后下划线会浮在第一行按钮底下，激活态换成胶囊底色
  assert.match(decls(phone, '.vq-content .agx-page .agx-tabs button'), /border-radius:\s*var\(--radius-pill\)/)
  assert.match(decls(phone, '.vq-content .agx-page .agx-tabs button.is-active::after'), /display:\s*none/)
})

test('历史弹层：窄屏贴底浮层，不再 absolute right:0 跑到屏幕外', () => {
  const popover = decls(band, '.agx-page .agx-popover')
  assert.match(popover, /position:\s*fixed/)
  assert.match(popover, /left:\s*8px/)
  assert.match(popover, /right:\s*8px/)
  assert.match(popover, /bottom:\s*8px/)
  assert.match(popover, /max-height:\s*70vh/)
  // 桌面基样式仍是挂在按钮右边的 352px 绝对定位弹层
  const base = firstRule(agentsCss, '.agx-popover')
  assert.match(base, /position:\s*absolute/)
  assert.match(base, /right:\s*0/)
  assert.match(base, /width:\s*352px/)
})

test('左栏不再在「新对话」和「历史对话」之间孤零零显示一个 0', () => {
  assert.match(chatSource, /items\.length > 0 \? <span className="qc-count">共 \{items\.length\} 个<\/span> : null/)
})

test('新增的窄屏规则里没有小于 13px 的字', () => {
  for (const [name, block] of [['≤1080', band], ['≤560', phone]]) {
    for (const rule of rulesOf(block)) {
      const match = rule.body.match(/font-size:\s*([\d.]+)px/)
      if (!match) continue
      assert.ok(Number(match[1]) >= 13, name + ' 里 ' + rule.selectors.join(',') + ' 是 ' + match[1] + 'px')
    }
  }
})

test('桌面基线没被改：12 / 11.5px 与 28 / 30 / 32px 仍是原值', () => {
  assert.match(firstRule(agentsCss, '.agx-mono'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
  assert.match(firstRule(agentsCss, '.agx-capsule'), /height:\s*30px/)
  assert.match(firstRule(agentsCss, '.agx-capsule > span'), /font-size:\s*(?:11\.5px|var\(--text-2xs\))/)
  assert.match(firstRule(agentsCss, '.agx-capsule-trigger em'), /font-size:\s*(?:12\.5px|var\(--text-2xs\))/)
  assert.match(firstRule(agentsCss, '.agx-mode-tabs button'), /min-height:\s*28px/)
  assert.match(firstRule(agentsCss, '.agx-surface-switch button'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
  assert.match(firstRule(agentsCss, '.agx-surface-note'), /font-size:\s*(?:11px|var\(--text-2xs\))/)
  assert.match(firstRule(agentsCss, '.agx-tabs button'), /padding:\s*0 0 12px/)
  assert.match(firstRule(agentsCss, '.agx-popover-tabs button'), /height:\s*24px/)
  assert.match(firstRule(agentsCss, '.qc-new'), /min-height:\s*32px/)
  assert.match(firstRule(agentsCss, '.qc-tool'), /height:\s*28px/)
})
