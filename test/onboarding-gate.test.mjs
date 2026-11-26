// r327：注册后第一屏（身份引导弹窗）的「声明 ↔ 挂载」绑定。
//
// 这一轮修的是两件在真页面上才看得出来的事，两件都能被一次「看起来改完了」的编辑悄悄废掉：
//
//   1) 进场：卡片与遮罩本来是 animation-name: none，别的弹窗都有进场，第一屏反而「啪」一下出现。
//      最像的坑是 fill-mode——写成 forwards / both 之后动画结束还一直持有最后一帧的 transform，
//      卡片就永久变成一层包含块（r326 那个教训换了个地方出现）。
//   2) 键盘：这个弹窗是阻塞的（第一步没有关闭入口、Esc 也拦掉），焦点却既没被收进来、
//      Tab 也能一路走到遮罩后面的侧栏上——实测连按十次全落在 .vq-nav-item 上，
//      而那时背景是点不动的，用户看到的是「按了半天什么都没变」。
//      所以这里扫的是「焦点真的被收进卡片」「Tab 的首尾真的自己兜住（还要挂捕获阶段，
//      否则页面上别的处理器先动手）」「换步之后焦点不会掉回 body」。
//
// 每条都配一个反证（把源码改坏，检查必须变成「有问题」），免得写出一个恒真的断言——
// 门禁的价值在于它真能红。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const GATE = read('src/components/OnboardingGate.tsx')
const CSS = read('src/styles/assets.css')
const MOTION = read('src/styles/motion.css')

/** 取一个选择器的规则体（我们的规则都写成「选择器 {」）。取不到就是空串。 */
function ruleBody(css, selector) {
  const at = css.indexOf(selector + ' {')
  if (at < 0) return ''
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) return ''
  return css.slice(open + 1, close)
}

/** 出一份问题清单；空数组 = 这一项没毛病。 */
function gateProblems(src) {
  const problems = []
  // ---- 进场 ----
  if (!src.includes("stepSeq > 0 ? ' is-step-in' : ''")) {
    problems.push('换步的内容没有带上 is-step-in，换步会硬切')
  }
  if (!src.includes('key={step}')) {
    problems.push('.vq-gate-body 没有按 step 换 key，换步不会重新放一次进场')
  }
  const bumps = src.split('setStepSeq((count) => count + 1)').length - 1
  if (bumps < 2) {
    problems.push('换步加 seq 的地方只有 ' + bumps + ' 处（保存身份与「上一步」都要加）')
  }
  // ---- 键盘 ----
  if (!src.includes('tabIndex={-1}')) {
    problems.push('卡片没有 tabIndex={-1}：容器自己不能被脚本聚焦（也就念不出标题）')
  }
  if (!src.includes('ref={cardRef}')) problems.push('卡片没有挂 ref，效果里拿不到它')
  if (!src.includes('cardRef.current?.focus({ preventScroll: true })')) {
    problems.push('打开时没有把焦点收进卡片，焦点会留在遮罩后面的页面上')
  }
  if (!src.includes('if (!visible || stepSeq === 0) return')) {
    problems.push('换步之后没有把焦点收回来：点「继续」那颗按钮一卸载，焦点就掉回 body')
  }
  if (!src.includes("event.key !== 'Tab'")) problems.push('没有接管 Tab，键盘能走到遮罩后面')
  if (!src.includes("event.key === 'Escape'")) {
    problems.push('Escape 没被拦下来（这一步是设计如此：第一步没有关闭入口）')
  }
  if (!src.includes('GATE_FOCUSABLE')) problems.push('兜住首尾时没有用统一的可聚焦选择器')
  if (!src.includes('getClientRects()')) {
    problems.push('判可见性用了 offsetParent：这个弹窗是 position: fixed，offsetParent 一律是 null，会把所有元素都判成隐藏')
  }
  if (!src.includes('event.shiftKey && active === first')) {
    problems.push('Shift+Tab 没有从第一格往回绕')
  }
  if (!src.includes('last.focus()') || !src.includes('first.focus()')) {
    problems.push('Tab 到最后一格没有绕回第一格')
  }
  if (!src.includes("document.addEventListener('keydown', onKey, true)")) {
    problems.push('键盘处理没有挂在捕获阶段：页面上别的处理器会先动手')
  }
  if (!src.includes("document.removeEventListener('keydown', onKey, true)")) {
    problems.push('卸载时没有把捕获阶段的监听摘掉（挂载与卸载不一致会漏摘）')
  }
  return problems
}

function cssProblems(css, motion) {
  const problems = []
  const card = ruleBody(css, '.vq-gate-card')
  if (!card.includes('animation: vq-rise')) {
    problems.push('身份引导卡片没有进场（缺 animation: vq-rise）')
  }
  // 进了场还持有最后一帧：动画结束后 transform 一直留着，卡片永久变成一层包含块
  if (/\b(forwards|both)\b/.test(card)) {
    problems.push('卡片进了场还持有最后一帧：transform 会一直留着，卡片永久变成一层包含块')
  }
  if (!ruleBody(css, '.vq-gate-backdrop').includes('animation: vq-fade')) {
    problems.push('遮罩没有淡入（缺 animation: vq-fade）')
  }
  if (!ruleBody(css, '.vq-gate-body.is-step-in').includes('animation: vq-rise')) {
    problems.push('换步的内容没有进场规则（.vq-gate-body.is-step-in）')
  }
  if (!ruleBody(css, '.vq-gate-card:focus').includes('outline: none')) {
    problems.push('卡片被脚本聚焦时会画一圈焦点框（它是容器不是控件）')
  }
  // 带上结尾的 { 再比：不然把 @keyframes vq-fade 改名成 vq-fade-gone 也会「看起来还在」
  if (!motion.includes('@keyframes vq-rise {')) problems.push('动效层里没有 vq-rise')
  if (!motion.includes('@keyframes vq-fade {')) problems.push('动效层里没有 vq-fade')
  return problems
}

test('真源码：第一屏有进场，键盘也真的被关在弹窗里', () => {
  assert.deepEqual(gateProblems(GATE), [])
  assert.deepEqual(cssProblems(CSS, MOTION), [])
})

test('反证：进场被拿掉 / 用 forwards 留在最后一帧 / 遮罩不淡入 / 换步没规则，检查必须变红', () => {
  // 第一条命中「卡片没有进场」
  const stripped = CSS.replace('animation: vq-rise var(--dur-2) var(--ease-out);', 'animation: none;')
  assert.notEqual(stripped, CSS, '反证的替换本身要真的改到源码')
  assert.ok(cssProblems(stripped, MOTION).some((item) => item.includes('没有进场')))

  // 同一条替换加上 forwards，命中的是「永久变成一层包含块」
  const filled = CSS.replace('animation: vq-rise var(--dur-2) var(--ease-out);', 'animation: vq-rise var(--dur-2) var(--ease-out) forwards;')
  assert.notEqual(filled, CSS)
  assert.ok(cssProblems(filled, MOTION).some((item) => item.includes('包含块')))

  const noFade = MOTION.replace('@keyframes vq-fade {', '@keyframes vq-fade-gone {')
  assert.notEqual(noFade, MOTION)
  assert.ok(cssProblems(CSS, noFade).some((item) => item.includes('vq-fade')))

  const noStep = CSS.replace('.vq-gate-body.is-step-in', '.vq-gate-body.is-nope')
  assert.notEqual(noStep, CSS)
  assert.ok(cssProblems(noStep, MOTION).some((item) => item.includes('换步的内容没有进场')))
})

test('反证：焦点没收进卡片 / Tab 没兜住 / 换步后没收回来，检查必须变红', () => {
  const noTabIndex = GATE.replace('tabIndex={-1}', '')
  assert.notEqual(noTabIndex, GATE)
  assert.ok(gateProblems(noTabIndex).some((item) => item.includes('tabIndex')))

  const noTrap = GATE.replace("if (event.key !== 'Tab' || !card) return", 'if (true) return')
  assert.notEqual(noTrap, GATE)
  assert.ok(gateProblems(noTrap).some((item) => item.includes('没有接管 Tab')))

  const noCapture = GATE.replace("document.addEventListener('keydown', onKey, true)", "document.addEventListener('keydown', onKey)")
  assert.notEqual(noCapture, GATE)
  assert.ok(gateProblems(noCapture).some((item) => item.includes('捕获阶段')))

  const noWrap = GATE.replace('last.focus()', 'last.blur()')
  assert.notEqual(noWrap, GATE)
  assert.ok(gateProblems(noWrap).some((item) => item.includes('绕回第一格')))

  const noPullBack = GATE.replace('cardRef.current?.focus({ preventScroll: true })', 'void 0')
  assert.notEqual(noPullBack, GATE)
  assert.ok(gateProblems(noPullBack).some((item) => item.includes('没有把焦点收进卡片')))

  const noStepFocus = GATE.replace('if (!visible || stepSeq === 0) return', 'if (!visible) return')
  assert.notEqual(noStepFocus, GATE)
  assert.ok(gateProblems(noStepFocus).some((item) => item.includes('掉回 body')))

  const oneBump = GATE.replace(
    "      // 换步才让内容进场：与 setStep 同一个提交，key 和类一起变，动画从挂载那一刻开始放\n      setStepSeq((count) => count + 1)\n",
    '',
  )
  assert.notEqual(oneBump, GATE, '反证的替换要真的删掉一处')
  assert.ok(gateProblems(oneBump).some((item) => item.includes('换步加 seq')))
})
