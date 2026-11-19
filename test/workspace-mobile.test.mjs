// 工作流页在手机与平板上的一条底线（r242 / v0.9.226）。
// 2026-11-19 量 320 / 360 / 375 / 390 / 768 / 1024 / 1440 三态（默认、节点面板打开、首次上手引导）：
// 12px 的等宽元信息 14–15 处、不到 40px 的点按区 11–17 处；
// 顺带量出三处真问题：顶栏「内部测试」胶囊 + 模型切换在 375 宽把整页撑到 381、320 撑到 346，
// 工具条在 761–1024 不换行（768 的内容 444px 挤进 366px 的格子，文字互压），
// 顶栏图标键被挤成 37px。这一页只在 ≤1080 / ≤560 两段里改，桌面（1081 起）一条规则都不进。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const canvasCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'canvas.css'), 'utf8')
const shellCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'shell.css'), 'utf8')
const pageSource = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'CanvasPage.tsx'), 'utf8')
const modelSource = fs.readFileSync(path.join(ROOT, 'src', 'components', 'ModelSwitch.tsx'), 'utf8')

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

const band = mediaBlocks(canvasCss, '(max-width: 1080px)', '.cv-page').at(-1)
const phone = mediaBlocks(canvasCss, '(max-width: 560px)', '.cv-page').at(-1)
const shellBand = mediaBlocks(shellCss, '(max-width: 1080px)', '.vq-env-pill').at(-1)
const shellPhone = mediaBlocks(shellCss, '(max-width: 480px)', '.vq-model-name').at(-1)

test('工作流页的窄屏规则只在 ≤1080 / ≤560 两段里，根元素仍是 cv-page', () => {
  assert.ok(pageSource.includes('className="page cv-page"'), '工作流页根元素要还是 cv-page')
  assert.ok(band, 'canvas.css 缺少 ≤1080 的工作流页规则')
  assert.ok(phone, 'canvas.css 缺少 ≤560 的工作流页规则')
  const outside = canvasCss.slice(0, canvasCss.lastIndexOf('@media (max-width: 1080px)', canvasCss.indexOf('.cv-page .cv-save')))
  assert.ok(!outside.includes('.cv-page .cv-save'), '13px 的元信息规则要在 ≤1080 里')
})

test('1080 以下：token 抬一档，页内的按钮与胶囊跟着走', () => {
  const root = decls(band, '.cv-page')
  assert.match(root, /--btn-h:\s*40px/)
  assert.match(root, /--btn-h-sm:\s*40px/)
  assert.match(root, /--chip-font:\s*13px/)
  assert.match(root, /--chip-pill-h:\s*24px/)
  assert.match(root, /--text-mono:\s*13px/)
})

test('1080 以下：12px 那一片逐个点名抬到 13px', () => {
  for (const selector of [
    '.cv-page .cv-save',
    '.cv-page .cv-run-credit',
    '.cv-page .cv-kicker',
    '.cv-page .cv-toolbar-count',
    '.cv-page .cv-zoom',
    '.cv-page .cv-node-type',
    '.cv-page .cv-node-state',
    '.cv-page .cv-node-foot',
    '.cv-page .cv-type-mono',
    '.cv-page .cv-type-status',
    '.cv-page .cv-section-title',
    '.cv-page .cv-input--mono',
    '.cv-page .cv-range-value',
    '.cv-page .cv-mono',
    '.cv-page .cv-run-ms',
    '.cv-page .cv-steps-count',
    '.cv-page .cv-step-no',
    '.cv-page .cv-step-dep',
    '.cv-page .cv-step-state',
    '.cv-page .cv-steps-note',
    '.cv-page .cv-empty-note',
  ]) {
    assert.match(decls(band, selector), /font-size:\s*13px/, selector + ' 要抬到 13px')
  }
})

test('1080 以下：点按区 40px（工具条 / 流程名 / 选择框 / 输入框 / 缩放键 / 面板关闭 / 队列条）', () => {
  assert.match(decls(band, '.cv-page .cv-tool'), /height:\s*40px/)
  assert.match(decls(band, '.cv-page .cv-tool'), /padding:\s*0 12px/)
  assert.match(decls(band, '.cv-page .cv-flow-select select'), /height:\s*40px/)
  assert.match(decls(band, '.cv-page .cv-flow-name'), /min-height:\s*40px/)
  assert.match(decls(band, '.cv-page .cv-input'), /min-height:\s*40px/)
  assert.match(decls(band, '.cv-page .cv-palette-close'), /width:\s*40px/)
  assert.match(decls(band, '.cv-page .cv-palette-close'), /height:\s*40px/)
  assert.match(decls(band, '.cv-page .cv-canvas .react-flow__controls-button'), /width:\s*40px/)
  assert.match(decls(band, '.cv-page .cv-run-queue'), /height:\s*40px/)
  const toolbar = decls(band, '.cv-page .cv-toolbar')
  assert.match(toolbar, /min-height:\s*52px/)
  // 761–1024 原来不换行：768 上工具条内容 444px 挤进 366px 的格子，文字直接互压
  assert.match(toolbar, /flex-wrap:\s*wrap/)
  assert.match(decls(band, '.cv-page .cv-toolbar-group'), /flex-wrap:\s*wrap/)
})

test('560 以下再抬一档到 44px', () => {
  const root = decls(phone, '.cv-page')
  assert.match(root, /--btn-h:\s*44px/)
  assert.match(root, /--chip-pill-h:\s*26px/)
  assert.match(decls(phone, '.cv-page .cv-tool'), /height:\s*44px/)
  assert.match(decls(phone, '.cv-page .cv-flow-name'), /min-height:\s*44px/)
  assert.match(decls(phone, '.cv-page .cv-input'), /min-height:\s*44px/)
  assert.match(decls(phone, '.cv-page .cv-palette-item'), /min-height:\s*44px/)
})

test('新加的两段里没有小于 13px 的字', () => {
  for (const block of [band, phone]) {
    for (const match of block.matchAll(/font-size:\s*([\d.]+)px/g)) {
      assert.ok(Number(match[1]) >= 13, '新段落里还有 ' + match[1] + 'px 的字')
    }
  }
})

// r242 那条「桌面一行没动」的护栏：桌面仍是 27px 工具条、42px 工具条高、40px 输入框。
// r255 起桌面元信息由 12px 抬到 13px（用户说「字太小」），所以这里锁 13px——
// 再往回改小要被这条拦下来。
test('桌面（1081 起）：27px 工具条、13px 元信息、26px 缩放键', () => {
  assert.match(firstRule(canvasCss, '.cv-tool'), /height:\s*27px/)
  assert.match(firstRule(canvasCss, '.cv-toolbar'), /height:\s*42px/)
  assert.match(firstRule(canvasCss, '.cv-toolbar-count'), /font-size:\s*13px/)
  assert.match(firstRule(canvasCss, '.cv-zoom'), /font-size:\s*13px/)
  assert.match(firstRule(canvasCss, '.cv-page .cv-tool'), /height:\s*40px/)
  assert.ok(!firstRule(canvasCss, '.cv-flow-name').includes('min-height'), '流程名输入框基样式不加 min-height')
  assert.match(firstRule(canvasCss, '.cv-step-no'), /width:\s*24px/)
  assert.match(firstRule(canvasCss, '.cv-step-state'), /line-height:\s*22px/)
})

test('顶栏：内部测试胶囊 1080 以下 13px，1024 收窄模型名，480 以下胶囊与模型名都让位', () => {
  assert.match(firstRule(shellCss, '.vq-env-pill'), /font-size:\s*12px/)
  assert.ok(shellBand, 'shell.css 缺少 ≤1080 的顶栏规则')
  assert.match(decls(shellBand, '.vq-env-pill'), /font-size:\s*13px/)
  assert.match(decls(shellBand, '.vq-topbar .vq-model-trigger'), /max-width:\s*148px/)
  assert.match(decls(shellBand, '.vq-topbar .vq-topbar-right'), /flex:\s*0 0 auto/)
  assert.match(decls(shellBand, '.vq-topbar .vq-button--icon'), /flex:\s*0 0 auto/)
  assert.ok(shellPhone, 'shell.css 缺少 ≤480 的顶栏规则')
  assert.match(decls(shellPhone, '.vq-topbar .vq-env-pill'), /display:\s*none/)
  assert.match(decls(shellPhone, '.vq-topbar .vq-model-name'), /display:\s*none/)
})

test('手机上模型键只剩图标 + 箭头，读屏要还有名字', () => {
  assert.match(modelSource, /aria-label=\{ready \? '选择模型：' \+ activeLabel/, '模型键要给 aria-label')
})
