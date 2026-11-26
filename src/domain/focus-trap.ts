/**
 * 弹窗的键盘边界（r328）。
 *
 * 全站二十来个浮层都写着 role="dialog" aria-modal="true"，但 aria-modal 是对读屏的一句承诺：
 * 「这个弹窗外面的东西现在都不能用」。改之前只有「身份引导」兑现了它（r327，因为那是全站唯一
 * 关不掉的弹窗）；其余浮层的焦点根本没收进来——打开后焦点还留在背后那颗按钮上，连按 Tab
 * 会一路走到遮罩后面的侧栏。而遮罩已经把背景挡住了，用户看到的是「按了半天，眼前没动静」。
 *
 * 这个文件只放不碰 DOM 的判定，真正的 keydown 处理在 ../components/useModalFocus.ts。
 * 拆开的原因是单测：test/modal-focus.test.mjs 用一张真值表把 planTab 钉死，
 * 改判定就必须连测试一起改，不给「顺手把兜底删了」留缝。
 */

/** 弹窗里能接住焦点的元素。tabindex="-1" 的不算：它只能被脚本聚焦，不该占 Tab 的一站。 */
export const MODAL_FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** Tab 这一个动作该怎么处理。 */
export type TabPlan =
  /** 落在弹窗中间：交给浏览器，别插手 */
  | 'pass'
  /** 在最后一个上按 Tab：回到第一个 */
  | 'wrap-first'
  /** 在第一个上按 Shift+Tab：跳到最后一个 */
  | 'wrap-last'
  /** 焦点不在弹窗里（刚打开、被别处抢走、或者停在弹窗容器上）：拉进来 */
  | 'pull-in'
  /** 弹窗里一个能接焦点的元素都没有：留在容器上，别让 Tab 跑出去 */
  | 'hold'

export type TabState = {
  shift: boolean
  /** 弹窗里能接焦点的元素个数 */
  count: number
  /** 当前焦点是否已经在弹窗里 */
  inside: boolean
  /** 当前焦点是否就在弹窗容器自己身上（容器 tabIndex=-1 时的正常状态） */
  onContainer: boolean
  isFirst: boolean
  isLast: boolean
}

export function planTab(state: TabState): TabPlan {
  if (state.count === 0) return 'hold'
  if (!state.inside || state.onContainer) return 'pull-in'
  if (state.shift && state.isFirst) return 'wrap-last'
  if (!state.shift && state.isLast) return 'wrap-first'
  return 'pass'
}
