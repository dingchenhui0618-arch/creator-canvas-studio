import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import {
  listFeedback,
  updateFeedback,
  type FeedbackItem,
  type FeedbackQueue,
  type FeedbackStatus,
} from '../../api/feedback'
import { formatDateTime } from './data'
import { AdminHead, Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

// 用户反馈（B5）：登录用户与匿名用户（登录页）都能交，后台在这里读到、改状态、写回复。
// 回复随条目回到提交者的「设置 → 帮助与反馈」；匿名条目没有账号可回，按 contact 字段联系。

const STATUS_TABS: { value: 'new' | 'reading' | 'done' | 'all'; label: string }[] = [
  { value: 'new', label: '待处理' },
  { value: 'reading', label: '处理中' },
  { value: 'done', label: '已处理' },
  { value: 'all', label: '全部' },
]

const KIND_LABEL: Record<string, string> = { problem: '功能问题', idea: '改进建议', other: '其他' }

export default function FeedbackSection() {
  const [status, setStatus] = useState<'new' | 'reading' | 'done' | 'all'>('new')
  const [data, setData] = useState<FeedbackQueue | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [open, setOpen] = useState('')
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await listFeedback(status))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '反馈队列没有读到')
    } finally {
      setLoading(false)
    }
  }, [status])

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void load()
  }, [load])

  const apply = async (item: FeedbackItem, next: FeedbackStatus) => {
    setBusy(item.id)
    setMessage('')
    try {
      const result = await updateFeedback(item.id, { status: next, reply })
      setMessage(
        next === 'done'
          ? '已标记处理：' + item.id + (result.item.reply ? '，回复会回到提交者设置页' : '，没有写回复')
          : '已标记为' + (next === 'reading' ? '处理中' : '待处理') + '：' + item.id,
      )
      setOpen('')
      setReply('')
      // 处理完立即让侧栏角标归零：不必换页才刷新
      window.dispatchEvent(new Event('vq:feedback-changed'))
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
        kicker="ADMIN / FEEDBACK"
        title="用户反馈"
        description="用户在设置页或登录页提交的问题与建议。改成「已处理」时可以写一段回复，登录用户会在自己的设置页看到；匿名条目按你填的联系方式联系。"
        actions={<RefreshButton onClick={() => void load()} busy={loading} />}
      />

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {message ? <p className="admin-hint admin-hint--ok">{message}</p> : null}

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">受理队列</p>
            <p className="admin-sub">
              待处理 {counts?.new ?? 0} · 处理中 {counts?.reading ?? 0} · 已处理 {counts?.done ?? 0} · 累计 {counts?.total ?? 0}
            </p>
          </div>
          <div className="admin-alert-actions">
            <SourceTag kind="api" source="GET /api/admin/feedback" />
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

        {loading && !data ? <LoadingLine label="/api/admin/feedback" /> : null}

        {data && data.items.length ? (
          <ul className="admin-report-list">
            {data.items.map((item) => (
              <li key={item.id} className="admin-report-row">
                <div className="admin-report-head">
                  <Badge tone={item.kind === 'problem' ? 'warn' : 'neutral'}>{KIND_LABEL[item.kind] || item.kind}</Badge>
                  <strong>{item.body.slice(0, 42)}{item.body.length > 42 ? '…' : ''}</strong>
                  <span className="admin-cell-sub admin-mono">
                    {item.id} · {item.page || '未记录页面'} · {formatDateTime(item.createdAt)}
                  </span>
                  <Badge tone={item.status === 'done' ? 'ok' : item.status === 'reading' ? 'warn' : 'neutral'}>
                    {item.status === 'done' ? '已处理' : item.status === 'reading' ? '处理中' : '待处理'}
                  </Badge>
                </div>

                <p className="admin-report-detail">{item.body}</p>
                <p className="admin-cell-sub">
                  {item.userEmail ? '账号：' + item.userEmail : '匿名提交'}
                  {item.contact && item.contact !== item.userEmail ? ' · 联系方式：' + item.contact : ''}
                  {item.handledBy ? ' · 处理人：' + item.handledBy : ''}
                </p>
                {item.reply ? <p className="admin-cell-sub">回复：{item.reply}</p> : null}

                {item.status === 'done' ? (
                  <div className="admin-report-actions">
                    <button type="button" className="vq-button vq-button--ghost" onClick={() => void apply(item, 'new')} disabled={busy === item.id}>
                      重新打开
                    </button>
                  </div>
                ) : open === item.id ? (
                  <div className="admin-report-actions">
                    <input
                      className="admin-input"
                      placeholder="给提交者的回复（可选，会显示在他的设置页）"
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                    />
                    <button type="button" className="vq-button vq-button--primary" onClick={() => void apply(item, 'done')} disabled={busy === item.id}>
                      {busy === item.id ? <Loader2 size={13} className="vq-spin" /> : <CheckCircle2 size={13} />}
                      标记已处理
                    </button>
                    <button type="button" className="vq-button vq-button--ghost" onClick={() => void apply(item, 'reading')} disabled={busy === item.id}>
                      处理中
                    </button>
                    <button type="button" className="vq-button vq-button--ghost" onClick={() => { setOpen(''); setReply('') }} disabled={busy === item.id}>
                      取消
                    </button>
                  </div>
                ) : (
                  <div className="admin-report-actions">
                    <button type="button" className="vq-button vq-button--ghost" onClick={() => { setOpen(item.id); setReply(item.reply || '') }}>
                      处理
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {data && !data.items.length && !loading ? (
          <EmptyState title={status === 'all' ? '还没有收到反馈' : '这一档没有反馈'} description="用户提交后会出现在这里；登录页的匿名反馈也会进同一条队列。" />
        ) : null}
      </section>
    </>
  )
}
