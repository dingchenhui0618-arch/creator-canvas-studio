import type { ScriptBeat, StoryboardShot, TemplateTiming } from './radar'
import type { ReviewIssues, ReviewSummary } from '../api/review'

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

export type ProjectReviews = {
  count: number
  lastVerdict: string
  lastAt: string
  /** 这一版最近一次评审的问题数（按严重度）；老记录没有 */
  issues?: ReviewIssues | null
}

/**
 * 这条作品上花掉的积分（v0.9.65）：评审与画布运行分开记。
 * 退过款的那次运行不算（钱已经回去了），检索 / 复刻 / 智能体对话记在账号上，不摊到作品。
 */
export type ProjectSpend = {
  unit: string
  total: number
  reviews: { count: number; credits: number }
  runs: { count: number; credits: number }
  /** 最近一次花钱的时间；一次都没花过是空串（列表接口不返回这一项） */
  lastAt?: string
}

/** 花费明细里的一笔：评审或画布运行（v0.9.66）。退款的那笔照样列出，但不计入合计。 */
export type ProjectSpendEntry = {
  kind: 'review' | 'run'
  id: string
  at: string
  version: number
  credits: number
  /** 这一笔真的扣了积分没有；画布探活之类的运行是 false（金额写 0） */
  charged?: boolean
  refunded: boolean
  /** 评审结论（review）或运行状态（run），老记录可能是空串 */
  verdict?: string
  status?: string
  /** 评审意图或画布名：一行里说清「这笔是哪一次」 */
  note: string
}

export type ProjectSpendVersion = {
  version: number
  reviews: { count: number; credits: number }
  runs: { count: number; credits: number }
  total: number
  lastAt: string
}

export type ProjectSpendMonth = { month: string; total: number; reviews: number; runs: number; count: number }

/**
 * 一条作品的花费明细（v0.9.66）：口径与 ProjectSpend 同源，多给按版本、按月份与逐笔。
 * 传入 month 时只看那一个月（YYYY-MM），byMonth 与月份切换仍按全部记录算。
 */
export type ProjectSpendDetail = {
  unit: string
  /** 'all' 或 'YYYY-MM' */
  scope: string
  /** 服务端认为的「本月」，页面不按浏览器时钟猜 */
  month: string
  total: number
  reviews: { count: number; credits: number }
  runs: { count: number; credits: number }
  refunded: { count: number; credits: number }
  lastAt: string
  byVersion: ProjectSpendVersion[]
  byMonth: ProjectSpendMonth[]
  count: number
  shown: number
  items: ProjectSpendEntry[]
}

/**
 * 人工复核：人看过证据后对某一次评审拍板的结果。
 * 它不改评审记录本身（模型写了什么还是什么），只回答「这一版是谁拍的板、拍成什么」。
 * 按 reviewAt 认那次评审：同一版又评出新结论，这条就失效了。
 */
export type ProjectDecision = {
  id: string
  projectId: string
  version: number
  reviewAt: string
  verdict: string
  decision: 'pass' | 'reject'
  note: string
  at: string
  /**
   * 这条还算不算数（服务端算，页面只负责写人话）：
   *   current 管当前这一版最近一次评审 / stale 这一版后来重评过、已失效 / past 早先某一版的拍板
   */
  state?: 'current' | 'stale' | 'past'
}

/**
 * 「已看过」：人看过了、这一版先不改。
 * 它只是待办上的便利贴：结论不动、胶囊不动；按「哪一版哪一次评审」认，时间对不上就作废。
 */
export type ProjectAck = { version: number; reviewAt: string; at: string }

/**
 * 交付记录：一次「标记交付」= 哪一版、什么时候交出去。
 * 它是事实，不是开关：交付了 v2 又开 v3，v2 那条仍然在；老记录没有时间（at 是空串）。
 */
/** 交付时的评审快照：当时的结论、那次评审的时间、那一版的问题数 */
export type ProjectDeliveryReview = {
  verdict: string
  at: string
  issues: ReviewIssues | null
}

/**
 * 一条交付记录：哪一版、什么时候、交的时候评审怎么说。
 * review 三种状态都要分得清：对象 = 记下了；null = 当时还没评过；没有这个字段 = 升级前的老记录（没记）。
 */
export type ProjectDelivery = {
  version: number
  at: string
  review?: ProjectDeliveryReview | null
}

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
  /** 交付记录，按发生顺序；最后一条是最近一次 */
  deliveries?: ProjectDelivery[]
  createdAt: string
  updatedAt: string
}

/** 最近一次交付：交付了哪一版、什么时候（老记录 at 是空串）；从没交付过是 null */
export function deliveryOf(project: Project | null | undefined): ProjectDelivery | null {
  const list = Array.isArray(project?.deliveries) ? project.deliveries : []
  const last = list[list.length - 1]
  if (!last) return null
  return {
    version: Math.max(0, Math.round(Number(last.version) || 0)),
    at: String(last.at || ''),
    review: last.review,
  }
}

/**
 * 这一版交付了没有：status=done 只说明按过「标记交付」，交的是哪一版要看交付记录。
 * 交付 v2 之后开的 v3 还没交——胶囊不能再写已交付。没有交付记录的老数据照旧：done 就是这一版交了。
 */
export function deliveredCurrent(project: Project | null | undefined): boolean {
  if (project?.status !== 'done') return false
  const delivery = deliveryOf(project)
  if (!delivery) return true
  return delivery.version === Math.max(1, Math.round(Number(project?.version) || 0))
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
  /** 排队等了多久（v0.9.100）：0 = 没排过队 */
  queuedMs?: number
  total: number
  /** 已经开始的节点数：主动停止时按它结算（v0.9.101） */
  startedNodes?: number
  /** 用户停止 / 页面断开导致的中断，不是服务重启 */
  canceled?: boolean
  failed: number
  error: string
  credits: { cost: number; refunded: boolean; kept?: number; refundedAmount?: number } | null
  /** 这次运行跑的是第几版画布 */
  version: number
  /** 那一版画布还在不在：被删掉后运行记录仍留着，但画布打不开 */
  available: boolean
}

/**
 * 交付流水的一行（工作台「交出去的」）：某一版的某一次交付。
 * current 只回答「这一版还是不是当前版」，deliveredNow 只回答「这条作品现在还在交付状态」——
 * 两个都是事实，不能合成一句「已交付」，否则开过新版之后旧交付会被说成现状。
 */
export type ProjectDeliveryRow = {
  projectId: string
  title: string
  version: number
  /** 交付时间；老数据 / 开新版补的记录没有时间，是空串 */
  at: string
  /** 时间到底记下来没有：没记下的那行写「时间没记下」，不拿别的字段冒充 */
  atKnown: boolean
  /** 这条作品现在是第几版 */
  currentVersion: number
  /** 交的是不是当前这一版 */
  current: boolean
  /** 这条作品现在还在交付状态（交付过之后没开新版） */
  deliveredNow: boolean
  /** 那一版评过几次（含交付之后的重评）、最后一次结论：版本级事实，不是「交时」的结论 */
  reviews: number
  verdict: string
  /** 交的时候评审怎么说（交付时存下的快照）；null 当时还没评过；没有这个字段是升级前的老记录 */
  review?: ProjectDeliveryReview | null
  /** 这一版最近一评的问题数：界面拿它和交时快照比，判断「之后又评成了别的结论」（v0.9.86） */
  issues?: ReviewIssues | null
}

/** 交付流水的整份数字按全部记录算，不因为只取了一页而变小 */
export type DeliveryLedger = {
  items: ProjectDeliveryRow[]
  total: number
  /** 交付过几条作品（不是几条记录） */
  projects: number
  /** 其中几条交的还是当前这一版 */
  currentTotal: number
  /** 其中几条交出去之后这一版又被评成了别的结论（v0.9.86）：按交付记录数，不按作品数 */
  drifted: number
  /** 最近一次交付的时间；一条带时间的都没有就是空串 */
  lastAt: string
  offset: number
  hasMore: boolean
}

/**
 * 作品列表的筛法：只分「当前这一版交没交出去」，评审结论继续写在胶囊里。
 * 与状态胶囊同一口径：交付了 v2 又开 v3 的那条算「在做」，不算「已交付」。
 */
export type ProjectBucket = 'all' | 'active' | 'delivered'

/** 分面计数：按关键字算、不按当前状态算——换了状态，另一排数字仍然是真的 */
export type ProjectListFacets = { all: number; active: number; delivered: number }

export type ProjectSummary = Project & {
  template: ProjectTemplateBrief | null
  reviews: ProjectReviews
  /** 按版本分组的评审计数：状态胶囊只看当前这一版 */
  versionCounts: Record<string, ProjectReviews>
  /** 这条作品名下所有版本画布一共跑过几次 */
  runs: { count: number }
  /** 卡片上的花费：评审与画布运行加在一起，退过款的不算 */
  spend?: ProjectSpend
  /** 卡片上的分享状态；从没分享过就是 null */
  share: ProjectShareBrief | null
  /** 管当前这一版最近一次评审的人工拍板；还没人拍板就是 null */
  decision?: ProjectDecision | null
}

/**
 * 这条作品的模板「从哪来」（v0.9.35）：
 * original 是平台上的原片（有地址、作者、互动数）；canvas / agent 是自己产出的模板，本来就没有原片。
 * 老数据没有来源信息时整个 origin 是 null，页面不显示这一块，也不编一个「来源未知」。
 */
export type ProjectTemplateOrigin = {
  kind: 'original' | 'canvas' | 'agent'
  platform: string
  platformLabel: string
  author: string
  /** 原片地址；canvas / agent 一律空串 */
  url: string
  publishedAt: string
  /** 互动数；一样都抓不到时是 null（不是全 0，也不能拿 0 冒充「没人看」） */
  stats: { plays: number; likes: number; comments: number; shares: number; collects: number } | null
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
  /** 来源：原片还是自己产出的模板；服务端现算，不落库 */
  origin?: ProjectTemplateOrigin | null
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

/**
 * 作品列表卡片上的分享状态：只够写一枚胶囊与一个次数。
 * 不带 token、不带记录键、不带每一轮明细——那些只在作品页的分享面板里。
 */
export type ProjectShareBrief = {
  /** 当前是否有链接正在分享 */
  live: boolean
  /** 分享过几轮：正在分享的那条也算一轮 */
  rounds: number
  /** 各轮累计打开次数（次数不是人数） */
  opens: number
  /** 最近一次被打开的时间；没人打开过是空串 */
  lastAt: string
  lastClient: ShareVisits['lastClient']
}

/** 分享链接被打开过几次：只记次数与客户端类别，不记 IP、不区分是谁 */
export type ShareVisits = {
  opens: number
  firstAt: string
  lastAt: string
  /** wechat 微信内打开 / mobile 手机或平板 / desktop 电脑浏览器 / other 未知 */
  lastClient: 'wechat' | 'mobile' | 'desktop' | 'other' | ''
}

/** 作品级只读分享：token 只在作品页的分享面板与地址里出现，列表接口不返回 */
export type ProjectShare = { token: string; createdAt: string; visits?: ShareVisits }

/** 一轮已经停用的分享：地址打不开，但那次被打开过几次还留着（只留最近 8 轮） */
export type ShareHistoryEntry = { createdAt: string; closedAt: string; visits: ShareVisits }

/** 工作台的分享汇总：一条作品一行，visits 是各轮累计（次数相加，最近一次取最晚的那轮） */
export type ShareSummaryRow = {
  projectId: string
  title: string
  /** 当前是否有链接正在分享 */
  live: boolean
  /** 分享过几轮：正在分享的那条也算一轮 */
  rounds: number
  /** 最近一轮停用时间；正在分享且没有历史时为空串 */
  lastClosedAt: string
  visits: ShareVisits
}

/**
 * AI 生成内容标识（《人工智能生成合成内容标识办法》）：分享与导出都带它。
 * label 是给人看的显式标识，notice 是一句边界说明，regulation 只在说明里引用。
 */
export type AiLabel = {
  label: string
  generator: string
  aiGenerated: boolean
  regulation: string
  notice: string
  version: string
}

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
  /** 这份公开视图里有 AI 生成内容：页面上要有看得见的标识 */
  aiLabel: AiLabel
}

/** 这条作品沉淀出去的一条模板：作品只记「存过」，模板正文在模板库那边。 */
export type ProjectTemplateSave = {
  id: string
  title: string
  createdAt: string
  beats: number
  shots: number
}

export type ProjectDetail = {
  project: Project
  /** 这条作品的只读分享链接状态；没开就是 null */
  share: ProjectShare | null
  /** 以前开过的链接：按停用时间倒序，停用后地址打不开，打开记录还能回看 */
  shareHistory: ShareHistoryEntry[]
  template: ProjectTemplateDetail | null
  /** 这条作品沉淀过哪几条模板（模板那边记着 projectId，这里现算；刷新还在） */
  templateSaves?: ProjectTemplateSave[]
  flow: ProjectFlowBrief | null
  /** 作品页自己的脚本：自己的版本优先，没有则回退到模板 */
  script: ProjectScript | null
  reviews: ReviewSummary[]
  /** 归档版本（不含当前版），按归档先后 */
  versions: ProjectVersionView[]
  /** 按版本分组的评审计数：键是版本号，用于版本对照 */
  versionCounts: Record<string, ProjectReviews>
  /** 这条作品的拍板记录（按时间倒序）；管当前这一版的那条在 decision 里 */
  decisions?: ProjectDecision[]
  decision?: ProjectDecision | null
  /**
   * 当前这一版「已看过」的便利贴：版次与评审时间都对上才有，否则是 null。
   * 它只把这条从待办里拿开，不改结论、不改胶囊——和 decision 是两回事。
   */
  ack?: ProjectAck | null
  /** 运行归集：当前版与归档版的运行合成一条时间线，按开始时间倒序 */
  runs: ProjectRun[]
  runTotal: number
  /** 按版本分组的运行次数：版本对照里写「这一版跑过几次」 */
  runCounts: Record<string, number>
  /** 这条作品花了多少积分：合计、评审与运行各多少、最近一次是什么时候 */
  spend?: ProjectSpend
}

/**
 * 状态胶囊：文案 + 语气。语气只决定颜色，不改变语义。
 * 评过不等于过了：有结论时直接写结论，「已评审」只在没有结论的老记录上出现。
 * 有人拍过板时写人的那一句：胶囊回答「这一版谁拍的板」，人拍过就不再拿模型的「需人工确认」当结论。
 * 与服务端 server/project-status.mjs 同一口径——交付稿上写的状态和这里必须是一句话。
 */
export function projectStatus(
  project: Project,
  reviews: ProjectReviews,
  decision: ProjectDecision | null = null,
): { text: string; tone: 'idle' | 'live' | 'ok' | 'warn' | 'fail' | 'done'; verdict: string; human?: 'pass' | 'reject' } {
  if (deliveredCurrent(project)) return { text: '已交付', tone: 'done', verdict: '' }
  if (!project.flowId) return { text: '待开画布', tone: 'idle', verdict: '' }
  if (!reviews.count) return { text: '在做', tone: 'live', verdict: '' }
  const verdict = reviews.lastVerdict || ''
  if (decision && (decision.decision === 'pass' || decision.decision === 'reject')) {
    return {
      text: decision.decision === 'pass' ? '评审 · 人工通过' : '评审 · 人工不通过',
      tone: decision.decision === 'pass' ? 'ok' : 'fail',
      verdict,
      human: decision.decision,
    }
  }
  if (verdict === 'pass') return { text: '评审 · 通过', tone: 'ok', verdict }
  if (verdict === 'needs_review') return { text: '评审 · 需人工确认', tone: 'warn', verdict }
  if (verdict === 'fail') return { text: '评审 · 不通过', tone: 'fail', verdict }
  return { text: '已评审', tone: 'ok', verdict: '' }
}

/**
 * 某一版评过没有：版本划分之前留下的评审记在版本 0 上，v1 要把它们算进来，
 * 否则刚上线的老作品会突然显示「这一版还没进评审」。
 */
export function reviewsForVersion(counts: Record<string, ProjectReviews>, version: number): ProjectReviews {
  const own = counts[String(version)]
  const legacy = version === 1 ? counts['0'] : undefined
  // 问题数与 lastVerdict 同一个来源：这一版最近那一次评审，不把两次评审的问题相加
  if (!own && !legacy) return { count: 0, lastVerdict: '', lastAt: '', issues: null }
  if (!own) return { ...legacy!, issues: legacy!.issues ?? null }
  if (!legacy) return { ...own, issues: own.issues ?? null }
  const latest = String(own.lastAt) >= String(legacy.lastAt) ? own : legacy
  return {
    count: own.count + legacy.count,
    lastVerdict: latest.lastVerdict,
    lastAt: latest.lastAt,
    issues: latest.issues ?? null,
  }
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

export type ProjectStepKey = 'canvas' | 'review' | 'continue' | 'deliver' | 'done'

/**
 * 下一步只有一件事：
 *   没画布 → 用这条脚本开画布；有画布没评审 → 送一次评审；评过了看结论——通过就交出去，有意见就照着改；
 *   交付了 → 收尾。作品页主卡与工作台都读这一个函数，避免两处口径分叉。
 */
export function projectStep(
  project: Project,
  reviews: ProjectReviews,
  decision: ProjectDecision | null = null,
): { key: ProjectStepKey; label: string; title: string; hint: string; cta: string } {
  if (deliveredCurrent(project)) {
    const delivery = deliveryOf(project)
    return {
      key: 'done',
      label: '下一步 · 已交付',
      title: '这条已经交付',
      // 交的是哪一版要写出来：交付稿与版本对照里也记着同一件事
      hint: delivery
        ? '交付的是 v' + delivery.version + '；画布与评审都留在记录里，开一版新的就回到「在做」，上一版的交付时间仍然查得到'
        : '画布与评审都留在记录里，随时可以重新打开照着改',
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
  if (!reviews.count) {
    return {
      key: 'review',
      label: '下一步 · 送评审',
      title: '画布有了，送一次评审',
      hint: '拿你这一版的画面跑一遍视觉评审，结论会记在这条作品下',
      cta: '用评审看这版',
    }
  }
  // 人拍过板就听人的：拍板通过 → 交出去；拍板不通过 → 回去改。模型结论只是它下面的那一层。
  if (decision?.decision === 'pass') {
    return {
      key: 'deliver',
      label: '下一步 · 交付',
      title: '这一版你拍板通过了',
      hint: '人已经拍过板：把脚本、分镜、评审结论与运行记录打成交付稿或交付包发出去',
      cta: '交付这一版',
    }
  }
  if (decision?.decision === 'reject') {
    return {
      key: 'continue',
      label: '下一步 · 继续改',
      title: '你拍板这一版不行，按意见改',
      hint: '人已经否了这一版：按评审里指出的问题改完，再评一次；再评出新结论后需要重新拍板',
      cta: '继续画布',
    }
  }
  // 这一版评审通过了：下一步不再是改，而是把这版交出去
  if (reviews.lastVerdict === 'pass') {
    return {
      key: 'deliver',
      label: '下一步 · 交付',
      title: '这一版评审通过了',
      hint: '把脚本、分镜、评审结论与运行记录打成交付稿或交付包，发给剪辑、制片或甲方',
      cta: '交付这一版',
    }
  }
  return {
    key: 'continue',
    label: '下一步 · 继续做',
    title: reviews.lastVerdict === 'fail' ? '评审没过，按意见改一版' : '按评审意见改一版',
    hint: '评审结论里的修正建议逐条落到画布上，改完可以再评一次',
    cta: '继续画布',
  }
}