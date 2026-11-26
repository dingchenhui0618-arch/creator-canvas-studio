// r334：给量具自己上守卫。
//
// 这一轮的结论是「按下有反馈但还是硬切的按钮 32 → 0」，数字全靠 scripts/audit-press.mjs 里
// 那几行读 computed transition 的代码。把读数改回只读元素六个属性、或者把判据改成恒假，
// 报告一样会打印「硬切 0」——那不是页面变好了，是量具瞎了。所以这里逐条钉住它们，并逐条配反证。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(path.join(process.cwd(), 'scripts/audit-press.mjs'), 'utf8')

const GUARDS = [
  { needle: 'transitionProperty: cs.transitionProperty,', why: '按下要变的属性，得知道自己这条过渡表' },
  { needle: 'transitionDuration: cs.transitionDuration,', why: 'duration 为 0 等于没有过渡，必须一起读' },
  { needle: 'transitionProperty: ps.transitionProperty,', why: '::after 有自己的过渡表（伪元素不继承元素的 transition）' },
  { needle: 'transitionDuration: ps.transitionDuration,', why: '同上' },
  { needle: 'function transitionOf(state, after, prop) {', why: '属性 → 过渡表 的查表函数' },
  { needle: "let at = props.indexOf(prop)", why: '先按属性名查' },
  { needle: "if (at < 0) at = props.indexOf('all')", why: 'all 也算覆盖（浏览器给的默认值就是 all / 0s）' },
  { needle: "if (at < 0) at = props.findIndex((name) => (SHORTHAND_COVERS[name] || []).indexOf(prop) >= 0)", why: '简写也算覆盖（写 background 时动的是 background-color）' },
  { needle: 'const SHORTHAND_COVERS = {', why: '简写 → 长属性 的对照表' },
  { needle: 'function hardCutProps(changed, state) {', why: '把「变了但没过渡」的挑出来' },
  { needle: 'if (!found.declared || found.ms <= 0) rows.push(', why: '判据：没声明、或声明了但 duration 0，都算硬切' },
  { needle: "const isAfter = item.prop.indexOf('::after ') === 0", why: '带 ::after 前缀的那几项要查伪元素那张表，别查错表' },
  { needle: 'out.hardCuts = hardCutProps(out.changed, out.pressed)', why: '每一颗的硬切进产物（press.json 的 buttons[].hardCuts）' },
  { needle: 'hardCuts: buttons.filter((row) => (row.hardCuts || []).length > 0).length,', why: '硬切数进 summary' },
  { needle: "console.log('---- 有反馈但还是硬切（' + hardCutRows.length + ' 个）----')", why: '硬切清单要打印出来（不然只有翻 JSON 才看得到）' },
  { needle: "hardCut: '变了、但这条属性不在 computed transition-property 里", why: 'probe 元数据里要写清这一层判的是什么' },
  // r335：同一套判据用在 hover 上（划过的硬切也是硬切）
  { needle: 'transitionProperty: hover.transitionProperty,', why: 'hover 那一拍也要读过渡表（规范里过渡取的是 after-change style，就是这一份）' },
  { needle: 'out.hoverHardCuts = hardCutProps(out.hoverChangedVsRest, hover)', why: '划过变了的属性要走同一个硬切判据' },
  { needle: 'hoverHardCuts: buttons.filter((row) => (row.hoverHardCuts || []).length > 0).length,', why: '划过硬切数进 summary' },
  { needle: 'hoverHardCutProps: buttons.reduce((sum, row) => sum + (row.hoverHardCuts || []).length, 0),', why: '硬切属性条数也要有，不然「几颗按钮」看不出有 3 条还是 1 条' },
  { needle: "console.log('---- 划过有变化但还是硬切（' + hoverHardCutRows.length + ' 个）----')", why: '划过硬切清单要打印出来' },
  { needle: "hoverHardCut: 'r335：同一套判据用在 hover 上", why: 'probe 元数据里要写清 hover 这一层' },
  // r335：边框宽度为 0 时 border-color 是 currentColor 的另一种写法，不是反馈
  { needle: 'borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],', why: '要读边框宽度，不然分不出「有没有边框可画」' },
  { needle: 'function borderVisible(state) {', why: '边框可见性判定' },
  { needle: "if (prop !== 'border-color') return false", why: '只对 border-color 做这条推导判定' },
  { needle: 'return !borderVisible(before) && !borderVisible(after)', why: '两边都没有边框才算推导值' },
  { needle: 'function propDiffs(before, after, table) {', why: '变化清单要能带 derived 标记（先出全量，再分两份）；r337 起还要能换一张属性表（划过扩到非按钮表面时多了下划线两条）' },
  { needle: 'function derivedDiffs(before, after) {', why: '推导值要单独一份，如实记录' },
  { needle: 'out.hoverDerived = derivedDiffs(rest, hover).map((row) => row.prop)', why: 'hover 那一拍的推导值进产物' },
  { needle: 'out.derivedOnPress = derivedDiffs(hover, pressed).map((row) => row.prop)', why: '按下那一拍的推导值进产物' },
  { needle: 'derivedBorderChanges: buttons.reduce((sum, row) => sum + (row.hoverDerived || []).length + (row.derivedOnPress || []).length, 0),', why: '推导值条数进 summary（纯记录）' },
  { needle: "derivedBorder: 'r335：边框宽度全 0 时 computed border-color = currentColor", why: 'probe 元数据里要写清这一层' },
  // r336：键盘焦点那一层（Tab 走查）
  { needle: "const FOCUS_MODE = process.argv.indexOf('--focus') > 0", why: '要有一个只跑焦点那一层的开关' },
  { needle: 'async function tabKey() {', why: 'Tab 必须由 CDP 真发（合成事件动不了焦点）' },
  { needle: "await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base))", why: 'rawKeyDown 才是浏览器自己处理的那一次按键' },
  { needle: 'function focusActive() {', why: '要能读出「现在谁拿着焦点」和它的稳定选择器' },
  { needle: 'function readFocusState(selector) {', why: '焦点那一拍自己会读一份状态（元素 + 最多三层祖先）' },
  { needle: 'outlineStyle: cs.outlineStyle,', why: '要读 outline-style：none 和 auto 是两种世界' },
  { needle: 'outlineWidth: cs.outlineWidth,', why: '宽度 0 就没画出来' },
  { needle: 'outlineColor: cs.outlineColor,', why: '颜色也跟着读（但没画出来时它是推导值）' },
  { needle: 'outlineOffset: cs.outlineOffset,', why: 'offset 也在变，一起记' },
  { needle: 'const FOCUS_PROPS = [', why: '焦点这一层要有自己的属性表' },
  { needle: 'function outlineVisible(state) {', why: '焦点环可见性判定（style / 宽度 / 全透明三条）' },
  { needle: "if (prop.indexOf('outline-') === 0) return !outlineVisible(after)", why: '没画出来的 outline，四条（width/style/color/offset）都只是数字在变，不是反馈' },
  { needle: 'const ringAppeared = outlineVisible(rest.chain[0]) !== outlineVisible(focused.chain[0])', why: '环从无到有那一下要单独认出来（离散属性，不做补间）' },
  { needle: "const cutCandidates = ringAppeared ? selfChanged.filter((pair) => pair.prop.indexOf('outline-') !== 0) : selfChanged", why: '环出现那一下不进硬切，环本来就在才判' },
  { needle: "item.verdict = item.changed.length ? 'ring' : (item.ancestorChanged.length ? 'delegated-ring' : 'no-visible-change')", why: '三档判定：自己有环 / 环在祖先（:focus-within）/ 看不出焦点' },
  { needle: 'row.outlineAppearances = row.stops.filter((item) => item.ringAppeared).length', why: '「环从无到有」的站数要进产物（不进硬切，但要有数）' },
  { needle: 'focusNoVisibleChange: focusPages.reduce(', why: '看不出焦点的站数进 summary' },
  { needle: 'focusOutlineAppearances: focusPages.reduce(', why: '平台环出现的站数进 summary' },
  { needle: "focusRing: 'r336：--focus 单独一层。", why: 'probe 元数据里要写清这一层怎么量的' },
  { needle: "console.log('---- 键盘焦点：Tab 到但看不出焦点在哪（' + holeRows.length + ' 个）----')", why: '黑洞清单要打印出来' },
  // r337：第五层——非按钮的可点表面（行 / 卡片 / 链接），只划过、绝不按下
  { needle: "const LINK_MODE = process.argv.indexOf('--links') > 0", why: '要有一个只跑「非按钮表面」那一层的开关' },
  { needle: 'function collectHoverSurfaces(scopeSel, limit) {', why: '要能收集「非按钮的可点表面」（cursor 是 pointer / 语义上可点的）' },
  { needle: "if (!semantic && cs.cursor !== 'pointer') continue", why: '表面判定：语义可点的（链接/页签/开关…）不看 cursor，其余要 cursor: pointer' },
  { needle: 'if (el.closest(\'button, [role="button"]\')) continue', why: '按钮里/按钮本身的那些已经由按下那三层量过，这一层不重复' },
  { needle: 'for (const parent of outer) { if (parent.el.contains(item.el)) { nested = true; break } }', why: 'cursor 是继承属性：嵌套的只留最外层，划过一张卡片时手感落在卡片这张面上' },
  { needle: 'function readHoverState(selector) {', why: '划过那一拍要读元素自己 + 子孙（反馈常常画在里面的箭头/缩略图上）' },
  { needle: 'if (snapshots.length >= 13) { truncated = inner.length - i; break }', why: '子孙要有个上限，超了如实记 truncated（量不到 ≠ 没问题）' },
  { needle: 'const HOVER_PROPS = PROPS.concat([', why: '划过这一层自己的属性表（多了下划线三条），不并进 PROPS' },
  { needle: 'function hoverDerivedDecor(before, after, rows) {', why: 'text-decoration-color 是 currentColor 的另一种写法：没画线 / 与 color 同步变，都不算反馈' },
  { needle: 'if (colorRow && colorRow.from === row.from && colorRow.to === row.to)', why: '与 color 同一步就是 currentColor（值对值，不靠猜）' },
  { needle: 'function isDiscreteHoverProp(prop, before, after) {', why: '离散属性（下划线出现、auto ↔ 长度）算反馈但不进硬切' },
  { needle: 'async function hoverWalk(pageId, pageLabel, scope) {', why: '一趟 = 一屏的非按钮表面逐个划过去' },
  { needle: "if (!before || before.tag !== after.tag || before.cls !== after.cls) { surface.shifts.push(where); continue }", why: '子孙按位置对齐，挪位了算读不到（不硬凑）' },
  { needle: "surface.verdict = surface.changed.length ? 'hover-feedback' : 'hover-no-change'", why: '两档判定：划过有看得见的变化 / 一点变化都没有' },
  { needle: 'hoverNoChange: hoverPages.reduce(', why: '「划过看不出任何变化」的张数要进 summary' },
  { needle: "hoverSurface: 'r337：--links 单独一层。", why: 'probe 元数据里要写清这一层怎么量的' },
  { needle: "console.log('---- 非按钮表面：划过看不出任何变化（' + blankRows.length + ' 张）----')", why: '划过没反应的清单要打印出来' },
  { needle: "console.log('---- 非按钮表面：划过有变化但还是硬切（' + cutRows.length + ' 张）----')", why: '这一层的硬切清单也要打印出来' },
  // r338：焦点这一层的三处量具纠错
  { needle: 'async function ensurePageFocus(tries = 6) {', why: '每一趟走查之前先把「这一页拿得到系统焦点」确认下来' },
  { needle: "if (await evaluate('document.hasFocus()')) return { ok: true, tries: i + 1 }", why: '焦点模拟会被导航清掉：真读到 hasFocus 才算数' },
  { needle: 'row.focusReady = await ensurePageFocus()', why: '一趟开始时先补焦点' },
  { needle: "'补了几次也没能让这一页拿到系统焦点，这一趟的 Tab 走查作废（不是「没问题」）'", why: '拿不到焦点要如实作废，不写成「0 站」' },
  { needle: 'function uniquePath(node) {', why: '绕回开头要按唯一路径判（选择器字符串会重名）' },
  { needle: 'path: uniquePath(el),', why: '每一站都带上那条唯一路径' },
  { needle: 'const repeat = at && !at.body ? walk.filter((item) => item.path === at.path)[0] : null', why: '同一站连着出现，先当成「这一下按键被丢了」处理' },
  { needle: 'const moved = (state) => Boolean(state && !state.body && (!at || state.path !== at.path))', why: '「焦点往前走了」这一条判据' },
  { needle: "let how = '再读一次就动了（按键生效、读数来早了）'", why: '页面长、滚动慢时按键生效了而读数来早了，先把这个情形摘出去' },
  { needle: 'for (let attempt = 0; attempt < 2 && !moved(again); attempt += 1) {', why: '补焦点重按最多两次，两次都不动才是真结论' },
  { needle: 'row.droppedKeys.push(Object.assign(stuck, { how: how }))', why: '丢掉的按键要进产物（不然「少了几站」查不出原因）' },
  { needle: 'function focusUnvisited(visitedJson) {', why: '「可 Tab 元素」比站数多时，要能列出没走到的那些' },
  { needle: 'row.unvisited = await evaluate(', why: '没走到的清单进产物' },
  { needle: 'row.boundary = {', why: '边界自证：聚焦第一个没走到的元素再真按一下 Tab，分清「在 Tab 序里」和「真的到此为止」' },
  { needle: 'function focusDiag() {', why: '第一下就回 body 时的诊断探针' },
  { needle: 'firstTab: name(first),', why: '诊断要写清第一个可 Tab 的元素是谁' },
  { needle: "+ (row.droppedKeys && row.droppedKeys.length ? ' · 丢掉的按键 ' + row.droppedKeys.length : '')", why: '每一趟的汇总行都要报丢掉的按键数' },
  { needle: "focusR338: 'r338：焦点这一层的三处量具纠错。", why: 'probe 元数据里要写清这一层怎么量的' },
]

const missingFrom = (source) => GUARDS.filter((guard) => !source.includes(guard.needle)).map((guard) => guard.needle)

test('r334 · 量具：硬切这一层要读 computed transition（元素与 ::after 各一份）', () => {
  assert.deepEqual(missingFrom(SRC), [], '这些量具的代码被改掉了：\n' + missingFrom(SRC).join('\n'))
})

test('r334 · 量具：单条断言删掉之后检查必须变成「缺了它」', () => {
  for (const guard of GUARDS) {
    const broken = SRC.split(guard.needle).join('')
    assert.notEqual(broken, SRC, guard.needle + ' 在源码里找不到（守卫写的是不存在的字符串）')
    assert.ok(missingFrom(broken).includes(guard.needle), guard.why + '：删掉这一段之后守卫没有报出来')
  }
})

test('r334 · 量具：判据不是恒假的（把 duration 那一半删掉要能看出来）', () => {
  const broken = SRC.replace('if (!found.declared || found.ms <= 0) rows.push(', 'if (false) rows.push(')
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(missingFrom(broken).includes('if (!found.declared || found.ms <= 0) rows.push('), '判据被改成恒假，守卫没发现')
})

// r335：hover 那一层的反证。守卫只钉「代码还在不在」，这里钉「判据有没有被架空」——
// 把变了的属性这一边换成空数组、或者换去查另一份状态，报告都会打印「划过硬切 0」，而页面没变好。
test('r335 · 量具：边框宽度为 0 的连带变化不能算成反馈（filter 那一行要能看出来）', () => {
  const from = 'return propDiffs(before, after, table).filter((row) => !row.derived)'
  const broken = SRC.replace(from, 'return propDiffs(before, after, table)')
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(!broken.includes(from), '把 derived 过滤删掉之后守卫没发现（26 条误报会回来）')
})

// r336：焦点那一层的三条自我纠正，逐条配反证
test('r336 · 量具：没画出来的 outline 不能算成变化（把这条推导规则删掉要能看出来）', () => {
  const from = "if (prop.indexOf('outline-') === 0) return !outlineVisible(after)"
  const broken = SRC.replace(from, "if (prop.indexOf('outline-') === 0) return false")
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(!broken.includes(from), '把 outline 的推导规则改成恒假之后守卫没发现（qc-input / agx-textarea 那两站会回来当硬切）')
  // 只认 color 一项也不行：width / offset 同样是「环没画出来」的另一种写法
  const onlyColor = SRC.replace(from, "if (prop === 'outline-color') return !outlineVisible(after)")
  assert.ok(!onlyColor.includes(from), '只处理 outline-color 时守卫没发现')
})

test('r336 · 量具：环「从无到有」那一下不能算硬切（把摘出去的过滤删掉要能看出来）', () => {
  const from = "const cutCandidates = ringAppeared ? selfChanged.filter((pair) => pair.prop.indexOf('outline-') !== 0) : selfChanged"
  const broken = SRC.replace(from, 'const cutCandidates = selfChanged')
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(!broken.includes(from), '把环出现那一下的过滤删掉之后守卫没发现（每屏 30 条假硬切会回来）')
})

test('r336 · 量具：焦点那一层的属性表与按下/划过那张分开（别把 outline 并进 PROPS）', () => {
  const pressBlock = SRC.slice(SRC.indexOf('const PROPS = ['), SRC.indexOf('const AFTER_PROPS = ['))
  assert.ok(pressBlock.length > 0, '找不到 PROPS 那张表')
  assert.ok(!/outline/.test(pressBlock), '按下的属性表里出现了 outline —— 那会把 r331–r335 已经发布的读数改掉，三层不可比')
  assert.ok(SRC.indexOf('const FOCUS_PROPS = [') > 0, '焦点那一层自己的属性表不见了')
})

// r337：第五层（非按钮表面）的三处判据，逐条配反证
test('r337 · 量具：划过没变化不是恒假的（判定那一行改坏要能看出来）', () => {
  const from = "surface.verdict = surface.changed.length ? 'hover-feedback' : 'hover-no-change'"
  const broken = SRC.replace(from, "surface.verdict = 'hover-feedback'")
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(!broken.includes(from), '把「看不出变化」这一档改成恒真之后守卫没发现（模板抽屉那条裸链接会被记成有反馈）')
})

test('r337 · 量具：currentColor 那条推导不能删（下划线颜色跟着字色变不是一次反馈）', () => {
  const from = "if (decor[diff.prop]) { surface.derived.push(where + ' ' + diff.prop + '（' + decor[diff.prop] + '）'); continue }"
  const broken = SRC.replace(from, '')
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(!broken.includes(from), '删掉推导判定之后守卫没发现（.vq-link 三张面会各多一条 text-decoration-color 假硬切）')
  const lockstep = SRC.replace("if (colorRow && colorRow.from === row.from && colorRow.to === row.to) found[row.prop] = '与 color 同一步（currentColor）'", '')
  assert.ok(!lockstep.includes('与 color 同一步（currentColor）'), '只认「没画线」不认「同步变」时守卫没发现')
})

test('r337 · 量具：离散属性不能算硬切（下划线出现那一下不补间）', () => {
  const from = "if (prop === 'text-decoration-line') return true"
  const broken = SRC.replace(from, 'if (prop === \'text-decoration-line\') return false')
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(!broken.includes(from), '把下划线判成可过渡之后守卫没发现（.vq-link 三张面会被记成硬切）')
})

test('r335 · 量具：hover 的硬切不是恒假的（把输入换成空、或换查另一拍都要能看出来）', () => {
  const anchors = [
    { from: 'hardCutProps(out.hoverChangedVsRest, hover)', to: 'hardCutProps([], hover)', why: '输入换成空数组' },
    { from: 'hardCutProps(out.hoverChangedVsRest, hover)', to: 'hardCutProps(out.hoverChangedVsRest, out.pressed)', why: '查错过渡表（按下那一拍）' },
  ]
  for (const item of anchors) {
    const broken = SRC.replace(item.from, item.to)
    assert.notEqual(broken, SRC, item.why + '：改坏用的锚点没匹配到')
    assert.ok(missingFrom(broken).includes('out.hoverHardCuts = hardCutProps(out.hoverChangedVsRest, hover)'), item.why + '：守卫没发现')
  }
})

// r338：焦点那一层的三处纠错，逐条配反证
test('r338 · 量具：页面没有系统焦点时不能写成「0 站」（把 hasFocus 那道闸改成恒真要能看出来）', () => {
  const from = "if (await evaluate('document.hasFocus()')) return { ok: true, tries: i + 1 }"
  const broken = SRC.replace(from, "if (true) return { ok: true, tries: i + 1 }")
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(!broken.includes(from), '把 hasFocus 那道闸改成恒真之后守卫没发现（页面没焦点时仍会被写成「走查过了」）')
})

test('r338 · 量具：同一站连着出现要能救回来（把补按那一步删掉要能看出来）', () => {
  const from = 'for (let attempt = 0; attempt < 2 && !moved(again); attempt += 1) {'
  const broken = SRC.replace(from, 'for (let attempt = 0; attempt < 0; attempt += 1) {')
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(!broken.includes(from), '把补按删掉之后守卫没发现（被丢掉的按键会被当成绕回 / 走到头）')
})

test('r338 · 量具：绕回不能按选择器字符串判（换回 selector 要能看出来）', () => {
  const from = 'const seen = walk.filter((item) => item.path === at.path)[0]'
  const broken = SRC.replace(from, 'const seen = walk.filter((item) => item.selector === at.selector)[0]')
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(!broken.includes(from), '把唯一路径换回选择器之后守卫没发现（同名不同元素会被当成绕回，走查提前收工）')
})

