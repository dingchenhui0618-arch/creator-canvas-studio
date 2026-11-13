// 一条作品的花费明细（v0.9.66）：作品页先给合计，点「明细」才读这一份。
//
// 口径与 v0.9.65 的合计完全同源：评审读每条评审自己记下的成本，画布运行按这条作品名下
// 所有版本的画布归集。退过款的那次运行照样列出来、但标「已退回」且不算进合计——
// 否则「合计 16」和列出来的几笔对不上，人会先怀疑数字错了，而不是想起那次失败退了钱。
//
// 不摊过来的仍然是检索 / 复刻 / 智能体对话：账本里没有作品，硬摊等于编数。
import { config } from './config.mjs'
import { reviewSpendItems } from './reviews.mjs'
import { listRunsByFlows } from './flows.mjs'

// 明细一次最多给多少笔：再多也只是历史，页面按时间倒序排，不靠这一屏做统计
const MAX_ITEMS = 120

function monthOf(at) {
  const value = String(at || '')
  return /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : ''
}

/**
 * 把若干笔折成「按版本」与总计。
 * 运行次数含退过款的那次（那一次确实跑过），积分只算没退的；退款单独记一份，
 * 页面因此既能说「跑过 6 次、花了 6 积分」，也能说「其中 1 次失败，2 积分已退回」。
 */
function fold(items) {
  const versions = new Map()
  const totals = {
    total: 0,
    reviews: { count: 0, credits: 0 },
    runs: { count: 0, credits: 0 },
    refunded: { count: 0, credits: 0 },
    lastAt: '',
  }
  for (const item of items) {
    if (String(item.at) > totals.lastAt) totals.lastAt = String(item.at)
    let bucket = versions.get(item.version)
    if (!bucket) {
      bucket = { version: item.version, reviews: { count: 0, credits: 0 }, runs: { count: 0, credits: 0 }, total: 0, lastAt: '' }
      versions.set(item.version, bucket)
    }
    if (String(item.at) > bucket.lastAt) bucket.lastAt = String(item.at)
    if (item.kind === 'review') {
      totals.reviews.count += 1
      totals.reviews.credits += item.credits
      bucket.reviews.count += 1
      bucket.reviews.credits += item.credits
    } else {
      totals.runs.count += 1
      bucket.runs.count += 1
      if (item.refunded) {
        totals.refunded.count += 1
        totals.refunded.credits += item.credits
        continue
      }
      totals.runs.credits += item.credits
      bucket.runs.credits += item.credits
    }
    totals.total += item.credits
    bucket.total += item.credits
  }
  return { ...totals, byVersion: [...versions.values()].sort((a, b) => b.version - a.version) }
}

// 按 UTC 自然月分桶（与每月额度的月份口径一致）：退款的那笔不进任何月份的花费
function foldMonths(items) {
  const months = new Map()
  for (const item of items) {
    if (item.refunded) continue
    const month = monthOf(item.at)
    if (!month) continue
    let bucket = months.get(month)
    if (!bucket) {
      bucket = { month, total: 0, reviews: 0, runs: 0, count: 0 }
      months.set(month, bucket)
    }
    bucket.total += item.credits
    bucket.count += 1
    if (item.kind === 'review') bucket.reviews += item.credits
    else bucket.runs += item.credits
  }
  return [...months.values()].sort((a, b) => (a.month < b.month ? 1 : -1))
}

/**
 * 一条作品的花费明细。
 * month 给 YYYY-MM 就只看那一个月（页面的「本月」），不给就是累计。
 * byMonth 一律按全部记录算：月份切换上要显示每个月各多少，不能跟着范围缩水。
 */
export async function projectSpendDetail(project, user = null, { month = '' } = {}) {
  const flows = [project.flowId, ...(project.versions || []).map((entry) => entry.flowId)].filter(Boolean)
  const versionOfFlow = new Map()
  for (const entry of project.versions || []) {
    if (entry.flowId) versionOfFlow.set(entry.flowId, Number(entry.n) || 0)
  }
  if (project.flowId) versionOfFlow.set(project.flowId, Number(project.version) || 1)

  const [reviewRows, runData] = await Promise.all([
    reviewSpendItems(project.id, user),
    flows.length ? listRunsByFlows(flows, { all: true }, user) : Promise.resolve({ items: [] }),
  ])

  const items = []
  for (const review of reviewRows) {
    items.push({
      kind: 'review',
      id: review.id,
      at: review.at,
      version: review.version,
      credits: review.credits,
      refunded: false,
      verdict: review.verdict,
      note: review.note,
    })
  }
  for (const run of runData.items) {
    const cost = Math.max(0, Number(run.credits?.cost) || 0)
    // 没扣过积分的运行（画布直连、或者只是探活）照样列：它是一次运行，
    // 次数要与作品页「画布运行 N 次」对得上；金额写 0，页面标「未扣积分」。
    items.push({
      kind: 'run',
      id: run.id,
      at: String(run.startedAt || ''),
      version: versionOfFlow.get(run.flowId) || 0,
      credits: cost,
      charged: Boolean(run.credits) && cost > 0,
      refunded: Boolean(run.credits?.refunded),
      status: run.status || '',
      note: run.flowName || '',
    })
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)))

  const scope = /^\d{4}-\d{2}$/.test(String(month || '')) ? String(month) : ''
  const scoped = scope ? items.filter((item) => monthOf(item.at) === scope) : items
  const folded = fold(scoped)
  return {
    ok: true,
    unit: config.credits.unit,
    scope: scope || 'all',
    // 今天是哪个月由服务端说：页面拿它标「本月」，不按浏览器时钟猜
    month: new Date().toISOString().slice(0, 7),
    total: folded.total,
    reviews: folded.reviews,
    runs: folded.runs,
    refunded: folded.refunded,
    lastAt: folded.lastAt,
    byVersion: folded.byVersion,
    byMonth: foldMonths(items),
    count: scoped.length,
    shown: Math.min(scoped.length, MAX_ITEMS),
    items: scoped.slice(0, MAX_ITEMS),
  }
}
