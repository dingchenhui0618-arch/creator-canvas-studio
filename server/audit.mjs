// 管理员操作审计：谁、什么时候、对哪个对象做了什么。
// 以前管理动作只在 journald 里留一行 JSON，查一次要 SSH 翻日志；这里把管理动作落进同一个 SQLite，
// 后台可按动作与关键词筛选。只记管理员动作——普通用户的检索/评审/对话已经在积分流水与运行记录里。
import crypto from 'node:crypto'
import { clientIp, openDb } from './auth.mjs'
import { logEvent } from './log.mjs'

// 动作白名单：界面上的筛选项与行内标签都从这里来，不在前端另写一份中文
const ACTIONS = {
  'user.access': '账号权限',
  'user.delete': '删除账号',
  'user.password': '重置口令',
  'credits.grant': '发放积分',
  'client-errors.clear': '清空前端异常',
  'logs.prune': '清理服务端日志',
  'report.resolve': '处理举报',
  'plan.save': '定价档位',
  'plan.delete': '删除档位',
  'quota.save': '每月额度',
}

let schemaReady = false

function db() {
  const database = openDb()
  if (!schemaReady) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS admin_audit (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        actor_id TEXT,
        actor_email TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        target_label TEXT,
        detail TEXT,
        ip TEXT,
        trace_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit(action, at DESC);
    `)
    schemaReady = true
  }
  return database
}

export function auditActions() {
  return Object.entries(ACTIONS).map(([value, label]) => ({ value, label }))
}

function actionLabel(value) {
  return ACTIONS[value] || value
}

function safeDetail(value) {
  if (!value) return null
  try {
    const text = JSON.stringify(value)
    return text.length > 2000 ? text.slice(0, 2000) : text
  } catch {
    return null
  }
}

// 审计写失败绝不能把管理动作本身带崩：记一条日志，继续返回成功
export function recordAudit({ req, actor, action, targetType = '', targetId = '', targetLabel = '', detail = null }) {
  try {
    const id = 'au_' + crypto.randomBytes(8).toString('base64url')
    const at = new Date().toISOString()
    db()
      .prepare(
        'INSERT INTO admin_audit (id, at, actor_id, actor_email, action, target_type, target_id, target_label, detail, ip, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        at,
        actor?.id ? String(actor.id) : '',
        actor?.email ? String(actor.email) : '',
        String(action),
        String(targetType || '').slice(0, 40),
        String(targetId || '').slice(0, 120),
        String(targetLabel || '').slice(0, 200),
        safeDetail(detail),
        req ? String(clientIp(req) || '').slice(0, 80) : '',
        req?.vqTraceId ? String(req.vqTraceId) : '',
      )
    logEvent('admin-audit', { action, by: actor?.email || '', target: targetLabel })
    return { id, at }
  } catch (error) {
    logEvent('admin-audit-error', { action, message: String(error?.message || error).slice(0, 500) })
    return null
  }
}

function parseDetail(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// 分页与筛选都在服务端做：审计表只会越来越大，不能整表发给浏览器
export function listAudit({ action = '', actorId = '', q = '', limit = 50, offset = 0 } = {}) {
  const where = []
  const params = []
  if (action) {
    where.push('action = ?')
    params.push(String(action))
  }
  if (actorId) {
    where.push('actor_id = ?')
    params.push(String(actorId))
  }
  if (q) {
    where.push('(actor_email LIKE ? OR target_label LIKE ? OR detail LIKE ?)')
    const like = '%' + String(q) + '%'
    params.push(like, like, like)
  }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : ''
  const database = db()
  const total = Number(database.prepare('SELECT COUNT(*) AS n FROM admin_audit' + clause).get(...params)?.n || 0)
  const rows = database
    .prepare('SELECT * FROM admin_audit' + clause + ' ORDER BY at DESC, id DESC LIMIT ? OFFSET ?')
    .all(...params, Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0))

  return {
    items: rows.map((row) => ({
      id: row.id,
      at: row.at,
      actorId: row.actor_id || '',
      actorEmail: row.actor_email || '',
      action: row.action,
      actionLabel: actionLabel(row.action),
      targetType: row.target_type || '',
      targetId: row.target_id || '',
      targetLabel: row.target_label || '',
      detail: parseDetail(row.detail),
      ip: row.ip || '',
      traceId: row.trace_id || '',
    })),
    total,
    limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
    offset: Math.max(Number(offset) || 0, 0),
    actions: auditActions(),
  }
}
