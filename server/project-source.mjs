// 作品页「来源」面板要回答两件事：这条作品的模板是哪一条、那条模板的原片是哪条内容。
// 原片只认「有链接」的模板：画布另存的、智能体草稿存的本来就没有原片，这里如实说没有，
// 不拿模板标题当视频标题，也不编平台、作者与互动数。
//
// 这一份是纯函数：接口（server/routes/projects.mjs 的 templateDetail）只做挂载，
// 判定与折算都在这儿，测试也不用起服务。

const STAT_KEYS = ['plays', 'likes', 'comments', 'shares', 'collects']

function statNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** 互动数：五样全拿不到就当没有（老模板存下来时还没抓过互动，写 0 会被读成「没人看」）。 */
export function originStats(stats) {
  if (!stats || typeof stats !== 'object') return null
  const picked = {}
  let any = false
  for (const key of STAT_KEYS) {
    const value = statNumber(stats[key])
    picked[key] = value
    if (value > 0) any = true
  }
  return any ? picked : null
}

/**
 * 这条模板「从哪来」：
 *   original —— 平台上的原片（有链接），带上平台、作者、发布时间与互动数；
 *   canvas   —— 画布另存的模板，没有原片；
 *   agent    —— 智能体草稿存的模板，没有原片；
 *   null     —— 老数据没有来源信息（或模板已被删），页面就不显示这一块。
 */
export function templateOrigin(template) {
  if (!template) return null
  const url = String(template.sourceUrl || '').trim()
  const platform = String(template.platform || '').trim()
  const platformLabel = String(template.platformLabel || '').trim()
  if (url) {
    return {
      kind: 'original',
      platform,
      platformLabel,
      author: String(template.author || '').trim(),
      url,
      publishedAt: String(template.publishedAt || '').trim(),
      stats: originStats(template.stats),
    }
  }
  const derived =
    template.kind === 'flow' || platform === 'canvas' ? 'canvas'
      : template.kind === 'agent' || platform === 'agent' ? 'agent'
        : ''
  if (!derived) return null
  return { kind: derived, platform, platformLabel, author: '', url: '', publishedAt: '', stats: null }
}
