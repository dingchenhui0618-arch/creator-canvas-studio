// 运营位（r320）。一屏一个 <PromoSlot placement="…" />，内容来自服务端（后台「运营位」卡可改），
// 关掉哪几条记在这台机器的浏览器里（同一台不再出现；换设备/清缓存会重新出现）。
// 取数与「关掉」的共享状态在 src/api/promos.ts：同一屏多个位置共用一份，关一条全都消失。
import { useCallback, useMemo } from 'react'
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

  const dismiss = useCallback((id: string) => dismissPromo(id), [])

  if (!list.length) return null

  return (
    <section className="vq-promos" aria-label="平台动态" data-placement={placement}>
      {list.map((promo) => (
        <article className="vq-promo vq-lift" key={promo.id}>
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
            onClick={() => dismiss(promo.id)}
            aria-label={'关闭这条动态：' + promo.title}
            title="关掉这条"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </article>
      ))}
    </section>
  )
}
