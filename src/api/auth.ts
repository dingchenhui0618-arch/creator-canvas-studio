// 账号体系 API 客户端：与 server/routes/auth.mjs 的契约一一对应。
// 会话凭证是 HttpOnly cookie，由浏览器自动携带；前端不读取、不保存 token。
import { request as apiRequest } from './client'

export type AuthUserKind = 'account' | 'demo' | 'guest' | 'admin'

/** 服务端下发的界面能力开关；目前只有工作流 beta。 */
export type SessionFeatures = { workflow?: boolean }

export type AuthMe = {
  user: AuthUser
  features: SessionFeatures
}

export type AuthUser = {
  id: string
  email: string
  /** 用户名（手机号）登录标识；邮箱账号为空串。界面显示身份用它，不用占位邮箱。 */
  username?: string
  name: string
  workspace: string
  kind: AuthUserKind
  /** 头像地址；没有头像时为空串 */
  avatarUrl?: string
  /** 是否开启了两步验证：只给状态，secret 与备用码永远不下发 */
  twoFactor?: boolean
}

/** 后端 4xx 里指向前端字段的标记；没有 field 时归到表单级错误。 */
export type AuthErrorField = 'email' | 'phone' | 'password' | 'name' | 'terms' | 'code' | 'form'

export type LoginPayload = { email: string; password: string; remember: boolean }

/** 口令通过但账号开了两步验证：先拿 challenge，再换会话 */
export type LoginResult =
  | { user: AuthUser }
  | { twoFactorRequired: true; challenge: string; expiresInSec: number }

export type TwoFactorStatus = {
  enabled: boolean
  enabledAt: string
  backupCodesLeft: number
  pending: boolean
}

export type TotpSetup = {
  secret: string
  otpauth: string
  backupCodes: string[]
}

export type RegisterPayload = {
  email: string
  password: string
  name?: string
  /** 注册必须带：真的勾选了，且同意的是当前这一版条款 */
  acceptedTerms: boolean
  termsVersion: string
  /** 邀请制：注册全局关闭时，凭这枚码开号（服务端只在这里收明文码） */
  inviteCode?: string
}

export type AuthConfig = {
  registrationEnabled: boolean
  /** 邀请制始终可用：即使全局注册关闭，持有效邀请码也能自助开号 */
  inviteRegistration?: boolean
  /** 注册密码最小长度由后端下发（login 不校验长度，老密码不受影响）。 */
  minPasswordLength: number
  /** 完整口令规则的一句话说明，直接显示在注册表单下面。 */
  passwordPolicy?: string
  /** 服务端配了邮件通道才为 true：登录页据此决定「忘记密码」是开工还是如实说找管理员。 */
  passwordReset?: boolean
  /** 短信验证码登录：只有后台配了短信通道，login 才为 true，登录页据此显示「验证码登录」 */
  sms?: SmsLoginConfig
}

export type SmsLoginConfig = {
  login: boolean
  provider: string
  providerLabel: string
  codeLength: number
  ttlMinutes: number
  cooldownSec: number
}

export type SmsCodeSent = {
  ok: boolean
  sent: boolean
  expiresAt: string | null
  ttlMinutes: number
  cooldownSec: number
  message: string
}

type AuthErrorBody = { error?: string; field?: unknown }

export type AuthRequestError = Error & { status?: number; field: AuthErrorField; body?: AuthErrorBody }

const AUTH_ERROR_FIELDS: readonly AuthErrorField[] = ['email', 'phone', 'password', 'name', 'terms', 'code', 'form']

function toField(value: unknown): AuthErrorField {
  return AUTH_ERROR_FIELDS.includes(value as AuthErrorField) ? (value as AuthErrorField) : 'form'
}

// 公共请求封装（src/api/client.ts）只抛带 status 的 Error；这里补上契约里的 field，
// 登录页据此把错误落到具体输入框，而不是一律堆在表单顶部。
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await apiRequest<T>(path, { credentials: 'same-origin', ...init })
  } catch (caught) {
    const error = caught as AuthRequestError
    error.field = toField(error.body?.field)
    throw error
  }
}

export type InviteState = {
  valid: boolean
  /** active / used / revoked / expired / missing / invalid */
  status?: string
  reason?: string
  credits?: number
  remaining?: number
  expiresAt?: string | null
}

/** 注册页验码：只回「能不能用、还剩几次、送多少积分」。410 是无效码的正常状态，不当异常抛。 */
export async function checkInvite(code: string): Promise<InviteState> {
  try {
    return await request<InviteState>('/api/auth/invite?code=' + encodeURIComponent(code))
  } catch (caught) {
    const error = caught as AuthRequestError
    const body = (error.body || {}) as unknown as { reason?: string; status?: string; credits?: number }
    if (error.status === 410) return { valid: false, status: body.status, reason: body.reason }
    throw error
  }
}

/** 登录页需要的公开配置：是否开放注册、口令长度下限。不下发任何账号或口令。 */
export function getAuthConfig(signal?: AbortSignal): Promise<AuthConfig> {
  return request<AuthConfig>('/api/auth/config', { signal })
}

export function login(payload: LoginPayload): Promise<LoginResult> {
  return request<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** 两步验证第二步：6 位 TOTP 或一枚备用码，成功后服务端下发会话 cookie。 */
export async function loginTotp(challenge: string, code: string): Promise<{ user: AuthUser; backupCodeUsed: boolean }> {
  return request<{ user: AuthUser; backupCodeUsed: boolean }>('/api/auth/login/totp', {
    method: 'POST',
    body: JSON.stringify({ challenge, code }),
  })
}

/** 短信验证码登录：请服务端发一条码。成功与否都不判断「这个号码有没有账号」。 */
export function sendSmsCode(phone: string): Promise<SmsCodeSent> {
  return request<SmsCodeSent>('/api/auth/sms/send', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  })
}

/** 短信验证码登录：用码换会话；开了两步验证的账号同样先拿 challenge。 */
export function loginWithSms(payload: { phone: string; code: string; remember: boolean }): Promise<LoginResult> {
  return request<LoginResult>('/api/auth/sms/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getTwoFactor(): Promise<TwoFactorStatus> {
  return request<TwoFactorStatus>('/api/auth/totp')
}

export function startTwoFactorSetup(): Promise<TotpSetup> {
  return request<TotpSetup>('/api/auth/totp/setup', { method: 'POST', body: JSON.stringify({}) })
}

export function enableTwoFactor(code: string): Promise<TwoFactorStatus & { ok: boolean }> {
  return request<TwoFactorStatus & { ok: boolean }>('/api/auth/totp/enable', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

export function disableTwoFactor(password: string, code: string): Promise<{ ok: boolean; enabled: boolean }> {
  return request<{ ok: boolean; enabled: boolean }>('/api/auth/totp/disable', {
    method: 'POST',
    body: JSON.stringify({ password, code }),
  })
}

export async function register(payload: RegisterPayload): Promise<AuthUser> {
  const body = await request<{ user: AuthUser }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return body.user
}

/** 找回密码：服务端对所有情况回同一句话，页面照它显示，不据此判断邮箱是否存在。 */
export async function forgotPassword(email: string): Promise<{ ok: boolean; message: string }> {
  return request<{ ok: boolean; message: string }>('/api/auth/password/forgot', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export type ResetState = {
  valid: boolean
  expiresAt: string | null
  reason: string
  message: string
}

/** 重置页打开时先探测：链接还能用吗（不消费 token）。 */
export function checkResetToken(token: string): Promise<ResetState> {
  return request<ResetState>('/api/auth/password/reset?token=' + encodeURIComponent(token))
}

/** 用邮件里的 token 换新口令；成功后这个账号的全部会话被注销。 */
export function resetPassword(token: string, password: string): Promise<{ ok: boolean; signedOut: number }> {
  return request<{ ok: boolean; signedOut: number }>('/api/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
}

/** 修改当前账号口令；成功后服务端会注销其它设备上的会话。 */
export function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; signedOut: number }> {
  return request<{ ok: boolean; signedOut: number }>('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

/** 204 No Content：成功与否都只需要清本地缓存，所以不解析响应体。 */
export async function logout(): Promise<void> {
  await request<null>('/api/auth/logout', { method: 'POST' })
}

/** 服务端校验当前 cookie 会话；401 时 client 会抛带 status 的 Error。 */
export async function me(signal?: AbortSignal): Promise<AuthMe> {
  const body = await request<{ user: AuthUser; features?: SessionFeatures }>('/api/auth/me', { signal })
  return { user: body.user, features: body.features ?? {} }
}

/**
 * 受保护接口在未登录时返回 401 { error, loginRequired: true }。
 * 任何 API 调用方都可以用它判断「该把用户踢回登录页」。
 */
export function isLoginRequired(caught: unknown): boolean {
  if (typeof caught !== 'object' || caught === null) return false
  const error = caught as { status?: number; body?: { loginRequired?: boolean } }
  return error.status === 401 || error.body?.loginRequired === true
}
