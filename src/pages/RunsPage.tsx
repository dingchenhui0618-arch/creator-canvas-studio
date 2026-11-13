import { useCallback, useEffect, useState } from 'react'
import { Activity, ArrowRight, ChevronLeft, ChevronRight, Link2, RefreshCw, Search, Workflow } from 'lucide-react'
import PageHead from '../components/PageHead'
import { Select } from '../components/Select'
import { adoptProjectCanvas, createProject, listProjects } from '../api/projects'
import type { ProjectSummary } from '../domain/project'
import { listFlows, listRuns, type ApiFlow, type RunRecord } from '../api/flows'
import { runVersionLabel, runWorkLine } from '../domain/run'
import { readRunsView, resolveFlowFilter, writeRunsView, type RunsView } from '../domain/list-view'
import '../styles/runs.css'

const PAGE_SIZE = 12

const fmtTime = (iso: string) => {
  const date = new Date(iso)
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
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
  agent: '智能体',
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
export function RunsPage({
  onOpenFlow,
  onOpenProject,
}: {
  onOpenFlow?: (flowId: string) => void
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
  // 流程清单读成功过没有：只在「读到了、但里面没有这块画布」时才清掉记下来的流程
  const [flowsLoaded, setFlowsLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 归到作品（v0.9.29）：没挂在作品上的运行以前只有一句「作品页不会出现它」，
  // 现在就地能把它收进一条作品——挂到已有作品，或者照这块画布新建一条。
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

  // 记住的那块画布可能已经删了、或不是这个账号的：判据在 domain/list-view 的 resolveFlowFilter，
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
    // 归的是整块画布，不是选中那一条运行：同一块画布上的其他运行也一起归过去了，
    // 只改当前这一行会让旁边几行继续写着「没挂在作品上」——那是假话。
    setItems((list) => list.map((item) => (item.flowId === current.flowId ? { ...item, project: ref } : item)))
  }

  const adoptedLine = (project: { title: string; version: number }, runs: number, how: 'bind' | 'new') => {
    const version = '第 ' + Math.max(1, Math.round(Number(project.version) || 1)) + ' 版'
    const runsText = runs > 0 ? '这块画布跑过的 ' + runs + ' 次运行一起归过去了' : '这块画布还没有运行记录'
    const tail = runsText + '（运行不复制记录，只认这块画布）'
    return how === 'bind'
      ? '已归到《' + project.title + '》' + version + '：' + tail
      : '照这块画布新建了《' + project.title + '》' + version + '：没有模板，脚本在作品页现写；' + tail
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
    <div className="runs-page">
      <PageHead
        kicker="Runs · 画布执行记录"
        title="运行记录"
        desc="每次画布执行都以真实模型调用为单位记录：哪个节点、多久、返回了什么、在哪一步失败；每条都写着属于哪条作品的第几版。"
        actions={
          <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={() => void load()}>
            <RefreshCw size={13} />刷新
          </button>
        }
      />

      <div className="runs-stats">
        <div><strong>{total}</strong><span>{filtered ? '筛选结果' : '总运行'}</span></div>
        <div><strong>{pageSuccess}</strong><span>本页成功</span></div>
        <div><strong>{pageFailed + pageInterrupted}</strong><span>{pageInterrupted ? '本页未完成' : '本页失败'}</span></div>
        <div><strong>{total ? pageStart + '–' + pageEnd : '0'}</strong><span>当前区间</span></div>
      </div>

      <div className="runs-filters">
        <label className="runs-search">
          <Search size={14} />
          <input
            value={keyword}
            onChange={(event) => resetTo(() => setKeyword(event.target.value))}
            placeholder="按作品名、画布名、运行 ID 或错误信息搜索"
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
      </div>

      {error ? <p className="runs-note is-error">{error}</p> : null}
      {loading ? <p className="runs-note">读取运行记录…</p> : null}

      {!loading && !items.length ? (
        <div className="runs-empty">
          <Workflow size={18} strokeWidth={1.5} />
          <strong>{filtered ? '没有符合条件的运行记录' : '还没有运行记录'}</strong>
          <span>{filtered ? '换个流程、状态或关键词再试。' : '去「画布」点一次运行，这里会出现逐节点结果。'}</span>
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
                  }}
                >
                  <span className={`runs-dot ${item.status === 'success' ? 'is-pass' : item.status === 'interrupted' ? 'is-warn' : 'is-fail'}`} />
                  <span className="runs-row-main">
                    <strong>{item.flowName}</strong>
                    <small className={'runs-row-where' + (item.project ? '' : ' is-orphan')}>{runWorkLine(item)}</small>
                    <small className="vq-mono">{item.id} · {item.total} 个节点</small>
                  </span>
                  <span className="runs-row-meta">
                    <span className="vq-mono">{item.status === 'success' ? '成功' : item.status === 'interrupted' ? '已中断' : '失败'}</span>
                    <span className="vq-mono">{(item.durationMs / 1000).toFixed(1)}s</span>
                    <span className="vq-mono">{fmtTime(item.startedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>

          {current ? (
            <section className="runs-detail">
              <div className="runs-detail-head">
                <Activity size={14} strokeWidth={1.5} />
                <strong>{current.flowName}</strong>
                <span className="vq-mono">{(current.durationMs / 1000).toFixed(1)}s</span>
                {current.credits && current.credits.cost > 0 ? (
                  <span className="vq-mono">{current.credits.refunded ? '已退回 ' + current.credits.cost + ' 积分' : '消耗 ' + current.credits.cost + ' 积分'}</span>
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
                      title="把这次运行归到一条作品：挂到已有作品，或者照这块画布新建一条"
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
                  {onOpenFlow ? (
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-button--sm"
                      onClick={() => onOpenFlow(current.flowId)}
                    >
                      在画布打开
                    </button>
                  ) : null}
                </span>
              </div>
              {current.project ? (
                <p className="runs-detail-where">
                  作品 · {current.project.title} · {runVersionLabel(current.project)}
                </p>
              ) : (
                <p className="runs-detail-where is-orphan">
                  这次运行没挂在作品上：空白画布直接跑的，作品页不会出现它。点「归到作品」把它收进一条作品，跑过的记录一起跟过去。
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
                          label: item.title + ' · ' + (item.version ? '第 ' + item.version + ' 版' : '还没开画布'),
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
                      照这块画布建一条《{current.flowName}》：没有模板，脚本在作品页现写
                    </span>
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-button--sm"
                      disabled={adoptBusy}
                      onClick={() => void adoptNew()}
                    >
                      照这块画布建一条
                    </button>
                  </div>
                  {adoptError ? <p className="runs-adopt-error">{adoptError}</p> : null}
                </div>
              ) : null}
              {adoptDone ? <p className="runs-adopt-done">{adoptDone}</p> : null}
              {current.status !== 'success' ? (
                <p className="runs-note">
                  {current.status === 'interrupted'
                    ? '这次运行被中断，积分按账本退回。'
                    : '这次运行失败了，积分原路退回。'}
                  <a className="vq-link" href="#/help/replicate-failed">
                    看常见原因
                  </a>
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
    </div>
  )
}
