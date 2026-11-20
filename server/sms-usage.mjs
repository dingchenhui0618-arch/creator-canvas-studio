// 发码结果留档：后台要看的是「最近发过几次、有没有被服务商拒、为什么」。
// 为什么不在后台直接问阿里云：QuerySendDetails 必须给一个具体号码，而回执最长 72 小时才回；
// 这一份记的是「我们把码交给服务商时它怎么答的」——受理成功 / 拒收原因 / 耗时。
// 手机号只留掩码（138****0001）：明文不落盘，也不出现在接口响应里。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { maskPhone } from './sms-config.mjs'
import { writeFileAtomic } from './atomic-write.mjs'

/** 只留最近 50 条：这是给人看的「最近怎么样」，不是审计流水。 */
export const SMS_USAGE_CAP = 50

export const smsUsageFile = () => path.join(config.dataDir, 'sms-usage.json')

function text(value, max) {
  return String(value ?? '').slice(0, max)
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const at = text(raw.at, 40)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at)) return null
  const ms = Number(raw.ms)
  return {
    at,
    // 落盘也只有掩码：读的时候不再二次加工，坏数据也不会漏出明文
    phone: text(raw.phone, 11),
    ok: raw.ok === true,
    source: raw.source === 'test' ? 'test' : 'login',
    provider: text(raw.provider, 20),
    error: text(raw.error, 200),
    errorCode: text(raw.errorCode, 60),
    ms: Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : null,
    requestId: text(raw.requestId, 40),
  }
}

/** 读发码记录：文件坏了、没写过都当空数组，不让后台因为一份日志打不开。 */
export async function readSmsUsage() {
  try {
    const parsed = JSON.parse(await fsp.readFile(smsUsageFile(), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeEntry).filter(Boolean).slice(-SMS_USAGE_CAP)
  } catch {
    return []
  }
}

/**
 * 记一条发码结果。source：'login' 是登录页发的码，'test' 是后台「发一条测试短信」。
 * 写失败不抛：发码已经发生了，日志写不进去不该让用户以为码没发出去。
 */
export async function recordSmsUsage({ phone, ok, error = '', errorCode = '', ms = null, provider = '', requestId = '', source = 'login' } = {}) {
  const entry = normalizeEntry({
    at: new Date().toISOString(),
    phone: maskPhone(phone),
    ok: Boolean(ok),
    source,
    provider,
    error,
    errorCode,
    ms,
    requestId,
  })
  if (!entry) return null
  try {
    const list = await readSmsUsage()
    list.push(entry)
    const kept = list.slice(-SMS_USAGE_CAP)
    const file = smsUsageFile()
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await writeFileAtomic(file, JSON.stringify(kept, null, 2))
    return entry
  } catch {
    return null
  }
}

/** 后台看的那份：总数、成功 / 失败、最近一次，以及最近几条明细（新的在前）。 */
export function smsUsageViewFrom(list, { limit = 5 } = {}) {
  const items = Array.isArray(list) ? list.filter(Boolean) : []
  const okCount = items.filter((item) => item.ok).length
  const recent = items.slice(Math.max(0, items.length - Math.max(1, Math.min(20, Number(limit) || 5))))
  return {
    total: items.length,
    ok: okCount,
    failed: items.length - okCount,
    lastAt: items.length ? items[items.length - 1].at : '',
    lastOk: items.length ? items[items.length - 1].ok : null,
    items: recent.slice().reverse(),
  }
}

export async function smsUsageView(options = {}) {
  return smsUsageViewFrom(await readSmsUsage(), options)
}
