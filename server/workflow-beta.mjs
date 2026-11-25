// 工作流 beta 闸门（r313）：工作流从公开功能收成 beta，只给管理员用。
//
// 为什么单独一个模块：/api/flows 与 /api/runs 共用一个 router、/api/canvas 是同一个能力的
// 外延、/api/auth/me 的 features 又要回答「这台机器上这个账号能不能用工作流」——
// 同一件事写在四处迟早对不上。开关、判定与对外说法只放这一处。
//
// 默认关闭（fail-closed）：只有显式写 VQ_WORKFLOW_BETA=all（或 1）才对全部账号打开，
// 内部实例排障用。没配就是「只有管理员」，不会因为某个开关漏配变成全员可用。
import { isAdmin } from './auth.mjs'

// 对外说法只有一句：403 的 error、前端 beta 页的说明用的是同一句话（见 src/domain/features.ts）。
export const WORKFLOW_BETA_ERROR = '工作流还是 beta，现在只对管理员开放'

/** 内部实例排障：显式 VQ_WORKFLOW_BETA=all / 1 时对全部账号打开；默认关闭。 */
export function workflowBetaOpen() {
  const value = String(process.env.VQ_WORKFLOW_BETA || '').trim().toLowerCase()
  return value === 'all' || value === '1'
}

/**
 * 这个账号现在能不能用工作流。
 *
 * 管理员判定复用后台那一套（isAdmin：库里 kind='admin'，或 VQ_ADMIN_EMAILS 点名的邮箱）——
 * 否则邮箱授权的管理员能进后台发积分，却在自己的工作流页被 beta 门挡住。
 * 未登录一律 false：beta 视角下匿名连「能不能用」都不该答成 true。
 */
export function workflowBetaAllowed(user) {
  if (workflowBetaOpen()) return true
  return Boolean(user) && isAdmin(user)
}

/** 403 载荷：ok / error / code 都给，前端不必从 error 文案里猜是哪一种拒绝。 */
export function workflowBetaRefusal() {
  return { ok: false, error: WORKFLOW_BETA_ERROR, code: 'WORKFLOW_BETA' }
}

/**
 * 统一的 403 出口：路由在「读盘 / 排队 / 扣费 / 调上游」之前调它，返回 true 表示这单已处理完。
 * 自己写响应头而不是 import routes/_shared：这一层是核心判定，不该反过来依赖路由层。
 */
export function denyWorkflowBeta(res) {
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(workflowBetaRefusal()))
  return true
}
