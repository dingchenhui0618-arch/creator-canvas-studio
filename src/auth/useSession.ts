import { useCallback, useState } from 'react'
import {
  readSession,
  signIn as requestSignIn,
  signInAsGuest,
  signOut as requestSignOut,
  type Session,
  type SignInInput,
} from './session'

export type SessionController = {
  session: Session | null
  signIn: (input: SignInInput) => Promise<Session>
  continueAsGuest: () => void
  signOut: () => void
}

/** 唯一会话状态源：初始化时读回 localStorage / sessionStorage，登录与退出同步写回。 */
export function useSession(): SessionController {
  const [session, setSession] = useState<Session | null>(() => readSession())

  const signIn = useCallback(async (input: SignInInput) => {
    const next = await requestSignIn(input)
    setSession(next)
    return next
  }, [])

  const continueAsGuest = useCallback(() => {
    setSession(signInAsGuest())
  }, [])

  const signOut = useCallback(() => {
    requestSignOut()
    setSession(null)
  }, [])

  return { session, signIn, continueAsGuest, signOut }
}
