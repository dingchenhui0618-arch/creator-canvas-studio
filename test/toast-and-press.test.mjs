import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * r330：通知不吃点击 + 按下去得有反应。
 *
 * 三件小事都是 r329 巡检量出来的：
 *  1. 右下角的提示条 .vq-toast 压着模板抽屉底部那排操作按钮。抽屉打开后 3.3 秒里，
 *     elementFromPoint(「用它做作品」中心) 命中的是提示条——点它什么都没发生。
 *     纯通知永远不该是 hit target：pointer-events: none；里面真放了按钮再单独放行。
 *  2. 默认档 .vq-button（不带语气 = 透明底）压根没有 :hover。后台「保存运营位」就是这一档，
 *     鼠标放上去一个属性都不变。补一条悬停底色，四个语气各自的 :hover 在源码里排在后面盖住它。
 *  3. 预设卡 .agx-card-main 悬停有整卡抬起、按下什么都不变。补一层按下底色。
 *
 * 这个文件盯三组 CSS 前提，外加每一条的反证（拿掉/挪位就变红）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function read(rel) {
  // 仓库里的文件在 Windows 上是 CRLF：统一成 LF，锚点与反证才按一套写法走
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 所有规则（@media 里的也展开），带：
 *  sel —— 单条选择器；full —— 含 @media 前缀的整条；
 *  at  —— 选择器在原文里的绝对位置（用来判源码顺序）；body —— 声明体。
 */
function allRules(css, prefix = '', from = 0, to = css.length, out = []) {
  let i = from
  while (i < to) {
    const open = css.indexOf('{', i)
    if (open < 0 || open >= to) break
    // 选择器前面常挂一段注释（`split('}').pop()` 会把注释一起带进来）：从最后一段注释之后算起
    const raw = css.slice(i, open).split('}').pop()
    const cut = raw.lastIndexOf('*/') + 2
    const selRaw = raw.slice(cut)
    const sel = selRaw.trim()
    const at = i + cut + (selRaw.length - selRaw.trimStart().length)
    let depth = 0
    let j = open
    for (; j < to; j += 1) {
      if (css[j] === '{') depth += 1
      else if (css[j] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const body = css.slice(open + 1, j)
    if (sel.startsWith('@')) allRules(css, prefix + sel + ' >>> ', open + 1, j, out)
    else if (sel) out.push({ sel, full: prefix + sel, body, at })
    i = j + 1
  }
  return out
}

function rulesFor(css, pattern) {
  return allRules(css).filter((rule) => pattern.test(rule.sel))
}

/** 只看声明，不看注释：正文里的注释常写着「pointer-events:none 让它…」，
    按字面匹配会被注释喂饱，反证就永远红不了。 */
function decls(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, '')
}

function px(body, prop) {
  const m = body.match(new RegExp(prop + '\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px'))
  return m ? Number(m[1]) : null
}

function cssBundle() {
  return { shell: read('src/styles/shell.css'), agents: read('src/styles/agents.css') }
}

/* 抽屉底栏的真实高度：桌面 16 + 32 + 16 + 1px 描边 = 65；
   ≤640 是两行 48px 按钮 12 + 48 + 8 + 48 + 16 + 1 = 133。 */
const FOOT_DESKTOP = 65
const FOOT_NARROW = 133

function toastProblems(css) {
  const problems = []

  const toast = rulesFor(css.shell, /^\.vq-toast$/)
  if (!toast.length) problems.push('shell.css 里没有 .vq-toast 规则')
  else if (!toast.some((rule) => /pointer-events:\s*none/.test(decls(rule.body)))) {
    problems.push('.vq-toast 没写 pointer-events: none：提示条会继续吃掉它压着的按钮的点击')
  }

  // 里面真放了按钮/链接要能点：选择器必须同时点名提示条与可交互元素
  const inner = rulesFor(css.shell, /^\.vq-toast\s+:is\(/).filter((rule) =>
    /pointer-events:\s*auto/.test(decls(rule.body)),
  )
  if (!inner.length) problems.push('缺少「.vq-toast 里的按钮/链接 pointer-events: auto」，条里有动作就点不动')
  else if (!inner.some((rule) => /button/.test(rule.sel) && /a\b/.test(rule.sel))) {
    problems.push('放行规则没同时覆盖 <button> 与 <a>')
  }

  const lift = rulesFor(css.shell, /^body:has\(\.drawer-backdrop\)\s+\.vq-toast$/)
  const locked = lift.find((rule) => !rule.full.includes('@media'))
  if (!locked) problems.push('缺少「抽屉打开时把提示条抬到底栏之上」那条规则')
  else {
    const bottom = px(decls(locked.body), 'bottom')
    if (bottom === null) problems.push('抽屉打开时提示条没有 bottom 值')
    else if (bottom < FOOT_DESKTOP + 16) {
      problems.push('提示条只抬到 ' + bottom + 'px，压得住 ' + FOOT_DESKTOP + 'px 的底栏（至少要 ' + (FOOT_DESKTOP + 16) + 'px）')
    } else if (bottom % 8 !== 0) problems.push('提示条抬起值 ' + bottom + 'px 不在 8pt 栅格上')
  }

  const narrow = lift.find((rule) => rule.full.includes('@media (max-width: 640px)'))
  if (!narrow) problems.push('窄屏没有单独抬一次：≤640 底栏是两行 48px 按钮，比桌面高一截')
  else {
    const bottom = px(decls(narrow.body), 'bottom')
    if (bottom === null || bottom < FOOT_NARROW + 8) {
      problems.push('窄屏提示条抬起值 ' + bottom + 'px 压得住 ' + FOOT_NARROW + 'px 的底栏（至少要 ' + (FOOT_NARROW + 8) + 'px）')
    }
  }

  return problems
}

function pressProblems(css) {
  const problems = []

  const base = rulesFor(css.shell, /^\.vq-button:hover:not\(:disabled\)$/)
  if (!base.length) problems.push('默认档 .vq-button 没有 :hover：透明底按钮悬停一个属性都不变')
  else if (!base.some((rule) => /background(-color)?:\s*\S/.test(decls(rule.body)))) {
    problems.push('默认档 .vq-button:hover 没有背景，悬停看不出来')
  }

  // 四个语气自己的 :hover 必须排在默认档之后（同权重按源码顺序决胜负）
  const variantSel = [
    /^\.vq-button--primary:hover:not\(:disabled\)$/,
    /^\.vq-button--ghost:hover:not\(:disabled\)$/,
    /^\.vq-button--quiet:hover:not\(:disabled\)$/,
    /^\.vq-button--danger:hover:not\(:disabled\)$/,
  ]
  const baseAt = base.length ? base[0].at : -1
  for (const pattern of variantSel) {
    const hit = rulesFor(css.shell, pattern)
    if (!hit.length) {
      problems.push('找不到语气悬停规则 ' + pattern.source)
      continue
    }
    if (hit[0].at < baseAt) {
      problems.push(pattern.source + ' 排在默认档 :hover 前面：默认档会盖掉它自己的悬停')
    }
  }

  // ghost 的底色是实色，必须显式写回自己那条，否则悬停会变成半透明
  const ghost = rulesFor(css.shell, /^\.vq-button--ghost:hover:not\(:disabled\)$/)
  if (ghost.length && !/background(-color)?:\s*var\(--surface-raised\)/.test(decls(ghost[0].body))) {
    problems.push('ghost 悬停没写回自己的 --surface-raised：会被默认档的半透明底色顶掉')
  }

  const agx = rulesFor(css.agents, /^\.agx-card-main:active$/)
  if (!agx.length) problems.push('预设卡 .agx-card-main 没有按下态：按下去什么都不变')
  else if (!/background(-color)?:\s*\S/.test(decls(agx[0].body))) {
    problems.push('.agx-card-main:active 没有底色变化，等于没有按下反馈')
  }

  return problems
}

test('提示条是纯通知：不吃点击，抽屉打开时抬到底栏之上', () => {
  assert.deepEqual(toastProblems(cssBundle()), [])
  // 防扫描走空：规则得真被解析出来
  const shell = read('src/styles/shell.css')
  assert.ok(allRules(shell).length > 300, 'shell.css 只解析出 ' + allRules(shell).length + ' 条规则，解析器可能走空了')
  assert.ok(rulesFor(shell, /^\.vq-toast$/).length === 1)
})

test('按下去有反应：默认档按钮补悬停、预设卡补按下', () => {
  assert.deepEqual(pressProblems(cssBundle()), [])
})

test('反证：上面每一条断言都能真的变红', () => {
  // 1) 提示条又开始吃点击
  {
    const css = cssBundle()
    css.shell = css.shell.replace('  pointer-events: none;\n  /* r324', '  /* r324')
    assert.ok(toastProblems(css).some((p) => p.includes('吃掉它压着的按钮的点击')))
  }

  // 2) 条里的动作按钮不给放行
  {
    const css = cssBundle()
    css.shell = css.shell.replace(".vq-toast :is(a, button, [role='button'], [tabindex]) {", '.vq-toast__none {')
    assert.ok(toastProblems(css).some((p) => p.includes('条里有动作就点不动')))
  }

  // 3) 抽屉打开时不再抬起
  {
    const css = cssBundle()
    css.shell = css.shell.replace('body:has(.drawer-backdrop) .vq-toast {', 'body:has(.drawer-backdrop) .vq-toast--off {')
    assert.ok(toastProblems(css).some((p) => p.includes('抬到底栏之上')))
  }

  // 4) 抬起值压得住底栏（桌面）
  {
    const css = cssBundle()
    css.shell = css.shell.replace('bottom: 88px;', 'bottom: 24px;')
    assert.ok(toastProblems(css).some((p) => p.includes('压得住 65px 的底栏')))
  }

  // 5) 窄屏那条丢了
  {
    const css = cssBundle()
    css.shell = css.shell.replace('@media (max-width: 640px) {\n  body:has(.drawer-backdrop) .vq-toast {\n    bottom: 144px;\n  }\n}\n\n', '')
    assert.ok(toastProblems(css).some((p) => p.includes('窄屏没有单独抬一次')))
  }

  // 6) 默认档的悬停丢了
  {
    const css = cssBundle()
    css.shell = css.shell.replace('.vq-button:hover:not(:disabled) {\n  background: var(--line-faint);\n}', '.vq-button:hover:not(:disabled) {\n  color: var(--ink);\n}')
    assert.ok(pressProblems(css).some((p) => p.includes('悬停看不出来')))
  }

  // 7) ghost 不写回自己的底色：悬停会从实色变成半透明
  {
    const css = cssBundle()
    css.shell = css.shell.replace('.vq-button--ghost:hover:not(:disabled) {\n  background: var(--surface-raised);', '.vq-button--ghost:hover:not(:disabled) {')
    assert.ok(pressProblems(css).some((p) => p.includes('会被默认档的半透明底色顶掉')))
  }

  // 8) 默认档的悬停被挪到语气后面：同权重按源码顺序，语气自己的悬停就被盖了
  {
    const css = cssBundle()
    const rule = '.vq-button:hover:not(:disabled) {\n  background: var(--line-faint);\n}\n'
    css.shell = css.shell.replace(rule, '') + '\n' + rule
    assert.ok(pressProblems(css).some((p) => p.includes('排在默认档 :hover 前面')))
  }

  // 9) 预设卡的按下反馈没了
  {
    const css = cssBundle()
    css.agents = css.agents.replace('.agx-card-main:active {', '.agx-card-main:active-x {')
    assert.ok(pressProblems(css).some((p) => p.includes('没有按下态')))
  }
})
