import type { ScriptBeat, StoryboardShot, TemplateTiming } from './radar'
import type { ReviewSummary } from '../api/review'

// 作品（Project）：一条内容的主线对象。
// 它不自带脚本与分镜——那两样在它绑定的模板上，改了模板作品跟着变；
// 这里只描述「谁、用哪条模板、开的哪块画布、走到哪一步」。
export type ProjectStatus = 'active' | 'done'

export type ProjectTemplateBrief = {
  id: string
  title: string
  kind: string
  contentType: string
  durationSec: number
  beats: number
  shots: number
}

export type ProjectReviews = { count: number; lastVerdict: string; lastAt: string }

/** 归档的旧版本：只存画布指针与名字，画布本身仍在流程服务里 */
export type ProjectVersion = { n: number; flowId: string; name: string; archivedAt: string }

/** 作品详情会顺手确认归档画布还在，并带上节点数 */
// 归档版本额外带上开版时存下的脚本快照段数：交付稿与版本对照都靠它说「这一版几段」
export type ProjectVersionView = ProjectVersion & {
  available: boolean
  nodes: number
  /** 开新版那一刻的脚本段数；0 表示那一版没存快照（升级前开的版本） */
  scriptBeats: number
  /** 那一版的脚本当时是自己的还是跟随模板；没快照就是空串 */
  scriptSource: '' | 'project' | 'template'
}

export type Project = {
  id: string
  title: string
  templateId: string
  flowId: string
  /** 第几版：0 还没开画布，开出来就是 v1 */
  version: number
  versions: ProjectVersion[]
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

/** 一次画布运行的摘要：运行记在画布服务里，作品页把名下所有版本的运行按时间归集成一条线 */
export type ProjectRun = {
  id: string
  flowId: string
  flowName: string
  status: string
  startedAt: string
  finishedAt: string
  durationMs: number
  total: number
  failed: number
  error: string
  credits: { cost: number; refunded: boolean } | null
  /** 这次运行跑的是第几版画布 */
  version: number
  /** 那一版画布还在不在：被删掉后运行记录仍留着，但画布打不开 */
  available: boolean
}

export type ProjectSummary = Project & {
  template: ProjectTemplateBrief | null
  reviews: ProjectReviews
  /** 按版本分组的评审计数：状态胶囊只看当前这一版 */
  versionCounts: Record<string, ProjectReviews>
  /** 这条作品名下所有版本画布一共跑过几次 */
  runs: { count: number }
}

export type ProjectTemplateDetail = ProjectTemplateBrief & {
  hook: string
  hookType: string
  platformLabel: string
  structure: ScriptBeat[]
  storyboard: StoryboardShot[]
  timing: TemplateTiming | null
  cover: string
  reuseCount: number
}

export type ProjectFlowBrief = { id: string; name: string; nodes: number; updatedAt: string }

/**
 * 作品页看到的脚本。
 * source=project 表示这条作品自己的版本（改过就不再跟随模板）；template 表示还在跟随模板。
 * timing 是这份脚本按当前语速档重算后的口播时长，改完口播「要念几秒」随之更新。
 */
export type ProjectScript = {
  hook: string
  structure: ScriptBeat[]
  source: 'project' | 'template'
  updatedAt: string
  timing: TemplateTiming | null
}

/** 作品级只读分享：token 只在作品页的分享面板与地址里出现，列表接口不返回 */
export type ProjectShare = { token: string; createdAt: string }

/** 分享页读到的公开视图：服务端白名单挑过，不含账号、画布与模板 id */
export type SharedProjectShot = {
  shotNo: number
  startSec: number
  endSec: number
  visual: string
  camera: string
  caption: string
  audio: string
  /** 分镜帧图：走带 token 的公开地址，没有那一帧时是空串 */
  frameUrl: string
}

export type SharedProject = {
  project: { title: string; status: ProjectStatus; version: number; createdAt: string; updatedAt: string }
  template: {
    title: string
    platformLabel: string
    contentType: string
    durationSec: number
    beats: number
    shots: number
  } | null
  script: { hook: string; structure: ScriptBeat[]; source: 'project' | 'template'; timing: TemplateTiming | null } | null
  storyboard: SharedProjectShot[]
  stats: { beats: number; shots: number; reviews: number; lastVerdict: string; lastAt: string; runs: number }
  sharedAt: string
}

export type ProjectDetail = {
  project: Project
  /** 这条作品的只读分享链接状态；没开就是 null */
  share: ProjectShare | null
  template: ProjectTemplateDetail | null
  flow: ProjectFlowBrief | null
  /** 作品页自己的脚本：自己的版本优先，没有则回退到模板 */
  script: ProjectScript | null
  reviews: ReviewSummary[]
  /** 归档版本（不含当前版），按归档先后 */
  versions: ProjectVersionView[]
  /** 按版本分组的评审计数：键是版本号，用于版本对照 */
  versionCounts: Record<string, ProjectReviews>
  /** 运行归集：当前版与归档版的运行合成一条时间线，按开始时间倒序 */
  runs: ProjectRun[]
  runTotal: number
  /** 按版本分组的运行次数：版本对照里写「这一版跑过几次」 */
  runCounts: Record<string, number>
}

/** 状态胶囊：文案 + 语气。语气只决定颜色，不改变语义。 */
export function projectStatus(project: Project, reviewCount: number): { text: string; tone: 'idle' | 'live' | 'ok' | 'done' } {
  if (project.status === 'done') return { text: '已交付', tone: 'done' }
  if (!project.flowId) return { text: '待开画布', tone: 'idle' }
  if (!reviewCount) return { text: '在做', tone: 'live' }
  return { text: '已评审', tone: 'ok' }
}

/**
 * 某一版评过没有：版本划分之前留下的评审记在版本 0 上，v1 要把它们算进来，
 * 否则刚上线的老作品会突然显示「这一版还没进评审」。
 */
export function reviewsForVersion(counts: Record<string, ProjectReviews>, version: number): ProjectReviews {
  const own = counts[String(version)]
  const legacy = version === 1 ? counts['0'] : undefined
  if (!own && !legacy) return { count: 0, lastVerdict: '', lastAt: '' }
  if (!own) return legacy as ProjectReviews
  if (!legacy) return own
  const latest = String(own.lastAt) >= String(legacy.lastAt) ? own : legacy
  return { count: own.count + legacy.count, lastVerdict: latest.lastVerdict, lastAt: latest.lastAt }
}

/**
 * 某一版画布跑过几次：与评审同一套口径，版本划分之前留下的运行算进 v1，
 * 否则老作品刚开版本视图时会显示「这一版没跑过」。
 */
export function runsForVersion(counts: Record<string, number>, version: number): number {
  const own = Number(counts[String(version)]) || 0
  const legacy = version === 1 ? Number(counts['0']) || 0 : 0
  return own + legacy
}

export type ProjectStepKey = 'canvas' | 'review' | 'continue' | 'done'

/**
 * 下一步只有一件事：
 *   没画布 → 用这条脚本开画布；有画布没评审 → 送一次评审；都做过了 → 回去按意见改；交付了 → 收尾。
 * 作品页主卡与工作台都读这一个函数，避免两处口径分叉。
 */
export function projectStep(
  project: Project,
  reviewCount: number,
): { key: ProjectStepKey; label: string; title: string; hint: string; cta: string } {
  if (project.status === 'done') {
    return {
      key: 'done',
      label: '下一步 · 已交付',
      title: '这条已经交付',
      hint: '画布与评审都留在记录里，随时可以重新打开照着改',
      cta: '再打开画布',
    }
  }
  if (!project.flowId) {
    return {
      key: 'canvas',
      label: '下一步 · 开画布',
      title: '先开一张画布',
      hint: '用这条作品现在的脚本生成画布草稿：输入节点带钩子、复刻节点带完整提示词',
      cta: '用这条脚本开画布',
    }
  }
  if (!reviewCount) {
    return {
      key: 'review',
      label: '下一步 · 送评审',
      title: '画布有了，送一次评审',
      hint: '拿你这一版的画面跑一遍视觉评审，结论会记在这条作品下',
      cta: '用评审看这版',
    }
  }
  return {
    key: 'continue',
    label: '下一步 · 继续做',
    title: '按评审意见改一版',
    hint: '评审结论里的修正建议逐条落到画布上，改完可以再评一次',
    cta: '继续画布',
  }
}
