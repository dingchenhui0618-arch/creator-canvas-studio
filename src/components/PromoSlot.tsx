// 运营位（r320）。一屏一个 <PromoSlot placement="…" />，内容来自服务端（后台「运营位」卡可改），
// 关掉哪几条记在这台机器的浏览器里（同一台不再出现；换设备/清缓存会重新出现）。
// 取数与「关掉」的共享状态在 src/api/promos.ts：同一屏多个位置共用一份，关一条全都消失。
//
// r322 动效：进场逐条上浮（直接用 motion.css 的 .vq-stagger，与模板库/作品流同一套），
// 关掉时先塌下去再移除——原来是一按就消失，下面那条会「跳」上来一格，
// 这是运营位这一块最容易看出毛刺的地方。
//
// r326 两处手感（用户说的「小的细枝末节」，都是站在真页面上看出来的）：
//   1) 整卡可点：卡片悬停会抬起（.vq-lift），却只有右下那颗按钮能点，看着像「提起来了却按不动」。
//      做法是在按钮上铺一层透明热区盖住整张卡（stretched link），不给 article 挂 onClick、
//      也不把按钮套进按钮；键盘这条路照样走按钮自己（Tab 一格、回车触发）。
//   2) 关掉能撤：以前点错 ✕ 就再也回不来了（只记在本地，界面上没有任何入口）。现在关掉之后
//      槽里留一条「已关掉 XX · 撤销」；槽里还有别的运营位时它 8 秒后退场，
//      槽被关空了就一直留着——那正是没有别的入口的时候。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, RotateCcw, Sparkles, X } from 'lucide-react'
import type { Page } from '../domain/types'
import { PROMO_UNDO_MS, activePromos, promoUndoLabel, todayKey, type PromoPlacement } from '../domain/promos'
import { dismissPromo, restorePromos, usePromoStore } from '../api/promos'
import { useUiMode } from '../api/app'
import '../styles/promos.css'

/**
 * 塌下去那一段的兜底时长：正常会先收到 transitionend，
 * 但系统开了「减弱动态效果」时过渡只有 1ms、transitionend 也可能因为元素被卸载而不来，
 * 不能让卡片或条子卡在半路（它已经不可点了）。与卡片那一段用同一个数。
 */
const COLLAPSE_FALLBACK_MS = 420

export default function PromoSlot({
  placement,
  onNavigate,
  internal,
  max,
}: {
  placement: PromoPlacement
  onNavigate: (page: Page) => void
  /** 内部口径（管理员）多看一条内部专用的运营位；不传就按界面当前口径（管理员=internal）。 */
  internal?: boolean
  /** 这个位置最多几条；不写按 domain 里的默认（2 条）。 */
  max?: number
}) {
  const { items, dismissed } = usePromoStore()
  const { internal: uiInternal } = useUiMode()
  // 不传 internal 就跟着界面口径走：模板库这种页面不必为此多接一个 prop
  const showInternal = internal ?? uiInternal
  // 日期只算一次：运营位的起止按「今天」判，渲染中途跨零点不是个要处理的问题
  const on = useMemo(() => todayKey(), [])
  const list = useMemo(
    () => activePromos(items, { placement, on, internal: showInternal, dismissed, max }),
    [items, placement, on, showInternal, dismissed, max],
  )

  // 正在收起来的那一条：记下 id、标题与它当时的高度，收完（transitionend 或兜底计时器）才真正从
  // 「关掉过」的名单里写进去——写早了 React 会立刻把它从 DOM 拿掉，塌下去这段就看不见了。
  // 标题要一起记下来：收完之后这条已经不在 list 里了，撤销条上还得说清关掉的是哪一条。
  const [leaving, setLeaving] = useState<{ id: string; title: string; height: number } | null>(null)
  // 这次浏览里刚关掉的几条：「撤销」撤的是它们。只在内存里——刷新之后关掉的记录照样生效、
  // 条子不再出现（一个跨会话挂着的「撤销」更像没关干净）。
  const [undo, setUndo] = useState<{ id: string; title: string }[]>([])
  // 条子自己在退场时的高度（null = 不在退场）
  const [undoLeaving, setUndoLeaving] = useState<number | null>(null)
  // 光标停在条上、或键盘正停在「撤销」上时不抽走它：手伸过去的那一下正好到点，最气人
  const [undoHold, setUndoHold] = useState(false)
  const undoRef = useRef<HTMLDivElement | null>(null)
  const timers = useRef<number[]>([])

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer)
    },
    [],
  )

  const dismiss = useCallback(
    (id: string, title: string, card: HTMLElement | null) => {
      // 手快连点两条（或者点到刚补位上来的那条）时，上一条已经在收：先把它直接记成「关掉过」，
      // 再开始收这一条。直接忽略第二次点击会变成「点了没反应」——那比少一段动画难解释得多。
      // 两次 setState 在同一个事件里会被合并成一次渲染，上一条不会先弹回原高度再消失。
      if (leaving && leaving.id !== id) dismissPromo(leaving.id)
      setLeaving({ id, title, height: card ? card.offsetHeight : 0 })
    },
    [leaving],
  )

  const finishDismiss = useCallback((id: string, title: string) => {
    setLeaving((current) => (current && current.id === id ? null : current))
    dismissPromo(id)
    // 同一条只上一次（连点、或者撤销之后又关一次）
    setUndo((current) => (current.some((item) => item.id === id) ? current : [...current, { id, title }]))
  }, [])

  useEffect(() => {
    if (!leaving) return
    const id = leaving.id
    const title = leaving.title
    // 定住当前高度是上一步（内联 max-height），下一帧再收到 0 —— 中间必须隔一帧，
    // 不然浏览器只看到「最终值」，max-height 直接跳过去，塌下去这段就没了。
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        // height 已经是 0 就原样返回（同一个对象），否则每帧都会造一个新对象、无限循环
        setLeaving((current) =>
          current && current.id === id && current.height !== 0 ? { id, title, height: 0 } : current,
        ),
      ),
    )
    const timer = window.setTimeout(() => finishDismiss(id, title), COLLAPSE_FALLBACK_MS)
    timers.current.push(timer)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [leaving, finishDismiss])

  // 撤销条什么时候自己退场：槽里还有别的运营位时到点就走；
  // 槽被关空了就一直留着——那时候它已经是唯一的入口了（关掉一条只写进本地，刷新不会自己回来）。
  // undoHold 期间不挂计时器，松手（或焦点移开）时重新开始算，够一次从容的伸手。
  useEffect(() => {
    if (!undo.length || !list.length || undoLeaving !== null || undoHold) return
    const timer = window.setTimeout(
      () => setUndoLeaving(undoRef.current ? undoRef.current.offsetHeight : 0),
      PROMO_UNDO_MS,
    )
    return () => window.clearTimeout(timer)
  }, [undo, list.length, undoLeaving, undoHold])

  // 条子退场：与卡片同一套做法（先钉住高度、下一帧收到 0，CSS 那边一起收内边距与描边）
  useEffect(() => {
    if (undoLeaving === null) return
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setUndoLeaving((current) => (current !== null && current !== 0 ? 0 : current)),
      ),
    )
    const timer = window.setTimeout(() => {
      setUndoLeaving(null)
      setUndo([])
    }, COLLAPSE_FALLBACK_MS)
    timers.current.push(timer)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [undoLeaving])

  const undoAll = useCallback(() => {
    // 退场那 180ms 里按钮已经 disabled，键盘还按得动——那次撤销不算数，别把状态改乱
    if (undoLeaving !== null) return
    restorePromos(undo.map((item) => item.id))
    setUndo([])
    setUndoHold(false)
  }, [undo, undoLeaving])

  // 一条都没有、也没有撤销条时才整块不渲染：槽被关空了正是要留住撤销条的时候，
  // 这里不能只看 list（r322 那次就是在这里让「关掉之后什么都没有」的）
  if (!list.length && !undo.length) return null

  return (
    <section className="vq-promos vq-stagger" aria-label="平台动态" data-placement={placement}>
      {list.map((promo) => {
        const going = leaving?.id === promo.id
        return (
          <article
            className={'vq-promo vq-lift' + (going ? ' is-leaving' : '')}
            key={promo.id}
            data-promo-id={promo.id}
            // 内联高度只给正在收的那一条：先钉住它现在有多高，下一帧收到 0
            style={going && leaving ? { maxHeight: leaving.height + 'px' } : undefined}
            aria-hidden={going ? true : undefined}
            onTransitionEnd={(event) => {
              // 只认这一条自己的 max-height：子元素（按钮）的 transitionend 会冒泡上来
              if (going && event.target === event.currentTarget && event.propertyName === 'max-height') {
                finishDismiss(promo.id, promo.title)
              }
            }}
          >
            <span className="vq-promo-icon" aria-hidden="true">
              <Sparkles size={16} />
            </span>
            <div className="vq-promo-copy">
              <span className="vq-promo-kicker">{promo.kicker}</span>
              <h3 className="vq-promo-title">{promo.title}</h3>
              <p className="vq-promo-body">{promo.body}</p>
            </div>
            {/* 整卡可点靠这颗按钮的 ::after 热区（.vq-card-open，共用规则在 motion.css） */}
            <button
              type="button"
              className="vq-button vq-button--ghost vq-promo-cta vq-card-open"
              onClick={() => onNavigate(promo.page)}
            >
              {promo.cta}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="vq-promo-close"
              onClick={(event) =>
                dismiss(promo.id, promo.title, event.currentTarget.parentElement as HTMLElement | null)
              }
              aria-label={'关闭这条动态：' + promo.title}
              title="关掉这条"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </article>
        )
      })}
      {undo.length ? (
        <div
          className={'vq-promo-undo' + (undoLeaving !== null ? ' is-leaving' : '')}
          style={undoLeaving !== null ? { maxHeight: undoLeaving + 'px' } : undefined}
          ref={undoRef}
          onMouseEnter={() => setUndoHold(true)}
          onMouseLeave={() => setUndoHold(false)}
          onFocus={() => setUndoHold(true)}
          onBlur={() => setUndoHold(false)}
          onTransitionEnd={(event) => {
            // 与卡片同一条口径：只认这个元素自己的 max-height（按钮的 transitionend 会冒泡上来）
            if (undoLeaving !== null && event.target === event.currentTarget && event.propertyName === 'max-height') {
              setUndoLeaving(null)
              setUndo([])
            }
          }}
        >
          <span className="vq-promo-undo-text" role="status">
            {promoUndoLabel(undo)}
          </span>
          <button
            type="button"
            className="vq-button vq-button--ghost vq-button--sm vq-promo-undo-button"
            onClick={undoAll}
            disabled={undoLeaving !== null}
          >
            <RotateCcw size={14} aria-hidden="true" />
            撤销
          </button>
        </div>
      ) : null}
    </section>
  )
}
