import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, ScanSearch, ShieldCheck, Ticket, User } from 'lucide-react'
import {
  AuthError,
  DEFAULT_MIN_PASSWORD_LENGTH,
  EXAMPLE_EMAIL,
  NAME_MAX_LENGTH,
  TwoFactorRequired,
  register as registerAccount,
} from '../auth/session'
import type { RegisterInput, Session, SignInInput } from '../auth/session'
import { checkInvite, forgotPassword, getAuthConfig } from '../api/auth'
import type { InviteState } from '../api/auth'
import { useSiteInfo, useUiMode } from '../api/app'
import { FeedbackModal } from '../components/FeedbackModal'
import '../styles/shell.css'

type Mode = 'signin' | 'signup'

type FormErrors = { email?: string; password?: string; name?: string; terms?: string; code?: string; form?: string }

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// 邀请链接形如 #/register?code=VQ-XXXX-XXXX：直接进注册态并预填，对方不用再翻消息找码。
function inviteFromHash(): { code: string; signup: boolean } {
  if (typeof window === 'undefined') return { code: '', signup: false }
  const raw = window.location.hash.replace(/^#/, '')
  const [pathPart, queryPart = ''] = raw.split('?')
  const params = new URLSearchParams(queryPart)
  return { code: params.get('code') || '', signup: /^\/register\b/.test(pathPart) || params.has('code') }
}

// 注册成功后把 #/register?code=... 收拾干净：工作台已经进来了，地址栏不该还挂着邀请码。
function leaveAuthLink(): void {
  if (/^#\/(?:register|login)(?:[?]|$)/.test(window.location.hash)) {
    window.history.replaceState(null, '', '#/overview')
  }
}

function inviteHintOf(state: InviteState | null, checking: boolean): string {
  if (checking) return '正在核对邀请码…'
  if (!state) return ''
  if (state.valid) {
    const credits = Number(state.credits || 0)
    return '邀请码可用' + (credits > 0 ? '，注册后额外赠送 ' + credits + ' 积分' : '，注册后直接开号')
  }
  if (state.reason === 'used') return '这枚邀请码已经用完了，请联系管理员再要一枚'
  if (state.reason === 'revoked') return '这枚邀请码已被撤销，请联系管理员换一枚'
  if (state.reason === 'expired') return '这枚邀请码已过期，请联系管理员换一枚'
  return '邀请码无效，请核对完整邀请码'
}

type Props = {
  notice?: string
  onSignIn: (input: SignInInput) => Promise<Session>
  /**
   * 宿主的注册入口（useSession().register）。未接线时回退成「注册 + 登录」两次请求：
   * 后端注册已下发 cookie，回退路径只是为了让页面在宿主补齐之前也能用。
   */
  onRegister?: (input: RegisterInput) => Promise<Session>
  /** 两步验证第二步：拿到 challenge 后换会话 */
  onVerifyTwoFactor?: (challenge: string, code: string, remember: boolean) => Promise<Session>
}

export function LoginPage({ notice, onSignIn, onRegister, onVerifyTwoFactor }: Props) {
  const { internal } = useUiMode()
  const site = useSiteInfo()
  const [mode, setMode] = useState<Mode>(() => (inviteFromHash().signup ? 'signup' : 'signin'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [remember, setRemember] = useState(true)
  // 条款同意：注册必须真的勾上，服务端会把「同意的版本 + 时间」记到账号上
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  // 两步验证第二步：口令通过但账号开了 2FA 时，先停在这一步
  const [twoFactor, setTwoFactor] = useState<{ challenge: string; remember: boolean; email: string } | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<FormErrors>({})
  const [info, setInfo] = useState('')
  // 注册开关与密码长度由后端下发；登录页不再展示任何演示账号或口令。
  // 首屏默认不显示注册入口（跟服务端 fail-closed 一致），拿到配置再放开。
  const [registrationEnabled, setRegistrationEnabled] = useState(false)
  // 邀请制始终可用：注册全局关闭时，凭有效邀请码仍能自助开号
  const [inviteRegistration, setInviteRegistration] = useState(false)
  const [inviteCode, setInviteCode] = useState(() => inviteFromHash().code)
  const [invite, setInvite] = useState<InviteState | null>(null)
  const [checkingInvite, setCheckingInvite] = useState(false)
  // 服务端配了邮件通道才提供自助找回；没配就如实说「找管理员」，不摆一个点了没用的入口。
  const [passwordReset, setPasswordReset] = useState(false)
  const [forgotOpen, setForgotOpen] = useState(false)
  // 登录进不来时也要有一条求助路径：反馈不需要登录，留联系方式即可
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // 密码长度以后端配置为准，这里只放一个兜底值；登录不校验长度。
  const [minPasswordLength, setMinPasswordLength] = useState(DEFAULT_MIN_PASSWORD_LENGTH)
  const [passwordPolicy, setPasswordPolicy] = useState('')
  const passwordRef = useRef<HTMLInputElement>(null)
  const isSignup = mode === 'signup'
  // 注册全局关着也可以走邀请码；两扇门任一打开就显示注册入口
  const canSignup = registrationEnabled || inviteRegistration
  const inviteText = inviteCode.trim()
  const inviteMessage = isSignup ? inviteHintOf(invite, checkingInvite) : ''
  const inviteBad = Boolean(invite && !invite.valid)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    getAuthConfig(controller.signal)
      .then((config) => {
        if (!active) return
        setRegistrationEnabled(config.registrationEnabled)
        setInviteRegistration(Boolean(config.inviteRegistration))
        if (config.minPasswordLength > 0) setMinPasswordLength(config.minPasswordLength)
        if (config.passwordPolicy) setPasswordPolicy(config.passwordPolicy)
        setPasswordReset(Boolean(config.passwordReset))
      })
      .catch(() => {
        // 后端没起来：注册入口按最保守处理（不显示），登录照常可填。
        if (active) setRegistrationEnabled(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [])

  // 码一填就核一次（防抖 450ms）：有效的直接说送多少积分，无效的当场说原因，
  // 别等提交完再把人退回来重填。
  useEffect(() => {
    if (!isSignup || !inviteText) return
    let active = true
    const timer = window.setTimeout(() => {
      setCheckingInvite(true)
      checkInvite(inviteText)
        .then((state) => {
          if (active) setInvite(state)
        })
        .catch(() => {
          if (active) setInvite(null)
        })
        .finally(() => {
          if (active) setCheckingInvite(false)
        })
    }, 450)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [isSignup, inviteText])

  const switchMode = (next: Mode) => {
    if (busy || next === mode) return
    setMode(next)
    setErrors({})
    setInfo('')
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return

    const trimmedEmail = email.trim()
    const trimmedName = name.trim()
    const nextErrors: FormErrors = {}
    if (!trimmedEmail) nextErrors.email = '请输入邮箱'
    else if (!EMAIL_PATTERN.test(trimmedEmail)) nextErrors.email = '邮箱格式看起来不太对'
    if (isSignup) {
      // 只有注册校验密码长度，长度取后端下发的 minPasswordLength。
      if (!password) nextErrors.password = '请设置密码'
      else if (password.length < minPasswordLength) nextErrors.password = `密码至少 ${minPasswordLength} 位`
      else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) nextErrors.password = '密码要同时包含字母和数字'
      if (trimmedName.length > NAME_MAX_LENGTH) nextErrors.name = `昵称最多 ${NAME_MAX_LENGTH} 字`
      // 注册关闭时邀请码就是唯一入口；填了但已失效也不要继续，避免提交完才被退回来
      if (!registrationEnabled && !inviteText) nextErrors.code = '当前未开放自助注册，请填写邀请码'
      else if (inviteText && inviteBad) nextErrors.code = '这枚邀请码当前不可用，请核对或联系管理员'
      if (!acceptedTerms) nextErrors.terms = '请先阅读并勾选同意服务条款与隐私说明'
    } else if (!password) {
      nextErrors.password = '请输入密码'
    }

    setInfo('')
    if (nextErrors.email || nextErrors.password || nextErrors.name || nextErrors.terms || nextErrors.code) {
      setErrors(nextErrors)
      return
    }

    setErrors({})
    setBusy(true)
    let created = false
    try {
      if (mode === 'signup') {
        if (onRegister) {
          await onRegister({
            email: trimmedEmail,
            password,
            name: trimmedName || undefined,
            acceptedTerms,
            termsVersion: site.termsVersion,
            inviteCode: inviteText || undefined,
          })
          leaveAuthLink()
        } else {
          await registerAccount({
            email: trimmedEmail,
            password,
            name: trimmedName || undefined,
            acceptedTerms,
            termsVersion: site.termsVersion,
            inviteCode: inviteText || undefined,
          })
          created = true
          setInfo('账号已创建，正在建立会话…')
          await onSignIn({ email: trimmedEmail, password, remember })
          leaveAuthLink()
        }
      } else {
        await onSignIn({ email: trimmedEmail, password, remember })
        leaveAuthLink()
      }
    } catch (error) {
      setBusy(false)
      const detail = error instanceof AuthError ? error.message : ''
      // 账号已经建好、只是自动登录没走通：必须让用户知道「别再注册一次」。
      if (created) {
        setErrors({ form: `账号已创建，但自动登录没有完成${detail ? `（${detail}）` : ''}，请直接用该邮箱登录。` })
        return
      }
      // 不是失败：换到第二步输入验证码，页面别报「登录没有完成」
      if (error instanceof TwoFactorRequired) {
        setTwoFactor({ challenge: error.challenge, remember, email: trimmedEmail })
        setErrors({})
        setInfo('')
        return
      }
      if (error instanceof AuthError) {
        if (error.field === 'email') setErrors({ email: error.message })
        else if (error.field === 'password') setErrors({ password: error.message })
        else if (error.field === 'name') setErrors({ name: error.message })
        else if (error.field === 'terms') setErrors({ terms: error.message })
        else if (error.field === 'code') setErrors({ code: error.message })
        else setErrors({ form: error.message })
      } else {
        setErrors({ form: isSignup ? '注册没有完成，请稍后重试。' : '登录没有完成，请稍后重试。' })
      }
    }
  }

  // 第二步：6 位 TOTP 或一枚备用码
  const submitTotp = async (code: string) => {
    if (busy || !twoFactor || !onVerifyTwoFactor) return
    const trimmed = code.trim()
    if (!trimmed) {
      setErrors({ code: '请输入验证码' })
      return
    }
    setErrors({})
    setInfo('')
    setBusy(true)
    try {
      await onVerifyTwoFactor(twoFactor.challenge, trimmed, twoFactor.remember)
    } catch (error) {
      setBusy(false)
      if (error instanceof AuthError) {
        setErrors(error.field === 'code' ? { code: error.message } : { form: error.message })
      } else {
        setErrors({ form: '验证没有完成，请稍后重试。' })
      }
    }
  }

  return (
    <div className="vq-scope vq-login">
      <section className="vq-login-brand" aria-label="VisionQA 品牌介绍">
        <span className="vq-login-watermark-text" aria-hidden="true">VisionQA</span>
        <header className="vq-login-brand-head">
          <span className="vq-login-brand-dot" aria-hidden="true" />
          <span className="vq-login-wordmark">VisionQA</span>
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
          <span className="vq-mono">{internal ? '账号与会话由服务端校验。' : '账号与会话均已安全校验。'}</span>
          <span className="vq-mono">© 2026 VisionQA</span>
        </footer>
      </section>

      <main className="vq-login-panel">
        <div className="vq-login-form-wrap">
          {twoFactor ? (
            <TwoFactorStep
              email={twoFactor.email}
              busy={busy}
              error={errors.code || errors.form || ''}
              onSubmit={(code) => void submitTotp(code)}
              onCancel={() => {
                setTwoFactor(null)
                setErrors({})
                setInfo('')
              }}
            />
          ) : forgotOpen ? (
            <ForgotStep
              email={email}
              supportEmail={site.supportEmail}
              onBack={() => {
                setForgotOpen(false)
                setErrors({})
                setInfo('')
              }}
            />
          ) : (
            <>
          <div className="vq-login-form-head">
            <span className="vq-mono">{isSignup ? 'Create account' : 'Sign in'}</span>
            <h2>{isSignup ? '创建账号' : '登录 VisionQA'}</h2>
            <p>
              {isSignup
                ? registrationEnabled
                  ? '注册完直接进入工作台。昵称只是显示名，可以稍后再补。'
                  : '凭邀请码创建账号，开通后直接进入工作台；没有邀请码可以联系管理员。'
                : internal
                  ? '使用工作邮箱继续。会话由服务端校验，凭据不进浏览器存储。'
                  : '使用工作邮箱继续。登录状态会安全保存，凭据不留在浏览器里。'}
            </p>
          </div>

          {canSignup && (
            <div className="vq-login-modes" role="group" aria-label="登录或注册">
              <button
                type="button"
                className="vq-login-mode"
                aria-pressed={!isSignup}
                onClick={() => switchMode('signin')}
                disabled={busy}
              >
                登录
              </button>
              <button
                type="button"
                className="vq-login-mode"
                aria-pressed={isSignup}
                onClick={() => switchMode('signup')}
                disabled={busy}
              >
                注册
              </button>
            </div>
          )}

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
            {isSignup && (
              <div className="vq-field">
                <label className="vq-field-label" htmlFor="vq-invite">
                  邀请码 <em className="vq-mono">{registrationEnabled ? 'invite · 可选' : 'invite · 内测必填'}</em>
                </label>
                <span className={`vq-input${errors.code ? ' is-invalid' : ''}`}>
                  <Ticket size={15} />
                  <input
                    id="vq-invite"
                    name="inviteCode"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="VQ-XXXX-XXXX"
                    value={inviteCode}
                    onChange={(event) => {
                      const next = event.target.value
                      setInviteCode(next)
                      if (!next.trim()) {
                        setInvite(null)
                        setCheckingInvite(false)
                      }
                      if (errors.code) setErrors((previous) => ({ ...previous, code: undefined }))
                    }}
                    aria-invalid={Boolean(errors.code)}
                    aria-describedby="vq-invite-hint"
                    disabled={busy}
                  />
                </span>
                {errors.code ? (
                  <span className="vq-field-error" id="vq-invite-hint">
                    {errors.code}
                  </span>
                ) : inviteMessage ? (
                  <span className={`vq-field-hint${inviteBad ? ' is-bad' : invite ? ' is-ok' : ''}`} id="vq-invite-hint">
                    {inviteMessage}
                  </span>
                ) : (
                  <span className="vq-field-hint" id="vq-invite-hint">
                    {registrationEnabled
                      ? '有邀请码就填上，注册后额外赠送积分；没有也可以直接注册。'
                      : '注册通道未公开开放；凭邀请码可以自助开号。'}
                  </span>
                )}
              </div>
            )}
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

            {isSignup && (
              <div className="vq-field">
                <label className="vq-field-label" htmlFor="vq-name">
                  昵称 <em className="vq-mono">name · 可选</em>
                </label>
                <span className={`vq-input${errors.name ? ' is-invalid' : ''}`}>
                  <User size={15} />
                  <input
                    id="vq-name"
                    type="text"
                    name="name"
                    autoComplete="nickname"
                    placeholder="例如：林可"
                    maxLength={NAME_MAX_LENGTH}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    aria-invalid={Boolean(errors.name)}
                    aria-describedby={errors.name ? 'vq-name-error' : undefined}
                    disabled={busy}
                  />
                </span>
                {errors.name && (
                  <span className="vq-field-error" id="vq-name-error">
                    {errors.name}
                  </span>
                )}
              </div>
            )}

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
                  autoComplete={isSignup ? 'new-password' : 'current-password'}
                  placeholder={isSignup ? `至少 ${minPasswordLength} 位，含字母和数字` : '账户密码'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? 'vq-password-error' : isSignup ? 'vq-password-policy' : undefined}
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
              {isSignup && !errors.password && (
                <span className="vq-field-hint" id="vq-password-policy">
                  {passwordPolicy || `至少 ${minPasswordLength} 位，且同时包含字母和数字`}
                </span>
              )}
            </div>

            {!isSignup && (
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
                  onClick={() => {
                    if (passwordReset) {
                      setForgotOpen(true)
                      setErrors({})
                      setInfo('')
                      return
                    }
                    setInfo(
                      internal
                        ? '内部环境：管理员在「后台 → 账号」里可直接重置口令，新口令只显示一次；该账号所有旧会话会被注销。'
                        : site.supportEmail
                          ? '这个部署还没配置邮件通道，不能自助找回。请找管理员重置（' + site.supportEmail + '）：管理员在「后台 → 账号」里直接改，新口令只显示一次。平台不会以任何方式向你索要当前口令。'
                          : '这个部署还没配置邮件通道，不能自助找回。请找工作区管理员重置：管理员在「后台 → 账号」里直接改，新口令只显示一次。平台不会以任何方式向你索要当前口令。',
                    )
                  }}
                >
                  忘记密码？
                </button>
              </div>
            )}

            {isSignup && (
              <div className="vq-field vq-field--terms">
                <label className="vq-check">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(event) => setAcceptedTerms(event.target.checked)}
                    disabled={busy}
                  />
                  <span>
                    我已阅读并同意
                    <a className="vq-link" href="#/legal/terms" target="_blank" rel="noreferrer">
                      服务条款
                    </a>
                    与
                    <a className="vq-link" href="#/legal/privacy" target="_blank" rel="noreferrer">
                      隐私说明
                    </a>
                    {site.termsVersion ? <em className="vq-check-note">版本 {site.termsVersion}</em> : null}
                  </span>
                </label>
                {errors.terms ? <span className="vq-field-error">{errors.terms}</span> : null}
              </div>
            )}

            <button className="vq-button vq-button--primary vq-button--lg" type="submit" disabled={busy}>
              {busy ? (
                <>
                  <Loader2 size={15} className="vq-spin" />
                  {isSignup ? '正在创建账号…' : '正在验证凭据…'}
                </>
              ) : (
                <>
                  {isSignup ? '创建账号' : '登录'}
                  <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>

          <p className="vq-login-foot vq-login-foot--legal">
            <a className="vq-link" href="#/help">帮助</a>
            <a className="vq-link" href="#/legal/terms">服务条款</a>
            <a className="vq-link" href="#/legal/privacy">隐私说明</a>
            <button type="button" className="vq-link" onClick={() => setFeedbackOpen(true)}>
              反馈问题
            </button>
          </p>

          <p className="vq-login-foot">
            <Lock size={12} />
            <span>{internal ? '会话保存在服务端下发的 HttpOnly cookie 里；浏览器只缓存用户名与邮箱，用于首屏渲染。' : '登录状态会安全保存；浏览器只记住用户名与邮箱，用来加快下次打开。'}</span>
          </p>
            </>
          )}
        </div>
      </main>

      {feedbackOpen ? <FeedbackModal onClose={() => setFeedbackOpen(false)} page="#/login" /> : null}
    </div>
  )
}

/** 登录第二步：认证器 6 位数字，或一枚一次性备用码。 */
function TwoFactorStep({
  email,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  email: string
  busy: boolean
  error: string
  onSubmit: (code: string) => void
  onCancel: () => void
}) {
  const [code, setCode] = useState('')
  return (
    <>
      <div className="vq-login-form-head">
        <span className="vq-mono">Two-factor</span>
        <h2>两步验证</h2>
        <p>
          {email ? email + ' 已开启两步验证。' : '这个账号已开启两步验证。'}
          输入认证器 App 里「VisionQA」这一条的 6 位数字；换了手机就用一枚一次性备用码。
        </p>
      </div>

      {error ? (
        <div className="vq-banner vq-banner--error" role="alert">
          <Lock size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      <form
        className="vq-login-form"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(code)
        }}
        noValidate
      >
        <div className="vq-field">
          <label className="vq-field-label" htmlFor="vq-totp">
            验证码 <em className="vq-mono">code</em>
          </label>
          <span className="vq-input">
            <ShieldCheck size={15} />
            <input
              id="vq-totp"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="6 位数字，或 XXXXX-XXXXX 备用码"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={busy}
            />
          </span>
          <span className="vq-field-hint">验证码每 30 秒变一次；备用码每枚只能用一次。</span>
        </div>

        <button className="vq-button vq-button--primary vq-button--lg" type="submit" disabled={busy}>
          {busy ? (
            <>
              <Loader2 size={15} className="vq-spin" />
              正在验证…
            </>
          ) : (
            <>
              验证并进入
              <ArrowRight size={15} />
            </>
          )}
        </button>
        <button type="button" className="vq-link vq-login-back" onClick={onCancel} disabled={busy}>
          返回，换一个账号登录
        </button>
      </form>
    </>
  )
}

/** 找回密码第一步：填邮箱发链接。服务端对「有没有这个账号」回同一句话，这里照它显示。 */
function ForgotStep({
  email: initial,
  supportEmail,
  onBack,
}: {
  email: string
  supportEmail: string
  onBack: () => void
}) {
  const [email, setEmail] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const trimmed = email.trim()
    if (!trimmed) {
      setError('请输入邮箱')
      return
    }
    if (!EMAIL_PATTERN.test(trimmed)) {
      setError('邮箱格式看起来不太对')
      return
    }
    setError('')
    setBusy(true)
    try {
      const result = await forgotPassword(trimmed)
      setNote(result.message || '如果这个邮箱有账号，重置邮件已经发出。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有发出去，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="vq-login-form-head">
        <span className="vq-mono">Reset password</span>
        <h2>找回口令</h2>
        <p>填登录用的邮箱，我们会发一封带一次性链接的邮件，链接 30 分钟内有效。</p>
      </div>

      {note ? (
        <div className="vq-banner vq-banner--info" role="status">
          <ShieldCheck size={14} />
          <span>{note}</span>
        </div>
      ) : null}
      {error ? (
        <div className="vq-banner vq-banner--error" role="alert">
          <Lock size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      <form className="vq-login-form" onSubmit={submit} noValidate>
        <div className="vq-field">
          <label className="vq-field-label" htmlFor="vq-forgot-email">
            邮箱 <em className="vq-mono">email</em>
          </label>
          <span className={'vq-input' + (error ? ' is-invalid' : '')}>
            <Mail size={15} />
            <input
              id="vq-forgot-email"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoFocus
              placeholder={EXAMPLE_EMAIL}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                if (error) setError('')
              }}
              disabled={busy}
            />
          </span>
          <span className="vq-field-hint">
            {supportEmail ? '收不到就找管理员重置（' + supportEmail + '）。' : '收不到就找工作区管理员重置。'}
            平台不会向你索要当前口令。
          </span>
        </div>

        <button className="vq-button vq-button--primary vq-button--lg" type="submit" disabled={busy}>
          {busy ? (
            <>
              <Loader2 size={15} className="vq-spin" />
              正在发送…
            </>
          ) : (
            <>
              发送重置邮件
              <ArrowRight size={15} />
            </>
          )}
        </button>
        <button type="button" className="vq-link vq-login-back" onClick={onBack} disabled={busy}>
          返回登录
        </button>
      </form>
    </>
  )
}

