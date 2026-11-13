import type { ReactNode } from 'react'
import { useUiMode } from '../../api/app'
import { Pill } from '../../components/ui'

// 生产环境不显示接口路径：错误提示只说哪块数据没取到，路径留给内部环境排障
function stripApiPrefix(message: string) {
  return message
    .split('；')
    .map((part) => part.replace(/^\s*(?:(?:GET|POST|PATCH|DELETE|PUT)\s+)?\/api\/[^\s：:]*[：:]\s*/, ''))
    .join('；')
}

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
  const { internal } = useUiMode()
  if (!internal) return null
  return (
    <span className={`admin-tag admin-tag--${kind}`} title={source}>
      <span className="admin-tag-dot" aria-hidden="true" />
      {kind === 'api' ? '真实接口' : '本地会话'}
    </span>
  )
}

export function ErrorBanner({ message, onRetry, title = '数据加载失败' }: { message: string; onRetry?: () => void; title?: string }) {
  const { internal } = useUiMode()
  return (
    <div className="admin-error" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{internal ? message : stripApiPrefix(message)}</p>
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
  const { internal } = useUiMode()
  return (
    <p className="admin-loading" role="status">
      <span className="admin-loading-dot" aria-hidden="true" />
      {internal ? `正在请求 ${label}…` : '正在加载…'}
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
  return <Pill tone={tone}>{children}</Pill>
}

export function RefreshButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button type="button" className="admin-btn admin-btn--ghost" onClick={onClick} disabled={busy}>
      {busy ? '刷新中…' : '刷新'}
    </button>
  )
}
