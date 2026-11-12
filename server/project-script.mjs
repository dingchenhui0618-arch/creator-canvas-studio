// 作品自己的脚本：copy-on-write（2026-11-12，P1 第三片的延续）。
//
// 作品默认跟随绑定模板的脚本；在作品页第一次保存脚本时，才把脚本复制成作品自己的版本。
// 从此这条作品的脚本独立：模板再改不影响它，它也不影响别的作品。
// 删掉自己的版本就回到「跟随模板」——不复制就不留副本，改模板作品照样跟着变。
import { reconcileTimeline } from './speech.mjs'

export const SCRIPT_MAX_BEATS = 12
export const SCRIPT_LIMITS = { hook: 400, beat: 60, voiceover: 600, onScreen: 200, purpose: 200 }

const clip = (value, max) => String(value ?? '').trim().slice(0, max)
// 秒数只留一位小数：口播估算本来就只有一位，存多了是假精度
const num = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 10) / 10 : 0
}

/** 模板的语速档位：和模板时长估算同一口径，改完脚本重算也照样快/中/慢。 */
export function scriptPace(template) {
  return template?.timing?.pace || template?.analysis?.pacing || '中'
}

/**
 * 把用户提交的脚本整理成可落库的形状：超长截断、至少一段有内容、按口播重算「要念几秒」。
 * 返回 null 表示这份脚本是空的——路由据此拒绝保存，界面提示「至少留一段」。
 */
export function normalizeProjectScript(input, { pace = '中', totalSec = 0 } = {}) {
  if (!input || typeof input !== 'object') return null
  const rawBeats = Array.isArray(input.structure) ? input.structure.slice(0, SCRIPT_MAX_BEATS) : []
  const beats = rawBeats.map((raw) => ({
    beat: clip(raw?.beat, SCRIPT_LIMITS.beat),
    startSec: num(raw?.startSec),
    endSec: num(raw?.endSec),
    voiceover: clip(raw?.voiceover, SCRIPT_LIMITS.voiceover),
    onScreen: clip(raw?.onScreen, SCRIPT_LIMITS.onScreen),
    purpose: clip(raw?.purpose, SCRIPT_LIMITS.purpose),
  }))
  // 整段被清空的段落不落库：脚本是给画布与评审看的，空段落只会让编号对不上
  const kept = beats.filter((beat) => beat.beat || beat.voiceover || beat.onScreen)
  if (!kept.length) return null
  // 段名空着时按序号补：界面与提示词都按「第 N 段」引用，不留空标题
  const named = kept.map((beat, index) => ({ ...beat, beat: beat.beat || '第 ' + (index + 1) + ' 段' }))
  const { rows } = reconcileTimeline(named, { totalSec, textOf: (beat) => beat.voiceover, pace })
  return { hook: clip(input.hook, SCRIPT_LIMITS.hook), structure: rows, updatedAt: new Date().toISOString() }
}

/** 读盘时只认形状，不信任存储里的旧数据：结构坏了就当没有自己的脚本，回退到模板。 */
export function normalizeStoredScript(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.structure)) return null
  const structure = raw.structure.filter((beat) => beat && typeof beat === 'object').slice(0, SCRIPT_MAX_BEATS)
  if (!structure.length) return null
  return {
    hook: clip(raw.hook, SCRIPT_LIMITS.hook),
    structure,
    updatedAt: String(raw.updatedAt || ''),
  }
}

/**
 * 作品页看到的脚本：自己的版本优先，没有就回退到模板。
 * 自己的脚本按「当前模板的语速档 / 原片时长」重新对账，改完口播的「要念几秒」才是新的。
 */
export function scriptView(project, template) {
  if (project?.script?.structure?.length) {
    const { rows, summary } = reconcileTimeline(project.script.structure, {
      totalSec: Number(template?.durationSec) || 0,
      textOf: (beat) => beat.voiceover,
      pace: scriptPace(template),
    })
    return {
      hook: project.script.hook || '',
      structure: rows,
      source: 'project',
      updatedAt: project.script.updatedAt || '',
      timing: summary,
    }
  }
  const structure = Array.isArray(template?.structure) ? template.structure : []
  if (!structure.length && !template?.hook) return null
  return {
    hook: template.hook || '',
    structure,
    source: 'template',
    updatedAt: template.updatedAt || template.createdAt || '',
    timing: template.timing || null,
  }
}
