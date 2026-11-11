import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, ArrowUpRight, Plus, RefreshCw } from 'lucide-react'
import type { Page } from '../domain/types'
import PageHead from '../components/PageHead'
import { MonoTag } from '../components/ui'
import { request } from '../api/client'
import { listBdcCanvases, type BdcCanvas } from '../api/bdc'
import { useSiteInfo, useUiMode } from '../api/app'
import '../styles/overview.css'

type RunRow = {
  id: string
  flowName: string
  status: string
  startedAt: string
  durationMs: number
}

type TemplateRow = {
  id: string
  title: string
  contentType?: string
  createdAt?: string
  durationSec?: number
}

type Props = {
  userName: string
  onCreate: () => void
  onNavigate: (page: Page) => void
  // 工作台列的是画布服务里的画布项目：点哪块就开哪块，不再只是跳到画布页
  onOpenCanvas: (canvasId: string) => void
}

const pad2 = (value: number) => String(value).padStart(2, '0')

// 页头日期用「2026-11-10 周二」：等宽数字对齐，比「2026 年 11 月 10 日 · 星期二」短一半，
// 也不会因为中文和数字混排被拉出一段虚的字距。
function todayLabel(date: Date): string {
  const iso = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)
  return `${iso} ${weekday}`
}

function clockOf(input?: string | number): string {
  const date = typeof input === 'number' ? new Date(input) : new Date(String(input ?? ''))
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

function secondsOf(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return (ms / 1000).toFixed(1) + 's'
}

/**
 * 工作台只看真实数据：画布来自画布服务，运行与模板来自工作台 API。
 * 任何一块没有数据就写空状态并给出下一步，不用示例行填充——上线后的首页不能靠假数据撑版面。
 */
export function OverviewPage({ userName, onCreate, onNavigate, onOpenCanvas }: Props) {
  const { internal } = useUiMode()
  const site = useSiteInfo()
  const [now] = useState(() => new Date())
  const [canvases, setCanvases] = useState<BdcCanvas[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    const problems: string[] = []
    const [canvasResult, runResult, templateResult] = await Promise.allSettled([
      listBdcCanvases(),
      request<{ items: RunRow[] }>('/api/runs'),
      request<{ items: TemplateRow[] }>('/api/templates'),
    ])
    if (canvasResult.status === 'fulfilled' && canvasResult.value.ok) {
      setCanvases(canvasResult.value.canvases ?? [])
    } else {
      setCanvases([])
      problems.push('画布列表：' + (canvasResult.status === 'rejected' ? String((canvasResult.reason as Error)?.message || canvasResult.reason) : canvasResult.value.error || '画布服务无响应'))
    }
    if (runResult.status === 'fulfilled') {
      setRuns(runResult.value.items ?? [])
    } else {
      setRuns([])
      problems.push('运行记录：' + String((runResult.reason as Error)?.message || runResult.reason))
    }
    if (templateResult.status === 'fulfilled') {
      setTemplates(templateResult.value.items ?? [])
    } else {
      setTemplates([])
      problems.push('模板库：' + String((templateResult.reason as Error)?.message || templateResult.reason))
    }
    setErrors(problems)
    setLoading(false)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const recentRuns = runs.slice(0, 6)
  const recentTemplates = templates.slice(0, 4)

  return (
    <div className="vq-page">
      <PageHead
        kicker={
          <>
            {/* 不给问候语：这一屏的价值是「有什么、各多少」，不是寒暄 */}
            <span>工作台</span>
            <span className="vq-head-sep" aria-hidden="true">·</span>
            <span>{userName}</span>
            <span className="vq-head-sep" aria-hidden="true">·</span>
            <time dateTime={now.toISOString().slice(0, 10)}>{todayLabel(now)}</time>
          </>
        }
        title={
          loading ? (
            '正在读取…'
          ) : (
            <>
              <b>{canvases.length}</b> 块画布
              <span className="vq-head-sep" aria-hidden="true">·</span>
              <b>{runs.length}</b> 条运行
              <span className="vq-head-sep" aria-hidden="true">·</span>
              <b>{templates.length}</b> 个模板
            </>
          )
        }
        desc={
          internal
            ? '三个数字分别来自画布服务、/api/runs 与 /api/templates；没有数据的区块写空状态，不放示例数据。'
            : '三个数字分别是画布、运行与模板的当前数量；没有数据时写清空状态。'
        }
        actions={
          <>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} />
              刷新
            </button>
            <button type="button" className="vq-button vq-button--primary" onClick={onCreate}>
              <Plus size={14} />
              新建
            </button>
          </>
        }
      />

      {errors.length ? (
        <p className="vq-note vq-note--error" role="status">
          {errors.join('；')}
        </p>
      ) : null}

      <section className="vq-section">
        <div className="vq-section-head">
          <div>
            <span className="vq-mono">01 / 画布</span>
            <h2>继续上次的画布</h2>
          </div>
          <span className="vq-mono">{canvases.length} 块</span>
        </div>

        {canvases.length ? (
          <div className="vq-task-grid">
            {canvases.slice(0, 3).map((canvas, index) => (
              <button type="button" className="vq-task" key={canvas.id} onClick={() => onOpenCanvas(canvas.id)}>
                <span className="vq-task-index">{String(index + 1).padStart(2, '0')}</span>
                <strong>{canvas.name}</strong>
                <p>
                  {canvas.nodeCount} 个节点 · 版本 r{canvas.revision}
                </p>
                <span className="vq-task-foot">
                  <span className="vq-mono">{clockOf(canvas.updatedAt)}</span>
                  <span className="vq-task-go">
                    打开画布
                    <ArrowRight size={12} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="vq-empty">
            <strong>还没有画布</strong>
            <span>画布与工作台共用同一批数据：在画布页新建一块，这里立刻会出现。</span>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('canvas')}>
              去画布
              <ArrowRight size={13} />
            </button>
          </div>
        )}
      </section>

      <div className="vq-overview-grid">
        <section className="vq-section">
          <div className="vq-section-head">
            <div>
              <span className="vq-mono">02 / 最近运行</span>
              <h2>逐节点执行记录</h2>
            </div>
            <button type="button" className="vq-link" onClick={() => onNavigate('runs')}>
              全部运行
              <ArrowUpRight size={13} />
            </button>
          </div>

          {recentRuns.length ? (
            <div className="vq-table" role="table" aria-label="最近运行">
              <div className="vq-table-head" role="row">
                <span role="columnheader">流程</span>
                <span role="columnheader">状态</span>
                <span role="columnheader">耗时</span>
                <span role="columnheader">开始</span>
              </div>
              {recentRuns.map((run) => (
                <div className="vq-table-row" role="row" key={run.id}>
                  <div className="vq-table-name" role="cell">
                    <strong>{run.flowName}</strong>
                    <span className="vq-mono">{run.id}</span>
                  </div>
                  <span role="cell">
                    <MonoTag>{run.status === 'success' ? '成功' : '失败'}</MonoTag>
                  </span>
                  <span className="vq-mono" role="cell">
                    {secondsOf(run.durationMs)}
                  </span>
                  <span className="vq-mono" role="cell">
                    {clockOf(run.startedAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="vq-empty vq-empty--inline">
              <strong>还没有运行记录</strong>
              <span>去画布点一次运行，这里会按节点列出耗时与返回。</span>
            </div>
          )}
        </section>

        <aside className="vq-section">
          <div className="vq-section-head">
            <div>
              <span className="vq-mono">03 / 模板库</span>
              <h2>可复用的脚本结构</h2>
            </div>
            <button type="button" className="vq-link" onClick={() => onNavigate('templates')}>
              打开模板库
              <ArrowRight size={13} />
            </button>
          </div>

          {recentTemplates.length ? (
            recentTemplates.map((template) => (
              <button type="button" className="vq-template-row" key={template.id} onClick={() => onNavigate('templates')}>
                <span className="vq-template-copy">
                  <strong>{template.title}</strong>
                  <span className="vq-mono">
                    {template.contentType || '脚本'} · {(template.durationSec ?? 0).toFixed(0)}s
                  </span>
                </span>
                <ArrowRight size={13} />
              </button>
            ))
          ) : (
            <div className="vq-empty vq-empty--inline">
              <strong>模板库还是空的</strong>
              <span>在爆款雷达里复刻一条内容，拆出来的脚本结构会落到这里。</span>
              <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('radar')}>
                去检索
                <ArrowRight size={13} />
              </button>
            </div>
          )}

          <p className="vq-note">
            <span>{internal ? '模板、运行与画布都存服务端，换浏览器登录同一账号即可看到。' : '模板、运行与画布都保存在你的账号下，换浏览器登录同一账号即可看到。'}</span>
          </p>
        </aside>
      </div>

      <footer className="vq-overview-foot">
        <span>{internal ? '画布数据来自画布服务；运行与模板来自工作台 API。' : '画布、运行与模板数据都在你的账号下。'}</span>
        <span className="vq-overview-legal">
          <a className="vq-link" href="#/legal/terms">服务条款</a>
          <a className="vq-link" href="#/legal/privacy">隐私说明</a>
          <a className="vq-link" href="#/welcome">上手指引</a>
          {site.icp ? <span className="vq-mono">{site.icp}</span> : null}
        </span>
      </footer>
    </div>
  )
}
