import { useCallback, useEffect, useState } from 'react'
import { Activity, RefreshCw, Workflow } from 'lucide-react'
import { request } from '../api/client'
import '../styles/runs.css'

type RunNode = {
  id: string
  kind: string
  title: string
  status: 'success' | 'error' | 'skipped' | 'pending' | 'running'
  ms: number
  output?: unknown
  error?: string | null
  message?: string | null
}

type FlowRun = {
  id: string
  flowId: string
  flowName: string
  status: string
  startedAt: string
  finishedAt?: string | null
  durationMs: number
  total: number
  nodes: RunNode[]
  output?: unknown
  error?: string | null
}

const fmtTime = (iso: string) => {
  const date = new Date(iso)
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function RunsPage() {
  const [items, setItems] = useState<FlowRun[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await request<{ items: FlowRun[] }>('/api/runs')
      setItems(result.items || [])
      setOpen(result.items?.[0]?.id || null)
    } catch (reason) {
      setError(String((reason as Error)?.message || reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const success = items.filter((item) => item.status === 'success').length
  const failed = items.filter((item) => item.status !== 'success').length
  const current = items.find((item) => item.id === open) || null

  return (
    <div className="runs-page">
      <header className="runs-head">
        <div>
          <span className="vq-mono">Runs · 画布执行记录</span>
          <h1>运行记录</h1>
          <p>每次画布执行都以真实模型调用为单位记录：哪个节点、多久、返回了什么、在哪一步失败。</p>
        </div>
        <button type="button" className="button button--ghost button--tiny" onClick={() => void load()}>
          <RefreshCw size={13} />刷新
        </button>
      </header>

      <div className="runs-stats">
        <div><strong>{items.length}</strong><span>总运行</span></div>
        <div><strong>{success}</strong><span>成功</span></div>
        <div><strong>{failed}</strong><span>失败</span></div>
      </div>

      {error ? <p className="runs-note is-error">{error}</p> : null}
      {loading ? <p className="runs-note">读取运行记录…</p> : null}

      {!loading && !items.length ? (
        <div className="runs-empty">
          <Workflow size={18} strokeWidth={1.5} />
          <strong>还没有运行记录</strong>
          <span>去「画布」点一次运行，这里会出现逐节点结果。</span>
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
              </div>
              <ol className="runs-nodes">
                {current.nodes.map((node) => (
                  <li key={node.id} className={`runs-node is-${node.status}`}>
                    <div className="runs-node-head">
                      <span className="vq-mono">{node.kind}</span>
                      <strong>{node.title}</strong>
                      <span className="vq-mono">{node.ms}ms</span>
                    </div>
                    {node.error ? <p className="runs-node-error">{node.error}</p> : null}
                    {node.message ? <p className="runs-node-error">{node.message}</p> : null}
                    {node.output != null ? (
                      <pre className="runs-node-output">{String(typeof node.output === 'string' ? node.output : JSON.stringify(node.output, null, 1)).slice(0, 900)}</pre>
                    ) : null}
                  </li>
                ))}
              </ol>
              {current.error ? <p className="runs-node-error">{current.error}</p> : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
