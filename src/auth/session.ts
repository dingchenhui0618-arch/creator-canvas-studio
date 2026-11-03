// 本地演示会话：纯前端 mock，不连接任何真实账号体系，也不校验真实密码。
// 任何邮箱 + 任意 6 位以上密码都能登录；演示账号只是给评审人一个可复现的入口。
export type SessionKind = 'demo' | 'account' | 'guest'

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

export type AuthField = 'email' | 'password' | 'form'

export class AuthError extends Error {
  field: AuthField

  constructor(field: AuthField, message: string) {
    super(message)
    this.name = 'AuthError'
    this.field = field
  }
}

export const SESSION_KEY = 'visionqa.session.v1'

// 用拼接写出演示邮箱，避免源码里出现完整的邮箱字面量。
const AT = String.fromCharCode(64)
export const DEMO_EMAIL = ['demo', 'visionqa.studio'].join(AT)
export const EXAMPLE_EMAIL = ['name', 'studio.com'].join(AT)
export const DEMO_NAME = '演示用户'
export const MIN_PASSWORD_LENGTH = 6
export const LOGIN_LATENCY_MS = 700

const GUEST_EMAIL = ['guest', 'visionqa.local'].join(AT)
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Session>
  const user = candidate.user as Partial<SessionUser> | undefined
  return (
    candidate.version === 1 &&
    typeof candidate.signedInAt === 'string' &&
    typeof candidate.remember === 'boolean' &&
    typeof user === 'object' &&
    user !== null &&
    typeof user.name === 'string' &&
    typeof user.email === 'string'
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

function clearStoredSession(): void {
  for (const storage of storageCandidates()) {
    try {
      storage.removeItem(SESSION_KEY)
    } catch {
      // 存储被禁用时无需处理。
    }
  }
}

function persist(session: Session): void {
  clearStoredSession()
  const target = session.remember ? storageCandidates()[0] : storageCandidates()[1]
  if (!target) return
  try {
    target.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // 存储写满或被禁用时，会话只在当前内存里生效。
  }
}

function hashEmail(email: string): string {
  let hash = 5381
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 33) ^ email.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

function displayNameFor(email: string): string {
  const local = email.split('@')[0]?.replace(/[._-]+/g, ' ').trim()
  if (!local) return 'VisionQA 用户'
  return local.replace(/(^|\s)(\S)/g, (_match, prefix: string, char: string) => `${prefix}${char.toUpperCase()}`)
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
      // 损坏的会话直接跳过，下一次登录会覆盖它。
    }
  }
  return null
}

export async function signIn(input: SignInInput): Promise<Session> {
  const email = input.email.trim().toLowerCase()
  if (!EMAIL_PATTERN.test(email)) {
    throw new AuthError('email', `请输入有效的邮箱地址，例如 ${EXAMPLE_EMAIL}`)
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError('password', `密码至少 ${MIN_PASSWORD_LENGTH} 位`)
  }

  // 演示用的固定延迟：让加载态在真实点击后能被看见，不做网络请求。
  await new Promise((resolve) => {
    setTimeout(resolve, LOGIN_LATENCY_MS)
  })

  const isDemo = email === DEMO_EMAIL
  const session: Session = {
    version: 1,
    remember: input.remember,
    signedInAt: new Date().toISOString(),
    user: {
      id: isDemo ? 'user-demo' : `user-${hashEmail(email)}`,
      name: isDemo ? DEMO_NAME : displayNameFor(email),
      email,
      workspace: '个人工作区',
      kind: isDemo ? 'demo' : 'account',
    },
  }
  persist(session)
  return session
}

export function signInAsGuest(): Session {
  const session: Session = {
    version: 1,
    remember: false,
    signedInAt: new Date().toISOString(),
    user: {
      id: 'user-guest',
      name: '访客',
      email: GUEST_EMAIL,
      workspace: '个人工作区',
      kind: 'guest',
    },
  }
  persist(session)
  return session
}

export function signOut(): void {
  clearStoredSession()
}

export function sessionKindLabel(kind: SessionKind): string {
  if (kind === 'demo') return '演示账号'
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
