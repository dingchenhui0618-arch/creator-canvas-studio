// 登录设备（v0.9.62）：列出本账号还在登录的会话，能单独退出某一台，也能一次退出其它所有设备。
// 只展示自己账号的数据；当前这一条不给「退出」，退出当前设备走左下角的「退出登录」。
import { useCallback, useEffect, useState } from 'react'
import { Laptop, LogOut, RefreshCw } from 'lucide-react'
import { Pill } from './ui'
import {
  listLoginSessions,
  revokeLoginSession,
  revokeOtherSessions,
  type LoginSession,
} from '../api/sessions'
import { daysLeft, deviceLabel, maskIp } from '../domain/device'
import '../styles/shell.css'

function stamp(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function SessionsCard() {
  const [sessions, setSessions] = useState<LoginSession[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listLoginSessions()
      setSessions(data.sessions)
      setTotal(data.total)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录设备没有读到')
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次挂载读一次。这里不直接调用 load()：在 effect 里同步 setState 会多渲染一轮，
  // 也让 lint 报 set-state-in-effect；读回来的结果只在 then 里落地。
  useEffect(() => {
    let alive = true
    listLoginSessions()
      .then((data) => {
        if (!alive) return
        setSessions(data.sessions)
        setTotal(data.total)
        setError('')
      })
      .catch((caught) => {
        if (alive) setError(caught instanceof Error ? caught.message : '登录设备没有读到')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const revokeOne = async (item: LoginSession) => {
    setBusy(item.id)
    setError('')
    setMessage('')
    try {
      await revokeLoginSession(item.id)
      setMessage('已退出 ' + deviceLabel(item.userAgent) + ' 上的登录。')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '这台设备没有退出')
    } finally {
      setBusy('')
    }
  }

  const revokeOthers = async () => {
    setBusy('others')
    setError('')
    setMessage('')
    try {
      const result = await revokeOtherSessions()
      setMessage(
        result.signedOut > 0
          ? '已退出其它 ' + result.signedOut + ' 台设备，当前设备保持登录。'
          : '除当前设备外没有其它登录。',
      )
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '退出其它设备没有完成')
    } finally {
      setBusy('')
    }
  }

  // 按总数判断有没有别的设备：列表只列最近几条，最早那批不进列表但同样要能一键清掉
  const others = Math.max(0, total - 1)

  return (
    <section className="vq-card vq-card--wide" id="account-sessions">
      <div className="vq-card-head">
        <div>
          <span className="vq-mono">安全 / Devices</span>
          <h2>登录设备</h2>
          <p>
            这里是这个账号还在登录的会话。发现不认识的设备就退出它；改口令或重置口令也会清掉除当前设备外的全部登录。
          </p>
        </div>
        <div className="vq-account-actions">
          <Pill tone={others > 0 ? 'warn' : 'pass'}>{loading ? '读取中' : total + ' 台'}</Pill>
          <button
            type="button"
            className="vq-button vq-button--ghost vq-button--sm"
            onClick={() => void revokeOthers()}
            disabled={busy !== '' || others === 0}
            title="退出除当前设备外的全部登录"
          >
            <LogOut size={13} />
            退出其它设备
          </button>
          <button
            type="button"
            className="vq-button vq-button--icon"
            onClick={() => void load()}
            disabled={loading}
            aria-label="刷新登录设备"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div className="vq-card-body">
        {error ? <p className="vq-ledger-empty">{error}</p> : null}
        {loading && !sessions.length ? <p className="vq-ledger-empty">读取登录设备…</p> : null}
        {sessions.length ? (
          <ul className="vq-session-list">
            {sessions.map((item) => (
              <li className={'vq-session-row' + (item.current ? ' is-current' : '')} key={item.id}>
                <span className="vq-session-icon" aria-hidden="true">
                  <Laptop size={14} strokeWidth={1.5} />
                </span>
                <span className="vq-session-main">
                  <strong>{deviceLabel(item.userAgent)}</strong>
                  <small>登录于 {stamp(item.createdAt)}</small>
                </span>
                <span className="vq-session-ip vq-mono">{maskIp(item.ip)}</span>
                <span className="vq-session-expire vq-mono">
                  {daysLeft(item.expiresAt) > 0 ? daysLeft(item.expiresAt) + ' 天后到期' : '即将到期'}
                </span>
                {item.current ? (
                  <Pill tone="pass">当前</Pill>
                ) : (
                  <button
                    type="button"
                    className="vq-button vq-button--ghost vq-button--sm"
                    onClick={() => void revokeOne(item)}
                    disabled={busy !== ''}
                  >
                    退出
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {total > sessions.length ? (
          <p className="vq-session-note">
            还有 {total - sessions.length} 台更早的登录没有逐条列出。确认都不是自己的设备后，点「退出其它设备」一次清掉。
          </p>
        ) : null}
        {message ? <p className="vq-password-ok" role="status">{message}</p> : null}
        <p className="vq-session-note">
          会话凭据只存在服务端下发的 HttpOnly cookie 里，页面读不到；退出之后，那台设备下一次请求就会被拒绝。
        </p>
      </div>
    </section>
  )
}
