// 作品状态：一句话说明这条作品走到哪一步。
// 口径只写在这一处——作品卡片、作品页主卡、工作台、交付稿都读它，避免一处说「已评审」一处说「过了」。
//
// v0.9.19 起「已评审」不再当状态用：评过不等于过了。
// 有结论时直接写结论（评审 · 通过 / 评审 · 需人工确认 / 评审 · 不通过），
// 只有老记录没有结论时才退回「已评审」。

/** 结论的三种写法：与评审页、评审历史、分享页同一套字。 */
export const VERDICT_TEXT = { pass: '通过', needs_review: '需人工确认', fail: '不通过' }

/** 人拍板的两种写法：写在模型结论旁边时要分得清是谁说的。 */
export const DECISION_TEXT = { pass: '人工通过', reject: '人工不通过' }

/**
 * 某一版评过几次、最后一次结论是什么。
 * 版本划分之前留下的评审记在 0 上，v1 要把它们算进来，否则老作品刚开版本视图会显示「这一版没评过」。
 */
export function reviewsForVersion(counts, version) {
  const own = counts?.[String(version)]
  const legacy = Number(version) === 1 ? counts?.['0'] : undefined
  if (!own && !legacy) return { count: 0, lastVerdict: '', lastAt: '' }
  if (!own) return { count: Number(legacy.count) || 0, lastVerdict: legacy.lastVerdict || '', lastAt: legacy.lastAt || '' }
  if (!legacy) return { count: Number(own.count) || 0, lastVerdict: own.lastVerdict || '', lastAt: own.lastAt || '' }
  const latest = String(own.lastAt) >= String(legacy.lastAt) ? own : legacy
  return {
    count: (Number(own.count) || 0) + (Number(legacy.count) || 0),
    lastVerdict: latest.lastVerdict || '',
    lastAt: latest.lastAt || '',
  }
}

/**
 * 哪条拍板管这一次评审：按评审时间认（版次只是写给人看的）。
 * 同一版又评出新结论、或开了新版，时间对不上，拍板自动失效——人拍的是那一次评审，不是「这条作品永远通过」。
 */
export function decisionFor(decisions, reviewAt) {
  const at = String(reviewAt || '')
  if (!at) return null
  for (const entry of Array.isArray(decisions) ? decisions : []) {
    if (entry && entry.decision && String(entry.reviewAt || '') === at) return entry
  }
  return null
}

/**
 * 最近一次「标记交付」：交出去的是哪一版、什么时候（老记录没有时间，at 是空串）。
 * deliveries 按发生顺序排，最后一条就是最近一次；没有记录返回 null。
 */
export function deliveryOf(project) {
  const list = Array.isArray(project?.deliveries) ? project.deliveries : []
  const last = list[list.length - 1]
  if (!last) return null
  return { version: Math.max(0, Math.round(Number(last.version) || 0)), at: String(last.at || '') }
}

/**
 * 这一版交付了没有：status=done 只说明「按过标记交付」，交的是哪一版要看交付记录。
 * 交付了 v2 之后开了 v3，v3 还没交——胶囊不能再写「已交付」，下一步也要继续走。
 * 没有交付记录的老数据照旧：status=done 就是这一版交了。
 */
export function deliveredCurrent(project) {
  if (project?.status !== 'done') return false
  const delivery = deliveryOf(project)
  if (!delivery) return true
  return delivery.version === Math.max(1, Math.round(Number(project?.version) || 0))
}

/**
 * 状态胶囊：文案 + 语气 + 那条结论。
 * 语气只决定颜色，语义全在文案里，换皮不会改意思。
 *   idle 待开画布 / live 在做 / ok 评审通过 / warn 需人工确认 / fail 不通过 / done 已交付
 *
 * 有人的拍板时写人的那一句（评审 · 人工通过 / 人工不通过）：胶囊回答的是「谁能拍板」，
 * 人拍过板就不再拿模型的「需人工确认」当结论。
 */
export function projectStatus(project, reviews, decision = null) {
  if (deliveredCurrent(project)) return { text: '已交付', tone: 'done', verdict: '' }
  if (!project?.flowId) return { text: '待开画布', tone: 'idle', verdict: '' }
  const count = Number(reviews?.count) || 0
  if (!count) return { text: '在做', tone: 'live', verdict: '' }
  const verdict = reviews?.lastVerdict || ''
  // 人拍板优先：它是结论之上的一层，模型写的结论仍然留在评审记录里
  if (decision && DECISION_TEXT[decision.decision]) {
    return {
      text: '评审 · ' + DECISION_TEXT[decision.decision],
      tone: decision.decision === 'pass' ? 'ok' : 'fail',
      verdict,
      human: decision.decision,
    }
  }
  if (verdict === 'pass') return { text: '评审 · 通过', tone: 'ok', verdict }
  if (verdict === 'needs_review') return { text: '评审 · 需人工确认', tone: 'warn', verdict }
  if (verdict === 'fail') return { text: '评审 · 不通过', tone: 'fail', verdict }
  // 结论之前的老记录：只说评过，不假装给了结论
  return { text: '已评审', tone: 'ok', verdict: '' }
}
