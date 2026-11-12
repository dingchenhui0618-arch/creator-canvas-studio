// 作品状态：一句话说明这条作品走到哪一步。
// 口径只写在这一处——作品卡片、作品页主卡、工作台、交付稿都读它，避免一处说「已评审」一处说「过了」。
//
// v0.9.19 起「已评审」不再当状态用：评过不等于过了。
// 有结论时直接写结论（评审 · 通过 / 评审 · 需人工确认 / 评审 · 不通过），
// 只有老记录没有结论时才退回「已评审」。

/** 结论的三种写法：与评审页、评审历史、分享页同一套字。 */
export const VERDICT_TEXT = { pass: '通过', needs_review: '需人工确认', fail: '不通过' }

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
 * 状态胶囊：文案 + 语气 + 那条结论。
 * 语气只决定颜色，语义全在文案里，换皮不会改意思。
 *   idle 待开画布 / live 在做 / ok 评审通过 / warn 需人工确认 / fail 不通过 / done 已交付
 */
export function projectStatus(project, reviews) {
  if (project?.status === 'done') return { text: '已交付', tone: 'done', verdict: '' }
  if (!project?.flowId) return { text: '待开画布', tone: 'idle', verdict: '' }
  const count = Number(reviews?.count) || 0
  if (!count) return { text: '在做', tone: 'live', verdict: '' }
  const verdict = reviews?.lastVerdict || ''
  if (verdict === 'pass') return { text: '评审 · 通过', tone: 'ok', verdict }
  if (verdict === 'needs_review') return { text: '评审 · 需人工确认', tone: 'warn', verdict }
  if (verdict === 'fail') return { text: '评审 · 不通过', tone: 'fail', verdict }
  // 结论之前的老记录：只说评过，不假装给了结论
  return { text: '已评审', tone: 'ok', verdict: '' }
}
