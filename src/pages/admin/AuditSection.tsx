import { Fragment, useState } from 'react'
import type { AdminUser } from '../../api/credits'
import { useUiMode } from '../../api/app'
import { formatDateTime, formatDuration, useApi, type AuditItem, type AuditResponse, type RunItem, type RunsResponse } from './data'
import { AdminHead, Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

type FlowsResponse = { items: { id: string; name: string }[]; total: number }
type UsersResponse = { items: AdminUser[]; total: number }

function statusOf(status: string): { tone: 'neutral' | 'ok' | 'warn' | 'fail'; label: string } {
  if (status === 'success') return { tone: 'ok', label: '成功' }
  if (status === 'failed' || status === 'error') return { tone: 'fail', label: '失败' }
  if (status === 'interrupted') return { tone: 'warn', label: '已中断' }
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

// 管理动作的详情是 JSON：表格里要能一眼看懂，不要直接把 JSON 摊给管理员
function auditDetail(item: AuditItem): string {
  const detail = item.detail
  if (detail === null || detail === undefined || detail === '') return '—'
  if (typeof detail === 'string') return detail
  if (typeof detail !== 'object') return String(detail)
  const data = detail as Record<string, unknown>
  if (item.action === 'credits.grant') {
    const amount = Number(data.amount ?? 0)
    const note = data.note ? ' · ' + String(data.note) : ''
    return (amount > 0 ? '+' : '') + amount + ' 积分' + note
  }
  if (item.action === 'user.access') {
    const active = data.active === undefined ? '未改状态' : data.active ? '启用' : '停用'
    const kind = data.kind === undefined ? '未改角色' : data.kind === 'admin' ? '管理员' : '普通账号'
    return active + ' · ' + kind
  }
  if (item.action === 'user.password') {
    return (data.mode === 'temporary' ? '生成临时口令' : '设置新口令') + ' · 注销旧会话 ' + Number(data.signedOut ?? 0) + ' 个'
  }
  if (item.action === 'user.delete') {
    return '删除' + (data.kind === 'admin' ? '管理员' : '普通账号')
  }
  return Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => key + '=' + String(value))
    .join(' · ')
}

export default function AuditSection() {
  const [view, setView] = useState<'runs' | 'ops'>('runs')
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
      <AdminHead
        kicker={view === 'runs' ? 'ADMIN / AUDIT' : 'ADMIN / AUDIT · OPS'}
        title={view === 'runs' ? '运行审计' : '操作日志'}
        description={
          view === 'runs'
            ? '真实运行记录，按开始时间倒序；可按账号、流程与状态筛选，点开一行查看逐节点状态与输出。'
            : '管理员动作留痕：谁在什么时候改了账号、重置了口令或发放了积分。普通用户的检索与评审在积分流水与运行记录里。'
        }
        actions={<RefreshButton onClick={() => setRefreshKey((value) => value + 1)} />}
      />

      <div className="admin-tabs" role="tablist" aria-label="审计视图">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'runs'}
          className={'admin-tab' + (view === 'runs' ? ' is-active' : '')}
          onClick={() => setView('runs')}
        >
          运行记录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'ops'}
          className={'admin-tab' + (view === 'ops' ? ' is-active' : '')}
          onClick={() => setView('ops')}
        >
          操作日志
        </button>
      </div>

      {view === 'runs' ? <RunsPanel refreshKey={refreshKey} /> : <OpsPanel refreshKey={refreshKey} />}
    </>
  )
}

function RunsPanel({ refreshKey }: { refreshKey: number }) {
  const [status, setStatus] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [flowId, setFlowId] = useState('')
  const users = useApi<UsersResponse>('/api/admin/users')
  const flows = useApi<FlowsResponse>('/api/flows')

  const query = ['limit=50', '_r=' + refreshKey]
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
              <option value="interrupted">已中断</option>
            </select>
          </label>
          {filtering ? (
            <button
              type="button"
              className="vq-button vq-button--ghost"
              onClick={() => {
                setStatus('')
                setOwnerId('')
                setFlowId('')
              }}
            >
              清除筛选
            </button>
          ) : null}
          <button type="button" className="vq-button vq-button--ghost" onClick={() => exportCsv(runs, accountOf)} disabled={!runs.length}>
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

function OpsPanel({ refreshKey }: { refreshKey: number }) {
  const { internal } = useUiMode()
  const [action, setAction] = useState('')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const users = useApi<UsersResponse>('/api/admin/users')

  const query = ['limit=100', '_r=' + refreshKey]
  if (action) query.push('action=' + encodeURIComponent(action))
  if (q) query.push('q=' + encodeURIComponent(q))
  const { data, error, loading, reload } = useApi<AuditResponse>('/api/admin/audit?' + query.join('&'))
  const items = data?.items ?? []
  const filtering = Boolean(action || q)

  const accountName = (item: AuditItem) => {
    const hit = users.data?.items.find((user) => user.id === item.actorId || user.email === item.actorEmail)
    return hit ? hit.name || hit.email : item.actorEmail || '—'
  }

  return (
    <>
      {error ? <ErrorBanner message={`GET /api/admin/audit：${error}`} onRetry={reload} /> : null}
      {loading && !data ? <LoadingLine label="/api/admin/audit" /> : null}

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">操作日志</p>
            <p className="admin-sub">
              {data ? `共 ${data.total} 条${filtering ? '（已筛选）' : ''}；只记录管理动作，按时间倒序。` : '等待接口返回。'}
            </p>
          </div>
          <SourceTag kind="api" source="GET /api/admin/audit" />
        </div>

        <div className="admin-run-toolbar">
          <label className="admin-run-filter">
            <span>动作</span>
            <select value={action} onChange={(event) => setAction(event.target.value)}>
              <option value="">全部动作</option>
              {(data?.actions ?? []).map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <form
            className="admin-audit-search"
            onSubmit={(event) => {
              event.preventDefault()
              setQ(qInput.trim())
            }}
          >
            <input
              className="vq-input admin-audit-input"
              type="search"
              value={qInput}
              placeholder="按账号、对象或详情搜索"
              onChange={(event) => setQInput(event.target.value)}
            />
            <button type="submit" className="vq-button vq-button--ghost">
              筛选
            </button>
          </form>
          {filtering ? (
            <button
              type="button"
              className="vq-button vq-button--ghost"
              onClick={() => {
                setAction('')
                setQ('')
                setQInput('')
              }}
            >
              清除筛选
            </button>
          ) : null}
        </div>

        {items.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table admin-table--audit">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作人</th>
                  <th>动作</th>
                  <th>对象</th>
                  <th>详情</th>
                  <th className="admin-audit-source">来源</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="admin-mono">{formatDateTime(item.at)}</td>
                    <td>
                      <span>{accountName(item)}</span>
                      {internal && item.actorEmail ? <span className="admin-cell-sub">{item.actorEmail}</span> : null}
                    </td>
                    <td>
                      <Badge tone="neutral">{item.actionLabel}</Badge>
                    </td>
                    <td>
                      <span>{item.targetLabel || '—'}</span>
                      {internal && item.targetId ? (
                        <span className="admin-cell-sub admin-mono">
                          {item.targetType || '对象'} · {item.targetId}
                        </span>
                      ) : null}
                    </td>
                    <td className="admin-audit-detail">{auditDetail(item)}</td>
                    <td className="admin-audit-source admin-mono">
                      {internal ? [item.ip, item.traceId].filter(Boolean).join(' · ') || '—' : item.ip || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {!loading && !items.length ? (
          <EmptyState
            title={filtering ? '当前筛选下没有操作记录' : '还没有管理动作'}
            description={filtering ? '换一个动作或关键词再试。' : '发放积分、调整账号、重置口令之后，这里会出现真实留痕。'}
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
