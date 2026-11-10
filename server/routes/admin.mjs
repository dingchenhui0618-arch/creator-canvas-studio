// /api/admin/*：只有管理员能用。
// 目前两个动作是真的：列真实账号（含积分余额）、给某个账号发放/扣减积分。
// 充值通道没接，所以积分的唯一来源是这里 + 新账号初始额度。
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import { readBody, sendJson } from './_shared.mjs'
import { currentUser, isAdmin, listUsers, findUserById, updateUserAccess, setPassword, destroyOtherSessions } from '../auth.mjs'
import { grant, ledgerOf, balanceOf } from '../credits.mjs'
import { config } from '../config.mjs'
import { deepHealth } from '../health.mjs'
import { logEvent } from '../log.mjs'

const USER_CREDITS = /^\/api\/admin\/users\/([\w-]+)\/credits$/
const USER_PASSWORD = /^\/api\/admin\/users\/([\w-]+)\/password$/
const USER_ACCESS = /^\/api\/admin\/users\/([\w-]+)$/

function forbid(res) {
  sendJson(res, 403, { error: '只有管理员可以访问管理接口', code: 'NOT_ADMIN' })
}

// 数据目录占用：后台「系统」页要显示真实数字，而不是写「接口没返回」。
// 只统计数据目录本身，遍历失败的单条跳过（例如刚被删掉的临时文件），不让整页报错。
async function storageSummary() {
  const root = config.dataDir
  const items = []
  let totalBytes = 0
  let totalFiles = 0

  async function sizeOf(target) {
    let bytes = 0
    let files = 0
    const entries = await fs.readdir(target, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        const info = await fs.stat(path.join(entry.parentPath || target, entry.name))
        bytes += info.size
        files += 1
      } catch {
        // 统计期间被删掉的文件不计入
      }
    }
    return { bytes, files }
  }

  let top = []
  try {
    top = await fs.readdir(root, { withFileTypes: true })
  } catch {
    top = []
  }
  for (const entry of top) {
    try {
      if (entry.isFile()) {
        const info = await fs.stat(path.join(root, entry.name))
        items.push({ name: entry.name, bytes: info.size, files: 1 })
        totalBytes += info.size
        totalFiles += 1
      } else if (entry.isDirectory()) {
        const sum = await sizeOf(path.join(root, entry.name))
        items.push({ name: entry.name + '/', bytes: sum.bytes, files: sum.files })
        totalBytes += sum.bytes
        totalFiles += sum.files
      }
    } catch {
      // 单个条目统计失败不影响其它条目
    }
  }
  items.sort((a, b) => b.bytes - a.bytes)

  let disk = null
  try {
    const info = await fs.statfs(root)
    disk = { totalBytes: Number(info.blocks) * Number(info.bsize), freeBytes: Number(info.bavail) * Number(info.bsize) }
  } catch {
    disk = null
  }

  return { ok: true, dataDir: root, bytes: totalBytes, files: totalFiles, items, disk, checkedAt: new Date().toISOString() }
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

      const passwordMatch = pathname.match(USER_PASSWORD)
      if (passwordMatch && req.method === 'POST') {
        const target = findUserById(passwordMatch[1])
        if (!target) {
          sendJson(res, 404, { error: '账号不存在' })
          return true
        }
        if (target.id === user.id) {
          sendJson(res, 400, { error: '自己的口令请到「设置 → 修改口令」里改', code: 'SELF_RESET' })
          return true
        }
        const body = await readBody(req)
        let password = String(body.password || '').trim()
        if (password) {
          if (password.length < 8 || password.length > 200 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
            sendJson(res, 400, { error: '新口令至少 8 位，且同时包含字母和数字', code: 'WEAK_PASSWORD' })
            return true
          }
        } else {
          // 临时口令：固定带大写字母与数字，满足口令策略；只在这一次响应里返回
          password = 'Vq7' + crypto.randomBytes(7).toString('base64url')
        }
        setPassword(target.id, password)
        // 口令被管理员重置后，该账号所有旧会话立即失效
        const signedOut = destroyOtherSessions(target.id)
        logEvent('user-password-reset', { by: user.email, to: target.email, signedOut })
        sendJson(res, 200, {
          ok: true,
          password,
          signedOut,
          user: { id: target.id, email: target.email, name: target.name, kind: target.kind, active: Boolean(target.is_active) },
        })
        return true
      }

      if (pathname === '/api/admin/storage' && req.method === 'GET') {
        sendJson(res, 200, await storageSummary())
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
