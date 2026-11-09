import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clearStoredSession,
  persistSession,
  readSession,
  register as requestRegister,
  signIn as requestSignIn,
  signOut as requestSignOut,
  type RegisterInput,
  type Session,
  type SignInInput,
} from './session'
import { isLoginRequired, me as fetchMe } from '../api/auth'

export type SessionController = {
  session: Session | null
  /** 首屏是否还在用 /api/auth/me 校验缓存会话；true 时宿主可以渲染骨架而不是登录页。 */
  loading: boolean
  signIn: (input: SignInInput) => Promise<Session>
  register: (input: RegisterInput) => Promise<Session>
  signOut: () => void
}

type SessionState = { session: Session | null; loading: boolean }

/**
 * 唯一会话状态源。
 * 初始 state 直接读本地缓存，已有会话的首屏立刻进工作台（不闪登录页）；
 * 挂载后拿 /api/auth/me 校验一次缓存：401 才清缓存踢回登录页，网络失败保留缓存。
 */
export function useSession(): SessionController {
  const [state, setState] = useState<SessionState>(() => {
    const cached = readSession()
    return { session: cached, loading: Boolean(cached && cached.user.kind !== 'guest') }
  })
  // 用户主动登录 / 注册 / 退出 / 访客进入都会推进 epoch，用来丢弃迟到的 /me 响应。
  const epoch = useRef(0)

  useEffect(() => {
    const cached = readSession()
    // 访客是纯本地会话，没有后端 cookie 可校验。
    if (!cached || cached.user.kind === 'guest') return

    const controller = new AbortController()
    const startedAt = epoch.current
    let active = true

    const verify = async () => {
      try {
        const user = await fetchMe(controller.signal)
        if (!active || epoch.current !== startedAt) return
        const next: Session = { ...cached, user }
        persistSession(next)
        setState({ session: next, loading: false })
      } catch (error) {
        if (!active || epoch.current !== startedAt) return
        // 401 / { loginRequired: true }：cookie 会话已经失效，清缓存并回到登录页。
        if (isLoginRequired(error)) {
          clearStoredSession()
          setState({ session: null, loading: false })
          return
        }
        // 后端没起来或断网时不清缓存：宁可沿用首屏的用户信息，也不逼用户重新登录。
        setState((prev) => ({ ...prev, loading: false }))
      }
    }
    void verify()

    return () => {
      active = false
      controller.abort()
    }
  }, [])

  // 其它页面调用受保护接口收到 401 { loginRequired: true } 时，由 src/api/client.ts 派发这个事件；
  // 会话状态只有这里一份，所以统一在这里清空，避免各页面各写一套「踢回登录页」。
  useEffect(() => {
    const onAuthRequired = () => {
      epoch.current += 1
      clearStoredSession()
      setState({ session: null, loading: false })
    }
    window.addEventListener('vq:auth-required', onAuthRequired)
    return () => window.removeEventListener('vq:auth-required', onAuthRequired)
  }, [])

  const signIn = useCallback(async (input: SignInInput) => {
    const next = await requestSignIn(input)
    epoch.current += 1
    setState({ session: next, loading: false })
    return next
  }, [])

  const register = useCallback(async (input: RegisterInput) => {
    const next = await requestRegister(input)
    epoch.current += 1
    setState({ session: next, loading: false })
    return next
  }, [])

  const signOut = useCallback(() => {
    // 宿主只关心「立刻回到登录页」，后端清 cookie 与清缓存放到异步里完成。
    epoch.current += 1
    setState({ session: null, loading: false })
    void requestSignOut()
  }, [])

  return { session: state.session, loading: state.loading, signIn, register, signOut }
}
