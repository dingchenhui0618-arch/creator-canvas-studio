// 口播时长预估：复刻出来的分镜表要能照着拍，镜头时长必须和台词量对得上。
//
// 语速口径**照抄 hypit 的 @hypit/speech-estimate@0.1.1**（LICENSE: SEE LICENSE IN LICENSE，
// 商业授权已到位，见 docs/research/hypit-2026-11-11.md）：
//   zh: 慢 4.2 / 中 5.25 / 快 6.5625 字每秒
//   en: 慢 4.2 / 中 4.6  / 快 5.6    音节每秒
// 这些是「作者侧交付密度」，已经把正常停顿算进去了，所以这里**不再额外加标点停顿**。
// 单位口径也照它：中文按汉字、日文按假名、英文按音节（没有 CMU 词典时用启发式切音节）。
// 我们自己原来取的 4.5 字/秒是拍的，比 vendor 的中速慢 17%，已换成上面的表，好让两个系统口径一致。

export const PACE_RATES = {
  zh: { slow: 4.2, normal: 5.25, fast: 6.5625 },
  en: { slow: 4.2, normal: 4.6, fast: 5.6 },
  ja: { slow: 6, normal: 7.5, fast: 9.375 },
}
export const PACE_ALIAS = { 慢: 'slow', 中: 'normal', 快: 'fast', slow: 'slow', normal: 'normal', fast: 'fast' }
export const MIN_SEC = 0.8
export const MAX_SEC = 60

const HAN = /\p{Script=Han}/gu
const KANA = /[\u3040-\u30ff]/gu
const WORD = /[\p{L}\p{N}]+(?:['’\-‐‑–][\p{L}\p{N}]+)*/gu
const NUMBER = /^\d+$/

const round1 = (value) => Math.round(value * 10) / 10

/** 中文场景下英文词按音节算（与 hypit 一致；没有 CMU 词典，用同一套启发式）。 */
export function countSyllables(word) {
  const normalized = String(word || '').toLowerCase().replace(/[^a-z]/g, '')
  if (!normalized) return NUMBER.test(String(word || '')) ? 1 : 0
  if (normalized.length <= 3) return 1
  const stripped = normalized.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '')
  return Math.max(1, (stripped.match(/[aeiouy]{1,2}/g) || []).length)
}

/** 把一段台词换算成「要念多少单位」：汉字 + 假名 + 英文/数字音节。 */
export function speechUnits(text) {
  const value = String(text || '')
  const han = (value.match(HAN) || []).length
  const kana = (value.match(KANA) || []).length
  const latin = (value.replace(HAN, ' ').replace(KANA, ' ').match(WORD) || [])
    .filter((word) => /[A-Za-z0-9]/.test(word))
    .reduce((sum, word) => sum + countSyllables(word), 0)
  return { han, kana, latin, total: han + kana + latin }
}

export function rateForPace(pace, language = 'zh') {
  const key = PACE_ALIAS[String(pace || '').trim()] || 'normal'
  const table = PACE_RATES[language] || PACE_RATES.zh
  return table[key] || PACE_RATES.zh.normal
}

/**
 * 估算一段台词念完需要多少秒。空文本返回 0（表示「没有台词可估」，不是 0 秒）。
 * 有文本时至少 0.8 秒：一个字的字幕也要给足半秒以上才看得清。
 */
export function estimateSpeechDuration(text, options = {}) {
  const { pace = '中', minSec = MIN_SEC, maxSec = MAX_SEC } = options
  const units = speechUnits(text)
  if (!units.total) return 0
  const language = units.han + units.kana > 0 ? 'zh' : 'en'
  const seconds = units.total / rateForPace(pace, language)
  return round1(Math.min(maxSec, Math.max(minSec, seconds)))
}

/**
 * 时长与台词对账：
 * - tight：台词念不完（估算超过实际 1.2 倍 —— 20% 就已是一个镜头里多出半秒到一秒，足够听出来）；
 * - loose：镜头空转（估算不到实际 0.55 倍，画面比台词长太多）；
 * - untimed：模型没给时长，估算值就是建议时长。
 */
export function speechFit(expectedSec, actualSec) {
  if (!(actualSec > 0)) return expectedSec > 0 ? 'untimed' : 'ok'
  if (!(expectedSec > 0)) return 'ok'
  const ratio = expectedSec / actualSec
  if (ratio > 1.2) return 'tight'
  if (ratio < 0.55) return 'loose'
  return 'ok'
}

/**
 * 给一组分段（脚本段落或分镜）补上「台词约需几秒」，并汇总整条的时长是否合理。
 * textOf 取该段真正会被念出来的文本：段落取口播，镜头取字幕。
 * pace 跟着模型的节奏判断走（快 / 中 / 慢），复刻出来的口播密度才对得上原片。
 */
export function reconcileTimeline(segments, { totalSec = 0, textOf = (seg) => seg?.caption, pace = '中' } = {}) {
  const startOf = (seg) => Number(seg?.startSec) || 0
  const endOf = (seg) => Number(seg?.endSec) || 0
  let cursor = 0
  const rows = (Array.isArray(segments) ? segments : []).map((seg, index) => {
    const expectedSec = estimateSpeechDuration(textOf(seg), { pace })
    const rawStart = Number(seg?.startSec)
    // 第一镜之后还写 0 秒开头，说明模型没给时间，按上一镜结束时间顺排
    const startSec = Number.isFinite(rawStart) && !(index > 0 && rawStart === 0) ? rawStart : cursor
    let endSec = endOf(seg)
    // 模型没给结束时间时，用台词估出来的时长补齐，不再退化成 0 秒或整条视频
    if (!(endSec > startSec)) endSec = round1(startSec + expectedSec)
    cursor = endSec
    return { ...seg, startSec, endSec, expectedSec, fit: speechFit(expectedSec, round1(endSec - startSec)) }
  })
  const estimatedSec = round1(rows.reduce((sum, row) => sum + (row.expectedSec || 0), 0))
  const actualSec = round1(rows.reduce((sum, row) => sum + Math.max(0, row.endSec - row.startSec), 0))
  const scope = totalSec > 0 ? totalSec : actualSec
  const fit = estimatedSec > 0 && scope > 0 ? speechFit(estimatedSec, scope) : 'ok'
  return {
    rows,
    summary: {
      estimatedSec,
      actualSec,
      durationSec: round1(scope),
      fit,
      pace: PACE_ALIAS[String(pace || '').trim()] || 'normal',
      rate: rateForPace(pace),
      overSec: round1(Math.max(0, estimatedSec - scope)),
      tight: rows.filter((row) => row.fit === 'tight').length,
      loose: rows.filter((row) => row.fit === 'loose').length,
    },
  }
}

/** 一句话说明这条模板的时长问题，界面直接显示，不给用户看术语。 */
export function describeTiming(summary) {
  if (!summary || !summary.estimatedSec) return ''
  if (summary.fit === 'tight') {
    const over = Math.max(1, Math.round(summary.overSec))
    return '台词量比原片长，照着念完大约要多 ' + over + ' 秒，复刻时要删掉一部分口播'
  }
  if (summary.fit === 'loose') {
    return '画面比台词长，照着拍会有空镜，复刻时要补口播或加快剪辑'
  }
  const tight = summary.tight || 0
  return tight ? ('整体时长合理，其中 ' + tight + ' 个镜头台词偏多') : '台词量与时长匹配'
}
