// 右上角账号区（r313，照 Codex 的样子）：头像 + 名字 + 剩余积分，点开是账号菜单。
//
// 为什么放这里：用户报「积分余额要能一眼看到」，左下角那个入口太深。
// 左下角的账号菜单仍然保留（也可以从那儿点开），两处读同一份余额，不各算一遍。
import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronDown, Compass, LogOut, RefreshCw, Settings2, Wallet } from 'lucide-react'
import { UserAvatar } from './UserAvatar'
import { sessionKindLabel, type Session } from '../auth/session'
import { accountIdentifier } from '../domain/account-label'

export type TopCredits = { balance: number | null; unit: string; loading: boolean }

export function AccountMenu({
  session,
  credits,
  onOpenRecharge,
  onOpenSettings,
  onOpenHelp,
  onOpenGuide,
  onSwitchAccount,
  onSignOut,
}: {
  session: Session
  credits: TopCredits
  onOpenRecharge: () => void
  onOpenSettings: () => void
  onOpenHelp: () => void
  onOpenGuide: () => void
  onSwitchAccount: () => void
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const balanceText =
    credits.balance === null ? (credits.loading ? '余额读取中' : '余额未读到') : String(credits.balance) + ' ' + (credits.unit || '积分')

  const pick = (action: () => void) => () => {
    setOpen(false)
    action()
  }

  return (
    <div className="vq-topbar-account" ref={rootRef}>
      <button
        type="button"
        className="vq-topbar-account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={session.user.name + ' · ' + balanceText}
      >
        <UserAvatar user={session.user} size={26} />
        <span className="vq-topbar-account-name">{session.user.name}</span>
        <span className={'vq-credit-chip' + (credits.balance !== null && credits.balance <= 0 ? ' is-empty' : '')}>
          <Wallet size={13} aria-hidden="true" />
          {balanceText}
        </span>
        <ChevronDown size={14} aria-hidden="true" className="vq-topbar-account-caret" />
      </button>

      {open && (
        <div className="vq-menu vq-topbar-account-menu" role="menu">
          <div className="vq-topbar-account-head">
            <UserAvatar user={session.user} size={36} />
            <div className="vq-topbar-account-head-copy">
              <strong>{session.user.name}</strong>
              <span>{sessionKindLabel(session.user)}</span>
            </div>
          </div>

          <div className="vq-topbar-account-credits">
            <div>
              <span className="vq-topbar-account-credits-label">剩余积分</span>
              <strong>{credits.balance === null ? '—' : credits.balance}</strong>
            </div>
            <button type="button" className="vq-button vq-button--primary vq-button--sm" onClick={pick(onOpenRecharge)}>
              去充值
            </button>
          </div>

          <div className="vq-menu-sep" />
          <button type="button" role="menuitem" onClick={pick(onOpenGuide)}>
            <Compass size={15} />
            使用引导
          </button>
          <button type="button" role="menuitem" onClick={pick(onOpenSettings)}>
            <Settings2 size={15} />
            账号设置
          </button>
          <button type="button" role="menuitem" onClick={pick(onOpenHelp)}>
            <BookOpen size={15} />
            帮助与协议
          </button>
          <button type="button" role="menuitem" onClick={pick(onSwitchAccount)}>
            <RefreshCw size={15} />
            切换账号
          </button>
          <div className="vq-menu-sep" />
          <button type="button" role="menuitem" className="is-danger" onClick={pick(onSignOut)}>
            <LogOut size={15} />
            退出登录
          </button>
          <p className="vq-topbar-account-id" title={accountIdentifier(session.user)}>
            {accountIdentifier(session.user)}
          </p>
        </div>
      )}
    </div>
  )
}
