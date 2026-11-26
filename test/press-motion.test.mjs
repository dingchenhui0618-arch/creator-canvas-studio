// r334：按下反馈的「过渡」那一半。
//
// r333 把「按下去有没有变化」清零了（136 颗按钮 · 无反馈候选 22 → 0），但「有变化」不等于
// 「变化走过渡」：没写 transition 的按下是「啪」一下到位（浏览器给的默认值是 transition-property: all、
// duration: 0s，等于没有），和全站按钮（tokens.css 给 .vq-button 的那条）不是一套手感——这一层量后者。
//
// 判据（静态，不开浏览器）：src/styles 里每条 :active 规则声明的每一条属性，必须能在这份 CSS 里
// 找到一条覆盖它的 transition。三条讲究：
//   1) 元素查元素那张表，::after 查伪元素自己那张表——伪元素**不继承**元素的 transition；
//   2) 覆盖可以来自「类更少的同一条选择器」：.works-action.is-danger.is-armed:active 的过渡由
//      .works-action 那条提供（浏览器就是这么算的）；但来自**别的类**（JSX 里同时挂了 .vq-button）
//      的那份静态看不出来，只能逐条列进 ALLOW 并写明原因；
//   3) cursor 不是可过渡属性（CSS 规范里不可动画），直接不算——写进 transition 也没用。
//
// 每条修复都配反证：把那一行删掉，检查必须变红。不这么写就会做出恒真的门禁。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
// 统一成 LF 再断言：仓库里的 CSS 是 CRLF，锚点带 \n 时不然永远匹配不到
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

export const STYLE_DIR = 'src/styles'
export function readStyles() {
  const out = {}
  for (const name of fs.readdirSync(path.join(ROOT, STYLE_DIR)).filter((item) => item.endsWith('.css')).sort()) {
    out[name] = read(path.join(STYLE_DIR, name))
  }
  return out
}

/** 把 CSS 拆成 { media, selector, body }；@media 里的规则带上条件文本（按块上界递归）。 */
export function parseRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const selector = src.slice(i, open).trim()
    let depth = 0
    let close = open
    for (; close < src.length; close += 1) {
      if (src[close] === '{') depth += 1
      else if (src[close] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const body = src.slice(open + 1, close)
    if (selector.startsWith('@')) {
      if (/^@media|^@supports/.test(selector)) {
        for (const inner of parseRules(body)) rules.push({ media: selector, selector: inner.selector, body: inner.body })
      }
    } else {
      rules.push({ media: null, selector: selector, body: body })
    }
    i = close + 1
  }
  return rules
}

/** 按顶层分隔符切：逗号在 var(...) / rgba(...) 里的不算分隔符。 */
export function splitTop(text, sep = ',') {
  const parts = []
  let depth = 0
  let buf = ''
  for (const char of text) {
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (char === sep && depth === 0) { parts.push(buf); buf = '' } else buf += char
  }
  parts.push(buf)
  return parts.map((item) => item.trim()).filter(Boolean)
}

/** 把 :where() / :is() 的逗号列表摊开成一条条选择器。 */
export function expand(selector) {
  let list = [selector]
  for (;;) {
    const next = []
    let hit = false
    for (const one of list) {
      const found = one.match(/:(?:where|is)\(([^()]*)\)/)
      if (!found) { next.push(one); continue }
      hit = true
      for (const alt of splitTop(found[1])) next.push(one.slice(0, found.index) + alt + one.slice(found.index + found[0].length))
    }
    list = next
    if (!hit) return list
  }
}

/** 选择器的「与状态无关」部分：记号只留标签、类名集合、伪元素。 */
export function keyOf(selector) {
  const pe = (selector.match(/::[a-z-]+/g) || []).sort().join('')
  let rest = selector.replace(/::[a-z-]+/g, '').replace(/:not\([^()]*\)/g, '')
  rest = rest.replace(/:(active|hover|focus-visible|focus|focus-within|disabled|visited)\b/g, '')
  rest = rest.replace(/\[[^\]]*\]/g, '')
  const classes = [...new Set((rest.match(/\.[A-Za-z0-9_-]+/g) || []).map((item) => item.slice(1).toLowerCase()))].sort()
  const tag = ((rest.match(/(^|[\s>+~])([a-zA-Z][A-Za-z0-9-]*)/) || [])[2] || '').toLowerCase()
  return { tag: tag, classes: classes, pe: pe }
}

/** 类更少（或相同）的选择器能作用到同一颗元素上——它的 transition 就算数。 */
export function covers(transitionKey, requiredKey) {
  if (transitionKey.pe !== requiredKey.pe) return false
  if (transitionKey.tag !== '' && transitionKey.tag !== requiredKey.tag) return false
  if (!transitionKey.classes.every((name) => requiredKey.classes.includes(name))) return false
  return transitionKey.classes.length > 0 || (transitionKey.tag !== '' && transitionKey.tag !== '*')
}

/** 简写展开：transition-property 里写简写时，真正在动的是这些长属性。 */
export const SHORTHAND_LONGHANDS = {
  background: ['background-color'],
  border: ['border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-bottom': ['border-bottom-color'],
  'border-top': ['border-top-color'],
}

/** 一条 transition 能不能盖住这次要变的属性（两个方向都认简写）。 */
export function coversProp(props, prop) {
  const set = props instanceof Set ? props : new Set(props)
  if (set.has('all') || set.has(prop)) return true
  for (const name of set) if ((SHORTHAND_LONGHANDS[name] || []).includes(prop)) return true
  if (prop === 'background') return set.has('background-color')
  if (prop === 'border') return set.has('border-color')
  if (/^border-(top|right|bottom|left)-color$/.test(prop)) return set.has('border-color')
  return false
}

export function declsOf(body) {
  return splitTop(body, ';').map((item) => {
    const at = item.indexOf(':')
    if (at < 0) return null
    return { prop: item.slice(0, at).trim().toLowerCase(), value: item.slice(at + 1).trim() }
  }).filter(Boolean)
}

export function transitionPropsOf(value) {
  return splitTop(value).map((item) => item.split(/\s+/)[0].trim().toLowerCase()).filter(Boolean)
}

/** 一条规则体里声明的过渡属性集合。 */
export function transitionSetOf(body) {
  const props = new Set()
  for (const item of declsOf(body)) {
    if (item.prop === 'transition') for (const prop of transitionPropsOf(item.value)) props.add(prop)
    if (item.prop === 'transition-property') for (const prop of splitTop(item.value)) props.add(prop.toLowerCase())
  }
  return props
}

/**
 * 全量体检：返回 [{ file, selector, prop, id }]，空数组才算过。
 * 只看 :active 规则；prefers-reduced-motion 里的那几条是「把动效关掉」的覆盖，不看过渡。
 */
export function coverageProblems(files) {
  const problems = []
  for (const [file, css] of Object.entries(files)) {
    const transitions = []
    const actives = []
    for (const rule of parseRules(css)) {
      if (rule.media && /prefers-reduced-motion/.test(rule.media)) continue
      for (const one of splitTop(rule.selector)) {
        for (const selector of expand(one)) {
          const decls = declsOf(rule.body)
          if (decls.some((item) => item.prop === 'transition' || item.prop === 'transition-property')) {
            transitions.push({ key: keyOf(selector), props: transitionSetOf(rule.body) })
          }
          if (/:active\b/.test(selector)) {
            const props = decls
              .filter((item) => !item.prop.startsWith('transition') && !item.prop.startsWith('animation') && item.prop !== 'cursor')
              .map((item) => item.prop)
            actives.push({ selector: selector, props: props })
          }
        }
      }
    }
    for (const rule of actives) {
      const required = keyOf(rule.selector)
      const available = new Set()
      for (const entry of transitions) {
        if (covers(entry.key, required)) for (const prop of entry.props) available.add(prop)
      }
      for (const prop of new Set(rule.props)) {
        if (!coversProp(available, prop)) problems.push({ file: file, selector: rule.selector, prop: prop, id: file + ' :: ' + rule.selector + ' :: ' + prop })
      }
    }
  }
  return problems
}

/**
 * 焦点环那一半：按下时元素会拿到焦点，:focus-within / :focus-visible 上写的东西同样是「按下会看到的变化」。
 * 顶栏搜索那一格就是这么暴露出来的——它没有 :active 规则，按下的反馈全来自 .vq-search:focus-within 的 2px 环。
 */
export function focusRingProblems(css) {
  const rules = parseRules(css).filter((rule) => !rule.media)
  const bodyOf = (selector) => rules.filter((rule) => splitTop(rule.selector).includes(selector)).map((rule) => rule.body).join('\n')
  const available = transitionSetOf(bodyOf('.vq-search'))
  const problems = []
  for (const item of declsOf(bodyOf('.vq-search:focus-within'))) {
    if (item.prop.startsWith('transition') || item.prop === 'cursor') continue
    if (!coversProp(available, item.prop)) problems.push('shell.css :: .vq-search:focus-within :: ' + item.prop)
  }
  return problems
}

/**
 * 白名单：静态看不出来、但真机上确实有过渡的几条。
 * 每条都写清「为什么可以例外」，并且下面有用例检查它仍然成立——
 * 哪天它自己好了（比如改成不用靠别的类了），那一条会红，提醒删掉而不是烂在这儿。
 * cursor 不列在这里：它不是可过渡属性，coverageProblems 直接不算（规则见文件头第 3 条）。
 */
export const ALLOW = [
  { file: 'motion.css', selector: '.vq-card-open.vq-card-open:active', prop: 'transform', why: '这条只是把 tokens.css 的 1px 位移按回 none；按钮自己带 .vq-button，过渡来自 tokens 的 :where(.vq-button, …)' },
  { file: 'promos.css', selector: '.vq-promo-cta.vq-promo-cta:active', prop: 'background', why: '运营位的 CTA 在 PromoSlot.tsx 里是 .vq-button vq-button--ghost（过渡同上）；这条只是把按下配电压到 0-3-0' },
]
const idOfAllow = (item) => item.file + ' :: ' + item.selector + ' :: ' + item.prop

test('r334 · 所有 :active 声明要变的属性都有过渡（白名单之外的 0 条）', () => {
  const problems = coverageProblems(readStyles())
  const allow = new Set(ALLOW.map(idOfAllow))
  const left = problems.filter((item) => !allow.has(item.id))
  assert.deepEqual(left.map((item) => item.id), [], '这些按下还是硬切（没有 transition 覆盖）：\n' + left.map((item) => '  ' + item.id).join('\n'))
})

test('r334 · 白名单没有烂掉：每条例外今天仍然量得到', () => {
  const ids = new Set(coverageProblems(readStyles()).map((item) => item.id))
  const stale = ALLOW.filter((item) => !ids.has(idOfAllow(item)))
  assert.deepEqual(stale.map((item) => idOfAllow(item) + '（' + item.why + '）'), [], '这些例外已经不需要了，删掉对应条目')
})

test('r334 · 简写也算覆盖：transition 写 background，background-color 就是会动', () => {
  // radar.css 的 .drawer-work 写的就是简写命中：computed transition-property 是「border-color, background」，
  // 量具第一版只认全名，把一条真在动的过渡报成了硬切。两个方向都要认。
  assert.equal(coversProp(['background'], 'background-color'), true)
  assert.equal(coversProp(['border'], 'border-bottom-color'), true)
  assert.equal(coversProp(['border-color'], 'border-bottom-color'), true)
  assert.equal(coversProp(['background'], 'color'), false)
})

test('r334 · 按下拿到的焦点环也走过渡（顶栏搜索那一格）', () => {
  const problems = focusRingProblems(readStyles()['shell.css'])
  assert.deepEqual(problems, [], '这一格按下会拿到焦点，焦点环上的属性同样是硬切：\n' + problems.join('\n'))
})

// ---- 反证：把这一轮补的过渡删掉，检查必须变红 ----
const FIXES = [
  {
    name: 'motion.css · 整卡可点的按钮，::after 那层压暗',
    file: 'motion.css',
    from: '  transition: background-color var(--dur-1) var(--ease-out);\n',
    to: '',
    expect: ['motion.css :: .vq-card-open.vq-card-open:active::after :: background'],
  },
  {
    name: 'review.css · 候选卡片的 1px 位移',
    file: 'review.css',
    from: ', transform .15s ease;',
    to: ';',
    expect: ['review.css :: .review-candidate:active :: transform'],
  },
  {
    name: 'shell.css · 行内链接按下压底',
    file: 'shell.css',
    from: '.vq-link {\n  transition: background-color var(--dur-1) var(--ease-out), color var(--dur-1) var(--ease-out);\n}\n\n',
    to: '',
    expect: ['shell.css :: .vq-link:not(:disabled):active :: background', 'shell.css :: .vq-link:not(:disabled):active :: color'],
  },
  {
    name: 'overview.css · 能力卡按钮多出来的圆角',
    file: 'overview.css',
    from: ', border-radius var(--dur-1) var(--ease-out)',
    to: '',
    expect: ['overview.css :: .ov-cap-action:not(.vq-card-open):not(:disabled):active :: border-radius'],
  },
  {
    name: 'agents.css · 四颗只有目标值、没有过渡的按钮',
    file: 'agents.css',
    from: '.agx-surface-switch button,\n.agx-page .agx-capsule-trigger,\n.qc-new,\n.qc-tool {\n  transition: background-color var(--dur-1) var(--ease-out), border-color var(--dur-1) var(--ease-out),\n    color var(--dur-1) var(--ease-out);\n}\n',
    to: '',
    expect: [
      'agents.css :: .agx-surface-switch button:not(:disabled):active :: border-color',
      'agents.css :: .agx-page .agx-capsule-trigger:not(:disabled):active :: color',
      'agents.css :: .qc-new:not(:disabled):active :: background',
      'agents.css :: .qc-tool:not(:disabled):active :: border-color',
    ],
  },
  {
    name: 'agents.css · 对话预设页签按下时的底色',
    file: 'agents.css',
    from: 'transition: color 0.15s ease, background-color var(--dur-1) var(--ease-out);',
    to: 'transition: color 0.15s ease;',
    expect: ['agents.css :: .vq-content .agx-page .agx-tabs button:not(:disabled):active :: background'],
  },
]

test('r334 · 反证：删掉这一轮补的每一条过渡，检查都要变红', () => {
  for (const fix of FIXES) {
    const files = readStyles()
    const before = files[fix.file]
    const count = before.split(fix.from).length - 1
    assert.equal(count, 1, fix.name + '：改坏用的锚点在 ' + fix.file + ' 里出现了 ' + count + ' 次（锚点漂了，这条反证等于没跑）')
    files[fix.file] = before.replace(fix.from, fix.to)
    const ids = new Set(coverageProblems(files).map((item) => item.id))
    for (const expected of fix.expect) {
      assert.ok(ids.has(expected), fix.name + '：删掉之后没有量到 ' + expected + '（门禁是恒真的）')
    }
  }
})

test('r334 · 反证：删掉 .vq-search 的 box-shadow 过渡，焦点环检查要变红', () => {
  const css = readStyles()['shell.css']
  const from = ',\n    box-shadow var(--dur-1) var(--ease-out);'
  assert.equal(css.split(from).length - 1, 1, '锚点漂了，这条反证等于没跑')
  const problems = focusRingProblems(css.replace(from, ';'))
  assert.ok(problems.includes('shell.css :: .vq-search:focus-within :: box-shadow'), '删掉之后没量到 box-shadow：' + JSON.stringify(problems))
})
