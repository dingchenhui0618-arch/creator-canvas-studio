import { useEffect, useRef, type RefObject } from 'react'
import { MODAL_FOCUSABLE, planTab } from '../domain/focus-trap'

/**
 * 把弹窗的键盘关在里面（r328）。
 *
 * 一条 aria-modal="true" 就是个承诺：外面的东西不能用了。兑现它需要三件事，
 * 这里一次做完，全站二十来个浮层共用——以前只有「身份引导」自己写了一份。
 *
 *  1. 焦点收进来（initial）／关掉之后还回去（restoreFocus）
 *  2. Tab / Shift+Tab 在弹窗首尾之间循环（挂在捕获阶段，别处抢不走）
 *  3. 背景不跟着滚（lockScroll，多弹窗叠开时按引用计数，谁先关都不会把别人解开）
 *
 * 两层叠加（大图上再开一个确认框）时只有最上面那一层管键盘：模块里一个栈，
 * 不然外层看到「焦点不在我这儿」会把焦点从内层抢回去。
 */

const VISIBLE = (el: HTMLElement) => !el.hasAttribute('disabled') && el.getClientRects().length > 0

const trapStack: HTMLElement[] = []

let scrollLocks = 0
let scrollLockPrevious = ''

function lockBodyScroll(): () => void {
  if (scrollLocks === 0) {
    scrollLockPrevious = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLocks += 1
  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1)
    if (scrollLocks === 0) document.body.style.overflow = scrollLockPrevious
  }
}

export type ModalFocusOptions = {
  /**
   * 打开时把焦点放哪。
   * - 'none'：不动（弹窗自己 focus 了输入框、或者 autoFocus 指定了某颗按钮）
   * - 'first'：弹窗里第一个能接焦点的元素（多数弹窗就是右上角那颗关闭）
   * - 'container'：弹窗容器自己（读屏会把标题念一遍；容器要 tabIndex={-1}）
   */
  initial?: 'none' | 'first' | 'container'
  /** 打开期间不让人滚底下的页面。默认不开：已经有自己锁的多弹窗场景不必重复。 */
  lockScroll?: boolean
  /**
   * Esc 会不会关掉它。默认 true = 不插手，弹窗自己处理；
   * 设成 false 表示「关不掉的弹窗」（身份引导第一步），Esc 直接吞掉。
   */
  dismissible?: boolean
  /** 关掉之后把焦点还给打开它的那颗按钮。默认 true。 */
  restoreFocus?: boolean
  /**
   * Esc 按下去要做什么。不传就交给弹窗自己（它可能挂在别处）；
   * 传了就在捕获阶段统一处理，焦点在弹窗哪一格都算数——Tab 兜住之后
   * 焦点可能停在列表项上，那时原来挂在输入框上的 Esc 就不管用了。
   */
  onEscape?: () => void
}

export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  options: ModalFocusOptions = {},
) {
  const { initial = 'none', lockScroll = false, dismissible = true, restoreFocus = true } = options
  const opener = useRef<HTMLElement | null>(null)
  // Esc 的回调不进依赖数组：调用方多半现写一个箭头函数，进了依赖就会每次渲染重挂监听，
  // 而重挂监听会把「是谁打开的」清掉、把焦点从弹窗里还回去。
  const escape = useRef(options.onEscape)
  useEffect(() => {
    escape.current = options.onEscape
  })

  useEffect(() => {
    if (!active) return
    const root = ref.current
    if (!root) return

    // 记下「是谁打开的」：关掉之后要把焦点还回去，不然键盘用户得从页首重新走一遍。
    // 记录的是打开那一刻的焦点，所以必须在这一轮任何 focus 之前读。
    const current = document.activeElement
    if (current instanceof HTMLElement && current !== root && !root.contains(current)) {
      opener.current = current
    }

    const focusables = () =>
      Array.prototype.filter.call(root.querySelectorAll(MODAL_FOCUSABLE), VISIBLE) as HTMLElement[]
    const focusFirst = (backwards = false) => {
      const list = focusables()
      const target = backwards ? list[list.length - 1] : list[0]
      ;(target || root).focus({ preventScroll: true })
    }

    if (initial === 'first') focusFirst()
    else if (initial === 'container') root.focus({ preventScroll: true })

    const onKey = (event: KeyboardEvent) => {
      // 只有最上面那一层管键盘
      if (trapStack[trapStack.length - 1] !== root) return
      if (event.key === 'Escape') {
        // 关不掉的弹窗（身份引导第一步）把 Esc 直接吞掉，别让别处的监听顺手关掉别的
        if (!dismissible) {
          event.preventDefault()
          return
        }
        escape.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const list = focusables()
      const activeElement = document.activeElement
      const plan = planTab({
        shift: event.shiftKey,
        count: list.length,
        inside: Boolean(activeElement && root.contains(activeElement)),
        onContainer: activeElement === root,
        isFirst: activeElement === list[0],
        isLast: activeElement === list[list.length - 1],
      })
      if (plan === 'pass') return
      event.preventDefault()
      if (plan === 'hold') {
        root.focus({ preventScroll: true })
        return
      }
      if (plan === 'pull-in') {
        focusFirst(event.shiftKey)
        return
      }
      if (plan === 'wrap-first') {
        list[0]?.focus()
        return
      }
      list[list.length - 1]?.focus()
    }

    // 没开 lockScroll 的浮层也照样进栈：键盘归最上面那层管，滚动锁只管自己那层
    trapStack.push(root)
    const unlock = lockScroll ? lockBodyScroll() : null
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('keydown', onKey, true)
      unlock?.()
      const at = trapStack.lastIndexOf(root)
      if (at >= 0) trapStack.splice(at, 1)
      if (restoreFocus) {
        const back = opener.current
        if (back && back.isConnected) back.focus({ preventScroll: true })
      }
      opener.current = null
    }
    // ref 是稳定引用；options 摊平成原始值，避免每次渲染都重挂监听
  }, [active, ref, initial, lockScroll, dismissible, restoreFocus])
}
