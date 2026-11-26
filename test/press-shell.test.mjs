// r332：外壳的按下反馈。r331 的 scripts/audit-press.mjs 在 v0.9.303 产物上真按了 136 个按钮，
// 量出 73 个「按下去和悬停一模一样」，其中最大的一簇就在外壳：12 个侧栏导航项，加账号行、
// 版本号、模型、顶栏账号。这些都不是 .vq-button，tokens.css 那条 :where(...) 够不到，
// 而且在浏览器里「看着都对」——按钮在、hover 也在、就是按下去没有那一拍。
//
// 这条门禁钉住四件事，每一件都能被一次「看起来改完了」的编辑悄悄废掉：
//   1) 五个外壳家族都有一条 :not(:disabled):active 规则，且里面真的有 translateY(1px)；
//      少了 :not(:disabled) 就掉到 (0,2,0)，和 .vq-nav-item.is-active 同权重——
//      于是「当前这一项」按下去又变成没反应（顺序一变就翻车）。
//   2) 按下规则里只许有 transform：口径与 .vq-button 一致（1px，悬停的底色还在），
//      谁顺手在里面换个 background/color，按下那一拍就会和悬停打架。
//   3) .vq-link 是行内元素，按下只压一层底、绝不许位移（行内位移看着像抖了一下）。
//   4) 五个家族的 transition 里必须有 transform，且 prefers-reduced-motion 里要能关掉。
//
// 每条都配一个反证（把源码改坏，检查必须变成「有问题」）——不这么写就会做出恒真的门禁。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SHELL = fs.readFileSync(path.join(ROOT, 'src/styles/shell.css'), 'utf8')

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

const FAMILIES = [
  '.vq-nav-item',
  '.vq-sidebar-account-row',
  '.vq-version-trigger',
  '.vq-model-trigger',
  '.vq-topbar-account-trigger',
]
const REDUCED = /prefers-reduced-motion/

/** 出一份问题清单；空数组 = 这一项没毛病。 */
function shellPressProblems(css) {
  const problems = []
  for (const family of FAMILIES) {
    const body = bodyFor(css, family + ':not(:disabled):active')
    if (!body.trim()) {
      problems.push(family + ' 没有按下规则（' + family + ':not(:disabled):active）——按下去和悬停一模一样')
      continue
    }
    if (!/transform:\s*translateY\(1px\)/.test(body)) {
      problems.push(family + ' 的按下规则里没有 translateY(1px)——那一拍还是没反应')
    }
    if (/background|color|border/.test(body)) {
      problems.push(family + ' 的按下规则里改了底色/边框/颜色；外壳的口径是只位移 1px，悬停的底色还在')
    }
    // 少了 :not(:disabled) 就掉到 (0,2,0)，被 .vq-nav-item.is-active 盖住（顺序一变就翻车）
    const bare = bodyFor(css, family + ':active')
    if (bare.trim() && !bare.includes('translateY')) {
      problems.push(family + ':active 有一条更弱的规则垫着，权重不够压过 .is-active')
    }
  }
  // 四家（含导航项）的 transition 要能过渡 transform：否则按下那一拍是瞬跳，松开也是瞬回
  for (const family of FAMILIES) {
    const body = bodyFor(css, family)
    if (!/transition:[^;]*transform/.test(body)) {
      problems.push(family + ' 的 transition 里没有 transform，按下/松开会瞬间跳')
    }
  }
  // 文字链接只压底、绝不位移
  const link = bodyFor(css, '.vq-link:not(:disabled):active')
  if (!link.trim()) problems.push('.vq-link 没有按下规则')
  else {
    if (!/background:\s*var\(--line-faint\)/.test(link)) problems.push('.vq-link 按下没有压出底色，和悬停一样')
    if (/transform/.test(link)) problems.push('.vq-link 按下位移了；行内元素位移看着像抖了一下')
  }
  // 减弱动效里必须能关掉位移
  for (const family of FAMILIES) {
    const body = bodyFor(css, family + ':not(:disabled):active', REDUCED)
    if (!/transform:\s*none/.test(body)) {
      problems.push('prefers-reduced-motion 里没有把 ' + family + ' 的位移关掉')
    }
  }
  return problems
}

test('外壳五个家族与文字链接都有真的按下反馈', () => {
  assert.deepEqual(shellPressProblems(SHELL), [])
})

test('导航项的按下位移不是恒真断言：改坏源码必须变红', () => {
  const mutations = [
    [
      '把某一族的选择器写错',
      ['.vq-nav-item:not(:disabled):active,', '.vq-navitem:not(:disabled):active,'],
    ],
    [
      '把 1px 位移改成 none',
      [
        '.vq-topbar-account-trigger:not(:disabled):active {\n  transform: translateY(1px);\n}',
        '.vq-topbar-account-trigger:not(:disabled):active {\n  transform: none;\n}',
      ],
    ],
    [
      '把权重降到 .is-active 同级（去掉 :not(:disabled)）',
      [
        '.vq-nav-item:not(:disabled):active,\n.vq-sidebar-account-row:not(:disabled):active,\n.vq-version-trigger:not(:disabled):active,\n.vq-model-trigger:not(:disabled):active,\n.vq-topbar-account-trigger:not(:disabled):active {\n  transform: translateY(1px);',
        '.vq-nav-item:active,\n.vq-sidebar-account-row:not(:disabled):active,\n.vq-version-trigger:not(:disabled):active,\n.vq-model-trigger:not(:disabled):active,\n.vq-topbar-account-trigger:not(:disabled):active {\n  transform: translateY(1px);',
      ],
    ],
    [
      '在按下规则里顺手改底色',
      [
        '.vq-version-trigger:not(:disabled):active,\n.vq-model-trigger:not(:disabled):active,\n.vq-topbar-account-trigger:not(:disabled):active {\n  transform: translateY(1px);\n}',
        '.vq-version-trigger:not(:disabled):active,\n.vq-model-trigger:not(:disabled):active,\n.vq-topbar-account-trigger:not(:disabled):active {\n  transform: translateY(1px);\n  background: var(--line);\n}',
      ],
    ],
    [
      '让文字链接也位移',
      [
        '.vq-link:not(:disabled):active {\n  background: var(--line-faint);\n  color: var(--ink);\n}',
        '.vq-link:not(:disabled):active {\n  background: var(--line-faint);\n  color: var(--ink);\n  transform: translateY(1px);\n}',
      ],
    ],
    [
      '减弱动效里不再关掉位移',
      [
        '.vq-topbar-account-trigger:not(:disabled):active {\n    transform: none;\n  }\n}',
        '.vq-topbar-account-trigger:not(:disabled):active {\n  }\n}',
      ],
    ],
    [
      'transition 里去掉 transform',
      [
        'transition: background 0.14s ease, color 0.14s ease, transform 0.14s ease;',
        'transition: background 0.14s ease, color 0.14s ease;',
      ],
    ],
  ]
  for (const [label, pair] of mutations) {
    const mutated = SHELL.replace(pair[0], pair[1])
    assert.notEqual(mutated, SHELL, '反证没改到源码（锚点漂了）：' + label)
    assert.notDeepEqual(shellPressProblems(mutated), [], '反证没让门禁变红：' + label)
  }
})
