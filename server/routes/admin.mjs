// /api/admin/*：只有管理员能用。
// 目前两个动作是真的：列真实账号（含积分余额）、给某个账号发放/扣减积分。
// 充值通道没接，所以积分的唯一来源是这里 + 新账号初始额度。
import { readBody, sendJson } from './_shared.mjs'
import { currentUser, isAdmin, listUsers, findUserById, updateUserAccess } from '../auth.mjs'
import { grant, ledgerOf, balanceOf } from '../credits.mjs'
import { deepHealth } from '../health.mjs'
import { logEvent } from '../log.mjs'

const USER_CREDITS = /^\/api\/admin\/users\/([\w-]+)\/credits$/
const USER_ACCESS = /^\/api\/admin\/users\/([\w-]+)$/

function forbid(res) {
  sendJson(res, 403, { error: '只有管理员可以访问管理接口', code: 'NOT_ADMIN' })
}

export function createAdminRouter() {
  return {
    prefix: '/api/admin',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/admin')) return false
      const user = currentUser(req)
      if (!user) {
        sendJson(res, 401, { error: '未登录', loginRequired: true })
        return true
      }
      if (!isAdmin(user)) {
        forbid(res)
        return true
      }

      if (pathname === '/api/admin/users' && req.method === 'GET') {
        const items = listUsers()
        sendJson(res, 200, { items, total: items.length })
        return true
      }

      const accessMatch = pathname.match(USER_ACCESS)
      if (accessMatch && req.method === 'PATCH') {
        const target = findUserById(accessMatch[1])
        if (!target) {
          sendJson(res, 404, { error: '账号不存在' })
          return true
        }
        const body = await readBody(req)
        const patch = {}
        if (body.active !== undefined) patch.active = Boolean(body.active)
        if (body.kind !== undefined) {
          if (body.kind !== 'admin' && body.kind !== 'account') {
            sendJson(res, 400, { error: '角色只能是 admin 或 account', code: 'BAD_ROLE' })
            return true
          }
          patch.kind = body.kind
        }
        // 不允许把自己停用或降级：那会把最后一个管理员锁在门外
        if (target.id === user.id && (patch.active === false || patch.kind === 'account')) {
          sendJson(res, 400, { error: '不能停用或降级当前登录的管理员账号', code: 'SELF_LOCKOUT' })
          return true
        }
        const updated = updateUserAccess(target.id, patch)
        logEvent('user-access', { by: user.email, to: target.email, active: updated.is_active, kind: updated.kind })
        sendJson(res, 200, {
          ok: true,
          user: {
            id: updated.id,
            email: updated.email,
            name: updated.name,
            kind: updated.kind,
            active: Boolean(updated.is_active),
            credits: Number(updated.credits || 0),
          },
        })
        return true
      }

      const creditsMatch = pathname.match(USER_CREDITS)
      if (creditsMatch && req.method === 'POST') {
        const target = findUserById(creditsMatch[1])
        if (!target) {
          sendJson(res, 404, { error: '账号不存在' })
          return true
        }
        const body = await readBody(req)
        const amount = Math.trunc(Number(body.amount))
        if (!Number.isFinite(amount) || amount === 0) {
          sendJson(res, 400, { error: '发放数量必须是非 0 整数（负数表示扣减）' })
          return true
        }
        try {
          const result = grant(target.id, amount, { note: String(body.note || '').slice(0, 120), operator: user.email })
          logEvent('credit-grant', { by: user.email, to: target.email, amount, balance: result.balance })
          sendJson(res, 200, {
            ok: true,
            userId: target.id,
            balance: result.balance,
            ledger: ledgerOf(target.id, 10),
          })
        } catch (error) {
          sendJson(res, 400, { error: String(error?.message || error) })
        }
        return true
      }

      if (pathname === '/api/admin/health' && req.method === 'GET') {
        sendJson(res, 200, await deepHealth({ force: url.searchParams.get('force') === '1' }))
        return true
      }

      if (pathname === '/api/admin/credits/me' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, balance: balanceOf(user.id) })
        return true
      }

      sendJson(res, 404, { error: '未知的管理接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}
