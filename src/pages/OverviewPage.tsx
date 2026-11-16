import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, Download, Eye, History, LayoutTemplate, Plus, RefreshCw, RotateCcw, Search, Send, Share2, Workflow, X } from 'lucide-react'
import type { Page } from '../domain/types'
import PageHead from '../components/PageHead'
import { Pill, Tag } from '../components/ui'
import { request } from '../api/client'
import { listBdcCanvases, type BdcCanvas } from '../api/bdc'
import type { RunProjectRef } from '../api/flows'
import {
  closeDeliveryWait,
  deliverablePrintUrl,
  deliveryPackageUrl,
  listDeliveries,
  listProjects,
  listShares,
  issueReceiptLink,
  receiptLinkUrl,
  relinkDelivery,
  remindDelivery,
  resendDelivery,
} from '../api/projects'
import {
  ackReview,
  listReviewQueue,
  unackReview,
  type ReviewQueueDecidedRow,
  type ReviewQueueFacets,
  type ReviewQueueRange,
  type ReviewQueueRow,
  type ReviewQueueSeenRow,
} from '../api/review'
import {
  deliveredCurrent,
  ledgerReceiptText,
  ledgerReceiptTotalsText,
  projectStatus,
  reviewsForVersion,
  type DeliveryLedgerReceipts,
  type DeliveryPerson,
  type ProjectDeliveryRow,
  type ProjectSummary,
  type ShareSummaryRow,
} from '../domain/project'
import { isFirstRun } from '../domain/first-run'
import {
  deliveryChannelText,
  deliveryLateText,
  deliveryNagLate,
  deliveryReminderText,
  deliveryWaitClosedHint,
  deliveryWaitClosedLead,
  deliveryWaitClosedTotalText,
  deliveryWaitDays,
  deliveryWaitLate,
  deliveryWaitText,
  deliveryWaitToggleHint,
  deliveryWaitToggleLabel,
  monthDayText,
} from '../domain/delivery-wait'
import { deliveryOpenHint, deliveryOpenShort, deliveryUnopenedText } from '../domain/delivery-open'
import {
  deliveryResendHint,
  deliveryResendMessage,
  deliveryResendText,
  deliveryStuckText,
} from '../domain/delivery-resend'
import {
  deliveryRelinkCappedText,
  deliveryRelinkHint,
  deliveryRelinkMessage,
  deliveryRelinkText,
  deliveryRelinkedText,
} from '../domain/delivery-relink'
import { deliveryAskMessage } from '../domain/delivery-ask'
import { deliveryAckedText, deliveryAckHint, deliveryAckLead } from '../domain/delivery-ack'
import { recipientText, recipientTitle } from '../domain/delivery-recipient'
import { replyRowText, replyRowTitle } from '../domain/delivery-reply'
import { peopleLeadText, personNagOutText, personSummary, personTitle, personWaitText, unlabeledText } from '../domain/delivery-people'
import { deliveryRetiredHitHint, deliveryRetiredHitText } from '../domain/delivery-retired-hit'
import {
  REVIEW_VERDICT_LABEL,
  deliveryDrift,
  deliveryDriftText,
  issueLine,
  reviewTimeLabel,
  type DeliveryDrift,
} from '../domain/review'
import { runLiveText, runStatusMeta, runWorkLine } from '../domain/run'
import { stampTime, visitLine } from '../domain/share'
import { useSiteInfo, useUiMode } from '../api/app'
import '../styles/overview.css'

/** 服务端一页 8 条（v0.9.32）：整块重取时按这个数往前铺页，不把翻到的行弄丢。 */
const LEDGER_PAGE_SIZE = 8

/** 回执那几个数的「全是零」（v0.9.159）：读不到时用它，界面各处不必各写一份。 */
const EMPTY_RECEIPTS: DeliveryLedgerReceipts = {
  sealed: 0,
  matched: 0,
  mismatched: 0,
  unclear: 0,
  pending: 0,
  pendingLate: 0,
  pendingUnopened: 0,
  pendingStuck: 0,
  pendingRelinked: 0,
  pendingAcked: 0,
  waitClosed: 0,
}

/** 交出去之后这一版又被评过：与作品页、交付稿是同一份规则，只多一句跟在交时评审后面（v0.9.86）。 */
function DeliveryDriftNote({ drift }: { drift: DeliveryDrift | null }) {
  if (!drift) return null
  return <span className={'vq-delivery-drift is-' + drift.tone}>{' · ' + deliveryDriftText(drift)}</span>
}

type RunRow = {
  id: string
  flowName: string
  status: string
  startedAt: string
  queuedAt?: string | null
  durationMs: number
  // 这条运行挂在哪条作品的哪一版；空白画布直接跑的是 null
  project?: RunProjectRef | null
}

type TemplateRow = {
  id: string
  title: string
  contentType?: string
  createdAt?: string
  durationSec?: number
}

type Props = {
  userName: string
  onNavigate: (page: Page) => void
  // 工作台列的是画布服务里的画布项目：点哪块就开哪块，不再只是跳到画布页
  onOpenCanvas: (canvasId: string) => void
  // 作品是主线：有作品时主卡先给「继续这个作品」，没有才退回最近改动的画布
  // 第二个参数（v0.9.140）：交出去的清单点一行，带着那条交付记录落在作品页的档案上
  onOpenProject: (projectId: string, deliveryId?: string) => void
  // 空白画布：直接建一块并进去，不再先弹「智能体 / 资产画布」二选一（那个弹窗把主价值藏起来了）
  onCreateCanvas: () => void
  // 引导是弹窗：页脚「上手指引」重新打开它，不再跳一个 #/welcome 页面
  onOpenGuide: () => void
  // 复制提醒之后说一声（v0.9.144）：复制成功 / 失败都得让人知道，不然不知道剪贴板里有没有东西
  onToast: (message: string) => void
}

// 队列的三个时间范围（v0.9.25）：按那次评审的时间算，不是作品最近被点开的时间——
// 「等你看」等的是结论出来的那一刻。
const QUEUE_RANGES: { value: ReviewQueueRange; label: string; hint: string }[] = [
  { value: 'all', label: '全部时间', hint: '等你看的全列出来，按评审时间倒序' },
  { value: '7d', label: '7 天内', hint: '只看最近 7 天评出意见的' },
  { value: '30d', label: '30 天内', hint: '只看最近 30 天评出意见的' },
]

// 队列一页 20 条、最多翻 10 页（v0.9.27）：一页一页往后取，翻到底才说「都列出来了」。
// 200 条的顶是给「一次点开几百行」兜底：真到那儿了，用搜索或时间范围收窄比继续翻更省事。
const QUEUE_PAGE_SIZE = 20
const QUEUE_MAX_PAGES = 10

const pad2 = (value: number) => String(value).padStart(2, '0')

// 新账号第一屏（v0.9.42）：这四块都挂在作品上，手上还没有作品时必然是空的。
// 与其在空账号上铺四个「还没有」，不如先说清它们什么时候出现——顺序就是主线的顺序。
const FIRST_RUN_BLOCKS = [
  { key: 'review', icon: Eye, title: '评审等你看的', when: '评过一版画面、结论是「需人工确认」或「不通过」的作品排在这里；点一行进作品改一版。' },
  { key: 'delivery', icon: Send, title: '交出去的', when: '在作品页点「交付这一版」；每一版按时间留在这儿，交付稿随时能打开。' },
  { key: 'runs', icon: History, title: '最近运行', when: '画布跑一次运行，这里列出节点耗时与返回，并标出它挂在哪条作品上。' },
  { key: 'shares', icon: Share2, title: '分享出去的链接', when: '发给甲方的只读链接，这里汇总每条被打开过几次，停用之后也留着。' },
] as const

// 页头日期用「2026-11-10 周二」：等宽数字对齐，比「2026 年 11 月 10 日 · 星期二」短一半，
// 也不会因为中文和数字混排被拉出一段虚的字距。
function todayLabel(date: Date): string {
  const iso = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)
  return `${iso} ${weekday}`
}

function clockOf(input?: string | number): string {
  const date = typeof input === 'number' ? new Date(input) : new Date(String(input ?? ''))
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

function secondsOf(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return (ms / 1000).toFixed(1) + 's'
}

/**
 * 这一行「等了多久」（v0.9.144）：还没收到回执的那一份，发出几天了。
 * 时间没记下的老记录就什么都不说——不拿作品更新日期冒充发出时间。
 */
function rowWaitText(row: ProjectDeliveryRow): string {
  return row.atKnown ? deliveryWaitText(row.at) : ''
}

/** 到了该提一句的时候没有：第三天以上才说（与清单顶上那句同一个门槛）。 */
function rowWaitLate(row: ProjectDeliveryRow): boolean {
  return row.atKnown && deliveryWaitLate(row.at)
}

/** 催过几次：只写次数，日期放在 title 里，一行里不堆两个时间。 */
function rowReminderText(row: ProjectDeliveryRow): string {
  const count = Math.max(0, Math.round(Number(row.reminder?.count) || 0))
  return count ? '催过 ' + count + ' 次' : ''
}

/** 那一行催过没有、最近一次哪天：给 title 用，不占行宽。 */
function rowReminderTitle(row: ProjectDeliveryRow): string {
  const at = String(row.reminder?.at || '')
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return '最近一次 ' + (date.getMonth() + 1) + '-' + date.getDate()
}

/**
 * 催过、三天以上还没动静（v0.9.157）：再发一遍一模一样的话多半还是没动静。
 * 判据与上面那句「等了几天」同一个门槛（REMIND_LATE_DAYS），只是从最近一次催收算起；
 * 没记催收时间的旧行不算——不知道哪天催的，就别说「催了几天没动静」。
 */
function rowNagLate(row: ProjectDeliveryRow): boolean {
  const at = String(row.reminder?.at || '')
  if (!Number.isFinite(Date.parse(at))) return false
  return deliveryNagLate(at)
}

/**
 * 「换个渠道问」那枚按钮的 title：把这一行为什么换动作说清，也先把这一段的边界说清——
 * 它只复制，不记进「催过几次」：换个渠道发没发，这边没法替你记。
 */
function rowChannelTitle(row: ProjectDeliveryRow): string {
  const at = String(row.reminder?.at || '')
  const count = Math.max(0, Math.round(Number(row.reminder?.count) || 0))
  const days = deliveryWaitDays(at)
  const when = monthDayText(at)
  return (
    '已经催过' + (count ? ' ' + count + ' 次' : '') +
    (when ? '，最近 ' + when : '') +
    (days === null ? '' : '，' + days + ' 天还没动静') +
    '：再发一遍一模一样的话多半还是没动静，换成问一句收到没有、要不要换种发法（直接发文件 / 发邮箱）。' +
    '这一段只复制，不记进「催过几次」——换了渠道发没发，这边没法替你记。'
  )
}

/**
 * 又发过几次（v0.9.146）：链接一次都没被打开过时，把这条地址重新发出去的那几次。
 * 与「催过」分成两段写：一个问验没验，一个问收没收到。
 */
function rowResendText(row: ProjectDeliveryRow): string {
  return deliveryResendText(row.resend)
}

/**
 * 换过几次链接（v0.9.147）：换掉一条地址之后，重发次数从零算起，
 * 所以这一行要能同时写「换过 1 次链接」和「又发过 1 次」，两个数说的是两条不同的地址。
 */
function rowRelinkText(row: ProjectDeliveryRow): string {
  return deliveryRelinkText(row.relink)
}

/**
 * 换掉的那条旧地址还被点过几次（v0.9.149）：换完地址之后，新地址的「0 次打开」
 * 分不出「没送到」和「送到了没理」；旧的这条还在被点，说的就是前一种。
 * 单独一段、单独一个类名：这一句带着下一步动作，不该混在「又发过几次」的字堆里。
 */
function rowRetiredHitText(row: ProjectDeliveryRow): string {
  return deliveryRetiredHitText(row.retiredHits)
}

/**
 * 换到头了（v0.9.150）：换过两次地址、还是一次都没被打开，这一行多写一段状态。
 * 它解释的是「为什么按钮没了」——不然用户只会觉得工具把功能拿走了。
 */
function rowRelinkCappedText(row: ProjectDeliveryRow): string {
  return row.relinkCapped ? deliveryRelinkCappedText(row.relink) : ''
}

/**
 * 他点过「收到了」没有（v0.9.151）：有这一句的时候，行首那句「还没收到回执」
 * 换成「他点了「收到了」，收据还没贴」——不然一行里同时写着「还没收到回执」和
 * 「他点了「收到了」」，读起来像两件事打架。
 */
/**
 * 你自己把这一份收口了没有（v0.9.158）：收口之后这一行不再说「还没收到回执」——
 * 回执确实没回来，但不欠着了。两件事混成一句，清单上就永远看不出哪一条已经了结。
 */
function rowWaitClosed(row: ProjectDeliveryRow): boolean {
  return Boolean(row.waitClosed?.at)
}

function rowPendingLead(row: ProjectDeliveryRow): string {
  // 收口优先于「他点了收到了」：手上有更晚的决定时，先说这个
  if (rowWaitClosed(row)) return deliveryWaitClosedLead()
  return deliveryAckLead(row.ack) || '还没收到回执'
}

/**
 * 还没收到回执那一行的 title：等了几天、这条地址送到没有、催过 / 重发过 / 换过几次、
 * 旧地址还在不在被点，合成一句。
 * 换到头了（v0.9.150）就不再提「再发一次」「换一条新链接」：这两件事这一行已经不给做了，
 * 留在 title 里只会让人去找一个不存在的按钮。
 */
function rowPendingTitle(row: ProjectDeliveryRow): string {
  // 自己收口的那一条（v0.9.158）：只说收口这件事，不再把「催过几次 / 打开过几次」堆上来——
  // 那些是等待期间的账，等已经结束了
  if (rowWaitClosed(row)) return deliveryWaitClosedHint(String(row.waitClosed?.at || ''))
  const capped = Boolean(row.relinkCapped)
  // 他点过「收到了」（v0.9.151）：这一行从此不再谈「送没送到」——
  // 东西到他手上了，缺的只是验。换地址、再发一遍都不是他此刻的问题，title 里提了只会让人去找按钮。
  const acked = Boolean(row.ack?.at)
  return (
    '封存包已经能贴回收据了，这一份还没收到' +
    (rowWaitText(row) ? '：' + rowWaitText(row) : '') +
    (rowWaitLate(row) ? '，可以提一句' : '') +
    // 先说「他点了收到了」，再谈打开过几次：「在验」比「打开过 2 次」更接近现在到哪一步
    (deliveryAckHint(row.ack) ? '。' + deliveryAckHint(row.ack) : '') +
    (!capped && !acked && deliveryOpenHint(row.visits) ? '。' + deliveryOpenHint(row.visits) : '') +
    (!capped && !acked && deliveryResendHint(row.resend) ? '。' + deliveryResendHint(row.resend) : '') +
    (!acked && deliveryRelinkHint(row.relink) ? '。' + deliveryRelinkHint(row.relink) : '') +
    (!acked && deliveryRetiredHitHint(row.retiredHits) ? '。' + deliveryRetiredHitHint(row.retiredHits) : '') +
    (rowReminderTitle(row) ? '。' + rowReminderTitle(row) : '')
  )
}

/**
 * 工作台只回答一个问题：下一步点哪里。
 * 首屏是一张「下一步」主卡（继续上次那块画布，没画布就从一条爆款开始）加三个场景化入口；
 * 统计压进主卡右侧，不再单开一排数字卡——数字是背景，不是任务。
 * 任何一块没有数据就写空状态并给出下一步，不用示例行填充。
 */
export function OverviewPage({ userName, onNavigate, onOpenCanvas, onOpenProject, onCreateCanvas, onOpenGuide, onToast }: Props) {
  const { internal } = useUiMode()
  const site = useSiteInfo()
  const [now] = useState(() => new Date())
  const [canvases, setCanvases] = useState<BdcCanvas[]>([])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  // 工作台的分享汇总：一条作品一行，累计各轮打开情况（v0.9.12）
  const [shares, setShares] = useState<ShareSummaryRow[]>([])
  const [shareTotals, setShareTotals] = useState({ total: 0, opens: 0 })
  // 评审队列：最近一次结论是需人工确认 / 不通过的作品，按评审时间倒序（v0.9.19）
  const [queue, setQueue] = useState<ReviewQueueRow[]>([])
  const [queueTotal, setQueueTotal] = useState(0)
  // 不带筛选的全量：筛着的时候仍然写「全部还有 N 条」，不拿筛出来的数冒充全部（v0.9.25）
  const [queueAllTotal, setQueueAllTotal] = useState(0)
  // 时间范围的计数按关键字算、不按当前范围算：换一个范围，另一排数字仍然是真的
  const [queueFacets, setQueueFacets] = useState<ReviewQueueFacets>({ all: 0, '7d': 0, '30d': 0 })
  // 不跟着筛选变的最新一条：上面那张「下一步」主卡读它，筛列表不会把主卡换掉（v0.9.25）
  const [queueLead, setQueueLead] = useState<ReviewQueueRow | null>(null)
  // 队列的两种找法：时间范围 + 作品标题关键字；在服务端筛，不在这一屏里筛 20 条
  const [queueRange, setQueueRange] = useState<ReviewQueueRange>('all')
  const [queueKeyword, setQueueKeyword] = useState('')
  const queueSearchRef = useRef<HTMLInputElement | null>(null)
  // 看过了、这一版先不改的：还在作品里，但不催了（v0.9.20）
  const [seen, setSeen] = useState<ReviewQueueSeenRow[]>([])
  const [seenTotal, setSeenTotal] = useState(0)
  // 人已经拍过板的：结论按人的走，工作台留一行交代它去了哪（v0.9.21）
  const [decided, setDecided] = useState<ReviewQueueDecidedRow[]>([])
  const [decidedTotal, setDecidedTotal] = useState(0)
  // 看过的 / 拍过板的点开就是整份清单（v0.9.28）：默认收着，不当成两串常驻列表
  const [seenOpen, setSeenOpen] = useState(false)
  const [decidedOpen, setDecidedOpen] = useState(false)
  // 首屏只排 3 条，第 4 条以后不能凭空消失：给一行「还有 N 条」，点开把已取回的行都排出来
  const [queueOpen, setQueueOpen] = useState(false)
  // 已经取到第几页（v0.9.27）：点一次「再看 N 条」加一页；换筛选回到第一页
  const [queuePages, setQueuePages] = useState(1)
  // 正在取下一页：按钮禁用，防连点
  const [queueBusy, setQueueBusy] = useState(false)
  // 正在「已看过 / 撤销」的那条作品：按钮转圈并禁用，防连点
  const [ackBusy, setAckBusy] = useState('')
  const [queueError, setQueueError] = useState('')
  // 交出去的（v0.9.32）：跨作品把每一次交付摊成一条线。
  // 首屏先排 3 条，点开排到已经取回的一页（8 条），再往下按 offset 接着取——
  // 「我交出去过什么」不该只给最近一条，也不该只在作品页里一条一条翻。
  const [deliveries, setDeliveries] = useState<ProjectDeliveryRow[]>([])
  const [deliveryTotal, setDeliveryTotal] = useState(0)
  const [deliverySummary, setDeliverySummary] = useState({ projects: 0, current: 0, drifted: 0, lastAt: '' })
  // 回执的四个数（v0.9.139）：封过包的几次、对上几次、对不上几次、还没回来几次
  const [deliveryReceipts, setDeliveryReceipts] = useState<DeliveryLedgerReceipts>({ ...EMPTY_RECEIPTS })
  // 按人看（v0.9.154）：谁还欠着回执。整份记录的账，不随分页变；
  // 没写收件人的那些只给一个数，不猜是谁，也不混进任何人名下。
  const [deliveryPeople, setDeliveryPeople] = useState<DeliveryPerson[]>([])
  const [deliveryUnlabeled, setDeliveryUnlabeled] = useState(0)
  const [deliveryHasMore, setDeliveryHasMore] = useState(false)
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [deliveryBusy, setDeliveryBusy] = useState(false)
  const [deliveryError, setDeliveryError] = useState('')
  // 正在写「催一句」的那一条（v0.9.144）：按钮转圈并禁用，防连点
  const [remindBusy, setRemindBusy] = useState('')
  // 正在写「再发一次」的那一条（v0.9.146）：与催一句分开，两个按钮不会同时转
  const [resendBusy, setResendBusy] = useState('')
  // 正在换一条新链接的那一条（v0.9.147）：换的是地址，写盘之后旧地址立刻打不开
  const [relinkBusy, setRelinkBusy] = useState('')
  // 正在写「问他一句」的那一条（v0.9.150）：只复制、不写盘，所以只防连点
  const [askBusy, setAskBusy] = useState('')
  // 正在收口 / 继续等的那一条（v0.9.159）：写盘一次，等它回来再让点第二次
  const [waitBusy, setWaitBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    const problems: string[] = []
    // 队列不在这里取：它跟着筛选项走，由下面那个 effect 单独刷新（首屏也走那一处）
    const [canvasResult, runResult, templateResult, projectResult, shareResult, deliveryResult] = await Promise.allSettled([
      listBdcCanvases(),
      request<{ items: RunRow[] }>('/api/runs'),
      request<{ items: TemplateRow[] }>('/api/templates'),
      listProjects(),
      listShares(),
      listDeliveries(),
    ])
    if (canvasResult.status === 'fulfilled' && canvasResult.value.ok) {
      setCanvases(canvasResult.value.canvases ?? [])
    } else {
      setCanvases([])
      problems.push('画布列表：' + (canvasResult.status === 'rejected' ? String((canvasResult.reason as Error)?.message || canvasResult.reason) : canvasResult.value.error || '读取失败'))
    }
    if (runResult.status === 'fulfilled') {
      setRuns(runResult.value.items ?? [])
    } else {
      setRuns([])
      problems.push('运行记录：' + String((runResult.reason as Error)?.message || runResult.reason))
    }
    if (templateResult.status === 'fulfilled') {
      setTemplates(templateResult.value.items ?? [])
    } else {
      setTemplates([])
      problems.push('模板库：' + String((templateResult.reason as Error)?.message || templateResult.reason))
    }
    if (projectResult.status === 'fulfilled') {
      setProjects(projectResult.value.items ?? [])
    } else {
      setProjects([])
      problems.push('作品：' + String((projectResult.reason as Error)?.message || projectResult.reason))
    }
    if (shareResult.status === 'fulfilled') {
      setShares(shareResult.value.items ?? [])
      setShareTotals({ total: shareResult.value.total ?? 0, opens: shareResult.value.opens ?? 0 })
    } else {
      setShares([])
      setShareTotals({ total: 0, opens: 0 })
      problems.push('分享记录：' + String((shareResult.reason as Error)?.message || shareResult.reason))
    }

    if (deliveryResult.status === 'fulfilled') {
      setDeliveries(deliveryResult.value.items ?? [])
      setDeliveryTotal(deliveryResult.value.total ?? 0)
      setDeliverySummary({
        projects: deliveryResult.value.projects ?? 0,
        current: deliveryResult.value.currentTotal ?? 0,
        drifted: deliveryResult.value.drifted ?? 0,
        lastAt: deliveryResult.value.lastAt || '',
      })
      setDeliveryHasMore(Boolean(deliveryResult.value.hasMore))
      setDeliveryReceipts(deliveryResult.value.receipts ?? { ...EMPTY_RECEIPTS })
      setDeliveryPeople(deliveryResult.value.people ?? [])
      setDeliveryUnlabeled(Number(deliveryResult.value.unlabeled) || 0)
    } else {
      setDeliveries([])
      setDeliveryTotal(0)
      setDeliverySummary({ projects: 0, current: 0, drifted: 0, lastAt: '' })
      setDeliveryReceipts({ ...EMPTY_RECEIPTS })
      setDeliveryPeople([])
      setDeliveryUnlabeled(0)
      setDeliveryHasMore(false)
      problems.push('交付记录：' + String((deliveryResult.reason as Error)?.message || deliveryResult.reason))
    }

    setErrors(problems)
    setLoading(false)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  // 队列单独刷新：筛选项变了、看没看过变了、又翻了一页，都只重取这一块，不把整页五路请求重跑一遍。
  // 已经翻开几页就取几页（v0.9.27）：第 2 页之后刷新一次也要把前面的行一起取回来，
  // 否则「第 1 行已看过」拿掉后行整体前移，拼出来的列表会缺一条。
  const refreshQueue = useCallback(async () => {
    const pages = Math.max(1, Math.min(QUEUE_MAX_PAGES, Math.round(Number(queuePages) || 1)))
    setQueueBusy(true)
    try {
      const results = await Promise.all(
        Array.from({ length: pages }, (_, index) =>
          listReviewQueue(QUEUE_PAGE_SIZE, { range: queueRange, q: queueKeyword, offset: index * QUEUE_PAGE_SIZE }),
        ),
      )
      const first = results[0]
      // 按页顺序拼、按作品去重：翻页途中有人「已看过」时，相邻两页可能返回同一行
      const seenIds = new Set<string>()
      const rows: ReviewQueueRow[] = []
      for (const result of results) {
        for (const row of result.items ?? []) {
          if (seenIds.has(row.projectId)) continue
          seenIds.add(row.projectId)
          rows.push(row)
        }
      }
      setQueue(rows)
      setQueueTotal(first.total ?? 0)
      setQueueAllTotal(first.allTotal ?? 0)
      setQueueFacets(first.facets ?? { all: 0, '7d': 0, '30d': 0 })
      setQueueLead(first.lead ?? null)
      setSeen(first.seen ?? [])
      setSeenTotal(first.seenTotal ?? 0)
      setDecided(first.decided ?? [])
      setDecidedTotal(first.decidedTotal ?? 0)
      setQueueError('')
    } catch (error) {
      setQueueError('评审队列：' + String((error as Error)?.message || error))
    } finally {
      setQueueBusy(false)
    }
  }, [queueKeyword, queuePages, queueRange])

  // 换范围立刻问、打字等 220ms 再问；首屏不带筛选，也从这一处取
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshQueue()
    }, queueKeyword ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [queueKeyword, queueRange, refreshQueue])

  // 交付流水往下取（v0.9.32）：只取下一页，按「作品 + 版次」去重——
  // 翻页途中又交了一版时，相邻两页可能返回同一行。
  const loadMoreDeliveries = useCallback(async () => {
    if (deliveryBusy) return
    setDeliveryBusy(true)
    try {
      const next = await listDeliveries(deliveries.length)
      const seen = new Set(deliveries.map((row) => row.projectId + ':' + row.version))
      const merged = [...deliveries]
      for (const row of next.items ?? []) {
        const key = row.projectId + ':' + row.version
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(row)
      }
      setDeliveries(merged)
      setDeliveryHasMore(Boolean(next.hasMore))
      setDeliveryTotal(next.total ?? merged.length)
      setDeliverySummary({ projects: next.projects ?? 0, current: next.currentTotal ?? 0, drifted: next.drifted ?? 0, lastAt: next.lastAt || '' })
      setDeliveryReceipts((prev) => next.receipts ?? prev)
      setDeliveryError('')
    } catch (error) {
      setDeliveryError('再往下没取到：' + String((error as Error)?.message || error))
    } finally {
      setDeliveryBusy(false)
    }
  }, [deliveries, deliveryBusy])

  /**
   * 收口 / 继续等之后，把这一块重新问一遍（v0.9.159）。
   *
   * 为什么不自己加减：清单顶上那几个数（封过包的、回来了的、还没回来的、不再等的）与
   * 「按人看」都是服务端按整份记录算的，一条收口还会牵动「超过三天 / 链接没打开」这些子集。
   * 界面自己减错一个数，比多取一次请求糟得多。已经翻开几页就取几页，翻到哪儿不会因此缩回第一页。
   */
  const refreshLedger = useCallback(async (keep: number) => {
    const pages = Math.max(1, Math.ceil(Math.max(keep, 1) / LEDGER_PAGE_SIZE))
    const results = await Promise.all(
      Array.from({ length: pages }, (_, index) => listDeliveries(index * LEDGER_PAGE_SIZE)),
    )
    const first = results[0]
    const seen = new Set<string>()
    const rows: ProjectDeliveryRow[] = []
    for (const result of results) {
      for (const row of result.items ?? []) {
        const key = row.projectId + ':' + row.version
        if (seen.has(key)) continue
        seen.add(key)
        rows.push(row)
      }
    }
    setDeliveries(rows)
    setDeliveryTotal(first.total ?? rows.length)
    setDeliverySummary({
      projects: first.projects ?? 0,
      current: first.currentTotal ?? 0,
      drifted: first.drifted ?? 0,
      lastAt: first.lastAt || '',
    })
    setDeliveryReceipts(first.receipts ?? { ...EMPTY_RECEIPTS })
    setDeliveryPeople(first.people ?? [])
    setDeliveryUnlabeled(Number(first.unlabeled) || 0)
    setDeliveryHasMore(rows.length < (first.total ?? rows.length))
  }, [])

  // 交付稿在新标签里打开：与作品页同一个地址，纸的样式只写一处（v0.9.32）。
  // 被浏览器拦下就如实说一句，不假装打开了。
  const openDeliverable = useCallback((projectId: string) => {
    const opened = window.open(deliverablePrintUrl(projectId), '_blank', 'noopener')
    setDeliveryError(opened ? '' : '新标签被浏览器拦下了：允许本站弹窗，或者从作品页打开交付稿')
  }, [])

  /**
   * 催一句（v0.9.144）：还没收到回执的那一份，把「哪一份、哪天发的、打开包里那张校验页怎么验、
   * 收据贴回哪条链接」拼成一段能直接发的话复制走，顺手在档案里记下这一次。
   * 复制失败也如实说：这一段没进剪贴板，但档案里已经记了一次，去作品页还能再复制回执链接。
   */
  const copyDeliveryReminder = useCallback(
    async (row: ProjectDeliveryRow) => {
      const deliveryId = String(row.deliveryId || '')
      if (!deliveryId) return
      const key = row.projectId + ':' + row.version
      setRemindBusy(key)
      try {
        const issued = await remindDelivery(row.projectId, deliveryId)
        const text = deliveryReminderText({
          title: row.title,
          version: row.version,
          fileName: row.package?.fileName,
          bytes: row.package?.bytes,
          at: row.at,
          link: receiptLinkUrl(issued.token),
          // 这一条是给谁的（v0.9.152）：写了就用称呼开头，没写就不加
          recipient: row.recipient,
        })
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          setDeliveryError('这一段没复制进剪贴板：浏览器没给权限。档案里已经记了这一次，回执链接到作品页那一版还能再复制。')
          return
        }
        setDeliveries((prev) =>
          prev.map((entry) =>
            entry.projectId === row.projectId && entry.version === row.version
              ? { ...entry, reminder: { count: issued.count, at: issued.at } }
              : entry,
          ),
        )
        setDeliveryError('')
        onToast('已复制：提醒他验包的那一段，带回收据链接')
      } catch (error) {
        setDeliveryError('没催成：' + String((error as Error)?.message || error))
      } finally {
        setRemindBusy('')
      }
    },
    [onToast],
  )

  /**
   * 换个渠道问一句（v0.9.157）：催过几次、三天以上还没动静的那一行，这一枚按钮换成它。
   *
   * 为什么不再用「复制提醒」：同一段「打开校验.html 拖进去」发到第四遍，问题多半不在他忘了，
   * 而在这条消息根本没送到他手上——再发一遍一样的话，只是把同一个失败重演一次。
   *
   * 这一段只复制、不记进「催过几次」：换了渠道发没发，这边没法替你记；
   * 记一笔假的「又催过」，会让那一枚上的「催完几天没动静」从头再算，就把「一直没动静」这件事抹掉了。
   */
  const copyDeliveryChannel = useCallback(
    async (row: ProjectDeliveryRow) => {
      const text = deliveryChannelText({
        title: row.title,
        version: row.version,
        at: row.at,
        recipient: row.recipient,
      })
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        setDeliveryError('这一段没复制进剪贴板：浏览器没给权限。可以到作品页那一版里复制回执链接，或者换一个浏览器再试。')
        return
      }
      setDeliveryError('')
      onToast('已复制：问一句收到没有、要不要换种发法（没记成催过）')
    },
    [onToast],
  )

  /**
   * 再发一次链接（v0.9.146）：这条地址一次都没被打开过时，把同一条地址重新发一次。
   * 复制的是一段「可能没收到」的话（不是催验），并且留一句「这条也打不开就说一声」——
   * 下一次该换渠道还是换人，全靠这句回来的答案。档案里另记一个数，与催过分开。
   */
  const copyDeliveryResend = useCallback(
    async (row: ProjectDeliveryRow) => {
      const deliveryId = String(row.deliveryId || '')
      if (!deliveryId) return
      const key = row.projectId + ':' + row.version
      setResendBusy(key)
      try {
        const issued = await resendDelivery(row.projectId, deliveryId)
        const text = deliveryResendMessage({
          title: row.title,
          version: row.version,
          fileName: row.package?.fileName,
          bytes: row.package?.bytes,
          at: row.at,
          link: receiptLinkUrl(issued.token),
          recipient: row.recipient,
        })
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          setDeliveryError('这一段没复制进剪贴板：浏览器没给权限。档案里已经记了这一次，回执链接到作品页那一版还能再复制。')
          return
        }
        setDeliveries((prev) =>
          prev.map((entry) =>
            entry.projectId === row.projectId && entry.version === row.version
              ? { ...entry, resend: { count: issued.count, at: issued.at } }
              : entry,
          ),
        )
        setDeliveryError('')
        onToast('已复制：再发一次回执链接的那一段，带回了同一条链接')
      } catch (error) {
        setDeliveryError('没发成：' + String((error as Error)?.message || error))
      } finally {
        setResendBusy('')
      }
    },
    [onToast],
  )

  /**
   * 换一条新链接（v0.9.147）：同一条地址又发过两次还是没人打开，说明问题不在「他忘了」——
   * 换一枚新 token，旧地址立刻失效，打开次数与「又发过几次」都从零算起（旧账折进「换过几次链接」）。
   * 只换地址不换包；也不替人把消息发出去，发还是发件人自己发。
   */
  const copyDeliveryRelink = useCallback(
    async (row: ProjectDeliveryRow) => {
      const deliveryId = String(row.deliveryId || '')
      if (!deliveryId) return
      const key = row.projectId + ':' + row.version
      setRelinkBusy(key)
      try {
        const issued = await relinkDelivery(row.projectId, deliveryId)
        const text = deliveryRelinkMessage({
          title: row.title,
          version: row.version,
          fileName: row.package?.fileName,
          bytes: row.package?.bytes,
          at: row.at,
          link: receiptLinkUrl(issued.token),
          recipient: row.recipient,
        })
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          setDeliveryError('这一段没复制进剪贴板：浏览器没给权限。地址已经换了，回执链接到作品页那一版还能再复制。')
          return
        }
        setDeliveries((prev) =>
          prev.map((entry) =>
            entry.projectId === row.projectId && entry.version === row.version
              ? {
                  ...entry,
                  relink: { count: issued.count, at: issued.at, resends: issued.resendsBefore },
                  // 新地址还没发过：两个数都回到起点，按钮也跟着变回「再发一次链接」
                  resend: null,
                  resendable: true,
                  relinkable: false,
                }
              : entry,
          ),
        )
        setDeliveryError('')
        onToast('已复制：换过地址的那一段（旧链接已作废）')
      } catch (error) {
        setDeliveryError('没换成：' + String((error as Error)?.message || error))
      } finally {
        setRelinkBusy('')
      }
    },
    [onToast],
  )

  /**
   * 问他一句（v0.9.150）：换过两次地址、一条都没被打开，工具不再给换第三条——
   * 换的是 token，不是渠道。这里只做一件事：把现在这条地址带上，问一句「是不是没收到」。
   * 不换地址（rotate=false，旧的不作废）、不写盘、不记账：这一行已经写满了试过几次，
   * 再加一个「问过几次」只是把一行字变成账本。
   */
  const copyDeliveryAsk = useCallback(
    async (row: ProjectDeliveryRow) => {
      const deliveryId = String(row.deliveryId || '')
      if (!deliveryId) return
      const key = row.projectId + ':' + row.version
      setAskBusy(key)
      try {
        const current = await issueReceiptLink(row.projectId, deliveryId, false)
        const text = deliveryAskMessage({
          title: row.title,
          version: row.version,
          fileName: row.package?.fileName,
          bytes: row.package?.bytes,
          at: row.at,
          link: receiptLinkUrl(current.token),
          recipient: row.recipient,
        })
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          setDeliveryError('这一段没复制进剪贴板：浏览器没给权限。回执链接到作品页那一版还能再复制。')
          return
        }
        setDeliveryError('')
        onToast('已复制：问他收到没有的那一段，带上了现在这条地址（这一行不记数）')
      } catch (error) {
        setDeliveryError('没写出来：' + String((error as Error)?.message || error))
      } finally {
        setAskBusy('')
      }
    },
    [onToast],
  )
  /**
   * 收口 / 继续等（v0.9.159）：等待这件事的出口，现在也在工作台这一行上。
   *
   * 以前只能点进作品页、摊开那一版档案才能收口——可「这版作废了、不追了」这个念头，
   * 恰恰是在清单上看着那一行「还没收到回执」时冒出来的。收口只记一个时间：
   * 不碰包、不碰收据、不碰链接，也不清催过几次的账；点错了行尾就是「继续等」。
   */
  const toggleDeliveryWait = useCallback(
    async (row: ProjectDeliveryRow, closed: boolean) => {
      const deliveryId = String(row.deliveryId || '')
      if (!deliveryId) return
      const key = row.projectId + ':' + row.version
      setWaitBusy(key)
      try {
        const result = await closeDeliveryWait(row.projectId, deliveryId, closed)
        // 先把这一行改过来：胶囊、行首那句、动作同时换，不等整块重取回来才动
        setDeliveries((prev) =>
          prev.map((entry) =>
            entry.projectId === row.projectId && entry.version === row.version
              ? { ...entry, waitClosed: result.closed ? { at: result.at } : null }
              : entry,
          ),
        )
        onToast(closed ? '收口了：这一份不再算「还没回来」，档案与链接都照留' : '继续等这一份的回执了')
        await refreshLedger(deliveries.length)
      } catch (error) {
        const status = Number((error as { status?: number })?.status) || 0
        const code = String((error as { body?: { code?: string } })?.body?.code || '')
        if (status === 409 && code === 'RECEIPT_ALREADY') {
          // 这一份在别处已经收到回执了：收口 / 撤回都不再改它，把清单刷到最新给人看
          setDeliveryError('这一份已经有回执了：等的事已经结束，清单已经刷新到最新。')
          await refreshLedger(deliveries.length)
        } else {
          setDeliveryError('没改成：' + String((error as Error)?.message || error))
        }
      } finally {
        setWaitBusy('')
      }
    },
    [deliveries.length, onToast, refreshLedger],
  )
  const queueFiltered = queueRange !== 'all' || queueKeyword.trim() !== ''

  const resetQueueFilter = useCallback(() => {
    setQueueRange('all')
    setQueueKeyword('')
    setQueueOpen(false)
    // 换了找法就从第一页看起：不然会停在「第 2 页」而总数已经变了（v0.9.27）
    setQueuePages(1)
    queueSearchRef.current?.focus()
  }, [])

  // 与作品页同一套顺手键：`/` 聚焦搜索、`Esc` 清关键字；正在别处输入时不抢键
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      if (event.key === '/' && !editing && queueAllTotal > 0) {
        event.preventDefault()
        queueSearchRef.current?.focus()
        return
      }
      if (event.key === 'Escape' && target === queueSearchRef.current && queueKeyword) {
        setQueueKeyword('')
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [queueAllTotal, queueKeyword])

  // 已看过：只处理待办，不动评审结论——那条评审还在评审历史里，作品胶囊照旧
  const markSeen = useCallback(
    async (projectId: string) => {
      setAckBusy(projectId)
      try {
        await ackReview(projectId)
        await refreshQueue()
      } catch (error) {
        setQueueError('「已看过」没记上：' + String((error as Error)?.message || error))
      } finally {
        setAckBusy('')
      }
    },
    [refreshQueue],
  )

  const undoSeen = useCallback(
    async (projectId: string) => {
      setAckBusy(projectId)
      try {
        const result = await unackReview(projectId)
        // 一条都没撤掉就别说撤了：多半是刚在作品页撤过（或者别人先撤了）
        if (!result?.removed) setQueueError('撤销没撤掉：这条「已看过」已经不在了，可能刚在作品页撤过')
        await refreshQueue()
      } catch (error) {
        setQueueError('撤销没成功：' + String((error as Error)?.message || error))
      } finally {
        setAckBusy('')
      }
    },
    [refreshQueue],
  )

  // 队列先在页面上排 3 条：第 4 条以后由「还有 N 条」展开，展开的只是已经取回来的行。
  // 取回来的行数 < 总数时才轮到「已列 20 / 27 条 · 再看 7 条」（v0.9.27）。
  const visibleQueue = queueOpen ? queue : queue.slice(0, 3)
  // 收着的时候写的是「队列里还有几条」（总数 - 3），不是「已经取回来几条」：
  // 点开先把已取回的 20 条排出来，屏下再写「已列 20 / 27 条」——两句话各说各的事实，数字接得上
  const queueMore = queueOpen ? 0 : Math.max(0, queueTotal - 3)
  const queueRest = Math.max(0, queueTotal - queue.length)
  const queueNextPage = Math.min(QUEUE_PAGE_SIZE, queueRest)
  const queueMaxed = queueRest > 0 && queuePages >= QUEUE_MAX_PAGES

  // 交付流水首屏排 3 条；点开排到已经取回的那一页（8 条），再往下才是「再看 N 条」
  const visibleDeliveries = deliveryOpen ? deliveries : deliveries.slice(0, 3)
  const deliveryMore = deliveryOpen ? 0 : Math.max(0, deliveries.length - 3)
  const deliveryRest = Math.max(0, deliveryTotal - deliveries.length)
  const deliveryNextPage = Math.min(8, deliveryRest)
  // 旧版的交付稿不按那一版生成（交付稿只按当前版）：有一行旧版就得把这句话说出来
  const hasPastDelivery = deliveries.some((row) => !row.current)

  const recentRuns = runs.slice(0, 6)
  const recentTemplates = templates.slice(0, 4)

  // 「下一步」= 手上还没交付的那条作品；没有作品再看最近改动的画布；都没有就从一条爆款开始。
  // 作品优先是这次产品结构收敛的核心：作品才是那条内容，画布只是它的一步。
  const latestCanvas = useMemo(() => {
    if (!canvases.length) return undefined
    return [...canvases].sort((a, b) => new Date(String(b.updatedAt ?? 0)).getTime() - new Date(String(a.updatedAt ?? 0)).getTime())[0]
  }, [canvases])

  // 还没交出去的那条优先：交付了 v2 又开了 v3 的作品，就是要接着做的那条
  const latestProject = useMemo(
    () => projects.find((item) => !deliveredCurrent(item)) ?? projects[0],
    [projects],
  )

  // 评审给了意见、还没改的那条最该先看：它比「最近改过的作品」更接近「下一步点哪里」。
  // 队列里的第一条要和作品列表对得上（作品可能刚被删），对不上就往后找。
  // 主卡读服务端给的 lead（不带筛选的最新一条）：筛队列是「找」，不该顺手把「下一步」换掉
  const queuedProject = useMemo(() => {
    const byId = new Map(projects.map((item) => [item.id, item]))
    const project = queueLead ? byId.get(queueLead.projectId) : undefined
    return queueLead && project ? { row: queueLead, project } : null
  }, [queueLead, projects])

  const hero = useMemo(() => {
    const heroProject = queuedProject?.project ?? latestProject
    if (heroProject) {
      const reviews = reviewsForVersion(heroProject.versionCounts || {}, heroProject.version)
      const status = projectStatus(heroProject, reviews, heroProject.decision ?? null)
      // 待改的读队列那条（它是评审队列的口径），其余读这一版最近一次评审
      const reviewNote =
        queuedProject && queuedProject.project.id === heroProject.id
          ? '最近评审 ' + (REVIEW_VERDICT_LABEL[queuedProject.row.verdict] || '有结论') + ' · ' + reviewTimeLabel(queuedProject.row.at)
          : reviews.count
            ? '最近评审 ' + (REVIEW_VERDICT_LABEL[reviews.lastVerdict] || '未记结论') + ' · ' + reviewTimeLabel(reviews.lastAt)
            : '还没进评审'
      return {
        label: '下一步 · 作品 · ' + status.text,
        title: heroProject.title,
        meta: (heroProject.template ? '模板 · ' + heroProject.template.title + ' · ' : '') + reviewNote,
        cta: queuedProject && queuedProject.project.id === heroProject.id ? '按意见改这一版' : '继续这个作品',
        go: () => onOpenProject(heroProject.id),
      }
    }
    if (latestCanvas) {
      return {
        label: '下一步 · 画布',
        title: latestCanvas.name,
        meta: latestCanvas.nodeCount + ' 个节点 · 版本 r' + latestCanvas.revision + ' · 上次改动 ' + clockOf(latestCanvas.updatedAt),
        cta: '继续这块画布',
        go: () => onOpenCanvas(latestCanvas.id),
      }
    }
    return {
      label: '下一步 · 找一条能抄的',
      title: '从一条爆款开始',
      meta: '检索抖音与小红书的真实互动数据，挑一条拆出脚本与分镜',
      cta: '去检索',
      go: () => onNavigate('radar'),
    }
  }, [latestProject, queuedProject, latestCanvas, onOpenProject, onOpenCanvas, onNavigate])

  // 空账号的判定（v0.9.42）：六路都读到、并且都是 0 才算。读失败的时候宁可多铺一块空状态，
  // 也不能把一次服务故障说成「你还没做过」——判据在 domain/first-run.ts，那边有单测。
  const firstRun = !loading && isFirstRun({
    counts: {
      projects: projects.length,
      canvases: canvases.length,
      templates: templates.length,
      runs: runs.length,
      deliveries: deliveryTotal,
      shares: shares.length,
    },
    failed: errors.length,
  })

  return (
    <div className="vq-page">
      <PageHead
        kicker={
          <>
            <span>工作台</span>
            <span className="vq-head-sep" aria-hidden="true">·</span>
            <time dateTime={now.toISOString().slice(0, 10)}>{todayLabel(now)}</time>
          </>
        }
        title={loading ? '正在读取…' : firstRun ? '还没有作品' : '欢迎回来，' + userName}
        desc={
          loading
            ? '正在读取你账号下的画布、运行与模板。'
            : firstRun
              ? '一条内容从「发现」进来：检索一条 → 在模板库拆成脚本与分镜 → 开成作品改到能拍 → 交付这一版。今天先挑一条值得抄的，做完第一条，下面那些区块会自己出现。'
              : internal
                ? '首屏主卡读的是画布服务的最近改动；运行与模板分别来自 /api/runs 与 /api/templates。没有数据的区块写空状态，不放示例数据。'
                : '先看「下一步」，或者从下面三种方式开始一条新内容。'
        }
        actions={
          <>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => {
            void load()
            void refreshQueue()
          }}
          disabled={loading}>
              <RefreshCw size={14} />
              刷新
            </button>
            {/* 页头不再摆实心主按钮（v0.9.42）：工作台这一屏要回答「下一步点哪里」，
                而画布是作品里的一步。主按钮让给下面主卡的「去检索 / 继续这个作品」，
                建画布降成次要动作——它仍然在页头，只是不抢主位。 */}
            <button type="button" className="vq-button vq-button--ghost" onClick={onCreateCanvas}>
              <Plus size={14} />
              新建画布
            </button>
          </>
        }
      />

      {errors.length ? (
        <p className="vq-note vq-note--error" role="status">
          {errors.join('；')}
        </p>
      ) : null}

      <section className="vq-next" aria-labelledby="vq-next-title">
        <div className="vq-next-main">
          <span className="vq-next-label">{hero.label}</span>
          <h2 id="vq-next-title">{hero.title}</h2>
          <p className="vq-next-meta">{hero.meta}</p>
          <button type="button" className="vq-next-cta" onClick={hero.go}>
            {hero.cta}
            <ArrowRight size={15} />
          </button>
        </div>
        <dl className="vq-next-stats">
          <div>
            <dt>作品</dt>
            <dd>{projects.length}</dd>
          </div>
          <div>
            <dt>画布</dt>
            <dd>{canvases.length}</dd>
          </div>
          <div>
            <dt>模板</dt>
            <dd>{templates.length}</dd>
          </div>
        </dl>
      </section>

      {/* 空账号第一屏（v0.9.42）：评审 / 交付 / 运行 / 分享都挂在作品上，手上没有作品时必然是空的。
          与其铺四块「还没有」加三张空心开始卡，不如把「它们什么时候出现」讲清楚，主卡说下一步。 */}
      {firstRun ? (
        <section className="vq-section vq-first-run" aria-labelledby="vq-first-run-title">
          <div className="vq-section-head">
            <div>
              <h2 id="vq-first-run-title">做完第一条，这几块会自己出现</h2>
              <p className="vq-first-run-sub">
                它们不用先配好：评审、交付、运行、分享都挂在作品上——手上还没有作品，所以这里先不铺空的。
              </p>
            </div>
            <button type="button" className="vq-link" onClick={onOpenGuide}>
              看四步主线
              <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="vq-first-run-list">
            {FIRST_RUN_BLOCKS.map((entry) => {
              const Icon = entry.icon
              return (
                <div className="vq-first-run-row" key={entry.key}>
                  <span className="vq-first-run-icon"><Icon size={14} strokeWidth={1.75} /></span>
                  <span className="vq-first-run-copy">
                    <strong>{entry.title}</strong>
                    <span>{entry.when}</span>
                  </span>
                </div>
              )
            })}
          </div>
          <p className="vq-first-run-note">
            这一屏现在能做的只有一件事：从上面那张主卡进「发现」，按关键词检索一条值得抄的。
            检索与解析按次扣积分；开画布、导出与分享不扣积分。
          </p>
        </section>
      ) : (
        <>
      <section className="vq-section vq-review-queue" aria-labelledby="vq-review-queue-title">
        <div className="vq-section-head">
          <div>
            <h2 id="vq-review-queue-title">评审等你看的</h2>
            <p className="vq-review-queue-sub">
              {queueAllTotal
                ? '最近一次结论是「需人工确认」或「不通过」的作品，按评审时间排；点一条进作品改一版。'
                : seenTotal
                  ? '没有新的等你看；下面这些你看过了、这一版先没改。'
                  : decidedTotal
                    ? '没有新的等你看；这一条你已经拍过板，状态胶囊与下一步按你的结论走。'
                    : '评审给出意见的作品会排在这里；点一条进作品改一版，改完可以再评一次。'}
            </p>
          </div>
          <button type="button" className="vq-link" onClick={() => onNavigate('review')}>
            全部评审
            <ArrowUpRight size={13} />
          </button>
        </div>

        {/* 队列的找法（v0.9.25）：时间范围按那次评审的时间算、关键字只搜作品标题。
            在服务端筛——这一屏只有 20 条，只筛这 20 条会把「只列了最近 20 条」变成假话。 */}
        {queueAllTotal ? (
          <div className="vq-toolbar vq-review-queue-toolbar">
            <label className="vq-toolbar-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={queueSearchRef}
                type="search"
                value={queueKeyword}
                onChange={(event) => {
                  setQueueKeyword(event.target.value)
                  setQueueOpen(false)
                  setQueuePages(1)
                }}
                placeholder="搜索作品标题"
                aria-label="按作品标题搜索待办"
                autoComplete="off"
                spellCheck={false}
              />
              {queueKeyword ? (
                <button
                  type="button"
                  className="vq-toolbar-search-clear"
                  aria-label="清掉搜索"
                  title="清掉搜索（Esc）"
                  onClick={() => {
                    setQueueKeyword('')
                    queueSearchRef.current?.focus()
                  }}
                >
                  <X size={12} />
                </button>
              ) : (
                <kbd aria-hidden="true">/</kbd>
              )}
            </label>

            <div className="vq-filter-row" role="group" aria-label="按评审时间筛选">
              {QUEUE_RANGES.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  className={'vq-filter-chip' + (queueRange === entry.value ? ' is-active' : '')}
                  aria-pressed={queueRange === entry.value}
                  title={entry.hint}
                  onClick={() => {
                    setQueueRange(entry.value)
                    setQueueOpen(false)
                    setQueuePages(1)
                  }}
                >
                  {entry.label}
                  <span className="vq-filter-chip__count">{queueFacets[entry.value]}</span>
                </button>
              ))}
            </div>

            <p className="vq-toolbar-count">
              {queueFiltered ? (
                <>
                  筛出 <strong className="vq-mono">{queueTotal}</strong> / 全部 {queueAllTotal} 条
                </>
              ) : (
                <>共 {queueAllTotal} 条等你改</>
              )}
            </p>
            {queueFiltered ? (
              <button type="button" className="vq-toolbar-reset" onClick={resetQueueFilter}>
                清掉筛选
              </button>
            ) : null}
          </div>
        ) : null}

        {queueError ? (
          <p className="vq-note vq-note--error" role="status">
            {queueError}
          </p>
        ) : null}

        {queue.length ? (
          <>
            <div className="vq-review-queue-list">
              {visibleQueue.map((row) => (
              <div className="vq-review-queue-row" key={row.projectId}>
                <button
                  type="button"
                  className="vq-review-queue-open"
                  onClick={() => onOpenProject(row.projectId)}
                  aria-label={'打开作品：' + row.title + '，第 ' + Math.max(1, row.version) + ' 版'}
                >
                  <Pill tone={row.status.tone}>{row.status.text}</Pill>
                  <span className="vq-review-queue-copy">
                    <strong>{row.title}</strong>
                    <span className="vq-mono">
                      第 {Math.max(1, row.version)} 版 · 评过 {row.count} 次 ·{' '}
                      <span className="vq-review-queue-time">{reviewTimeLabel(row.at)}</span>
                    </span>
                  </span>
                  <ArrowRight size={13} />
                </button>
                <button
                  type="button"
                  className="vq-button vq-button--quiet vq-button--sm vq-review-queue-ack"
                  onClick={() => void markSeen(row.projectId)}
                  disabled={ackBusy === row.projectId}
                  title="看过了，这一版先不改：从待办里拿掉；这一版再评出结论，它会自己回来"
                >
                  <Eye size={12} />
                  已看过
                </button>
              </div>
              ))}
            </div>
          {/* 第 4 条以后不凭空消失：先写「还有 N 条」，点开把已取回的行都排出来 */}
          {queueMore ? (
            <button type="button" className="vq-link vq-review-queue-more" onClick={() => setQueueOpen(true)}>
              还有 {queueMore} 条等你改
              <ArrowRight size={12} />
            </button>
          ) : null}
          {/* 翻页（v0.9.27）：取回来的行数少于总数时给出口，翻到底才说「都列出来了」。
              只在展开之后出现——收着的时候屏上只有 3 行，写「已列 20 条」会是一句假话。
              之前这里只有一句「只列了最近 20 条，还有 N 条更早的等你改」，点不动。 */}
          {queueOpen && queueRest ? (
            <div className="vq-review-queue-pager">
              <span className="vq-review-queue-pager-count vq-mono">
                已列 <strong>{queue.length}</strong> / {queueTotal} 条
              </span>
              {queueMaxed ? (
                <span className="vq-review-queue-pager-hint">
                  一次最多列 {QUEUE_MAX_PAGES * QUEUE_PAGE_SIZE} 条：用上面的搜索或时间范围收窄
                </span>
              ) : (
                <button
                  type="button"
                  className="vq-button vq-button--quiet vq-button--sm"
                  onClick={() => setQueuePages((pages) => Math.min(QUEUE_MAX_PAGES, pages + 1))}
                  disabled={queueBusy}
                  title="接着往下排：一页 20 条"
                >
                  {queueBusy ? '正在取…' : '再看 ' + queueNextPage + ' 条'}
                  {queueBusy ? null : <ArrowRight size={12} />}
                </button>
              )}
            </div>
          ) : queueOpen && queuePages > 1 ? (
            <p className="vq-review-queue-tail vq-mono">全部 {queueTotal} 条都列出来了</p>
          ) : null}
          </>
        ) : queueFiltered ? (
          <div className="vq-empty vq-empty--inline">
            <strong>
              {queueKeyword.trim()
                ? '没有标题含「' + queueKeyword.trim() + '」的等你改'
                : queueRange === '7d'
                  ? '最近 7 天没有等你改的'
                  : '最近 30 天没有等你改的'}
            </strong>
            <span>
              全部还有 {queueAllTotal} 条等你改：把时间放宽到「全部时间」
              {queueKeyword.trim() ? '，或换个词' : ''}就能看到。
            </span>
            <button type="button" className="vq-button" onClick={resetQueueFilter}>
              清掉筛选
              <ArrowRight size={13} />
            </button>
          </div>
        ) : (
          <div className="vq-empty vq-empty--inline">
            <strong>{decidedTotal && !seenTotal ? '这一版你拍过板了' : seenTotal ? '等你看的都看过了' : '没有等你改的评审'}</strong>
            <span>
              {seenTotal
                ? '看过不等于改过：作品状态还是「评审 · 需人工确认 / 不通过」，评审证据也都在作品页；这一版再评一次会回到这里。'
                : decidedTotal
                  ? '拍板不是「已看过」：胶囊与下一步按你的结论走，交付稿与评审对照纸上也写着谁拍的板；再评出新结论后要重新拍板。'
                  : '评审一版画面后，结论是「需人工确认」或「不通过」的作品会排在这里；通过的作品直接去交付。'}
            </span>
            {seenTotal || decidedTotal ? null : (
              <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('review')}>
                去视觉评审
                <ArrowRight size={13} />
              </button>
            )}
          </div>
        )}

        {/* 看过的都留在这儿（v0.9.28）：以前只写「最近一条」、也只撤得掉最近一条，
            其余几条要看哪条作品得去作品页翻——等于记不回来。现在点开就是整份清单，逐条撤销。 */}
        {seenTotal && seen[0] ? (
          <div className="vq-review-queue-seen-block">
            <div className="vq-review-queue-seen">
              <span className="vq-review-queue-seen-text">
                已看过 <strong className="vq-mono">{seenTotal}</strong> 条，这一版先没改 · 最近：{seen[0].title}（第{' '}
                {Math.max(1, seen[0].version)} 版 · {reviewTimeLabel(seen[0].seenAt)} 看过）
              </span>
              <span className="vq-review-queue-seen-actions">
                <button
                  type="button"
                  className="vq-link"
                  onClick={() => setSeenOpen((open) => !open)}
                  aria-expanded={seenOpen}
                  aria-controls="vq-review-queue-seen-list"
                >
                  {seenOpen ? '收起' : '看这 ' + seenTotal + ' 条'}
                </button>
                {seenOpen ? null : (
                  <button
                    type="button"
                    className="vq-link"
                    onClick={() => void undoSeen(seen[0].projectId)}
                    disabled={ackBusy === seen[0].projectId}
                  >
                    撤销最近一条
                  </button>
                )}
              </span>
            </div>
            {seenOpen ? (
              <div className="vq-review-queue-list vq-review-queue-seen-list" id="vq-review-queue-seen-list">
                {seen.map((row) => (
                  <div className="vq-review-queue-row" key={row.projectId}>
                    <button
                      type="button"
                      className="vq-review-queue-open"
                      onClick={() => onOpenProject(row.projectId)}
                      aria-label={'打开作品：' + row.title + '，第 ' + Math.max(1, row.version) + ' 版'}
                    >
                      <Pill tone={row.status.tone}>{row.status.text}</Pill>
                      <span className="vq-review-queue-copy">
                        <strong>{row.title}</strong>
                        <span className="vq-mono">
                          第 {Math.max(1, row.version)} 版 · 评过 {row.count} 次 ·{' '}
                          <span className="vq-review-queue-time">{reviewTimeLabel(row.seenAt)} 看过</span>
                        </span>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                    <button
                      type="button"
                      className="vq-button vq-button--quiet vq-button--sm vq-review-queue-ack"
                      onClick={() => void undoSeen(row.projectId)}
                      disabled={ackBusy === row.projectId}
                      title="撤销「已看过」：它回到待办，这一版照旧要改"
                    >
                      <RotateCcw size={12} />
                      {ackBusy === row.projectId ? '撤销中…' : '撤销'}
                    </button>
                  </div>
                ))}
                <p className="vq-review-queue-seen-note">
                  撤销之后它回到上面的待办；这一版再评出新结论也会自己回来。
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 拍过板的也能点开（v0.9.28）：胶囊写人的那一句，点一行进作品撤销或改判 */}
        {decidedTotal && decided[0] ? (
          <div className="vq-review-queue-seen-block">
            <div className="vq-review-queue-seen is-decided">
              <span className="vq-review-queue-seen-text">
                你拍板过 <strong className="vq-mono">{decidedTotal}</strong> 条 · 最近：{decided[0].title}（第{' '}
                {Math.max(1, decided[0].version)} 版 · {decided[0].decision === 'pass' ? '通过' : '不通过'} ·{' '}
                {reviewTimeLabel(decided[0].decidedAt)}）
              </span>
              <span className="vq-review-queue-seen-actions">
                <button
                  type="button"
                  className="vq-link"
                  onClick={() => setDecidedOpen((open) => !open)}
                  aria-expanded={decidedOpen}
                  aria-controls="vq-review-queue-decided-list"
                >
                  {decidedOpen ? '收起' : '看这 ' + decidedTotal + ' 条'}
                </button>
              </span>
            </div>
            {decidedOpen ? (
              <div className="vq-review-queue-list vq-review-queue-seen-list" id="vq-review-queue-decided-list">
                {decided.map((row) => (
                  <div className="vq-review-queue-row" key={row.projectId}>
                    <button
                      type="button"
                      className="vq-review-queue-open"
                      onClick={() => onOpenProject(row.projectId)}
                      aria-label={'打开作品：' + row.title + '，第 ' + Math.max(1, row.version) + ' 版'}
                      title={row.note || undefined}
                    >
                      <Pill tone={row.status.tone}>{row.status.text}</Pill>
                      <span className="vq-review-queue-copy">
                        <strong>{row.title}</strong>
                        <span className="vq-mono">
                          第 {Math.max(1, row.version)} 版 · 模型「{REVIEW_VERDICT_LABEL[row.verdict] || '未记结论'}」·{' '}
                          <span className="vq-review-queue-time">{reviewTimeLabel(row.decidedAt)} 拍板</span>
                        </span>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                  </div>
                ))}
                <p className="vq-review-queue-seen-note">
                  这里只列还等在队列里的拍板；点一行进作品，撤销这一版与改判都在「拍板记录」里。
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 交出去的（v0.9.32）：已经交出去的每一版，按交付时间倒序摊成一条线。
          这一行回答「交的是哪一版、什么时候」，不是「现在什么状态」——
          开过新版的旧交付仍然在（记录是事实），但不会被说成现状。 */}
      <section className="vq-section vq-delivery-ledger" aria-labelledby="vq-delivery-ledger-title">
        <div className="vq-section-head">
          <div>
            <h2 id="vq-delivery-ledger-title">交出去的</h2>
            <p className="vq-delivery-sub">
              {deliveryTotal
                ? '已经交出去 ' +
                  deliveryTotal +
                  ' 次，分布在 ' +
                  deliverySummary.projects +
                  ' 条作品上' +
                  (deliverySummary.current
                    ? '，其中 ' + deliverySummary.current + ' 次交的还是当前这一版。'
                    : '，都不是当前这一版了：开过新版，旧交付的记录仍然留着。') +
                  (deliverySummary.drifted
                    ? '另有 ' + deliverySummary.drifted + ' 次交出去之后这一版又被评成了别的结论。'
                    : '')
                : '作品评审通过后在作品页「交付这一版」；交出去的每一版都排在这里，开过新版也留得住。'}
            </p>
            {/* 回执（v0.9.139）：封过包的几份里，他验过的有几份、对不上的有几份。
                对不上是这里唯一值得当场动手的一件，所以单独一句、带颜色。 */}
            {deliveryReceipts.sealed ? (
              <p className="vq-delivery-receipt-total">
                {ledgerReceiptTotalsText(deliveryReceipts)}
                {/* 还没回来的那几份里，超过三天的单说一句：该提一句了（v0.9.144） */}
                {deliveryReceipts.pendingLate ? deliveryLateText(deliveryReceipts.pendingLate) : ''}
                {/* 连链接都没人打开过的那几份：多半没送到，先再发一次（v0.9.145） */}
                {deliveryReceipts.pendingUnopened ? deliveryUnopenedText(deliveryReceipts.pendingUnopened) : ''}
                {/* 又发过两次还是没打开的那几次：同一条地址再发也没用了，换个方式（v0.9.146） */}
                {deliveryReceipts.pendingStuck ? deliveryStuckText(deliveryReceipts.pendingStuck) : ''}
                {/* 换过新地址、新地址也没人打开的那几次：别再换地址了，先问一句（v0.9.147） */}
                {deliveryReceipts.pendingRelinked ? deliveryRelinkedText(deliveryReceipts.pendingRelinked) : ''}
                {/* 他自己点了「收到了」的那几份：东西到手了，只差验——这几份不用再问（v0.9.151） */}
                {deliveryReceipts.pendingAcked ? deliveryAckedText(deliveryReceipts.pendingAcked) : ''}
                {/* 你自己收口的那些（v0.9.158）：不算「还没回来」，所以单说一句 */}
                {deliveryReceipts.waitClosed ? deliveryWaitClosedTotalText(deliveryReceipts.waitClosed) : ''}
              </p>
            ) : null}
            {deliveryReceipts.mismatched ? (
              <p className="vq-delivery-receipt-total is-bad" role="status">
                {'有 ' + deliveryReceipts.mismatched + ' 次回执对不上：点那几行进去，看差在哪一项。'}
              </p>
            ) : null}
          </div>
          <button type="button" className="vq-link" onClick={() => onNavigate('projects')}>
            全部作品
            <ArrowUpRight size={13} />
          </button>
        </div>

        {/* 按人看（v0.9.154）：交出去十几条之后，「哪一条还没回来」不如「谁还欠着」好问。
            一个人一枚按钮：欠着的用虚线（与回执胶囊同一套说法），点一下落在他最近那一条交付上。
            没写收件人的只给一个数——不猜是谁，也不混进任何一个人名下。
            v0.9.155：欠几条还不够急，补上「最早那一条等了几天」——同样欠两条，昨天刚发的和拖了六天的不是一回事。
            v0.9.156：再补「催完回了没有」——催过还没动静的，该换个渠道，不是再催一遍。 */}
        {deliveryPeople.length ? (
          <div className="vq-delivery-people">
            <p className="vq-delivery-people-lead">{peopleLeadText(deliveryPeople)}</p>
            <div className="vq-delivery-people-list">
              {deliveryPeople.map((person) => {
                const wait = personWaitText(person)
                const nag = personNagOutText(person)
                return (
                  <button
                    key={person.name}
                    type="button"
                    className={'vq-person' + (person.pending ? ' is-pending' : '')}
                    title={personTitle(person)}
                    onClick={() => onOpenProject(person.target.projectId, person.target.deliveryId || undefined)}
                  >
                    <span className="vq-person-name">{person.name}</span>
                    <span className="vq-person-count vq-mono">{personSummary(person)}</span>
                    {wait ? <span className="vq-person-wait vq-mono">{wait}</span> : null}
                    {nag ? <span className="vq-person-nag vq-mono">{nag}</span> : null}
                  </button>
                )
              })}
              {deliveryUnlabeled ? <span className="vq-person-note">{unlabeledText(deliveryUnlabeled)}</span> : null}
            </div>
          </div>
        ) : null}

        {deliveryError ? (
          <p className="vq-note vq-note--error" role="status">
            {deliveryError}
          </p>
        ) : null}

        {deliveries.length ? (
          <>
            <div className="vq-delivery-list">
              {visibleDeliveries.map((row) => (
                <div className="vq-delivery-row" key={row.projectId + ':' + row.version}>
                  <button
                    type="button"
                    className="vq-delivery-open"
                    // 封过包的那几条直接落在那一版的档案上：点进去就是要看「差在哪一项」
                    onClick={() => onOpenProject(row.projectId, row.package && row.deliveryId ? row.deliveryId : undefined)}
                    aria-label={
                      '打开作品：' +
                      row.title +
                      '，第 ' +
                      row.version +
                      ' 版' +
                      (row.package && row.deliveryId ? '，直接打开这一条交付档案' : '')
                    }
                  >
                    <Tag className="vq-delivery-tag">v{row.version}</Tag>
                    <span className="vq-delivery-copy">
                      <strong>{row.title}</strong>
                      {/* 时间与结论各自成段：窄屏换行只在「·」处断，不会把「通过」劈成两行 */}
                      <span className="vq-mono vq-delivery-meta">
                        {/* 这一条是给谁的（v0.9.152）：同时交出去两三份时，行上先得说清是给谁的。
                            没写就什么都不说——不写「未知」，也不拿作品标题冒充收件人。 */}
                        {row.recipient ? (
                          <>
                            <span className="vq-delivery-recipient" title={recipientTitle(row.recipient)}>
                              {recipientText(row.recipient)}
                            </span>
                            {' · '}
                          </>
                        ) : null}
                        <span>{row.atKnown ? stampTime(row.at) + ' 交出去' : '交付时间没记下'}</span>
                        {' · '}
                        {row.review ? (
                          // 交付那一刻存下的快照：之后这一版重评，这一行也不改
                          <span>
                            {'交时评审「' + (REVIEW_VERDICT_LABEL[row.review.verdict] || '未记结论') + '」'}
                            {issueLine(row.review.issues) ? ' · ' + issueLine(row.review.issues) : ''}
                            <DeliveryDriftNote drift={deliveryDrift(row.review, { verdict: row.verdict, issues: row.issues })} />
                          </span>
                        ) : row.review === null ? (
                          // 当时确实查过：一版都没评过，不是「没记」
                          <span>交的时候还没评过</span>
                        ) : (
                          // 升级前的交付记录没有快照：只能说当时没记，不能拿这一版最近一评冒充
                          <span>{'交时评审没记' + (row.reviews ? ' · 这一版评过 ' + row.reviews + ' 次' : '')}</span>
                        )}
                      </span>
                      {/* 回执（v0.9.139）：这一份他验没验、验的是不是这一份。
                          没封过包的老交付没有这一行——那时候还没有可比的包，不能写成「没回来」。 */}
                      {row.package ? (
                        row.receipt ? (
                          <span
                            className={'vq-delivery-receipt is-' + row.receipt.state}
                            title={'回执是' + (row.receipt.via === 'link' ? '收包人自己从回执链接贴回来的' : '你替收包人贴进来的')}
                          >
                            {ledgerReceiptText(row.receipt)}
                          </span>
                        ) : (
                          // 还没回来：等了几天、这条链接有没有人点开、催过几次，都写在这一行上
                          // （v0.9.144 天数与提醒，v0.9.145 打开情况）。
                          // 到了第三天换成警示色，并在 title 里说清「可以提一句」——不在行上写第二句。
                          <span
                            className={
                              'vq-delivery-receipt is-pending' +
                              // 收口之后不再算「到了第三天可以提一句」（v0.9.158）：这一条不催了
                              (rowWaitLate(row) && !rowWaitClosed(row) ? ' is-late' : '') +
                              (rowWaitClosed(row) ? ' is-closed' : '')
                            }
                            title={rowPendingTitle(row)}
                          >
                            {/* 一段一句、各自不拆：390 上「链接还没打 / 开」「又发过 1 / 次」这种
                                从词中间断行看着像排版事故。整段 whenwrap 之后只在「·」处换行。 */}
                            {[
                              // 他点过「收到了」（v0.9.151）：行首那句换成「收据还没贴」——
                              // 一行里不能同时写着「还没收到回执」和「他点了收到了」
                              rowPendingLead(row),
                              rowWaitText(row) ? ' · ' + rowWaitText(row) : '',
                              deliveryOpenShort(row.visits) ? ' · ' + deliveryOpenShort(row.visits) : '',
                              rowRelinkText(row) ? ' · ' + rowRelinkText(row) : '',
                              // 换到头了（v0.9.150）：这一段解释「为什么不再给换」，单独成段
                              rowRelinkCappedText(row) ? (
                                <span className="vq-keep-together vq-delivery-capped" key="capped">
                                  {' · ' + rowRelinkCappedText(row)}
                                </span>
                              ) : null,
                              // 换掉的那条还在被点（v0.9.149）：单独一段、单独颜色——
                              // 这一句后面跟着一个动作（把现在这条再发一次），不该被读成一串计数。
                              rowRetiredHitText(row) ? (
                                <span className="vq-keep-together vq-delivery-old" key="old">
                                  {' · ' + rowRetiredHitText(row)}
                                </span>
                              ) : null,
                              rowResendText(row) ? ' · ' + rowResendText(row) : '',
                              rowReminderText(row) ? ' · ' + rowReminderText(row) : '',
                            ]
                              .filter(Boolean)
                              .map((part) =>
                                typeof part === 'string' ? (
                                  <span className="vq-keep-together" key={part}>
                                    {part}
                                  </span>
                                ) : (
                                  part
                                ),
                              )}
                          </span>
                        )
                      ) : null}
                      {/* 他回了什么（v0.9.153）：收据给的是结论，他真正说的那句放在这一行最后——
                          看到「他说：第 3 张背景色偏了」就知道下一步要改哪张，不用点进档案。
                          没记就什么都不说（不是「他说没问题」）。 */}
                      {row.reply?.text ? (
                        <span className="vq-delivery-reply" title={replyRowTitle(row.reply)}>
                          {replyRowText(row.reply)}
                        </span>
                      ) : null}
                    </span>
                    <span className={'vq-delivery-state' + (row.current ? ' is-current' : '')}>
                      {row.current ? '当前版' : '已到 v' + row.currentVersion}
                    </span>
                    <ArrowRight size={13} />
                  </button>
                  {row.current || (row.deliveryId && row.package) ? (
                    <div className="vq-delivery-actions">
                      {row.current ? (
                        <button
                          type="button"
                          className="vq-button vq-button--quiet vq-button--sm vq-delivery-paper"
                          onClick={() => openDeliverable(row.projectId)}
                          title="在新标签里打开这一版的交付稿（A4，可存 PDF）"
                        >
                          交付稿
                        </button>
                      ) : null}
                      {row.deliveryId && row.package ? (
                        <a
                          className="vq-button vq-button--quiet vq-button--sm vq-delivery-package"
                          href={deliveryPackageUrl(row.projectId, row.deliveryId)}
                          download
                          title={'下载交付时封存的整套（' + row.package.bytes.toLocaleString('zh-CN') + ' B，之后改模板也不会变）'}
                        >
                          交付包
                          <Download size={12} />
                        </a>
                      ) : null}
                      {/* 链接一次都没被打开过：先给「再发一次」（v0.9.146）——多半是没送到，
                          再发一条同样的地址比催他验更对路。点过但没有回执的那几条仍然只有「复制提醒」。
                          同一条地址发到两次还没打开（v0.9.147）：换一条新链接——第三遍同样的地址
                          不会比前两遍多出什么，地址本身多半就不对。 */}
                      {row.relinkable && row.deliveryId ? (
                        <button
                          type="button"
                          className="vq-button vq-button--quiet vq-button--sm vq-delivery-relink"
                          disabled={relinkBusy === row.projectId + ':' + row.version}
                          onClick={() => void copyDeliveryRelink(row)}
                          title="换一枚新的回执地址（旧的那条立刻打不开），并复制一段「新地址在这儿」的话；包、字节、哈希都不动"
                        >
                          {relinkBusy === row.projectId + ':' + row.version ? '正在换…' : '换一条新链接'}
                        </button>
                      ) : row.relinkCapped && row.deliveryId ? (
                        // 换到头了（v0.9.150）：不再给第三条地址，剩下的动作是问人。
                        // 这一段话里带着现在这条地址，所以「再发一次」这件事也算在里头了。
                        <button
                          type="button"
                          className="vq-button vq-button--quiet vq-button--sm vq-delivery-ask"
                          disabled={askBusy === row.projectId + ':' + row.version}
                          onClick={() => void copyDeliveryAsk(row)}
                          title="复制一段「是不是没收到」的话，带现在这条地址；换地址已经换到头了（两次），这一步不换地址、也不改这一行的数"
                        >
                          {askBusy === row.projectId + ':' + row.version ? '正在写…' : '问问收到没'}
                        </button>
                      ) : row.resendable && row.deliveryId ? (
                        <button
                          type="button"
                          className="vq-button vq-button--quiet vq-button--sm vq-delivery-resend"
                          disabled={resendBusy === row.projectId + ':' + row.version}
                          onClick={() => void copyDeliveryResend(row)}
                          title="复制一段「再发一次回执链接」的话，发到微信 / 邮件里就行；这一行会记下又发过几次，与催过几次分开算"
                        >
                          {resendBusy === row.projectId + ':' + row.version ? '正在写…' : '再发一次链接'}
                        </button>
                      ) : row.remindable && row.deliveryId ? (
                        // 催过、三天以上没动静的那一行（v0.9.157）：再发一遍一样的话没用，换成问一句
                        // 「收到没有、要不要换种发法」。两种动作同一档，一次只出一个——按钮从「复制提醒」
                        // 变成「换个渠道问」，是在回答「这件事到哪一步了」，不是又加了一个功能。
                        rowNagLate(row) ? (
                          <button
                            type="button"
                            className="vq-button vq-button--quiet vq-button--sm vq-delivery-channel"
                            onClick={() => void copyDeliveryChannel(row)}
                            title={rowChannelTitle(row)}
                          >
                            换个渠道问
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="vq-button vq-button--quiet vq-button--sm vq-delivery-remind"
                            disabled={remindBusy === row.projectId + ':' + row.version}
                            onClick={() => void copyDeliveryReminder(row)}
                            title="复制一段提醒他验包的话（带回收据链接），发到微信 / 邮件里就行；发出去之后这一行会记下催过几次"
                          >
                            {remindBusy === row.projectId + ':' + row.version ? '正在写…' : '复制提醒'}
                          </button>
                        )
                      ) : null}
                      {/* 收口（v0.9.159）：等待这件事的出口。它和「催 / 换渠道」不是同一档——
                          那一枚回答「下一步做什么」，这一枚回答「这件事还追不追」，所以压到最淡、排最后。
                          收口之后同一处换成「继续等」：点错了不必先点进作品页就能退回来。
                          已经有回执的那一条不给这一枚：等的事已经结束，收口和撤回都不该再改它。 */}
                      {row.deliveryId && row.package && !row.receipt ? (
                        <button
                          type="button"
                          className={
                            'vq-button vq-button--quiet vq-button--sm vq-delivery-wait' +
                            (rowWaitClosed(row) ? ' is-closed' : '')
                          }
                          disabled={waitBusy === row.projectId + ':' + row.version}
                          onClick={() => void toggleDeliveryWait(row, !rowWaitClosed(row))}
                          title={deliveryWaitToggleHint(rowWaitClosed(row))}
                        >
                          {waitBusy === row.projectId + ':' + row.version
                            ? '正在改…'
                            : deliveryWaitToggleLabel(rowWaitClosed(row))}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>

            {deliveryMore ? (
              <button type="button" className="vq-link vq-delivery-more" onClick={() => setDeliveryOpen(true)}>
                看这 {deliveries.length} 条
                <ArrowRight size={12} />
              </button>
            ) : null}

            {/* 翻页与评审队列同一套说法：左边写「已列 8 / 12 条」可以被核对，翻到底才说都列出来了 */}
            {deliveryOpen && deliveryRest ? (
              <div className="vq-delivery-pager">
                <span className="vq-delivery-pager-count vq-mono">
                  已列 <strong>{deliveries.length}</strong> / {deliveryTotal} 条
                </span>
                {deliveryHasMore ? (
                  <button
                    type="button"
                    className="vq-button vq-button--quiet vq-button--sm"
                    onClick={() => void loadMoreDeliveries()}
                    disabled={deliveryBusy}
                    title="接着往下取：一页 8 条"
                  >
                    {deliveryBusy ? '正在取…' : '再看 ' + deliveryNextPage + ' 条'}
                    {deliveryBusy ? null : <ArrowRight size={12} />}
                  </button>
                ) : (
                  <span className="vq-delivery-pager-hint">全部 {deliveryTotal} 条都列出来了</span>
                )}
              </div>
            ) : deliveryOpen && deliveries.length > 8 ? (
              // 已经翻到底：说一句「都列出来了」，比让翻页行悄悄消失清楚
              <p className="vq-delivery-tail vq-mono">全部 {deliveryTotal} 条都列出来了</p>
            ) : null}

            {hasPastDelivery ? (
              <p className="vq-delivery-note">
                交付包在标记交付时封存：旧版封过也能原样下载；升级前交的那几版没有包，要回看就点进作品看「版本对照」。
              </p>
            ) : null}
          </>
        ) : (
          <div className="vq-empty vq-empty--inline">
            <strong>还没交出去过</strong>
            <span>标记交付之后，这里按时间排：交的是哪条作品的哪一版、什么时候、现在还算不算数。</span>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('projects')}>
              去作品列表
              <ArrowRight size={13} />
            </button>
          </div>
        )}
      </section>

      <div className="vq-start">
        <button type="button" className="vq-start-card" onClick={() => onNavigate('radar')}>
          <span className="vq-start-icon"><Search size={16} strokeWidth={1.75} /></span>
          <span className="vq-start-copy">
            <strong>从爆款开始</strong>
            <span>按关键词检索，挑一条加进模板库</span>
          </span>
          <ArrowRight size={15} />
        </button>
        <button type="button" className="vq-start-card" onClick={() => onNavigate('templates')}>
          <span className="vq-start-icon"><LayoutTemplate size={16} strokeWidth={1.75} /></span>
          <span className="vq-start-copy">
            <strong>从模板开始</strong>
            <span>
              {templates.length ? templates.length + ' 条已解析结构，套一条改写' : '模板库还是空的，先从爆款拆一条'}
            </span>
          </span>
          <ArrowRight size={15} />
        </button>
        <button type="button" className="vq-start-card" onClick={onCreateCanvas}>
          <span className="vq-start-icon"><Workflow size={16} strokeWidth={1.75} /></span>
          <span className="vq-start-copy">
            <strong>空白画布</strong>
            <span>从零搭节点，跑一次看每个节点返回什么</span>
          </span>
          <ArrowRight size={15} />
        </button>
      </div>

      <div className="vq-overview-grid">
        <section className="vq-section">
          <div className="vq-section-head">
            <div>
              <h2>最近运行</h2>
            </div>
            <button type="button" className="vq-link" onClick={() => onNavigate('runs')}>
              全部运行
              <ArrowUpRight size={13} />
            </button>
          </div>

          {recentRuns.length ? (
            <div className="vq-table" role="table" aria-label="最近运行">
              <div className="vq-table-head" role="row">
                <span role="columnheader">画布 / 作品</span>
                <span role="columnheader">状态</span>
                <span role="columnheader">耗时</span>
                <span role="columnheader">开始</span>
              </div>
              {recentRuns.map((run) => {
                const meta = runStatusMeta(run.status)
                return (
                <div className="vq-table-row" role="row" key={run.id}>
                  <div className="vq-table-name" role="cell">
                    <strong>{run.flowName}</strong>
                    {/* 第二行先回答「这是哪条作品的运行」：运行 ID 只在运行记录页里排障用得上 */}
                    <span className="vq-mono">{runWorkLine(run)}</span>
                  </div>
                  <span role="cell">
                    <Tag tone={meta.tone === 'pass' ? 'plain' : meta.tone === 'fail' ? 'fail' : 'warn'}>{meta.label}</Tag>
                  </span>
                  <span className="vq-mono" role="cell">
                    {run.status === 'running' || run.status === 'queued' ? runLiveText(run) : secondsOf(run.durationMs)}
                  </span>
                  <span className="vq-mono" role="cell">
                    {clockOf(run.startedAt)}
                  </span>
                </div>
                )
              })}
            </div>
          ) : (
            <div className="vq-empty vq-empty--inline">
              <strong>还没有运行记录</strong>
              <span>去画布点一次运行，这里会按节点列出耗时与返回。</span>
            </div>
          )}
        </section>

        <section className="vq-section">
          <div className="vq-section-head">
            <div>
              <h2>模板库</h2>
            </div>
            <button type="button" className="vq-link" onClick={() => onNavigate('templates')}>
              全部模板
              <ArrowRight size={13} />
            </button>
          </div>

          {recentTemplates.length ? (
            <>
              {recentTemplates.map((template) => (
                <button type="button" className="vq-template-row" key={template.id} onClick={() => onNavigate('templates')}>
                  <span className="vq-template-copy">
                    <strong>{template.title}</strong>
                    <span className="vq-mono">
                      {template.contentType || '脚本'} · {(template.durationSec ?? 0).toFixed(0)}s
                    </span>
                  </span>
                  <ArrowRight size={13} />
                </button>
              ))}
              <button type="button" className="vq-button vq-button--ghost vq-template-cta" onClick={() => onNavigate('templates')}>
                拿一条模板开始
                <ArrowRight size={13} />
              </button>
            </>
          ) : (
            <div className="vq-empty vq-empty--inline">
              <strong>模板库还是空的</strong>
              <span>在「发现」里复刻一条内容，拆出来的脚本结构会落到这里。</span>
              <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('radar')}>
                去检索
                <ArrowRight size={13} />
              </button>
            </div>
          )}
        </section>
      </div>

      <section className="vq-section vq-share-summary" aria-labelledby="vq-share-summary-title">
        <div className="vq-section-head">
          <div>
            <h2 id="vq-share-summary-title">分享出去的链接</h2>
            <p className="vq-share-summary-sub">
              {shares.length
                ? '共 ' + shareTotals.total + ' 条作品分享过 · ' + shareTotals.opens + ' 次打开。点开作品看每一轮。'
                : '发出去的链接，这里汇总有没有人点开。'}
            </p>
          </div>
          <button type="button" className="vq-link" onClick={() => onNavigate('projects')}>
            全部作品
            <ArrowUpRight size={13} />
          </button>
        </div>

        {shares.length ? (
          <div className="vq-share-summary-list">
            {shares.map((row) => (
              <button type="button" className="vq-share-summary-row" key={row.projectId} onClick={() => onOpenProject(row.projectId)}>
                <span className="vq-share-summary-copy">
                  <strong>{row.title}</strong>
                  <span className="vq-share-summary-meta">
                    <span className={'vq-share-summary-state' + (row.live ? ' is-live' : '')}>
                      {row.live ? <span className="vq-share-summary-dot" aria-hidden="true" /> : null}
                      {row.live ? '分享中' : '已停用'}
                    </span>
                    <span>
                      {row.rounds} 轮链接
                      {!row.live && row.lastClosedAt ? ' · 最近停用 ' + stampTime(row.lastClosedAt) : ''}
                    </span>
                  </span>
                </span>
                <span className="vq-share-summary-visits">
                  <b>{row.visits.opens}</b>
                  <span>{row.visits.opens ? '次打开 · ' + visitLine(row.visits) : '次打开 · 还没人点开'}</span>
                </span>
                <ArrowRight size={13} />
              </button>
            ))}
          </div>
        ) : (
          <div className="vq-empty vq-empty--inline">
            <strong>还没有分享出去的链接</strong>
            <span>在作品页点「分享」，把链接发给甲方；这里会汇总每条被打开过几次，停用后也留着。</span>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('projects')}>
              去作品列表
              <ArrowRight size={13} />
            </button>
          </div>
        )}
      </section>
        </>
      )}

      <footer className="vq-overview-foot">
        <span className="vq-overview-legal">
          <a className="vq-link" href="#/legal/terms">服务条款</a>
          <a className="vq-link" href="#/legal/privacy">隐私说明</a>
          <a className="vq-link" href="#/sources">素材来源</a>
          <button type="button" className="vq-link" onClick={onOpenGuide}>
            上手指引
          </button>
          {site.operator ? <span>{site.operator}</span> : null}
          {site.icp ? <span className="vq-mono">{site.icp}</span> : null}
        </span>
      </footer>
    </div>
  )
}
