// 智能体的结构化出口（2026-11-12，P1 最后一片）。
//
// 正文负责讲清思路，正文之后附一段 ```draft JSON 负责「可以继续用的东西」：
// 标题、钩子、分段口播、分镜画面。服务端只认这一段，整理成「段 + 镜」的草稿，
// 正文里不留 JSON；没有这段就没有出口，不猜、不从 Markdown 表格里反推。
//
// 时长不采信模型写的秒数：统一用 speech.mjs 按口播字数估（与模板、作品同一口径），
// 这样草稿存成模板、送到画布之后，时长和「这句要念几秒」仍然是一套数。
import { normalizeProjectScript } from './project-script.mjs'
import { reconcileTimeline } from './speech.mjs'

export const DRAFT_MAX_SHOTS = 24

const LIMITS = {
  title: 60,
  hook: 400,
  contentType: 20,
  beat: 60,
  voiceover: 600,
  onScreen: 200,
  purpose: 200,
  visual: 400,
  camera: 60,
  caption: 200,
  audio: 200,
}

const clip = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max)
const list = (value) => (Array.isArray(value) ? value : [])
const round1 = (value) => Math.round(Number(value) * 10) / 10

// 模型可能用近义词当字段名（beats / shots / sections），只做一次温和的别名收敛，
// 不替它翻译内容：形状不对就是草稿不合格。
function pick(object, ...keys) {
  for (const key of keys) {
    const value = object?.[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function normalizeShots(rawShots) {
  const shots = list(rawShots)
    .slice(0, DRAFT_MAX_SHOTS)
    .map((raw, index) => ({
      shotNo: Number(raw?.shotNo ?? raw?.no ?? 0) || index + 1,
      visual: clip(pick(raw, 'visual', 'picture', 'scene'), LIMITS.visual),
      camera: clip(pick(raw, 'camera', 'shot', 'framing'), LIMITS.camera),
      caption: clip(pick(raw, 'caption', 'subtitle', 'line'), LIMITS.caption),
      audio: clip(pick(raw, 'audio', 'sound'), LIMITS.audio),
      purpose: clip(pick(raw, 'purpose', 'role'), LIMITS.purpose),
    }))
    .filter((shot) => shot.visual || shot.caption || shot.audio || shot.camera)
  if (!shots.length) return []
  const { rows } = reconcileTimeline(shots, { textOf: (shot) => shot.caption || shot.audio })
  // 没有字幕也没有声音的镜头算不出台词时长，给 2 秒默认值：空镜也要占一格时间轴
  return rows.map((row) => (row.endSec > row.startSec ? row : { ...row, endSec: round1(row.startSec + 2) }))
}

/**
 * 把模型给的（或界面回传的）草稿整理成可落库的形状。
 * 至少要有脚本段落或分镜之一，否则返回 null —— 调用方据此不给出口。
 */
export function normalizeDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const rawHook = clip(pick(input, 'hook', 'opening') ?? '', LIMITS.hook)
  const rawBeats = list(pick(input, 'structure', 'beats', 'sections'))
  const script = normalizeProjectScript({ hook: rawHook, structure: rawBeats }, { pace: '中' })
  const storyboard = normalizeShots(pick(input, 'storyboard', 'shots'))
  if (!script && !storyboard.length) return null
  const structure = script?.structure || []
  const voiceoverSec = round1(structure.reduce((sum, beat) => sum + (beat.expectedSec || 0), 0))
  const storyboardSec = round1(storyboard.reduce((sum, shot) => sum + Math.max(0, shot.endSec - shot.startSec), 0))
  const durationSec = round1(Math.max(voiceoverSec, storyboardSec))
  return {
    title: clip(pick(input, 'title', 'name'), LIMITS.title) || '未命名草稿',
    hook: script?.hook || rawHook,
    contentType: clip(pick(input, 'contentType', 'type'), LIMITS.contentType) || '脚本',
    structure,
    storyboard,
    stats: {
      beats: structure.length,
      shots: storyboard.length,
      voiceoverSec,
      storyboardSec,
      durationSec,
    },
  }
}

/** 草稿的时长对账：口播估算 vs 分镜实际，口径与模板详情一致。 */
export function draftTiming(draft) {
  const structure = Array.isArray(draft?.structure) ? draft.structure : []
  if (!structure.length) return null
  const totalSec = Number(draft?.stats?.storyboardSec) || 0
  const { summary } = reconcileTimeline(structure, { totalSec, textOf: (beat) => beat.voiceover })
  return summary
}

/**
 * 从回复里取出草稿块。只认 fenced 代码块（```draft / ```json），
 * 解析失败或形状不合格就当没有，绝不把正文里其它 JSON 误当草稿。
 * 返回的 reply 已经把草稿块去掉，气泡里不会出现一坨 JSON。
 */
export function extractDraft(reply) {
  const source = String(reply ?? '')
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g
  let match
  while ((match = fence.exec(source))) {
    const info = match[1].trim().toLowerCase()
    if (info && !/^(json|json5|draft)$/.test(info)) continue
    let parsed
    try {
      parsed = JSON.parse(match[2])
    } catch {
      continue
    }
    const draft = normalizeDraft(parsed)
    if (!draft) continue
    const replyText = (source.slice(0, match.index) + source.slice(match.index + match[0].length))
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return { draft, reply: replyText }
  }
  return { draft: null, reply: source }
}

/** 送画布时喂给复刻提示词的脚本形状：和作品脚本同一套字段。 */
export function draftToScript(draft) {
  return {
    hook: draft?.hook || '',
    structure: Array.isArray(draft?.structure) ? draft.structure : [],
  }
}

/** 面板上一句话说明这份草稿：「6 段 · 8 镜 · 口播约 42.6 秒」。 */
export function describeDraft(draft) {
  if (!draft?.stats) return ''
  const parts = []
  if (draft.stats.beats) parts.push(draft.stats.beats + ' 段')
  if (draft.stats.shots) parts.push(draft.stats.shots + ' 镜')
  if (draft.stats.voiceoverSec) parts.push('口播约 ' + draft.stats.voiceoverSec + ' 秒')
  return parts.join(' · ')
}


// 写进 system 消息的约定。放在「本次输出类型」之后：语气、知识、禁止项仍然按智能体的系统提示词。
//
// 第一版写的是「适合就输出」，实测 deepseek-flash 会因为正文已经写了口播和分镜表
// 而整段省略草稿块，两个出口直接消失。所以这里改成强制格式：正文有什么都必须再给一份，
// 并说清「系统只读这个块」，模型才会把它当成交付物而不是可选的补充。
export const DRAFT_HINT = [
  '【本次交付的固定格式，必须遵守】',
  '正文写完之后，必须再输出一个 ```draft 代码块，作为这次结果的机器可读版本。系统只读这个块来生成「存为模板」和「送到画布」，没有它这两个出口就不可用。',
  '不管正文已经写了口播、分镜表还是拍摄提示，都必须输出这个块；不能用表格代替，不能省略，也不能写「同上」。',
  '块里是一段 JSON，字段如下：',
  '{"title":"这条叫什么（不超过 20 字）","hook":"开头钩子原话","contentType":"脚本","structure":[{"beat":"段落名","voiceover":"要念出来的原话","onScreen":"屏幕字，可空"}],"storyboard":[{"shotNo":1,"visual":"画面","camera":"景别与运镜","caption":"这一镜的台词字幕"}]}',
  '要求：structure 最多 12 段，storyboard 最多 24 镜；voiceover 和 caption 写可以直接念、可以直接上字幕的原话，不要写「此处讲卖点」这类占位；不要写秒数（时长由系统按字数算）；JSON 之外不要再解释它，正文里也不要再贴一份。',
  '即使内容更接近文案或评审，也要尽量给出 structure；实在拆不出段落时，至少给 storyboard。',
].join('\n')
