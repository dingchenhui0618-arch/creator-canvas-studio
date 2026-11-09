import type { ReactNode } from 'react'
import { ArrowUpRight, Bot, Check, FileImage, FileText, Sparkles, Workflow, X } from 'lucide-react'
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

export function NavItem({ icon: Icon, label, active, compact, utility, badge, onClick }: { icon: IconComponent; label: string; active?: boolean; compact?: boolean; utility?: boolean; badge?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`vq-nav-item${active ? ' is-active' : ''}${compact ? ' vq-nav-item--compact' : ''}${utility ? ' vq-nav-item--utility' : ''}`}
      onClick={onClick}
      title={compact ? label : undefined}
      aria-current={active ? 'page' : undefined}
    >
      <Icon size={16} strokeWidth={1.5} />
      {!compact && <span>{label}</span>}
      {!compact && badge && <em>{badge}</em>}
    </button>
  )
}

export function ReferenceRow({ label, type, tone }: { label: string; type: string; tone: string }) { return <div className="reference-row"><div className={`mini-thumb mini-thumb--${tone}`}>{type === '文本' ? 'Aa' : '杯'}</div><div><strong>{label}</strong><span>{type} · 当前版本</span></div><Check size={14} className="reference-check" /></div> }

export function Stat({ label, value, detail, accent }: { label: string; value: string; detail: string; accent?: string }) { return <div className="stat-card"><span>{label}</span><strong>{value}</strong><small className={accent}>{detail}</small></div> }

export function ProjectCard({ title, detail, tone, onClick }: { title: string; detail: string; tone: string; onClick: () => void }) { return <button className="project-card" onClick={onClick}><div className={`project-art project-art--${tone}`}><span>{tone === 'warm' ? '春日\n上新' : tone === 'cool' ? 'Agent\nDraft' : '12\nassets'}</span><ArrowUpRight size={15} /></div><div className="project-card-copy"><strong>{title}</strong><span>{detail}</span></div></button> }

export function QuickAction({ icon: Icon, title, detail, onClick }: { icon: IconComponent; title: string; detail: string; onClick: () => void }) { return <button className="quick-action" onClick={onClick}><span className="quick-icon"><Icon size={16} /></span><span><strong>{title}</strong><small>{detail}</small></span><ArrowUpRight size={14} /></button> }

export function Capability({ label, value }: { label: string; value: string }) { return <div className="capability-row"><span>{label}</span><strong className={value === '待接入' || value === '未配置' ? 'is-muted' : ''}>{value}</strong></div> }

export function CreateModal({ onClose, onCreate }: { onClose: () => void; onCreate: (kind: 'agent' | 'canvas') => void }) { return <div className="modal-backdrop" onMouseDown={onClose}><div className="create-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="section-kicker">开始一个新项目</span><h2>你想先创建什么？</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className="create-options"><button onClick={() => onCreate('agent')}><span className="create-option-icon create-option-icon--violet"><Bot size={20} /></span><span><strong>智能体</strong><small>创建一个可复用的创作搭档</small></span><ArrowUpRight size={15} /></button><button onClick={() => onCreate('canvas')}><span className="create-option-icon create-option-icon--gold"><Workflow size={20} /></span><span><strong>资产画布</strong><small>整理素材、节点和生成结果</small></span><ArrowUpRight size={15} /></button></div><div className="modal-foot"><Sparkles size={14} />画布与工作台共用同一批画布数据</div></div></div> }
