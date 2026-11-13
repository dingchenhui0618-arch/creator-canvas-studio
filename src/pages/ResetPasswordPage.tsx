// 找回密码：从邮件里的链接进来，不登录也要能打开。
// 三步：先探链接（还能用吗）→ 填新口令 → 改完去登录。
// 这里不显示「这个邮箱有没有账号」之类的信息：token 本身就说明了一切。
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, KeyRound, Loader2, Lock, ShieldCheck } from 'lucide-react'
import { checkResetToken, getAuthConfig, resetPassword } from '../api/auth'
import { navigate } from '../router'
import '../styles/shell.css'

type Phase = 'checking' | 'ready' | 'invalid' | 'done'

const MIN_FALLBACK = 8

function formatExpiry(value: string | null): string {
  if (!value) return ''
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })
}

export function ResetPasswordPage({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>(token ? 'checking' : 'invalid')
  const [problem, setProblem] = useState(token ? '' : '链接里没有重置凭据，请从邮件里重新点一次')
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [policy, setPolicy] = useState('')
  const [minLength, setMinLength] = useState(MIN_FALLBACK)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    getAuthConfig()
      .then((config) => {
        if (!alive) return
        if (config.minPasswordLength > 0) setMinLength(config.minPasswordLength)
        if (config.passwordPolicy) setPolicy(config.passwordPolicy)
      })
      .catch(() => {
        // 配置拿不到不影响改口令：服务端仍按自己的规则校验
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!token) return
    let alive = true
    checkResetToken(token)
      .then((state) => {
        if (!alive) return
        if (state.valid) {
          setPhase('ready')
          setExpiresAt(state.expiresAt)
          return
        }
        setPhase('invalid')
        setProblem(state.message || '这枚链接不能用了，请重新申请一封')
      })
      .catch(() => {
        if (!alive) return
        setPhase('invalid')
        setProblem('核验链接时没有连上服务端，请刷新重试，或重新申请一封')
      })
    return () => {
      alive = false
    }
  }, [token])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    if (!password) {
      setError('请输入新口令')
      return
    }
    if (password.length < minLength) {
      setError('口令至少 ' + minLength + ' 位')
      return
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      setError('口令要同时包含字母和数字')
      return
    }
    if (password !== confirm) {
      setError('两次输入的口令不一样')
      return
    }
    setError('')
    setBusy(true)
    try {
      await resetPassword(token, password)
      setPhase('done')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : ''
      setError(message || '口令没有改成功，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="vq-reset">
      <div className="vq-reset-card">
        <div className="vq-reset-head">
          <span className="vq-mono vq-reset-kicker">Reset password</span>
          <h1>{phase === 'done' ? '口令已更新' : phase === 'invalid' ? '这枚链接不能用了' : '设置新口令'}</h1>
          <p>
            {phase === 'done'
              ? '旧口令已失效，这个账号在其它设备上的会话也一起注销了。用新口令重新登录。'
              : phase === 'invalid'
                ? '重置链接只能用一次，过期或已经用过的都不能再打开。回到登录页重新发一封就行。'
                : '这枚链接只能用一次' + (expiresAt ? '，' + formatExpiry(expiresAt) + ' 前有效' : '') + '。改完这个账号的所有会话会一起注销。'}
          </p>
        </div>

        {phase === 'checking' ? (
          <p className="vq-reset-checking">
            <Loader2 size={14} className="vq-spin" />
            正在核验链接…
          </p>
        ) : null}

        {phase === 'invalid' && problem ? (
          <div className="vq-banner vq-banner--error" role="alert">
            <Lock size={14} />
            <span>{problem}</span>
          </div>
        ) : null}

        {phase === 'ready' ? (
          <form className="vq-reset-form" onSubmit={submit} noValidate>
            <div className="vq-field">
              <label className="vq-field-label" htmlFor="vq-reset-password">
                新口令 <em className="vq-mono">new password</em>
              </label>
              <span className={'vq-input' + (error ? ' is-invalid' : '')}>
                <Lock size={15} />
                <input
                  id="vq-reset-password"
                  type={show ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoFocus
                  placeholder={'至少 ' + minLength + ' 位，含字母和数字'}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    if (error) setError('')
                  }}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="vq-input-action"
                  onClick={() => setShow((value) => !value)}
                  aria-label={show ? '隐藏口令' : '显示口令'}
                  tabIndex={-1}
                >
                  {show ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </span>
              <span className="vq-field-hint">{policy || '至少 ' + minLength + ' 位，且同时包含字母和数字'}</span>
            </div>

            <div className="vq-field">
              <label className="vq-field-label" htmlFor="vq-reset-confirm">
                再输一次 <em className="vq-mono">confirm</em>
              </label>
              <span className={'vq-input' + (error ? ' is-invalid' : '')}>
                <KeyRound size={15} />
                <input
                  id="vq-reset-confirm"
                  type={show ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="再输一次，确认没有打错"
                  value={confirm}
                  onChange={(event) => {
                    setConfirm(event.target.value)
                    if (error) setError('')
                  }}
                  disabled={busy}
                />
              </span>
            </div>

            {error ? (
              <div className="vq-banner vq-banner--error" role="alert">
                <Lock size={14} />
                <span>{error}</span>
              </div>
            ) : null}

            <button className="vq-button vq-button--primary vq-button--lg" type="submit" disabled={busy}>
              {busy ? (
                <>
                  <Loader2 size={15} className="vq-spin" />
                  正在改口令…
                </>
              ) : (
                <>
                  设置新口令
                  <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>
        ) : null}

        {phase === 'done' || phase === 'invalid' ? (
          <button
            className="vq-button vq-button--primary vq-button--lg"
            type="button"
            onClick={() => navigate({ kind: 'page', page: 'overview' })}
          >
            {phase === 'done' ? '用新口令登录' : '回到登录页'}
            <ArrowRight size={15} />
          </button>
        ) : null}

        <p className="vq-reset-foot">
          <ShieldCheck size={12} />
          <span>链接由 VisionQA 通过邮件发出，只能用一次；它不会出现在浏览器历史之外的地方。</span>
        </p>
      </div>
    </main>
  )
}
