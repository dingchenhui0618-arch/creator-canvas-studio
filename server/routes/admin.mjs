// /api/admin/*：只有管理员能用。
// 目前两个动作是真的：列真实账号（含积分余额）、给某个账号发放/扣减积分。
// 充值通道没接，所以积分的唯一来源是这里 + 新账号初始额度。
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import { readBody, sendJson } from './_shared.mjs'
import { currentUser, isAdmin, listUsers, findUserById, findUserByEmail, createUser, updateUserAccess, setPassword, destroyOtherSessions, deleteUser, countAdmins } from '../auth.mjs'
import { grant, ledgerOf, balanceOf } from '../credits.mjs'
import { listRequests, resolveRequest } from '../credit-requests.mjs'
import { config, redfoxEnabled, visionEnabled } from '../config.mjs'
import { deepHealth } from '../health.mjs'
import { diagnosticsLogs, logEvent } from '../log.mjs'
import { listAudit, recordAudit } from '../audit.mjs'
import { removePreference } from '../preferences.mjs'
import { AGENT_TOOLS } from '../agents.mjs'
import { lastWebRead, readWebPage } from '../webread.mjs'
import { listKeys, createKey, updateKey, deleteKey, testKey, listRoutes, previewRoute, vaultModels, PROVIDER_PRESETS, CAPABILITIES } from '../keyvault.mjs'
import { gatewayStatus, modelCoverage } from '../gateway.mjs'
import { canvasAdminConfigured, listCanvasUsers, setCanvasUserAccess } from '../canvas-admin.mjs'
import { alertCounts, ackAlert, checkDisk, listAlerts, recordAlert } from '../alerts.mjs'
import { clearClientErrors, listClientErrors } from '../client-errors.mjs'
import { listLogs, pruneLogs } from '../log-files.mjs'
import { listReports, reportCounts, resolveReport } from '../reports.mjs'
import { disableTemplateShare, getTemplate, updateTemplate } from '../templates.mjs'

const MODEL_KEY = /^\/api\/admin\/model-keys\/([\w-]+)$/
const MODEL_KEY_TEST = /^\/api\/admin\/model-keys\/([\w-]+)\/test$/
const USER_CREDITS = /^\/api\/admin\/users\/([\w-]+)\/credits$/
const USER_PASSWORD = /^\/api\/admin\/users\/([\w-]+)\/password$/
const USER_ACCESS = /^\/api\/admin\/users\/([\w-]+)$/
const CANVAS_ACCESS = /^\/api\/admin\/canvas\/users\/(\d+)\/access$/

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

      if (pathname === '/api/admin/users' && req.method === 'POST') {
        const body = await readBody(req)
        const email = String(body.email || '').trim().toLowerCase()
        const name = String(body.name || '').trim().slice(0, 40)
        const kind = body.kind === 'admin' ? 'admin' : 'account'
        if (!email) return (sendJson(res, 400, { error: '请输入邮箱', field: 'email' }), true)
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return (sendJson(res, 400, { error: '邮箱格式不正确', field: 'email' }), true)
        if (findUserByEmail(email)) return (sendJson(res, 409, { error: '这个邮箱已经有账号了', field: 'email' }), true)
        let password = String(body.password || '').trim()
        if (password) {
          if (password.length < 8 || password.length > 200 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
            return (sendJson(res, 400, { error: '口令至少 8 位，且同时包含字母和数字', field: 'password' }), true)
          }
        } else {
          // 不填口令就生成一次性临时口令，同样只在这一次响应里返回
          password = 'Vq7' + crypto.randomBytes(7).toString('base64url')
        }
        let created
        try {
          created = createUser({ email, password, name, kind })
        } catch (error) {
          sendJson(res, 400, { error: '建号失败：' + String(error?.message || error) })
          return true
        }
        // 额外初始积分单独记一笔流水，账本上「欢迎额度」和「管理员发放」分得清
        const extra = Math.trunc(Number(body.credits) || 0)
        let balance = Number(created.credits || 0)
        if (extra > 0) {
          const result = grant(created.id, extra, { note: '建号时发放', operator: user.email })
          balance = result.balance
        } else if (extra < 0) {
          sendJson(res, 400, { error: '初始积分不能是负数', field: 'credits' })
          return true
        }
        const payload = {
          ok: true,
          password,
          balance,
          user: { id: created.id, email: created.email, name: created.name, kind: created.kind, active: Boolean(created.is_active), credits: balance },
        }
        logEvent('user-create', { by: user.email, email, kind, balance })
        recordAudit({ req, actor: user, action: 'user.create', targetType: 'user', targetId: created.id, targetLabel: created.email, detail: { kind, balance } })
        sendJson(res, 201, payload)
        return true
      }
      // ── 额度申请 ────────────────────────────────────────────────
      // 用户积分不够时提交的申请；管理员在这里发放或忽略，发放与账本记的是同一笔。
      if (pathname === '/api/admin/credit-requests' && req.method === 'GET') {
        const status = String(url.searchParams.get('status') || '')
        const items = listRequests({ status })
        sendJson(res, 200, { items, total: items.length, pending: listRequests({ status: 'pending' }).length })
        return true
      }

      const CREDIT_REQUEST = /^\/api\/admin\/credit-requests\/([\w-]+)$/
      const requestMatch = pathname.match(CREDIT_REQUEST)
      if (requestMatch && req.method === 'POST') {
        const list = listRequests({})
        const target = list.find((item) => item.id === requestMatch[1])
        if (!target) {
          sendJson(res, 404, { error: '申请不存在' })
          return true
        }
        if (target.status !== 'pending') {
          sendJson(res, 409, { error: '这条申请已经处理过了', request: target })
          return true
        }
        const body = await readBody(req)
        if (body.action === 'ignore') {
          const resolved = resolveRequest(target.id, { status: 'ignored', by: user.email })
          logEvent('credit-request-ignore', { by: user.email, request: target.id, user: target.email })
          sendJson(res, 200, { ok: true, request: resolved, balance: null })
          return true
        }
        const amount = Math.trunc(Number(body.amount) || target.amount)
        if (!Number.isFinite(amount) || amount === 0) {
          sendJson(res, 400, { error: '发放数量必须是非 0 整数' })
          return true
        }
        const account = findUserById(target.userId)
        if (!account) {
          sendJson(res, 404, { error: '申请对应的账号已被删除' })
          return true
        }
        const result = grant(account.id, amount, { note: '额度申请发放（' + target.id + '）', operator: user.email })
        const resolved = resolveRequest(target.id, { status: 'granted', by: user.email, grantedAmount: amount })
        logEvent('credit-request-grant', { by: user.email, to: account.email, amount, balance: result.balance })
        recordAudit({ req, actor: user, action: 'credits.grant', targetType: 'user', targetId: account.id, targetLabel: account.email, detail: { amount, note: '额度申请 ' + target.id, balance: result.balance } })
        sendJson(res, 200, { ok: true, request: resolved, balance: result.balance })
        return true
      }
      // ── 平台 Key 池 ────────────────────────────────────────────────
      // 管理员在后台随时增删改，下一次模型调用就生效（不需要重启进程）。
      // 列表只回脱敏值，明文 Key 永远不会离开服务端。
      if (pathname === '/api/admin/model-keys' && req.method === 'GET') {
        const data = listKeys()
        sendJson(res, 200, {
          ...data,
          providers: PROVIDER_PRESETS,
          fallback: {
            configured: visionEnabled(),
            model: config.vision.model,
            baseUrl: config.vision.baseUrl,
          },
        })
        return true
      }

      // 生成通道：画布的出图 / 出视频请求走这里。后台只回「开没开、几把 Key、跑着几个任务」，
      // 不回令牌明文与上游 Key —— 这两样东西任何人都不能从浏览器拿到。
      if (pathname === '/api/admin/gateway' && req.method === 'GET') {
        const status = gatewayStatus()
        const counts = listKeys().summary.counts
        const maskToken = (token) => (token ? String(token).slice(0, 4) + '••••' + String(token).slice(-4) : '')
        sendJson(res, 200, {
          ...status,
          userOpen: config.gateway.open,
          tokenMasked: maskToken(config.gateway.token),
          keys: { image: counts.image || 0, video: counts.video || 0 },
          models: { image: vaultModels('image'), video: vaultModels('video') },
          coverage: modelCoverage(),
        })
        return true
      }

      // 路由可观测：最近 200 次真实调用走了哪把 Key、为什么、多快、成没成；
      // 外加「现在调一次会走哪把」的预演 —— 改完 Key 不用等出问题才知道效果。
      if (pathname === '/api/admin/model-keys/routes' && req.method === 'GET') {
        const data = listRoutes(Number(url.searchParams.get('limit')) || 50)
        sendJson(res, 200, {
          ...data,
          fallback: { configured: visionEnabled(), model: config.vision.model, baseUrl: config.vision.baseUrl },
        })
        return true
      }

      if (pathname === '/api/admin/model-keys/preview' && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const capability = String(body?.capability || 'text')
          // 用 Key 池同一份能力清单，避免像 2026-11-11 那样：界面加了「判断（Jev）」选项，
          // 预演接口的白名单没跟上，选判断就 400。
          if (!CAPABILITIES.includes(capability)) {
            sendJson(res, 400, { error: '能力只能是 ' + CAPABILITIES.join(' / '), code: 'BAD_CAPABILITY' })
            return true
          }
          const preview = previewRoute({ capability, model: String(body?.model || '').slice(0, 80) })
          sendJson(res, 200, {
            ok: true,
            ...preview,
            fallback: { configured: visionEnabled(), model: config.vision.model },
          })
        } catch (error) {
          sendJson(res, 400, { error: error?.message || '预演失败' })
        }
        return true
      }

      if (pathname === '/api/admin/model-keys' && req.method === 'POST') {
        try {
          const key = createKey(await readBody(req))
          recordAudit({
            req,
            actor: user,
            action: 'model-key.create',
            targetType: 'model-key',
            targetId: key.id,
            targetLabel: key.name,
            detail: { provider: key.provider, capabilities: key.capabilities, models: key.models },
          })
          sendJson(res, 201, { ok: true, key })
        } catch (error) {
          sendJson(res, error?.status || 400, { error: error?.message || '创建 Key 失败', code: error?.code })
        }
        return true
      }

      const keyTest = pathname.match(MODEL_KEY_TEST)
      if (keyTest && req.method === 'POST') {
        try {
          const result = await testKey(keyTest[1])
          recordAudit({
            req,
            actor: user,
            action: 'model-key.test',
            targetType: 'model-key',
            targetId: keyTest[1],
            targetLabel: result?.key?.name || keyTest[1],
            detail: { ok: result.ok, mode: result.mode, status: result.status, ms: result.ms },
          })
          sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          sendJson(res, error?.status || 400, { error: error?.message || '连接测试失败', code: error?.code })
        }
        return true
      }

      const keyMatch = pathname.match(MODEL_KEY)
      if (keyMatch && req.method === 'PATCH') {
        try {
          const key = updateKey(keyMatch[1], await readBody(req))
          recordAudit({
            req,
            actor: user,
            action: 'model-key.update',
            targetType: 'model-key',
            targetId: key.id,
            targetLabel: key.name,
            detail: { enabled: key.enabled, capabilities: key.capabilities, priority: key.priority, weight: key.weight },
          })
          sendJson(res, 200, { ok: true, key })
        } catch (error) {
          sendJson(res, error?.status || 400, { error: error?.message || '更新 Key 失败', code: error?.code })
        }
        return true
      }

      if (keyMatch && req.method === 'DELETE') {
        try {
          const key = deleteKey(keyMatch[1])
          recordAudit({
            req,
            actor: user,
            action: 'model-key.delete',
            targetType: 'model-key',
            targetId: key.id,
            targetLabel: key.name,
            detail: { provider: key.provider },
          })
          sendJson(res, 200, { ok: true, id: key.id })
        } catch (error) {
          sendJson(res, error?.status || 400, { error: error?.message || '删除 Key 失败', code: error?.code })
        }
        return true
      }

      // ── 画布身份（跨系统）────────────────────────────────────────
      // 画布已并入 VisionQA 账号：这里列出从工作台进过画布的人，并允许停用/恢复。
      // 画布服务在自己的内网端口上，用互通密钥验证；画布没配好时如实说 unavailable。
      if (pathname === '/api/admin/canvas/users' && req.method === 'GET') {
        if (!canvasAdminConfigured()) {
          sendJson(res, 200, { available: false, reason: '画布账号互通未配置', items: [], total: 0 })
          return true
        }
        try {
          const items = await listCanvasUsers()
          const joined = items.map((item) => {
            const account = item.visionqaUserId ? findUserById(item.visionqaUserId) : null
            return {
              id: item.id,
              displayName: item.displayName,
              active: Boolean(item.active),
              lastLoginAt: item.lastLoginAt,
              createdAt: item.createdAt,
              visionqaUserId: item.visionqaUserId,
              account: account
                ? { id: account.id, email: account.email, name: account.name, active: Boolean(account.is_active) }
                : null,
            }
          })
          const activeCount = joined.filter((item) => item.active).length
          sendJson(res, 200, {
            available: true,
            items: joined,
            total: joined.length,
            summary: { active: activeCount, suspended: joined.length - activeCount, missing: joined.filter((item) => !item.account).length },
          })
        } catch (error) {
          sendJson(res, 200, { available: false, reason: error?.message || '画布服务暂时连不上', code: error?.code, items: [], total: 0 })
        }
        return true
      }

      const canvasAccess = pathname.match(CANVAS_ACCESS)
      if (canvasAccess && req.method === 'POST') {
        try {
          const body = await readBody(req)
          if (typeof body?.enabled !== 'boolean') {
            sendJson(res, 400, { error: 'enabled 必须是布尔值', code: 'BAD_REQUEST' })
            return true
          }
          const item = await setCanvasUserAccess(canvasAccess[1], body.enabled)
          recordAudit({
            req,
            actor: user,
            action: 'canvas.access',
            targetType: 'canvas-user',
            targetId: String(item?.id || canvasAccess[1]),
            targetLabel: item?.displayName || '画布身份 ' + canvasAccess[1],
            detail: { enabled: Boolean(item?.active), visionqaUserId: item?.visionqaUserId },
          })
          sendJson(res, 200, { ok: true, item: { id: item?.id, active: Boolean(item?.active), displayName: item?.displayName } })
        } catch (error) {
          sendJson(res, error?.status || 502, { error: error?.message || '画布身份状态修改失败', code: error?.code })
        }
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
        recordAudit({
          req,
          actor: user,
          action: 'user.access',
          targetType: 'user',
          targetId: target.id,
          targetLabel: target.email,
          detail: { active: Boolean(updated.is_active), kind: updated.kind },
        })
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

      // 删除账号：只删登录与积分；模板 / 画布 / 运行记录保留，避免误删别人引用过的内容
      if (accessMatch && req.method === 'DELETE') {
        const target = findUserById(accessMatch[1])
        if (!target) {
          sendJson(res, 404, { error: '账号不存在' })
          return true
        }
        if (target.id === user.id) {
          sendJson(res, 400, { error: '不能删除当前登录的管理员账号', code: 'SELF_DELETE' })
          return true
        }
        if (target.kind === 'admin' && countAdmins() <= 1) {
          sendJson(res, 400, { error: '这是最后一个管理员账号，不能删除', code: 'LAST_ADMIN' })
          return true
        }
        deleteUser(target.id)
        removePreference(target.id)
        logEvent('user-deleted', { by: user.email, to: target.email, kind: target.kind })
        recordAudit({
          req,
          actor: user,
          action: 'user.delete',
          targetType: 'user',
          targetId: target.id,
          targetLabel: target.email,
          detail: { kind: target.kind },
        })
        sendJson(res, 200, { ok: true, id: target.id, email: target.email })
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
          recordAudit({
            req,
            actor: user,
            action: 'credits.grant',
            targetType: 'user',
            targetId: target.id,
            targetLabel: target.email,
            detail: { amount, note: String(body.note || '').slice(0, 120), balance: result.balance },
          })
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
        const passwordMode = body.password ? 'custom' : 'temporary'
        setPassword(target.id, password)
        // 口令被管理员重置后，该账号所有旧会话立即失效
        const signedOut = destroyOtherSessions(target.id)
        logEvent('user-password-reset', { by: user.email, to: target.email, signedOut })
        recordAudit({
          req,
          actor: user,
          action: 'user.password',
          targetType: 'user',
          targetId: target.id,
          targetLabel: target.email,
          detail: { mode: passwordMode, signedOut },
        })
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

      if (pathname === '/api/admin/audit' && req.method === 'GET') {
        sendJson(
          res,
          200,
          listAudit({
            action: url.searchParams.get('action') || '',
            actorId: url.searchParams.get('actorId') || '',
            q: url.searchParams.get('q') || '',
            limit: url.searchParams.get('limit') || 50,
            offset: url.searchParams.get('offset') || 0,
          }),
        )
        return true
      }

      // 排障信息只在内部环境存在：生产环境连这个路径都不认，避免任何技术细节被带出去。
      // 返回内容只有「进程 / 配置是否就绪 / 最近请求与错误」，不含任何密钥明文。
      if (pathname === '/api/admin/diagnostics' && req.method === 'GET') {
        if (config.ui.mode !== 'internal') {
          sendJson(res, 404, { error: '接口不存在', code: 'NOT_FOUND' })
          return true
        }
        let pkg = { name: 'visionqa', version: '' }
        try {
          pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'))
        } catch {
          // 读不到 package.json 不影响排障，版本留空
        }
        const memory = process.memoryUsage()
        sendJson(res, 200, {
          ok: true,
          mode: config.ui.mode,
          generatedAt: new Date().toISOString(),
          package: { name: pkg.name, version: pkg.version },
          process: {
            pid: process.pid,
            node: process.version,
            platform: process.platform,
            startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            uptimeSec: Math.round(process.uptime()),
            memoryMb: {
              rss: Math.round(memory.rss / 1048576),
              heapUsed: Math.round(memory.heapUsed / 1048576),
              heapTotal: Math.round(memory.heapTotal / 1048576),
              external: Math.round(memory.external / 1048576),
            },
          },
          config: {
            dataDir: config.dataDir,
            uiMode: config.ui.mode,
            models: {
              chat: config.llm.model,
              chatFallbacks: config.llm.fallbacks,
              vision: config.vision.model,
              visionFallbacks: config.vision.fallbacks,
              visionModels: config.vision.models,
            },
            upstream: {
              visionBaseUrl: config.vision.baseUrl,
              visionKeyConfigured: visionEnabled(),
              searchKeyConfigured: redfoxEnabled(),
              remoteWorker: config.remote.enabled,
              remoteWorkerLabel: config.remote.label,
            },
            auth: { requireAuth: config.auth.requireAuth, registrationEnabled: config.auth.registrationEnabled },
            limits: { ...config.limits },
            webRead: { timeoutMs: config.webread.timeoutMs, maxBytes: config.webread.maxBytes, maxChars: config.webread.maxChars },
            credits: {
              prices: { ...config.credits.prices },
              concurrency: { ...config.credits.concurrency },
            },
          },
          tools: {
            list: AGENT_TOOLS.map((tool) => ({ id: tool.id, label: tool.label, state: tool.state })),
            webRead: { enabled: true, last: lastWebRead() },
          },
          logs: diagnosticsLogs({ access: 120, errors: 30 }),
        })
        return true
      }

      // 内部环境的工具自检：直接跑一次「网页读取」，不经过模型，用来区分
      // 「页面抓不到」和「模型答不上来」。生产环境同样 404。
      if (pathname === '/api/admin/tools/web-read' && req.method === 'POST') {
        if (config.ui.mode !== 'internal') {
          sendJson(res, 404, { error: '接口不存在', code: 'NOT_FOUND' })
          return true
        }
        const body = await readBody(req)
        const target = String(body.url || '').trim()
        if (!target) {
          sendJson(res, 400, { ok: false, code: 'WEB_READ_EMPTY', error: '请提供要读取的链接' })
          return true
        }
        try {
          const page = await readWebPage(target)
          sendJson(res, 200, {
            ok: true,
            url: page.url,
            title: page.title,
            chars: page.chars,
            bytes: page.bytes,
            truncated: page.truncated,
            contentType: page.contentType,
            elapsedMs: page.elapsedMs,
            excerpt: page.text.slice(0, 600),
          })
        } catch (error) {
          sendJson(res, error?.status || 400, {
            ok: false,
            code: error?.code || 'WEB_READ_FAILED',
            error: String(error?.message || '页面读取失败'),
          })
        }
        return true
      }

      // 告警：5xx / 模型上游失败 / 磁盘不足 三类。没有外部通道也能在后台看，
      // 配了 VQ_ALERT_WEBHOOK 的会在记告警时同步往外推一条。
      if (pathname === '/api/admin/alerts' && req.method === 'GET') {
        const status = url.searchParams.get('status') === 'all' ? 'all' : 'open'
        const items = await listAlerts({ status, limit: Number(url.searchParams.get('limit')) || 50 })
        const counts = await alertCounts()
        const disk = await checkDisk()
        sendJson(res, 200, {
          items,
          counts,
          disk,
          channel: { webhook: Boolean(config.alerts.webhook), diskFreeMb: config.alerts.diskFreeMb },
        })
        return true
      }

      // 举报处理：队列、计数，以及「驳回 / 下架」两个动作
      if (pathname === '/api/admin/reports' && req.method === 'GET') {
        const status = String(url.searchParams.get('status') || 'open')
        const info = await listReports({ status, limit: Number(url.searchParams.get('limit')) || 50 })
        sendJson(res, 200, { ...info, counts: await reportCounts() })
        return true
      }

      const reportResolve = pathname.match(/^\/api\/admin\/reports\/([\w-]+)\/resolve$/)
      if (reportResolve && req.method === 'POST') {
        const body = await readBody(req)
        const action = body.action === 'takedown' ? 'takedown' : 'dismiss'
        const list = await listReports({ status: 'all', limit: 200 })
        const target = list.items.find((item) => item.id === reportResolve[1])
        if (!target) return (sendJson(res, 404, { error: '没有这条举报' }), true)
        let takedown = null
        if (action === 'takedown' && target.target.kind === 'template') {
          const template = await getTemplate(target.target.id, user)
          if (template) {
            // 下架 = 从公共模板里收回 + 停掉分享链接；不物理删除（证据要留着）
            await updateTemplate(template.id, { shared: false }, user)
            await disableTemplateShare(template.id, user)
            takedown = { templateId: template.id, title: template.title }
          }
        }
        const report = await resolveReport(reportResolve[1], {
          action,
          note: String(body.note || ''),
          by: user.email,
        })
        recordAudit({
          req,
          actor: user,
          action: 'report.resolve',
          targetType: 'report',
          targetId: reportResolve[1],
          targetLabel: target.target.title || target.target.id,
          detail: { action, takedown, note: String(body.note || '').slice(0, 200) },
        })
        sendJson(res, 200, { ok: true, report, takedown })
        return true
      }

      // 服务端日志：按天轮转的文件、保留天数与总量上限；清理动作也记审计
      if (pathname === '/api/admin/logs' && req.method === 'GET') {
        sendJson(res, 200, await listLogs({ limit: Number(url.searchParams.get('limit')) || 60 }))
        return true
      }

      if (pathname === '/api/admin/logs/prune' && req.method === 'POST') {
        const result = await pruneLogs()
        recordAudit({ req, actor: user, action: 'logs.prune', targetType: 'logs', targetId: 'all', detail: { removed: result.removed.length } })
        sendJson(res, 200, { ok: true, ...result })
        return true
      }

      // 前端异常：浏览器上报的脚本错误 / 未处理 Promise / 渲染抛错，按页面聚合
      if (pathname === '/api/admin/client-errors' && req.method === 'GET') {
        const info = await listClientErrors({ limit: Number(url.searchParams.get('limit')) || 50 })
        sendJson(res, 200, info)
        return true
      }

      if (pathname === '/api/admin/client-errors/clear' && req.method === 'POST') {
        const removed = await clearClientErrors()
        recordAudit({ req, actor: user, action: 'client-errors.clear', targetType: 'client-errors', targetId: 'all', detail: { removed } })
        sendJson(res, 200, { ok: true, removed })
        return true
      }

      if (pathname === '/api/admin/alerts/test' && req.method === 'POST') {
        const alert = await recordAlert({
          kind: 'test',
          level: 'warn',
          title: '测试告警：后台链路正常',
          detail: '由 ' + user.email + ' 手动触发，用来确认告警队列与外推通道是通的',
        })
        sendJson(res, 201, { ok: true, alert })
        return true
      }

      const alertAck = pathname.match(/^\/api\/admin\/alerts\/([\w-]+)\/ack$/)
      if (alertAck && req.method === 'POST') {
        const done = await ackAlert(alertAck[1], user.email)
        if (!done) return (sendJson(res, 404, { error: '没有这条告警' }), true)
        sendJson(res, 200, { ok: true, alert: done, counts: await alertCounts() })
        return true
      }

      sendJson(res, 404, { error: '未知的管理接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}