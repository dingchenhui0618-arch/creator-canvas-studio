import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Loader2, ShieldCheck, ShieldOff } from 'lucide-react'
import {
  disableTwoFactor,
  enableTwoFactor,
  getTwoFactor,
  startTwoFactorSetup,
  type TotpSetup,
  type TwoFactorStatus,
} from '../api/auth'
import '../styles/shell.css'

// 两步验证：开启时先给 secret + 备用码，再用 6 位码确认；关闭要口令 + 验证码双要素。
// secret 与备用码只在开启那一次出现在页面上，服务端之后只会回「有没有开、剩几次」。

const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function TwoFactorCard() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [setup, setSetup] = useState<TotpSetup | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [confirmOff, setConfirmOff] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setStatus(await getTwoFactor())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '两步验证状态没有读到')
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次挂载读一次；后续动作自己刷新，不在 render 里发请求
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void load()
  }, [load])

  const start = async () => {
    setBusy('setup')
    setError('')
    setMessage('')
    try {
      const next = await startTwoFactorSetup()
      setSetup(next)
      setCode('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '没有生成设置')
    } finally {
      setBusy('')
    }
  }

  const enable = async () => {
    if (!setup) return
    setBusy('enable')
    setError('')
    try {
      const next = await enableTwoFactor(code.trim())
      setStatus(next)
      setSetup(null)
      setCode('')
      setMessage('两步验证已开启。下次登录除了口令，还要输入认证器里的 6 位数字。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '确认没有完成')
    } finally {
      setBusy('')
    }
  }

  const disable = async () => {
    setBusy('disable')
    setError('')
    try {
      await disableTwoFactor(password, disableCode.trim())
      setPassword('')
      setDisableCode('')
      setConfirmOff(false)
      setMessage('两步验证已关闭。想再开一次，重新走一遍设置即可（会生成新的 secret 与备用码）。')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '关闭没有完成')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="vq-card vq-card--wide" id="account-two-factor">
      <div className="vq-card-head">
        <div>
          <span className="vq-mono">安全 / Two-factor</span>
          <h2>两步验证</h2>
          <p>
            开启后登录要两步：口令 + 认证器 App（Google Authenticator、1Password、Authy 都可以）里的 6 位数字。
            开启时会给你 10 枚一次性备用码，换手机时用它登录。
          </p>
        </div>
        <span className={'vq-badge ' + (status?.enabled ? 'vq-badge--pass' : 'vq-badge--warn')}>
          {loading ? '读取中' : status?.enabled ? '已开启' : '未开启'}
        </span>
      </div>

      {error ? <p className="vq-inline-error" role="alert">{error}</p> : null}
      {message ? <p className="vq-inline-ok" role="status">{message}</p> : null}

      {status?.enabled ? (
        <div className="vq-2fa-enabled">
          <p className="vq-2fa-facts">
            <ShieldCheck size={14} />
            已于 {status.enabledAt ? status.enabledAt.slice(0, 10) : '—'} 开启 · 备用码剩余{' '}
            <strong>{status.backupCodesLeft}</strong> 枚
          </p>
          {confirmOff ? (
            <div className="vq-2fa-off">
              <p className="vq-2fa-warn">关闭后，登录只需要口令。口令泄露就没有第二道门了。</p>
              <label className="vq-field">
                <span>当前口令</span>
                <input className="vq-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
              </label>
              <label className="vq-field">
                <span>认证器验证码，或一枚备用码</span>
                <input className="vq-input" value={disableCode} onChange={(event) => setDisableCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" />
              </label>
              <div className="vq-2fa-actions">
                <button className="vq-button vq-button--danger" onClick={() => void disable()} disabled={busy === 'disable'}>
                  {busy === 'disable' ? <Loader2 size={14} className="vq-spin" /> : <ShieldOff size={14} />}
                  确认关闭两步验证
                </button>
                <button className="vq-button vq-button--ghost" onClick={() => setConfirmOff(false)} disabled={busy === 'disable'}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button className="vq-button vq-button--ghost" onClick={() => setConfirmOff(true)}>
              <ShieldOff size={14} />
              关闭两步验证
            </button>
          )}
        </div>
      ) : setup ? (
        <div className="vq-2fa-setup">
          <div className="vq-field">
            <span>1. 在认证器里添加这个密钥（手动输入 / 粘贴）</span>
            <div className="vq-2fa-secret">
              <code>{setup.secret}</code>
              <button
                type="button"
                className="vq-button vq-button--ghost vq-button--tiny"
                onClick={() => void copyText(setup.secret).then((ok) => setMessage(ok ? '密钥已复制' : '复制失败，请手动选中'))}
              >
                <Copy size={13} />
                复制
              </button>
            </div>
            <span className="vq-field-hint">
              账号名填 visionqa；算法 SHA1 / 30 秒 / 6 位，和认证器默认一致。
              <a className="vq-link" href={setup.otpauth}>
                用 otpauth 链接打开
              </a>
            </span>
          </div>

          <div className="vq-field">
            <span>2. 备用码（只显示这一次，请存到密码管理器）</span>
            <div className="vq-2fa-codes">
              {setup.backupCodes.map((item) => (
                <code key={item}>{item}</code>
              ))}
            </div>
            <button
              type="button"
              className="vq-button vq-button--ghost vq-button--tiny"
              onClick={() => void copyText(setup.backupCodes.join('\n')).then((ok) => setMessage(ok ? '备用码已复制' : '复制失败，请手动复制'))}
            >
              <Copy size={13} />
              复制全部备用码
            </button>
          </div>

          <div className="vq-field">
            <span>3. 输入认证器里现在的 6 位数字，确认开启</span>
            <div className="vq-2fa-confirm">
              <input
                className="vq-input"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
              />
              <button className="vq-button vq-button--primary" onClick={() => void enable()} disabled={busy === 'enable' || code.trim().length < 6}>
                {busy === 'enable' ? <Loader2 size={14} className="vq-spin" /> : <Check size={14} />}
                确认开启
              </button>
              <button className="vq-button vq-button--ghost" onClick={() => setSetup(null)} disabled={busy === 'enable'}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="vq-button vq-button--primary" onClick={() => void start()} disabled={loading || busy === 'setup'}>
          {busy === 'setup' ? <Loader2 size={14} className="vq-spin" /> : <ShieldCheck size={14} />}
          开启两步验证
        </button>
      )}

      <p className="vq-2fa-note">
        密钥在服务端用 AES-GCM 加密保存，接口与日志都拿不到明文；备用码只存哈希，用过一次就作废。
      </p>
    </section>
  )
}
