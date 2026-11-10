import { Fragment, useState } from 'react'
import type { AdminUser } from '../../api/credits'
import { formatDateTime, formatDuration, useApi, type RunItem, type RunsResponse } from './data'
import { AdminHead, Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

type FlowsResponse = { items: { id: string; name: string }[]; total: number }
type UsersResponse = { items: AdminUser[]; total: number }

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

// 导出当前筛选结果：只导已加载的记录，字段与表格一致，带 BOM 让 Excel 正确识别中文
function exportCsv(runs: RunItem[], accountOf: (run: RunItem) => string) {
  const rows: (string | number | null | undefined)[][] = [
    ['运行 ID', '流程 ID', '流程', '账号', '状态', '耗时 ms', '节点数', '开始时间', '结束时间', '错误'],
    ...runs.map((run) => [
      run.id,
      run.flowId,
      run.flowName,
      accountOf(run),
      run.status,
      run.durationMs,
      run.total,
      run.startedAt,
      run.finishedAt || '',
      run.error || '',
    ]),
  ]
  const csv = rows.map((row) => row.map((cell) => '"' + String(cell ?? '').replace(/"/g, '""') + '"').join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'visionqa-runs-' + new Date().toISOString().slice(0, 10) + '.csv'
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function AuditSection() {
  const [status, setStatus] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [flowId, setFlowId] = useState('')
  const users = useApi<UsersResponse>('/api/admin/users')
  const flows = useApi<FlowsResponse>('/api/flows')

  const query = ['limit=50']
  if (status) query.push('status=' + encodeURIComponent(status))
  if (ownerId) query.push('ownerId=' + encodeURIComponent(ownerId))
  if (flowId) query.push('flowId=' + encodeURIComponent(flowId))
  const { data, error, loading, reload } = useApi<RunsResponse>('/api/runs?' + query.join('&'))
  const [openId, setOpenId] = useState<string | null>(null)

  const runs = [...(data?.items ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const accountOf = (run: RunItem) => {
    if (!run.ownerId) return '未归属'
    const hit = users.data?.items.find((user) => user.id === run.ownerId)
    return hit ? hit.name || hit.email : '账号已删除'
  }
  const accountTitle = (run: RunItem) => {
    if (!run.ownerId) return '这条运行没有账号归属（积分制之前或本地演示产生）'
    const hit = users.data?.items.find((user) => user.id === run.ownerId)
    return hit ? hit.email : run.ownerId
  }
  const filtering = Boolean(status || ownerId || flowId)

  return (
    <>
      <AdminHead
        kicker="ADMIN / AUDIT"
        title="运行审计"
        description="真实运行记录，按开始时间倒序；可按账号、流程与状态筛选，点开一行查看逐节点状态与输出。"
        actions={<RefreshButton onClick={reload} busy={loading} />}
      />

      {error ? <ErrorBanner message={`GET /api/runs：${error}`} onRetry={reload} /> : null}
      {loading && !data ? <LoadingLine label="/api/runs" /> : null}

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">运行记录</p>
            <p className="admin-sub">
              {data ? `共 ${data.total} 条${filtering ? '（已筛选）' : ''}；节点输出来自列表返回的 nodes 字段。` : '等待接口返回。'}
            </p>
          </div>
          <SourceTag kind="api" source="GET /api/runs" />
        </div>

        <div className="admin-run-toolbar">
          <label className="admin-run-filter">
            <span>账号</span>
            <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
              <option value="">全部账号</option>
              {(users.data?.items ?? []).map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name || user.email}
                </option>
              ))}
              <option value="__none__">未归属</option>
            </select>
          </label>
          <label className="admin-run-filter">
            <span>流程</span>
            <select value={flowId} onChange={(event) => setFlowId(event.target.value)}>
              <option value="">全部流程</option>
              {(flows.data?.items ?? []).map((flow) => (
                <option key={flow.id} value={flow.id}>
                  {flow.name}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-run-filter">
            <span>状态</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部</option>
              <option value="success">成功</option>
              <option value="error">失败</option>
            </select>
          </label>
          {filtering ? (
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={() => {
                setStatus('')
                setOwnerId('')
                setFlowId('')
              }}
            >
              清除筛选
            </button>
          ) : null}
          <button type="button" className="admin-btn admin-btn--ghost" onClick={() => exportCsv(runs, accountOf)} disabled={!runs.length}>
            导出 CSV（当前筛选）
          </button>
        </div>

        {runs.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table admin-table--runs">
              <thead>
                <tr>
                  <th>运行 ID</th>
                  <th>流程</th>
                  <th>账号</th>
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
                        <td title={accountTitle(run)}>{accountOf(run)}</td>
                        <td>
                          <Badge tone={tone.tone}>{tone.label}</Badge>
                        </td>
                        <td className="admin-mono">{formatDuration(run.durationMs)}</td>
                        <td className="admin-mono">{run.total}</td>
                        <td className="admin-mono">{formatDateTime(run.startedAt)}</td>
                      </tr>
                      {open ? (
                        <tr className="admin-run-detail">
                          <td colSpan={7}>
                            <RunDetail run={run} account={accountOf(run)} />
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
          <EmptyState
            title={filtering ? '当前筛选下没有运行记录' : '还没有运行记录'}
            description={filtering ? '换一个账号、流程或状态再试。' : '在画布跑一条流程后，这里会出现真实审计。'}
          />
        ) : null}
      </section>
    </>
  )
}

function RunDetail({ run, account }: { run: RunItem; account: string }) {
  const nodes = run.nodes ?? []
  return (
    <div className="admin-run-expand">
      <div className="admin-run-meta">
        <span className="admin-mono">{run.id}</span>
        <span>flow {run.flowId}</span>
        <span>账号 {account}</span>
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
