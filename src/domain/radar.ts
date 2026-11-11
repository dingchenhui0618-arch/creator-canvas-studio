export type Platform = 'douyin' | 'xiaohongshu'

export type MediaItem = {
  id: string
  platform: Platform
  platformLabel: string
  title: string
  author: string
  authorId?: string
  cover: string
  url: string
  publishedAt: string
  durationSec: number | null
  // plays 只有抖音有；interactions 是小红书自带的互动量。取不到就是 0，不做估算。
  stats: { plays?: number; likes: number; comments: number; shares: number; collects: number; interactions?: number | null }
  mock?: boolean
}

export type QuotaNotice = {
  code: string
  message: string
  rechargeUrl?: string
  goodsName?: string
}

export type SearchResult = {
  mode: 'live' | 'mock'
  items: MediaItem[]
  total: number
  /** 本次取回的是第几页（从 1 开始） */
  page?: number
  /** 后面还有没有下一页：页满且总数没到 */
  hasMore?: boolean
  /** 服务端实际使用的排序字段 */
  sort?: string
  note?: string
  quota?: QuotaNotice
}

/** 时长与台词对账：fit 由语速估算（约 4.5 字/秒）与原片时长比较得出。 */
export type SpeechFit = 'ok' | 'tight' | 'loose' | 'untimed'

export type ScriptBeat = {
  beat: string
  startSec: number
  endSec: number
  voiceover: string
  onScreen: string
  purpose: string
  /** 这段口播念完大约要几秒 */
  expectedSec?: number
  fit?: SpeechFit
}

export type StoryboardShot = {
  shotNo: number
  startSec: number
  endSec: number
  frameIndex: number
  frameUrl?: string
  visual: string
  camera: string
  caption: string
  audio: string
  purpose: string
  /** 这句字幕念完大约要几秒 */
  expectedSec?: number
  fit?: SpeechFit
}

export type TemplateTiming = {
  estimatedSec: number
  actualSec: number
  durationSec: number
  fit: SpeechFit
  /** 估算用的语速档位：fast / normal / slow（来自模型对原片节奏的判断） */
  pace?: string
  /** 中文字/秒 */
  rate?: number
  overSec: number
  tight: number
  loose: number
}

/** 一句话说明这条模板的时长问题（与 server/speech.mjs 的 describeTiming 同口径）。 */
/** 语速档位的中文标签（与 server/speech.mjs 的 PACE_ALIAS 对应）。 */
export function paceLabel(pace?: string): string {
  if (pace === 'fast' || pace === '快') return '快'
  if (pace === 'slow' || pace === '慢') return '慢'
  return '中'
}

export function describeTiming(timing?: TemplateTiming | null): string {
  if (!timing || !timing.estimatedSec) return ''
  if (timing.fit === 'tight') {
    return '台词量比原片长，照着念完大约要多 ' + Math.max(1, Math.round(timing.overSec)) + ' 秒'
  }
  if (timing.fit === 'loose') return '画面比台词长，照着拍会有空镜，需要补口播或加快剪辑'
  return timing.tight ? '整体时长合理，其中 ' + timing.tight + ' 个镜头台词偏多' : '台词量与时长匹配'
}

export type TemplateAnalysis = {
  pacing: string
  viralPoints: string[]
  reusableRules: string[]
  targetAudience: string
}

export type ReplicaTemplate = {
  thumb?: string
  id: string
  /** saved：只存了链接与互动数据；replica：跑过一键复刻，有脚本与分镜；flow：画布另存的工作流 */
  kind: 'saved' | 'replica' | 'flow'
  savedAt?: string
  title: string
  contentType: string
  tags: string[]
  platform: Platform
  platformLabel: string
  sourceUrl: string
  sourceId: string
  author: string
  publishedAt: string
  stats: MediaItem['stats']
  durationSec: number
  hook: string
  hookType: string
  structure: ScriptBeat[]
  storyboard: StoryboardShot[]
  /** 整条模板的时长对账结果（saved 状态、纯画布工作流没有这一项） */
  timing?: TemplateTiming | null
  analysis: TemplateAnalysis
  frames: { index: number; t: number; url: string }[]
  cover: string
  video: { width: number; height: number; fps: number; duration: number }
  origin: 'ai' | 'manual' | 'canvas'
  reuseCount: number
  createdAt: string
  /** kind === 'flow' 时才有：画布节点摘要与可恢复的节点/连线 */
  flowNodes?: { title: string; kind: string }[]
  blueprint?: { nodes: unknown[]; edges: unknown[] }
}

export type JobLog = { at: string; text: string }

export type ReplicateJob = {
  id: string
  status: 'running' | 'done' | 'error'
  step: string
  progress: number
  logs: JobLog[]
  error: string | null
  templateId: string | null
  createdAt: string
}

export type TemplateList = {
  items: ReplicaTemplate[]
  total: number
  parsed: number
  saved: number
  /** 画布另存的工作流模板条数（不混进「已解析」） */
  flows?: number
  byType: Record<string, number>
}
