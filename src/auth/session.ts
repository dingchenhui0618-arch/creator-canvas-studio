// 账号会话：真实请求走后端 /api/auth/*，凭据是服务端下发的 HttpOnly cookie。
// 前端既不保存密码也不保存 token；本地只缓存 user（加 signedInAt / remember 这类非机密元数据）
// 供首屏渲染，任何「当前是谁」的判断都以 /api/auth/me 为准。
import {
  login as requestLogin,
  loginTotp as requestLoginTotp,
  logout as requestLogout,
  register as requestRegister,
} from '../api/auth'

// admin 是服务端 users.kind='admin'：能看全部数据、发放积分。界面只用来显示角色与放开管理台入口。
export type SessionKind = 'demo' | 'account' | 'guest' | 'admin'

export type SessionUser = {
  id: string
  name: string
  email: string
  workspace: string
  kind: SessionKind
}

export type Session = {
  version: 1
  user: SessionUser
  remember: boolean
  signedInAt: string
}

export type SignInInput = {
  email: string
  password: string
  remember: boolean
}

export type RegisterInput = {
  email: string
  password: string
  name?: string
  acceptedTerms: boolean
  termsVersion: string
}

export type AuthField = 'email' | 'password' | 'name' | 'terms' | 'code' | 'form'

/**
 * 口令通过、但账号开了两步验证：此时还没有会话，只拿到一个 5 分钟有效的 challenge。
 * 登录页捕获它切成第二步，而不是当成登录失败。
 */
export class TwoFactorRequired extends Error {
  challenge: string

  constructor(challenge: string) {
    super('这个账号开启了两步验证')
    this.name = 'TwoFactorRequired'
    this.challenge = challenge
  }
}

export class AuthError extends Error {
  field: AuthField

  constructor(field: AuthField, message: string) {
    super(message)
    this.name = 'AuthError'
    this.field = field
  }
}

export const SESSION_KEY = 'visionqa.session.v1'

// 输入框占位用的示例地址；不是任何真实账号。
const AT = String.fromCharCode(64)
export const EXAMPLE_EMAIL = ['name', 'studio.com'].join(AT)
// 后端只在注册时校验密码长度，且真值由 GET /api/auth/config 下发；这里只是接口不可用时的兜底。
export const DEFAULT_MIN_PASSWORD_LENGTH = 8
export const NAME_MAX_LENGTH = 40

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SESSION_KINDS: readonly SessionKind[] = ['account', 'demo', 'guest', 'admin']

function isSessionUser(value: unknown): value is SessionUser {
  if (typeof value !== 'object' || value === null) return false
  const user = value as Partial<SessionUser>
  return (
    typeof user.id === 'string' &&
    typeof user.name === 'string' &&
    typeof user.email === 'string' &&
    typeof user.workspace === 'string' &&
    SESSION_KINDS.includes(user.kind as SessionKind)
  )
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Session>
  return (
    candidate.version === 1 &&
    typeof candidate.signedInAt === 'string' &&
    typeof candidate.remember === 'boolean' &&
    isSessionUser(candidate.user)
  )
}

function storageCandidates(): Storage[] {
  if (typeof window === 'undefined') return []
  const storages: Storage[] = []
  try {
    storages.push(window.localStorage)
  } catch {
    // 隐私模式下 localStorage 可能不可用，忽略即可。
  }
  try {
    storages.push(window.sessionStorage)
  } catch {
    // 同上。
  }
  return storages
}

/** 清掉本地用户缓存（不涉及后端会话）。 */
export function clearStoredSession(): void {
  for (const storage of storageCandidates()) {
    try {
      storage.removeItem(SESSION_KEY)
    } catch {
      // 存储被禁用时无需处理。
    }
  }
}

/**
 * 写入本地用户缓存：勾了「记住我」放 localStorage，否则只放当前标签页的 sessionStorage。
 * 这里存的是 user 档案，不是凭据；cookie 由服务端管理，前端读不到。
 */
export function persistSession(session: Session): void {
  clearStoredSession()
  const [persistent, tabOnly] = storageCandidates()
  const target = session.remember ? persistent : tabOnly
  if (!target) return
  try {
    target.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // 存储写满或被禁用时，会话只在当前内存里生效。
  }
}

export function readSession(): Session | null {
  for (const storage of storageCandidates()) {
    try {
      const raw = storage.getItem(SESSION_KEY)
      if (!raw) continue
      const parsed: unknown = JSON.parse(raw)
      if (isSession(parsed)) return parsed
      storage.removeItem(SESSION_KEY)
    } catch {
      // 损坏的缓存直接跳过，下一次登录会覆盖它。
    }
  }
  return null
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function assertEmail(email: string): void {
  if (!EMAIL_PATTERN.test(email)) {
    throw new AuthError('email', `请输入有效的邮箱地址，例如 ${EXAMPLE_EMAIL}`)
  }
}

// 只挡空密码：长度规则归后端（登录不校验长度，老密码不受影响）。
function assertPasswordPresent(password: string): void {
  if (!password) {
    throw new AuthError('password', '请输入密码')
  }
}

function assertName(name: string): void {
  if (name.length > NAME_MAX_LENGTH) {
    throw new AuthError('name', `昵称最多 ${NAME_MAX_LENGTH} 字`)
  }
}

/** 后端错误 → 页面可直接展示的 AuthError：401/429 归到表单级，400/409 保留字段。 */
function toAuthError(caught: unknown, fallback: string): AuthError {
  if (caught instanceof AuthError) return caught
  if (!(caught instanceof Error)) return new AuthError('form', fallback)

  const status = (caught as { status?: number }).status
  const field = (caught as { field?: AuthField }).field
  const message = caught.message || fallback

  // 没有 status 说明请求根本没发出去（后端没起来 / 断网），提示要指向环境而不是密码。
  if (typeof status !== 'number') {
    return new AuthError('form', '连不上账号服务，请确认后端已启动后重试。')
  }
  if (status === 401) return new AuthError('form', message || '邮箱或密码不正确。')
  if (status === 429) return new AuthError('form', message || '尝试次数过多，请稍后再试。')
  if (status >= 500) return new AuthError('form', fallback)
  return new AuthError(field ?? 'form', message)
}

function createSession(user: SessionUser, remember: boolean): Session {
  return {
    version: 1,
    user,
    remember,
    signedInAt: new Date().toISOString(),
  }
}

/** 登录：先做本地格式校验，再交给后端；成功会后端已下发 cookie，这里只缓存 user。 */
export async function signIn(input: SignInInput): Promise<Session> {
  const email = normalizeEmail(input.email)
  assertEmail(email)
  assertPasswordPresent(input.password)

  try {
    const result = await requestLogin({ email, password: input.password, remember: input.remember })
    if ('twoFactorRequired' in result) throw new TwoFactorRequired(result.challenge)
    const session = createSession(result.user, input.remember)
    persistSession(session)
    return session
  } catch (error) {
    if (error instanceof TwoFactorRequired) throw error
    throw toAuthError(error, '登录没有完成，请稍后重试。')
  }
}

/** 两步验证第二步：6 位数字或备用码换会话。remember 决定本地缓存放哪，cookie 时长由服务端按 challenge 里的值给。 */
export async function verifyTwoFactor(challenge: string, code: string, remember: boolean): Promise<Session> {
  const trimmed = code.trim()
  if (!trimmed) throw new AuthError('code', '请输入验证码')
  try {
    const result = await requestLoginTotp(challenge, trimmed)
    const session = createSession(result.user, remember)
    persistSession(session)
    return session
  } catch (error) {
    throw toAuthError(error, '验证没有完成，请稍后重试。')
  }
}

/** 注册：后端 201 同时下发会话 cookie，注册完即为登录态，不再补一次 login。 */
export async function register(input: RegisterInput): Promise<Session> {
  const email = normalizeEmail(input.email)
  assertEmail(email)
  assertPasswordPresent(input.password)

  // 昵称可以留空：后端会用邮箱前缀补一个显示名。
  const name = input.name?.trim() ?? ''
  assertName(name)
  try {
    const user = await requestRegister({
      email,
      password: input.password,
      name: name || undefined,
      acceptedTerms: input.acceptedTerms,
      termsVersion: input.termsVersion,
    })
    const session = createSession(user, true)
    persistSession(session)
    return session
  } catch (error) {
    throw toAuthError(error, '注册没有完成，请稍后重试。')
  }
}

/** 退出：先让后端清 cookie，再清本地缓存；后端不可达时也要清干净本地。 */
export async function signOut(): Promise<void> {
  try {
    await requestLogout()
  } catch {
    // 退出失败不能把用户留在本地的「已登录」假象里。
  } finally {
    clearStoredSession()
  }
}

export function sessionKindLabel(kind: SessionKind): string {
  if (kind === 'admin') return '管理员'
  if (kind === 'demo') return '账号'
  if (kind === 'guest') return '访客会话'
  return '工作邮箱'
}

export function initialsFor(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'V'
  if (/[\u4e00-\u9fff]/.test(trimmed)) return trimmed.slice(0, 1)
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}
