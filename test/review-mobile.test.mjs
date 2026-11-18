// 视觉评审页在手机与平板上的一条底线（r239）。
// 2026-11-19 量 390 / 768（首屏候选 + 最近评审、一条历史评审详情、历史弹层）：
// 12px 的字还有 22–37 处（胶囊 / 标签 / mono 时间与面积 / 历史位置 / 编号盒），
// 点按区还有 4–6 处不到 40px（模板首帧折叠开关 24、查看全部 35、选图与回作品 28、顶栏搜索 30）。
// 评审页的字与点按区都走 shell 的原子，所以在这一页把原子档位抬一档；
// 桌面（1081 起）一条规则都不进，1440 逐字段与改前一致。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const reviewCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'review.css'), 'utf8')
const shellCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'shell.css'), 'utf8')
const tokensCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
const reviewSource = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'ReviewPage.tsx'), 'utf8')

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

/** 取某条选择器的全部声明体（同一段里可能先有一条组规则、后面再补一条）；组选择器里出现过就算命中。 */
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

const band = mediaBlocks(reviewCss, '(max-width: 1080px)', '.review-page').at(-1)
const phone = mediaBlocks(reviewCss, '(max-width: 560px)', '.review-page').at(-1)
const shellTablet = mediaBlocks(shellCss, '(max-width: 1080px)', '.vq-nav-item em').at(-1)
const shellIconSearch = mediaBlocks(shellCss, '(max-width: 900px)', '.vq-search').at(-1)
const shellPhone = mediaBlocks(shellCss, '(max-width: 560px)', '.vq-search').at(-1)

test('评审页窄屏规则只在 ≤1080 / ≤560 两段里，页面根元素仍是 review-page', () => {
  assert.ok(reviewSource.includes('className="review-page"'), '评审页根元素要还是 review-page')
  assert.ok(band, 'review.css 缺少 ≤1080 的评审页规则')
  assert.ok(phone, 'review.css 缺少 ≤560 的评审页规则')
  // 新写的字与点按区规则不许跑到媒体查询外面去：桌面按构造就进不来
  const outside = reviewCss.slice(0, reviewCss.indexOf('@media (max-width: 1080px)'))
  assert.ok(!outside.includes('.review-page .vq-mono'), '13px 的 mono 规则要在 ≤1080 里')
})

test('1080 以下：胶囊 / 标签 / mono 全部 13px', () => {
  const root = decls(band, '.review-page')
  assert.match(root, /--btn-h:\s*40px/)
  assert.match(root, /--btn-h-sm:\s*40px/)
  assert.match(root, /--chip-font:\s*13px/)
  assert.match(root, /--chip-pill-h:\s*24px/)
  assert.match(root, /--chip-tag-h:\s*24px/)
  assert.match(root, /--text-mono:\s*13px/)
  // tokens.css 里 .vq-mono 的 12px 不吃 --text-mono，所以页面里单点抬
  assert.match(decls(band, '.review-page .vq-mono'), /font-size:\s*13px/)
  for (const selector of [
    '.review-page .review-picker-toggle',
    '.review-page .review-thumb-fallback',
    '.review-page .review-shots-head span',
    '.review-page .review-manual label',
    '.review-page .review-credit',
    '.review-page .review-history-time',
    '.review-page .review-history-flag',
    '.review-page .review-history-where',
    '.review-page .review-issue-summary',
    '.review-page .review-obs-no',
    '.review-page .review-project-scope span',
    '.review-page .review-model-note-text small',
    '.review-page .review-anchor-no',
  ]) {
    assert.match(decls(band, selector), /font-size:\s*13px/, selector + ' 要 13px')
  }
})

test('1080 以下：折叠开关与两个「更多」撑到 40px 点按区', () => {
  const toggle = decls(band, '.review-page .review-picker-toggle')
  assert.match(toggle, /min-height:\s*40px/)
  assert.match(toggle, /padding:\s*8px 12px/)
  assert.match(decls(band, '.review-page .review-history-more'), /min-height:\s*40px/)
  assert.match(decls(band, '.review-page .review-candidates-more'), /min-height:\s*40px/)
  assert.match(decls(band, '.review-page .review-history-item'), /min-height:\s*40px/)
  const badge = decls(band, '.review-page .review-anchor-no')
  assert.match(badge, /min-width:\s*18px/)
  assert.match(badge, /height:\s*18px/)
  assert.match(decls(band, '.review-page .review-history-head .vq-button--icon'), /flex:\s*0 0 auto/)
})

test('手机（560 以下）：按钮 44px，点按区跟着抬', () => {
  const root = decls(phone, '.review-page')
  assert.match(root, /--btn-h:\s*44px/)
  assert.match(root, /--btn-h-sm:\s*44px/)
  for (const selector of [
    '.review-page .review-picker-toggle',
    '.review-page .review-history-more',
    '.review-page .review-candidates-more',
    '.review-page .review-history-item',
  ]) {
    assert.match(decls(phone, selector), /min-height:\s*44px/, selector + ' 要 44px')
  }
  assert.match(decls(phone, '.review-page .review-history-item'), /padding:\s*8px/)
})

test('共用骨架：图标态搜索 40/44px，「等你看」计数 13px，顶栏图标按钮不收缩', () => {
  assert.match(decls(shellIconSearch, '.vq-search'), /width:\s*40px/)
  assert.match(decls(shellPhone, '.vq-search'), /width:\s*44px/)
  assert.match(decls(shellTablet, '.vq-nav-item em'), /font-size:\s*13px/)
  assert.match(decls(shellPhone, '.vq-topbar .vq-button--icon'), /flex:\s*0 0 auto/)
})

test('新写的两段里没有比 13px 还小的字号', () => {
  for (const [label, block] of [['≤1080', band], ['≤560', phone]]) {
    for (const rule of rulesOf(block)) {
      const match = rule.body.match(/font-size:\s*([\d.]+)px/)
      if (!match) continue
      assert.ok(Number(match[1]) >= 13, label + ' 还有 ' + match[1] + 'px：' + rule.selectors.join(','))
    }
  }
})

test('桌面（1081 起）基样式一个像素没动', () => {
  assert.match(firstRule(tokensCss, '.vq-mono'), /font-size:\s*12px/)
  assert.match(firstRule(reviewCss, '.review-history-time'), /font-size:\s*12px/)
  assert.match(firstRule(reviewCss, '.review-history-flag'), /font-size:\s*12px/)
  assert.match(firstRule(reviewCss, '.review-picker-toggle'), /min-height:\s*24px/)
  assert.match(firstRule(reviewCss, '.review-obs-no'), /font-size:\s*12px/)
  assert.match(firstRule(shellCss, '.vq-search'), /height:\s*30px/)
  assert.match(firstRule(shellCss, '.vq-nav-item em'), /font-size:\s*12px/)
  assert.match(firstRule(tokensCss, ':root'), /--btn-h:\s*32px/)
  assert.match(firstRule(tokensCss, ':root'), /--btn-h-sm:\s*28px/)
})
