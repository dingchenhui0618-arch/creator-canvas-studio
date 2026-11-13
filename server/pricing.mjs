// 按次算账（v0.9.81）：把「扣多少积分」和「上游花多少钱」折进同一个单位（元），
// 回答定价时最该先答的那句话——一次检索 / 一次复刻 / 一次评审 / 一次画布运行，平台赚还是倒贴。
//
// 三个刻意的决定：
//   1) 汇率只有一个来源：管理员在「计费 → 档位」里定的「多少钱换多少积分」。
//      没有档位就不算钱，页面写「还没有定价档位」——不拿积分倍率冒充金额（那是 v0.9.58 定下的规矩）。
//   2) 成本不在本模块里估：仍然来自 usage_events × 管理员填的上游估算单价（usage-meter）。
//      分母只数「真有用量」的调用（live 且成功）；回填条目只有次数，算进分母会把一次成本摊薄成假的。
//      算不出来就写「未定价」并给出原因，绝不写 0.00 冒充「成本为零、毛利 100%」。
//   3) 不扣积分的通道（画布出图 / 出视频）也进表：它们有真实上游成本、没有对应收入。
//      这一行是平台现在最该看见的账，藏起来等于把补贴当利润。
//
// 一条边界：这里的「收入」是按档位汇率折算的理论值，不是真实收款（支付通道还没接）；
// 「成本」是估算单价折出来的，不是上游账单。两者都只是拿来定价的量级，不当财务凭证。
import { config } from './config.mjs'
import { listPlans } from './plans.mjs'
import { usagePrices, usageSummary } from './usage-meter.mjs'

const milli = (yuan) => Math.round((Number(yuan) || 0) * 1000)
const percent = (part, whole) => (Number(whole) > 0 ? Math.round((Number(part) / Number(whole)) * 1000) / 10 : null)

function money(milliYuan) {
  const value = Math.max(0, Number(milliYuan) || 0)
  const yuan = value / 1000
  if (!yuan) return '¥0.00'
  return '¥' + (yuan < 0.01 ? yuan.toFixed(4) : yuan.toFixed(2))
}

// 积分动作 → 用量口径。评审一次既有视觉模型调用、也有判断模型调用，两个都算进它的成本。
const BILLED = [
  { action: 'search', label: '检索', credit: 'search', kinds: ['search'] },
  { action: 'replicate', label: '一键复刻', credit: 'replicate', kinds: ['replicate'] },
  { action: 'review', label: '视觉评审', credit: 'review', kinds: ['vision', 'judge'] },
  { action: 'chat', label: '智能体对话', credit: 'chat', kinds: ['text'] },
  { action: 'flow_run', label: '画布运行', credit: 'flow_run', kinds: ['run'] },
]

// 不扣积分、但有真实上游成本的通道：画布出图按张、出视频按秒。
// 这两行的「一次成本」按单位算（一张 / 一秒），不是按请求：一次请求可能出 3 张，
// 按请求摊会把「一张多少钱」抹平成「一次请求多少钱」，定价时看错的正是这个数。
const UNBILLED = [
  { action: 'canvas_image', label: '画布出图', credit: '', kinds: ['image'], unit: '张' },
  { action: 'canvas_video', label: '画布出视频', credit: '', kinds: ['video'], unit: '秒' },
]

/** 一档换算成「每积分多少钱」：积分为 0 或价格为 0（赠送档）不参与折算。 */
export function rateOfPlan(plan) {
  const credits = Math.trunc(Number(plan && plan.credits) || 0)
  const priceCents = Math.trunc(Number(plan && plan.priceCents) || 0)
  if (credits <= 0 || priceCents <= 0) return null
  return priceCents / 100 / credits
}

/**
 * 汇率：手填 > 指定档位 > 最划算的一档（每积分最便宜）。
 * 默认取最便宜那档是故意的：收入按最低价估，毛利只会被低估，不会被虚报。
 */
export function creditRate({ plans = [], planId = '', rmbPerCredit = 0 } = {}) {
  const rows = []
  for (const plan of plans) {
    if (!plan || plan.enabled === false) continue
    const rate = rateOfPlan(plan)
    if (rate === null) continue
    rows.push({
      id: String(plan.id || ''),
      name: String(plan.name || ''),
      credits: Math.trunc(Number(plan.credits) || 0),
      priceCents: Math.trunc(Number(plan.priceCents) || 0),
      rmbPerCredit: rate,
    })
  }
  rows.sort((a, b) => a.rmbPerCredit - b.rmbPerCredit)
  const custom = Number(rmbPerCredit)
  if (Number.isFinite(custom) && custom > 0) {
    return { rmbPerCredit: custom, source: 'custom', planId: '', planName: '手填', rows }
  }
  const wanted = String(planId || '')
  if (wanted) {
    const hit = rows.find((item) => item.id === wanted)
    if (hit) return { rmbPerCredit: hit.rmbPerCredit, source: 'plan', planId: hit.id, planName: hit.name, rows }
  }
  if (rows.length) {
    const best = rows[0]
    return { rmbPerCredit: best.rmbPerCredit, source: 'plan', planId: best.id, planName: best.name, rows }
  }
  return { rmbPerCredit: 0, source: 'none', planId: '', planName: '', rows }
}

function kindMap(summary) {
  const map = new Map()
  for (const row of (summary && summary.byKind) || []) map.set(String(row.kind), row)
  return map
}

function sumKinds(map, kinds) {
  const out = { calls: 0, failedCalls: 0, measuredCalls: 0, costMilli: 0, units: 0 }
  for (const kind of kinds) {
    const row = map.get(kind)
    if (!row) continue
    out.calls += Number(row.calls) || 0
    out.failedCalls += Number(row.failedCalls) || 0
    out.measuredCalls += Number(row.measuredCalls) || 0
    out.costMilli += Number(row.estCostMilli) || 0
    out.units += Number(row.units) || 0
  }
  return out
}

/** 这一次的上游成本到底算不算得出来——算不出来要说清是哪一种算不出来。 */
function costState(agg) {
  if (agg.measuredCalls <= 0) {
    return {
      costKnown: false,
      costReason: agg.calls > 0 ? '只有历史回填记录，没有带用量的调用' : '窗口里没有这类调用',
    }
  }
  if (agg.costMilli <= 0) {
    return { costKnown: false, costReason: '这些调用没有可折算的用量（上游没回 token，或单价还没填）' }
  }
  return { costKnown: true, costReason: '' }
}

/**
 * 纯计算：给一份 usageSummary、档位与积分价，算出每个动作的「每次收入 / 一次成本 / 每次毛利」。
 * 不读盘、不联网、不看时间——测试直接喂数字。
 */
export function unitEconomics({ summary, plans = [], planId = '', rmbPerCredit = 0, creditPrices = {} } = {}) {
  const rate = creditRate({ plans, planId, rmbPerCredit })
  const billable = rate.source !== 'none'
  const map = kindMap(summary)
  const rows = []

  for (const spec of BILLED) {
    const agg = sumKinds(map, spec.kinds)
    const credits = Math.max(0, Math.round(Number(creditPrices[spec.credit]) || 0))
    const revenueMilli = billable ? milli(credits * rate.rmbPerCredit) : null
    const unitCostMilli = agg.measuredCalls > 0 ? Math.round(agg.costMilli / agg.measuredCalls) : null
    const cost = costState(agg)
    const marginMilli = billable && cost.costKnown ? revenueMilli - unitCostMilli : null
    rows.push({
      action: spec.action,
      label: spec.label,
      unit: '次',
      credits,
      billable: true,
      subsidized: false,
      revenueMilli,
      measured: agg.measuredCalls,
      calls: agg.calls,
      failedCalls: agg.failedCalls,
      units: agg.units,
      costMilli: agg.costMilli,
      unitCostMilli,
      costKnown: cost.costKnown,
      costReason: cost.costReason,
      marginMilli,
      marginPct: marginMilli === null ? null : percent(marginMilli, revenueMilli),
    })
  }

  for (const spec of UNBILLED) {
    const agg = sumKinds(map, spec.kinds)
    const perUnit = agg.units > 0 ? Math.round(agg.costMilli / agg.units) : null
    const unitCostMilli = perUnit !== null ? perUnit : agg.measuredCalls > 0 ? Math.round(agg.costMilli / agg.measuredCalls) : null
    const cost = costState(agg)
    rows.push({
      action: spec.action,
      label: spec.label,
      unit: spec.unit,
      credits: 0,
      billable: false,
      subsidized: true,
      // 一次成本按单位算（张 / 秒）：分母是 units，不是请求数
      perUnit: perUnit !== null,
      // 不收费就是 0：有汇率时写 0（不是 null），这样「倒贴 = −成本」在页面上算得出来
      revenueMilli: billable ? 0 : null,
      measured: agg.measuredCalls,
      calls: agg.calls,
      failedCalls: agg.failedCalls,
      units: agg.units,
      costMilli: agg.costMilli,
      unitCostMilli,
      costKnown: cost.costKnown,
      costReason: cost.costReason,
      marginMilli: billable && cost.costKnown ? -unitCostMilli : null,
      marginPct: null,
    })
  }

  let costMilli = 0
  let revenueMilli = 0
  let unbilledCostMilli = 0
  let measured = 0
  for (const row of rows) {
    costMilli += row.costMilli
    measured += row.measured
    if (row.revenueMilli !== null) revenueMilli += row.revenueMilli * row.measured
    if (row.subsidized) unbilledCostMilli += row.costMilli
  }

  const warnings = []
  if (!billable) {
    warnings.push('还没有定价档位，也没有手填汇率：先加一条档位（或填「每积分多少钱」），收入和毛利才算得出来。')
  }
  for (const row of rows) {
    if (row.calls > 0 && !row.costKnown) {
      warnings.push('「' + row.label + '」算不出一次成本：' + row.costReason + '。')
    }
  }
  for (const row of rows) {
    if (row.subsidized && row.costMilli > 0) {
      warnings.push('「' + row.label + '」不扣积分：本窗口约 ' + money(row.costMilli) + ' 的上游成本没有对应收入。')
    }
  }
  if (billable && measured === 0) {
    warnings.push('本窗口没有带用量的调用：窗口收入与成本都算不出来（表里的「折算收入」是按汇率折的每次收入）。')
  }
  warnings.push('金额是按管理员填的上游估算单价折算的，不是账单；收入是按档位汇率折算的理论值，不是真实收款。')

  return {
    rate,
    plans: rate.rows,
    rows,
    totals: {
      measured,
      costMilli,
      // 一次带用量的调用都没有时，窗口收入不是一个数（0 会读成「真的收了 0 元」）：回 null
      revenueMilli: billable && measured > 0 ? revenueMilli : null,
      marginMilli: billable && measured > 0 ? revenueMilli - costMilli : null,
      unbilledCostMilli,
    },
    warnings,
  }
}

/**
 * 后台用的完整结果：窗口内的真实用量 + 单价 + 档位。
 * 只读：不扣积分、不调上游、不动任何数据。
 */
export function pricingEstimate({ days = 30, planId = '', rmbPerCredit = 0 } = {}) {
  const span = Math.max(1, Math.min(90, Math.round(Number(days) || 30)))
  const summary = usageSummary({ days: span })
  const priceView = usagePrices()
  const result = unitEconomics({
    summary,
    plans: listPlans(),
    planId,
    rmbPerCredit,
    creditPrices: config.credits.prices,
  })
  return {
    ok: true,
    days: span,
    window: summary.window,
    currency: 'CNY',
    creditPrices: { ...config.credits.prices },
    pricesPriced: priceView.priced,
    pricesUpdatedAt: priceView.updatedAt,
    pricesUpdatedBy: priceView.updatedBy,
    ...result,
  }
}
