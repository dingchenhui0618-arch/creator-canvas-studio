import { useCallback, useEffect, useState } from 'react'
import { listCanvasIdentities, setCanvasIdentityAccess, type CanvasIdentity, type CanvasIdentityList } from '../../api/adminCanvas'
import { formatDateTime } from './data'
import { AdminHead, Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton } from './ui'

/**
 * 画布身份：画布并入 VisionQA 账号后，谁从工作台进过画布都在这里。停用只影响画布，不影响工作台登录。
 */
export default function CanvasSection() {
  const [data, setData] = useState<CanvasIdentityList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(0)
  const [message, setMessage] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    listCanvasIdentities()
      .then((next) => setData(next))
      .catch((caught) => setError(caught instanceof Error ? caught.message : '画布身份读取失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const toggle = async (item: CanvasIdentity) => {
    setBusyId(item.id)
    setMessage('')
    try {
      await setCanvasIdentityAccess(item.id, !item.active)
      setMessage(`${item.displayName} 已${item.active ? '停用画布访问' : '恢复画布访问'}`)
      load()
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : '画布身份状态修改失败')
    } finally {
      setBusyId(0)
    }
  }

  const items = data?.items || []
  const summary = data?.summary

  return (
    <>
      <AdminHead
        kicker="画布"
        title="画布身份"
        description="画布已并入 VisionQA 账号：从工作台进入过画布的用户会出现在这里。停用只停画布，不停工作台登录；停用后该用户下次进入会被拒绝。"
        actions={<RefreshButton onClick={load} busy={loading} />}
      />

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      {data && !data.available ? (
        <section className="admin-card admin-block">
          <div className="admin-block-head">
            <div>
              <p className="admin-label">画布服务未连接</p>
              <p className="admin-sub">{data.reason || '画布服务暂时连不上'}。画布身份要等画布服务可用后才能读取。</p>
            </div>
          </div>
        </section>
      ) : null}

      {data && data.available ? (
        <section className="admin-card admin-block">
          <div className="admin-block-head">
            <div>
              <p className="admin-label">已开通画布的账号</p>
              <p className="admin-sub">
                共 {data.total} 位，其中在用 {summary?.active ?? 0} 位、停用 {summary?.suspended ?? 0} 位
                {summary?.missing ? `；${summary.missing} 位的 VisionQA 账号已删除` : ''}。
              </p>
            </div>
          </div>

          {loading && !items.length ? (
            <LoadingLine label="/api/admin/canvas/users" />
          ) : items.length ? (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>VisionQA 账号</th>
                    <th>画布身份</th>
                    <th>最近进入</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td className="admin-mono">{item.account ? item.account.email : '账号已删除'}</td>
                      <td>{item.displayName}</td>
                      <td className="admin-mono">{formatDateTime(item.lastLoginAt)}</td>
                      <td>
                        {item.account && !item.account.active ? (
                          <Badge tone="warn">工作台已停用</Badge>
                        ) : (
                          <Badge tone={item.active ? 'ok' : 'fail'}>{item.active ? '可用' : '已停用'}</Badge>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="admin-btn admin-btn--ghost"
                          disabled={busyId === item.id}
                          onClick={() => void toggle(item)}
                        >
                          {busyId === item.id ? '处理中…' : item.active ? '停用画布' : '恢复画布'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="还没有人进入过画布" description="从工作台点开画布后，这里会出现对应的画布身份。" />
          )}
          {message ? <p className="admin-hint" role="status">{message}</p> : null}
        </section>
      ) : null}
    </>
  )
}
