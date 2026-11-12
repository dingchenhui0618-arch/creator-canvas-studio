import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, Eye, LayoutTemplate, Plus, RefreshCw, Search, Workflow, X } from 'lucide-react'
import type { Page } from '../domain/types'
import PageHead from '../components/PageHead'
import { MonoTag } from '../components/ui'
import { request } from '../api/client'
import { listBdcCanvases, type BdcCanvas } from '../api/bdc'
import type { RunProjectRef } from '../api/flows'
import { listProjects, listShares } from '../api/projects'
import {
  ackReview,
  listReviewQueue,
  unackReview,
  type ReviewQueueDecidedRow,
  type ReviewQueueFacets,
  type ReviewQueueRange,
  type ReviewQueueRow,
  type ReviewQueueSeenRow,
} from '../api/review'
import { deliveredCurrent, projectStatus, reviewsForVersion, type ProjectSummary, type ShareSummaryRow } from '../domain/project'
import { REVIEW_VERDICT_LABEL, reviewTimeLabel } from '../domain/review'
import { runWorkLine } from '../domain/run'
import { stampTime, visitLine } from '../domain/share'
import { useSiteInfo, useUiMode } from '../api/app'
import '../styles/overview.css'

type RunRow = {
  id: string
  flowName: string
  status: string
  startedAt: string
  durationMs: number
  // 这条运行挂在哪条作品的哪一版；空白画布直接跑的是 null
  project?: RunProjectRef | null
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
  onNavigate: (page: Page) => void
  // 工作台列的是画布服务里的画布项目：点哪块就开哪块，不再只是跳到画布页
  onOpenCanvas: (canvasId: string) => void
  // 作品是主线：有作品时主卡先给「继续这个作品」，没有才退回最近改动的画布
  onOpenProject: (projectId: string) => void
  // 空白画布：直接建一块并进去，不再先弹「智能体 / 资产画布」二选一（那个弹窗把主价值藏起来了）
  onCreateCanvas: () => void
  // 引导是弹窗：页脚「上手指引」重新打开它，不再跳一个 #/welcome 页面
  onOpenGuide: () => void
}

// 队列的三个时间范围（v0.9.25）：按那次评审的时间算，不是作品最近被点开的时间——
// 「等你看」等的是结论出来的那一刻。
const QUEUE_RANGES: { value: ReviewQueueRange; label: string; hint: string }[] = [
  { value: 'all', label: '全部时间', hint: '等你看的全列出来，按评审时间倒序' },
  { value: '7d', label: '7 天内', hint: '只看最近 7 天评出意见的' },
  { value: '30d', label: '30 天内', hint: '只看最近 30 天评出意见的' },
]

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
 * 工作台只回答一个问题：下一步点哪里。
 * 首屏是一张「下一步」主卡（继续上次那块画布，没画布就从一条爆款开始）加三个场景化入口；
 * 统计压进主卡右侧，不再单开一排数字卡——数字是背景，不是任务。
 * 任何一块没有数据就写空状态并给出下一步，不用示例行填充。
 */
export function OverviewPage({ userName, onNavigate, onOpenCanvas, onOpenProject, onCreateCanvas, onOpenGuide }: Props) {
  const { internal } = useUiMode()
  const site = useSiteInfo()
  const [now] = useState(() => new Date())
  const [canvases, setCanvases] = useState<BdcCanvas[]>([])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  // 工作台的分享汇总：一条作品一行，累计各轮打开情况（v0.9.12）
  const [shares, setShares] = useState<ShareSummaryRow[]>([])
  const [shareTotals, setShareTotals] = useState({ total: 0, opens: 0 })
  // 评审队列：最近一次结论是需人工确认 / 不通过的作品，按评审时间倒序（v0.9.19）
  const [queue, setQueue] = useState<ReviewQueueRow[]>([])
  const [queueTotal, setQueueTotal] = useState(0)
  // 不带筛选的全量：筛着的时候仍然写「全部还有 N 条」，不拿筛出来的数冒充全部（v0.9.25）
  const [queueAllTotal, setQueueAllTotal] = useState(0)
  // 时间范围的计数按关键字算、不按当前范围算：换一个范围，另一排数字仍然是真的
  const [queueFacets, setQueueFacets] = useState<ReviewQueueFacets>({ all: 0, '7d': 0, '30d': 0 })
  // 不跟着筛选变的最新一条：上面那张「下一步」主卡读它，筛列表不会把主卡换掉（v0.9.25）
  const [queueLead, setQueueLead] = useState<ReviewQueueRow | null>(null)
  // 队列的两种找法：时间范围 + 作品标题关键字；在服务端筛，不在这一屏里筛 20 条
  const [queueRange, setQueueRange] = useState<ReviewQueueRange>('all')
  const [queueKeyword, setQueueKeyword] = useState('')
  const queueSearchRef = useRef<HTMLInputElement | null>(null)
  // 看过了、这一版先不改的：还在作品里，但不催了（v0.9.20）
  const [seen, setSeen] = useState<ReviewQueueSeenRow[]>([])
  const [seenTotal, setSeenTotal] = useState(0)
  // 人已经拍过板的：结论按人的走，工作台只留一行交代它去了哪（v0.9.21）
  const [decided, setDecided] = useState<ReviewQueueDecidedRow[]>([])
  const [decidedTotal, setDecidedTotal] = useState(0)
  // 首屏只排 3 条，第 4 条以后不能凭空消失：给一行「还有 N 条」，点开排到服务端上限（20 条）
  const [queueOpen, setQueueOpen] = useState(false)
  // 正在「已看过 / 撤销」的那条作品：按钮转圈并禁用，防连点
  const [ackBusy, setAckBusy] = useState('')
  const [queueError, setQueueError] = useState('')
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    const problems: string[] = []
    // 队列不在这里取：它跟着筛选项走，由下面那个 effect 单独刷新（首屏也走那一处）
    const [canvasResult, runResult, templateResult, projectResult, shareResult] = await Promise.allSettled([
      listBdcCanvases(),
      request<{ items: RunRow[] }>('/api/runs'),
      request<{ items: TemplateRow[] }>('/api/templates'),
      listProjects(),
      listShares(),
    ])
    if (canvasResult.status === 'fulfilled' && canvasResult.value.ok) {
      setCanvases(canvasResult.value.canvases ?? [])
    } else {
      setCanvases([])
      problems.push('画布列表：' + (canvasResult.status === 'rejected' ? String((canvasResult.reason as Error)?.message || canvasResult.reason) : canvasResult.value.error || '读取失败'))
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
    if (projectResult.status === 'fulfilled') {
      setProjects(projectResult.value.items ?? [])
    } else {
      setProjects([])
      problems.push('作品：' + String((projectResult.reason as Error)?.message || projectResult.reason))
    }
    if (shareResult.status === 'fulfilled') {
      setShares(shareResult.value.items ?? [])
      setShareTotals({ total: shareResult.value.total ?? 0, opens: shareResult.value.opens ?? 0 })
    } else {
      setShares([])
      setShareTotals({ total: 0, opens: 0 })
      problems.push('分享记录：' + String((shareResult.reason as Error)?.message || shareResult.reason))
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

  // 队列单独刷新：筛选项变了、看没看过变了都只重取这一块，不必把整页五路请求重跑一遍。
  // 一次取到上限 20：首屏只渲染 3 条，展开时不必再打一次接口。
  const refreshQueue = useCallback(async () => {
    try {
      const result = await listReviewQueue(20, { range: queueRange, q: queueKeyword })
      setQueue(result.items ?? [])
      setQueueTotal(result.total ?? 0)
      setQueueAllTotal(result.allTotal ?? 0)
      setQueueFacets(result.facets ?? { all: 0, '7d': 0, '30d': 0 })
      setQueueLead(result.lead ?? null)
      setSeen(result.seen ?? [])
      setSeenTotal(result.seenTotal ?? 0)
      setDecided(result.decided ?? [])
      setDecidedTotal(result.decidedTotal ?? 0)
      setQueueError('')
    } catch (error) {
      setQueueError('评审队列：' + String((error as Error)?.message || error))
    }
  }, [queueKeyword, queueRange])

  // 换范围立刻问、打字等 220ms 再问；首屏不带筛选，也从这一处取
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshQueue()
    }, queueKeyword ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [queueKeyword, queueRange, refreshQueue])

  const queueFiltered = queueRange !== 'all' || queueKeyword.trim() !== ''

  const resetQueueFilter = useCallback(() => {
    setQueueRange('all')
    setQueueKeyword('')
    setQueueOpen(false)
    queueSearchRef.current?.focus()
  }, [])

  // 与作品页同一套顺手键：`/` 聚焦搜索、`Esc` 清关键字；正在别处输入时不抢键
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      if (event.key === '/' && !editing && queueAllTotal > 0) {
        event.preventDefault()
        queueSearchRef.current?.focus()
        return
      }
      if (event.key === 'Escape' && target === queueSearchRef.current && queueKeyword) {
        setQueueKeyword('')
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [queueAllTotal, queueKeyword])

  // 已看过：只处理待办，不动评审结论——那条评审还在评审历史里，作品胶囊照旧
  const markSeen = useCallback(
    async (projectId: string) => {
      setAckBusy(projectId)
      try {
        await ackReview(projectId)
        await refreshQueue()
      } catch (error) {
        setQueueError('「已看过」没记上：' + String((error as Error)?.message || error))
      } finally {
        setAckBusy('')
      }
    },
    [refreshQueue],
  )

  const undoSeen = useCallback(
    async (projectId: string) => {
      setAckBusy(projectId)
      try {
        await unackReview(projectId)
        await refreshQueue()
      } catch (error) {
        setQueueError('撤销没成功：' + String((error as Error)?.message || error))
      } finally {
        setAckBusy('')
      }
    },
    [refreshQueue],
  )

  // 队列先在页面上排 3 条：total 照旧是全部，第 4 条以后由「还有 N 条」展开
  const visibleQueue = queueOpen ? queue : queue.slice(0, 3)
  const queueHidden = Math.max(0, queueTotal - visibleQueue.length)

  const recentRuns = runs.slice(0, 6)
  const recentTemplates = templates.slice(0, 4)

  // 「下一步」= 手上还没交付的那条作品；没有作品再看最近改动的画布；都没有就从一条爆款开始。
  // 作品优先是这次产品结构收敛的核心：作品才是那条内容，画布只是它的一步。
  const latestCanvas = useMemo(() => {
    if (!canvases.length) return undefined
    return [...canvases].sort((a, b) => new Date(String(b.updatedAt ?? 0)).getTime() - new Date(String(a.updatedAt ?? 0)).getTime())[0]
  }, [canvases])

  // 还没交出去的那条优先：交付了 v2 又开了 v3 的作品，就是要接着做的那条
  const latestProject = useMemo(
    () => projects.find((item) => !deliveredCurrent(item)) ?? projects[0],
    [projects],
  )

  // 评审给了意见、还没改的那条最该先看：它比「最近改过的作品」更接近「下一步点哪里」。
  // 队列里的第一条要和作品列表对得上（作品可能刚被删），对不上就往后找。
  // 主卡读服务端给的 lead（不带筛选的最新一条）：筛队列是「找」，不该顺手把「下一步」换掉
  const queuedProject = useMemo(() => {
    const byId = new Map(projects.map((item) => [item.id, item]))
    const project = queueLead ? byId.get(queueLead.projectId) : undefined
    return queueLead && project ? { row: queueLead, project } : null
  }, [queueLead, projects])

  const hero = useMemo(() => {
    const heroProject = queuedProject?.project ?? latestProject
    if (heroProject) {
      const reviews = reviewsForVersion(heroProject.versionCounts || {}, heroProject.version)
      const status = projectStatus(heroProject, reviews, heroProject.decision ?? null)
      // 待改的读队列那条（它是评审队列的口径），其余读这一版最近一次评审
      const reviewNote =
        queuedProject && queuedProject.project.id === heroProject.id
          ? '最近评审 ' + (REVIEW_VERDICT_LABEL[queuedProject.row.verdict] || '有结论') + ' · ' + reviewTimeLabel(queuedProject.row.at)
          : reviews.count
            ? '最近评审 ' + (REVIEW_VERDICT_LABEL[reviews.lastVerdict] || '未记结论') + ' · ' + reviewTimeLabel(reviews.lastAt)
            : '还没进评审'
      return {
        label: '下一步 · 作品 · ' + status.text,
        title: heroProject.title,
        meta: (heroProject.template ? '模板 · ' + heroProject.template.title + ' · ' : '') + reviewNote,
        cta: queuedProject && queuedProject.project.id === heroProject.id ? '按意见改这一版' : '继续这个作品',
        go: () => onOpenProject(heroProject.id),
      }
    }
    if (latestCanvas) {
      return {
        label: '下一步 · 画布',
        title: latestCanvas.name,
        meta: latestCanvas.nodeCount + ' 个节点 · 版本 r' + latestCanvas.revision + ' · 上次改动 ' + clockOf(latestCanvas.updatedAt),
        cta: '继续这块画布',
        go: () => onOpenCanvas(latestCanvas.id),
      }
    }
    return {
      label: '下一步 · 找一条能抄的',
      title: '从一条爆款开始',
      meta: '检索抖音与小红书的真实互动数据，挑一条拆出脚本与分镜',
      cta: '去检索',
      go: () => onNavigate('radar'),
    }
  }, [latestProject, queuedProject, latestCanvas, onOpenProject, onOpenCanvas, onNavigate])

  return (
    <div className="vq-page">
      <PageHead
        kicker={
          <>
            <span>工作台</span>
            <span className="vq-head-sep" aria-hidden="true">·</span>
            <time dateTime={now.toISOString().slice(0, 10)}>{todayLabel(now)}</time>
          </>
        }
        title={loading ? '正在读取…' : '欢迎回来，' + userName}
        desc={
          loading
            ? '正在读取你账号下的画布、运行与模板。'
            : internal
              ? '首屏主卡读的是画布服务的最近改动；运行与模板分别来自 /api/runs 与 /api/templates。没有数据的区块写空状态，不放示例数据。'
              : '先看「下一步」，或者从下面三种方式开始一条新内容。'
        }
        actions={
          <>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => {
            void load()
            void refreshQueue()
          }}
          disabled={loading}>
              <RefreshCw size={14} />
              刷新
            </button>
            <button type="button" className="vq-button vq-button--primary" onClick={onCreateCanvas}>
              <Plus size={14} />
              新建画布
            </button>
          </>
        }
      />

      {errors.length ? (
        <p className="vq-note vq-note--error" role="status">
          {errors.join('；')}
        </p>
      ) : null}

      <section className="vq-next" aria-labelledby="vq-next-title">
        <div className="vq-next-main">
          <span className="vq-next-label">{hero.label}</span>
          <h2 id="vq-next-title">{hero.title}</h2>
          <p className="vq-next-meta">{hero.meta}</p>
          <button type="button" className="vq-next-cta" onClick={hero.go}>
            {hero.cta}
            <ArrowRight size={15} />
          </button>
        </div>
        <dl className="vq-next-stats">
          <div>
            <dt>作品</dt>
            <dd>{projects.length}</dd>
          </div>
          <div>
            <dt>画布</dt>
            <dd>{canvases.length}</dd>
          </div>
          <div>
            <dt>模板</dt>
            <dd>{templates.length}</dd>
          </div>
        </dl>
      </section>

      <section className="vq-section vq-review-queue" aria-labelledby="vq-review-queue-title">
        <div className="vq-section-head">
          <div>
            <h2 id="vq-review-queue-title">评审等你看的</h2>
            <p className="vq-review-queue-sub">
              {queueAllTotal
                ? '最近一次结论是「需人工确认」或「不通过」的作品，按评审时间排；点一条进作品改一版。'
                : seenTotal
                  ? '没有新的等你看；下面这些你看过了、这一版先没改。'
                  : decidedTotal
                    ? '没有新的等你看；这一条你已经拍过板，状态胶囊与下一步按你的结论走。'
                    : '评审给出意见的作品会排在这里；点一条进作品改一版，改完可以再评一次。'}
            </p>
          </div>
          <button type="button" className="vq-link" onClick={() => onNavigate('review')}>
            全部评审
            <ArrowUpRight size={13} />
          </button>
        </div>

        {/* 队列的找法（v0.9.25）：时间范围按那次评审的时间算、关键字只搜作品标题。
            在服务端筛——这一屏只有 20 条，只筛这 20 条会把「只列了最近 20 条」变成假话。 */}
        {queueAllTotal ? (
          <div className="vq-toolbar vq-review-queue-toolbar">
            <label className="vq-toolbar-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={queueSearchRef}
                type="search"
                value={queueKeyword}
                onChange={(event) => {
                  setQueueKeyword(event.target.value)
                  setQueueOpen(false)
                }}
                placeholder="搜索作品标题"
                aria-label="按作品标题搜索待办"
                autoComplete="off"
                spellCheck={false}
              />
              {queueKeyword ? (
                <button
                  type="button"
                  className="vq-toolbar-search-clear"
                  aria-label="清掉搜索"
                  title="清掉搜索（Esc）"
                  onClick={() => {
                    setQueueKeyword('')
                    queueSearchRef.current?.focus()
                  }}
                >
                  <X size={12} />
                </button>
              ) : (
                <kbd aria-hidden="true">/</kbd>
              )}
            </label>

            <div className="vq-filter-row" role="group" aria-label="按评审时间筛选">
              {QUEUE_RANGES.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  className={'vq-filter-chip' + (queueRange === entry.value ? ' is-active' : '')}
                  aria-pressed={queueRange === entry.value}
                  title={entry.hint}
                  onClick={() => {
                    setQueueRange(entry.value)
                    setQueueOpen(false)
                  }}
                >
                  {entry.label}
                  <span className="vq-filter-chip__count">{queueFacets[entry.value]}</span>
                </button>
              ))}
            </div>

            <p className="vq-toolbar-count">
              {queueFiltered ? (
                <>
                  筛出 <strong className="vq-mono">{queueTotal}</strong> / 全部 {queueAllTotal} 条
                </>
              ) : (
                <>共 {queueAllTotal} 条等你改</>
              )}
            </p>
            {queueFiltered ? (
              <button type="button" className="vq-toolbar-reset" onClick={resetQueueFilter}>
                清掉筛选
              </button>
            ) : null}
          </div>
        ) : null}

        {queueError ? (
          <p className="vq-note vq-note--error" role="status">
            {queueError}
          </p>
        ) : null}

        {queue.length ? (
          <>
            <div className="vq-review-queue-list">
              {visibleQueue.map((row) => (
              <div className="vq-review-queue-row" key={row.projectId}>
                <button
                  type="button"
                  className="vq-review-queue-open"
                  onClick={() => onOpenProject(row.projectId)}
                  aria-label={'打开作品：' + row.title + '，第 ' + Math.max(1, row.version) + ' 版'}
                >
                  <span className={'vq-project-status is-' + row.status.tone}>{row.status.text}</span>
                  <span className="vq-review-queue-copy">
                    <strong>{row.title}</strong>
                    <span className="vq-mono">
                      第 {Math.max(1, row.version)} 版 · 评过 {row.count} 次 ·{' '}
                      <span className="vq-review-queue-time">{reviewTimeLabel(row.at)}</span>
                    </span>
                  </span>
                  <ArrowRight size={13} />
                </button>
                <button
                  type="button"
                  className="vq-button vq-button--quiet vq-button--tiny vq-review-queue-ack"
                  onClick={() => void markSeen(row.projectId)}
                  disabled={ackBusy === row.projectId}
                  title="看过了，这一版先不改：从待办里拿掉；这一版再评出结论，它会自己回来"
                >
                  <Eye size={12} />
                  已看过
                </button>
              </div>
              ))}
            </div>
          {/* 第 4 条以后不凭空消失：先写「还有 N 条」，点开排到服务端上限；
              超过上限时如实写「只列最近 N 条」，不假装这一屏就是全部。 */}
          {queueHidden ? (
            <button type="button" className="vq-link vq-review-queue-more" onClick={() => setQueueOpen(true)}>
              还有 {queueHidden} 条等你改
              <ArrowRight size={12} />
            </button>
          ) : null}
          {queueTotal > queue.length ? (
            <p className="vq-review-queue-tail vq-mono">
              只列了最近 {queue.length} 条，还有 {queueTotal - queue.length} 条更早的等你改
            </p>
          ) : null}
          </>
        ) : queueFiltered ? (
          <div className="vq-empty vq-empty--inline">
            <strong>
              {queueKeyword.trim()
                ? '没有标题含「' + queueKeyword.trim() + '」的等你改'
                : queueRange === '7d'
                  ? '最近 7 天没有等你改的'
                  : '最近 30 天没有等你改的'}
            </strong>
            <span>
              全部还有 {queueAllTotal} 条等你改：把时间放宽到「全部时间」
              {queueKeyword.trim() ? '，或换个词' : ''}就能看到。
            </span>
            <button type="button" className="vq-button" onClick={resetQueueFilter}>
              清掉筛选
              <ArrowRight size={13} />
            </button>
          </div>
        ) : (
          <div className="vq-empty vq-empty--inline">
            <strong>{decidedTotal && !seenTotal ? '这一版你拍过板了' : seenTotal ? '等你看的都看过了' : '没有等你改的评审'}</strong>
            <span>
              {seenTotal
                ? '看过不等于改过：作品状态还是「评审 · 需人工确认 / 不通过」，评审证据也都在作品页；这一版再评一次会回到这里。'
                : decidedTotal
                  ? '拍板不是「已看过」：胶囊与下一步按你的结论走，交付稿与评审对照纸上也写着谁拍的板；再评出新结论后要重新拍板。'
                  : '评审一版画面后，结论是「需人工确认」或「不通过」的作品会排在这里；通过的作品直接去交付。'}
            </span>
            {seenTotal || decidedTotal ? null : (
              <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('review')}>
                去视觉评审
                <ArrowRight size={13} />
              </button>
            )}
          </div>
        )}

        {/* 看过的留在下面一行：还能撤销，也不是「改完了」 */}
        {seenTotal && seen[0] ? (
          <div className="vq-review-queue-seen">
            <span className="vq-review-queue-seen-text">
              已看过 {seenTotal} 条，这一版先没改 · 最近：{seen[0].title}（第 {Math.max(1, seen[0].version)} 版 ·{' '}
              {reviewTimeLabel(seen[0].seenAt)} 看过）
            </span>
            <button
              type="button"
              className="vq-link"
              onClick={() => void undoSeen(seen[0].projectId)}
              disabled={ackBusy === seen[0].projectId}
            >
              撤销
            </button>
          </div>
        ) : null}

        {/* 拍过板的也留一行：它不是「已看过」，胶囊与下一步已经按人的结论走了 */}
        {decidedTotal && decided[0] ? (
          <div className="vq-review-queue-seen is-decided">
            <span className="vq-review-queue-seen-text">
              你拍板过 {decidedTotal} 条 · 最近：{decided[0].title}（第 {Math.max(1, decided[0].version)} 版 ·{' '}
              {decided[0].decision === 'pass' ? '通过' : '不通过'} · {reviewTimeLabel(decided[0].decidedAt)}）· 撤销在作品页
            </span>
            <button type="button" className="vq-link" onClick={() => onOpenProject(decided[0].projectId)}>
              打开
            </button>
          </div>
        ) : null}
      </section>

      <div className="vq-start">
        <button type="button" className="vq-start-card" onClick={() => onNavigate('radar')}>
          <span className="vq-start-icon"><Search size={16} strokeWidth={1.75} /></span>
          <span className="vq-start-copy">
            <strong>从爆款开始</strong>
            <span>按关键词检索，挑一条加进模板库</span>
          </span>
          <ArrowRight size={15} />
        </button>
        <button type="button" className="vq-start-card" onClick={() => onNavigate('templates')}>
          <span className="vq-start-icon"><LayoutTemplate size={16} strokeWidth={1.75} /></span>
          <span className="vq-start-copy">
            <strong>从模板开始</strong>
            <span>
              {templates.length ? templates.length + ' 条已解析结构，套一条改写' : '模板库还是空的，先从爆款拆一条'}
            </span>
          </span>
          <ArrowRight size={15} />
        </button>
        <button type="button" className="vq-start-card" onClick={onCreateCanvas}>
          <span className="vq-start-icon"><Workflow size={16} strokeWidth={1.75} /></span>
          <span className="vq-start-copy">
            <strong>空白画布</strong>
            <span>从零搭节点，跑一次看每个节点返回什么</span>
          </span>
          <ArrowRight size={15} />
        </button>
      </div>

      <div className="vq-overview-grid">
        <section className="vq-section">
          <div className="vq-section-head">
            <div>
              <h2>最近运行</h2>
            </div>
            <button type="button" className="vq-link" onClick={() => onNavigate('runs')}>
              全部运行
              <ArrowUpRight size={13} />
            </button>
          </div>

          {recentRuns.length ? (
            <div className="vq-table" role="table" aria-label="最近运行">
              <div className="vq-table-head" role="row">
                <span role="columnheader">画布 / 作品</span>
                <span role="columnheader">状态</span>
                <span role="columnheader">耗时</span>
                <span role="columnheader">开始</span>
              </div>
              {recentRuns.map((run) => (
                <div className="vq-table-row" role="row" key={run.id}>
                  <div className="vq-table-name" role="cell">
                    <strong>{run.flowName}</strong>
                    {/* 第二行先回答「这是哪条作品的运行」：运行 ID 只在运行记录页里排障用得上 */}
                    <span className="vq-mono">{runWorkLine(run)}</span>
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

        <section className="vq-section">
          <div className="vq-section-head">
            <div>
              <h2>模板库</h2>
            </div>
            <button type="button" className="vq-link" onClick={() => onNavigate('templates')}>
              全部模板
              <ArrowRight size={13} />
            </button>
          </div>

          {recentTemplates.length ? (
            <>
              {recentTemplates.map((template) => (
                <button type="button" className="vq-template-row" key={template.id} onClick={() => onNavigate('templates')}>
                  <span className="vq-template-copy">
                    <strong>{template.title}</strong>
                    <span className="vq-mono">
                      {template.contentType || '脚本'} · {(template.durationSec ?? 0).toFixed(0)}s
                    </span>
                  </span>
                  <ArrowRight size={13} />
                </button>
              ))}
              <button type="button" className="vq-button vq-button--ghost vq-template-cta" onClick={() => onNavigate('templates')}>
                拿一条模板开始
                <ArrowRight size={13} />
              </button>
            </>
          ) : (
            <div className="vq-empty vq-empty--inline">
              <strong>模板库还是空的</strong>
              <span>在「发现」里复刻一条内容，拆出来的脚本结构会落到这里。</span>
              <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('radar')}>
                去检索
                <ArrowRight size={13} />
              </button>
            </div>
          )}
        </section>
      </div>

      <section className="vq-section vq-share-summary" aria-labelledby="vq-share-summary-title">
        <div className="vq-section-head">
          <div>
            <h2 id="vq-share-summary-title">分享出去的链接</h2>
            <p className="vq-share-summary-sub">
              {shares.length
                ? '共 ' + shareTotals.total + ' 条作品分享过 · ' + shareTotals.opens + ' 次打开。点开作品看每一轮。'
                : '发出去的链接，这里汇总有没有人点开。'}
            </p>
          </div>
          <button type="button" className="vq-link" onClick={() => onNavigate('projects')}>
            全部作品
            <ArrowUpRight size={13} />
          </button>
        </div>

        {shares.length ? (
          <div className="vq-share-summary-list">
            {shares.map((row) => (
              <button type="button" className="vq-share-summary-row" key={row.projectId} onClick={() => onOpenProject(row.projectId)}>
                <span className="vq-share-summary-copy">
                  <strong>{row.title}</strong>
                  <span className="vq-share-summary-meta">
                    <span className={'vq-share-summary-state' + (row.live ? ' is-live' : '')}>
                      {row.live ? <span className="vq-share-summary-dot" aria-hidden="true" /> : null}
                      {row.live ? '分享中' : '已停用'}
                    </span>
                    <span>
                      {row.rounds} 轮链接
                      {!row.live && row.lastClosedAt ? ' · 最近停用 ' + stampTime(row.lastClosedAt) : ''}
                    </span>
                  </span>
                </span>
                <span className="vq-share-summary-visits">
                  <b>{row.visits.opens}</b>
                  <span>{row.visits.opens ? '次打开 · ' + visitLine(row.visits) : '次打开 · 还没人点开'}</span>
                </span>
                <ArrowRight size={13} />
              </button>
            ))}
          </div>
        ) : (
          <div className="vq-empty vq-empty--inline">
            <strong>还没有分享出去的链接</strong>
            <span>在作品页点「分享」，把链接发给甲方；这里会汇总每条被打开过几次，停用后也留着。</span>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('projects')}>
              去作品列表
              <ArrowRight size={13} />
            </button>
          </div>
        )}
      </section>

      <footer className="vq-overview-foot">
        <span className="vq-overview-legal">
          <a className="vq-link" href="#/legal/terms">服务条款</a>
          <a className="vq-link" href="#/legal/privacy">隐私说明</a>
          <button type="button" className="vq-link" onClick={onOpenGuide}>
            上手指引
          </button>
          {site.icp ? <span className="vq-mono">{site.icp}</span> : null}
        </span>
      </footer>
    </div>
  )
}
