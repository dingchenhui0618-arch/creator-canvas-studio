// r333：按下反馈第三批。r331 的 scripts/audit-press.mjs 在 v0.9.304 产物上真按了 136 个按钮，
// 量出 21 个「按下去和悬停一模一样」，全落在工作台、模板库、模板详情抽屉与作品流这四处。
// r332 清掉了 44 条（外壳 16 / 文字链接 6 / agents 22），这一批收尾剩下的。
//
// 「怎么按」按目标大小分三档（口径与逐块证据记在 docs/r333-press-details-2026-11-27.md）：
//   move —— 有盒子的小按钮（胶囊 / 药丸 / 小描边按钮）：位移 1px，与全站 .vq-button 同口径。
//           位移是另一条属性，不必跟各自的 .is-active 抢配色权重，「当前这一项」按下去也有反应；
//           少了 :not(:disabled) 就掉到 (0,2,0)，顺序一变就会被 .is-active 盖掉变成没反应。
//   fill —— 整行 / 纯文字按钮：只压一层底（--line-faint），绝不位移
//           （行内位移看着像抖了一下，整行位移像布局抖；r332 的文字链接同此）。
//   dim  —— 大块图片按钮（作品缩略图）：一档变淡（opacity 0.9）。1px 在 271px 宽的图上等于没动，
//           而 opacity 不像 transform 那样给绝对定位后代（.works-tag / .works-fallback）另立包含块。
//
// 另外钉住 r326 那条不变量：整卡热区（.vq-card-open）永远不许位移——带 transform 的元素会成为
// 绝对定位后代的包含块，按下的一瞬间 ::after 的参照从整张卡变成按钮自己，点了正文什么也不会发生，
// 而编译、样式、单测全都看不出问题。它的反馈只画在 ::after 的底色上。
//
// 每条都配反证（把源码改坏，检查必须变成「有问题」）——不这么写就会做出恒真的门禁。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
// 统一成 LF 再断言：仓库里的 CSS 是 CRLF，反证的锚点带 \n 时不然永远匹配不到
// （那样反证会以「锚点漂了」的名义红掉，看着像守卫生效，其实什么都没验）。
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const CSS = {
  shell: read('src/styles/shell.css'),
  overview: read('src/styles/overview.css'),
  works: read('src/styles/works.css'),
  radar: read('src/styles/radar.css'),
  motion: read('src/styles/motion.css'),
}

/** 把 CSS 拆成 { media, selector, body }。@media 里的规则带上条件文本（按块上界递归，不重解析全文）。 */
function parseRules(css) {
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

const selectorsOf = (rule) => rule.selector.split(',').map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean)

/** 所有命中这个选择器的规则体（同一条选择器可能在多处出现，全部拼起来看）。 */
function bodyFor(css, selector, mediaRe) {
  const hit = parseRules(css).filter((rule) => {
    if (mediaRe) return rule.media !== null && mediaRe.test(rule.media) && selectorsOf(rule).includes(selector)
    return rule.media === null && selectorsOf(rule).includes(selector)
  })
  return hit.map((rule) => rule.body).join('\n')
}

const REDUCED = /prefers-reduced-motion/

// 这一批要盯的家族：file 决定读哪个文件，kind 决定按下该长什么样。
const SPECS = [
  { file: 'shell', family: '.vq-filter-chip', kind: 'move' },
  { file: 'overview', family: '.vq-template-row', kind: 'fill', border: true },
  // 这一族的选择器自带 :not(.vq-card-open)（保护整卡可点的那三颗），基样式仍在 .ov-cap-action 上
  { file: 'overview', family: '.ov-cap-action:not(.vq-card-open)', base: '.ov-cap-action', kind: 'fill' },
  { file: 'works', family: '.works-chip', kind: 'move' },
  { file: 'works', family: '.works-gap-retry', kind: 'move' },
  { file: 'works', family: '.works-thumb', kind: 'dim' },
  { file: 'works', family: '.works-open', kind: 'fill' },
  { file: 'works', family: '.works-action', kind: 'fill', underline: true },
  { file: 'radar', family: '.template-adapt', kind: 'move' },
  { file: 'radar', family: '.drawer-work', kind: 'fill', border: true },
]

/** 出一份问题清单；空数组 = 这一批没毛病。 */
function pressProblems(cssMap, specs) {
  const problems = []
  for (const spec of specs) {
    const css = cssMap[spec.file]
    const where = spec.file + ' ' + spec.family
    const active = spec.family + ':not(:disabled):active'
    const body = bodyFor(css, active)
    if (!body.trim()) {
      problems.push(where + ' 没有按下规则（' + active + '）——按下去和悬停一模一样')
      continue
    }
    if (spec.kind === 'move') {
      if (!/transform:\s*translateY\(1px\)/.test(body)) problems.push(where + ' 的按下规则里没有 translateY(1px)——那一拍还是没反应')
      if (/background|color:|border/.test(body)) problems.push(where + ' 的按下规则里改了底色/边框/颜色；这一档只位移，悬停的底色还在')
    } else if (spec.kind === 'fill') {
      if (!/background:\s*var\(--line-faint\)/.test(body)) problems.push(where + ' 按下没有压出 --line-faint 的底，和悬停一样')
      if (/transform/.test(body)) problems.push(where + ' 按下位移了；整行 / 纯文字按钮位移看着像抖')
      if (spec.border && !/border-color:\s*var\(--line-strong\)/.test(body)) problems.push(where + ' 按下没有把描边加深')
      if (spec.underline && !/border-bottom-color/.test(body)) problems.push(where + ' 按下时下划线没跟着变实')
    } else if (spec.kind === 'dim') {
      if (!/opacity:\s*0?\.9/.test(body)) problems.push(where + ' 按下没有变淡（opacity 0.9）')
      if (/transform/.test(body)) problems.push(where + ' 按下位移了；大块图片按钮这一档用变淡')
    }
    // 作品流那两颗「用作参考 / 下载」以外还有一颗删除：上膛之后按下去仍是危险色，
    // 否则按下的黑字会让人以为上膛被取消了（这一条只在那颗按钮上生效，所以单独钉）
    if (spec.file === 'works' && spec.family === '.works-action') {
      const armed = bodyFor(css, '.works-action.is-danger.is-armed:not(:disabled):active')
      if (!armed.trim()) problems.push('.works-action.is-danger.is-armed 没有按下规则：上膛的删除按下去会掉回普通色')
      else {
        // 前面那个 (?<!-) 不能省：border-bottom-color: var(--danger) 里也含 "color: var(--danger)"，
        // 少了它，把文字色改成普通色也不会变红（门禁恒真）。
        if (!/(?<!-)color:\s*var\(--danger\)/.test(armed)) problems.push('.works-action.is-danger.is-armed 按下时不是危险色')
        if (!/border-bottom-color:\s*var\(--danger\)/.test(armed)) problems.push('.works-action.is-danger.is-armed 按下时下划线不是危险色')
      }
    }
    // 被改的那条属性必须在该元素自己的 transition 里：否则按下与松开都是硬切，不是「压下去」
    const need = spec.kind === 'move' ? 'transform' : spec.kind === 'dim' ? 'opacity' : 'background(-color)?'
    if (!new RegExp('transition:[^;]*' + need).test(bodyFor(css, spec.base || spec.family))) {
      problems.push(where + ' 的 transition 里没有 ' + need + '，按下/松开会瞬间跳')
    }
    // 减弱动效里必须能关掉位移（motion.css 的全局 reduce 只压时长，不取消位移）
    if (spec.kind === 'move' && !/transform:\s*none/.test(bodyFor(css, active, REDUCED))) {
      problems.push('prefers-reduced-motion 里没有把 ' + where + ' 的位移关掉')
    }
  }
  return problems
}

test('r333 十个家族都有真的按下反馈', () => {
  assert.deepEqual(pressProblems(CSS, SPECS), [])
})

test('整卡热区（.vq-card-open）永远不许位移，反馈只画在 ::after 的底色上（r326 不变量）', () => {
  const open = bodyFor(CSS.motion, '.vq-card-open.vq-card-open:active')
  assert.match(open, /transform:\s*none/, 'motion.css 里必须显式把 .vq-card-open 的按下位移按回 none')
  const afterBody = bodyFor(CSS.motion, '.vq-card-open.vq-card-open:active::after')
  assert.match(afterBody, /background:\s*var\(--line-faint\)/, '整卡可点的那一拍必须压在 ::after 的底上')
  for (const [name, css] of Object.entries(CSS)) {
    for (const rule of parseRules(css)) {
      if (!/:active/.test(rule.selector)) continue
      if (!selectorsOf(rule).some((part) => part.includes('.vq-card-open'))) continue
      assert.doesNotMatch(rule.body, /translateY\(\s*[1-9]/, name + ' 给 ' + rule.selector + ' 加了位移：按下瞬间 ::after 热区会从整卡塌成按钮大小（r326）')
    }
  }
})

test('按下反馈不是恒真断言：把源码改坏必须变红', () => {
  const mutations = [
    ['shell 掉权重（去掉 :not(:disabled)）', 'shell', '.vq-filter-chip:not(:disabled):active {', '.vq-filter-chip:active {'],
    ['shell 位移改成 0', 'shell', '.vq-filter-chip:not(:disabled):active {\n  transform: translateY(1px);', '.vq-filter-chip:not(:disabled):active {\n  transform: translateY(0);'],
    ['shell 减弱动效里不再关掉位移', 'shell', '.vq-filter-chip:not(:disabled):active {\n    transform: none;', '.vq-filter-chip:not(:disabled):active {\n    transform: translateY(1px);'],
    ['works 缩略图不再变淡', 'works', '.works-thumb:not(:disabled):active { opacity: 0.9; }', '.works-thumb:not(:disabled):active { opacity: 1; }'],
    ['works 胶囊的 transition 丢了 transform', 'works', 'color var(--dur-1) var(--ease-out), transform var(--dur-1) var(--ease-out);', 'color var(--dur-1) var(--ease-out);'],
    ['works 动作按钮的底改成透明', 'works', '.works-action:not(:disabled):active {\n  background: var(--line-faint);', '.works-action:not(:disabled):active {\n  background: transparent;'],
    ['radar 药丸在按下规则里顺手改底色', 'radar', '.template-adapt:not(:disabled):active {\n  transform: translateY(1px);\n}', '.template-adapt:not(:disabled):active {\n  transform: translateY(1px);\n  background: var(--line-faint);\n}'],
    ['radar 抽屉行不再压底', 'radar', '.drawer-work:not(:disabled):active {\n  background: var(--line-faint);', '.drawer-work:not(:disabled):active {\n  background: var(--surface-raised);'],
    ['overview 整行偷偷位移', 'overview', '.vq-template-row:not(:disabled):active {\n  background: var(--line-faint);', '.vq-template-row:not(:disabled):active {\n  background: var(--line-faint);\n  transform: translateY(1px);'],
    ['overview 文字按钮丢了「排除整卡可点」的 :not(.vq-card-open)', 'overview', '.ov-cap-action:not(.vq-card-open):not(:disabled):active {', '.ov-cap-action:not(:disabled):active {'],
    ['works 上膛的删除按下丢掉危险色', 'works', '.works-action.is-danger.is-armed:not(:disabled):active {\n  color: var(--danger);', '.works-action.is-danger.is-armed:not(:disabled):active {\n  color: var(--ink);'],
  ]
  for (const [label, file, from, to] of mutations) {
    const mutated = CSS[file].replace(from, to)
    assert.notEqual(mutated, CSS[file], '反证没改到源码（锚点漂了）：' + label)
    const map = Object.assign({}, CSS, { [file]: mutated })
    assert.notDeepEqual(pressProblems(map, SPECS), [], '反证没让门禁变红：' + label)
  }
})
