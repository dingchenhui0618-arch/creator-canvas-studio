// 全站唯一的头像渲染（r313）：有图显示圆图，没图显示首字母。
//
// 归属：服务端把头像存成 data/avatars/<userId>.jpg|png，/api/auth/me 里带 avatarUrl（没有就是空串）。
// 这里不做上传、不做裁剪——上传在设置页把图裁成 256 方图再发，服务端只负责校验与存盘。
import { useEffect, useState } from 'react'
import { initialsFor } from '../auth/session'

export type AvatarUser = { id: string; name: string; avatarUrl?: string }

export function UserAvatar({
  user,
  size = 28,
  className,
}: {
  user: AvatarUser
  size?: number
  className?: string
}) {
  const [broken, setBroken] = useState(false)
  const url = String(user.avatarUrl || '')

  // 换了头像地址就重新给一次机会：上一张 404 不该让新上传的图一直不显示
  useEffect(() => setBroken(false), [url])

  const initials = initialsFor(user.name || '')
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)) }

  if (url && !broken) {
    return (
      <img
        className={'vq-avatar' + (className ? ' ' + className : '')}
        src={url}
        alt=""
        width={size}
        height={size}
        style={style}
        onError={() => setBroken(true)}
        // 头像不是内容图：拖拽与选中都没意义
        draggable={false}
      />
    )
  }
  return (
    <span className={'vq-avatar vq-avatar--initials' + (className ? ' ' + className : '')} style={style} aria-hidden="true">
      {initials}
    </span>
  )
}
