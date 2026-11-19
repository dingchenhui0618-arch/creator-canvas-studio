// 运行记录页在手机与平板上的一条底线（r240）。
// 2026-11-19 量 390 / 768 / 1024 / 320（14 条样例运行 + 一条详情 + 对照弹层）：
// 12px 的字 50–62 处、不到 40px 的点按区 12 处；320 还量出三处真坏的地方：
// 输出的「字段 → 值」两列塌成竖排单字、翻页的「1–12 / 14」折成四行、
// 每行右侧 70px 的窄列把标题与版次挤成两段。
// 这一页只在 ≤1080 / ≤700 / ≤560 三段里改，桌面（1081 起）一条规则都不进。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const runsCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'runs.css'), 'utf8')
const tokensCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
const runsSource = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'RunsPage.tsx'), 'utf8')
const compareCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'run-compare.css'), 'utf8')

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

const band = mediaBlocks(runsCss, '(max-width: 1080px)', '.runs-page').at(-1)
const rowBand = mediaBlocks(runsCss, '(max-width: 700px)', '.runs-page .runs-row').at(-1)
const phone = mediaBlocks(runsCss, '(max-width: 560px)', '.runs-page').at(-1)

test('运行记录页的窄屏规则只在 ≤1080 / ≤700 / ≤560 三段里，根元素仍是 runs-page', () => {
  assert.ok(runsSource.includes('className="runs-page"'), '运行记录页根元素要还是 runs-page')
  assert.ok(band, 'runs.css 缺少 ≤1080 的运行记录页规则')
  assert.ok(rowBand, 'runs.css 缺少 ≤700 的行布局规则')
  assert.ok(phone, 'runs.css 缺少 ≤560 的运行记录页规则')
  const outside = runsCss.slice(0, runsCss.indexOf('@media (max-width: 1080px)'))
  assert.ok(!outside.includes('.runs-page .vq-mono'), '13px 的 mono 规则要在 ≤1080 里')
})

test('1080 以下：标签 / mono / 输出字段全部 13px', () => {
  const root = decls(band, '.runs-page')
  assert.match(root, /--btn-h:\s*40px/)
  assert.match(root, /--btn-h-sm:\s*40px/)
  assert.match(root, /--chip-font:\s*13px/)
  assert.match(root, /--text-mono:\s*13px/)
  // tokens.css 里 .vq-mono 的 12px 不吃 --text-mono，所以页面里单点抬
  assert.match(decls(band, '.runs-page .vq-mono'), /font-size:\s*13px/)
  for (const selector of [
    '.runs-page .runs-stats span',
    '.runs-page .runs-select > span',
    '.runs-page .runs-adopt-label',
    '.runs-page .runs-plan-label',
    '.runs-page .runs-output-list dt',
    '.runs-page .runs-output-raw',
    '.runs-page .runs-node-output',
  ]) {
    assert.match(decls(band, selector), /font-size:\s*13px/, selector + ' 要 13px')
  }
})

test('筛选下拉的选中值不被标签的 12px 压住（.runs-select span 打中过 .vq-select__value）', () => {
  assert.match(decls(band, '.runs-page .runs-select .vq-select__value'), /font-size:\s*13px/)
  // 基样式仍是标签的 12px：这一条只治窄屏，不把桌面的标签字号一起改了
  assert.match(firstRule(runsCss, '.runs-select span'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
})

test('1080 以下：搜索框 40px、「原始返回」撑到 40px 点按区', () => {
  assert.match(decls(band, '.runs-page .runs-search'), /height:\s*40px/)
  assert.match(decls(band, '.runs-page .runs-search input'), /height:\s*40px/)
  const summary = decls(band, '.runs-page .runs-output-raw summary')
  assert.match(summary, /min-height:\s*40px/)
  assert.match(summary, /padding:\s*8px 0/)
  assert.match(decls(band, '.runs-page .runs-pager .vq-mono'), /white-space:\s*nowrap/)
})

test('700 以下：状态与耗时挪到第二行，标题拿到整行宽度', () => {
  const row = decls(rowBand, '.runs-page .runs-row')
  assert.match(row, /grid-template-columns:\s*8px minmax\(0, 1fr\)/)
  assert.match(decls(rowBand, '.runs-page .runs-row-main'), /grid-column:\s*2/)
  const meta = decls(rowBand, '.runs-page .runs-row-meta')
  assert.match(meta, /grid-column:\s*2/)
  assert.match(meta, /flex-direction:\s*row/)
})

test('手机（560 以下）：按钮 44px，输出改成键在上、值在下', () => {
  const root = decls(phone, '.runs-page')
  assert.match(root, /--btn-h:\s*44px/)
  assert.match(root, /--btn-h-sm:\s*44px/)
  assert.match(decls(phone, '.runs-page .runs-search'), /height:\s*44px/)
  assert.match(decls(phone, '.runs-page .runs-search input'), /height:\s*44px/)
  assert.match(decls(phone, '.runs-page .runs-output-raw summary'), /min-height:\s*44px/)
  // 320 上键列 88px 会把值挤成一个字一行：单列才读得出来
  assert.match(decls(phone, '.runs-page .runs-output-list > div'), /grid-template-columns:\s*minmax\(0, 1fr\)/)
  assert.match(decls(phone, '.runs-page .runs-stats'), /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  // 24px 列间距在 320 会把「1–12 当前区间」折断，12px 才放得下
  assert.match(decls(phone, '.runs-page .runs-stats'), /gap:\s*8px 12px/)
  assert.match(decls(phone, '.runs-page .runs-stats strong'), /white-space:\s*nowrap/)
  const pager = decls(phone, '.runs-page .runs-pager')
  assert.match(pager, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(decls(phone, '.runs-page .runs-pager .vq-mono'), /grid-column:\s*1 \/ -1/)
})

test('新写的三段里没有比 13px 还小的字号', () => {
  for (const [label, block] of [['≤1080', band], ['≤700', rowBand], ['≤560', phone]]) {
    for (const rule of rulesOf(block)) {
      const match = rule.body.match(/font-size:\s*([\d.]+)px/)
      if (!match) continue
      assert.ok(Number(match[1]) >= 13, label + ' 还有 ' + match[1] + 'px：' + rule.selectors.join(','))
    }
  }
})

test('窄屏点一次运行要把详情滚到眼前（桌面两栏并排，不滚）', () => {
  assert.match(runsSource, /import \{ useCallback, useEffect, useRef, useState \} from 'react'/)
  assert.match(runsSource, /const detailRef = useRef<HTMLElement \| null>\(null\)/)
  const reveal = runsSource.slice(runsSource.indexOf('const revealDetail'), runsSource.indexOf('const revealDetail') + 700)
  assert.match(reveal, /matchMedia\('\(max-width: 1100px\)'\)\.matches/)
  assert.match(reveal, /prefers-reduced-motion: reduce/)
  assert.match(reveal, /scrollIntoView\(\{ block: 'start'/)
  assert.match(runsSource, /<section className="runs-detail" ref=\{detailRef\}>/)
  // 点行的那一处必须真的调它，否则 ref 与函数都白写
  const click = runsSource.slice(runsSource.indexOf('setOpen(item.id)'), runsSource.indexOf('setOpen(item.id)') + 200)
  assert.match(click, /revealDetail\(\)/)
})

test('运行对照弹层：关闭按钮与「看改了哪几行」在窄屏撑到 40 / 44px', () => {
  const wide = mediaBlocks(compareCss, '(max-width: 1080px)', '.rc-head .vq-button--icon').at(-1)
  const small = mediaBlocks(compareCss, '(max-width: 560px)', '.rc-head .vq-button--icon').at(-1)
  const close = decls(wide, '.rc-head .vq-button--icon')
  assert.match(close, /flex:\s*0 0 auto/)
  assert.match(close, /width:\s*40px/)
  assert.match(decls(wide, '.rc-diff-toggle'), /min-height:\s*40px/)
  assert.match(decls(small, '.rc-head .vq-button--icon'), /width:\s*44px/)
  assert.match(decls(small, '.rc-diff-toggle'), /min-height:\s*44px/)
})

test('桌面（1081 起）基样式一个像素没动', () => {
  assert.match(firstRule(tokensCss, '.vq-mono'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
  assert.match(firstRule(tokensCss, ':root'), /--btn-h:\s*32px/)
  assert.match(firstRule(tokensCss, ':root'), /--btn-h-sm:\s*28px/)
  assert.match(firstRule(runsCss, '.runs-stats span'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
  assert.match(firstRule(runsCss, '.runs-output-list dt'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
  assert.match(firstRule(runsCss, '.runs-node-output'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
  assert.match(firstRule(runsCss, '.runs-search'), /height:\s*34px/)
  assert.match(firstRule(runsCss, '.runs-row'), /grid-template-columns:\s*8px 1fr auto/)
  assert.match(firstRule(runsCss, '.runs-output-list > div'), /grid-template-columns:\s*minmax\(88px, 140px\)/)
})