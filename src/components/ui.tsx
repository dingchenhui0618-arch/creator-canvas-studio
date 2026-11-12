import type { ReactNode } from 'react'
import { ArrowUpRight, Bot, Check, FileImage, FileText } from 'lucide-react'
import type { IconComponent } from '../domain/types'

export function StatusDot({ status }: { status: 'ready' | 'running' | 'success' }) {
  return <span className={`status-dot status-dot--${status}`} aria-label={status} />
}

export function NodeIcon({ icon }: { icon?: 'image' | 'text' | 'bot' }) {
  if (icon === 'text') return <FileText size={15} />
  if (icon === 'bot') return <Bot size={15} />
  return <FileImage size={15} />
}

/** 评审结论徽标：只允许 pass / warn / fail 三种语义，不用装饰色。 */
export function StatusPill({ tone, children }: { tone: 'pass' | 'warn' | 'fail'; children: ReactNode }) {
  return <span className={`vq-pill vq-pill--${tone}`}>{children}</span>
}

/** 中性状态标签：流程状态（已入库 / 演示账号 / 演示模式）不用语义色。 */
export function MonoTag({ children }: { children: ReactNode }) {
  return <span className="vq-tag">{children}</span>
}

export function NavItem({ icon: Icon, label, active, compact, utility, badge, badgeLabel, onClick }: { icon: IconComponent; label: string; active?: boolean; compact?: boolean; utility?: boolean; badge?: string; /** 角标的完整说法（给读屏与收起态 tooltip 用），如「3 条评审等你看」 */ badgeLabel?: string; onClick: () => void }) {
  // 数字放不下时（收起侧栏 / 窄屏）只剩一个点，所以把「几条、是什么」写进可访问名，别让读屏的人丢掉这条信息
  const spoken = badgeLabel ? label + '，' + badgeLabel : label
  return (
    <button
      type="button"
      className={`vq-nav-item${active ? ' is-active' : ''}${compact ? ' vq-nav-item--compact' : ''}${utility ? ' vq-nav-item--utility' : ''}`}
      onClick={onClick}
      // 窄屏会把文字藏起来（只剩图标），可访问名与图标态的 tooltip 都得由 label 兜住
      aria-label={spoken}
      title={compact ? spoken : undefined}
      aria-current={active ? 'page' : undefined}
    >
      <Icon size={16} strokeWidth={1.5} />
      {!compact && <span>{label}</span>}
      {!compact && badge && <em>{badge}</em>}
      {badge ? <i className="vq-nav-item-dot" aria-hidden="true" /> : null}
    </button>
  )
}

export function ReferenceRow({ label, type, tone }: { label: string; type: string; tone: string }) { return <div className="reference-row"><div className={`mini-thumb mini-thumb--${tone}`}>{type === '文本' ? 'Aa' : '杯'}</div><div><strong>{label}</strong><span>{type} · 当前版本</span></div><Check size={14} className="reference-check" /></div> }

export function Stat({ label, value, detail, accent }: { label: string; value: string; detail: string; accent?: string }) { return <div className="stat-card"><span>{label}</span><strong>{value}</strong><small className={accent}>{detail}</small></div> }

export function ProjectCard({ title, detail, tone, onClick }: { title: string; detail: string; tone: string; onClick: () => void }) { return <button className="project-card" onClick={onClick}><div className={`project-art project-art--${tone}`}><span>{tone === 'warm' ? '春日\n上新' : tone === 'cool' ? 'Agent\nDraft' : '12\nassets'}</span><ArrowUpRight size={15} /></div><div className="project-card-copy"><strong>{title}</strong><span>{detail}</span></div></button> }

export function QuickAction({ icon: Icon, title, detail, onClick }: { icon: IconComponent; title: string; detail: string; onClick: () => void }) { return <button className="quick-action" onClick={onClick}><span className="quick-icon"><Icon size={16} /></span><span><strong>{title}</strong><small>{detail}</small></span><ArrowUpRight size={14} /></button> }

export function Capability({ label, value }: { label: string; value: string }) { return <div className="capability-row"><span>{label}</span><strong className={value === '待接入' || value === '未配置' ? 'is-muted' : ''}>{value}</strong></div> }

