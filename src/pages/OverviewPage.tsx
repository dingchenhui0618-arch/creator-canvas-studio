import { useState } from 'react'
import { ArrowRight, ArrowUpRight, Info, Plus } from 'lucide-react'
import type { Page } from '../domain/types'
import { MonoTag, StatusPill } from '../components/ui'
import { recentReplications, reviewQueue, workbenchTasks } from '../data/mock'
import '../styles/overview.css'

function greeting(date: Date): string {
  const hour = date.getHours()
  if (hour < 6) return '凌晨好'
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function todayLabel(date: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')} 年 ${pick('month')} 月 ${pick('day')} 日 · ${pick('weekday')}`
}

function verdictLabel(verdict: 'pass' | 'warn' | 'fail'): string {
  if (verdict === 'pass') return '通过'
  if (verdict === 'fail') return '问题'
  return '待确认'
}

type Props = {
  userName: string
  onCreate: () => void
  onNavigate: (page: Page) => void
}

export function OverviewPage({ userName, onCreate, onNavigate }: Props) {
  const [now] = useState(() => new Date())

  return (
    <div className="vq-page">
      <header className="vq-page-head">
        <div>
          <span className="vq-mono">{todayLabel(now)}</span>
          <h1>
            {greeting(now)}，{userName}
          </h1>
          <p>今天先做三件事：复刻一条爆款、核对三张待确认帧、把一条口播模板接进画布。</p>
        </div>
        <div className="vq-page-actions">
          <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('runs')}>
            运行记录
          </button>
          <button type="button" className="vq-button vq-button--primary" onClick={onCreate}>
            <Plus size={14} />
            新建
          </button>
        </div>
      </header>

      <section className="vq-section">
        <div className="vq-section-head">
          <div>
            <span className="vq-mono">01 / 今天要做什么</span>
            <h2>先做这三件事</h2>
          </div>
          <span className="vq-mono">按优先级排序</span>
        </div>
        <div className="vq-task-grid">
          {workbenchTasks.map((task) => (
            <button type="button" className="vq-task" key={task.id} onClick={() => onNavigate(task.page)}>
              <span className="vq-task-index">{task.index}</span>
              <strong>{task.title}</strong>
              <p>{task.detail}</p>
              <span className="vq-task-foot">
                <span className="vq-mono">{task.meta}</span>
                <span className="vq-task-go">
                  {task.action}
                  <ArrowRight size={12} />
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="vq-overview-grid">
        <section className="vq-section">
          <div className="vq-section-head">
            <div>
              <span className="vq-mono">02 / 最近复刻</span>
              <h2>刚入库的脚本结构</h2>
            </div>
            <button type="button" className="vq-link" onClick={() => onNavigate('templates')}>
              打开模板库
              <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="vq-table" role="table" aria-label="最近复刻">
            <div className="vq-table-head" role="row">
              <span role="columnheader">标题</span>
              <span role="columnheader">来源</span>
              <span role="columnheader">镜头</span>
              <span role="columnheader">时长</span>
              <span role="columnheader">入库</span>
              <span role="columnheader">状态</span>
            </div>
            {recentReplications.map((item) => (
              <div className="vq-table-row" role="row" key={item.id}>
                <div className="vq-table-name" role="cell">
                  <strong>{item.title}</strong>
                  <span className="vq-mono">{item.id}</span>
                </div>
                <span role="cell">
                  {item.platform} · {item.contentType}
                </span>
                <span className="vq-mono" role="cell">
                  {item.shots} 镜
                </span>
                <span className="vq-mono" role="cell">
                  {item.duration}
                </span>
                <span className="vq-mono" role="cell">
                  {item.time}
                </span>
                <span role="cell">
                  <MonoTag>{item.status === 'pass' ? '已入库' : '待核对'}</MonoTag>
                </span>
              </div>
            ))}
          </div>
        </section>

        <aside className="vq-section">
          <div className="vq-section-head">
            <div>
              <span className="vq-mono">03 / 待评审</span>
              <h2>结论待定</h2>
            </div>
            <button type="button" className="vq-link" onClick={() => onNavigate('review')}>
              整理队列
              <ArrowRight size={13} />
            </button>
          </div>
          {reviewQueue.map((item) => (
            <button type="button" className="vq-review" key={item.id} onClick={() => onNavigate('review')}>
              <span className="vq-frame vq-review-frame">
                <img src={item.frameUrl} alt="" loading="lazy" />
              </span>
              <span className="vq-review-body">
                <span className="vq-review-top">
                  <span className="vq-mono">{item.meta}</span>
                  <StatusPill tone={item.verdict}>{verdictLabel(item.verdict)}</StatusPill>
                </span>
                <strong>{item.title}</strong>
                <span className="vq-review-note">{item.note}</span>
              </span>
            </button>
          ))}
          <p className="vq-note">
            <Info size={12} />
            <span>评审服务尚未接入，以上为示例队列；结论不会写入任何地方。</span>
          </p>
        </aside>
      </div>

      <footer className="vq-overview-foot">
        <span>工作台数据来自本地模板库与演示队列，不连接真实账号体系。</span>
        <span className="vq-mono">VisionQA Workbench · 本地演示</span>
      </footer>
    </div>
  )
}
