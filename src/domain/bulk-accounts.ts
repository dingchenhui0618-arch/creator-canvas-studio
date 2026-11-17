// 批量建号：后台一次粘贴多行，逐行建账号。
// 为什么放在 domain 而不是组件里：解析规则（用户名/邮箱、口令强度、去重、上限）要么和
// 服务端一致，要么就该在测试里钉死；组件只负责把结果贴出来。
//
// 行的形状：「用户名或邮箱  口令  姓名」，分隔符是空格 / Tab / 逗号（中英文均可），
// 姓名可省、可以带空格（取剩余部分）。以 # 开头的行与空行直接跳过，方便把需求原话贴上。

export interface BulkAccountRow {
  /** 原始行号（从 1 开始），结果表按它对回去 */
  line: number
  /** 只给用户名（手机号）时为空串 */
  email: string
  username: string
  password: string
  name: string
}

export interface BulkAccountProblem {
  line: number
  text: string
  reason: string
}

export interface BulkAccountParseResult {
  rows: BulkAccountRow[]
  problems: BulkAccountProblem[]
}

/** 一次最多建多少个：粘贴错一行不至于开出几十个账号，要更多就分两批。 */
export const BULK_ACCOUNT_LIMIT = 20

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function splitFields(line: string): string[] {
  return line.split(/[\s,，、]+/).filter(Boolean)
}

/**
 * 解析一段粘贴文本。规则与服务端 POST /api/admin/users 对齐：
 *   用户名 4-32 位且不含空格与 @；邮箱要像邮箱；口令 8-200 位且同时有字母和数字。
 * 不合法的行不静默丢弃——逐条回 problems，界面才说得清哪一行为什么没建。
 */
export function parseBulkAccounts(text: string): BulkAccountParseResult {
  const rows: BulkAccountRow[] = []
  const problems: BulkAccountProblem[] = []
  const seen = new Set<string>()
  const lines = String(text || '').split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim()
    const line = index + 1
    if (!raw || raw.startsWith('#')) continue
    if (rows.length >= BULK_ACCOUNT_LIMIT) {
      problems.push({ line, text: raw, reason: '一次最多建 ' + BULK_ACCOUNT_LIMIT + ' 个账号，后面这些没处理' })
      break
    }

    const fields = splitFields(raw)
    if (fields.length < 2) {
      problems.push({ line, text: raw, reason: '每行至少要有「用户名或邮箱」和「口令」' })
      continue
    }

    const account = fields[0].toLowerCase()
    const password = fields[1]
    const name = fields.slice(2).join(' ').trim().slice(0, 40)
    const isEmail = account.includes('@')

    if (isEmail && !EMAIL_PATTERN.test(account)) {
      problems.push({ line, text: raw, reason: '邮箱格式不正确' })
      continue
    }
    if (!isEmail && (account.length < 4 || account.length > 32)) {
      problems.push({ line, text: raw, reason: '用户名要 4-32 位' })
      continue
    }
    if (password.length < 8 || password.length > 200) {
      problems.push({ line, text: raw, reason: '口令要 8-200 位' })
      continue
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      problems.push({ line, text: raw, reason: '口令要同时包含字母和数字' })
      continue
    }
    if (seen.has(account)) {
      problems.push({ line, text: raw, reason: '这一行和前面重复了' })
      continue
    }
    seen.add(account)

    rows.push({ line, email: isEmail ? account : '', username: isEmail ? '' : account, password, name })
  }

  return { rows, problems }
}
