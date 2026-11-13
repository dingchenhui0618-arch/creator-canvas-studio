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

// 发现页开场「带走的原片」（v0.9.36）：模板上留着原片链接，作品那侧只有模板指针，服务端现算。
export type TakenOriginStats = { plays: number; likes: number; comments: number; shares: number; collects: number }

/**
 * 这一行的下一步（v0.9.39）：服务端算出「点一下会发生什么」，界面只照着渲染。
 *   open-work   已经开过作品，点一下进那条作品（projectId）
 *   create-work 还没开过，点一下照这条模板开一条
 *   blocked     还没解析出脚本与分镜，按钮点不动，理由在 hint 里
 */
export type OriginEntry = {
  kind: 'open-work' | 'create-work' | 'blocked'
  label: string
  hint: string
  /** open-work 才有；别的 kind 是空串 */
  projectId: string
}

export type TakenOrigin = {
  templateId: string
  title: string
  platform: Platform | ''
  /** 抖音 / 小红书；认不出的平台是空串，界面兜底写「原片」 */
  platformLabel: string
  author: string
  /** 一件互动都没有时是 null：不拿一排 0 冒充原片数据 */
  stats: TakenOriginStats | null
  savedAt: string
  /** 官方示例（运营给的样例）：照实标出来，不冒充「你带回来的」 */
  official: boolean
  /** 同一条原片存成了几条模板（改编版继承原链接） */
  templates: number
  /** 这条原片开出的最近一条作品；没开成作品是 null */
  project: { id: string; title: string; version: number } | null
  /** 这条原片开出了几条作品（一条作品多版只算一条） */
  works: number
  /** 这一行的下一步：开成作品 / 打开作品 / 还没解析 */
  entry: OriginEntry | null
}

export type TakenOrigins = {
  total: number
  withProject: number
  /** 还没开成作品的有几条（按全部原片算，不是只算列出来的那几行） */
  pending: number
  works: number
  official: number
  lastAt: string
  items: TakenOrigin[]
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
  /** saved：只存了链接与互动数据；replica：跑过一键复刻；adapted：以某条为底改编出的我的一版；flow：画布另存的工作流；agent：智能体的结构化草稿存成的模板 */
  kind: 'saved' | 'replica' | 'adapted' | 'flow' | 'agent'
  /** kind === 'adapted' 时才有：改编自哪条模板 */
  adaptedFrom?: string
  /** kind === 'agent' 时才有：这份草稿来自哪个智能体 */
  agentId?: string
  agentName?: string
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
  /** 改编版没有原片分析，可能是 null */
  analysis: TemplateAnalysis | null
  frames: { index: number; t: number; url: string }[]
  cover: string
  video: { width: number; height: number; fps: number; duration: number }
  /** 进了回收站才有：删除时间（ISO），30 天后自动清空 */
  deletedAt?: string
  /** 只读分享 token：开着分享才有；没有它就没有对外链接 */
  shareToken?: string
  shareCreatedAt?: string
  /** project：从一条作品沉淀下来的（adapt 那条路的 origin 是 adapted） */
  origin: 'ai' | 'manual' | 'canvas' | 'agent' | 'adapted' | 'project'
  /** 「这条从哪来」：服务端 templateSource 的唯一口径，卡片标签与来源胶囊共用 */
  source?: TemplateSourceKey
  /** origin === 'project' 时才有：它是从哪条作品的第几版沉淀出来的 */
  projectId?: string
  projectTitle?: string
  projectVersion?: number
  reuseCount: number
  /** 公共模板：运营放进来的示例，所有账号都看得见（ownerId 为空） */
  shared?: boolean
  createdAt: string
  /** kind === 'flow' 时才有：画布节点摘要与可恢复的节点/连线 */
  flowNodes?: { title: string; kind: string }[]
  blueprint?: { nodes: unknown[]; edges: unknown[] }
  /** 列表接口现算：这条模板名下有几条作品在用（不是复用次数的计数器） */
  projectCount?: number
  /** 详情接口才有：用这条模板的作品，最近改过的排前面 */
  projects?: TemplateProjectRef[]
  /** 详情接口才有：这条原片在库里的全貌（同源改编版 + 跨模板开出的作品）；没有原片的模板为 null。
   *  字段名不能叫 origin：模板自己的 origin 是「这条从哪来」（ai / manual / canvas …）。 */
  footprint?: TemplateOrigin | null
}

/** 模板详情里「这条原片在库里」：同源模板、跨模板开出的作品、套用过几次 */
export type TemplateOrigin = {
  /** 认原片的键：平台 + 平台 id（没有平台 id 时是规范化链接），与发现页同一套规则 */
  key: string
  platform: string
  platformLabel: string
  sourceId: string
  templateId: string
  /** 这条原片在库里存成了几条模板（含当前这条） */
  templateCount: number
  /** 除当前这条外的同源模板，最近存进来的排前面 */
  siblings: { id: string; title: string; source: string; kind: string; shared: boolean; reuseCount: number; createdAt: string }[]
  siblingTotal: number
  /** 这条原片开出了几条作品：一条作品多版只算一条 */
  workCount: number
  works: { id: string; title: string; version: number; status: 'active' | 'done'; delivered: boolean; updatedAt: string }[]
  /** 组内各条模板的 reuseCount 之和 */
  applied: number
  /** 整组都是官方示例：不是你自己带回来的 */
  shared: boolean
  /** 模板与作品里最近一次变动 */
  lastAt: string
}

/** 发现页检索卡片：这条内容已经在库里（给到已有的那条模板，别重复收一遍） */
export type LibraryMark = {
  id: string
  templateId: string
  title: string
  source: string
  shared: boolean
  /** 这条原片开出了几条作品 */
  workCount: number
  /** 版本 0 = 照模板开了作品、还没开画布 */
  project: { id: string; title: string; version: number } | null
  /** 卡片第二格的下一步：与「库里的原片」那一行同一个口径 */
  entry?: OriginEntry | null
}

/** 模板详情里「用这条模板的作品」那一行：够认出是哪条、走到哪一步 */
export type TemplateProjectRef = {
  id: string
  title: string
  status: 'active' | 'done'
  /** 这一版交没交：交付了 v2 又开 v3 的作品这里仍是 false */
  delivered?: boolean
  version: number
  updatedAt: string
}

/** 公开分享的只读视图：服务端按白名单给出，不含归属、版本历史和画布 blueprint。 */
export type SharedTemplate = Pick<
  ReplicaTemplate,
  | 'id'
  | 'kind'
  | 'title'
  | 'contentType'
  | 'tags'
  | 'platform'
  | 'platformLabel'
  | 'sourceUrl'
  | 'author'
  | 'publishedAt'
  | 'stats'
  | 'durationSec'
  | 'hook'
  | 'hookType'
  | 'structure'
  | 'storyboard'
  | 'timing'
  | 'analysis'
  | 'frames'
  | 'cover'
  | 'video'
  | 'reuseCount'
  | 'flowNodes'
> & {
  /** 分享建立时间（ISO） */
  sharedAt: string
}

/** 检索历史：只存条件与结果条数，不存结果本身（结果会过期，重搜要重新花钱）。 */
export type SearchHistoryEntry = {
  id: string
  platform: string
  keyword: string
  range: string
  sort: string
  total: number
  at: string
  favorite: boolean
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

/** 模板来源：一张卡片只属于一个来源（官方示例优先，其次是作品 / 智能体 / 画布 / 改编，其余算发现） */
export type TemplateSourceKey = 'radar' | 'project' | 'agent' | 'canvas' | 'adapted' | 'shared'

/** 来源胶囊：key 与文案都由服务端给，前端不另写一份分类表 */
export type TemplateSourceCount = { key: TemplateSourceKey; label: string; count: number }

export type TemplateList = {
  items: ReplicaTemplate[]
  /** 全库条数：筛选时它不变，筛到的条数看 items.length */
  total: number
  parsed: number
  saved: number
  /** 画布另存的工作流模板条数（不混进「已解析」） */
  flows?: number
  /** 当前来源下还没解析的条数：类型标签里的「待解析」只在它 > 0 时出现 */
  pending?: number
  byType: Record<string, number>
  /** 每个来源各有几条（按全库算，数量为 0 的不显示胶囊） */
  sources?: TemplateSourceCount[]
  /** 这批模板名下共有几条作品在用：作品是现算的，不是复用次数的计数器 */
  projectTotal?: number
}
