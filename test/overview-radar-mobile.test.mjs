// 工作台 / 模板库 / 爆款雷达在手机与平板上的一条底线（r237）。
// 2026-11-19 量 390 / 768 / 1024：三页共用骨架上还有 12–12.5px 的字和 24–34px 的点按区
// （导航 34、顶栏搜索 30、版本 28、筛选片 30、文字链接 24），雷达每张卡 9 处 11–12px。
// 这里锁住抬上去的档位、模板库紧凑行，以及「桌面（1081 起）一个像素没动」。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const shellCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'shell.css'), 'utf8')
const overviewCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'overview.css'), 'utf8')
const radarCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'radar.css'), 'utf8')
const overviewSource = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'OverviewPage.tsx'), 'utf8')

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

/** 同一选择器可能出现在几组里（字号一组、触控区一组）：全部取回来。 */
function allDecls(block, selector) {
  return rulesOf(block).filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body)
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

// 取每组里最后一段：r237 的覆盖都追加在文件末尾。
const shellBand = mediaBlocks(shellCss, '(max-width: 1080px)', '.vq-nav-item').at(-1)
const shellPhone = mediaBlocks(shellCss, '(max-width: 560px)', '.vq-nav-item').at(-1)
const overviewBand = mediaBlocks(overviewCss, '(max-width: 1080px)', '.vq-page--overview').at(-1)
const overviewPhone = mediaBlocks(overviewCss, '(max-width: 560px)', '.vq-page--overview').at(-1)
const radarBand = mediaBlocks(radarCss, '(max-width: 1080px)', '.page--templates').at(-1)
const radarPhone = mediaBlocks(radarCss, '(max-width: 560px)', '.page--templates').at(-1)
const compact = mediaBlocks(radarCss, '(max-width: 820px)', '.page--templates .template-card').at(-1)
const tiny = mediaBlocks(radarCss, '(max-width: 360px)', '.page--templates .template-card').at(-1)

test('工作台根元素带 vq-page--overview，三页的规则各自成段', () => {
  assert.ok(overviewSource.includes('vq-page vq-page--overview'), '工作台根元素要带 vq-page--overview')
  assert.ok(shellBand, 'shell.css 缺少 ≤1080 的骨架规则')
  assert.ok(overviewBand, 'overview.css 缺少 ≤1080 的工作台规则')
  assert.ok(radarBand, 'radar.css 缺少 ≤1080 的雷达/模板库规则')
})

test('骨架（导航 / 顶栏搜索 / 版本 / 筛选片 / 文字链接）在 1080 下抬到 40px', () => {
  for (const with_ of ['.vq-nav-item', '.vq-nav-item--utility']) assert.match(decls(shellBand, with_), /min-height:\s*40px/)
  for (const heightOf of ['.vq-search', '.vq-model-trigger']) assert.match(decls(shellBand, heightOf), /height:\s*40px/)
  for (const minHeightOf of ['.vq-version-trigger', '.vq-link', '.vq-select__trigger']) assert.match(decls(shellBand, minHeightOf), /min-height:\s*40px/)
  const chip = decls(shellBand, '.vq-filter-chip')
  assert.match(chip, /height:\s*40px/)
  assert.match(chip, /font-size:\s*14px/)
})

test('骨架的字：筛选片说明 13、kicker 13、上手引导 13', () => {
  assert.match(decls(shellBand, '.vq-filter-chip__count'), /font-size:\s*14px/)
  assert.match(decls(shellBand, '.vq-head-kicker'), /--head-kicker-size:\s*14px/)
  assert.match(decls(shellBand, '.vq-guide-step-body'), /font-size:\s*14px/)
  assert.match(decls(shellBand, '.vq-guide-head p'), /font-size:\s*14px/)
})

test('手机（560 以下）骨架抬到 44px', () => {
  for (const with_ of ['.vq-nav-item', '.vq-nav-item--utility']) assert.match(decls(shellPhone, with_), /min-height:\s*44px/)
  for (const heightOf of ['.vq-search', '.vq-model-trigger', '.vq-filter-chip']) assert.match(decls(shellPhone, heightOf), /height:\s*44px/)
  for (const minHeightOf of ['.vq-version-trigger', '.vq-link', '.vq-select__trigger']) assert.match(decls(shellPhone, minHeightOf), /min-height:\s*44px/)
})

test('工作台：按钮两个档位、三处小字 13、主按钮 40/44', () => {
  const root = decls(overviewBand, '.vq-page--overview')
  assert.match(root, /--btn-h:\s*40px/)
  assert.match(root, /--btn-h-sm:\s*40px/)
  assert.match(decls(overviewBand, '.vq-page--overview .vq-mono'), /font-size:\s*14px/)
  assert.match(decls(overviewBand, '.vq-page--overview .vq-next-label'), /font-size:\s*14px/)
  assert.match(decls(overviewBand, '.vq-page--overview .vq-next-stats dt'), /font-size:\s*14px/)
  assert.match(decls(overviewBand, '.vq-page--overview .vq-next-cta'), /height:\s*40px/)
  assert.match(decls(overviewPhone, '.vq-page--overview .vq-next-cta'), /height:\s*44px/)
  assert.match(decls(overviewPhone, '.vq-page--overview'), /--btn-h:\s*44px/)
})

test('爆款雷达 / 模板库：字号 13、按钮 40、标题 16、搜索框 44', () => {
  const root = decls(radarBand, '.page--radar')
  assert.match(root, /--btn-h:\s*40px/)
  assert.match(root, /--btn-h-sm:\s*40px/)
  assert.match(root, /--chip-font:\s*14px/)
  for (const selector of ['.page--radar .radar-author', '.page--radar .radar-badge', '.page--radar .radar-owned']) {
    assert.match(decls(radarBand, selector), /font-size:\s*14px/, selector)
  }
  assert.match(decls(radarBand, '.page--radar .radar-stats'), /font-size:\s*14px/)
  assert.match(decls(radarBand, '.page--radar .radar-stats .radar-rate'), /font-size:\s*14px/)
  assert.match(decls(radarBand, '.page--radar .radar-actions .vq-button'), /height:\s*40px/)
  assert.match(decls(radarBand, '.page--radar .radar-title'), /font-size:\s*17px/)
  const adapt = allDecls(radarBand, '.page--templates .template-adapt').join(' ')
  assert.match(adapt, /font-size:\s*14px/)
  assert.match(adapt, /height:\s*40px/)
  assert.match(decls(radarBand, '.page--templates .template-stats'), /font-size:\s*14px/)
  assert.match(decls(radarBand, '.page--radar .inline-search'), /height:\s*44px/)
})

test('手机（560 以下）雷达与模板库的按钮 44px', () => {
  assert.match(decls(radarPhone, '.page--radar .radar-actions .vq-button'), /height:\s*44px/)
  assert.match(decls(radarPhone, '.page--templates .template-adapt'), /height:\s*44px/)
  assert.match(decls(radarPhone, '.page--radar'), /--btn-h:\s*44px/)
})

test('模板库 ≤820 改紧凑行：左 96px 封面、右文案；320 再收到 80px', () => {
  const card = decls(compact, '.page--templates .template-card')
  assert.match(card, /display:\s*grid/)
  assert.match(card, /grid-template-columns:\s*96px minmax\(0,\s*1fr\)/)
  assert.match(decls(compact, '.page--templates .template-cover'), /width:\s*96px/)
  assert.match(decls(tiny, '.page--templates .template-card'), /grid-template-columns:\s*80px/)
  assert.match(decls(tiny, '.page--templates .template-meta > span'), /white-space:\s*normal/)
})

test('桌面（1081 起）基样式一个像素没动', () => {
  assert.match(firstRule(shellCss, '.vq-nav-item'), /min-height:\s*34px/)
  assert.match(firstRule(shellCss, '.vq-search'), /height:\s*30px/)
  assert.match(firstRule(shellCss, '.vq-filter-chip'), /height:\s*30px/)
  assert.match(firstRule(shellCss, '.vq-filter-chip'), /font-size:\s*(?:12\.5px|var\(--text-2xs\))/)
  assert.match(firstRule(shellCss, '.vq-link'), /min-height:\s*24px/)
  assert.match(firstRule(overviewCss, '.vq-next-cta'), /height:\s*36px/)
  assert.match(firstRule(overviewCss, '.vq-next-label'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
  assert.match(firstRule(radarCss, '.radar-author'), /font-size:\s*(?:11\.5px|var\(--text-2xs\))/)
  assert.match(firstRule(radarCss, '.radar-title'), /font-size:\s*16px/)
  assert.match(firstRule(radarCss, '.template-adapt'), /height:\s*32px/)
  assert.match(firstRule(radarCss, '.template-adapt'), /font-size:\s*(?:11\.5px|var\(--text-2xs\))/)
})

test('新加的几段里没有小于 14px 的字', () => {
  for (const block of [shellBand, shellPhone, overviewBand, overviewPhone, radarBand, radarPhone, compact, tiny]) {
    for (const match of block.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      assert.ok(Number(match[1]) >= 13, '新规则里不该出现 ' + match[1] + 'px 的字')
    }
  }
})
