// 懒加载页面的占位骨架：保持页面同样的左右留白，避免切页时内容从边缘跳进来。
type Props = {
  label?: string
}

export function PageSkeleton({ label = '正在加载页面' }: Props) {
  return (
    <div className="vq-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="vq-skeleton-label">{label}…</span>
      <div className="vq-skeleton-head" aria-hidden="true">
        <span className="vq-skeleton-line vq-skeleton-line--title" />
        <span className="vq-skeleton-line vq-skeleton-line--copy" />
      </div>
      <div className="vq-skeleton-grid" aria-hidden="true">
        <span className="vq-skeleton-card" />
        <span className="vq-skeleton-card" />
        <span className="vq-skeleton-card" />
      </div>
    </div>
  )
}
