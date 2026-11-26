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
