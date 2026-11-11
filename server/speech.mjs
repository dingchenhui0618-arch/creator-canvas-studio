// 口播时长预估：复刻出来的分镜表要能照着拍，镜头时长必须和台词量对得上。
// 语义来自 hypit 的 estimateSpeechDuration（见 docs/research/hypit-2026-11-11.md P0-1）：
// 先按文本算出「这句话念完要几秒」，再和模型给的时长对账，而不是让模型随手填一个数。
//
// 语速基准：中文短视频口播 240–300 字/分钟（4.0–5.0 字/秒），取中位 4.5 字/秒；
// 英文与数字按 2.8 词/秒折算。标点算停顿：句末 0.35 秒、句内 0.18 秒。

export const SPEECH_RATE = 4.5
export const WORD_RATE = 2.8
export const SENTENCE_PAUSE = 0.35
export const CLAUSE_PAUSE = 0.18
export const MIN_SEC = 0.8
export const MAX_SEC = 60

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g
const WORDS = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g
const NUMBERS = /\d+(?:\.\d+)?/g
const SENTENCE_END = /[。！？!?；;\n]/g
const CLAUSE_END = /[，、,：:]/g

const round1 = (value) => Math.round(value * 10) / 10

/** 把一段文本拆成「要念多少」的计量：汉字、英文词、数字、句末与句内停顿。 */
export function speechStats(text) {
  const value = String(text || '')
  return {
    cjk: (value.match(CJK) || []).length,
    words: (value.match(WORDS) || []).length,
    numbers: (value.match(NUMBERS) || []).length,
    sentences: (value.match(SENTENCE_END) || []).length,
    clauses: (value.match(CLAUSE_END) || []).length,
  }
}

/**
 * 估算一段台词念完需要多少秒。空文本返回 0（表示「没有台词可估」，不是「0 秒」）。
 * 有文本时至少 0.8 秒：一个字的字幕也要给足半秒以上才看得清。
 */
export function estimateSpeechDuration(text, options = {}) {
  const { minSec = MIN_SEC, maxSec = MAX_SEC } = options
  const stats = speechStats(text)
  if (!stats.cjk && !stats.words && !stats.numbers) return 0
  const seconds =
    stats.cjk / SPEECH_RATE +
    (stats.words + stats.numbers) / WORD_RATE +
    stats.sentences * SENTENCE_PAUSE +
    stats.clauses * CLAUSE_PAUSE
  return round1(Math.min(maxSec, Math.max(minSec, seconds)))
}

/**
 * 时长与台词对账：
 * - tight：台词念不完（估算超过实际 1.35 倍）；
 * - loose：镜头空转（估算不到实际 0.55 倍，画面比台词长太多）；
 * - untimed：模型没给时长，估算值就是建议时长。
 */
export function speechFit(expectedSec, actualSec) {
  if (!(actualSec > 0)) return expectedSec > 0 ? 'untimed' : 'ok'
  if (!(expectedSec > 0)) return 'ok'
  const ratio = expectedSec / actualSec
  if (ratio > 1.35) return 'tight'
  if (ratio < 0.55) return 'loose'
  return 'ok'
}

/**
 * 给一组分段（脚本段落或分镜）补上「台词约需几秒」，并汇总整条的时长是否合理。
 * textOf 取该段真正会被念出来的文本：段落取口播，镜头取字幕。
 */
export function reconcileTimeline(segments, { totalSec = 0, textOf = (seg) => seg?.caption } = {}) {
  const startOf = (seg) => Number(seg?.startSec) || 0
  const endOf = (seg) => Number(seg?.endSec) || 0
  let cursor = 0
  const rows = (Array.isArray(segments) ? segments : []).map((seg, index) => {
    const expectedSec = estimateSpeechDuration(textOf(seg))
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
  const fit =
    estimatedSec > 0 && scope > 0 ? speechFit(estimatedSec, scope) : 'ok'
  return {
    rows,
    summary: {
      estimatedSec,
      actualSec,
      durationSec: round1(scope),
      fit,
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
    return '台词量比原片长，照着念完大约要多 ' + over + ' 秒，复刻时要删掉一部分口播';
  }
  if (summary.fit === 'loose') {
    return '画面比台词长，照着拍会有空镜，复刻时要补口播或加快剪辑';
  }
  const tight = summary.tight || 0
  return tight ? ('整体时长合理，其中 ' + tight + ' 个镜头台词偏多') : '台词量与时长匹配';
}
