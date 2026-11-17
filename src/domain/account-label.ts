// 账号身份文案：同一个 kind 在界面上的称呼，以及「他是谁」该显示哪一串。
// 用户名账号（手机号登录）没有真邮箱，服务端给的是内部占位邮箱（@login.visionqa.local），
// 界面不能把这个占位串当成用户的邮箱露出来。
export type AccountKind = 'demo' | 'account' | 'guest' | 'admin'

const PLACEHOLDER_EMAIL_SUFFIX = '@login.visionqa.local'

/** 界面需要「这是谁、怎么登录」的最小字段集合：账号、会话、后台账号表共用一套。 */
export type AccountLike = { name?: string; email?: string; username?: string }

/**
 * 这个账号有没有能收信的邮箱。
 * 只填用户名（手机号）建的账号，服务端塞的是内部占位邮箱，忘记密码的信永远送不到——
 * 后台要在账号表上把这个差别说出来，而不是把占位串当邮箱显示。
 */
export function hasRealEmail(user: AccountLike): boolean {
  const email = String(user.email || '').trim().toLowerCase()
  if (!email) return false
  return !email.endsWith(PLACEHOLDER_EMAIL_SUFFIX)
}

/**
 * kind + 登录标识 → 界面上的身份文案。
 * - 管理员：管理员
 * - 用户名登录的普通账号：登录账号
 * - 邮箱登录的普通账号：工作邮箱
 */
export function accountKindLabel(kind: AccountKind, username?: string): string {
  if (kind === 'admin') return '管理员'
  if (kind === 'demo') return '账号'
  if (kind === 'guest') return '访客会话'
  return username && username.trim() ? '登录账号' : '工作邮箱'
}

/** 界面上显示的登录标识：优先用户名，其次真邮箱；占位邮箱一律换成姓名。 */
export function accountIdentifier(user: AccountLike): string {
  const username = String(user.username || '').trim()
  if (username) return username
  const email = String(user.email || '').trim()
  const name = String(user.name || '').trim()
  if (!email) return name || '账号'
  if (email.toLowerCase().endsWith(PLACEHOLDER_EMAIL_SUFFIX)) return name || '账号'
  return email
}