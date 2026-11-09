// 账号体系 API 客户端：与 server/routes/auth.mjs 的契约一一对应。
// 会话凭证是 HttpOnly cookie，由浏览器自动携带；前端不读取、不保存 token。
import { request as apiRequest } from './client'

export type AuthUserKind = 'account' | 'demo' | 'guest'

export type AuthUser = {
  id: string
  email: string
  name: string
  workspace: string
  kind: AuthUserKind
}

/** 后端 4xx 里指向前端字段的标记；没有 field 时归到表单级错误。 */
export type AuthErrorField = 'email' | 'password' | 'name' | 'form'

export type LoginPayload = { email: string; password: string; remember: boolean }

export type RegisterPayload = { email: string; password: string; name?: string }

export type AuthConfig = {
  registrationEnabled: boolean
  /** 注册密码最小长度由后端下发（login 不校验长度，老密码不受影响）。 */
  minPasswordLength: number
}

type AuthErrorBody = { error?: string; field?: unknown }

export type AuthRequestError = Error & { status?: number; field: AuthErrorField; body?: AuthErrorBody }

const AUTH_ERROR_FIELDS: readonly AuthErrorField[] = ['email', 'password', 'name', 'form']

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

/** 登录页需要的公开配置：是否开放注册、口令长度下限。不下发任何账号或口令。 */
export function getAuthConfig(signal?: AbortSignal): Promise<AuthConfig> {
  return request<AuthConfig>('/api/auth/config', { signal })
}

export async function login(payload: LoginPayload): Promise<AuthUser> {
  const body = await request<{ user: AuthUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return body.user
}

export async function register(payload: RegisterPayload): Promise<AuthUser> {
  const body = await request<{ user: AuthUser }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return body.user
}

/** 204 No Content：成功与否都只需要清本地缓存，所以不解析响应体。 */
export async function logout(): Promise<void> {
  await request<null>('/api/auth/logout', { method: 'POST' })
}

/** 服务端校验当前 cookie 会话；401 时 client 会抛带 status 的 Error。 */
export async function me(signal?: AbortSignal): Promise<AuthUser> {
  const body = await request<{ user: AuthUser }>('/api/auth/me', { signal })
  return body.user
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
