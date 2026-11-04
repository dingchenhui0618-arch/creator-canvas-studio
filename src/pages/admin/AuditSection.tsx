import { Fragment, useState } from 'react'
import { formatDateTime, formatDuration, useApi, type RunItem, type RunsResponse } from './data'
import { AdminHead, Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

function statusOf(status: string): { tone: 'neutral' | 'ok' | 'warn' | 'fail'; label: string } {
  if (status === 'success') return { tone: 'ok', label: '成功' }
  if (status === 'failed' || status === 'error') return { tone: 'fail', label: '失败' }
  if (status === 'running') return { tone: 'warn', label: '运行中' }
  if (status === 'skipped') return { tone: 'neutral', label: '跳过' }
  if (status === 'pending' || status === 'idle') return { tone: 'neutral', label: '等待' }
  return { tone: 'neutral', label: status || '未知' }
}

function outputOf(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export default function AuditSection() {
  const { data, error, loading, reload } = useApi<RunsResponse>('/api/runs')
  const [openId, setOpenId] = useState<string | null>(null)

  const runs = [...(data?.items ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  return (
    <>
      <AdminHead
        kicker="ADMIN / AUDIT"
        title="运行审计"
        description="GET /api/runs 的实际运行记录，按开始时间倒序；点开一行查看逐节点状态与输出。"
        actions={<RefreshButton onClick={reload} busy={loading} />}
      />

      {error ? <ErrorBanner message={`GET /api/runs：${error}`} onRetry={reload} /> : null}
      {loading && !data ? <LoadingLine label="/api/runs" /> : null}

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">运行记录</p>
            <p className="admin-sub">{data ? `共 ${data.total} 条；节点输出来自列表返回的 nodes 字段。` : '等待接口返回。'}</p>
          </div>
          <SourceTag kind="api" source="GET /api/runs" />
        </div>

        {runs.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table admin-table--runs">
              <thead>
                <tr>
                  <th>运行 ID</th>
                  <th>流程</th>
                  <th>状态</th>
                  <th>耗时</th>
                  <th>节点</th>
                  <th>开始时间</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const tone = statusOf(run.status)
                  const open = openId === run.id
                  return (
                    <Fragment key={run.id}>
                      <tr
                        className="admin-run-row"
                        tabIndex={0}
                        aria-expanded={open}
                        onClick={() => setOpenId(open ? null : run.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            setOpenId(open ? null : run.id)
                          }
                        }}
                      >
                        <td className="admin-mono">{run.id}</td>
                        <td>{run.flowName}</td>
                        <td>
                          <Badge tone={tone.tone}>{tone.label}</Badge>
                        </td>
                        <td className="admin-mono">{formatDuration(run.durationMs)}</td>
                        <td className="admin-mono">{run.total}</td>
                        <td className="admin-mono">{formatDateTime(run.startedAt)}</td>
                      </tr>
                      {open ? (
                        <tr className="admin-run-detail">
                          <td colSpan={6}>
                            <RunDetail run={run} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {!loading && !runs.length ? (
          <EmptyState title="还没有运行记录" description="在画布跑一条流程后，这里会出现真实审计。" />
        ) : null}
      </section>
    </>
  )
}

function RunDetail({ run }: { run: RunItem }) {
  const nodes = run.nodes ?? []
  return (
    <div className="admin-run-expand">
      <div className="admin-run-meta">
        <span className="admin-mono">{run.id}</span>
        <span>flow {run.flowId}</span>
        <span>结束 {formatDateTime(run.finishedAt)}</span>
      </div>
      {nodes.length ? (
        <div className="admin-nodes">
          {nodes.map((node) => (
            <article key={node.id} className="admin-node">
              <header>
                <strong>{node.title}</strong>
                <span className="admin-mono">{node.kind}</span>
                <span className="admin-mono">{node.id}</span>
                <Badge tone={statusOf(node.status).tone}>{statusOf(node.status).label}</Badge>
                <span className="admin-mono">{formatDuration(node.ms)}</span>
              </header>
              {node.error ? <p className="admin-node-error">{node.error}</p> : null}
              <details>
                <summary>逐节点输出</summary>
                <pre>{outputOf(node.output)}</pre>
              </details>
            </article>
          ))}
        </div>
      ) : (
        <p className="admin-hint">该运行记录没有 nodes 字段，无法展开逐节点输出。</p>
      )}
    </div>
  )
}
