// 无限画布（外部那张自由画布）状态条在手机与平板上的一条底线（r243 / v0.9.227）。
// 2026-11-19 量 320 / 360 / 375 / 390 / 768 / 1024 / 1440 三态（默认、出图排队中、写笔记弹层打开）：
// 状态条本身只有 42px 高、按钮 24px、字 12px。768 上整条内容 780px 挤进 672px 的格子，
// 整页被撑到 912px 横向滚动；1024 也差 20px，「新窗口」图标键被弹性收缩压成 16×32；
// 手机上「最久 12.4s」把排队位胶囊顶出状态条右边缘，写笔记弹层按 100vw 算宽度顶出 30px。
// 这一页只在 ≤1080 / ≤560 两段里改，桌面（1081 起）一条规则都不进。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const boardCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'board.css'), 'utf8')
const pageSource = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'BoardPage.tsx'), 'utf8')

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

/** 选择器是否被写进了这一段（不要求它带自己的声明体）。 */
function has(block, selector) {
  return rulesOf(block).some((rule) => rule.selectors.includes(selector))
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

const band = mediaBlocks(boardCss, '(max-width: 1080px)', '.bd-strip').at(-1)
const phone = mediaBlocks(boardCss, '(max-width: 560px)', '.bd-strip').at(-1)
// ≤760 那条把状态条按钮收成方块（只留图标），宽度必须自己在 761 那一段之后补回来
const block760 = mediaBlocks(boardCss, '(max-width: 760px)', 'width: 40px').at(-1)

test('无限画布状态条的窄屏规则只在 ≤1080 / ≤560 两段里，加在文件末尾', () => {
  assert.ok(band, 'board.css 缺少 ≤1080 的状态条规则')
  assert.ok(phone, 'board.css 缺少 ≤560 的状态条规则')
  const firstBand = boardCss.indexOf('@media (max-width: 1080px)')
  assert.ok(firstBand > boardCss.indexOf('.bd-centre-actions'), '新增的 ≤1080 段要排在基础样式之后')
  assert.ok(boardCss.indexOf('@media (max-width: 560px)') > firstBand, '≤560 段要跟在 ≤1080 后面')
})

test('1080 以下：状态条允许换行，宽度不再溢出到整页', () => {
  const strip = decls(band, '.bd-strip')
  assert.match(strip, /flex-wrap:\s*wrap/)
  assert.match(strip, /height:\s*auto/)
  assert.match(strip, /min-height:\s*52px/)
  assert.match(strip, /row-gap:\s*var\(--space-2\)|gap:\s*var\(--space-1\) var\(--space-2\)/)
})

test('1080 以下：让位的那几处（页面名 / 分隔线 / 选择器标签 / 画布域名）', () => {
  for (const selector of ['.bd-label', '.bd-sep', '.bd-picker-label', '.bd-url']) {
    assert.ok(has(band, selector), selector + ' 要在 ≤1080 的让位名单里')
    assert.match(decls(band, selector), /display:\s*none/, selector + ' 要被收起')
  }
})

test('1080 以下：12px 的字抬到 13px，点按区 24 → 40px', () => {
  for (const selector of ['.bd-state', '.bd-queue', '.bd-note-hint']) {
    assert.match(decls(band, selector), /font-size:\s*13px/, selector + ' 要抬到 13px')
  }
  assert.match(decls(band, '.bd-action'), /height:\s*40px/)
  assert.match(decls(band, '.bd-action'), /padding:\s*0 var\(--space-3\)/)
  // 弹性收缩会把「新窗口」图标键压成 16×32：显式给宽度并禁止收缩
  const icon = decls(band, '.bd-strip .vq-button--icon')
  assert.match(icon, /width:\s*40px/)
  assert.match(icon, /height:\s*40px/)
  assert.match(icon, /flex:\s*0 0 auto/)
})

test('排队位胶囊与写笔记弹层不再顶出状态条', () => {
  const queue = decls(band, '.bd-queue')
  assert.match(queue, /max-width:\s*100%/)
  assert.match(queue, /min-width:\s*0/)
  // 弹层宽度按状态条自己算：原来 min(340px, 100vw - 48px) 在 390 上右边缘顶出 30px
  assert.match(decls(phone, '.bd-note'), /width:\s*min\(340px, calc\(100% - var\(--space-6\)\)\)/)
  assert.match(decls(phone, '.bd-queue-oldest'), /display:\s*none/)
  assert.match(decls(phone, '.bd-picker'), /flex:\s*1 1 0%/)
  assert.match(decls(phone, '.bd-picker'), /min-width:\s*120px/)
})

test('561–760 只留图标的按钮也是 40px 宽（原来被钉在 32px）', () => {
  assert.ok(block760, 'board.css 缺少 40px 见方的 760 段')
  assert.match(decls(block760, '.bd-strip > .bd-action'), /width:\s*40px/)
  // 层叠顺序：760 段要排在 560 段之前，手机上才轮得到 44px
  const at1080 = boardCss.lastIndexOf('@media (max-width: 1080px)')
  const at760 = boardCss.lastIndexOf('@media (max-width: 760px)')
  const at560 = boardCss.lastIndexOf('@media (max-width: 560px)')
  assert.ok(at1080 < at760 && at760 < at560, '三段顺序要是 1080 → 760 → 560')
})

test('560 以下再抬一档到 44px', () => {
  assert.match(decls(phone, '.bd-strip'), /min-height:\s*56px/)
  assert.match(decls(phone, '.bd-action'), /height:\s*44px/)
  assert.match(decls(phone, '.bd-strip > .bd-action'), /width:\s*44px/)
  const icon = decls(phone, '.bd-strip .vq-button--icon')
  assert.match(icon, /width:\s*44px/)
  assert.match(icon, /height:\s*44px/)
  assert.match(decls(phone, '.bd-state'), /height:\s*28px/)
})

test('新加的两段里没有小于 13px 的字', () => {
  for (const block of [band, phone]) {
    for (const match of block.matchAll(/font-size:\s*([\d.]+)px/g)) {
      assert.ok(Number(match[1]) >= 13, '新段落里还有 ' + match[1] + 'px 的字')
    }
  }
})

test('桌面（1081 起）保持原样：42px 状态条、24px 按钮、12px 小字', () => {
  assert.match(firstRule(boardCss, '.bd-strip'), /height:\s*42px/)
  assert.match(firstRule(boardCss, '.bd-action'), /height:\s*24px/)
  assert.match(firstRule(boardCss, '.bd-action'), /font-size:\s*13px/)
  assert.match(firstRule(boardCss, '.bd-state'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
  assert.match(firstRule(boardCss, '.bd-label'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
  // 选择器触发器的高度由 shell 的全局窄屏规则管，这一页不该自己写死
  assert.ok(!boardCss.includes('.vq-select__trigger {\n    height'), '状态条不该自己改选择器高度')
})

test('页面把状态条标成一组，窄屏收起「无限画布」字样后仍有名字', () => {
  assert.match(pageSource, /className="bd-strip" role="group" aria-label="无限画布状态条"/)
  // 排队位胶囊里「最久 12.4s」这一段单独成块，手机上才好按断点收起
  assert.match(pageSource, /className="bd-queue-oldest"/)
  assert.match(pageSource, /title=\{'出图的排队位：'/)
})
