import type { ReactNode } from 'react'
import '../styles/page-head.css'

export default function PageHead({
  kicker,
  title,
  desc,
  actions,
}: {
  kicker?: ReactNode
  title: ReactNode
  desc?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="vq-head">
      <div className="vq-head-main">
        {kicker ? <div className="vq-head-kicker">{kicker}</div> : null}
        <h1 className="vq-head-title">{title}</h1>
        {desc ? <p className="vq-head-desc">{desc}</p> : null}
      </div>
      {actions ? <div className="vq-head-actions">{actions}</div> : null}
    </header>
  )
}
