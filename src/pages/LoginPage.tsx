import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, ScanSearch, ShieldCheck } from 'lucide-react'
import { VisionQaMark } from '../brand/VisionQaMark'
import {
  AuthError,
  DEMO_EMAIL,
  DEMO_NAME,
  EXAMPLE_EMAIL,
  MIN_PASSWORD_LENGTH,
} from '../auth/session'
import type { Session, SignInInput } from '../auth/session'
import '../styles/shell.css'

type FormErrors = { email?: string; password?: string; form?: string }

type Props = {
  notice?: string
  onSignIn: (input: SignInInput) => Promise<Session>
  onGuest: () => void
}

export function LoginPage({ notice, onSignIn, onGuest }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<FormErrors>({})
  const [info, setInfo] = useState('')
  const passwordRef = useRef<HTMLInputElement>(null)

  const fillDemo = () => {
    setEmail(DEMO_EMAIL)
    setPassword('')
    setErrors({})
    setInfo(`已填入演示邮箱；密码输入任意 ${MIN_PASSWORD_LENGTH} 位以上即可。`)
    passwordRef.current?.focus()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return

    setErrors({})
    setInfo('')
    const trimmedEmail = email.trim()
    const nextErrors: FormErrors = {}
    if (!trimmedEmail) nextErrors.email = '请输入邮箱'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) nextErrors.email = '邮箱格式看起来不太对'
    if (password.length < MIN_PASSWORD_LENGTH) nextErrors.password = `密码至少 ${MIN_PASSWORD_LENGTH} 位`
    if (nextErrors.email || nextErrors.password) {
      setErrors(nextErrors)
      return
    }

    setBusy(true)
    try {
      await onSignIn({ email: trimmedEmail, password, remember })
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.field === 'email') setErrors({ email: error.message })
        else if (error.field === 'password') setErrors({ password: error.message })
        else setErrors({ form: error.message })
      } else {
        setErrors({ form: '登录没有完成，请稍后重试。' })
      }
      setBusy(false)
    }
  }

  return (
    <div className="vq-scope vq-login">
      <section className="vq-login-brand" aria-label="VisionQA 品牌介绍">
        <VisionQaMark size={440} className="vq-login-watermark" />
        <header className="vq-login-brand-head">
          <VisionQaMark size={24} />
          <span className="vq-login-wordmark">VisionQA</span>
          <span className="vq-login-divider" aria-hidden="true" />
          <span className="vq-mono">Workbench</span>
        </header>

        <div className="vq-login-brand-body">
          <p className="vq-mono">Visual review · Evidence first</p>
          <h1>
            给每一张截图
            <br />
            一个可复查的结论。
          </h1>
          <p className="vq-login-lede">
            VisionQA 对截图和产物做有证据的视觉评审：指出问题、标出区域、留下结论。这里是它的创作与检索工作台。
          </p>
          <ul className="vq-login-facts">
            <li>
              <span className="vq-mono">01</span>
              <div>
                <strong>检索爆款</strong>
                <p>按平台与关键词检索，拆帧复刻成可复用的脚本结构。</p>
              </div>
            </li>
            <li>
              <span className="vq-mono">02</span>
              <div>
                <strong>逐帧评审</strong>
                <p>结论只有通过、待确认、问题三种，每条都指向具体区域。</p>
              </div>
            </li>
            <li>
              <span className="vq-mono">03</span>
              <div>
                <strong>沉淀复用</strong>
                <p>评审过的产物回到模板库与画布，被下一个节点引用。</p>
              </div>
            </li>
          </ul>
        </div>

        <div className="vq-login-evidence" aria-label="评审记录示例">
          <div className="vq-login-evidence-head">
            <span className="vq-mono">VQ-0042 · FRAME 01</span>
            <span className="vq-login-verdict">待确认</span>
          </div>
          <p>主标题距商品底边 8px，低于规范要求的 16px。</p>
          <div className="vq-login-evidence-meta">
            <ScanSearch size={13} />
            <span className="vq-mono">1080 × 1920 · 安全区锚点</span>
          </div>
        </div>

        <footer className="vq-login-brand-foot">
          <span className="vq-mono">本地演示登录，不连接真实账号体系。</span>
          <span className="vq-mono">© 2026 VisionQA</span>
        </footer>
      </section>

      <main className="vq-login-panel">
        <div className="vq-login-form-wrap">
          <div className="vq-login-form-head">
            <span className="vq-mono">Sign in</span>
            <h2>登录 Workbench</h2>
            <p>使用工作邮箱继续。没有账号的话，直接填入演示账号即可。</p>
          </div>

          {notice && (
            <div className="vq-banner vq-banner--info" role="status">
              <ShieldCheck size={14} />
              <span>{notice}</span>
            </div>
          )}
          {info && (
            <div className="vq-banner vq-banner--info" role="status">
              <ShieldCheck size={14} />
              <span>{info}</span>
            </div>
          )}
          {errors.form && (
            <div className="vq-banner vq-banner--error" role="alert">
              <Lock size={14} />
              <span>{errors.form}</span>
            </div>
          )}

          <form className="vq-login-form" onSubmit={submit} noValidate>
            <div className="vq-field">
              <label className="vq-field-label" htmlFor="vq-email">
                邮箱 <em className="vq-mono">email</em>
              </label>
              <span className={`vq-input${errors.email ? ' is-invalid' : ''}`}>
                <Mail size={15} />
                <input
                  id="vq-email"
                  type="email"
                  name="email"
                  inputMode="email"
                  autoComplete="username"
                  placeholder={EXAMPLE_EMAIL}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby={errors.email ? 'vq-email-error' : undefined}
                  disabled={busy}
                />
              </span>
              {errors.email && (
                <span className="vq-field-error" id="vq-email-error">
                  {errors.email}
                </span>
              )}
            </div>

            <div className="vq-field">
              <label className="vq-field-label" htmlFor="vq-password">
                密码 <em className="vq-mono">password</em>
              </label>
              <span className={`vq-input${errors.password ? ' is-invalid' : ''}`}>
                <Lock size={15} />
                <input
                  id="vq-password"
                  ref={passwordRef}
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? 'vq-password-error' : undefined}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="vq-input-action"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </span>
              {errors.password && (
                <span className="vq-field-error" id="vq-password-error">
                  {errors.password}
                </span>
              )}
            </div>

            <div className="vq-login-row">
              <label className="vq-check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                  disabled={busy}
                />
                <span>记住我</span>
              </label>
              <button
                type="button"
                className="vq-link"
                onClick={() => setInfo('本地演示环境不提供密码找回，请使用演示账号或以访客身份进入。')}
              >
                忘记密码？
              </button>
            </div>

            <button className="vq-button vq-button--primary vq-button--block" type="submit" disabled={busy}>
              {busy ? (
                <>
                  <Loader2 size={15} className="vq-spin" />
                  正在验证会话…
                </>
              ) : (
                <>
                  登录
                  <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>

          <div className="vq-or">
            <span>或</span>
          </div>

          <button type="button" className="vq-button vq-button--ghost vq-button--block" onClick={onGuest} disabled={busy}>
            以访客身份进入
          </button>

          <div className="vq-demo">
            <div>
              <span className="vq-mono">演示账号</span>
              <strong>{DEMO_EMAIL}</strong>
              <span className="vq-demo-sub">
                {DEMO_NAME} · 任意 {MIN_PASSWORD_LENGTH} 位以上密码
              </span>
            </div>
            <button type="button" className="vq-button vq-button--quiet" onClick={fillDemo} disabled={busy}>
              填入
            </button>
          </div>

          <p className="vq-login-foot">
            <Lock size={12} />
            <span>本地演示登录，不连接真实账号体系。会话只保存在这个浏览器里。</span>
          </p>
        </div>
      </main>
    </div>
  )
}
