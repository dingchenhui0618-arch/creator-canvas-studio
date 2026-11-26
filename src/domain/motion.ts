// 「减弱动态效果」这条口径的唯一一处实现（r339）。
//
// 以前是六处各写各的：四处直接 scrollIntoView({ behavior: 'smooth' })，两处自己 matchMedia 判一遍
// （判得对，但同一句话在六个地方抄）。收成一个文件里的两个函数：
//   · prefersReducedMotion() —— 全站只有这里读一次系统的「减弱动态效果」
//   · scrollToSoft(target, options) —— 滚一段到眼前；开了减弱动态效果就直接到位，不然平滑滚过去
//
// 为什么这件事不能只靠 CSS：motion.css 那条总闸里有一句 * { scroll-behavior: auto !important }，
// 它管的是「没有指定 behavior 时用哪个默认值」。JS 显式传的 behavior 优先于它，
// 所以写死 smooth 的那几下在减弱动态效果下照样平滑滚 —— 这是实测出来的（scripts/audit-press.mjs
// 的 --motion 那一层会在真页面上滚一次，量 smooth 与 auto 各要多少帧）。唯一能拦住它的地方是调用方。
export function prefersReducedMotion(): boolean {
  try {
    const query = typeof window === 'undefined' ? null : window.matchMedia
    return Boolean(query && query('(prefers-reduced-motion: reduce)').matches)
  } catch {
    return false
  }
}

/** 滚到某个元素眼前：开了「减弱动态效果」就瞬间到位（behavior: 'auto'），否则平滑滚过去。 */
export function scrollToSoft(
  target: Element | null | undefined,
  options: { block?: ScrollLogicalPosition; inline?: ScrollLogicalPosition } = { block: 'start' },
): void {
  if (!target || typeof target.scrollIntoView !== 'function') return
  target.scrollIntoView({ ...options, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
}
