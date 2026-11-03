import type { ReactNode } from 'react'
import type { Session, SignInInput } from './session'
import { LoginPage } from '../pages/LoginPage'

type Props = {
  session: Session | null
  notice?: string
  onSignIn: (input: SignInInput) => Promise<Session>
  onGuest: () => void
  children: (session: Session) => ReactNode
}

/** 受保护渲染：没有会话就只给全屏登录页，登录后把会话交给工作台外壳。 */
export function RequireSession({ session, notice, onSignIn, onGuest, children }: Props) {
  if (!session) return <LoginPage notice={notice} onSignIn={onSignIn} onGuest={onGuest} />
  return <>{children(session)}</>
}
