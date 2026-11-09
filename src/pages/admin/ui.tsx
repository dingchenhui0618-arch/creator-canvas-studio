import type { ReactNode } from 'react'

export function AdminHead({
  kicker,
  title,
  description,
  actions,
}: {
  kicker: string
  title: string
  description: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="admin-head">
      <div className="admin-head-main">
        <p className="admin-kicker">{kicker}</p>
        <h1 className="admin-title">{title}</h1>
        <p className="admin-desc">{description}</p>
      </div>
      {actions ? <div className="admin-head-actions">{actions}</div> : null}
    </header>
  )
}

export function SourceTag({ kind, source }: { kind: 'api' | 'local'; source: string }) {
  return (
    <span className={`admin-tag admin-tag--${kind}`} title={source}>
      <span className="admin-tag-dot" aria-hidden="true" />
      {kind === 'api' ? '真实接口' : '本地会话'}
    </span>
  )
}

export function ErrorBanner({ message, onRetry, title = '数据加载失败' }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <div className="admin-error" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      {onRetry ? (
        <button type="button" className="admin-btn admin-btn--ghost" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}

export function LoadingLine({ label }: { label: string }) {
  return (
    <p className="admin-loading" role="status">
      <span className="admin-loading-dot" aria-hidden="true" />
      正在请求 {label}…
    </p>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="admin-empty">
      <p>{title}</p>
      {description ? <span>{description}</span> : null}
    </div>
  )
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'fail'
  children: ReactNode
}) {
  return <span className={`admin-badge admin-badge--${tone}`}>{children}</span>
}

export function RefreshButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button type="button" className="admin-btn admin-btn--ghost" onClick={onClick} disabled={busy}>
      {busy ? '刷新中…' : '刷新'}
    </button>
  )
}
