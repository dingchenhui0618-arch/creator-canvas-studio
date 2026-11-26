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
  // 顺序有讲究：focus 写在 focus-within 前面时，:focus-within 会被切成 .a-within（r336 量出来的量具自身盲区；
  // 悬停那一层没暴露它，是因为那里的目标选择器里没有 :focus-within）
  rest = rest.replace(/:(focus-visible|focus-within|focus|hover|active|disabled|visited)\b/g, '')
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

// ---------- r335：悬停（hover）那一半 ----------
// 划过是最常发生的一次状态变化。判据与按下那一层一样（变了的那条属性必须能在这份 CSS 里找到过渡），
// 但有两处不同，都是这一轮量出来的：
//   1) 过渡池是**全局**的。CSS 不分文件，同一个类在哪份文件里写了 transition 都算数
//      （按下那一层按文件算，是因为那几条修复都落在同一个文件里；这里换个更准的口径）。
//   2) 没有可见边框时，computed 的 border-color 就是 currentColor —— color 一变它必然跟着变，
//      这不是一次反馈。四边宽度全 0 的 border-color 直接不看（浏览器那一层同步修了：见 audit-press.mjs
//      的 hoverDerived / derivedOnPress）。
export const NOT_ANIMATABLE = ['cursor', 'text-decoration', 'border-style', 'background-image', 'display']

/** 这些声明里有没有画出一条真的能看见的边框（透明也算：hover 常常就是把它变成不透明）。 */
/** 选择器里「真正会变的那颗元素」的类名（最后一段复合选择器；:not(...) 里的不算）。 */
export function lastCompoundClasses(selector) {
  const text = selector.replace(/\([^()]*\)/g, '')
  const parts = text.split(/[\s>+~]+/).filter(Boolean)
  const last = parts[parts.length - 1] || ''
  return [...new Set((last.match(/\.[A-Za-z0-9_-]+/g) || []).map((item) => item.slice(1)))]
}

/**
 * 一个复合选择器（没有后代 / 子代 / 兄弟组合符）才能和另一条谈「作用在同一颗元素上」。
 * .agx-media-zoom .agx-media-image 这种两段式的，BEM 那套推不出来，一律不猜。
 */
export function isSimpleSelector(selector) {
  return !/[\s>+~]/.test(selector.replace(/\([^()]*\)/g, ''))
}

/** BEM 修饰类：.a--b 的元素上通常同时挂着 .a（JSX 里就是这么写的，实测 see .vq-nav-item--utility）。 */
export function bemBases(name) {
  const at = name.indexOf('--')
  return at > 0 ? [name.slice(0, at)] : []
}

/**
 * 同一颗元素上的「基类过渡」也算覆盖：.vq-nav-item--utility 的过渡来自 .vq-nav-item。
 * 只对单段选择器生效，而且要求 required 的每一个类都能在过渡那条里找到（自己或它的 BEM 基类）——
 * 否则 .vq-sidebar-account-row--guest .vq-sidebar-account-action 会被祖先那条误当成覆盖。
 */
export function coversFamily(transitionKey, requiredKey) {
  if (transitionKey.pe !== requiredKey.pe) return false
  if (transitionKey.tag !== '' && transitionKey.tag !== requiredKey.tag) return false
  if (!transitionKey.classes.length || !requiredKey.classes.length) return false
  return requiredKey.classes.every((name) => transitionKey.classes.includes(name) || bemBases(name).some((base) => transitionKey.classes.includes(base)))
}

export function declaresVisibleBorder(bodies) {
  for (const body of bodies) {
    for (const item of declsOf(body)) {
      if (item.prop === 'border') {
        const width = item.value.match(/^([0-9.]+)px\s+([a-z-]+)/)
        if (width && Number(width[1]) > 0 && width[2] !== 'none' && width[2] !== 'hidden') return true
      }
      if (/^border(-(top|right|bottom|left))?-width$/.test(item.prop) && parseFloat(item.value) > 0) return true
    }
  }
  return false
}

/** 全量体检：返回 [{ file, selector, prop, id }]，空数组才算过。 */
export function hoverCoverageProblems(files) {
  const pool = []
  const borderRules = []
  for (const [file, css] of Object.entries(files)) {
    for (const rule of parseRules(css)) {
      if (rule.media && /prefers-reduced-motion/.test(rule.media)) continue
      for (const one of splitTop(rule.selector)) {
        for (const selector of expand(one)) {
          const decls = declsOf(rule.body)
          if (decls.some((item) => item.prop === 'transition' || item.prop === 'transition-property')) {
            pool.push({ file: file, key: keyOf(selector), props: transitionSetOf(rule.body), simple: isSimpleSelector(selector) })
          }
          if (decls.some((item) => /^border(-(top|right|bottom|left))?(-width|$)/.test(item.prop))) {
            borderRules.push({ key: keyOf(selector), body: rule.body })
          }
        }
      }
    }
  }
  const problems = []
  for (const [file, css] of Object.entries(files)) {
    for (const rule of parseRules(css)) {
      if (rule.media && /prefers-reduced-motion/.test(rule.media)) continue
      for (const one of splitTop(rule.selector)) {
        for (const selector of expand(one)) {
          if (!/:hover\b/.test(selector)) continue
          const required = keyOf(selector)
          const requiredSimple = isSimpleSelector(selector)
          const available = new Set()
          for (const entry of pool) {
            const same = covers(entry.key, required) || (entry.simple && requiredSimple && coversFamily(entry.key, required))
            if (!same) continue
            for (const prop of entry.props) available.add(prop)
          }
          const borderVisible = declaresVisibleBorder(borderRules.filter((entry) => covers(entry.key, required)).map((entry) => entry.body))
          for (const item of declsOf(rule.body)) {
            if (item.prop.startsWith('transition') || item.prop.startsWith('animation')) continue
            if (NOT_ANIMATABLE.includes(item.prop)) continue
            if (item.prop === 'border-color' && !borderVisible) continue
            if (coversProp(available, item.prop)) continue
            problems.push({ file: file, selector: selector, prop: item.prop, id: file + ' :: ' + selector + ' :: ' + item.prop })
          }
        }
      }
    }
  }
  return problems
}

/**
 * 悬停这一层的白名单。和按下那一层同一条理由：静态看不出来，但运行时确实有过渡。
 * 这几条不能自己再写一条短过渡 —— 那条（类选择器）权重压过 tokens.css 的 :where(...)，
 * 会把 transform / box-shadow 一起挤掉，按下的 1px 位移、卡片压暗就变成硬切（按下那一层会红）。
 */
export const ALLOW_HOVER = [
  // 现在是空的：.vq-button--* 那五条原来在这里，改成 coversFamily 之后它们被
  // tokens.css 的 :where(.vq-button, …) 认出来了（元素上确实同时挂着 .vq-button），
  // 留着会变成「已经不需要的例外」。按下那一层的 ALLOW 不共享这条：那两条是**跨类**，
  // 不是 BEM 家族，静态推不出来，仍然要人写明。
]
const idOfHover = (item) => item.file + ' :: ' + item.selector + ' :: ' + item.prop

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

// ---------- r335 的用例 ----------
test('r335 · 所有 :hover 声明要变的属性都有过渡（白名单之外的 0 条）', () => {
  const problems = hoverCoverageProblems(readStyles())
  const allow = new Set(ALLOW_HOVER.map(idOfHover))
  const left = problems.filter((item) => !allow.has(item.id))
  assert.deepEqual(left.map((item) => item.id), [], '这些划过还是硬切（没有 transition 覆盖）：\n' + left.map((item) => '  ' + item.id).join('\n'))
})

test('r335 · 悬停白名单没有烂掉：每条例外今天仍然量得到', () => {
  const ids = new Set(hoverCoverageProblems(readStyles()).map((item) => item.id))
  const stale = ALLOW_HOVER.filter((item) => !ids.has(idOfHover(item)))
  assert.deepEqual(stale.map((item) => idOfHover(item) + '（' + item.why + '）'), [], '这些例外已经不需要了，删掉对应条目')
})

test('r335 · 没有可见边框时不要求 border-color 的过渡（那是 currentColor 的另一种写法）', () => {
  assert.equal(declaresVisibleBorder(['border: 0; color: var(--muted)']), false)
  assert.equal(declaresVisibleBorder(['border: 1px solid transparent']), true)
  assert.equal(declaresVisibleBorder(['border-width: 1px; border-style: none']), true) // width 写了就算（style 由别的规则兜底）
  assert.equal(declaresVisibleBorder(['border-radius: 8px']), false)
  // 26 条误报的形状：.vq-nav-item 写的是 border: 0，hover 只改 background / color
  const css = { 'x.css': '.a { border: 0; color: #111 }\n.a:hover { color: #000 }\n' }
  assert.deepEqual(hoverCoverageProblems(css).map((item) => item.id), ['x.css :: .a:hover :: color'])
  // 真画了边框的，border-color 才要过渡
  const css2 = { 'x.css': '.a { border: 1px solid transparent }\n.a:hover { border-color: #111 }\n' }
  assert.deepEqual(hoverCoverageProblems(css2).map((item) => item.id), ['x.css :: .a:hover :: border-color'])
})

// ---- r335 的反证：删掉这一层补的过渡，检查必须变红 ----
// 这一层是「一整段追加」的形式（每个文件末尾一段），所以锚点是那段的头一行；
// 先确认段在（不然反证等于没跑），再删掉整段，看检查有没有报出对应的那几条。
const HOVER_SECTION = '/* r335 · 悬停反馈的过渡'
const HOVER_SECTIONS = [
  { file: 'agents.css', expect: ['agents.css :: .agx-history-item:hover :: background', 'agents.css :: .qc-copy:hover :: color', 'agents.css :: .qc-search-item:hover :: border-color'] },
  { file: 'shell.css', expect: ['shell.css :: .vq-toolbar-reset:hover :: color', 'shell.css :: .vq-help-link:hover :: border-color'] },
  { file: 'rooms.css', expect: ['rooms.css :: .rooms-row:hover :: background', 'rooms.css :: .rooms-auto:hover :: color'] },
  { file: 'projects.css', expect: ['projects.css :: .vq-project-source-link:hover :: text-decoration-thickness'] },
  { file: 'legacy-fix.css', expect: ['legacy-fix.css :: .template-card:hover :: box-shadow'] },
]
const HOVER_MERGES = [
  { file: 'overview.css', from: ', border-radius var(--dur-1) var(--ease-out),\n    text-underline-offset var(--dur-1) var(--ease-out)', to: ', border-radius var(--dur-1) var(--ease-out)', expect: 'overview.css :: .ov-cap-action:hover :: text-underline-offset' },
  { file: 'radar.css', from: 'opacity .18s var(--ease-out), color var(--dur-1) var(--ease-out)', to: 'opacity .18s var(--ease-out)', expect: 'radar.css :: .radar-taken-main:hover > svg :: color' },
  { file: 'shell.css', from: ', color var(--dur-1) var(--ease-out),\n    text-underline-offset var(--dur-1) var(--ease-out);', to: ', color var(--dur-1) var(--ease-out);', expect: 'shell.css :: .vq-link:hover :: text-underline-offset' },
  // BEM 家族那两条：修饰类自己不在追加段里，缺的属性并进基类那一条
  { file: 'shell.css', from: 'box-shadow var(--dur-1) var(--ease-out), color var(--dur-1) var(--ease-out);', to: 'box-shadow var(--dur-1) var(--ease-out);', expect: 'shell.css :: .vq-search--trigger:hover :: color' },
  // r336：这条锚点漂过一次 —— 焦点那一轮往同一条过渡尾部并进了 box-shadow，锚点的尾巴（分号）对不上了。
  // 锚点只取到 background-color 那一项为止，后面接什么都不会再让它失效。
  { file: 'share.css', from: ', color .15s ease, background-color .15s ease,', to: ', color .15s ease,', expect: 'share.css :: .share-button--primary:hover :: background' },
]

// r335 踩过的那一脚：.vq-nav-item--utility 自己写一条 transition，把 .vq-nav-item 那条（含 transform，
// 按下 1px 位移）整条盖掉 —— 按下巡检当时是 0 硬切，改完变 3。所以钉一条：追加段里的目标，
// 不能是「基类上已经有过渡」的 BEM 修饰类。修法是并进基类那条，不是自己再写一条。
test('r335 · 追加段里不能出现「基类已有过渡」的 BEM 修饰类（会盖掉基类那条）', () => {
  const files = readStyles()
  const base = {}
  for (const [file, css] of Object.entries(files)) {
    const at = css.indexOf(HOVER_SECTION)
    base[file] = at >= 0 ? css.slice(0, at) : css
  }
  const transitions = []
  for (const css of Object.values(base)) {
    for (const rule of parseRules(css)) {
      for (const one of splitTop(rule.selector)) {
        for (const selector of expand(one)) {
          const decls = declsOf(rule.body)
          if (decls.some((item) => item.prop === 'transition' || item.prop === 'transition-property')) {
            transitions.push({ selector: selector, key: keyOf(selector), simple: isSimpleSelector(selector) })
          }
        }
      }
    }
  }
  const risks = []
  for (const [file, css] of Object.entries(files)) {
    const at = css.indexOf(HOVER_SECTION)
    if (at < 0) continue
    const seg = css.slice(at)
    const block = seg.slice(seg.indexOf('*/') + 2, seg.indexOf('{'))
    for (const one of splitTop(block)) {
      for (const selector of expand(one.trim())) {
        for (const name of lastCompoundClasses(selector)) {
          for (const baseClass of bemBases(name)) {
            const hit = transitions.find((entry) => entry.simple && entry.key.classes.includes(baseClass))
            if (hit) risks.push(file + ' :: ' + selector + '（基类 .' + baseClass + ' 上已有过渡：' + hit.selector + '）')
          }
        }
      }
    }
  }
  assert.deepEqual(risks, [], '这些目标自己再写一条会把基类那条整条盖掉（transform / box-shadow 会退回硬切）：\n' + risks.join('\n'))
})

test('r335 · 反证：删掉这一层追加的过渡段，检查都要变红', () => {
  for (const fix of HOVER_SECTIONS) {
    const files = readStyles()
    const at = files[fix.file].indexOf(HOVER_SECTION)
    assert.ok(at > 0, fix.file + ' 里找不到 r335 那一段（锚点漂了，这条反证等于没跑）')
    files[fix.file] = files[fix.file].slice(0, at)
    const ids = new Set(hoverCoverageProblems(files).map((item) => item.id))
    for (const expected of fix.expect) assert.ok(ids.has(expected), fix.file + '：删掉之后没有量到 ' + expected + '（门禁是恒真的）')
  }
})

test('r335 · 反证：把并进原声明的那几条再拿掉，检查要变红', () => {
  for (const fix of HOVER_MERGES) {
    const files = readStyles()
    const count = files[fix.file].split(fix.from).length - 1
    assert.equal(count, 1, fix.file + '：改坏用的锚点出现了 ' + count + ' 次（锚点漂了，这条反证等于没跑）')
    files[fix.file] = files[fix.file].replace(fix.from, fix.to)
    const ids = new Set(hoverCoverageProblems(files).map((item) => item.id))
    assert.ok(ids.has(fix.expect), fix.file + '：拿掉之后没有量到 ' + fix.expect + '（门禁是恒真的）')
  }
})

test('r335 · 非动画属性不要求过渡（列在这里、不在别处）', () => {
  assert.deepEqual(NOT_ANIMATABLE, ['cursor', 'text-decoration', 'border-style', 'background-image', 'display'])
  const css = { 'x.css': '.a:hover { text-decoration: underline; text-underline-offset: 3px }\n' }
  assert.deepEqual(hoverCoverageProblems(css).map((item) => item.id), ['x.css :: .a:hover :: text-underline-offset'])
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
    from: '.vq-link {\n  transition: background-color var(--dur-1) var(--ease-out), color var(--dur-1) var(--ease-out),\n    text-underline-offset var(--dur-1) var(--ease-out);\n}\n\n',
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

// ---------- r336：键盘焦点（focus）那一层 ----------
// 与鼠标那三层同一个口径，但读的是**另一张属性表**（多了 outline 四件套），而且多了两条自我纠正：
//   1) outline-style 是离散属性（none ↔ auto），规范里不做补间 —— 焦点环「从无到有」是平台行为，
//      不是这一页的设计选择，所以「环出现」那一下不进硬切判定（运行时那一半同步这么做：见 audit-press.mjs 的 ringAppeared）；
//   2) 环压根没画出来（style none / 宽度 0 / 颜色全透明）时，computed 的 outline-color / offset / width
//      还在变，但屏幕上什么都没有 —— 与 r335 的 border-color 是同一种「不是反馈的变化」。
// 静态这一层管两件事：
//   A) 把 UA 焦点框按掉的规则，必须自己补一个看得见的东西，或者交给祖先的 :focus-within、
//      同一颗元素的兄弟焦点规则（:focus 按掉、:focus-visible 补一道环）；
//   B) 用 box-shadow / 边框画的焦点环，必须在元素自己的过渡表里有对应的一条 —— 否则环是啪一下出来的。
export function readFocusStyles() {
  // 焦点这一层要看 src/App.css：顶栏与模板库的搜索框（.search-box / .inline-search）写在那儿
  const out = readStyles()
  out['App.css'] = read('src/App.css')
  return out
}

const OUTLINE_PROPS = /^outline(-(style|width|color))?$/
const FOCUS_RING_PROPS = ['box-shadow', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'background-color', 'background', 'color', 'transform', 'opacity']

/** 这条规则有没有把 UA 的焦点框按掉（outline: none / 0 / outline-style: none / outline-width: 0）。 */
export function killsOutline(body) {
  for (const item of declsOf(body)) {
    if (!/^(outline|outline-style|outline-width)$/.test(item.prop)) continue
    const value = item.value.trim().toLowerCase()
    if (/^(none|0|0px)(\s|$)/.test(value)) return true
  }
  return false
}

/** 这条规则有没有给出一处看得见的变化（含自己画一道 outline）。 */
export function compensates(body) {
  for (const item of declsOf(body)) {
    if (/^(transition|animation)/.test(item.prop)) continue
    if (OUTLINE_PROPS.test(item.prop)) {
      const value = item.value.trim().toLowerCase()
      if (/^(none|0|0px)\b/.test(value) || value.indexOf('transparent') >= 0) continue
      return true
    }
    if (!/^(box-shadow|border|border-color|border-width|background|background-color|color|transform|opacity|filter|text-decoration)/.test(item.prop)) continue
    const value = item.value.trim().toLowerCase()
    if (value === 'none' || value === 'transparent' || value === '0' || value === '0px') continue
    return true
  }
  return false
}

/** :focus-within 的那条（祖先接走了焦点提示）能不能算这颗元素的补偿：祖先里要有同一个类。 */
export function ancestorCarriesClass(withInSelector, targetSelector) {
  const wanted = keyOf(withInSelector).classes
  if (!wanted.length) return false
  const text = targetSelector.replace(/\([^()]*\)/g, '')
  const ancestors = text.split(/[\s>+~]+/).filter(Boolean).slice(0, -1)
  for (const compound of ancestors) {
    const names = (compound.match(/\.[A-Za-z0-9_-]+/g) || []).map((item) => item.slice(1).toLowerCase())
    if (wanted.every((name) => names.includes(name))) return true
  }
  return false
}

/** A) 杀掉 outline 又没有补偿的焦点规则（白名单之外应当是空的）。 */
export function focusCompensationProblems(files, allow = []) {
  const rules = []
  for (const [file, css] of Object.entries(files)) {
    for (const rule of parseRules(css)) {
      if (rule.media && /prefers-reduced-motion/.test(rule.media)) continue
      for (const one of splitTop(rule.selector)) {
        for (const selector of expand(one)) rules.push({ file: file, selector: selector, body: rule.body })
      }
    }
  }
  const focusRules = rules.filter((rule) => /:focus(-visible)?\b/.test(rule.selector))
  const withIn = rules.filter((rule) => /:focus-within\b/.test(rule.selector))
  const problems = []
  for (const rule of focusRules) {
    if (!killsOutline(rule.body) || compensates(rule.body)) continue
    if (withIn.some((entry) => compensates(entry.body) && ancestorCarriesClass(entry.selector, rule.selector))) continue
    if (focusRules.some((other) => other !== rule && covers(keyOf(other.selector), keyOf(rule.selector)) && compensates(other.body))) continue
    if (allow.some((item) => item.file === rule.file && item.selector === rule.selector)) continue
    problems.push({ file: rule.file, selector: rule.selector, prop: 'outline', id: rule.file + ' :: ' + rule.selector + ' :: outline' })
  }
  return problems
}

/** B) 画了焦点环、但元素自己的过渡表里没有这条属性的规则。 */
export function focusRingMotionProblems(files) {
  const pool = []
  for (const [file, css] of Object.entries(files)) {
    for (const rule of parseRules(css)) {
      if (rule.media && /prefers-reduced-motion/.test(rule.media)) continue
      for (const one of splitTop(rule.selector)) {
        for (const selector of expand(one)) {
          if (declsOf(rule.body).some((item) => item.prop === 'transition' || item.prop === 'transition-property')) {
            pool.push({ file: file, key: keyOf(selector), props: transitionSetOf(rule.body), simple: isSimpleSelector(selector) })
          }
        }
      }
    }
  }
  const problems = []
  for (const [file, css] of Object.entries(files)) {
    for (const rule of parseRules(css)) {
      if (rule.media && /prefers-reduced-motion/.test(rule.media)) continue
      for (const one of splitTop(rule.selector)) {
        for (const selector of expand(one)) {
          if (!/:focus(-visible)?\b/.test(selector)) continue
          const required = keyOf(selector)
          const requiredSimple = isSimpleSelector(selector)
          const available = new Set()
          for (const entry of pool) {
            if (covers(entry.key, required) || (entry.simple && requiredSimple && coversFamily(entry.key, required))) {
              for (const prop of entry.props) available.add(prop)
            }
          }
          for (const item of declsOf(rule.body)) {
            // outline 那几条是平台画的那道环：离散属性，写过渡也没用（文件头第 1 条）
            if (/^(transition|animation|outline)/.test(item.prop)) continue
            if (!FOCUS_RING_PROPS.includes(item.prop)) continue
            const value = item.value.trim().toLowerCase()
            if (value === 'none' || value === 'transparent') continue
            if (coversProp(available, item.prop)) continue
            problems.push({ file: file, selector: selector, prop: item.prop, id: file + ' :: ' + selector + ' :: ' + item.prop })
          }
        }
      }
    }
  }
  return problems
}

/**
 * 焦点这一层的白名单：唯一一条是「容器卡片，不是控件」——
 * 打开时焦点是脚本放到卡片自己身上的（读屏会念出标题），给它画焦点圈反而像可点。
 * 下面有用例检查它仍然成立：哪天这条规则不在了，用例会红，提醒删掉而不是烂在这儿。
 */
export const ALLOW_FOCUS = [
  { file: 'assets.css', selector: '.vq-gate-card:focus', why: '给「先看三个方向」那张引导卡的容器：focus 是脚本给它做读屏锚点的，它不是控件，不画焦点圈（assets.css 里那行注释就是为此写的）' },
]

test('r336 · 杀掉 outline 的焦点规则必须有补偿（白名单之外 0 条）', () => {
  const problems = focusCompensationProblems(readFocusStyles(), ALLOW_FOCUS)
  assert.deepEqual(problems.map((item) => item.id), [], problems.map((item) => item.id).join('\n'))
})

test('r336 · 焦点白名单没有烂掉：每条例外今天仍然量得到', () => {
  const files = readFocusStyles()
  for (const item of ALLOW_FOCUS) {
    const without = focusCompensationProblems(files, [])
    assert.ok(without.some((row) => row.file === item.file && row.selector === item.selector), item.file + ' :: ' + item.selector + ' 今天已经不缺补偿了，把这条例外删掉（原因：' + item.why + '）')
  }
})

test('r336 · 焦点环必须声明过渡（画了环却没过渡的 0 条）', () => {
  const problems = focusRingMotionProblems(readFocusStyles())
  assert.deepEqual(problems.map((item) => item.id), [], problems.map((item) => item.id).join('\n'))
})

test('r336 · :focus-within 不能被 keyOf 当成 -within 后缀的类名', () => {
  assert.deepEqual(keyOf('.vq-search:focus-within').classes, ['vq-search'])
  assert.deepEqual(keyOf('.runs-search input:focus-visible').classes, ['runs-search'])
})

test('r336 · 反证：拿掉 .lw-composer 补的那道焦点环，补偿检查要变红', () => {
  const files = readFocusStyles()
  const from = '\n.lw-composer textarea:focus-visible { outline: 2px solid var(--ink); outline-offset: 4px; border-radius: var(--radius-xs); }'
  assert.equal(files['local-workspace.css'].split(from).length - 1, 1, '锚点漂了，这条反证等于没跑')
  files['local-workspace.css'] = files['local-workspace.css'].replace(from, '')
  const ids = new Set(focusCompensationProblems(files).map((item) => item.id))
  assert.ok(ids.has('local-workspace.css :: .lw-composer textarea:focus :: outline'), '拿掉补的那道环之后没量到黑洞：' + JSON.stringify([...ids]))
})

test('r336 · 反证：删掉基类过渡里的 box-shadow，环过渡检查要变红', () => {
  const files = readFocusStyles()
  const from = 'background-color var(--dur-1) var(--ease-out), box-shadow var(--dur-1) var(--ease-out);'
  assert.equal(files['promos.css'].split(from).length - 1, 1, '锚点漂了，这条反证等于没跑')
  files['promos.css'] = files['promos.css'].replace(from, 'background-color var(--dur-1) var(--ease-out);')
  const ids = new Set(focusRingMotionProblems(files).map((item) => item.id))
  assert.ok(ids.has('promos.css :: .vq-promo-close:focus-visible :: box-shadow'), '删掉之后没量到会硬切的那道环：' + JSON.stringify([...ids]))
})

test('r336 · 原生控件的过渡不许把 button 一起写进来（tag 权重压过 :where(.vq-button, …)）', () => {
  const css = readStyles()['tokens.css']
  for (const rule of parseRules(css)) {
    for (const one of splitTop(rule.selector)) {
      const selector = one.trim()
      if (!/^(input|select|textarea)(\s*,|$)/.test(selector) && !/, *\b(input|select|textarea)\b/.test(selector)) continue
      if (!declsOf(rule.body).some((item) => item.prop === 'transition' || item.prop === 'transition-property')) continue
      assert.ok(!/(^|,)\s*button\s*(,|$)/.test(selector), '这条过渡里带了 button：' + selector + '（tag 选择器会盖掉 :where(.vq-button, …) 那条，按下位移变成硬切）')
    }
  }
  // 全站按钮那条必须还是完整的五条（哪天被谁换掉，这里先红）
  const buttonRule = parseRules(css).find((rule) => rule.selector.indexOf(':where(.vq-button, .cv-bdc-action, .cv-palette-item)') === 0)
  const props = transitionSetOf(buttonRule.body)
  for (const prop of ['background-color', 'border-color', 'color', 'transform', 'box-shadow']) {
    assert.ok(props.has(prop), ':where(.vq-button, …) 的过渡少了 ' + prop)
  }
})

test('r334 · 反证：删掉 .vq-search 的 box-shadow 过渡，焦点环检查要变红', () => {
  const css = readStyles()['shell.css']
  const from = ',\n    box-shadow var(--dur-1) var(--ease-out), color var(--dur-1) var(--ease-out);'
  assert.equal(css.split(from).length - 1, 1, '锚点漂了，这条反证等于没跑')
  const problems = focusRingProblems(css.replace(from, ';'))
  assert.ok(problems.includes('shell.css :: .vq-search:focus-within :: box-shadow'), '删掉之后没量到 box-shadow：' + JSON.stringify(problems))
})
