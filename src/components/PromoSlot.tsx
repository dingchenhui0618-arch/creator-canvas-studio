// 运营位（r320）。一屏一个 <PromoSlot placement="…" />，内容来自服务端（后台「运营位」卡可改），
// 关掉哪几条记在这台机器的浏览器里（同一台不再出现；换设备/清缓存会重新出现）。
// 取数与「关掉」的共享状态在 src/api/promos.ts：同一屏多个位置共用一份，关一条全都消失。
//
// r322 动效：进场逐条上浮（直接用 motion.css 的 .vq-stagger，与模板库/作品流同一套），
// 关掉时先塌下去再移除——原来是一按就消失，下面那条会「跳」上来一格，
// 这是运营位这一块最容易看出毛刺的地方。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Sparkles, X } from 'lucide-react'
import type { Page } from '../domain/types'
import { activePromos, todayKey, type PromoPlacement } from '../domain/promos'
import { dismissPromo, usePromoStore } from '../api/promos'
import { useUiMode } from '../api/app'
import '../styles/promos.css'

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

  // 正在收起来的那一条：记下 id 与它当时的高度，收完（transitionend 或兜底计时器）才真正从
  // 「关掉过」的名单里写进去——写早了 React 会立刻把它从 DOM 拿掉，塌下去这段就看不见了。
  const [leaving, setLeaving] = useState<{ id: string; height: number } | null>(null)
  const timers = useRef<number[]>([])

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer)
    },
    [],
  )

  const dismiss = useCallback(
    (id: string, card: HTMLElement | null) => {
      // 手快连点两条（或者点到刚补位上来的那条）时，上一条已经在收：先把它直接记成「关掉过」，
      // 再开始收这一条。直接忽略第二次点击会变成「点了没反应」——那比少一段动画难解释得多。
      // 两次 setState 在同一个事件里会被合并成一次渲染，上一条不会先弹回原高度再消失。
      if (leaving && leaving.id !== id) dismissPromo(leaving.id)
      setLeaving({ id, height: card ? card.offsetHeight : 0 })
    },
    [leaving],
  )

  const finish = useCallback((id: string) => {
    setLeaving((current) => (current && current.id === id ? null : current))
    dismissPromo(id)
  }, [])

  useEffect(() => {
    if (!leaving) return
    const id = leaving.id
    // 定住当前高度是上一步（内联 max-height），下一帧再收到 0 —— 中间必须隔一帧，
    // 不然浏览器只看到「最终值」，max-height 直接跳过去，塌下去这段就没了。
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        // height 已经是 0 就原样返回（同一个对象），否则每帧都会造一个新对象、无限循环
        setLeaving((current) => (current && current.id === id && current.height !== 0 ? { id, height: 0 } : current)),
      ),
    )
    // 兜底：系统开了「减弱动态效果」时过渡只有 1ms，正常会先收到 transitionend；
    // 万一没到，也不能让这条卡在半路（它已经不可点了）。
    const timer = window.setTimeout(() => finish(id), 420)
    timers.current.push(timer)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [leaving, finish])

  if (!list.length) return null

    return (
      <section className="vq-promos vq-stagger" aria-label="平台动态" data-placement={placement}>
        {list.map((promo) => {
          const going = leaving?.id === promo.id
          return (
          <article
            className={'vq-promo vq-lift' + (going ? ' is-leaving' : '')}
            key={promo.id}
            // 内联高度只给正在收的那一条：先钉住它现在有多高，下一帧收到 0
            style={going && leaving ? { maxHeight: leaving.height + 'px' } : undefined}
            aria-hidden={going ? true : undefined}
            onTransitionEnd={(event) => {
              // 只认这一条自己的 max-height：子元素（按钮）的 transitionend 会冒泡上来
              if (going && event.target === event.currentTarget && event.propertyName === 'max-height') finish(promo.id)
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
            <button
              type="button"
              className="vq-button vq-button--ghost vq-promo-cta"
              onClick={() => onNavigate(promo.page)}
            >
              {promo.cta}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="vq-promo-close"
              onClick={(event) => dismiss(promo.id, event.currentTarget.parentElement as HTMLElement | null)}
              aria-label={'关闭这条动态：' + promo.title}
              title="关掉这条"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </article>
        )
      })}
    </section>
  )
}