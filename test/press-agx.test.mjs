// r332：agents 页按下反馈的「声明 ↔ 命中」绑定。
//
// r331 在真产物上按了 136 颗按钮，agents 两趟有 22 颗「按下去与悬停/选中一模一样」：
// 快捷创作的 对话/图片/视频、平台对话/对话预设、读链接/思考模式/附件、新对话，
// 以及对话预设页的三个模型胶囊与五个分类页签。
//
// 这里钉住的不是「写没写 background」，而是四件会让它悄悄失效的事：
//   1) 选择器真的命中那颗按钮（写错类名 / 漏掉 :active 都不算）；
//   2) :not(:disabled) 还在——否则禁用态也会跟着按下；
//   3) 权重真的压过各自最高的 .is-active（含 390 那条 .vq-content … 的 4 类权重），
//      否则「当前选中的那颗」按下去仍然没反应；
//   4) 按下态只改 background / border-color / color。用 transform 就会制造包含块，
//      还要额外碰 prefers-reduced-motion；这一簇不需要它。
//
// 每条都配反证：把真源码改坏，检查必须变红。门禁不能恒真。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/styles/agents.css'), 'utf8')

/** 先剥注释：注释里写「要加 :active」不能让检查通过。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 一次扫描、按块上界递归进 @media，不重解析余下全文。
 * 返回扁平的 { selector, body }；组选择器拆开，方便按单条算权重。
 */
function collectRules(css, out = []) {
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
    if (head.startsWith('@')) collectRules(body, out)
    else {
      for (const selector of head.split(',')) {
        const clean = selector.trim()
        if (clean) out.push({ selector: clean, body })
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
    key: 'mode-tabs',
    label: '对话 / 图片 / 视频（6 颗）',
    base: '.agx-mode-tabs button',
    needBorder: false,
    count: 6,
  },
  {
    key: 'surface-switch',
    label: '平台对话 / 对话预设（4 颗）',
    base: '.agx-surface-switch button',
    needBorder: true,
    count: 4,
  },
  {
    key: 'qc-new',
    label: '新对话（1 颗）',
    base: '.qc-new',
    needBorder: true,
    count: 1,
  },
  {
    key: 'qc-tool',
    label: '读链接 / 思考模式 / 附件（3 颗）',
    base: '.qc-tool',
    needBorder: true,
    count: 3,
  },
  {
    key: 'capsule',
    label: '模型胶囊触发器（3 颗）',
    base: '.agx-capsule-trigger',
    needBorder: false,
    count: 3,
  },
  {
    key: 'tabs',
    label: '预设分类页签（5 颗）',
    base: '.agx-tabs button',
    needBorder: false,
    count: 5,
  },
]

const ALLOWED = new Set(['background', 'background-color', 'border-color', 'color'])

function pressProblems(source) {
  const problems = []
  const rules = collectRules(stripComments(source))
  let total = 0
  for (const target of TARGETS) {
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
      if (!rule.selector.includes(':not(:disabled)')) {
        problems.push(target.label + ' 的 :active 没有排除 :disabled，禁用态也会跟着按下去')
      }
      for (const [prop] of declarations(rule.body)) {
        if (!ALLOWED.has(prop)) {
          problems.push(target.label + ' 的 :active 多改了 ' + prop + '（只允许 background / border-color / color）')
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
    const background = bodies.map((decl) => decl.get('background') || decl.get('background-color') || '').join(' ')
    if (!background.includes('var(--line-faint)')) {
      problems.push(target.label + ' 的 :active 没有底色反馈（background 应为 var(--line-faint)）')
    }
    if (target.needBorder) {
      const border = bodies.map((decl) => decl.get('border-color') || '').join(' ')
      if (!border.includes('var(--ink)')) {
        problems.push(target.label + ' 的 :active 没有边框反馈（border-color 应为 var(--ink)）')
      }
    }
    const color = bodies.map((decl) => decl.get('color') || '').join(' ')
    if (!color.includes('var(--ink)')) {
      problems.push(target.label + ' 的 :active 没有文字反馈（color 应为 var(--ink)）')
    }
  }
  if (total !== 22) problems.push('覆盖数不是 22 颗，而是 ' + total)
  return problems
}

test('22 颗：选择器命中、排除 disabled、权重压过 is-active、只改三个颜色属性', () => {
  assert.deepEqual(pressProblems(CSS), [])
  // 「只加 :active」不能靠 transform：这一簇不需要碰 prefers-reduced-motion。
  // 只看这一簇命中的规则；文件里既有的 .agx-send / .agx-card-main 不在这次范围内。
  const ours = collectRules(stripComments(CSS)).filter(
    (rule) => rule.selector.includes(':active') && TARGETS.some((target) => rule.selector.includes(target.base)),
  )
  assert.equal(
    ours.some((rule) => declarations(rule.body).has('transform')),
    false,
    '按下规则里出现了 transform：要么去掉，要么补 prefers-reduced-motion 的 transform: none',
  )
})

test('反证：删掉 :active，检查必须变红', () => {
  const broken = CSS.replace('.qc-tool:not(:disabled):active', '.qc-tool:not(:disabled)')
  assert.notEqual(broken, CSS, '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(broken).some((line) => line.includes('读链接 / 思考模式 / 附件') && line.includes('没有 :active')))
})

test('反证：选择器写错（agx-tabs 写成 agx-tabsx），检查必须变红', () => {
  const broken = CSS.replace(
    '.vq-content .agx-page .agx-tabs button:not(:disabled):active',
    '.vq-content .agx-page .agx-tabsx button:not(:disabled):active',
  )
  assert.notEqual(broken, CSS, '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(broken).some((line) => line.includes('预设分类页签') && line.includes('没有 :active')))
})

test('反证：权重降到与 .is-active 同级（去掉两条限定类），检查必须变红', () => {
  const broken = CSS.replace(
    '.vq-content .agx-page .agx-tabs button:not(:disabled):active',
    '.agx-tabs button:not(:disabled):active',
  )
  assert.notEqual(broken, CSS, '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(broken).some((line) => line.includes('预设分类页签') && line.includes('没压过最高基线')))
})

test('反证：删掉底色，检查必须变红', () => {
  const broken = CSS.replace(
    /\.agx-mode-tabs button:not\(:disabled\):active \{[^}]*\}/,
    '.agx-mode-tabs button:not(:disabled):active { color: var(--ink); }',
  )
  assert.notEqual(broken, CSS, '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(broken).some((line) => line.includes('对话 / 图片 / 视频') && line.includes('底色反馈')))
})

test('反证：把 transform 塞进按下态，检查必须变红', () => {
  const broken = CSS.replace(
    '.qc-new:not(:disabled):active {',
    '.qc-new:not(:disabled):active {\n  transform: translateY(1px);',
  )
  assert.notEqual(broken, CSS, '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(broken).some((line) => line.includes('新对话') && line.includes('transform')))
})
