import { useCallback, useEffect, useState } from 'react'
import { Check, Gauge, Trash2 } from 'lucide-react'
import {
  clearQuotaOverride,
  getAdminQuota,
  saveAdminQuota,
  setQuotaOverride,
  type AdminQuota,
  type QuotaRow,
} from '../../api/quota'
import { listAdminUsers, type AdminUser } from '../../api/credits'
import { formatDateTime } from './data'
import { Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton } from './ui'

// 每月额度：只回答「一个账号一个自然月最多能花多少积分」。
// 三个刻意的决定：
//   1. 默认 0（不限）：额度数字是商务决定，没定之前不偷偷设上限；
//   2. 限额是数据：改完立刻生效，下一次扣费就按新数字拦，不用发版；
//   3. 名额查看的是积分流水：本月已用 = 扣费 - 退款，管理员扣减与赠送不算消耗。
// 拦截发生在扣费之前：超额请求返回 429，不扣积分、也不调用上游。

const num = (raw: string): number | null => {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

function limitLabel(row: QuotaRow): string {
  if (row.override !== null) return '单独 ' + (row.override || '不限')
  return row.limit > 0 ? '默认 ' + row.limit : '默认不限'
}

export default function QuotaCard() {
  const [view, setView] = useState<AdminQuota | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [draft, setDraft] = useState('')
  const [rowDraft, setRowDraft] = useState<Record<string, string>>({})
  const [pickUser, setPickUser] = useState('')
  const [pickLimit, setPickLimit] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    getAdminQuota()
      .then((data) => {
        setView(data)
        setDraft(String(data.monthlyLimit))
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '额度读取失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    listAdminUsers()
      .then((data) => setUsers(data.items))
      .catch(() => setUsers([]))
  }, [])

  const run = async (action: () => Promise<AdminQuota>, done: string) => {
    if (busy) return
    setBusy(true)
    setNote('')
    try {
      const next = await action()
      setView(next)
      setDraft(String(next.monthlyLimit))
      setRowDraft({})
      setNote(done)
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const saveDefault = () => {
    const value = num(draft)
    if (value === null) {
      setNote('默认额度写 0（不限）或一个正整数，例如 2000')
      return
    }
    void run(
      () => saveAdminQuota(value),
      value ? '默认额度已设为每月 ' + value + ' 积分，下一次扣费就按它拦' : '已取消默认额度：所有账号回到「不限」',
    )
  }

  const saveRow = (row: QuotaRow) => {
    const raw = rowDraft[row.userId] === undefined ? String(row.override ?? row.limit) : rowDraft[row.userId]
    const value = num(raw)
    if (value === null) {
      setNote('单独额度写 0（不限）或一个正整数')
      return
    }
    void run(() => setQuotaOverride(row.userId, value), '已把 ' + row.email + ' 的每月上限设为 ' + (value || '不限'))
  }

  const clearRow = (row: QuotaRow) => {
    void run(() => clearQuotaOverride(row.userId), '已恢复 ' + row.email + ' 的默认额度')
  }

  const addOverride = () => {
    if (!pickUser) {
      setNote('先选一个账号')
      return
    }
    const value = num(pickLimit)
    if (value === null) {
      setNote('单独额度写 0（不限）或一个正整数')
      return
    }
    void run(() => setQuotaOverride(pickUser, value), '已为选中的账号设置每月上限 ' + (value || '不限'))
    setPickLimit('')
  }

  const rows = view?.rows ?? []
  // 账号不多（内测规模），直接算：为了一个 20 行列表挂 useMemo 只会被 lint 判成「每渲染都变」
  const known = new Set(rows.map((row) => row.userId))
  const candidates = users.filter((user) => !known.has(user.id))

  return (
    <>
      <section className="admin-card admin-block">
        <div className="admin-card-head">
          <div>
            <h2>每月额度</h2>
            <p>
              一个账号在一个自然月（UTC）里最多消耗多少积分。0 表示不限，也是现在的默认值。
              超出之后请求在扣费前就返回 429：不扣积分、不调用上游，明细里也不会多一条流水。
            </p>
          </div>
          <Badge tone={view && view.monthlyLimit > 0 ? 'ok' : 'neutral'}>
            {view ? (view.monthlyLimit > 0 ? '每月 ' + view.monthlyLimit + ' 积分' : '不限') : '读取中'}
          </Badge>
        </div>
        {error ? <ErrorBanner message={error} onRetry={load} /> : null}
        {loading && !view ? <LoadingLine label="每月额度" /> : null}
        <div className="admin-quota-form">
          <label className="vq-field">
            <span>默认每月上限（积分，0 = 不限）</span>
            <input
              className="vq-input"
              value={draft}
              inputMode="numeric"
              onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
              placeholder="0"
            />
          </label>
          <button type="button" className="vq-button vq-button--primary" onClick={saveDefault} disabled={busy || !view}>
            <Check size={14} />
            {busy ? '保存中…' : '保存默认额度'}
          </button>
          <span className="admin-cell-note">
            {view
              ? '本月 ' + view.month + ' · 每月 1 日（UTC）重置，下次 ' + String(view.resetAt).slice(0, 10) +
                (view.updatedAt ? ' · 最近修改 ' + formatDateTime(view.updatedAt) + (view.updatedBy ? ' · ' + view.updatedBy : '') : '')
              : ''}
          </span>
        </div>
        <div className="admin-quota-form">
          <label className="vq-field">
            <span>给某个账号单独设上限</span>
            <select className="vq-input" value={pickUser} onChange={(event) => setPickUser(event.target.value)}>
              <option value="">选择账号</option>
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.email}
                </option>
              ))}
            </select>
          </label>
          <label className="vq-field admin-quota-limit">
            <span>每月上限</span>
            <input
              className="vq-input"
              value={pickLimit}
              inputMode="numeric"
              onChange={(event) => setPickLimit(event.target.value.replace(/[^0-9]/g, ''))}
              placeholder="0 = 不限"
            />
          </label>
          <button type="button" className="vq-button vq-button--ghost" onClick={addOverride} disabled={busy || !view}>
            <Gauge size={14} />
            设置单独额度
          </button>
        </div>
        {note ? <p className="admin-cell-note" role="status">{note}</p> : null}
      </section>

      <section className="admin-card admin-block">
        <div className="admin-card-head">
          <div>
            <h2>账号用量与额度</h2>
            <p>
              只列「本月花过积分」或「单独设过上限」的账号，按消耗从多到少排，最多 50 个。
              本月已用 = 扣费 − 退款；管理员发放与扣减不算消耗。
            </p>
          </div>
          <div className="admin-row-actions">
            <Badge tone={view && view.overrideCount ? 'ok' : 'neutral'}>
              {view ? (view.overrideCount ? view.overrideCount + ' 个单独额度' : '没有单独额度') : '读取中'}
            </Badge>
            <RefreshButton onClick={load} busy={loading} />
          </div>
        </div>
        {!loading && !rows.length && !error ? (
          <EmptyState
            title="本月还没有账号花积分"
            description="默认额度不限；等有人检索、评审或跑一次复刻，这里会按账本记的消耗列出来。"
          />
        ) : null}
        {rows.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th style={{ textAlign: 'right' }}>本月已用</th>
                  <th style={{ textAlign: 'right' }}>余额</th>
                  <th>上限</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.userId}>
                    <td>
                      <strong>{row.email}</strong>
                      <span className="admin-cell-note">
                        {row.name || '—'} · {row.kind === 'admin' ? '管理员' : '账号'}
                        {row.active ? '' : ' · 已停用'}
                      </span>
                    </td>
                    <td className="admin-mono num-col">{row.used.toLocaleString('zh-CN')}</td>
                    <td className="admin-mono num-col">{row.credits.toLocaleString('zh-CN')}</td>
                    <td>
                      <span className={row.unlimited ? 'admin-cell-note' : ''}>{limitLabel(row)}</span>
                      {row.override !== null && row.limit > 0 ? (
                        <span className="admin-cell-note">
                          默认 {view && view.monthlyLimit > 0 ? view.monthlyLimit : '不限'}
                        </span>
                      ) : null}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="admin-row-actions admin-row-actions--end">
                        <input
                          className="vq-input admin-quota-input"
                          value={rowDraft[row.userId] === undefined ? String(row.override ?? row.limit) : rowDraft[row.userId]}
                          inputMode="numeric"
                          aria-label={'给 ' + row.email + ' 设置每月上限'}
                          onChange={(event) => setRowDraft({ ...rowDraft, [row.userId]: event.target.value.replace(/[^0-9]/g, '') })}
                        />
                        <button type="button" className="vq-button vq-button--ghost" onClick={() => saveRow(row)} disabled={busy}>
                          保存
                        </button>
                        {row.override !== null ? (
                          <button type="button" className="vq-button vq-button--ghost" onClick={() => clearRow(row)} disabled={busy}>
                            <Trash2 size={14} />
                            恢复默认
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  )
}
