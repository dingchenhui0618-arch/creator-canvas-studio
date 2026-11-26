// r326：运营位两处手感的「声明 ↔ 挂载」绑定。改的是看得见摸得着的两件事，
// 但它们都能被一次「看起来改完了」的编辑悄悄废掉：
//
//   1) 整卡可点：靠 CTA 的 ::after 铺一层热区。热区以「最近的定位祖先」为参照，
//      参照物必须是 .vq-promo；谁给 .vq-promo-cta 加上 position，热区就只剩按钮那么大
//      ——代码照样编译、按钮照样好使，只有「点标题又没反应」自己回来。
//      关闭按钮没盖在热区之上则是另一头：点 ✕ 变成「关不掉，还跑去那一页」。
//   2) 关掉能撤：条子要真的渲染得出来（槽被关空时必须还在）、按钮要真的把这几条从
//      「关掉过」名单里拿掉并写回本地。最像 r322 那个坑的是 `if (!list.length) return null`：
//      槽被关空的时候，正好把唯一能撤销的入口一起藏了。
//
// 所以这里对着真源码扫。每条都配一个反证（把源码改坏，检查必须变成「有问题」），
// 免得写出一个恒真的断言——门禁的价值在于它真能红。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const SLOT = read('src/components/PromoSlot.tsx')
const CSS = read('src/styles/promos.css')
// r329：整卡热区与「按下不位移」搬进了共用层（运营位是它的第一处用户，不是唯一一处）
const MOTION = read('src/styles/motion.css')
const STORE = read('src/api/promos.ts')

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
function slotProblems(src) {
  const problems = []
  if (!src.includes('restorePromos')) problems.push('没有把 restorePromos 接进界面')
  if (!src.includes('restorePromos(undo.map((item) => item.id))')) {
    problems.push('撤销按钮没有真的去恢复关掉的那几条')
  }
  if (!src.includes('promoUndoLabel(undo)')) problems.push('撤销条上的文案不是由 promoUndoLabel 出的')
  if (!src.includes('vq-promo-undo-text')) problems.push('撤销条没有渲染出来（找不到 vq-promo-undo-text）')
  if (src.includes('if (!list.length) return null')) {
    problems.push('槽被关空时整块不渲染，撤销条会跟着一起消失——那正是唯一能撤销的时候')
  }
  if (!src.includes('if (!list.length && !undo.length) return null')) {
    problems.push('整块不渲染的条件里没有把撤销条算进去')
  }
  if (!src.includes('disabled={undoLeaving !== null}')) {
    problems.push('条子退场那 180ms 里按钮还能按，撤销会落空')
  }
  // r329：整卡热区搬进共用层之后，运营位这边只剩「挂上类名」这一根线，断了热区就没了
  if (!src.includes('vq-promo-cta vq-card-open')) {
    problems.push('运营位的 CTA 没挂 .vq-card-open，整卡热区不会生效')
  }
  return problems
}

function cssProblems(src, motion = MOTION) {
  const problems = []
  // r329：热区本体在共用层（motion.css 的 .vq-card-open），运营位只是挂上那个类名的那一处
  const hotzone = ruleBody(motion, '.vq-card-open::after')
  if (!hotzone.includes('position: absolute') || !hotzone.includes('inset: 0')) {
    problems.push('CTA 的热区没铺满卡片（::after 少了 position: absolute / inset: 0）')
  }
  // 按下时不能有 transform：带 transform 的元素会成为绝对定位后代的包含块，
  // CTA 一被按下，热区就塌成按钮那么大（实测：mouseup 落回标题、click 落到卡片上，点了没反应）
  const openActive = ruleBody(motion, '.vq-card-open.vq-card-open:active')
  if (!openActive.includes('transform: none')) {
    problems.push('CTA 按下时没有挡住 1px 位移：热区的包含块会变成按钮自己，按下期间热区塌掉')
  }
  const cta = ruleBody(src, '.vq-promo-cta')
  if (cta.includes('position')) {
    problems.push('CTA 自己定位了，::after 的参照变成按钮自己，热区只剩按钮那么大')
  }
  const promo = ruleBody(src, '.vq-promo')
  if (!promo.includes('position: relative')) {
    problems.push('.vq-promo 不是 position: relative，::after 找不到参照物')
  }
  const close = ruleBody(src, '.vq-promo-close')
  if (!close.includes('z-index: 1')) problems.push('关闭按钮没盖在热区之上，点 ✕ 会被热区吃掉')
  const ctaActive = ruleBody(src, '.vq-promo-cta.vq-promo-cta:active')
  if (!ctaActive.includes('background: var(--line-faint)')) {
    problems.push('CTA 按下时没有底色反馈（位移交给共用层关掉了，配色还该留在这里）')
  }
  if (!src.includes('.vq-promo-undo.is-leaving.is-leaving')) {
    problems.push('撤销条退场没走塌陷那条规则（会「啪」地跳没）')
  }
  const undo = ruleBody(src, '.vq-promo-undo')
  if (!undo.includes('margin-top: var(--space-2)')) {
    problems.push('撤销条与上一条卡片的间距没挂在条子自己身上，移除时下面会跳 8px')
  }
  if (!src.includes('.vq-promo:has(+ .vq-promo-undo)')) {
    problems.push('条子顶上那条卡片的下边距没让出来，间距会变成两份')
  }
  return problems
}

function storeProblems(src) {
  const problems = []
  if (!src.includes('export function restorePromos')) problems.push('取数层没有 restorePromos')
  if (!src.includes('withoutDismissed')) problems.push('撤销没有走 withoutDismissed（名单规则不是一处）')
  if (!src.includes('writeLocal(PROMO_DISMISS_KEY, JSON.stringify(next))')) {
    problems.push('撤销之后没写回本地存储，刷新一下那条又会是关掉的')
  }
  return problems
}

test('真源码：整卡可点的热区、可撤销的条子都在位', () => {
  assert.deepEqual(slotProblems(SLOT), [])
  assert.deepEqual(cssProblems(CSS), [])
  assert.deepEqual(storeProblems(STORE), [])
})

test('反证：热区被缩回按钮大小 / 关闭按钮没压住它 / 间距没挂在条子上，检查必须变红', () => {
  const shrunk = CSS.replace('.vq-promo-cta { flex: none; }', '.vq-promo-cta { flex: none; position: relative; }')
  assert.notEqual(shrunk, CSS, '反证的替换本身要真的改到源码')
  assert.ok(cssProblems(shrunk).some((item) => item.includes('热区只剩按钮那么大')))

  const eaten = CSS.replace('z-index: 1;', 'z-index: 0;')
  assert.notEqual(eaten, CSS)
  assert.ok(cssProblems(eaten).some((item) => item.includes('关闭按钮')))

  const noHotzone = cssProblems(CSS, MOTION.replace('inset: 0;', 'inset: 4px;'))
  assert.ok(noHotzone.some((item) => item.includes('热区没铺满')))

  // 反证：运营位的 CTA 没挂上共用热区类名（改了名字却没接线）
  const unwired = slotProblems(SLOT.replace('vq-promo-cta vq-card-open', 'vq-promo-cta'))
  assert.notEqual(unwired.length, 0)
  assert.ok(unwired.some((item) => item.includes('没挂 .vq-card-open')))

  const noGap = CSS.replace('margin-top: var(--space-2);', 'margin-top: 0;')
  assert.notEqual(noGap, CSS)
  assert.ok(cssProblems(noGap).some((item) => item.includes('跳 8px')))

  // 反证：共用层里把「按下不位移」改回全站统一的 1px 位移，检查必须变红
  const movedOnPress = MOTION.replace('.vq-card-open.vq-card-open:active { transform: none; }', '.vq-card-open.vq-card-open:active { transform: translateY(1px); }')
  assert.notEqual(movedOnPress, MOTION, '反证的替换要真的改到那条规则')
  assert.ok(cssProblems(CSS, movedOnPress).some((item) => item.includes('按下期间热区塌掉')))
})

test('反证：槽被关空时把整块藏起来、撤销不恢复、撤销不落盘，检查必须变红', () => {
  const hidesUndo = SLOT.replace('if (!list.length && !undo.length) return null', 'if (!list.length) return null')
  assert.notEqual(hidesUndo, SLOT)
  assert.ok(slotProblems(hidesUndo).some((item) => item.includes('唯一能撤销的时候')))

  const noRestore = SLOT.replace('restorePromos(undo.map((item) => item.id))', 'void 0')
  assert.notEqual(noRestore, SLOT)
  assert.ok(slotProblems(noRestore).some((item) => item.includes('没有真的去恢复')))

  const storeNoWrite = STORE.replace('writeLocal(PROMO_DISMISS_KEY, JSON.stringify(next))', 'void next')
  assert.notEqual(storeNoWrite, STORE)
  assert.ok(storeProblems(storeNoWrite).some((item) => item.includes('没写回本地存储')))
})
// ---------- r331：运营位的三处手感 ----------
// 1) ✕ 按下要有反应：全站那条按下反馈只覆盖 .vq-button / .cv-bdc-action / .cv-palette-item，
//    这颗 ✕ 不沾其中任何一个，它自己只有 :hover。少了这条，按下去和停着看一模一样。
// 2) 窄屏触控区：✕ 原来是 28×28，是这一块里最小的目标，偏偏它就是「关掉这条」。
// 3) 撤销条进场：这一块里唯一「说出现就出现」的东西，现在跟卡片同一套 vq-rise。
// 外加一条后台的「形式与事实不符」：权重是保存时按行序算出来的，写成能填的输入框就是在骗人。
const ADMIN_CARD = read('src/pages/admin/PromosCard.tsx')
const CONSOLE = read('src/styles/console.css')

/** 取某个断点的**所有**块（r330 的教训：只取第一个，新加一个同断点的块就能让守卫失效）。 */
function mediaBlocks(css, query) {
  const blocks = []
  const needle = '@media (' + query + ') {'
  let from = 0
  for (;;) {
    const at = css.indexOf(needle, from)
    if (at < 0) break
    const open = css.indexOf('{', at)
    let depth = 0
    let index = open
    for (; index < css.length; index++) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    blocks.push(css.slice(open + 1, index))
    from = index + 1
  }
  return blocks
}

function touchProblems(src) {
  const problems = []
  const flat = mediaBlocks(src, 'max-width: 760px')
  const phone = mediaBlocks(src, 'max-width: 560px')
  if (!flat.length) problems.push('找不到 760 那一段')
  if (!phone.length) problems.push('找不到 560 那一段（手机段要把 ✕ 抬到 44）')
  const sizes = (blocks) => blocks.map((block) => ruleBody(block, '.vq-promo-close')).filter(Boolean)
  const flatRule = sizes(flat).join('\n')
  const phoneRule = sizes(phone).join('\n')
  if (!/width:\s*40px/.test(flatRule) || !/height:\s*40px/.test(flatRule)) {
    problems.push('平板段的 ✕ 没有 40×40 的触控区')
  }
  if (!/width:\s*44px/.test(phoneRule) || !/height:\s*44px/.test(phoneRule)) {
    problems.push('手机段的 ✕ 没有 44×44 的触控区')
  }
  return problems
}

function pressProblems(src) {
  const problems = []
  const active = ruleBody(src, '.vq-promo-close:active')
  if (!active) problems.push('✕ 没有 :active 规则（全站那条按下反馈不覆盖它）')
  else if (!/background:\s*var\(--line-faint\)/.test(active)) {
    problems.push('✕ 按下时没有底色反馈，与同一张卡上的 CTA 不是一套口径')
  }
  // 撤销条的进场动画由父容器 .vq-stagger 提供（r331 实测：before 那版 dist 里它的 animationstart
  // 就是 vq-rise）。在这里再写一条是重复声明，等权重时还会和容器规则抢——所以盯住「别再加回来」。
  const undo = ruleBody(src, '.vq-promo-undo')
  if (/(^|\n)\s*animation:/.test(undo)) {
    problems.push('撤销条自己又写了一条 animation：它的进场是父容器 .vq-stagger 管的，重复声明没意义')
  }
  if (!src.includes('.vq-promo-undo .vq-promo-undo-button')) {
    problems.push('撤销条上的按钮定位规则丢了')
  }
  return problems
}

function weightProblems(card, console_) {
  const problems = []
  if (/type="number"/.test(card)) problems.push('后台运营位里又有能填数字的输入框（权重是算出来的）')
  if (!card.includes('admin-promo-weight')) problems.push('权重没有渲染成只读展示')
  if (!card.includes('{row.weight}')) problems.push('只读展示里没有真的把权重的值显示出来')
  if (!card.includes('保存时按行序重排权重')) problems.push('「按行序重排」那句提示没了，只读展示就无从解释')
  if (!ruleBody(console_, '.admin-promo-weight').includes('min-height: 32px')) {
    problems.push('只读权重的形状没有跟旁边的输入框对齐（32px）')
  }
  return problems
}

test('r331 源码：✕ 按下有反馈、窄屏 40/44 触控区（撤销条的进场是容器给的，别再重复声明）', () => {
  assert.deepEqual(pressProblems(CSS), [])
  assert.deepEqual(touchProblems(CSS), [])
})

test('r331 源码：后台权重是只读展示，不是能填的输入框', () => {
  assert.deepEqual(weightProblems(ADMIN_CARD, CONSOLE), [])
})

test('r331 反证：这四个检查都能真的变红', () => {
  const noActive = CSS.replace('.vq-promo-close:active {', '.vq-promo-close:active-none {')
  assert.notEqual(noActive, CSS, '反证的替换本身要真的改到源码')
  assert.ok(pressProblems(noActive).some((item) => item.includes(':active')))

  const smallFlat = CSS.replace('.vq-promo-close { order: 2; margin-left: auto; width: 40px; height: 40px; }', '.vq-promo-close { order: 2; margin-left: auto; }')
  assert.notEqual(smallFlat, CSS)
  assert.ok(touchProblems(smallFlat).some((item) => item.includes('40×40')))

  const noPhone = CSS.replace('.vq-promo-close { width: 44px; height: 44px; }', '.vq-promo-close { width: 28px; height: 28px; }')
  assert.notEqual(noPhone, CSS)
  assert.ok(touchProblems(noPhone).some((item) => item.includes('44×44')))

  const duplicateAnim = CSS.replace('.vq-promo-undo {\n  display: flex;', '.vq-promo-undo {\n  animation: vq-rise var(--dur-2) var(--ease-out) backwards;\n  display: flex;')
  assert.notEqual(duplicateAnim, CSS)
  assert.ok(pressProblems(duplicateAnim).some((item) => item.includes('重复声明')))

  const editable = ADMIN_CARD.replace('className="admin-promo-weight admin-mono"', 'type="number" className="admin-promo-weight admin-mono"')
  assert.notEqual(editable, ADMIN_CARD)
  assert.ok(weightProblems(editable, CONSOLE).some((item) => item.includes('能填数字')))

  const flatShape = CONSOLE.replace(
    '.admin-promo-weight {\n  display: flex;\n  align-items: center;\n  min-height: 32px;',
    '.admin-promo-weight {\n  display: flex;\n  align-items: center;\n  min-height: 28px;',
  )
  assert.notEqual(flatShape, CONSOLE)
  assert.ok(weightProblems(ADMIN_CARD, flatShape).some((item) => item.includes('32px')))
})
