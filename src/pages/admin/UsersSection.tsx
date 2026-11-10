import { useCallback, useEffect, useMemo, useState } from 'react'
import { listAdminUsers, grantCredits, updateAdminUser, type AdminUser } from '../../api/credits'
import type { SessionKind } from '../../auth/session'
import { formatDateTime } from './data'
import { AdminHead, Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'
import '../../styles/credits.css'

// 角色列说业务话：服务端 kind 只有 admin / account / guest 三种
function roleLabel(kind: SessionKind): string {
  if (kind === 'admin') return '管理员'
  if (kind === 'guest') return '访客'
  return '普通账号'
}

/**
 * 账号页现在是真接口：GET /api/admin/users 列真实账号（含积分余额），
 * POST /api/admin/users/:id/credits 发放/扣减积分。权限在服务端判断（kind=admin 或 VQ_ADMIN_EMAILS），
 * 非管理员进来会看到 403 的实话，而不是一张空表。
 */
export default function UsersSection() {
  const [items, setItems] = useState<AdminUser[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState('')
  const [amount, setAmount] = useState('50')
  const [note, setNote] = useState('')
  const [granting, setGranting] = useState(false)
  const [grantMessage, setGrantMessage] = useState('')
  const [accessBusy, setAccessBusy] = useState('')
  const [accessMessage, setAccessMessage] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    listAdminUsers()
      .then((data) => {
        setItems(data.items)
        setSelectedId((current) => current || data.items[0]?.id || '')
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '账号列表读取失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const selected = useMemo(() => items.find((item) => item.id === selectedId) || null, [items, selectedId])
  const totalCredits = items.reduce((sum, item) => sum + (item.credits || 0), 0)

  const changeAccess = async (item: AdminUser, patch: { active?: boolean; kind?: 'admin' | 'account' }) => {
    setAccessBusy(item.id)
    setAccessMessage('')
    try {
      const result = await updateAdminUser(item.id, patch)
      setAccessMessage(
        (result.user.kind === 'admin' ? '已将 ' : '已把 ') +
          item.email +
          (result.user.kind === 'admin' ? ' 设为管理员' : ' 设为普通账号') +
          (patch.active === false ? '，并停用登录' : patch.active === true ? '，恢复登录' : ''),
      )
      load()
    } catch (caught) {
      setAccessMessage(caught instanceof Error ? caught.message : '账号状态修改失败')
    } finally {
      setAccessBusy('')
    }
  }

  const submit = async () => {
    const value = Number(amount)
    if (!selected) return
    if (!Number.isFinite(value) || value === 0) {
      setGrantMessage('数量必须是非 0 整数（负数表示扣减）')
      return
    }
    setGranting(true)
    setGrantMessage('')
    try {
      const result = await grantCredits(selected.id, Math.trunc(value), note.trim())
      setGrantMessage('已' + (value > 0 ? '发放' : '扣减') + ' ' + Math.abs(Math.trunc(value)) + ' 积分，' + selected.email + ' 当前余额 ' + result.balance + ' 积分')
      setNote('')
      load()
    } catch (caught) {
      setGrantMessage(caught instanceof Error ? caught.message : '发放失败')
    } finally {
      setGranting(false)
    }
  }

  return (
    <>
      <AdminHead
        kicker="ADMIN / USERS"
        title="账号与积分"
        description="账号存在服务端数据库（data/auth.db，SQLite）；积分是服务端账本，检索/复刻/评审/对话按次扣减，失败原路退回。"
        actions={
          <>
            <SourceTag kind="api" source="/api/admin/users" />
            <RefreshButton onClick={load} busy={loading} />
          </>
        }
      />

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {accessMessage ? <p className="admin-hint">{accessMessage}</p> : null}

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">真实账号</p>
            <p className="admin-sub">
              共 {items.length} 个账号，积分合计 {totalCredits}。数据按账号隔离：模板、智能体、画布、运行记录只有本人（或管理员）能看。
            </p>
          </div>
        </div>

        {loading && !items.length ? (
          <LoadingLine label="/api/admin/users" />
        ) : items.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>显示名</th>
                  <th>角色</th>
                  <th className="num-col">积分</th>
                  <th>上次登录</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="admin-mono">{item.email}</td>
                    <td>{item.name}</td>
                    <td>{roleLabel(item.kind as SessionKind)}</td>
                    <td className="admin-mono num-col">{item.credits}</td>
                    <td className="admin-mono">{formatDateTime(item.lastLoginAt)}</td>
                    <td>
                      <Badge tone={item.active ? 'ok' : 'fail'}>{item.active ? '在用' : '停用'}</Badge>
                    </td>
                    <td>
                      <div className="admin-doc-actions">
                        <button
                          type="button"
                          className="admin-btn admin-btn--ghost"
                          disabled={accessBusy === item.id}
                          onClick={() => void changeAccess(item, { active: !item.active })}
                        >
                          {item.active ? '停用' : '启用'}
                        </button>
                        <button
                          type="button"
                          className="admin-btn admin-btn--ghost"
                          disabled={accessBusy === item.id}
                          onClick={() => void changeAccess(item, { kind: item.kind === 'admin' ? 'account' : 'admin' })}
                        >
                          {item.kind === 'admin' ? '设为普通账号' : '设为管理员'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="还没有账号" description="注册开关默认关闭；用 npm run adduser 加第一个账号。" />
        )}
      </section>

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">发放积分</p>
            <p className="admin-sub">充值通道未开通（金额与档位还没定），所以积分只能由管理员在这里发放。</p>
          </div>
        </div>

        <div className="vq-inline-form">
          <label className="vq-field">
            <span>账号</span>
            <select className="vq-input" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.email}（{item.credits} 积分）
                </option>
              ))}
            </select>
          </label>
          <label className="vq-field vq-field--narrow">
            <span>数量</span>
            <input className="vq-input" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" />
          </label>
          <label className="vq-field vq-field--wide">
            <span>备注</span>
            <input
              className="vq-input"
              value={note}
              placeholder="例如：首批体验额度"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button type="button" className="vq-button vq-button--primary" onClick={submit} disabled={granting || !selected}>
            {granting ? '提交中…' : '发放 / 扣减'}
          </button>
        </div>
        {grantMessage ? <p className="admin-hint">{grantMessage}</p> : null}
      </section>
    </>
  )
}
