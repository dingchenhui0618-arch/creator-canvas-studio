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
export type ProjectVersionView = ProjectVersion & { available: boolean; nodes: number }

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

export type ProjectSummary = Project & {
  template: ProjectTemplateBrief | null
  reviews: ProjectReviews
  /** 按版本分组的评审计数：状态胶囊只看当前这一版 */
  versionCounts: Record<string, ProjectReviews>
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

export type ProjectDetail = {
  project: Project
  template: ProjectTemplateDetail | null
  flow: ProjectFlowBrief | null
  reviews: ReviewSummary[]
  /** 归档版本（不含当前版），按归档先后 */
  versions: ProjectVersionView[]
  /** 按版本分组的评审计数：键是版本号，用于版本对照 */
  versionCounts: Record<string, ProjectReviews>
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

export type ProjectStepKey = 'canvas' | 'review' | 'continue' | 'done'

/**
 * 下一步只有一件事：
 *   没画布 → 套用模板开画布；有画布没评审 → 送一次评审；都做过了 → 回去按意见改；交付了 → 收尾。
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
      hint: '用这条模板生成画布草稿：脚本与分镜已经带过去，接着把节点连起来',
      cta: '套用模板开画布',
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
