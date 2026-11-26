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
  { needle: 'function propDiffs(before, after) {', why: '变化清单要能带 derived 标记（先出全量，再分两份）' },
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
  const from = 'return propDiffs(before, after).filter((row) => !row.derived)'
  const broken = SRC.replace(from, 'return propDiffs(before, after)')
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
