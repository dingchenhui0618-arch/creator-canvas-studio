import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ArrowRight, ChevronLeft, ChevronRight, Coins, Eye, GitCompareArrows, Link2, Loader2, Play, RefreshCw, Search, Workflow } from 'lucide-react'
import PageHead from '../components/PageHead'
import { Select } from '../components/Select'
import { RunCompareModal } from '../components/RunCompareModal'
import { adoptProjectCanvas, createProject, listProjects } from '../api/projects'
import type { ProjectSummary } from '../domain/project'
import { getRunResumePlan, listFlows, listRuns, type ApiFlow, type RunRecord, type RunResumePlan } from '../api/flows'
import { runCreditsText, runResumeInfo, runResumePlanView, runSpentText, runStatusMeta, runVersionLabel, runWorkLine } from '../domain/run'
import { readRunsView, resolveFlowFilter, writeRunsView, type RunsView } from '../domain/list-view'
import { scrollToSoft } from '../domain/motion'
import { creditKindLabel, getCredits, listCredits, type CreditEntry, type CreditsResponse } from '../api/credits'
import { readSession } from '../auth/session'
import '../styles/runs.css'

const PAGE_SIZE = 12
const LEDGER_PAGE = 20
const LEDGER_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'spend', label: '消耗' },
  { id: 'recharge', label: '充值' },
  { id: 'refund', label: '退款' },
] as const
type LedgerFilter = (typeof LEDGER_FILTERS)[number]['id']

// 续跑预检（v0.9.105）：记录里存的 resumable 是上次收尾时的判断；
// 工作流改过之后要按当前内容重算，页面才知道「还能复用几个、补多少」。
type ResumePlanState = {
  runId: string
  state: 'loading' | 'ready' | 'error'
  plan?: RunResumePlan
  message?: string
}

const fmtTime = (iso: string) => {
  const date = new Date(iso)
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const fmtFullTime = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')
}

const fmtNumber = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—'

// 一页流水按动作分四类：退款优先认（它也是正数），充值 / 赠送 / 发放都算进账，
// 管理员扣减虽然也是负数，但用户看到的是「钱从哪走的」，跟消耗放一起更好对账。
function ledgerBucket(entry: CreditEntry): LedgerFilter | 'other' {
  if (entry.kind.endsWith('-refund')) return 'refund'
  if (entry.delta > 0) return 'recharge'
  if (entry.delta < 0) return 'spend'
  return 'other'
}

// 动作名以服务端 kindLabel 为准（同一种扣费在不同入口叫法不同，例如快捷创作出图 vs 工作流出图）；
// 非管理员不看服务端按运行节点算出来的「工作流出图」，退回本地动作名，不露任何流程痕迹。
function ledgerAction(entry: CreditEntry, isAdmin: boolean): string {
  if (!isAdmin) return creditKindLabel(entry.kind)
  return entry.kindLabel || creditKindLabel(entry.kind)
}

// 说明列：管理员看账本原始说明与节点名；非管理员只留用户自己写的提示词 / 标题，
// 流程名、运行 ID、节点名与运行链接一律不出现。
function ledgerDescription(entry: CreditEntry, isAdmin: boolean): string {
  const label = String(entry.label || '').trim()
  if (isAdmin) {
    if (label) return label
    return entry.nodeLabel ? '工作流 · ' + entry.nodeLabel : ledgerAction(entry, true)
  }
  if (entry.kind === 'flow_run' || entry.kind === 'flow_run-refund') return ledgerAction(entry, false)
  if (entry.runId) {
    const tail = label.split(' · ').slice(1).join(' · ').trim()
    return tail && !tail.includes('退款') ? tail : ledgerAction(entry, false)
  }
  return label || ledgerAction(entry, false)
}

// 运行记录页：筛选与分页都在服务端做（GET /api/runs?flowId=&status=&q=&limit=&offset=），
// 前端只保留当前页，避免一次把几百条运行记录连节点输出全塞进浏览器。
// 节点类型是服务端内部代号（input / kb / llm…），页面上给中文名，认不出的原样显示。
const NODE_KIND_LABEL: Record<string, string> = {
  input: '输入',
  kb: '检索',
  llm: '模型',
  vision: '视觉',
  output: '输出',
  review: '评审',
  agent: '对话预设',
}

// 节点返回：用户要看的是「这一步拿回了什么」，不是一段 JSON。
// 对象按字段展开成两列；原始 JSON 收进折叠区，排障时还能看。
function NodeOutput({ output }: { output: unknown }) {
  const raw = String(typeof output === 'string' ? output : JSON.stringify(output, null, 2)).slice(0, 2000)
  const isRecord = Boolean(output) && typeof output === 'object' && !Array.isArray(output)
  if (!isRecord) {
    return <pre className="runs-node-output">{raw.slice(0, 900)}</pre>
  }
  const entries = Object.entries(output as Record<string, unknown>).slice(0, 8)
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '—'
    if (typeof value === 'string') return value.length > 180 ? value.slice(0, 180) + '…' : value
    if (Array.isArray(value)) return value.length ? value.length + ' 项' : '空'
    if (typeof value === 'object') {
      // 嵌套对象别甩一段 JSON：拆成「键 值」用 · 连起来
      const pairs = Object.entries(value as Record<string, unknown>)
        .slice(0, 5)
        .map(([key, inner]) => key + ' ' + cell(inner))
        .join(' · ')
      return pairs.length > 180 ? pairs.slice(0, 180) + '…' : pairs
    }
    return String(value)
  }
  return (
    <div className="runs-output">
      <dl className="runs-output-list">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{cell(value)}</dd>
          </div>
        ))}
      </dl>
      <details className="runs-output-raw">
        <summary>原始返回</summary>
        <pre className="runs-node-output">{raw}</pre>
      </details>
    </div>
  )
}

// onOpenProject：一条运行挂在作品上时，「回作品」直接进那条作品（脚本、分镜、评审都在那儿）。
function WorkflowRunsPanel({
  onOpenFlow,
  onResumeRun,
  onViewRun,
  onOpenProject,
}: {
  onOpenFlow?: (flowId: string) => void
  /** 续跑入口（v0.9.104）：回到工作流时把这条运行放回抽屉，已跑完的节点不再重复扣费 */
  onResumeRun?: (flowId: string, runId: string) => void
  /** 只读回放（v0.9.106）：在工作流上查看这次运行的节点状态，不改工作流、不扣费 */
  onViewRun?: (flowId: string, runId: string) => void
  onOpenProject?: (projectId: string) => void
}) {
  const [items, setItems] = useState<RunRecord[]>([])
  const [total, setTotal] = useState(0)
  const [flows, setFlows] = useState<ApiFlow[]>([])
  // 上次在这张页面上筛过的条件（v0.9.44）：去作品看一眼再回来，流程 / 状态 / 搜索词都还在
  const [savedView] = useState<RunsView>(() => readRunsView(window.sessionStorage))
  const [flowId, setFlowId] = useState(savedView.flowId)
  const [status, setStatus] = useState<'' | 'success' | 'error' | 'interrupted'>(savedView.status)
  const [keyword, setKeyword] = useState(savedView.keyword)
  // 流程清单读成功过没有：只在「读到了、但里面没有这条工作流」时才清掉记下来的流程
  const [flowsLoaded, setFlowsLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  // 运行记录页直接对照（v0.9.111）：不用先进只读回看，挑中的这条作为「当前运行」。
  const [compareRun, setCompareRun] = useState<RunRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [resumePlan, setResumePlan] = useState<ResumePlanState | null>(null)
  const [planNonce, setPlanNonce] = useState(0)
  // 归到作品（v0.9.29）：没挂在作品上的运行以前只有一句「作品页不会出现它」，
  // 现在就地能把它收进一条作品——挂到已有作品，或者照这条工作流新建一条。
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [adoptId, setAdoptId] = useState('')
  const [adoptBusy, setAdoptBusy] = useState(false)
  const [adoptError, setAdoptError] = useState('')
  const [adoptDone, setAdoptDone] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(keyword.trim()), 350)
    return () => window.clearTimeout(timer)
  }, [keyword])

  // 记住的那块工作流可能已经删了、或不是这个账号的：判据在 domain/list-view 的 resolveFlowFilter，
  // 在渲染里算，不另开一个 effect 去改 state——那会多一轮渲染，也是「effect 里 setState」的坏味道。
  const activeFlowId = resolveFlowFilter(flowId, flows.map((flow) => flow.id), flowsLoaded)

  // 条件一变就记下来；三样都空就把键删掉（「清空筛选」= 不留一条空记录）
  useEffect(() => {
    writeRunsView(window.sessionStorage, { keyword, flowId: activeFlowId, status })
  }, [activeFlowId, keyword, status])

  // 换一条运行就把这块面板收起来：上一条的「已归到…」不该挂在另一条运行下面。
  // 不写成 effect（在 effect 里同步 setState 会多渲染一轮），就在切选中项的那两处调。
  const resetAdopt = () => {
    setAdoptOpen(false)
    setAdoptId('')
    setAdoptError('')
    setAdoptDone('')
  }

  // 窄屏（≤1100）列表与详情是上下排的，详情落在整张清单下面。
  // 点一行只让那一行变色，人在手机上看不出「已经打开了」，得把详情滚到眼前；
  // 桌面两栏并排，详情一直在右边，不需要滚（也不该抢走滚动位置）。
  const detailRef = useRef<HTMLElement | null>(null)
  const revealDetail = () => {
    if (!window.matchMedia('(max-width: 1100px)').matches) return
    window.requestAnimationFrame(() => {
      const section = detailRef.current
      if (!section) return
      scrollToSoft(section, { block: 'start' })
    })
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await listRuns({ flowId: activeFlowId, status, q: query, limit: PAGE_SIZE, offset })
      setItems(result.items || [])
      setTotal(result.total || 0)
      setOpen(result.items?.[0]?.id || null)
      resetAdopt()
    } catch (reason) {
      setError(String((reason as Error)?.message || reason))
    } finally {
      setLoading(false)
    }
  }, [activeFlowId, offset, query, status])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  // 有单在排队或正在跑时，这一页自己跟上（v0.9.98）：不整页重载、不把选中项跳回第一条，
  // 也不闪「读取运行记录…」——只是安静地把列表换掉。没有活着的行就停，不白轮询。
  const refresh = useCallback(async () => {
    try {
      const result = await listRuns({ flowId: activeFlowId, status, q: query, limit: PAGE_SIZE, offset })
      const list = result.items || []
      setItems(list)
      setTotal(result.total || 0)
      setOpen((id) => (id && list.some((item) => item.id === id) ? id : list[0]?.id || null))
    } catch {
      // 轮询失败不打断页面：下一轮再来，真正读不到时还有手动刷新
    }
  }, [activeFlowId, offset, query, status])

  const live = items.some((item) => item.status === 'running' || item.status === 'queued')
  useEffect(() => {
    if (!live) return undefined
    const timer = window.setInterval(() => { void refresh() }, 3000)
    return () => window.clearInterval(timer)
  }, [live, refresh])

  useEffect(() => {
    let alive = true
    void listFlows()
      .then((list) => {
        if (!alive) return
        setFlows(list)
        setFlowsLoaded(true)
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  // 作品列表只在打开「归到作品」时取：运行记录页平时不需要它，
  // 现取也保证刚建好的作品马上出现在下拉里。
  useEffect(() => {
    if (!adoptOpen) return undefined
    let alive = true
    void listProjects()
      .then((result) => { if (alive) setProjects(result.items || []) })
      .catch(() => { if (alive) setProjects([]) })
    return () => { alive = false }
  }, [adoptOpen])


  const pageStart = total === 0 ? 0 : Math.min(offset + 1, total)
  const pageEnd = Math.min(offset + items.length, total)
  const pageSuccess = items.filter((item) => item.status === 'success').length
  // 中断不是失败：分开数，页面上第三格写「本页未完成」，不把重启打断算成运行出错
  const pageFailed = items.filter((item) => item.status === 'error').length
  const pageInterrupted = items.filter((item) => item.status === 'interrupted').length
  const current = items.find((item) => item.id === open) || null
  // 只有记录本身说「有跑完、也有没跑」的终态运行才值得预检。
  // 排队的和在跑的不问：它们没有可复用的旧结果。
  const planRun = current && current.status !== 'running' && current.status !== 'queued' && runResumeInfo(current).resumable ? current : null
  const planRunId = planRun?.id || ''
  const planFlowId = planRun?.flowId || ''
  // effect 落地前先用「核对中」占位，避免上一条运行的旧 plan 挂到新选中的行上。
  const planNow: ResumePlanState | null = planRunId
    ? (resumePlan?.runId === planRunId ? resumePlan : { runId: planRunId, state: 'loading' })
    : null
  const planView = planNow?.state === 'ready' ? runResumePlanView(planNow.plan ?? null) : null
  const storedResume = runResumeInfo(current)
  // 预检说不能续时，按钮也必须消失——不能让用户点进去才发现没有可复用的节点。
  // 预检失败（网络 / 服务端临时错误）仍按记录估算，服务端运行时还会再判一次。
  const canResume = planNow?.state === 'ready' ? Boolean(planNow.plan?.resumable) : storedResume.resumable
  const resumeBusy = planNow?.state === 'loading'

  useEffect(() => {
    // 不在 effect 里同步写「核对中」：那会多一轮渲染，也会让 lint 的
    // set-state-in-effect 亮起来。planNow 在渲染时按 runId 判断有没有拿到
    // 当前这条运行的 plan，没拿到就是 loading。
    if (!planRunId || !planFlowId) return undefined
    let alive = true
    getRunResumePlan(planFlowId, planRunId)
      .then((plan) => { if (alive) setResumePlan({ runId: planRunId, state: 'ready', plan }) })
      .catch((reason) => {
        if (alive) setResumePlan({ runId: planRunId, state: 'error', message: String((reason as Error)?.message || reason) })
      })
    return () => { alive = false }
  }, [planRunId, planFlowId, planNonce])

  const filtered = Boolean(activeFlowId || status || query)
  const hasPrev = offset > 0
  const hasNext = offset + items.length < total

  const resetTo = (next: () => void) => {
    next()
    setOffset(0)
  }

  // 归到作品的两条路都把结果就地写回这一行：服务端回的版次就是作品现在的版次。
  // 不整页重取——重取会把选中项跳回第一条，人刚做完的事当场就看不见了。
  const attachProject = (project: { id: string; title: string; version: number }) => {
    if (!current) return
    const ref = { id: project.id, title: project.title, version: Math.max(1, Math.round(Number(project.version) || 1)), archived: false }
    // 归的是整块工作流，不是选中那一条运行：同一条工作流上的其他运行也一起归过去了，
    // 只改当前这一行会让旁边几行继续写着「没挂在作品上」——那是假话。
    setItems((list) => list.map((item) => (item.flowId === current.flowId ? { ...item, project: ref } : item)))
  }

  const adoptedLine = (project: { title: string; version: number }, runs: number, how: 'bind' | 'new') => {
    const version = '第 ' + Math.max(1, Math.round(Number(project.version) || 1)) + ' 版'
    const runsText = runs > 0 ? '这条工作流跑过的 ' + runs + ' 次运行一起归过去了' : '这条工作流还没有运行记录'
    const tail = runsText + '（运行不复制记录，只认这条工作流）'
    return how === 'bind'
      ? '已归到《' + project.title + '》' + version + '：' + tail
      : '照这条工作流新建了《' + project.title + '》' + version + '：没有模板，脚本在作品页现写；' + tail
  }

  const adoptExisting = async () => {
    if (!current || !adoptId) return
    setAdoptBusy(true)
    setAdoptError('')
    try {
      const result = await adoptProjectCanvas(adoptId, current.flowId)
      attachProject(result.project)
      setAdoptDone(adoptedLine(result.project, result.runs?.count ?? 0, 'bind'))
      setAdoptOpen(false)
      setAdoptId('')
    } catch (reason) {
      setAdoptError(reason instanceof Error ? reason.message : '归到作品没有成功，稍后再试一次')
    } finally {
      setAdoptBusy(false)
    }
  }

  const adoptNew = async () => {
    if (!current) return
    setAdoptBusy(true)
    setAdoptError('')
    try {
      const result = await createProject({ flowId: current.flowId, title: current.flowName })
      attachProject(result.project)
      setAdoptDone(adoptedLine(result.project, result.runs?.count ?? 0, 'new'))
      setAdoptOpen(false)
    } catch (reason) {
      setAdoptError(reason instanceof Error ? reason.message : '新建作品没有成功，稍后再试一次')
    } finally {
      setAdoptBusy(false)
    }
  }

  return (
    <>
      {/* 读失败时这四个数不能写 0：0 条运行和「没读到」是两件事（r269）。 */}
      <div className="runs-stats">
        <div><strong>{error ? '—' : total}</strong><span>{filtered ? '筛选结果' : '总运行'}</span></div>
        <div><strong>{error ? '—' : pageSuccess}</strong><span>本页成功</span></div>
        <div><strong>{error ? '—' : pageFailed + pageInterrupted}</strong><span>{pageInterrupted ? '本页未完成' : '本页失败'}</span></div>
        <div><strong>{error ? '—' : total ? pageStart + '–' + pageEnd : '0'}</strong><span>当前区间</span></div>
      </div>

      <div className="runs-filters">
        <label className="runs-search">
          <Search size={14} />
          <input
            value={keyword}
            onChange={(event) => resetTo(() => setKeyword(event.target.value))}
            placeholder="按作品名、工作流名、运行 ID 或错误信息搜索"
            spellCheck={false}
          />
        </label>
        <label className="runs-select">
          <span>流程</span>
          <Select
            size="sm"
            label="按流程筛选"
            value={activeFlowId}
            options={[{ value: '', label: '全部流程' }, ...flows.map((flow) => ({ value: flow.id, label: flow.name }))]}
            onChange={(value) => resetTo(() => setFlowId(value))}
          />
        </label>
        <label className="runs-select">
          <span>状态</span>
          <Select
            size="sm"
            label="按状态筛选"
            value={status}
            options={[
              { value: '', label: '全部状态' },
              { value: 'success', label: '成功' },
              { value: 'error', label: '失败' },
              { value: 'interrupted', label: '已中断' },
            ]}
            onChange={(value) => resetTo(() => setStatus(value as '' | 'success' | 'error' | 'interrupted'))}
          />
        </label>
        {filtered ? (
          <button
            type="button"
            className="vq-button vq-button--ghost vq-button--sm"
            onClick={() => resetTo(() => { setKeyword(''); setFlowId(''); setStatus('') })}
          >
            清空筛选
          </button>
        ) : null}
        <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={() => void refresh()}>
          <RefreshCw size={13} />刷新
        </button>
      </div>

      {error ? <p className="runs-note is-error">{error}</p> : null}
      {loading ? <p className="runs-note">读取运行记录…</p> : null}

      {/* 读失败时上面已经有一句错误说明：这里再写「还没有运行记录」就是自相矛盾（r269）。 */}
      {!loading && !error && !items.length ? (
        <div className="runs-empty">
          <Workflow size={18} strokeWidth={1.5} />
          <strong>{filtered ? '没有符合条件的运行记录' : '还没有运行记录'}</strong>
          <span>{filtered ? '换个流程、状态或关键词再试。' : '去「工作流」点一次运行，这里会出现逐节点结果。'}</span>
        </div>
      ) : null}

      {items.length ? (
        <div className="runs-body">
          <ol className="runs-list">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`runs-row ${open === item.id ? 'is-active' : ''}`}
                  onClick={() => {
                    setOpen(item.id)
                    resetAdopt()
                    revealDetail()
                  }}
                >
                  <span className={`runs-dot is-${runStatusMeta(item.status, item.canceled).tone}`} />
                  <span className="runs-row-main">
                    <strong>{item.flowName}</strong>
                    <small className={'runs-row-where' + (item.project ? '' : ' is-orphan')}>{runWorkLine(item)}</small>
                    <small className="vq-mono">{item.id} · {item.total} 个节点</small>
                  </span>
                  <span className="runs-row-meta">
                    <span className="vq-mono">{runStatusMeta(item.status, item.canceled).label}</span>
                    <span className="vq-mono">{runSpentText(item)}</span>
                    <span className="vq-mono">{fmtTime(item.startedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>

          {current ? (
            <section className="runs-detail" ref={detailRef}>
              <div className="runs-detail-head">
                <Activity size={14} strokeWidth={1.5} />
                <strong>{current.flowName}</strong>
                <span className="vq-mono">{runSpentText(current)}</span>
                {current.status === 'queued' && current.credits && current.credits.cost > 0 ? (
                  <span className="vq-mono">排到后扣 {current.credits.cost} 积分</span>
                ) : runCreditsText(current) ? (
                  <span className="vq-mono">{runCreditsText(current)}</span>
                ) : null}
                {current.resumeOf ? (
                  <span className="vq-mono" title="上次已跑完的节点直接复用，这次只补没跑完的部分">
                    续跑自 {current.resumeOf} · 复用 {current.reusedNodes ?? 0} 个节点
                  </span>
                ) : null}
                <span className="runs-detail-actions">
                  {!current.project ? (
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-button--sm"
                      aria-expanded={adoptOpen}
                      onClick={() => {
                        setAdoptOpen((value) => !value)
                        setAdoptError('')
                      }}
                      title="把这次运行归到一条作品：挂到已有作品，或者照这条工作流新建一条"
                    >
                      <Link2 size={13} />
                      {adoptOpen ? '收起' : '归到作品'}
                    </button>
                  ) : null}
                  {current.project && onOpenProject ? (
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-button--sm"
                      onClick={() => onOpenProject(current.project?.id || '')}
                    >
                      回作品
                      <ArrowRight size={13} />
                    </button>
                  ) : null}
                  {current.status !== 'running' && current.status !== 'queued' ? (
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-button--sm"
                      onClick={() => setCompareRun(current)}
                      title="把这次运行和另一条运行摆在一起：同一条工作流，或同一件作品的另一版工作流；逐节点看变化、耗时与扣费，只读、不重跑"
                    >
                      <GitCompareArrows size={13} />对照
                    </button>
                  ) : null}
                  {onViewRun && current.status !== 'running' && current.status !== 'queued' ? (
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-button--sm"
                      onClick={() => onViewRun(current.flowId, current.id)}
                      title="在工作流上只读查看这次运行：节点状态与输出来自这条记录，不会改动工作流，也不扣积分"
                    >
                      <Eye size={13} />查看这次运行
                    </button>
                  ) : null}
                  {onResumeRun && current.status !== 'running' && current.status !== 'queued' && canResume ? (
                    <button
                      type="button"
                      className="vq-button vq-button--primary vq-button--sm"
                      onClick={() => onResumeRun(current.flowId, current.id)}
                      disabled={resumeBusy}
                      title={resumeBusy
                        ? '正在按当前工作流核对还能复用几个节点'
                        : planView?.resumable
                          ? planView.note
                          : '回到工作流，只补没跑完的节点；已跑完的节点直接复用，不重复扣费'}
                    >
                      {resumeBusy ? <Loader2 size={13} className="vq-spin" /> : <Play size={13} fill="currentColor" />}
                      {resumeBusy ? '继续运行 · 核对中' : planView?.resumable ? planView.button : '继续运行'}
                    </button>
                  ) : null}
                  {onOpenFlow ? (
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-button--sm"
                      onClick={() => onOpenFlow(current.flowId)}
                    >
                      在工作流打开
                    </button>
                  ) : null}
                </span>
              </div>
              {planNow ? (
                <div
                  className={'runs-plan' + (planView ? (planView.resumable ? ' is-ready' : ' is-blocked') : '')}
                  aria-live="polite"
                >
                  <span className="runs-plan-label">续跑预检</span>
                  {planNow.state === 'loading' ? (
                    <span className="runs-plan-main">
                      <Loader2 size={13} className="vq-spin" />
                      正在按当前工作流核对能复用几个、还要补多少积分…
                    </span>
                  ) : planNow.state === 'error' ? (
                    <>
                      <span className="runs-plan-main">这次没能核对</span>
                      <p className="runs-plan-copy">
                        服务端返回：{planNow.message || '未知错误'}。仍按上次记录估算，点继续运行时服务端还会再判一次。
                      </p>
                      <button
                        type="button"
                        className="vq-button vq-button--ghost vq-button--sm runs-plan-retry"
                        onClick={() => setPlanNonce((value) => value + 1)}
                      >
                        重新核对
                      </button>
                    </>
                  ) : planView ? (
                    <>
                      <strong className="runs-plan-main">{planView.summary}</strong>
                      <p className="runs-plan-copy">{planView.note}</p>
                    </>
                  ) : null}
                </div>
              ) : null}
              {current.project ? (
                <p className="runs-detail-where">
                  作品 · {current.project.title} · {runVersionLabel(current.project)}
                </p>
              ) : (
                <p className="runs-detail-where is-orphan">
                  这次运行没挂在作品上：空白工作流直接跑的，作品页不会出现它。点「归到作品」把它收进一条作品，跑过的记录一起跟过去。
                </p>
              )}
              {!current.project && adoptOpen ? (
                <div className="runs-adopt">
                  <div className="runs-adopt-row">
                    <span className="runs-adopt-label">挂到已有作品</span>
                    <Select
                      size="sm"
                      label="选择要归到的作品"
                      value={adoptId}
                      options={[
                        { value: '', label: projects.length ? '选一条作品' : '账号下还没有作品' },
                        ...projects.map((item) => ({
                          value: item.id,
                          label: item.title + ' · ' + (item.version ? '第 ' + item.version + ' 版' : '还没开工作流'),
                        })),
                      ]}
                      onChange={(value) => {
                        setAdoptId(value)
                        setAdoptError('')
                      }}
                    />
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-button--sm"
                      disabled={!adoptId || adoptBusy}
                      onClick={() => void adoptExisting()}
                    >
                      {adoptBusy ? '正在归…' : '挂到这条作品'}
                    </button>
                  </div>
                  <div className="runs-adopt-row">
                    <span className="runs-adopt-label">或者新建</span>
                    <span className="runs-adopt-hint">
                      照这条工作流建一条《{current.flowName}》：没有模板，脚本在作品页现写
                    </span>
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-button--sm"
                      disabled={adoptBusy}
                      onClick={() => void adoptNew()}
                    >
                      照这条工作流建一条
                    </button>
                  </div>
                  {adoptError ? <p className="runs-adopt-error">{adoptError}</p> : null}
                </div>
              ) : null}
              {adoptDone ? <p className="runs-adopt-done">{adoptDone}</p> : null}
              {current.status !== 'success' ? (
                <p className="runs-note">
                  {runStatusMeta(current.status, current.canceled).note}
                  {current.status === 'error' || current.status === 'interrupted' ? (
                    <a className="vq-link" href="#/help/replicate-failed">
                      看常见原因
                    </a>
                  ) : null}
                </p>
              ) : null}
              <ol className="runs-nodes">
                {current.nodes.map((node) => (
                  <li key={node.id} className={`runs-node is-${node.status}`}>
                    <div className="runs-node-head">
                      <span className="vq-mono">{NODE_KIND_LABEL[node.kind] ?? node.kind}</span>
                      <strong>{node.title}</strong>
                      <span className="vq-mono">{node.ms}ms</span>
                    </div>
                    {node.error ? <p className="runs-node-error">{node.error}</p> : null}
                    {node.message ? <p className="runs-node-error">{node.message}</p> : null}
                    {node.output != null ? <NodeOutput output={node.output} /> : null}
                  </li>
                ))}
              </ol>
              {current.error ? <p className="runs-node-error">{current.error}</p> : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {compareRun ? <RunCompareModal runId={compareRun.id} onClose={() => setCompareRun(null)} /> : null}

      {total > 0 ? (
        <div className="runs-pager">
          <span className="vq-mono">{pageStart}–{pageEnd} / {total}</span>
          <button type="button" className="vq-button vq-button--ghost vq-button--sm" disabled={!hasPrev} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            <ChevronLeft size={13} />上一页
          </button>
          <button type="button" className="vq-button vq-button--ghost vq-button--sm" disabled={!hasNext} onClick={() => setOffset(offset + PAGE_SIZE)}>
            下一页<ChevronRight size={13} />
          </button>
        </div>
      ) : null}
    </>
  )
}

// 积分记录（r313）：用户要能看见每一笔扣了多少、扣在哪个动作上，以及充值 / 赠送的增减。
// 管理员另有「工作流运行」页签；普通账号只看这一本积分账，页面上不出现工作流入口。
export function RunsPage({
  onOpenFlow,
  onResumeRun,
  onViewRun,
  onOpenProject,
  onRecharge,
  onQuickCreate,
}: {
  onOpenFlow?: (flowId: string) => void
  onResumeRun?: (flowId: string, runId: string) => void
  onViewRun?: (flowId: string, runId: string) => void
  onOpenProject?: (projectId: string) => void
  onRecharge?: () => void
  onQuickCreate?: () => void
}) {
  // App 已经用服务端会话渲染这一页；这里读同一份缓存只为决定「有没有工作流运行页签」，
  // 真正的权限仍由服务端接口与 App 的门禁负责。
  const [isAdmin] = useState(() => {
    try {
      return readSession()?.user.kind === 'admin'
    } catch {
      return false
    }
  })
  const [tab, setTab] = useState<'credits' | 'runs'>('credits')
  const creditsView = tab === 'credits' || !isAdmin
  const goRecharge = onRecharge || (() => { window.location.hash = '#/recharge' })
  const goCreate = onQuickCreate || (() => { window.location.hash = '#/agents' })

  return (
    <div className="runs-page">
      <PageHead
        kicker={creditsView ? 'Credits · 积分账本' : 'Runs · 工作流执行记录'}
        title={creditsView ? '积分记录' : '工作流运行'}
        desc={creditsView
          ? '每一次扣费与充值都在这里：扣了多少、扣在哪个动作上、结余多少。'
          : '每次工作流执行都以真实模型调用为单位记录：哪个节点、多久、返回了什么、在哪一步失败；每条都写着属于哪条作品的第几版。'}
      />

      {isAdmin ? (
        <div className="runs-tabs" role="tablist" aria-label="记录类型">
          <button
            type="button"
            id="runs-tab-credits"
            role="tab"
            aria-selected={creditsView}
            aria-controls="runs-panel-credits"
            className={'runs-tab' + (creditsView ? ' is-active' : '')}
            onClick={() => setTab('credits')}
          >
            积分明细
          </button>
          <button
            type="button"
            id="runs-tab-workflows"
            role="tab"
            aria-selected={!creditsView}
            aria-controls="runs-panel-workflows"
            className={'runs-tab' + (!creditsView ? ' is-active' : '')}
            onClick={() => setTab('runs')}
          >
            工作流运行
          </button>
        </div>
      ) : null}

      <div
        role={isAdmin ? 'tabpanel' : undefined}
        id={creditsView ? 'runs-panel-credits' : 'runs-panel-workflows'}
        aria-labelledby={isAdmin ? (creditsView ? 'runs-tab-credits' : 'runs-tab-workflows') : undefined}
      >
        {creditsView ? (
          <CreditLedger
            isAdmin={isAdmin}
            onViewRun={onViewRun}
            onRecharge={goRecharge}
            onQuickCreate={goCreate}
          />
        ) : (
          <WorkflowRunsPanel
            onOpenFlow={onOpenFlow}
            onResumeRun={onResumeRun}
            onViewRun={onViewRun}
            onOpenProject={onOpenProject}
          />
        )}
      </div>
    </div>
  )
}

function CreditLedger({
  isAdmin,
  onViewRun,
  onRecharge,
  onQuickCreate,
}: {
  isAdmin: boolean
  onViewRun?: (flowId: string, runId: string) => void
  onRecharge: () => void
  onQuickCreate: () => void
}) {
  const [summary, setSummary] = useState<CreditsResponse | null>(null)
  const [entries, setEntries] = useState<CreditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [filter, setFilter] = useState<LedgerFilter>('all')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const loadFirst = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await getCredits(LEDGER_PAGE, 0)
      const rows = Array.isArray(result.ledger) ? result.ledger : []
      setSummary(result)
      setEntries(rows)
      setTotal(Number(result.ledgerTotal ?? rows.length))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '积分记录读取失败，稍后再试一次')
    } finally {
      setLoading(false)
    }
  }, [])

  // 与运行记录页同一种写法：effect 里同步 setState 会多一轮渲染，推到下一个宏任务再读。
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadFirst() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadFirst])

  // 加载更多按 offset 追加，并按 id 去重：账本在两次请求之间多了新行时，
  // 下一页可能带回已经显示过的那一条，不能让同一笔钱出现两次。
  const loadMore = async () => {
    if (loadingMore || entries.length >= total) return
    setLoadingMore(true)
    setError('')
    try {
      const result = await listCredits(entries.length, LEDGER_PAGE)
      const rows = Array.isArray(result.ledger) ? result.ledger : []
      setEntries((prev) => {
        const seen = new Set(prev.map((entry) => entry.id))
        return [...prev, ...rows.filter((entry) => !seen.has(entry.id))]
      })
      setTotal(Number(result.ledgerTotal ?? Math.max(total, entries.length + rows.length)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '积分记录读取失败，稍后再试一次')
    } finally {
      setLoadingMore(false)
    }
  }

  const visible = filter === 'all' ? entries : entries.filter((entry) => ledgerBucket(entry) === filter)
  const hasMore = entries.length < total

  return (
    <>
      <section className="runs-credit-summary" aria-label="积分概览">
        <div className="runs-credit-block">
          <span className="runs-credit-label">当前余额</span>
          <span className="runs-credit-number">
            <strong>{fmtNumber(summary?.balance)}</strong>
            <em>{summary?.unit || '积分'}</em>
          </span>
        </div>
        <div className="runs-credit-block is-spend">
          <span className="runs-credit-label">本月消耗</span>
          <span className="runs-credit-number">
            <strong>{fmtNumber(summary?.spend?.total)}</strong>
            <em>{summary?.spend?.month ? summary.spend.month + ' 月' : '积分'}</em>
          </span>
        </div>
        <div className="runs-credit-actions">
          <button type="button" className="vq-button vq-button--primary vq-button--sm" onClick={onRecharge}>
            去充值
            <ArrowRight size={13} />
          </button>
        </div>
      </section>

      <div className="runs-ledger-filters" role="group" aria-label="按流水类型筛选">
        {LEDGER_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            className={'runs-ledger-filter' + (filter === item.id ? ' is-active' : '')}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className="vq-button vq-button--ghost vq-button--sm runs-ledger-refresh"
          onClick={() => void loadFirst()}
          disabled={loading}
        >
          <RefreshCw size={13} />
          刷新
        </button>
      </div>

      {loading ? <p className="runs-note">读取积分记录…</p> : null}
      {error ? <p className="runs-note is-error">{error}</p> : null}

      {!loading && !error && !entries.length ? (
        <div className="runs-empty">
          <Coins size={18} strokeWidth={1.5} />
          <strong>还没有积分记录</strong>
          <span>生成一次就会有记录：出图、出视频、检索或运行工作流，扣了多少都会写在这里。</span>
          <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={onQuickCreate}>
            去快捷创作
            <ArrowRight size={13} />
          </button>
        </div>
      ) : null}

      {!loading && entries.length && !visible.length ? (
        <div className="runs-empty">
          <strong>这个筛选下暂时没有记录</strong>
          <span>加载更多只会接着往后读；先看全部，或者换一个类型。</span>
          <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={() => setFilter('all')}>
            看全部流水
          </button>
        </div>
      ) : null}

      {visible.length ? (
        <>
          <div className="runs-ledger-head" aria-hidden="true">
            <span>时间</span>
            <span>动作与说明</span>
            <span>增减</span>
            <span>结余</span>
          </div>
          <ol className="runs-ledger">
            {visible.map((entry) => {
              const plus = entry.delta > 0
              const linkable = Boolean(isAdmin && entry.runId && entry.flowId && onViewRun)
              return (
                <li className="runs-ledger-item" key={entry.id}>
                  <time
                    className="runs-ledger-time"
                    dateTime={entry.createdAt}
                    title={fmtFullTime(entry.createdAt)}
                  >
                    {fmtTime(entry.createdAt)}
                  </time>
                  <div className="runs-ledger-main">
                    <span className="runs-ledger-action">{ledgerAction(entry, isAdmin)}</span>
                    {ledgerDescription(entry, isAdmin) !== ledgerAction(entry, isAdmin) ? (
                      <span className="runs-ledger-desc">{ledgerDescription(entry, isAdmin)}</span>
                    ) : null}
                    {isAdmin && (entry.nodeLabel || entry.flowName) ? (
                      <span className="runs-ledger-where">
                        {entry.nodeLabel ? <span>节点 · {entry.nodeLabel}</span> : null}
                        {entry.flowName ? <span>流程 · {entry.flowName}</span> : null}
                      </span>
                    ) : null}
                    {linkable ? (
                      <button
                        type="button"
                        className="runs-ledger-link"
                        onClick={() => onViewRun?.(entry.flowId || '', entry.runId || '')}
                      >
                        查看这次运行
                        <ArrowRight size={12} />
                      </button>
                    ) : null}
                  </div>
                  <span className={'runs-ledger-delta' + (plus ? ' is-plus' : '')}>
                    {plus ? '+' : ''}{entry.delta.toLocaleString('zh-CN')}
                  </span>
                  <span className="runs-ledger-balance">
                    <i>结余</i>
                    {fmtNumber(entry.balance)}
                  </span>
                </li>
              )
            })}
          </ol>
        </>
      ) : null}

      {entries.length ? (
        <div className="runs-ledger-more">
          <span>共 {fmtNumber(total)} 条，已显示 {entries.length} 条</span>
          {hasMore ? (
            <button
              type="button"
              className="vq-button vq-button--ghost vq-button--sm"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? <Loader2 size={13} className="vq-spin" /> : null}
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          ) : (
            <span className="runs-ledger-end">没有更多了</span>
          )}
        </div>
      ) : null}
    </>
  )
}