// r340：巡检铺到「资产 / 评审 / 充值」这三屏之后，量出来的第一件事。
//
// r331–r339 的巡检只在 11 屏上真按过（外壳、工作台、模板库、设置、作品流、智能体、后台运营位卡），
// 复刻主线的产出端（资产）与评审关（评审），以及全站唯一的钱路（充值），一屏都没量过。
// r340 把这几屏加进 PASSES（只加趟、不动前面任何一趟的目标与顺序），第一次按下就量出 5 处
// 「按下去和悬停一模一样」：
//   · 资产页的三颗筛选项（全部 / 产品资产 / 数字人资产）—— 两帧空、稳态也空；
//   · 评审页那颗「N 个模板首帧」折叠开关 —— 同上；
//   · 带作品那趟评审里的缩略图 .review-thumb —— 连悬停都没有，按下与停着看完全一样。
// 选中那颗筛选项还有第二处：.is-active 的底色与 .vq-assets-filter:hover 同级、又写在文件后面，
// 于是「当前选中的这一项」划过毫无变化（悬停层，不是按下层）。
// （充值页那颗运营位 ✕ 也在候选里，但它的稳态读数是变的：两帧采样落在过渡起点，
//  属 r331/r332 就记过的量具边界，不是页面问题，所以这里不钉它。）
//
// 这个门禁钉的不是「CSS 里有没有 :active 这几个字符」，而是五件会让它悄悄失效的事：
//   1) 选择器真的命中那颗按钮（写错类名 / 漏掉 :active 都不算），而且不在 @media 里 ——
//      量到的那一屏是 1440 宽，写进窄屏断点等于桌面端仍然没反应；
//   2) :not(:disabled) 还在 —— 否则禁用态也会跟着按下去；
//   3) 权重真的压过各自最高的基线（资产页那条悬停态是 0-3-0、.is-active 是 0-2-0），
//      不然「当前选中的那一颗」按下去仍然没反应（r332 在 agents 页踩过）；
//   4) 按下态改的属性要按各自那一档来：筛选项与折叠开关只改 background / color，
//      缩略图只改 opacity（大块图片按钮，与作品流 .works-thumb 同档，不用 transform）；
//      底色用哪个 token 也钉住 —— 筛选项坐在 --line-faint 的槽里，压 --line-faint 会跟槽底同色；
//   5) 改的那条属性必须在元素自己的 transition 里，否则按下/松开都是硬切。
//
// 每条都配反证：把真源码改坏，检查必须变红。门禁不能恒真。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const CSS = {
  'assets.css': read('src/styles/assets.css'),
  'review.css': read('src/styles/review.css'),
}
const INSTRUMENT = read('scripts/audit-press.mjs')

/** 先剥注释：注释里写「要加 :active」不能让检查通过。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 按块上界递归进 @media，返回扁平的 { media, selector, body }；组选择器拆开，方便按单条算权重。 */
function collectRules(css, media = null, out = []) {
  let index = 0
  while (index < css.length) {
    const open = css.indexOf('{', index)
    if (open < 0) break
    const head = css.slice(index, open).trim()
    let depth = 1
    let close = open + 1
    while (close < css.length && depth > 0) {
      if (css[close] === '{') depth += 1
      else if (css[close] === '}') depth -= 1
      close += 1
    }
    if (depth !== 0) break
    const body = css.slice(open + 1, close - 1)
    if (head.startsWith('@')) collectRules(body, head, out)
    else {
      for (const selector of head.split(',')) {
        const clean = selector.trim()
        if (clean) out.push({ media: media, selector: clean, body: body })
      }
    }
    index = close
  }
  return out
}

/** 简单但够用的 CSS specificity：[id, class/attr/pseudo-class, element]。 */
function specificity(selector) {
  let text = selector
    .replace(/::[a-z-]+/gi, '')
    .replace(/:not\(([^()]*)\)/g, '$1')
    .replace(/:where\(([^()]*)\)/g, '')
  const ids = (text.match(/#[\w-]+/g) || []).length
  const classes =
    (text.match(/\.[\w-]+/g) || []).length +
    (text.match(/\[[^\]]*\]/g) || []).length +
    (text.match(/:([a-z-]+)/gi) || []).length
  text = text.replace(/#[\w-]+/g, '').replace(/\.[\w-]+/g, '').replace(/\[[^\]]*\]/g, '').replace(/:([a-z-]+)/gi, '')
  const elements = (text.match(/(^|[\s>+~,(])([a-z][\w-]*)/gi) || []).length
  return [ids, classes, elements]
}

function beats(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

function declarations(body) {
  const map = new Map()
  for (const chunk of body.split(';')) {
    const at = chunk.indexOf(':')
    if (at < 0) continue
    const prop = chunk.slice(0, at).trim().toLowerCase()
    const value = chunk.slice(at + 1).trim()
    if (prop) map.set(prop, value)
  }
  return map
}

const TARGETS = [
  {
    file: 'assets.css',
    label: '资产页的三颗筛选项（全部 / 产品资产 / 数字人资产）',
    base: '.vq-assets-filter',
    count: 3,
    kind: 'fill',
    expectBg: 'var(--line)',
    why: '坐在 --line-faint 的浅底槽里，压 --line-faint 会跟槽底同一个颜色',
  },
  {
    file: 'review.css',
    label: '评审页的「N 个模板首帧」折叠开关',
    base: '.review-picker-toggle',
    count: 1,
    kind: 'fill',
    expectBg: 'var(--line-faint)',
    why: '悬停是白底（--surface-raised），压一层 --line-faint 就是压下去的样子',
  },
  {
    file: 'review.css',
    label: '评审页的缩略图（作品的画面 / 模板首帧）',
    base: '.review-thumb',
    count: 1,
    kind: 'dim',
    why: '大块图片按钮，与作品流 .works-thumb 同一档：按下变淡一档',
  },
]

const ALLOWED = {
  fill: new Set(['background', 'background-color', 'border-color', 'color']),
  dim: new Set(['opacity']),
}
const TRANSITION_NEED = {
  fill: /transition:[^;]*(background|background-color)/,
  dim: /transition:[^;]*opacity/,
}

function pressProblems(source, file) {
  const problems = []
  const rules = collectRules(stripComments(source))
  const targets = file ? TARGETS.filter((target) => target.file === file) : TARGETS
  let total = 0
  for (const target of targets) {
    total += target.count
    const activeRules = rules.filter((rule) =>
      rule.selector.includes(target.base) &&
      rule.selector.includes(':active') &&
      !rule.selector.includes('::'),
    )
    if (!activeRules.length) {
      problems.push(target.label + ' 没有 :active 规则（只改 hover / .is-active 不够）')
      continue
    }
    for (const rule of activeRules) {
      // 量到的那一屏是 1440 宽：写进 @media 就等于桌面端仍然没反应
      if (rule.media) {
        problems.push(target.label + ' 的 :active 写在 ' + rule.media + ' 里（桌面端仍然没反应）')
      }
      if (!rule.selector.includes(':not(:disabled)')) {
        problems.push(target.label + ' 的 :active 没有排除 :disabled，禁用态也会跟着按下去')
      }
      for (const [prop] of declarations(rule.body)) {
        if (!ALLOWED[target.kind].has(prop)) {
          problems.push(target.label + ' 的 :active 多改了 ' + prop + '（这一档只允许 ' + [...ALLOWED[target.kind]].join(' / ') + '）')
        }
      }
    }

    const baselineRules = rules.filter(
      (rule) =>
        rule.selector.includes(target.base) &&
        !rule.selector.includes(':active') &&
        !rule.selector.includes('::'),
    )
    const baseline = baselineRules
      .map((rule) => specificity(rule.selector))
      .reduce((best, next) => (beats(next, best) ? next : best), [0, 0, 0])
    const pressed = activeRules
      .map((rule) => specificity(rule.selector))
      .reduce((best, next) => (beats(next, best) ? next : best), [0, 0, 0])
    if (!beats(pressed, baseline)) {
      problems.push(
        target.label + ' 的 :active 权重 ' + pressed.join(',') + ' 没压过最高基线 ' + baseline.join(','),
      )
    }

    const bodies = activeRules.map((rule) => declarations(rule.body))
    if (target.kind === 'fill') {
      const background = bodies.map((decl) => decl.get('background') || decl.get('background-color') || '').join(' ')
      if (!background.includes(target.expectBg)) {
        problems.push(target.label + ' 的 :active 底色不是 ' + target.expectBg + '（' + target.why + '）')
      }
      const color = bodies.map((decl) => decl.get('color') || '').join(' ')
      if (!color.includes('var(--ink)')) {
        problems.push(target.label + ' 的 :active 没有文字反馈（color 应为 var(--ink)）')
      }
    } else {
      const opacity = bodies.map((decl) => decl.get('opacity') || '').join(' ')
      if (!/0?\.9\b/.test(opacity)) problems.push(target.label + ' 的 :active 没有变淡（opacity 0.9）')
    }

    // 改的那条属性必须在该元素自己的 transition 里，否则按下/松开是硬切
    const baseBody = rules
      .filter((rule) => !rule.media && rule.selector === target.base)
      .map((rule) => rule.body)
      .join('\n')
    if (!TRANSITION_NEED[target.kind].test(baseBody)) {
      problems.push(target.label + ' 的 transition 里没有这一档要变的属性，按下/松开会瞬间跳')
    }
  }
  const want = targets.reduce((sum, target) => sum + target.count, 0)
  if (total !== want) problems.push('覆盖数不是 ' + want + ' 颗，而是 ' + total)
  return problems
}

function problemsOf(file) {
  return pressProblems(CSS[file], file)
}

test('5 颗：命中、不在 @media 里、排除 disabled、权重压过基线、按各自那一档变色且不用 transform', () => {
  for (const file of Object.keys(CSS)) assert.deepEqual(problemsOf(file), [], file)
  for (const [file, source] of Object.entries(CSS)) {
    const ours = collectRules(stripComments(source)).filter(
      (rule) => rule.selector.includes(':active') && TARGETS.some((target) => rule.selector.includes(target.base)),
    )
    assert.equal(
      ours.some((rule) => declarations(rule.body).has('transform')),
      false,
      file + ' 的按下规则里出现了 transform：那会给绝对定位后代另立包含块（r326），这一簇不需要',
    )
  }
})

test('选中的那颗筛选项划过也要有反应（悬停层，不是按下层）', () => {
  const hover = collectRules(stripComments(CSS['assets.css'])).filter(
    (rule) => rule.selector === '.vq-assets-filter.is-active:hover',
  )
  assert.equal(hover.length, 1, '缺少 .vq-assets-filter.is-active:hover：当前选中那颗划过毫无变化')
  assert.match(hover[0].body, /background:\s*var\(--line-faint\)/)
  const press = specificity('.vq-assets-filter.vq-assets-filter:not(:disabled):active')
  const activeHover = specificity('.vq-assets-filter.is-active:hover')
  assert.ok(beats(press, activeHover), '按下态（' + press.join(',') + '）没压过选中态的悬停（' + activeHover.join(',') + '）：按下去会掉回悬停色')
})

test('反证：删掉 :active，检查必须变红', () => {
  const broken = CSS['assets.css'].replace('.vq-assets-filter.vq-assets-filter:not(:disabled):active', '.vq-assets-filter.vq-assets-filter:not(:disabled)')
  assert.notEqual(broken, CSS['assets.css'], '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(broken, 'assets.css').some((line) => line.includes('三颗筛选项') && line.includes('没有 :active')))
})

test('反证：权重降到与选中态悬停同级，检查必须变红', () => {
  const broken = CSS['assets.css'].replace('.vq-assets-filter.vq-assets-filter:not(:disabled):active', '.vq-assets-filter:active')
  assert.notEqual(broken, CSS['assets.css'], '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(broken, 'assets.css').some((line) => line.includes('三颗筛选项') && line.includes('没压过最高基线')))
})

test('反证：把规则塞进窄屏 @media，检查必须变红', () => {
  const rule = '.vq-assets-filter.vq-assets-filter:not(:disabled):active {\n  background: var(--line);\n  color: var(--ink);\n}'
  const broken = CSS['assets.css'].replace(rule, '')
  assert.notEqual(broken, CSS['assets.css'], '反证的锚点要真的命中源码里那条规则')
  const inside = broken + '\n@media (max-width: 560px) {\n' + rule + '\n}\n'
  assert.ok(pressProblems(inside, 'assets.css').some((line) => line.includes('三颗筛选项') && line.includes('@media')))
})

test('反证：底色换成与槽底同色的 --line-faint，检查必须变红', () => {
  const broken = CSS['assets.css'].replace(
    '.vq-assets-filter.vq-assets-filter:not(:disabled):active {\n  background: var(--line);',
    '.vq-assets-filter.vq-assets-filter:not(:disabled):active {\n  background: var(--line-faint);',
  )
  assert.notEqual(broken, CSS['assets.css'], '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(broken, 'assets.css').some((line) => line.includes('三颗筛选项') && line.includes('底色不是')))
})

test('反证：评审那颗开关删掉 :active，检查必须变红', () => {
  const broken = CSS['review.css'].replace('.review-picker-toggle:not(:disabled):active', '.review-picker-toggle:not(:disabled)')
  assert.notEqual(broken, CSS['review.css'], '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(broken, 'review.css').some((line) => line.includes('折叠开关') && line.includes('没有 :active')))
})

test('反证：缩略图按下不变淡，检查必须变红', () => {
  const broken = CSS['review.css'].replace('.review-thumb:not(:disabled):active { opacity:0.9; }', '.review-thumb:not(:disabled):active { opacity:1; }')
  assert.notEqual(broken, CSS['review.css'], '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(broken, 'review.css').some((line) => line.includes('缩略图') && line.includes('没有变淡')))
})

test('巡检真的铺到了这几屏，并给运营位第三个位置铺了内容', () => {
  // 只加趟、不改前面任何一趟：这四条是 r340 新增的
  for (const id of ["id: 'assets'", "id: 'review'", "id: 'review-project'", "id: 'recharge'"]) {
    assert.ok(INSTRUMENT.includes(id), '巡检缺了这一趟：' + id)
  }
  // 评审页带作品那条地址：空状态只有 3 颗可点元素，真正的界面在 #/review/project/<id>
  assert.match(INSTRUMENT, /route: '\/review\/project\/' \+ encodeURIComponent\(project\.id\)/)
  // 运营位白名单第三个位置（充值页）以前在夹具里没有内容，那一处挂载点一次都没渲染过
  assert.match(INSTRUMENT, /placement: 'recharge'/)
  // 前面那几趟的 scope / 顺序不许被这一轮带偏（否则 r331–r339 的基线不可比）
  assert.match(INSTRUMENT, /\{ id: 'overview', label: '工作台', route: '\/overview'/)
  assert.match(INSTRUMENT, /\{ id: 'admin-promos', label: '后台 · 运营位卡'/)
})
