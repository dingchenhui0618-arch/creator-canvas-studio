// 多用户归属：数据归「建它的人」。
// 单管理员部署时看不出差别；一旦开放第二个账号，模板 / 智能体 / 画布 / 运行记录必须按账号隔离，
// 否则 A 能删掉 B 的模板、读到 B 的提示词，甚至用 B 的积分跑任务。
// 规则：
//   - 未登录（本地演示、VQ_REQUIRE_AUTH=0）：不做隔离，全部可见（离线开发不受影响）
//   - 管理员：可见全部（运营排查用）
//   - 普通账号：只看得见 ownerId === 自己的条目；没有 ownerId 的历史数据视为公共（启动时会被迁移认领）
import { config } from './config.mjs'

export function isAdmin(user) {
  if (!user) return false
  if (user.kind === 'admin') return true
  return config.auth.adminEmails.includes(String(user.email || '').toLowerCase())
}

export function canAccess(item, user) {
  if (!user) return true
  if (isAdmin(user)) return true
  if (!item || !item.ownerId) return true
  return item.ownerId === user.id
}

// 新建条目时带上归属；没有登录态就留空（=公共数据）
export function ownerStamp(user) {
  return user?.id ? { ownerId: user.id } : {}
}

export function forbidden(res, sendJson, what = '这条数据') {
  sendJson(res, 403, { error: '无权访问' + what + '：它属于另一个账号', code: 'NOT_OWNER' })
}
