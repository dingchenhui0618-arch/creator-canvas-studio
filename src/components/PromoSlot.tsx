// 运营位（r319）。一屏一个 <PromoSlot placement="…" />，内容与开关都在 domain/promos.ts。
// 关掉记在浏览器本地（同一台机器不再出现）；换设备/清缓存会重新出现——这是有意的，
// 现在还没有账号级的运营位状态，等服务端配置那一步一起搬过去。
import { useCallback, useMemo, useState } from 'react'
import { ArrowRight, Sparkles, X } from 'lucide-react'
import type { Page } from '../domain/types'
import {
  PROMOS,
  PROMO_DISMISS_KEY,
  activePromos,
  readDismissedPromos,
  todayKey,
  type PromoPlacement,
} from '../domain/promos'
import '../styles/promos.css'

export default function PromoSlot({
  placement,
  onNavigate,
  internal = false,
  max,
}: {
  placement: PromoPlacement
  onNavigate: (page: Page) => void
  /** 内部口径（管理员）多看一条内部专用的运营位。 */
  internal?: boolean
  /** 这个位置最多几条；不写按 domain 里的默认（2 条）。 */
  max?: number
}) {
  const [dismissed, setDismissed] = useState<string[]>(() =>
    readDismissedPromos(window.localStorage.getItem(PROMO_DISMISS_KEY)),
  )
  const on = useMemo(() => todayKey(), [])
  const list = useMemo(
    () => activePromos(PROMOS, { placement, on, internal, dismissed, max }),
    [placement, on, internal, dismissed, max],
  )

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id]
      try {
        window.localStorage.setItem(PROMO_DISMISS_KEY, JSON.stringify(next))
      } catch {
        // 隐私模式写不进去：这一次仍然关掉，刷新后会回来，不打扰用户
      }
      return next
    })
  }, [])

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
