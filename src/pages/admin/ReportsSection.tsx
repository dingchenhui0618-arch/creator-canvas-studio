import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, ShieldOff } from 'lucide-react'
import { listReports, resolveReport, type ReportItem, type ReportQueue } from '../../api/reports'
import { formatDateTime } from './data'
import { AdminHead, Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

// 举报处理（D5）：分享页与公共模板上收到的侵权/不当内容举报在这里排进队列。
// 两个动作：驳回（保留内容）与下架（从公共模板收回 + 停掉分享链接，不物理删除，证据留着）。

const STATUS_TABS: { value: 'open' | 'dismissed' | 'takedown' | 'all'; label: string }[] = [
  { value: 'open', label: '待处理' },
  { value: 'dismissed', label: '已驳回' },
  { value: 'takedown', label: '已下架' },
  { value: 'all', label: '全部' },
]

export default function ReportsSection() {
  const [status, setStatus] = useState<'open' | 'dismissed' | 'takedown' | 'all'>('open')
  const [data, setData] = useState<ReportQueue | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [note, setNote] = useState('')
  const [open, setOpen] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await listReports(status))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '举报队列没有读到')
    } finally {
      setLoading(false)
    }
  }, [status])

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void load()
  }, [load])

  const resolve = async (item: ReportItem, action: 'dismiss' | 'takedown') => {
    setBusy(item.id)
    setMessage('')
    try {
      const result = await resolveReport(item.id, action, note)
      setMessage(
        action === 'takedown'
          ? '已下架：' + (result.takedown ? result.takedown.title + ' 已从公共模板收回并停掉分享链接' : '模板可能已被删除，只更新了举报状态')
          : '已驳回这条举报，内容保留',
      )
      setNote('')
      setOpen('')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '处理没有完成')
    } finally {
      setBusy('')
    }
  }

  const counts = data?.counts

  return (
    <>
      <AdminHead
        kicker="ADMIN / REPORTS"
        title="举报处理"
        description="分享页与公共模板收到的侵权、肖像与不当内容举报。下架会把模板从公共库收回并停掉分享链接，但不物理删除，处理记录留在审计里。"
        actions={<RefreshButton onClick={() => void load()} busy={loading} />}
      />

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {message ? <p className="admin-hint admin-hint--ok">{message}</p> : null}

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">受理队列</p>
            <p className="admin-sub">
              待处理 {counts?.open ?? 0} · 已驳回 {counts?.dismissed ?? 0} · 已下架 {counts?.takedown ?? 0} · 累计 {counts?.total ?? 0}
            </p>
          </div>
          <div className="admin-alert-actions">
            <SourceTag kind="api" source="GET /api/admin/reports" />
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                className={'vq-button ' + (status === tab.value ? 'vq-button--primary' : 'vq-button--ghost')}
                onClick={() => setStatus(tab.value)}
                disabled={loading}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {loading && !data ? <LoadingLine label="/api/admin/reports" /> : null}

        {data && data.items.length ? (
          <ul className="admin-report-list">
            {data.items.map((item) => (
              <li key={item.id} className="admin-report-row">
                <div className="admin-report-head">
                  <Badge tone={item.category === 'copyright' ? 'fail' : item.category === 'abuse' ? 'warn' : 'neutral'}>
                    {data.categories[item.category] || item.category}
                  </Badge>
                  <strong>{item.target.title || item.target.id}</strong>
                  <span className="admin-cell-sub admin-mono">
                    {item.target.kind === 'share' ? '分享链接' : '模板'} {item.target.id} · 第 {item.count} 次 · {formatDateTime(item.lastAt)}
                  </span>
                  <Badge tone={item.status === 'open' ? 'warn' : item.status === 'takedown' ? 'fail' : 'ok'}>
                    {item.status === 'open' ? '待处理' : item.status === 'takedown' ? '已下架' : '已驳回'}
                  </Badge>
                </div>

                <p className="admin-report-detail">{item.detail}</p>
                {item.contact ? <p className="admin-cell-sub">联系方式：{item.contact}</p> : null}
                {item.target.url ? (
                  <p className="admin-cell-sub admin-mono admin-report-url">
                    来源：<a href={item.target.url} target="_blank" rel="noreferrer">{item.target.url}</a>
                  </p>
                ) : null}
                {item.status !== 'open' ? (
                  <p className="admin-cell-sub">
                    {item.status === 'takedown' ? '已下架' : '已驳回'} · {formatDateTime(item.resolvedAt)} · {item.resolvedBy}
                    {item.note ? ' · ' + item.note : ''}
                  </p>
                ) : open === item.id ? (
                  <div className="admin-report-actions">
                    <input
                      className="admin-input"
                      placeholder="处理说明（会记进审计，可选）"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <button type="button" className="vq-button vq-button--danger" onClick={() => void resolve(item, 'takedown')} disabled={busy === item.id}>
                      {busy === item.id ? <Loader2 size={13} className="vq-spin" /> : <ShieldOff size={13} />}
                      确认下架
                    </button>
                    <button type="button" className="vq-button vq-button--ghost" onClick={() => void resolve(item, 'dismiss')} disabled={busy === item.id}>
                      <CheckCircle2 size={13} />
                      驳回
                    </button>
                    <button type="button" className="vq-button vq-button--ghost" onClick={() => { setOpen(''); setNote('') }} disabled={busy === item.id}>
                      取消
                    </button>
                  </div>
                ) : (
                  <div className="admin-report-actions">
                    <button type="button" className="vq-button vq-button--ghost" onClick={() => setOpen(item.id)}>
                      <AlertTriangle size={13} />
                      处理这条
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {data && !data.items.length && !loading ? (
          <EmptyState
            title={status === 'open' ? '没有待处理的举报' : '这个筛选下没有记录'}
            description={status === 'open' ? '分享页与公共模板上的「举报侵权」会排到这里；处理完的记录在「已驳回 / 已下架」里能查。' : '换一个筛选看看。'}
          />
        ) : null}
      </section>
    </>
  )
}
