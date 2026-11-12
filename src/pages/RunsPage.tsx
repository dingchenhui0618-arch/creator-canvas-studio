import { useCallback, useEffect, useState } from 'react'
import { Activity, ChevronLeft, ChevronRight, RefreshCw, Search, Workflow } from 'lucide-react'
import PageHead from '../components/PageHead'
import { Select } from '../components/Select'
import { listFlows, listRuns, type ApiFlow, type RunRecord } from '../api/flows'
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

export function RunsPage({ onOpenFlow }: { onOpenFlow?: (flowId: string) => void }) {
  const [items, setItems] = useState<RunRecord[]>([])
  const [total, setTotal] = useState(0)
  const [flows, setFlows] = useState<ApiFlow[]>([])
  const [flowId, setFlowId] = useState('')
  const [status, setStatus] = useState<'' | 'success' | 'error'>('')
  const [keyword, setKeyword] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(keyword.trim()), 350)
    return () => window.clearTimeout(timer)
  }, [keyword])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await listRuns({ flowId, status, q: query, limit: PAGE_SIZE, offset })
      setItems(result.items || [])
      setTotal(result.total || 0)
      setOpen(result.items?.[0]?.id || null)
    } catch (reason) {
      setError(String((reason as Error)?.message || reason))
    } finally {
      setLoading(false)
    }
  }, [flowId, offset, query, status])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    let alive = true
    void listFlows()
      .then((list) => { if (alive) setFlows(list) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  const pageStart = total === 0 ? 0 : Math.min(offset + 1, total)
  const pageEnd = Math.min(offset + items.length, total)
  const pageSuccess = items.filter((item) => item.status === 'success').length
  const pageFailed = items.filter((item) => item.status !== 'success').length
  const current = items.find((item) => item.id === open) || null
  const filtered = Boolean(flowId || status || query)
  const hasPrev = offset > 0
  const hasNext = offset + items.length < total

  const resetTo = (next: () => void) => {
    next()
    setOffset(0)
  }

  return (
    <div className="runs-page">
      <PageHead
        kicker="Runs · 画布执行记录"
        title="运行记录"
        desc="每次画布执行都以真实模型调用为单位记录：哪个节点、多久、返回了什么、在哪一步失败。"
        actions={
          <button type="button" className="button button--ghost button--tiny" onClick={() => void load()}>
            <RefreshCw size={13} />刷新
          </button>
        }
      />

      <div className="runs-stats">
        <div><strong>{total}</strong><span>{filtered ? '筛选结果' : '总运行'}</span></div>
        <div><strong>{pageSuccess}</strong><span>本页成功</span></div>
        <div><strong>{pageFailed}</strong><span>本页失败</span></div>
        <div><strong>{total ? pageStart + '–' + pageEnd : '0'}</strong><span>当前区间</span></div>
      </div>

      <div className="runs-filters">
        <label className="runs-search">
          <Search size={14} />
          <input
            value={keyword}
            onChange={(event) => resetTo(() => setKeyword(event.target.value))}
            placeholder="按流程名、运行 ID 或错误信息搜索"
            spellCheck={false}
          />
        </label>
        <label className="runs-select">
          <span>流程</span>
          <Select
            size="sm"
            label="按流程筛选"
            value={flowId}
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
            ]}
            onChange={(value) => resetTo(() => setStatus(value as '' | 'success' | 'error'))}
          />
        </label>
        {filtered ? (
          <button
            type="button"
            className="button button--ghost button--tiny"
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
                <button type="button" className={`runs-row ${open === item.id ? 'is-active' : ''}`} onClick={() => setOpen(item.id)}>
                  <span className={`runs-dot ${item.status === 'success' ? 'is-pass' : 'is-fail'}`} />
                  <span className="runs-row-main">
                    <strong>{item.flowName}</strong>
                    <small className="vq-mono">{item.id} · {item.total} 个节点</small>
                  </span>
                  <span className="runs-row-meta">
                    <span className="vq-mono">{item.status === 'success' ? '成功' : '失败'}</span>
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
                {onOpenFlow ? (
                  <button
                    type="button"
                    className="button button--ghost button--tiny runs-open-flow"
                    onClick={() => onOpenFlow(current.flowId)}
                  >
                    在画布打开
                  </button>
                ) : null}
              </div>
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
          <button type="button" className="button button--ghost button--tiny" disabled={!hasPrev} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            <ChevronLeft size={13} />上一页
          </button>
          <button type="button" className="button button--ghost button--tiny" disabled={!hasNext} onClick={() => setOffset(offset + PAGE_SIZE)}>
            下一页<ChevronRight size={13} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
