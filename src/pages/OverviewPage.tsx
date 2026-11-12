import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, Eye, LayoutTemplate, Plus, RefreshCw, RotateCcw, Search, Workflow, X } from 'lucide-react'
import type { Page } from '../domain/types'
import PageHead from '../components/PageHead'
import { MonoTag } from '../components/ui'
import { request } from '../api/client'
import { listBdcCanvases, type BdcCanvas } from '../api/bdc'
import type { RunProjectRef } from '../api/flows'
import { deliverablePrintUrl, listDeliveries, listProjects, listShares } from '../api/projects'
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
import {
  deliveredCurrent,
  projectStatus,
  reviewsForVersion,
  type ProjectDeliveryRow,
  type ProjectSummary,
  type ShareSummaryRow,
} from '../domain/project'
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

// 队列一页 20 条、最多翻 10 页（v0.9.27）：一页一页往后取，翻到底才说「都列出来了」。
// 200 条的顶是给「一次点开几百行」兜底：真到那儿了，用搜索或时间范围收窄比继续翻更省事。
const QUEUE_PAGE_SIZE = 20
const QUEUE_MAX_PAGES = 10

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
  // 人已经拍过板的：结论按人的走，工作台留一行交代它去了哪（v0.9.21）
  const [decided, setDecided] = useState<ReviewQueueDecidedRow[]>([])
  const [decidedTotal, setDecidedTotal] = useState(0)
  // 看过的 / 拍过板的点开就是整份清单（v0.9.28）：默认收着，不当成两串常驻列表
  const [seenOpen, setSeenOpen] = useState(false)
  const [decidedOpen, setDecidedOpen] = useState(false)
  // 首屏只排 3 条，第 4 条以后不能凭空消失：给一行「还有 N 条」，点开把已取回的行都排出来
  const [queueOpen, setQueueOpen] = useState(false)
  // 已经取到第几页（v0.9.27）：点一次「再看 N 条」加一页；换筛选回到第一页
  const [queuePages, setQueuePages] = useState(1)
  // 正在取下一页：按钮禁用，防连点
  const [queueBusy, setQueueBusy] = useState(false)
  // 正在「已看过 / 撤销」的那条作品：按钮转圈并禁用，防连点
  const [ackBusy, setAckBusy] = useState('')
  const [queueError, setQueueError] = useState('')
  // 交出去的（v0.9.32）：跨作品把每一次交付摊成一条线。
  // 首屏先排 3 条，点开排到已经取回的一页（8 条），再往下按 offset 接着取——
  // 「我交出去过什么」不该只给最近一条，也不该只在作品页里一条一条翻。
  const [deliveries, setDeliveries] = useState<ProjectDeliveryRow[]>([])
  const [deliveryTotal, setDeliveryTotal] = useState(0)
  const [deliverySummary, setDeliverySummary] = useState({ projects: 0, current: 0, lastAt: '' })
  const [deliveryHasMore, setDeliveryHasMore] = useState(false)
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [deliveryBusy, setDeliveryBusy] = useState(false)
  const [deliveryError, setDeliveryError] = useState('')
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    const problems: string[] = []
    // 队列不在这里取：它跟着筛选项走，由下面那个 effect 单独刷新（首屏也走那一处）
    const [canvasResult, runResult, templateResult, projectResult, shareResult, deliveryResult] = await Promise.allSettled([
      listBdcCanvases(),
      request<{ items: RunRow[] }>('/api/runs'),
      request<{ items: TemplateRow[] }>('/api/templates'),
      listProjects(),
      listShares(),
      listDeliveries(),
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

    if (deliveryResult.status === 'fulfilled') {
      setDeliveries(deliveryResult.value.items ?? [])
      setDeliveryTotal(deliveryResult.value.total ?? 0)
      setDeliverySummary({
        projects: deliveryResult.value.projects ?? 0,
        current: deliveryResult.value.currentTotal ?? 0,
        lastAt: deliveryResult.value.lastAt || '',
      })
      setDeliveryHasMore(Boolean(deliveryResult.value.hasMore))
    } else {
      setDeliveries([])
      setDeliveryTotal(0)
      setDeliverySummary({ projects: 0, current: 0, lastAt: '' })
      setDeliveryHasMore(false)
      problems.push('交付记录：' + String((deliveryResult.reason as Error)?.message || deliveryResult.reason))
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

  // 队列单独刷新：筛选项变了、看没看过变了、又翻了一页，都只重取这一块，不把整页五路请求重跑一遍。
  // 已经翻开几页就取几页（v0.9.27）：第 2 页之后刷新一次也要把前面的行一起取回来，
  // 否则「第 1 行已看过」拿掉后行整体前移，拼出来的列表会缺一条。
  const refreshQueue = useCallback(async () => {
    const pages = Math.max(1, Math.min(QUEUE_MAX_PAGES, Math.round(Number(queuePages) || 1)))
    setQueueBusy(true)
    try {
      const results = await Promise.all(
        Array.from({ length: pages }, (_, index) =>
          listReviewQueue(QUEUE_PAGE_SIZE, { range: queueRange, q: queueKeyword, offset: index * QUEUE_PAGE_SIZE }),
        ),
      )
      const first = results[0]
      // 按页顺序拼、按作品去重：翻页途中有人「已看过」时，相邻两页可能返回同一行
      const seenIds = new Set<string>()
      const rows: ReviewQueueRow[] = []
      for (const result of results) {
        for (const row of result.items ?? []) {
          if (seenIds.has(row.projectId)) continue
          seenIds.add(row.projectId)
          rows.push(row)
        }
      }
      setQueue(rows)
      setQueueTotal(first.total ?? 0)
      setQueueAllTotal(first.allTotal ?? 0)
      setQueueFacets(first.facets ?? { all: 0, '7d': 0, '30d': 0 })
      setQueueLead(first.lead ?? null)
      setSeen(first.seen ?? [])
      setSeenTotal(first.seenTotal ?? 0)
      setDecided(first.decided ?? [])
      setDecidedTotal(first.decidedTotal ?? 0)
      setQueueError('')
    } catch (error) {
      setQueueError('评审队列：' + String((error as Error)?.message || error))
    } finally {
      setQueueBusy(false)
    }
  }, [queueKeyword, queuePages, queueRange])

  // 换范围立刻问、打字等 220ms 再问；首屏不带筛选，也从这一处取
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshQueue()
    }, queueKeyword ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [queueKeyword, queueRange, refreshQueue])

  // 交付流水往下取（v0.9.32）：只取下一页，按「作品 + 版次」去重——
  // 翻页途中又交了一版时，相邻两页可能返回同一行。
  const loadMoreDeliveries = useCallback(async () => {
    if (deliveryBusy) return
    setDeliveryBusy(true)
    try {
      const next = await listDeliveries(deliveries.length)
      const seen = new Set(deliveries.map((row) => row.projectId + ':' + row.version))
      const merged = [...deliveries]
      for (const row of next.items ?? []) {
        const key = row.projectId + ':' + row.version
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(row)
      }
      setDeliveries(merged)
      setDeliveryHasMore(Boolean(next.hasMore))
      setDeliveryTotal(next.total ?? merged.length)
      setDeliverySummary({ projects: next.projects ?? 0, current: next.currentTotal ?? 0, lastAt: next.lastAt || '' })
      setDeliveryError('')
    } catch (error) {
      setDeliveryError('再往下没取到：' + String((error as Error)?.message || error))
    } finally {
      setDeliveryBusy(false)
    }
  }, [deliveries, deliveryBusy])

  // 交付稿在新标签里打开：与作品页同一个地址，纸的样式只写一处（v0.9.32）。
  // 被浏览器拦下就如实说一句，不假装打开了。
  const openDeliverable = useCallback((projectId: string) => {
    const opened = window.open(deliverablePrintUrl(projectId), '_blank', 'noopener')
    setDeliveryError(opened ? '' : '新标签被浏览器拦下了：允许本站弹窗，或者从作品页打开交付稿')
  }, [])

  const queueFiltered = queueRange !== 'all' || queueKeyword.trim() !== ''

  const resetQueueFilter = useCallback(() => {
    setQueueRange('all')
    setQueueKeyword('')
    setQueueOpen(false)
    // 换了找法就从第一页看起：不然会停在「第 2 页」而总数已经变了（v0.9.27）
    setQueuePages(1)
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
        const result = await unackReview(projectId)
        // 一条都没撤掉就别说撤了：多半是刚在作品页撤过（或者别人先撤了）
        if (!result?.removed) setQueueError('撤销没撤掉：这条「已看过」已经不在了，可能刚在作品页撤过')
        await refreshQueue()
      } catch (error) {
        setQueueError('撤销没成功：' + String((error as Error)?.message || error))
      } finally {
        setAckBusy('')
      }
    },
    [refreshQueue],
  )

  // 队列先在页面上排 3 条：第 4 条以后由「还有 N 条」展开，展开的只是已经取回来的行。
  // 取回来的行数 < 总数时才轮到「已列 20 / 27 条 · 再看 7 条」（v0.9.27）。
  const visibleQueue = queueOpen ? queue : queue.slice(0, 3)
  // 收着的时候写的是「队列里还有几条」（总数 - 3），不是「已经取回来几条」：
  // 点开先把已取回的 20 条排出来，屏下再写「已列 20 / 27 条」——两句话各说各的事实，数字接得上
  const queueMore = queueOpen ? 0 : Math.max(0, queueTotal - 3)
  const queueRest = Math.max(0, queueTotal - queue.length)
  const queueNextPage = Math.min(QUEUE_PAGE_SIZE, queueRest)
  const queueMaxed = queueRest > 0 && queuePages >= QUEUE_MAX_PAGES

  // 交付流水首屏排 3 条；点开排到已经取回的那一页（8 条），再往下才是「再看 N 条」
  const visibleDeliveries = deliveryOpen ? deliveries : deliveries.slice(0, 3)
  const deliveryMore = deliveryOpen ? 0 : Math.max(0, deliveries.length - 3)
  const deliveryRest = Math.max(0, deliveryTotal - deliveries.length)
  const deliveryNextPage = Math.min(8, deliveryRest)
  // 旧版的交付稿不按那一版生成（交付稿只按当前版）：有一行旧版就得把这句话说出来
  const hasPastDelivery = deliveries.some((row) => !row.current)

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
                  setQueuePages(1)
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
                    setQueuePages(1)
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
          {/* 第 4 条以后不凭空消失：先写「还有 N 条」，点开把已取回的行都排出来 */}
          {queueMore ? (
            <button type="button" className="vq-link vq-review-queue-more" onClick={() => setQueueOpen(true)}>
              还有 {queueMore} 条等你改
              <ArrowRight size={12} />
            </button>
          ) : null}
          {/* 翻页（v0.9.27）：取回来的行数少于总数时给出口，翻到底才说「都列出来了」。
              只在展开之后出现——收着的时候屏上只有 3 行，写「已列 20 条」会是一句假话。
              之前这里只有一句「只列了最近 20 条，还有 N 条更早的等你改」，点不动。 */}
          {queueOpen && queueRest ? (
            <div className="vq-review-queue-pager">
              <span className="vq-review-queue-pager-count vq-mono">
                已列 <strong>{queue.length}</strong> / {queueTotal} 条
              </span>
              {queueMaxed ? (
                <span className="vq-review-queue-pager-hint">
                  一次最多列 {QUEUE_MAX_PAGES * QUEUE_PAGE_SIZE} 条：用上面的搜索或时间范围收窄
                </span>
              ) : (
                <button
                  type="button"
                  className="vq-button vq-button--quiet vq-button--tiny"
                  onClick={() => setQueuePages((pages) => Math.min(QUEUE_MAX_PAGES, pages + 1))}
                  disabled={queueBusy}
                  title="接着往下排：一页 20 条"
                >
                  {queueBusy ? '正在取…' : '再看 ' + queueNextPage + ' 条'}
                  {queueBusy ? null : <ArrowRight size={12} />}
                </button>
              )}
            </div>
          ) : queueOpen && queuePages > 1 ? (
            <p className="vq-review-queue-tail vq-mono">全部 {queueTotal} 条都列出来了</p>
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

        {/* 看过的都留在这儿（v0.9.28）：以前只写「最近一条」、也只撤得掉最近一条，
            其余几条要看哪条作品得去作品页翻——等于记不回来。现在点开就是整份清单，逐条撤销。 */}
        {seenTotal && seen[0] ? (
          <div className="vq-review-queue-seen-block">
            <div className="vq-review-queue-seen">
              <span className="vq-review-queue-seen-text">
                已看过 <strong className="vq-mono">{seenTotal}</strong> 条，这一版先没改 · 最近：{seen[0].title}（第{' '}
                {Math.max(1, seen[0].version)} 版 · {reviewTimeLabel(seen[0].seenAt)} 看过）
              </span>
              <span className="vq-review-queue-seen-actions">
                <button
                  type="button"
                  className="vq-link"
                  onClick={() => setSeenOpen((open) => !open)}
                  aria-expanded={seenOpen}
                  aria-controls="vq-review-queue-seen-list"
                >
                  {seenOpen ? '收起' : '看这 ' + seenTotal + ' 条'}
                </button>
                {seenOpen ? null : (
                  <button
                    type="button"
                    className="vq-link"
                    onClick={() => void undoSeen(seen[0].projectId)}
                    disabled={ackBusy === seen[0].projectId}
                  >
                    撤销最近一条
                  </button>
                )}
              </span>
            </div>
            {seenOpen ? (
              <div className="vq-review-queue-list vq-review-queue-seen-list" id="vq-review-queue-seen-list">
                {seen.map((row) => (
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
                          <span className="vq-review-queue-time">{reviewTimeLabel(row.seenAt)} 看过</span>
                        </span>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                    <button
                      type="button"
                      className="vq-button vq-button--quiet vq-button--tiny vq-review-queue-ack"
                      onClick={() => void undoSeen(row.projectId)}
                      disabled={ackBusy === row.projectId}
                      title="撤销「已看过」：它回到待办，这一版照旧要改"
                    >
                      <RotateCcw size={12} />
                      {ackBusy === row.projectId ? '撤销中…' : '撤销'}
                    </button>
                  </div>
                ))}
                <p className="vq-review-queue-seen-note">
                  撤销之后它回到上面的待办；这一版再评出新结论也会自己回来。
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 拍过板的也能点开（v0.9.28）：胶囊写人的那一句，点一行进作品撤销或改判 */}
        {decidedTotal && decided[0] ? (
          <div className="vq-review-queue-seen-block">
            <div className="vq-review-queue-seen is-decided">
              <span className="vq-review-queue-seen-text">
                你拍板过 <strong className="vq-mono">{decidedTotal}</strong> 条 · 最近：{decided[0].title}（第{' '}
                {Math.max(1, decided[0].version)} 版 · {decided[0].decision === 'pass' ? '通过' : '不通过'} ·{' '}
                {reviewTimeLabel(decided[0].decidedAt)}）
              </span>
              <span className="vq-review-queue-seen-actions">
                <button
                  type="button"
                  className="vq-link"
                  onClick={() => setDecidedOpen((open) => !open)}
                  aria-expanded={decidedOpen}
                  aria-controls="vq-review-queue-decided-list"
                >
                  {decidedOpen ? '收起' : '看这 ' + decidedTotal + ' 条'}
                </button>
              </span>
            </div>
            {decidedOpen ? (
              <div className="vq-review-queue-list vq-review-queue-seen-list" id="vq-review-queue-decided-list">
                {decided.map((row) => (
                  <div className="vq-review-queue-row" key={row.projectId}>
                    <button
                      type="button"
                      className="vq-review-queue-open"
                      onClick={() => onOpenProject(row.projectId)}
                      aria-label={'打开作品：' + row.title + '，第 ' + Math.max(1, row.version) + ' 版'}
                      title={row.note || undefined}
                    >
                      <span className={'vq-project-status is-' + row.status.tone}>{row.status.text}</span>
                      <span className="vq-review-queue-copy">
                        <strong>{row.title}</strong>
                        <span className="vq-mono">
                          第 {Math.max(1, row.version)} 版 · 模型「{REVIEW_VERDICT_LABEL[row.verdict] || '未记结论'}」·{' '}
                          <span className="vq-review-queue-time">{reviewTimeLabel(row.decidedAt)} 拍板</span>
                        </span>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                  </div>
                ))}
                <p className="vq-review-queue-seen-note">
                  这里只列还等在队列里的拍板；点一行进作品，撤销这一版与改判都在「拍板记录」里。
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 交出去的（v0.9.32）：已经交出去的每一版，按交付时间倒序摊成一条线。
          这一行回答「交的是哪一版、什么时候」，不是「现在什么状态」——
          开过新版的旧交付仍然在（记录是事实），但不会被说成现状。 */}
      <section className="vq-section vq-delivery-ledger" aria-labelledby="vq-delivery-ledger-title">
        <div className="vq-section-head">
          <div>
            <h2 id="vq-delivery-ledger-title">交出去的</h2>
            <p className="vq-delivery-sub">
              {deliveryTotal
                ? '已经交出去 ' +
                  deliveryTotal +
                  ' 次，分布在 ' +
                  deliverySummary.projects +
                  ' 条作品上' +
                  (deliverySummary.current
                    ? '，其中 ' + deliverySummary.current + ' 次交的还是当前这一版。'
                    : '，都不是当前这一版了：开过新版，旧交付的记录仍然留着。')
                : '作品评审通过后在作品页「交付这一版」；交出去的每一版都排在这里，开过新版也留得住。'}
            </p>
          </div>
          <button type="button" className="vq-link" onClick={() => onNavigate('projects')}>
            全部作品
            <ArrowUpRight size={13} />
          </button>
        </div>

        {deliveryError ? (
          <p className="vq-note vq-note--error" role="status">
            {deliveryError}
          </p>
        ) : null}

        {deliveries.length ? (
          <>
            <div className="vq-delivery-list">
              {visibleDeliveries.map((row) => (
                <div className="vq-delivery-row" key={row.projectId + ':' + row.version}>
                  <button
                    type="button"
                    className="vq-delivery-open"
                    onClick={() => onOpenProject(row.projectId)}
                    aria-label={'打开作品：' + row.title + '，第 ' + row.version + ' 版'}
                  >
                    <span className="vq-delivery-tag vq-mono">v{row.version}</span>
                    <span className="vq-delivery-copy">
                      <strong>{row.title}</strong>
                      {/* 时间与结论各自成段：窄屏换行只在「·」处断，不会把「通过」劈成两行 */}
                      <span className="vq-mono vq-delivery-meta">
                        <span>{row.atKnown ? stampTime(row.at) + ' 交出去' : '交付时间没记下'}</span>
                        {' · '}
                        {row.reviews ? (
                          <>
                            <span>{'评审「' + (REVIEW_VERDICT_LABEL[row.verdict] || '未记结论') + '」'}</span>
                            {' · '}
                            <span>{'评过 ' + row.reviews + ' 次'}</span>
                          </>
                        ) : (
                          // 没进过评审就别写「未记结论」：那一行本来就没有结论可记
                          <span>交的时候没进评审</span>
                        )}
                      </span>
                    </span>
                    <span className={'vq-delivery-state' + (row.current ? ' is-current' : '')}>
                      {row.current ? '当前版' : '已到 v' + row.currentVersion}
                    </span>
                    <ArrowRight size={13} />
                  </button>
                  {row.current ? (
                    <button
                      type="button"
                      className="vq-button vq-button--quiet vq-button--tiny vq-delivery-paper"
                      onClick={() => openDeliverable(row.projectId)}
                      title="在新标签里打开这一版的交付稿（A4，可存 PDF）"
                    >
                      交付稿
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            {deliveryMore ? (
              <button type="button" className="vq-link vq-delivery-more" onClick={() => setDeliveryOpen(true)}>
                看这 {deliveries.length} 条
                <ArrowRight size={12} />
              </button>
            ) : null}

            {/* 翻页与评审队列同一套说法：左边写「已列 8 / 12 条」可以被核对，翻到底才说都列出来了 */}
            {deliveryOpen && deliveryRest ? (
              <div className="vq-delivery-pager">
                <span className="vq-delivery-pager-count vq-mono">
                  已列 <strong>{deliveries.length}</strong> / {deliveryTotal} 条
                </span>
                {deliveryHasMore ? (
                  <button
                    type="button"
                    className="vq-button vq-button--quiet vq-button--tiny"
                    onClick={() => void loadMoreDeliveries()}
                    disabled={deliveryBusy}
                    title="接着往下取：一页 8 条"
                  >
                    {deliveryBusy ? '正在取…' : '再看 ' + deliveryNextPage + ' 条'}
                    {deliveryBusy ? null : <ArrowRight size={12} />}
                  </button>
                ) : (
                  <span className="vq-delivery-pager-hint">全部 {deliveryTotal} 条都列出来了</span>
                )}
              </div>
            ) : deliveryOpen && deliveries.length > 8 ? (
              // 已经翻到底：说一句「都列出来了」，比让翻页行悄悄消失清楚
              <p className="vq-delivery-tail vq-mono">全部 {deliveryTotal} 条都列出来了</p>
            ) : null}

            {hasPastDelivery ? (
              <p className="vq-delivery-note">
                交付稿只按当前这一版生成：旧版要回看，点进去看作品里的「版本对照」。
              </p>
            ) : null}
          </>
        ) : (
          <div className="vq-empty vq-empty--inline">
            <strong>还没交出去过</strong>
            <span>标记交付之后，这里按时间排：交的是哪条作品的哪一版、什么时候、现在还算不算数。</span>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('projects')}>
              去作品列表
              <ArrowRight size={13} />
            </button>
          </div>
        )}
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
