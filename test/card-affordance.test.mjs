import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * r329：抬起 = 能点。
 *
 * 卡片悬停抬起来，就是在说「这张卡能点」。可点不等于可达：
 *  - 一整块 <article onClick> 鼠标点得动，键盘永远到不了，读屏也不知道它是个控件；
 *  - 只有右下角一颗小按钮能点的卡片，抬起来了却「按不动」——运营位 r326 修过一次，
 *    工作台首屏那四张能力卡一直是原样。
 * 统一做法沿用 r326：卡片里放一颗真按钮，挂 .vq-card-open，由它的 ::after 铺满整张卡。
 * 这个文件盯三件事：每张会抬起的卡片都有真入口、不可点的卡片不许抬起、热区那三条 CSS 前提。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else if (/\.tsx$/.test(name)) out.push(path)
  }
  return out
}

function sources() {
  const map = new Map()
  for (const path of walk(join(ROOT, 'src'))) {
    const file = relative(ROOT, path).replace(/\\/g, '/')
    // 仓库里的文件在 Windows 上是 CRLF：统一成 LF，下面所有锚点与反证才按一套写法走
    map.set(file, readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))
  }
  return map
}

function lineOf(source, at) {
  return source.slice(0, at).split('\n').length
}

/** 取 vq-lift 所在的那个标签本身：<article className="template-card vq-lift" ...> */
function tagOf(source, at) {
  const start = source.lastIndexOf('<', at)
  let depth = 0
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1)
  }
  return source.slice(start)
}

/** <button> / <a> 自己就能接键盘，不用热区。 */
function nativeClickable(tag) {
  return /^<(button|a)[\s>]/.test(tag)
}

/**
 * 每张会抬起的卡片都得有一个真入口：
 * 非 button/a 的 lift 宿主，同一文件里必须有同样数量的 .vq-card-open（一颗按钮铺一张卡）。
 * 按「文件内数量」比而不是「文件里出现过」，是为了删掉其中一颗时能真的变红。
 */
function liftProblems(map) {
  const problems = []
  let cards = 0
  let hotzones = 0
  for (const [file, source] of map) {
    // 只在 className 里找：文件顶上那句注释写了「.vq-lift」，按字面找会把它当成一张卡片
    const tags = []
    const re = /className=(?:"[^"]*"|\{[^}]*\})/g
    let m
    while ((m = re.exec(source))) {
      if (!/vq-lift/.test(m[0])) continue
      const tag = tagOf(source, m.index)
      if (!nativeClickable(tag)) tags.push({ tag, at: m.index })
    }
    // 只数 className 里的：注释里写一句 .vq-card-open 也会被字面匹配，反证就被吃掉了
    const open = (source.match(/className=(?:"[^"]*vq-card-open[^"]*"|\{`[^`]*vq-card-open[^`]*`\})/g) || []).length
    cards += tags.length
    hotzones += open
    if (tags.length > open) {
      problems.push(
        file +
          '：' +
          tags.length +
          ' 张会抬起的卡片只有 ' +
          open +
          ' 个 .vq-card-open（第 ' +
          lineOf(source, tags[tags.length - 1].at) +
          ' 行那张没有真入口）',
      )
    }
  }
  return { problems, cards, hotzones }
}

/** 一段 CSS 里所有规则的 { 选择器, 声明体 }（顶层；@media 内部不再展开）。 */
function rules(css) {
  const out = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const sel = css.slice(i, open).split(/[};]/).pop().trim()
    let depth = 0
    let j = open
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1
      else if (css[j] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    out.push({ sel, body: css.slice(open + 1, j) })
    i = j + 1
  }
  return out
}

function bodiesFor(css, pattern) {
  return rules(css).filter((rule) => pattern.test(rule.sel)).map((rule) => rule.body)
}

/**
 * 热区的三条前提，少一条就是「看着能点、点了没反应」：
 *  1. ::after 铺满整张卡（position: absolute + inset: 0）；
 *  2. 按下不许位移——带 transform 的元素会成为绝对定位后代的包含块，按下那一刻热区就塌回按钮那么大
 *     （r326 在运营位上真机实测过：mousedown 落在按钮、mouseup 落回标题、click 落在卡片上，什么也没发生）；
 *  3. 按钮自己不许定位——一按钮化，::after 的参照就从卡片变成按钮，热区只剩按钮那么大。
 * 另外两张宿主卡片自己必须是 position: relative，否则 ::after 找不到参照物。
 */
function hotzoneProblems(css) {
  const problems = []
  const after = bodiesFor(css.motion, /\.vq-card-open::after$/)
  if (!after.length) problems.push('motion.css 里没有 .vq-card-open::after（整卡热区）')
  for (const body of after) {
    if (!/position:\s*absolute/.test(body)) problems.push('.vq-card-open::after 没有 position: absolute，热区不铺满')
    if (!/inset:\s*0/.test(body)) problems.push('.vq-card-open::after 没有 inset: 0，热区不铺满')
  }

  const pressed = bodiesFor(css.motion, /\.vq-card-open\.vq-card-open:active$/)
  if (!pressed.length) problems.push('缺少 .vq-card-open.vq-card-open:active（按下反馈）')
  for (const body of pressed) {
    if (!/transform:\s*none/.test(body)) problems.push('按下时没把 transform 关掉：热区会在按下那一刻塌回按钮')
  }

  // 只看「作用在按钮自己身上」的规则：::after 那条本来就该 position: absolute，不是它的错
  const selfRules = rules(css.motion).filter((rule) => /\.vq-card-open$/.test(rule.sel))
  for (const rule of selfRules) {
    if (/position:\s*(relative|absolute|fixed|sticky)/.test(rule.body)) {
      problems.push('.vq-card-open 自己被定位了：::after 的参照会从卡片变成按钮，热区只剩按钮那么大')
    }
  }

  const anchors = [
    ['src/styles/overview.css', /\.ov-cap$/, '工作台能力卡'],
    ['src/App.css', /\.template-card$/, '模板库卡片'],
  ]
  for (const [file, pattern, label] of anchors) {
    const hit = bodiesFor(css[file === 'src/App.css' ? 'app' : 'overview'], pattern)
    if (!hit.length) problems.push(label + '：没找到 ' + file + ' 里的那条规则')
    else if (!hit.some((body) => /position:\s*relative/.test(body))) {
      problems.push(label + '不是 position: relative，::after 找不到参照物')
    }
  }
  return problems
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

function cssBundle() {
  return {
    motion: read('src/styles/motion.css'),
    overview: read('src/styles/overview.css'),
    app: read('src/App.css'),
  }
}

test('会抬起的卡片都有真入口：键盘能到、点卡上任何地方都进得去', () => {
  const map = sources()
  const { problems, cards, hotzones } = liftProblems(map)
  assert.deepEqual(problems, [])

  // 防扫描走空：卡片与热区都得真的存在，否则上面那句「没有问题」什么也没证明
  assert.ok(cards >= 4, '只扫到 ' + cards + ' 张非原生抬起的卡片，扫描可能走空了')
  assert.ok(hotzones >= 4, '只扫到 ' + hotzones + ' 个 .vq-card-open，扫描可能走空了')
  assert.ok(map.has('src/pages/TemplateLibraryPage.tsx'))
  assert.ok(map.has('src/pages/OverviewPage.tsx'))
})

/** 抬起是「能点」的承诺，不能点的卡片就不该抬：后台那张是只读预览，
    工作台第 4 张有两个去处（快捷创作 / 视觉评审），点卡上哪一处都说不清该去哪。 */
function noLiftProblems(map) {
  const problems = []
  const admin = map.get('src/pages/admin/PromosCard.tsx') || ''
  if (!admin.length) problems.push('读不到 src/pages/admin/PromosCard.tsx')
  else if (admin.includes('vq-lift')) problems.push('后台运营位预览卡不可点，不该有悬停抬起')

  const overview = map.get('src/pages/OverviewPage.tsx') || ''
  const lifts = (overview.match(/ov-cap vq-lift/g) || []).length
  if (lifts !== 3) problems.push('工作台会抬起的能力卡是 ' + lifts + ' 张，应当只有 3 张（第四张有两个去处）')
  return problems
}

test('不可点的卡片不许抬起：后台预览卡只看不改，工作台那张有两个去处的卡也不抬', () => {
  assert.deepEqual(noLiftProblems(sources()), [])
})

test('热区的三条 CSS 前提（铺满、按下不位移、按钮不许自己定位）', () => {
  assert.deepEqual(hotzoneProblems(cssBundle()), [])
})

test('反证：上面三条断言各自都能真的变红', () => {
  // 1) 拿掉一张能力卡的热区类名：数量对不上
  {
    const map = sources()
    const file = 'src/pages/OverviewPage.tsx'
    const source = map.get(file)
    map.set(file, source.replace("className=\"ov-cap-action vq-card-open\" onClick={() => onNavigate('assets')}", "className=\"ov-cap-action\""))
    assert.notDeepEqual(liftProblems(map).problems, [])
  }

  // 2) 热区没铺满：inset 被改小
  {
    const css = cssBundle()
    css.motion = css.motion.replace('inset: 0;', 'inset: 10px;')
    assert.ok(hotzoneProblems(css).some((p) => p.includes('inset')))
  }

  // 3) 按下时又位移了：热区会在按下那一刻塌回按钮
  {
    const css = cssBundle()
    css.motion = css.motion.replace('.vq-card-open.vq-card-open:active { transform: none; }', '.vq-card-open.vq-card-open:active { transform: translateY(1px); }')
    assert.ok(hotzoneProblems(css).some((p) => p.includes('热区会在按下那一刻塌回按钮')))
  }

  // 4) 按钮自己定位了：::after 的参照从卡片变成按钮
  {
    const css = cssBundle()
    css.motion = css.motion.replace('.vq-card-open::after {', '.vq-card-open { position: relative; }\n.vq-card-open::after {')
    assert.ok(hotzoneProblems(css).some((p) => p.includes('热区只剩按钮那么大')))
  }

  // 5) 宿主卡片不是定位上下文：::after 找不到参照物
  {
    const css = cssBundle()
    css.overview = css.overview.replace('.ov-cap {\n  position: relative;', '.ov-cap {')
    assert.ok(hotzoneProblems(css).some((p) => p.includes('工作台能力卡不是 position: relative')))
  }

  // 6) 后台预览卡又被挂上抬起
  {
    const map = sources()
    const file = 'src/pages/admin/PromosCard.tsx'
    map.set(file, map.get(file).replace('<article className="vq-promo">', '<article className="vq-promo vq-lift">'))
    assert.notDeepEqual(noLiftProblems(map), [])
  }

  // 7) 工作台第 4 张（两个去处）又被挂上抬起
  {
    const map = sources()
    const file = 'src/pages/OverviewPage.tsx'
    map.set(file, map.get(file).replace('<article className="ov-cap">', '<article className="ov-cap vq-lift">'))
    assert.notDeepEqual(noLiftProblems(map), [])
  }
})
