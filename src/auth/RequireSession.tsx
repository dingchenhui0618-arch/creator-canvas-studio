import type { ReactNode } from 'react'
import type { RegisterInput, Session, SignInInput } from './session'
import { LoginPage } from '../pages/LoginPage'
import '../styles/shell.css'

type Props = {
  session: Session | null
  /** 首屏还在用 /api/auth/me 校验缓存会话；true 时先给骨架，避免已登录的人闪一下登录页。 */
  loading?: boolean
  notice?: string
  onSignIn: (input: SignInInput) => Promise<Session>
  /** 全屏登录页的注册入口；不传时登录页回退成「注册 + 登录」两次请求。 */
  onRegister?: (input: RegisterInput) => Promise<Session>
  onGuest: () => void
  children: (session: Session) => ReactNode
}

/** 校验缓存会话的那一两百毫秒里显示的占位，跟登录页同一套墨色，不做动画噪声。 */
function BootScreen() {
  return (
    <div className="vq-boot" role="status" aria-live="polite">
      <span className="vq-boot-mark">VisionQA</span>
      <span className="vq-boot-text">正在恢复上次的登录…</span>
    </div>
  )
}

/** 受保护渲染：没有会话就只给全屏登录页，登录后把会话交给工作台外壳。 */
export function RequireSession({ session, loading = false, notice, onSignIn, onRegister, onGuest, children }: Props) {
  if (!session) {
    if (loading) return <BootScreen />
    return <LoginPage notice={notice} onSignIn={onSignIn} onRegister={onRegister} onGuest={onGuest} />
  }
  return <>{children(session)}</>
}
