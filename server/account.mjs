import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { deleteTemplatesByOwner, listTemplates, listTrash } from './templates.mjs'
import { deleteFlow, listFlows, listRuns } from './flows.mjs'
import { deleteAgent, listAgents } from './agents.mjs'
import { deleteReviewsByOwner, listReviews } from './reviews.mjs'
import { preferenceOf, removePreference } from './preferences.mjs'
import { balanceOf, ledgerOf } from './credits.mjs'
import { countAdmins, deleteUser, findUserById } from './auth.mjs'

// 账号自助：把自己的数据打包带走（导出 JSON），或者注销账号（可选择连内容一起删）。
//
// 两条原则：
//   1. 导出只给「属于这个账号」的数据：共享示例模板、别人的画布不会混进来；
//   2. 任何口令哈希、TOTP secret、备用码、会话 token 都不进导出包，也不出现在日志里。

const PKG = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))

function accountRecord(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    workspace: row.workspace,
    kind: row.kind,
    credits: Number(row.credits || 0),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || '',
    terms: { version: row.terms_version || '', acceptedAt: row.terms_accepted_at || '' },
    twoFactor: { enabled: Boolean(row.totp_enabled_at), enabledAt: row.totp_enabled_at || '' },
  }
}

export async function exportAccount(user) {
  const row = findUserById(user.id)
  const templates = (await listTemplates({}, user)).filter((item) => (item.ownerId || '') === user.id)
  const trashed = (await listTrash(user)).filter((item) => (item.ownerId || '') === user.id)
  const flows = (await listFlows(user)).filter((item) => (item.ownerId || '') === user.id)
  const runs = (await listRuns({ limit: 1000 }, user)).items?.filter((item) => (item.ownerId || '') === user.id) || []
  const agents = (await listAgents({}, user)).filter((item) => (item.ownerId || '') === user.id)
  const reviews = (await listReviews({ limit: 50 }, user)).items.filter((item) => (item.ownerId || '') === user.id)
  const ledger = ledgerOf(user.id, 1000, 0)
  return {
    format: 'visionqa-account-export',
    formatVersion: 1,
    app: { name: 'VisionQA', version: PKG.version },
    exportedAt: new Date().toISOString(),
    account: accountRecord(row),
    credits: { balance: balanceOf(user.id), ledger: ledger.items || ledger },
    preference: preferenceOf(user.id) || null,
    templates,
    templateTrash: trashed,
    flows,
    runs,
    agents,
    reviews,
  }
}

export function exportFileName(user) {
  const stamp = new Date().toISOString().slice(0, 10)
  const safe = String(user.email || user.id).replace(/[^\w.@-]/g, '_').slice(0, 60)
  return 'visionqa-' + safe + '-' + stamp + '.json'
}

/**
 * 注销：先（可选）删掉名下内容，再删账号本身（登录、会话、积分流水）。
 * 返回 { ok, removed: {...} }，方便界面如实告诉他删了什么。
 */
export async function deleteOwnAccount(user, { deleteContent = true } = {}) {
  const row = findUserById(user.id)
  if (!row) return { ok: false, code: 'NOT_FOUND' }
  // 最后一个管理员注销会把后台锁死：必须先加一个管理员，或者让管理员来删
  if (row.kind === 'admin' && countAdmins() <= 1) return { ok: false, code: 'LAST_ADMIN' }

  const removed = { templates: 0, flows: 0, agents: 0, reviews: 0 }
  if (deleteContent) {
    removed.templates = await deleteTemplatesByOwner(user.id)
    for (const flow of (await listFlows(user)).filter((item) => (item.ownerId || '') === user.id)) {
      if (await deleteFlow(flow.id)) removed.flows += 1
    }
    for (const agent of (await listAgents({}, user)).filter((item) => (item.ownerId || '') === user.id)) {
      if (await deleteAgent(agent.id)) removed.agents += 1
    }
    removed.reviews = await deleteReviewsByOwner(user.id)
  }
  removePreference(user.id)
  const deleted = deleteUser(user.id)
  if (!deleted) return { ok: false, code: 'NOT_FOUND' }
  return { ok: true, removed, deleteContent }
}

export { config }
