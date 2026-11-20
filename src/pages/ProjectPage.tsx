import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, BookmarkPlus, Bot, Check, ChevronDown, Clapperboard, ClipboardCheck, Copy, CopyPlus, Download, ExternalLink, FileCheck2, FileText, GitCompare, Link2, Package, Pencil, Plus, Printer, RefreshCw, RotateCcw, ScanEye, Share2, Sparkles, Trash2, Upload, Workflow, X } from 'lucide-react'
import PageHead from '../components/PageHead'
import ProjectStatusPill from '../components/ProjectStatus'
import { VersionScriptModal } from '../components/VersionScriptModal'
import { VersionCompareModal } from '../components/VersionCompareModal'
import {
  checkDeliveryPackage,
  checkDeliveryReceipt,
  deleteProject,
  deliverablePrintUrl,
  deliveryPackageAudit,
  deliveryPackageContents,
  deliveryPackageEntryUrl,
  deliveryPackageUrl,
  disableProjectShare,
  downloadProjectDeliverable,
  downloadProjectDeliverableZip,
  enableProjectShare,
  getProject,
  getProjectVersionScript,
  issueReceiptLink,
  closeDeliveryWait,
  setDeliveryRecipient,
  setDeliveryReply,
  receiptLinkUrl,
  openProjectCanvas,
  projectPackageAudits,
  projectSpend,
  resetProjectScript,
  reviewSheetUrl,
  saveProjectAsTemplate,
  saveProjectScript,
  setProjectShotFrame,
  setProjectShareCompare,
  setSheetUrl,
  startProjectVersion,
  updateProject,
  type ProjectTemplateSaveResult,
} from '../api/projects'
import { uploadRejection, uploadReviewImage } from '../api/media'
import { generateMediaImage, getMediaTask, listMediaModels } from '../api/media-gen'
import { safeFetch } from '../api/client'
import { getCredits } from '../api/credits'
import { describeTiming, type ScriptBeat } from '../domain/radar'
import { formatCount } from '../api/radar'
import {
  checkPackageFile,
  deliveredCurrent,
  deliveryArchive,
  deliveryLandingOf,
  deliveryLandingText,
  deliveryOf,
  deliveryReceiptLine,
  packageAuditFaultLabel,
  packageAuditLine,
  packageAuditText,
  packageBytesLabel,
  packageDiskAlert,
  packageManifestNote,
  packageShortSha,
  projectStep,
  receiptAdvice,
  receiptChangeOf,
  receiptOutreach,
  receiptCheckLabel,
  receiptStateText,
  receiptViaText,
  serverPackageText,
  sha256HexOfBytes,
  type PackageAudit,
  type PackageAuditRecord,
  type PackageCheck,
  type PackageContents,
  type PackageEntry,
  type PackageEntryKind,
  type PackageServerCheck,
  reviewsForVersion,
  runsForVersion,
  type Project,
  type ProjectDelivery,
  type ProjectDetail,
  type ProjectSpendDetail,
  type ProjectVersionScriptSnapshot,
} from '../domain/project'
import { clearUnsaved, setUnsaved } from '../domain/unsaved-guard'
import { ackReview, decideReview, clearReviewDecision, unackReview } from '../api/review'
import { allShotPrompts, beatForShot, shotPrompt, shotPromptHint, type ShotPromptScriptSource } from '../domain/shot-prompt'
import { SHOT_GEN_ATTACH_FAILED, SHOT_GEN_WAIT_MS, shotGenFailNote, shotGenFileName, shotGenPriceLabel, shotGenRatio, shotGenView, type ShotGenView } from '../domain/shot-generate'
import {
  ISSUE_LABEL,
  deliveryDrift,
  deliveryDriftText,
  deliveryReviewText,
  issueCompare,
  issueGap,
  issueLine,
  REVIEW_VERDICT_LABEL as VERDICT_LABEL,
  reviewTimeLabel,
  reviewsOfVersion,
} from '../domain/review'
import { deliveryOpenCount, deliveryOpenHint } from '../domain/delivery-open'
import { deliveryResendBrief, deliveryResendHint } from '../domain/delivery-resend'
import { RELINK_LIMIT, deliveryArchiveLine, deliveryRelinkBrief, deliveryRelinkHint } from '../domain/delivery-relink'
import { deliveryAckText } from '../domain/delivery-ack'
import { deliveryWaitReturned, deliveryWaitToggleHint, deliveryWaitToggleLabel } from '../domain/delivery-wait'
import {
  RECIPIENT_LIMIT,
  normalizeRecipient,
  recipientClearedText,
  recipientEmptyText,
  recipientHint,
  recipientPlaceholder,
  recipientSavedText,
} from '../domain/delivery-recipient'
import {
  REPLY_LIMIT,
  normalizeReply,
  replyClearedText,
  replyEmptyText,
  replyHint,
  replyPlaceholder,
  replySavedAt,
  replySavedText,
} from '../domain/delivery-reply'
import { stampTime as stamp, visitLine } from '../domain/share'
import '../styles/projects.css'

// 保存脚本之后工作流那边发生了什么：直接说人话，不把 reason 漏到界面上
// 脚本草稿的登记名（r270）：离开拦截只认这一条，别的页面登记的不动
const SCRIPT_UNSAVED_OWNER = 'project-script'

const SCRIPT_CANVAS_NOTE: Record<string, string> = {
  synced: '工作流里的复刻提示词也换成新脚本了',
  'no-canvas': '还没开工作流，开工作流时会用这条脚本生成复刻提示词，并按分镜给每一镜建出图节点',
  'canvas-missing': '这条作品绑的工作流不在了，脚本已经存下',
  'hand-edited': '工作流里的提示词是手改过的，没有覆盖',
  'save-failed': '工作流提示词这次没写进去，稍后再存一次脚本',
  'no-script': '',
}

const KIND_LABEL: Record<string, string> = { replica: '原片拆解', adapted: '改编版', flow: '工作流', saved: '待解析' }

const pad2 = (value: number) => String(value).padStart(2, '0')

// 逐镜出图（r276）这一行此刻长什么样：正在画 / 正在贴 / 失败（失败带着退没退款那句话）。
// 「画好了」不进状态——它紧接着就变成贴画面，只在界面上闪一下，不留一行要人读的中间态。
type ShotGenRow =
  | Extract<ShotGenView, { state: 'running' }>
  | { state: 'attach' }
  | (Extract<ShotGenView, { state: 'failed' }> & { note?: string })

// 花费明细里的时间：只到分钟，年份省掉——同一屏里不会有跨年的几笔
function shortStamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function monthLabel(month: string): string {
  const index = Number(month.slice(5, 7))
  return Number.isFinite(index) && index >= 1 && index <= 12 ? index + ' 月' : month
}

function seconds(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toFixed(1) + 's'
}

// 运行耗时：超过一分钟写成「1 分 20 秒」，比 80.4 秒好读
function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const total = Math.round(ms / 1000)
  if (total < 60) return (ms / 1000).toFixed(1) + ' 秒'
  return Math.floor(total / 60) + ' 分 ' + (total % 60) + ' 秒'
}

/** 收据结论与问题列表常常是同一句：句末标点不算不同，列表里不再重复一遍。 */
const stripStop = (value: string | undefined) => String(value || '').replace(/[。.]$/, '')

/**
 * 作品页：一条内容的完整现场。
 * 首屏只回答「下一步点哪里」（用脚本开工作流 → 送评审 → 继续改 → 交付），
 * 然后是版本对照，下面才是现场：脚本、分镜、工作流、评审。
 * 脚本默认跟随模板，在页内改过就复制成作品自己的版本（copy-on-write）；版本只存工作流指针。
 */
export default function ProjectPage({
  projectId,
  focusDeliveryId,
  onBack,
  onOpenFlow,
  onViewRun,
  onOpenReview,
  onOpenReviewRecord,
  onOpenAgents,
  onBrowseTemplates,
  onOpenTemplate,
  onToast,
}: {
  projectId: string
  /** 地址里点名的那一条交付（v0.9.140）：工作台点一行过来，档案直接落在那一版上 */
  focusDeliveryId?: string
  onBack: () => void
  onOpenFlow: (flowId: string) => void
  /** 只读回看一次运行（v0.9.108）：带着当时的节点状态进工作流，不改工作流、不扣费 */
  onViewRun: (flowId: string, runId: string) => void
  onOpenReview: (projectId: string) => void
  /** 打开某一条评审的记录页：那里有当时的证据原图与问题锚点 */
  onOpenReviewRecord: (reviewId: string) => void
  /** 让对话预设起草这一版脚本：带着这条作品的上下文去对话预设页，草稿写完能直接写回这一版 */
  onOpenAgents: (projectId: string) => void
  onBrowseTemplates: () => void
  /** 打开这条作品用的那条模板：来源面板里点模板名就走这里（地址是 #/templates/<模板 id>） */
  onOpenTemplate?: (templateId: string) => void
  onToast: (message: string) => void
}) {
  const [data, setData] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'' | 'canvas' | 'done' | 'delete' | 'title' | 'version' | 'rebase' | 'script' | 'export' | 'zip'>('')
  // 哪一镜正在贴画面（v0.9.161）：上传 + 记账两段，按镜头号显示「正在贴…」，不让整页转圈
  const [shotBusy, setShotBusy] = useState(0)
  // 逐镜出图（r276）：哪几镜在画、画到哪；只有点「出这一镜」才动它，进页面不出图
  const [shotGen, setShotGen] = useState<Record<number, ShotGenRow>>({})
  // 出图模型与单价：与「快捷创作 → 图片」读同一份 /api/media/models，界面不自己写死模型名与价格
  const [imageModel, setImageModel] = useState<{ id: string; label: string; price: number | null; ratios: string[] } | null>(null)
  const [imageModelNote, setImageModelNote] = useState('')
  const [balance, setBalance] = useState<number | null>(null)
  // 哪一镜的提示词摊开着（v0.9.164）：提示词是现拼的，不是存下来的，所以只记镜头号
  const [promptNo, setPromptNo] = useState(0)
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  // 脚本就地编辑：草稿只在内存里，保存后才写进作品（copy-on-write）
  const [scriptEditing, setScriptEditing] = useState(false)
  const [scriptDraft, setScriptDraft] = useState<{ hook: string; structure: ScriptBeat[] } | null>(null)
  // 开编辑那一刻的草稿长什么样（r270）：靠它判断「改了还是没改」，
  // 只看 scriptDraft 会把「打开看一眼就关」也算成改动。
  const [scriptBaseline, setScriptBaseline] = useState('')
  // 只读分享：链接在这个作品上，弹窗里开、停、复制；token 只从作品详情拿
  const [shareOpen, setShareOpen] = useState(false)
  const [shareBusy, setShareBusy] = useState<'' | 'enable' | 'disable' | 'copy' | 'compare'>('')
  const [shareCopied, setShareCopied] = useState(false)
  // 版本脚本快照（v0.9.114）：点旧版的「N 段脚本」才读，打开页面时不预取
  const [versionScript, setVersionScript] = useState<{
    open: boolean
    n: number
    name: string
    change: string
    busy: boolean
    error: string
    script: ProjectVersionScriptSnapshot | null
    reason: string
  }>({ open: false, n: 0, name: '', change: '', busy: false, error: '', script: null, reason: '' })
  // 任意两版对照（v0.9.117）：只读弹窗，打开才读；选哪两版由弹窗自己管
  const [compareOpen, setCompareOpen] = useState(false)
  // 交付菜单：五种产物（交付稿 / 打印稿 / 现场页 / 评审对照 / 交付包）收在一个入口里，
  // 页头就不会排到七个按钮；点空白处或 Esc 收起（和账号菜单同一套习惯）
  const [deliverOpen, setDeliverOpen] = useState(false)
  const deliverRef = useRef<HTMLDivElement | null>(null)
  // 交付档案（v0.9.126）：展开哪一版的包内清单（0 = 都收起）；同一时间只开一个
  const [archiveOpen, setArchiveOpen] = useState(0)
  // 核对下载到的包（v0.9.127）：只在本机算 SHA-256，0 表示哪一行都没开
  const [verifyOpen, setVerifyOpen] = useState(0)
  const [verify, setVerify] = useState<{
    version: number
    status: 'idle' | 'reading' | 'done' | 'error'
    fileName: string
    actualSha: string
    actualBytes: number
    check: PackageCheck | null
    error: string
  }>({ version: 0, status: 'idle', fileName: '', actualSha: '', actualBytes: 0, check: null, error: '' })
  // 服务器上那一份（v0.9.128）：点「查一遍」才让服务端重算盘上的 SHA-256；只读、不缓存
  const [serverCheck, setServerCheck] = useState<{
    version: number
    busy: boolean
    result: PackageServerCheck | null
    error: string
  }>({ version: 0, busy: false, result: null, error: '' })
  // 包里那份（v0.9.129）：目录从盘上那份封存包读，档案里记的清单只用来对照
  const [contents, setContents] = useState<{
    version: number
    busy: boolean
    result: PackageContents | null
    error: string
  }>({ version: 0, busy: false, result: null, error: '' })
  // 包里一条内容的预览：图片与页面交给浏览器按地址取（页面进沙箱），文字自己读回来看
  const [preview, setPreview] = useState<{
    version: number
    deliveryId: string
    name: string
    kind: PackageEntryKind
    status: 'idle' | 'loading' | 'ready' | 'error'
    text: string
    note: string
    error: string
  }>({ version: 0, deliveryId: '', name: '', kind: 'other', status: 'idle', text: '', note: '', error: '' })
  // 整包体检（v0.9.130）：把盘上那份逐条解开、重算 CRC32；只在点过之后出现，不跟首屏走
  const [audit, setAudit] = useState<{
    version: number
    state: 'idle' | 'busy' | 'done' | 'unreadable' | 'error'
    result: PackageAudit | null
    error: string
  }>({ version: 0, state: 'idle', result: null, error: '' })
  // 收据对账（v0.9.136）：收包人把校验页给出的收据发回来，贴进作品页跟封存包对一遍。
  // 打开哪一行、贴了什么文字、正在对/对完的结论都收在这里；结论同时写回这一条交付记录。
  const [receiptOpen, setReceiptOpen] = useState(0)
  const [receiptDraft, setReceiptDraft] = useState('')
  const [receiptBusy, setReceiptBusy] = useState(false)
  const [receiptError, setReceiptError] = useState('')
  // 回执链接（v0.9.137）：'issue' 正在生成、'rotate' 正在换一条，空串就是没在跑
  const [receiptLinkBusy, setReceiptLinkBusy] = useState<'' | 'issue' | 'rotate'>('')
  // 这一条是给谁的（v0.9.152）：按交付记录编号存草稿，改哪一条就只动哪一条的输入框。
  // 没打字的那几条读档案里的值——不预填任何名字，也不把上一行写的称呼带过来。
  const [recipientDrafts, setRecipientDrafts] = useState<Record<string, string>>({})
  const [recipientBusy, setRecipientBusy] = useState('')
  // 不再等这一份的回执（v0.9.158）：收口 / 继续等的那一下正在跑哪一条（空串 = 没在跑）
  const [waitBusy, setWaitBusy] = useState('')
  // 他回了什么（v0.9.153）：同样按交付记录编号存草稿；没打字的那几条读档案里记着的原话。
  // 草稿框里是「正在写的那一段」，与「已记下的那一段」分开，免得改到一半被别的刷新冲掉。
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [replyBusy, setReplyBusy] = useState('')
  // 上次巡检（v0.9.132）：定时任务每天把封存包验一遍，这里只读它写下的结论。
  // 没巡检过就 at 为空，界面上不出现这一行——不拿「今天没验」冒充「验过了」。
  const [audits, setAudits] = useState<{
    at: string
    problems: number
    checked: number
    byId: Record<string, PackageAuditRecord>
  }>({ at: '', problems: 0, checked: 0, byId: {} })
  // 从工作台点进来的那一条（v0.9.140）：地址里带着交付记录的编号。
  // 只落一次：之后在页里翻别的地方，不该被拽回这一版。
  const landedRef = useRef('')
  // 人工复核：一句话备注，加上正在提交的那一档（拍通过 / 拍不通过 / 撤销）
  // null 表示「跟着这条拍板的备注走」：改判或撤销后不用手动清空，渲染时现算
  const [decisionNote, setDecisionNote] = useState<string | null>(null)
  const [decideBusy, setDecideBusy] = useState<'' | 'pass' | 'reject' | 'undo' | 'clear'>('')
  // 「清空拍板记录」要点两下：第一下只是把按钮换成「再点一次」，5 秒没有第二下就缩回去
  const [clearLogArmed, setClearLogArmed] = useState(false)
  // 「以这一版为底」也点两下：第一下把按钮换成「再点一次 · 开 v4」，5 秒没有第二下就缩回去
  const [rebaseArmed, setRebaseArmed] = useState<number | null>(null)
  // 「存成模板」：把这一版做完的脚本 + 沿用模板的分镜沉淀回模板库。
  // 面板先把「存什么、从哪来、会不会跟原模板一样」说清，再让人点下去。
  const [tplSheet, setTplSheet] = useState<{
    open: boolean
    title: string
    busy: boolean
    error: string
    done: ProjectTemplateSaveResult['template'] | null
  }>({ open: false, title: '', busy: false, error: '', done: null })
  // 「已看过」也在作品页原地做：人点进来看了，就不该再回工作台点一下
  const [ackBusy, setAckBusy] = useState<'' | 'ack' | 'undo'>('')
  // 花费明细（v0.9.66）：合计在详情里已有，点「明细」才读逐笔；scope 为空是累计，否则是 YYYY-MM
  const [spendOpen, setSpendOpen] = useState(false)
  const [spendScope, setSpendScope] = useState('')
  const [spendDetail, setSpendDetail] = useState<ProjectSpendDetail | null>(null)
  const [spendBusy, setSpendBusy] = useState(false)
  const [spendError, setSpendError] = useState('')

  // 地址里点名的那一条（v0.9.140）：交付记录是异步取回来的，拿到之后落到那一版上。
  // 只落一次（同一地址数据再刷新，不把人从别处拽回来）；找不到就不落，界面上直说找不到。
  const applyLanding = useCallback(
    (project: Project | null | undefined) => {
      const found = deliveryLandingOf(project, focusDeliveryId)
      if (!found || found.missing || !found.version) return
      if (landedRef.current === found.id) return
      landedRef.current = found.id
      setArchiveOpen(found.version)
      if (found.hasPackage) setReceiptOpen(found.version)
    },
    [focusDeliveryId],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const next = await getProject(projectId)
      setData(next)
      applyLanding(next.project)
    } catch (caught) {
      setData(null)
      setError(caught instanceof Error ? caught.message : '作品读取失败')
    } finally {
      setLoading(false)
    }
  }, [projectId, applyLanding])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  // 出图的模型、单价与余额（r276）：模型与单价只认服务端那一份真源，余额只认账本。
  // 读不到就说读不到，并且把「出这一镜」按住——不许拿一个猜的价格哄人点下去花钱。
  useEffect(() => {
    let alive = true
    void listMediaModels()
      .then((list) => {
        if (!alive) return
        const wanted = list.defaults?.image || list.image?.[0]?.id || ''
        const found = (list.image || []).find((item) => item.id === wanted) || (list.image || [])[0] || null
        if (!found) {
          setImageModel(null)
          setImageModelNote('出图通道还没接上模型：先去「快捷创作 → 图片」看看那边能不能出图')
          return
        }
        setImageModel({
          id: found.id,
          label: found.label,
          price: Number(found.credits) > 0 ? Math.round(Number(found.credits)) : null,
          ratios: Array.isArray(found.ratios) ? found.ratios : [],
        })
        setImageModelNote('')
      })
      .catch(() => {
        if (!alive) return
        setImageModel(null)
        setImageModelNote('读不到出图模型与单价：这一下没连上服务，稍后刷新再看')
      })
    getCredits(1).then((result) => { if (alive) setBalance(typeof result.balance === 'number' ? result.balance : null) }).catch(() => { if (alive) setBalance(null) })
    return () => { alive = false }
  }, [])

  // 巡检结论跟首屏一起取：只读一份报告，读不到就不显示这一行（不挡作品页）
  useEffect(() => {
    let alive = true
    void projectPackageAudits(projectId)
      .then((report) => {
        if (!alive) return
        const byId: Record<string, PackageAuditRecord> = {}
        for (const item of report.packages || []) byId[item.deliveryId] = item
        setAudits({ at: report.at || '', problems: report.problems || 0, checked: report.checked || 0, byId })
      })
      .catch(() => {
        /* 巡检只是附加信息：读不到就当没巡检过，不在这里报错 */
      })
    return () => {
      alive = false
    }
  }, [projectId])

  // 从工作台点进来的那一条（v0.9.140）：按交付记录编号在档案里找，
  // 找到了就展开它那一版；找不到（旧链接 / 重新封过包）直说找不到，不猜成最近一版。
  const landing = useMemo(() => deliveryLandingOf(data?.project, focusDeliveryId), [data, focusDeliveryId])

  // 落在那一版上就把档案滚到眼前：作品页很长，不滚过去等于没落下
  useEffect(() => {
    if (!landing || landing.missing || !landing.version) return
    if (archiveOpen !== landing.version) return
    const section = document.getElementById('vq-project-archive')
    if (!section || typeof section.scrollIntoView !== 'function') return
    section.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [landing, archiveOpen])

  // 花费明细：读一次就留着，切月份才重新取；点「收起」不清缓存，再点开还是同一份
  const loadSpend = useCallback(async (scope: string) => {
    setSpendBusy(true)
    setSpendError('')
    try {
      setSpendDetail(await projectSpend(projectId, scope))
    } catch (caught) {
      setSpendError(caught instanceof Error ? caught.message : '花费明细读取失败')
    } finally {
      setSpendBusy(false)
    }
  }, [projectId])

  const toggleSpend = () => {
    if (spendOpen) {
      setSpendOpen(false)
      return
    }
    setSpendOpen(true)
    void loadSpend(spendScope)
  }

  const pickSpendScope = (scope: string) => {
    if (scope === spendScope) return
    setSpendScope(scope)
    void loadSpend(scope)
  }


  // 交付菜单：点别处、按 Esc 都收起
  // 「清空拍板记录」的第一下只保持 5 秒：等太久还挂着「再点一次」，容易误触
  useEffect(() => {
    if (!clearLogArmed) return
    const timer = window.setTimeout(() => setClearLogArmed(false), 5000)
    return () => window.clearTimeout(timer)
  }, [clearLogArmed])

  useEffect(() => {
    if (!deliverOpen) return
    const onDown = (event: PointerEvent) => {
      if (!deliverRef.current?.contains(event.target as Node)) setDeliverOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDeliverOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [deliverOpen])

  // 分享弹窗：Esc 关闭（和版本弹窗同一套习惯）；打开时不再往下滚页面
  useEffect(() => {
    if (!shareOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShareOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [shareOpen])

  // 「以这一版为底」的第一下只保持 5 秒：等太久还挂着「再点一次」，容易误触
  useEffect(() => {
    if (rebaseArmed === null) return
    const timer = window.setTimeout(() => setRebaseArmed(null), 5000)
    return () => window.clearTimeout(timer)
  }, [rebaseArmed])

  // 版本脚本弹窗：Esc 关闭；打开时背景不滚动（和分享弹窗同一套）
  useEffect(() => {
    if (!versionScript.open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVersionScript((prev) => ({ ...prev, open: false }))
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [versionScript.open])

  // 两版对照弹窗：Esc 关闭；打开时背景不滚动（和版本脚本弹窗同一套）
  useEffect(() => {
    if (!compareOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCompareOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [compareOpen])

  // 作品第一次开工作流就是这里：服务端用这条作品**现在的脚本**生成输入 + 复刻两个节点，
  // 再按分镜给每一镜建一个出图节点（r277），建完立刻绑上作品（v1），再打开工作流。
  // 脚本改过也不怕：工作流拿到的就是新词。开工作流本身不扣积分——钱在运行时的出图节点上。
  const openCanvas = useCallback(async () => {
    if (!data) return
    if (data.project.flowId) {
      onOpenFlow(data.project.flowId)
      return
    }
    setBusy('canvas')
    try {
      const result = await openProjectCanvas(data.project.id)
      // 节点数是服务端的事实：减掉输入与复刻两个骨架节点，剩下的就是每镜一个的出图节点。
      // 分镜超过上限时服务端只建前 12 个，这里读到的也就是 12，不按镜数自己算。
      const shotNodes = result.created ? Math.max(0, (result.flow.nodes || 0) - 2) : 0
      const eachPrice = imageModel?.price ?? 0
      onToast(
        result.created
          ? '已开好工作流：复刻脚本' +
            (shotNodes ? ' + ' + shotNodes + ' 镜出图' : '') +
            (shotNodes && eachPrice ? '（跑一次会画 ' + shotNodes + ' 张，每张 ' + eachPrice + ' 积分）' : '') +
            ' · ' + result.flow.name
          : '工作流已就绪：' + result.flow.name,
      )
      onOpenFlow(result.flow.id)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '开工作流失败')
    } finally {
      setBusy('')
    }
  }, [data, imageModel, onOpenFlow, onToast])

  // 只读分享：开 / 停 / 复制。链接是这条作品的地址，不是账号的，所以停止只影响这一条。
  const shareLink = data?.share ? window.location.origin + '/#/share/project/' + data.share.token : ''

  // 旧版脚本：点版本行上的段数才读。不动工作流、不扣积分；读失败也把弹窗留着，写清原因。
  const openVersionScript = async (row: { n: number; name: string }) => {
    if (!data) return
    setVersionScript({
      open: true,
      n: row.n,
      name: row.name,
      change: data.versionChanges?.[row.n] || '',
      busy: true,
      error: '',
      script: null,
      reason: '',
    })
    try {
      const result = await getProjectVersionScript(data.project.id, row.n)
      setVersionScript((prev) => prev.n === row.n
        ? { ...prev, busy: false, script: result.script, reason: result.reason || '' }
        : prev)
    } catch (caught) {
      setVersionScript((prev) => prev.n === row.n
        ? { ...prev, busy: false, error: caught instanceof Error ? caught.message : '这一版的脚本没读出来' }
        : prev)
    }
  }

  const openShare = () => {
    setShareCopied(false)
    setShareOpen(true)
    // 打开面板时拉一次最新数据：这一步就是来问「甲方看没看」的，不能拿开页面时的旧数字回答
    void getProject(projectId)
      .then((next) => setData((prev) => (prev ? { ...prev, share: next.share, shareHistory: next.shareHistory } : next)))
      .catch(() => {})
  }

  const startShare = async () => {
    if (!data) return
    setShareBusy('enable')
    try {
      const result = await enableProjectShare(data.project.id)
      setData({ ...data, share: result.share })
      onToast('分享链接已生成：拿到链接的人不用登录就能看脚本、分镜和评审对照')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '分享链接没生成成功')
    } finally {
      setShareBusy('')
    }
  }

  const stopShare = async () => {
    if (!data) return
    if (!window.confirm('停止分享？这个地址会立即失效，已经发出去的链接打不开了。')) return
    setShareBusy('disable')
    try {
      await disableProjectShare(data.project.id)
      setData({ ...data, share: null })
      onToast('已停止分享，旧链接当场失效')
      // 面板不关：顺手取回历史，停掉的那一轮还能看到被打开过几次（v0.9.11）
      void getProject(data.project.id)
        .then((next) => setData((prev) => (prev ? { ...prev, share: null, shareHistory: next.shareHistory } : next)))
        .catch(() => {})
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '停止分享失败，刷新再试')
    } finally {
      setShareBusy('')
    }
  }

  const copyShareLink = async () => {
    if (!shareLink) return
    setShareBusy('copy')
    try {
      await navigator.clipboard.writeText(shareLink)
      setShareCopied(true)
      onToast('分享链接已复制')
    } catch {
      onToast('浏览器没给剪贴板权限：手动选中链接复制')
    } finally {
      setShareBusy('')
    }
  }

  // 对照纸不是默认权限：分享者在这里主动打开，链接不变；关掉后同一地址立即打不开那张纸
  const toggleShareCompare = async () => {
    if (!data?.share) return
    const next = !data.share.compare
    setShareBusy('compare')
    try {
      const result = await setProjectShareCompare(data.project.id, next)
      setData((prev) => (prev ? { ...prev, share: result.share } : prev))
      onToast(next ? '分享页已带上两版对照：拿到链接的人也能打印这张纸' : '已关闭分享页的两版对照，链接本身不变')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '分享对照没切换成功，刷新再试')
    } finally {
      setShareBusy('')
    }
  }

  // 人拍板这一版：记在「哪一次评审」上（服务端现算版次与时间），模型写的评审记录一个字不改。
  // 再评出新结论后拍板自动失效、这条回到待办——人拍的是那一次评审，不是「这条作品永远通过」。
  const decide = async (kind: 'pass' | 'reject') => {
    if (!data) return
    setDecideBusy(kind)
    try {
      await decideReview(data.project.id, kind, (decisionNote ?? data.decision?.note ?? '').trim())
      await load()
      setDecisionNote(null)
      onToast(kind === 'pass' ? '已拍板：这一版通过' : '已拍板：这一版不通过')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '拍板没记上，刷新再试')
    } finally {
      setDecideBusy('')
    }
  }

  // 撤销只拿走「这一版这一次评审」那一条（v0.9.26）：早先几版的拍板是记录，不是开关。
  // 要连历史一起清掉，用下面的「清空拍板记录」——两件事写清楚，不靠按钮猜。
  const undoDecision = async () => {
    if (!data) return
    setDecideBusy('undo')
    try {
      const result = await clearReviewDecision(data.project.id, data.decision?.reviewAt || '')
      await load()
      setDecisionNote(null)
      setClearLogArmed(false)
      // removed=0 说明这条在别处已经被撤了（另一个标签页 / 另一个人）：别报「已撤销」
      onToast(result.removed ? '已撤销这一版的拍板，这一条回到待办' : '这条拍板已经不在记录里了，刷新看看')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '撤销没成功，刷新再试')
    } finally {
      setDecideBusy('')
    }
  }

  // 清空这条作品的全部拍板记录：连早先几版一起删。两步才动手，删的是记录，没有后悔药。
  const clearDecisionLog = async () => {
    if (!data) return
    if (!clearLogArmed) {
      setClearLogArmed(true)
      return
    }
    setClearLogArmed(false)
    setDecideBusy('clear')
    try {
      const result = await clearReviewDecision(data.project.id)
      await load()
      setDecisionNote(null)
      onToast(result.removed ? '已清空 ' + result.removed + ' 条拍板记录' : '没有可清空的拍板记录')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '清空没成功，刷新再试')
    } finally {
      setDecideBusy('')
    }
  }

  // 已看过：只是待办上的便利贴——从工作台队列里拿开，结论、胶囊与下一步一句都不动。
  // 这一版再评出结论、或开了新版，它自己会回到待办（服务端按版次与评审时间认）。
  const markSeen = async () => {
    if (!data) return
    setAckBusy('ack')
    try {
      await ackReview(data.project.id)
      await load()
      onToast('已看过：这一版先不改，工作台不再催它')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '「已看过」没记上，稍后再试')
    } finally {
      setAckBusy('')
    }
  }

  const undoSeen = async () => {
    if (!data) return
    setAckBusy('undo')
    try {
      await unackReview(data.project.id)
      await load()
      onToast('已撤销：这条回到工作台的待办')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '撤销没成功，稍后再试')
    } finally {
      setAckBusy('')
    }
  }

  // 标记交付会记下「哪一版、什么时候」并封存整套交付包（v0.9.125）；重新打开收回这一版的记录与包，别的版本留着
  const toggleDone = async () => {
    if (!data) return
    const next = deliveredCurrent(data.project) ? 'active' : 'done'
    setBusy('done')
    try {
      const result = await updateProject(data.project.id, { status: next })
      setData({ ...data, project: result.project })
      const delivery = deliveryOf(result.project)
      onToast(
        next === 'done'
          ? '已标记交付：v' + (delivery?.version ?? result.project.version) +
            (delivery?.at ? ' · ' + stamp(delivery.at) : '') +
            // 交的时候评审怎么说一起说出来：这条记录之后不会被重评改写
            (delivery ? ' · 交时评审 ' + deliveryReviewText(delivery.review) : '') +
            (delivery?.package ? ' · 交付包已封存' : '')
          : '已重新打开：这一版的交付记录也撤掉了',
      )
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '状态没保存成功')
    } finally {
      setBusy('')
    }
  }

  // 交付档案（v0.9.126）：复制的是完整 SHA-256，不是界面上截断的那 12 位。
  // 收件人拿到 zip 后可以自己算一遍哈希，对上才说明还是当初封存的那一份。
  const copyPackageSha = async (sha: string) => {
    try {
      await navigator.clipboard.writeText(sha)
      onToast('已复制 SHA-256，可发给收件人核对包有没有被改过')
    } catch {
      onToast('复制失败：浏览器没给剪贴板权限')
    }
  }

  // 核对封存包（v0.9.127）：文件在本机读、在本机算，不上传、不写出。
  // 哈希对上档案里那一条，才说明手里这份还是封存时的那一份；库里没有任何接口能收文件。
  const verifyPackage = async (version: number, pkg: { sha256: string; bytes: number }, file: File) => {
    setVerifyOpen(version)
    setVerify({
      version,
      status: 'reading',
      fileName: file.name,
      actualSha: '',
      actualBytes: file.size,
      check: null,
      error: '',
    })
    try {
      if (!file.size) throw new Error('这个文件是空的，不是交付包')
      if (file.size > 64 * 1024 * 1024) throw new Error('文件超过 64 MB，交付包不该这么大')
      const actualSha = await sha256HexOfBytes(await file.arrayBuffer())
      setVerify({
        version,
        status: 'done',
        fileName: file.name,
        actualSha,
        actualBytes: file.size,
        check: checkPackageFile(pkg, { sha256: actualSha, bytes: file.size }),
        error: '',
      })
    } catch (caught) {
      setVerify({
        version,
        status: 'error',
        fileName: file.name,
        actualSha: '',
        actualBytes: file.size,
        check: null,
        error: caught instanceof Error ? caught.message : '这个包没读出来',
      })
    }
  }

  // 服务器上那一份（v0.9.128）：盘上的文件和档案里的哈希比。
  // 只读接口：不修文件、不改档案、不缓存结果；查的就是「现在」这一份。
  const checkServerPackage = async (version: number, deliveryId: string) => {
    if (!data) return
    setServerCheck({ version, busy: true, result: null, error: '' })
    try {
      if (!deliveryId) throw new Error('这一条交付没有编号，查不了')
      const result = await checkDeliveryPackage(data.project.id, deliveryId)
      setServerCheck({ version, busy: false, result, error: '' })
    } catch (caught) {
      setServerCheck({
        version,
        busy: false,
        result: null,
        error: caught instanceof Error ? caught.message : '服务器上那一份没查成',
      })
    }
  }

  // 包里那份（v0.9.129）：清单改成从盘上那份的中央目录读，档案里记的那份只做对照。
  // 只读接口：不缓存、不解压到磁盘；盘上没了就退回档案里记的清单，不拿今天的样子补。
  // 贴一张自己的画面到某一镜（v0.9.161）：先传到自己账号下，再记到这条作品上。
  // 两步分开说：传失败不改记录；记不上时那张图仍留在自己的素材里，不删。
  const attachShotFrame = async (shotNo: number, file: File | null) => {
    if (!file) return
    const rejection = uploadRejection(file)
    if (rejection) {
      onToast(rejection)
      return
    }
    setShotBusy(shotNo)
    try {
      const uploaded = await uploadReviewImage(file)
      await setProjectShotFrame(projectId, shotNo, uploaded.media)
      await load()
      onToast('第 ' + shotNo + ' 镜的画面换成了你贴的这张 · 模板那几镜一个字没动')
    } catch (reason) {
      onToast(String((reason as Error)?.message || reason))
    } finally {
      setShotBusy(0)
    }
  }

  const clearShotFrame = async (shotNo: number) => {
    setShotBusy(shotNo)
    try {
      await setProjectShotFrame(projectId, shotNo, '')
      await load()
      onToast('第 ' + shotNo + ' 镜回到原片帧')
    } catch (reason) {
      onToast(String((reason as Error)?.message || reason))
    } finally {
      setShotBusy(0)
    }
  }

  // 逐镜出图（r276）：整条创作链里最后一段「得换个应用自己干」的活，收成这一下点击。
  // 顺序是「出图 → 取回字节 → 传成自己的素材 → 记到这一镜」：四段各有各的说法，
  // 画完但没贴上时不许说成「出图失败」——图在，钱也花了，只是还没记到这一镜。
  const generateShotFrame = useCallback(async (shotNo: number) => {
    const board = data?.template
    if (!board?.storyboard?.length || !imageModel) return
    const current = shotGen[shotNo]
    if (current?.state === 'running' || current?.state === 'attach') return
    const shot = board.storyboard.find((item, index) => Math.max(1, Math.round(Number(item.shotNo) || index + 1)) === shotNo)
    if (!shot) return
    const beats = data?.script?.structure?.length ? data.script.structure : board.structure
    const prompt = shotPrompt(shot, beatForShot(shot, beats), {
      platform: board.platform || board.origin?.platform || '',
      scriptSource: data?.script?.source === 'project' ? 'own' : 'template',
    })
    const mark = (next: ShotGenRow) => setShotGen((rows) => ({ ...rows, [shotNo]: next }))
    const fail = (view: Extract<ShotGenView, { state: 'failed' }>) => mark({ ...view, note: shotGenFailNote(view) })

    mark({ state: 'running', progress: 0, label: '正在提交…' })
    let task
    try {
      const started = await generateMediaImage({
        prompt,
        model: imageModel.id,
        mode: 'text2image',
        ratio: shotGenRatio(imageModel.ratios),
      })
      task = started.task
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      fail({ state: 'failed', message, refunded: false, cost: 0, topUp: /积分不足|余额不足/.test(message) })
      return
    }

    try {
      let view = shotGenView(task)
      const deadline = Date.now() + SHOT_GEN_WAIT_MS
      while (view.state === 'running' && Date.now() < deadline) {
        mark(view)
        await new Promise((resolve) => window.setTimeout(resolve, 2500))
        task = (await getMediaTask(task.id)).task
        view = shotGenView(task)
      }
      if (view.state === 'running') {
        // 服务端还在画：关掉这一页不影响它，回来能在「最近生成」里找到；这里绝不叫人重试
        fail({
          state: 'failed',
          message: '画了 4 分钟还没回来：关掉这一页它也会画完，回到「快捷创作 → 图片 → 最近生成」能找到这一张，别在这里重复点。',
          refunded: false,
          cost: 0,
          topUp: false,
        })
        return
      }
      if (view.state === 'failed') {
        fail(view)
        return
      }
      // 到这儿钱已经花了：后面任何一步没成就说「图在哪、怎么贴」，不再说「失败了」
      mark({ state: 'attach' })
      try {
        const response = await safeFetch(view.downloadUrl)
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const blob = await response.blob()
        const file = new File([blob], shotGenFileName(shotNo, blob.type || view.mime), { type: blob.type || view.mime })
        const uploaded = await uploadReviewImage(file)
        await setProjectShotFrame(projectId, shotNo, uploaded.media)
        await load()
        setShotGen((rows) => {
          const next = { ...rows }
          delete next[shotNo]
          return next
        })
        getCredits(1).then((result) => setBalance(typeof result.balance === 'number' ? result.balance : null)).catch(() => undefined)
        onToast('第 ' + shotNo + ' 镜的画面出好了 · 这张图也在「快捷创作 → 图片 → 最近生成」里')
      } catch {
        fail({ state: 'failed', message: SHOT_GEN_ATTACH_FAILED, refunded: false, cost: 0, topUp: false })
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '这一下的状态没读到'
      fail({ state: 'failed', message: message + '：任务号 ' + task.id + '，去「最近生成」看它现在是哪一步', refunded: false, cost: 0, topUp: false })
    }
  }, [data, imageModel, load, onToast, projectId, shotGen])

  // 分镜提示词（v0.9.164）：现拼现用，不落库——拼错了改一句文案就能修，盘上也不会多一份会过期的副本。
  // 复制的是一个镜头或整条作品的提示词；出图本身仍发生在无限画布，额度也由那边扣。
  const copyShotText = async (shotNo: number, all = false) => {
    const board = data?.template
    if (!board?.storyboard?.length) return
    const beats = data?.script?.structure?.length ? data.script.structure : board.structure
    const options = { platform: board.platform || board.origin?.platform || '', title: data?.project.title, scriptSource: (data?.script?.source === 'project' ? 'own' : 'template') as 'own' | 'template' }
    let text = ''
    if (all) {
      text = allShotPrompts(board.storyboard, beats, options)
    } else {
      const shot = board.storyboard.find((item, index) => Math.max(1, Math.round(Number(item.shotNo) || index + 1)) === shotNo)
      if (shot) text = shotPrompt(shot, beatForShot(shot, beats), options)
    }
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      onToast(all
        ? '已复制 ' + board.storyboard.length + ' 镜的提示词 · 也可以直接点每一镜的「出这一镜」'
        : '已复制第 ' + shotNo + ' 镜的提示词 · 要现成画面就点「出这一镜」')
    } catch {
      onToast('浏览器没给剪贴板权限：展开提示词后手动选中复制')
    }
  }

  const loadPackageContents = async (version: number, deliveryId: string) => {
    if (!data) return
    setContents({ version, busy: true, result: null, error: '' })
    try {
      if (!deliveryId) throw new Error('这一条交付没有编号，读不了包里的目录')
      const result = await deliveryPackageContents(data.project.id, deliveryId)
      setContents({ version, busy: false, result, error: '' })
    } catch (caught) {
      setContents({
        version,
        busy: false,
        result: null,
        error: caught instanceof Error ? caught.message : '包里的目录没读出来',
      })
    }
  }

  // 整包体检：逐条解开、重算 CRC32，跟目录里记的比。只读接口，不修文件、不写档案；
  // 结论只到「字节对不对」这一层，所以界面不拿它替内容背书。
  const auditPackage = async (version: number, deliveryId: string) => {
    if (!data) return
    if (!deliveryId) {
      onToast('这一版没有封存包，体检不了')
      return
    }
    setAudit({ version, state: 'busy', result: null, error: '' })
    try {
      const result = await deliveryPackageAudit(data.project.id, deliveryId)
      setAudit({ version, state: result.state === 'ok' ? 'done' : 'unreadable', result, error: '' })
    } catch (caught) {
      setAudit({ version, state: 'error', result: null, error: caught instanceof Error ? caught.message : '体检没跑完' })
    }
  }

  // 收据对账（v0.9.136）：贴进来的是一段文字，服务端拿里面的整包 SHA-256 跟这一条封存包比。
  // 对完写回这一条交付记录（刷新还在），同时把本地的这一行一起换掉——不用再等一次整页读。
  const submitReceipt = async (version: number, deliveryId: string) => {
    if (!data) return
    if (!receiptDraft.trim()) {
      setReceiptError('先把收包人发回的收据整段贴进来')
      return
    }
    if (!deliveryId) {
      setReceiptError('这一条交付没有封存包，没有可比的哈希')
      return
    }
    setReceiptBusy(true)
    setReceiptError('')
    try {
      const result = await checkDeliveryReceipt(data.project.id, deliveryId, receiptDraft)
      setData((prev) =>
        prev
          ? {
              ...prev,
              project: {
                ...prev.project,
                // 回执与流水一起换（v0.9.141）：又贴一次之后「和上一次比」和流水都该当场更新，
                // 不用刷新才看见；服务端那边同时把这一次接进流水，这里跟着写同一条。
                deliveries: (prev.project.deliveries || []).map((entry) => {
                  if (entry.id !== deliveryId) return entry
                  const history = entry.receipts?.length
                    ? entry.receipts
                    : entry.receipt
                      ? [entry.receipt]
                      : []
                  const next = history.filter((item) => item.at !== result.receipt.at)
                  return { ...entry, receipt: result.receipt, receipts: [...next, result.receipt].slice(-5) }
                }),
              },
            }
          : prev,
      )
      onToast(
        result.state === 'match'
          ? '对得上：收包人核过的就是这一份 v' + version
          : result.state === 'broken'
            ? '收包人那边读不出来：这一份重发更稳'
            : result.state === 'conflict'
              ? '哈希对得上，但收据的结论写着有问题：先问清对方验的是哪个文件'
              : '对不上：看下面哪一项不是这一份',
      )
    } catch (caught) {
      setReceiptError(caught instanceof Error ? caught.message : '这段收据没对成')
    } finally {
      setReceiptBusy(false)
    }
  }

  // 回执链接（v0.9.137）：复制发给收包人，他自己就能把收据贴回来，不用再转发文字。
  // 换一条 = 服务端换一枚 token，旧地址立刻失效；本地只把这一行的 token 换掉。
  const ensureReceiptLink = async (deliveryId: string, rotate: boolean) => {
    if (!data) return
    setReceiptLinkBusy(rotate ? 'rotate' : 'issue')
    setReceiptError('')
    try {
      const result = await issueReceiptLink(data.project.id, deliveryId, rotate)
      setData((prev) =>
        prev
          ? {
              ...prev,
              project: {
                ...prev.project,
                deliveries: (prev.project.deliveries || []).map((entry) =>
                  entry.id === deliveryId ? { ...entry, receiptToken: result.token } : entry,
                ),
              },
            }
          : prev,
      )
      onToast(rotate ? '换了一条新链接：旧的那条已经失效' : '回执链接好了：复制发给收包人')
    } catch (caught) {
      setReceiptError(caught instanceof Error ? caught.message : '回执链接没生成出来')
    } finally {
      setReceiptLinkBusy('')
    }
  }

  // 这一条是给谁的（v0.9.152）：写一个称呼，或者清掉。
  // 存的是发件人自己记的一行字——不改包、不改收据、不改链接；写空了就回到「没写」。
  const saveRecipient = async (deliveryId: string, value: string) => {
    if (!data || !deliveryId) return
    setRecipientBusy(deliveryId)
    setReceiptError('')
    try {
      const result = await setDeliveryRecipient(data.project.id, deliveryId, value)
      setData((prev) =>
        prev
          ? {
              ...prev,
              project: {
                ...prev.project,
                deliveries: (prev.project.deliveries || []).map((entry) =>
                  entry.id === deliveryId ? { ...entry, recipient: result.recipient || undefined } : entry,
                ),
              },
            }
          : prev,
      )
      // 存下之后把这一条的草稿收掉：输入框跟着档案里的值走，不会留着一份对不上的旧字
      setRecipientDrafts((prev) => {
        const next = { ...prev }
        delete next[deliveryId]
        return next
      })
      if (!result.changed) onToast('没变：这一条本来就写着这个称呼')
      else onToast(result.recipient ? recipientSavedText(result.recipient) : recipientClearedText())
    } catch (caught) {
      setReceiptError(caught instanceof Error ? caught.message : '收件人没记上')
    } finally {
      setRecipientBusy('')
    }
  }

  // 不再等这一份的回执（v0.9.158）：发件人自己收口，随时能撤回。
  // 收口是「等」这件事的决定——不改包、不改收据、不改链接，也不动催过几次那些数。
  const toggleWaitClosed = async (deliveryId: string, closed: boolean) => {
    if (!data || !deliveryId) return
    setWaitBusy(deliveryId)
    setReceiptError('')
    try {
      const result = await closeDeliveryWait(data.project.id, deliveryId, closed)
      setData((prev) =>
        prev
          ? {
              ...prev,
              project: {
                ...prev.project,
                deliveries: (prev.project.deliveries || []).map((entry) =>
                  entry.id === deliveryId
                    ? { ...entry, waitClosedAt: result.closed ? result.at : undefined }
                    : entry,
                ),
              },
            }
          : prev,
      )
      onToast(
        result.closed
          ? '收口了：这一份不再算「还没回来」，档案与链接都照留'
          : '继续等这一份的回执了',
      )
    } catch (caught) {
      setReceiptError(caught instanceof Error ? caught.message : closed ? '没收口成' : '没能改回继续等')
    } finally {
      setWaitBusy('')
    }
  }

  // 他回了什么（v0.9.153）：记一段原话，或者清掉。
  // 存的是发件人抄下来的话——不改包、不改收据、不改链接、不动那些「催过几次」的数。
  const saveReply = async (deliveryId: string, value: string) => {
    if (!data || !deliveryId) return
    setReplyBusy(deliveryId)
    setReceiptError('')
    try {
      const result = await setDeliveryReply(data.project.id, deliveryId, value)
      setData((prev) =>
        prev
          ? {
              ...prev,
              project: {
                ...prev.project,
                deliveries: (prev.project.deliveries || []).map((entry) =>
                  entry.id === deliveryId ? { ...entry, reply: result.reply || undefined } : entry,
                ),
              },
            }
          : prev,
      )
      // 存下之后把这一条的草稿收掉：输入框跟着档案里的原话走，不会留一份对不上的旧字
      setReplyDrafts((prev) => {
        const next = { ...prev }
        delete next[deliveryId]
        return next
      })
      if (!result.changed) onToast('没变：这一条本来就记着这段话')
      else onToast(result.reply ? replySavedText() : replyClearedText())
    } catch (caught) {
      setReceiptError(caught instanceof Error ? caught.message : '回复没记上')
    } finally {
      setReplyBusy('')
    }
  }

  const copyReceiptLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(receiptLinkUrl(token))
      onToast('已复制回执链接：发给收包人，他打开就能把收据贴回来')
    } catch {
      onToast('复制失败：浏览器没给剪贴板权限')
    }
  }

  // 给收包人的那段话（v0.9.143）：收据里已经把差别摆开了，这一步把它写成能直接发出去的两三句。
  const copyReceiptOutreach = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      onToast('已复制：发给收包人，让他照着重验一次')
    } catch {
      onToast('复制失败：浏览器没给剪贴板权限')
    }
  }

  // 换一行、收起时把草稿与上一次的报错清掉；已经记下的结论跟着交付记录走，不清。
  const toggleReceipt = (version: number) => {
    setReceiptOpen(receiptOpen === version ? 0 : version)
    setReceiptDraft('')
    setReceiptError('')
  }

  // 「清单」按钮：同一时间只开一行；换一行、收起时都把上一行的预览一起收掉
  const toggleArchive = (version: number, deliveryId: string) => {
    const next = archiveOpen === version ? 0 : version
    setArchiveOpen(next)
    setPreview({ version: 0, deliveryId: '', name: '', kind: 'other', status: 'idle', text: '', note: '', error: '' })
    setAudit({ version: 0, state: 'idle', result: null, error: '' })
    if (!next) return
    if (contents.version === version && (contents.busy || contents.result || contents.error)) return
    void loadPackageContents(version, deliveryId)
  }

  const closePreview = () => {
    setPreview({ version: 0, deliveryId: '', name: '', kind: 'other', status: 'idle', text: '', note: '', error: '' })
  }

  // 单条内容：图片与页面按地址取（页面进沙箱 iframe，脚本跑不起来），文字读回来给 <pre>。
  // 服务端解开每一条都会先验 CRC32；对不上回 409，这里照实说，不把那堆字节当内容。
  const openPackageEntry = async (version: number, deliveryId: string, entry: PackageEntry) => {
    if (!data) return
    if (preview.version === version && preview.name === entry.name) {
      closePreview()
      return
    }
    if (entry.kind !== 'text') {
      setPreview({ version, deliveryId, name: entry.name, kind: entry.kind, status: 'ready', text: '', note: '', error: '' })
      return
    }
    setPreview({ version, deliveryId, name: entry.name, kind: 'text', status: 'loading', text: '', note: '', error: '' })
    try {
      const response = await fetch(deliveryPackageEntryUrl(data.project.id, deliveryId, entry.name), {
        credentials: 'same-origin',
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error || '这一条读不出来')
      }
      const raw = await response.text()
      const limit = 20000
      setPreview({
        version,
        deliveryId,
        name: entry.name,
        kind: 'text',
        status: 'ready',
        text: raw.slice(0, limit),
        note: raw.length > limit ? '只显示前 2 万字符，全文下载包来解压' : '',
        error: '',
      })
    } catch (caught) {
      setPreview({
        version,
        deliveryId,
        name: entry.name,
        kind: 'text',
        status: 'error',
        text: '',
        note: '',
        error: caught instanceof Error ? caught.message : '这一条没读出来',
      })
    }
  }

  // 交付稿：脚本、分镜、评审结论、版本与运行压成一份 Markdown，直接落盘。
  // 只读接口，不扣积分；导出的是「当前这一版」，不是整条作品的历史合集。
  const exportDeliverable = async () => {
    if (!data) return
    setBusy('export')
    try {
      const result = await downloadProjectDeliverable(data.project.id)
      onToast('交付稿已导出：' + result.name)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '交付稿没导出成功')
    } finally {
      setBusy('')
    }
  }

  // 交付包：交付稿 + 现场页 + 帧图打成一个 zip。第一次打包要在服务端读一遍帧图，稍慢。
  const exportZip = async () => {
    if (!data) return
    setBusy('zip')
    try {
      const result = await downloadProjectDeliverableZip(data.project.id)
      onToast('交付包已导出：' + result.name)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '交付包没导出成功')
    } finally {
      setBusy('')
    }
  }

  // 打印稿 / 现场页：新标签里打开一张排好版的 A4，打印（存 PDF）交给浏览器。
  // 不走 fetch：打印页要有自己的地址，刷新一下还能再打印一次。
  const openPaper = (url: string, blocked: string) => {
    const opened = window.open(url, '_blank')
    if (!opened) {
      onToast(blocked)
      return
    }
    // 打印页不需要反过来操作作品页
    try {
      opened.opener = null
    } catch {
      // 跨源时改不了 opener，忽略
    }
  }

  const openPrint = () => {
    if (!data) return
    openPaper(deliverablePrintUrl(data.project.id), '新标签被浏览器拦下了：允许本站弹窗，或者先用「交付稿」拿 Markdown')
  }

  const openSetSheet = () => {
    if (!data) return
    openPaper(setSheetUrl(data.project.id), '新标签被浏览器拦下了：允许本站弹窗，或者下载「交付包」里的现场页')
  }

  const openReviewSheet = () => {
    if (!data) return
    openPaper(reviewSheetUrl(data.project.id), '新标签被浏览器拦下了：允许本站弹窗，或者下载「交付包」里的评审对照页')
  }

  const remove = async () => {
    if (!data) return
    // v0.9.253：删掉的作品进回收站，30 天内能原样恢复——所以这里敢直说「去哪能找回来」
    if (!window.confirm('把这条作品移到回收站？脚本、分镜、版本、交付记录和评审会一起进去，30 天内可以在「作品 → 回收站」恢复。')) return
    setBusy('delete')
    try {
      const result = await deleteProject(data.project.id)
      const days = result.trash?.days || 30
      onToast('已移到回收站，' + days + ' 天内在「作品 → 回收站」可以恢复')
      onBack()
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '删除失败')
      setBusy('')
    }
  }

  const beginRename = () => {
    if (!data) return
    setDraftTitle(data.project.title)
    setRenaming(true)
  }

  const saveTitle = async () => {
    if (!data) return
    const title = draftTitle.trim()
    if (!title) {
      onToast('作品名不能是空的')
      return
    }
    if (title === data.project.title) {
      setRenaming(false)
      return
    }
    setBusy('title')
    try {
      const result = await updateProject(data.project.id, { title })
      setData({ ...data, project: result.project })
      setRenaming(false)
      onToast('作品名已改成「' + result.project.title + '」')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '改名没保存成功')
    } finally {
      setBusy('')
    }
  }

  // 开新版＝复制当前工作流；旧工作流归档成 vN，作品立刻指向新工作流。
  const startVersion = async () => {
    if (!data || busy) return
    setBusy('version')
    try {
      const result = await startProjectVersion(data.project.id)
      await load()
      onToast('已开 v' + result.project.version + '：工作流从上一版复制过来，接着改这一版')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '开新版本失败')
    } finally {
      setBusy('')
    }
  }

  // 以旧版为底开新版（v0.9.115）：点两下才执行。新一版复制旧版工作流与脚本，当前版归档；
  // 不覆盖任何历史，所以不需要原生 confirm。第一下只把按钮换成「再点一次」。
  const rebaseVersion = async (row: { n: number; scriptBeats: number }) => {
    if (!data || busy) return
    if (!row.scriptBeats) {
      onToast('这一版开版时没存脚本快照，没法整版回到当时；只能打开那一版工作流手动改')
      return
    }
    if (rebaseArmed !== row.n) {
      setRebaseArmed(row.n)
      return
    }
    setRebaseArmed(null)
    setBusy('rebase')
    try {
      const result = await startProjectVersion(data.project.id, row.n)
      await load()
      onToast(
        '已以 v' + row.n + ' 为底开 v' + result.project.version +
        '：工作流和脚本回到那一版，v' + (result.project.version - 1) + ' 已归档，记录都还在',
      )
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '以旧版为底开新版失败')
    } finally {
      setBusy('')
    }
  }

  // 草稿改没改（r270）：基线是开编辑那一刻的样子，逐字比。8 段以内，比一次不心疼。
  const scriptDirty = Boolean(
    scriptEditing && scriptDraft && JSON.stringify(scriptDraft) !== scriptBaseline,
  )

  // 有改动就登记，跳走时路由会先问一句；存好、取消、卸载都把它撤掉。
  useEffect(() => {
    if (!scriptDirty) {
      clearUnsaved(SCRIPT_UNSAVED_OWNER)
      return
    }
    setUnsaved({
      owner: SCRIPT_UNSAVED_OWNER,
      message: '这条作品的脚本改了还没保存，现在离开就丢了。想留着就选「留在这页」，写完点「保存脚本」。',
    })
    return () => clearUnsaved(SCRIPT_UNSAVED_OWNER)
  }, [scriptDirty])

  // 进入脚本编辑：用自己的版本，没有就把当前看到的（模板脚本）拷一份草稿出来，
  // 保存时才真正落库——不想改就取消，作品不会平白多一份副本。
  const beginScript = () => {
    const script = data?.script
    const structure: ScriptBeat[] = script?.structure?.length
      ? script.structure.map((beat) => ({ ...beat }))
      : [{ beat: '', startSec: 0, endSec: 0, voiceover: '', onScreen: '', purpose: '' }]
    const draft = { hook: script?.hook || '', structure }
    setScriptDraft(draft)
    setScriptBaseline(JSON.stringify(draft))
    setScriptEditing(true)
  }

  const patchScriptBeat = (index: number, patch: Partial<ScriptBeat>) => {
    setScriptDraft((current) =>
      current
        ? { ...current, structure: current.structure.map((beat, i) => (i === index ? { ...beat, ...patch } : beat)) }
        : current,
    )
  }

  const addScriptBeat = () => {
    setScriptDraft((current) =>
      current && current.structure.length < 12
        ? { ...current, structure: [...current.structure, { beat: '', startSec: 0, endSec: 0, voiceover: '', onScreen: '', purpose: '' }] }
        : current,
    )
  }

  const removeScriptBeat = (index: number) => {
    setScriptDraft((current) =>
      current && current.structure.length > 1
        ? { ...current, structure: current.structure.filter((_, i) => i !== index) }
        : current,
    )
  }

  const cancelScript = () => {
    // 改了才问（r270）：打开看一眼就关不必拦，写了一半关掉才需要一句确认
    if (scriptDirty && !window.confirm('这条脚本草稿有改动，取消就丢了。要继续取消吗？')) return
    clearUnsaved(SCRIPT_UNSAVED_OWNER)
    setScriptEditing(false)
    setScriptDraft(null)
    setScriptBaseline('')
  }

  const saveScript = async () => {
    if (!data || !scriptDraft) return
    const structure = scriptDraft.structure
      .map((beat) => ({ ...beat, beat: beat.beat.trim(), voiceover: beat.voiceover.trim(), onScreen: beat.onScreen.trim() }))
      .filter((beat) => beat.beat || beat.voiceover || beat.onScreen)
    if (!structure.length) {
      onToast('脚本至少要留一段：段落名、口播或屏幕字写一个')
      return
    }
    setBusy('script')
    try {
      const result = await saveProjectScript(data.project.id, { hook: scriptDraft.hook.trim(), structure })
      // 先撤登记再关编辑：后面 load() 会重渲染，不能让「已存好」的一页还挂着拦截
      clearUnsaved(SCRIPT_UNSAVED_OWNER)
      setScriptEditing(false)
      setScriptDraft(null)
      setScriptBaseline('')
      await load()
      const note = SCRIPT_CANVAS_NOTE[result.canvas?.reason || ''] || ''
      onToast('脚本已保存' + (note ? '：' + note : ''))
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '脚本没保存成功')
    } finally {
      setBusy('')
    }
  }

  const restoreScript = async () => {
    if (!data) return
    if (!window.confirm('恢复成模板的脚本？这条作品自己改过的脚本会丢掉，模板本身不动。')) return
    setBusy('script')
    try {
      const result = await resetProjectScript(data.project.id)
      await load()
      onToast(result.script ? '已恢复成模板的脚本，工作流提示词也跟着回去了' : '已清掉作品自己的脚本')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '恢复失败')
    } finally {
      setBusy('')
    }
  }

  // 存成模板：只写模板库新的一条，作品与它绑定的模板一个字不动（服务端两道闸：没脚本 / 没分镜都不落库）
  const openTemplateSheet = () => {
    setTplSheet({ open: true, title: data?.project.title || '', busy: false, error: '', done: null })
  }

  const submitTemplate = async () => {
    if (!data) return
    setTplSheet((current) => ({ ...current, busy: true, error: '' }))
    try {
      const result = await saveProjectAsTemplate(data.project.id, { title: tplSheet.title.trim() })
      setTplSheet((current) => ({ ...current, busy: false, done: result.template }))
      onToast('已存成模板：《' + result.template.title + '》（' + result.template.beats + ' 段 · ' + result.template.shots + ' 镜）')
      await load()
    } catch (caught) {
      setTplSheet((current) => ({ ...current, busy: false, error: caught instanceof Error ? caught.message : '存成模板失败' }))
    }
  }

  const closeTemplateSheet = () => setTplSheet({ open: false, title: '', busy: false, error: '', done: null })

  if (loading && !data) {
    return (
      <div className="page vq-page">
        <p className="vq-note">正在打开作品…</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="page vq-page">
        <p className="vq-note vq-note--error" role="status">
          {error || '作品不存在或已被删除'}
        </p>
        <button type="button" className="vq-button vq-button--ghost" onClick={onBack}>
          <ArrowLeft size={14} />
          回到作品列表
        </button>
      </div>
    )
  }

  const { project, template, flow, reviews } = data
  // 这条作品花掉的积分（v0.9.65）：评审与工作流运行分开记，退过款的那次运行不算
  const spend = data.spend
  // 明细里的「累计 / 本月」两枚胶囊上的数字：byMonth 按全部记录算，切范围时上面的数字不跟着缩水
  const spendByMonth = spendDetail?.byMonth || []
  const spendTotalAll = spendByMonth.reduce((sum, row) => sum + row.total, 0)
  const spendTotalMonth = spendByMonth.find((row) => row.month === spendDetail?.month)?.total || 0
  // 脚本是作品页自己的视图：改过就是这条作品自己的版本，没改过则跟随模板
  const script = data.script
  // 分镜提示词（v0.9.164）：出图不在这边，但「这一镜该让人看见什么」在。
  // 脚本优先用这条作品自己的那份（改过脚本的复刻，画面要跟着新词走），没有才退回模板脚本。
  const promptBeats = script?.structure?.length ? script.structure : template?.structure || []
  const promptScriptSource: ShotPromptScriptSource = script?.source === 'project' ? 'own' : promptBeats.length ? 'template' : 'none'
  // 平台代号与开工作流时服务端用的是同一个字段（r277）：模板自己的 platform 优先，
  // 老数据没有时退回来源里的平台。认不出平台就不写比例，不替用户决定竖屏还是横屏。
  const promptPlatform = template?.platform || template?.origin?.platform || ''
  // 开工作流会建几个出图节点、每张多少积分（r277）：点之前先摆出来，
  // 别等跑完一次才发现「原来这次不是只出一段文字」。节点本身不扣钱，钱在运行时。
  const storyboardShots = template?.storyboard?.length || 0
  const shotEachPrice = imageModel?.price ?? 0
  // 状态与「下一步」只看当前这一版评过没有：新版刚开出来时不能因为上一版评过就跳过评审
  const currentReviews = reviewsForVersion(data.versionCounts, project.version)
  // 「这一版比上一版好在哪」：只在前后两版都评过、且都记了严重度时才算得出来（v0.9.84）
  const previousVersion = project.version > 1 ? project.version - 1 : 0
  const previousReviews = previousVersion ? reviewsForVersion(data.versionCounts, previousVersion) : null
  const issueDelta = issueCompare(previousReviews?.issues, currentReviews.issues)
  const currentIssueLine = issueLine(currentReviews.issues)
  // 人工复核：服务端已经按「当前这一版最近一次评审」挑好了，对不上就是 null（拍板自动失效）
  const decision = data.decision ?? null
  // 拍板记录（v0.9.26）：这条作品名下每一次拍板都留着，按拍板时间倒序；还算不算数由服务端算好（state）。
  // 回看要回答的是「上一版为什么放行」，所以每行都带上那次评审的模型结论与当时的备注。
  const decisionLog = data.decisions ?? []
  // 记录点得进那一次评审的证据：评审列表里还在，就按评审时间对上
  const reviewByCreatedAt = new Map(reviews.map((item) => [item.createdAt, item]))
  // 「已看过」同理：版次与评审时间都对上才算
  const ack = data.ack ?? null
  // 输入框显示哪句话：没动过就是这条拍板的备注，动过就是人正在打的字
  const noteValue = decisionNote ?? decision?.note ?? ''
  // 模型给了「需人工确认 / 不通过」的才需要拍板：通过的那一版不需要人再确认一次
  const canDecide = currentReviews.lastVerdict === 'needs_review' || currentReviews.lastVerdict === 'fail'
  const step = projectStep(project, currentReviews, decision)
  const scriptBeats = script ? script.structure.length : 0
  // 交付留痕：最近一次交的是哪一版；开了新版之后旧版那条仍在，但这一版不再算已交付
  const delivery = deliveryOf(project)
  const delivered = deliveredCurrent(project)
  const deliveredVersions = new Map<number, ProjectDelivery>(
    (Array.isArray(project.deliveries) ? project.deliveries : []).map((entry) => [entry.version, entry]),
  )
  // 老记录没有交付条目：状态是已交付就当当前这一版交过，只是时间没记录
  if (delivered && !delivery && project.version) deliveredVersions.set(project.version, { version: project.version, at: '' })
  // 交付档案（v0.9.126）：交过的每一版，最近的排前面；有没有包、包多大都从这里现算
  const archive = deliveryArchive(project)
  // 巡检那句放在档案区顶部：什么时候验的、几个包、有没有问题
  const auditSummary = audits.at
    ? '上次巡检 ' + stamp(audits.at) + ' · ' +
      (audits.problems
        ? audits.problems + ' 个包有问题'
        : audits.checked
          ? audits.checked + ' 个包都对得上 CRC32'
          : '还没有封存包') +
      '（定时任务每天验一遍）'
    : ''
  const versionRows = [
    {
      n: project.version,
      flowId: project.flowId,
      // 当前版用作品名：工作流名是建版本那一刻的标题，改名后拿它当行标题会显得对不上
      name: project.title,
      archivedAt: '',
      available: Boolean(flow),
      nodes: flow ? flow.nodes : 0,
      scriptBeats,
      // 当前这一版的来源：回退开出来的版本刷新后也要看得见（v0.9.116）
      basedOn: project.basedOn || 0,
      current: true,
    },
    ...data.versions.map((item) => ({ ...item, current: false })),
  ].sort((a, b) => b.n - a.n)
  // 每个版本相对上一版改了什么：服务端按同一份 diff 实现算好，页面只负责排成一句
  const versionChanges = data.versionChanges || {}

  return (
    <div className="page vq-page vq-project-page vq-project-detail">
      <button type="button" className="vq-project-back" onClick={onBack}>
        <ArrowLeft size={13} />
        全部作品
      </button>

      <PageHead
        kicker={
          <>
            <span>作品</span>
            <span className="vq-head-sep" aria-hidden="true">·</span>
            <span className="vq-mono">{project.id}</span>
            {project.version ? (
              <>
                <span className="vq-head-sep" aria-hidden="true">·</span>
                <span className="vq-mono">v{project.version}</span>
              </>
            ) : null}
          </>
        }
        title={
          renaming ? (
            <form
              className="vq-rename"
              onSubmit={(event) => {
                event.preventDefault()
                void saveTitle()
              }}
            >
              <input
                className="vq-rename-input"
                value={draftTitle}
                maxLength={80}
                autoFocus
                aria-label="作品名"
                onChange={(event) => setDraftTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenaming(false)
                }}
              />
              <button type="submit" className="vq-button vq-button--primary" disabled={busy === 'title'}>
                保存
              </button>
              <button type="button" className="vq-button vq-button--ghost" onClick={() => setRenaming(false)}>
                取消
              </button>
            </form>
          ) : (
            <span className="vq-title-edit">
              {project.title}
              <button type="button" className="vq-title-edit-btn" onClick={beginRename} aria-label="改作品名" title="改作品名">
                <Pencil size={14} />
              </button>
            </span>
          )
        }
        desc={
          <>
            <span className="vq-project-headline">
              <ProjectStatusPill project={project} reviews={currentReviews} decision={decision} />
              {delivered && delivery ? (
                <span
                  className="vq-mono vq-project-delivered"
                  title="交付记录：这一版是哪一刻交出去的。重新打开会收回这一版的交付，开新版则把它留在上一版"
                >
                  交付 v{delivery.version}
                  {delivery.at ? ' · ' + stamp(delivery.at) : ' · 时间没记录'}
                </span>
              ) : null}
              <span className="vq-mono">更新 {stamp(project.updatedAt)}</span>
              {template && template.title !== project.title ? <span className="vq-mono">模板 · {template.title}</span> : null}
            </span>
          </>
        }
        actions={
          <>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'vq-spin' : undefined} />
              刷新
            </button>
            <button
              type="button"
              className="vq-button vq-button--ghost"
              onClick={() => void toggleDone()}
              disabled={busy === 'done'}
              title={
                delivered
                  ? '把这条作品放回「在做」，并收回这一版的交付记录；上一版交过的记录留着'
                  : '标记这一版已交付：会记下是哪一版、什么时候交的'
              }
            >
              {delivered ? '重新打开' : '标记交付'}
            </button>
            {/* 交付：五种产物收在一个入口里。页头再放五个按钮就排成一条工具条了，
                而「交付这一版」本来就是一件事的几种形态。 */}
            <div className="vq-actions-menu" ref={deliverRef}>
              <button
                type="button"
                className="vq-button vq-button--ghost"
                aria-haspopup="menu"
                aria-expanded={deliverOpen}
                onClick={() => setDeliverOpen((value) => !value)}
                disabled={busy === 'export' || busy === 'zip'}
                title="交付这一版：Markdown 全文、A4 打印稿、现场页、评审对照、交付包（含两版对照）"
              >
                <Download size={14} />
                {busy === 'export' ? '正在整理…' : busy === 'zip' ? '正在打包…' : '交付'}
                <ChevronDown size={13} className="vq-actions-chevron" />
              </button>
              {deliverOpen && (
                <div className="vq-menu vq-export-menu" role="menu">
                  <div className="vq-menu-head">
                    <div>
                      <strong>交付这一版</strong>
                      <span className="vq-mono">
                        v{project.version} · 脚本 {scriptBeats} 段 · 分镜 {template ? template.shots : 0} 镜
                      </span>
                    </div>
                  </div>
                  {/* 导出是取产物，不是宣布交付：把「标记交付」这一步说清楚，别让人以为导完就算交了 */}
                  {delivered ? null : (
                    <>
                      <p className="vq-export-note">导出不会改状态；点页头「标记交付」才记交付。</p>
                      {/* 交付前先说清楚会记下什么：这一刻的评审跟着这一版走，之后重评也不改它 */}
                      <p className="vq-export-note">
                        交时评审会记为
                        {currentReviews.count
                          ? '「' + (VERDICT_LABEL[currentReviews.lastVerdict] || '未记结论') + '」' +
                            (currentIssueLine ? ' · ' + currentIssueLine : '')
                          : '「还没评过」'}
                        ，之后重评不改这条记录。
                      </p>
                    </>
                  )}
                  {/* 合规标识是产物的固定一部分：先说清楚，收件人才不会把稿子当成人工复核过的结论 */}
                  <p className="vq-export-note">
                    每份产物都带「AI 生成」标识与说明：交付稿在文首，三张纸在品牌行与纸脚，只读分享页在顶部与底部。
                  </p>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDeliverOpen(false)
                      void exportDeliverable()
                    }}
                  >
                    <FileText size={15} />
                    <span className="vq-menu-copy">
                      <strong>交付稿</strong>
                      <small>Markdown：脚本、分镜、评审、运行、逐版对照</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDeliverOpen(false)
                      openPrint()
                    }}
                  >
                    <Printer size={15} />
                    <span className="vq-menu-copy">
                      <strong>打印稿</strong>
                      <small>A4 全文，浏览器里打印或存 PDF</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDeliverOpen(false)
                      openSetSheet()
                    }}
                  >
                    <Clapperboard size={15} />
                    <span className="vq-menu-copy">
                      <strong>现场页</strong>
                      <small>只留脚本与分镜，带原片帧图；打开后可只印其中几镜</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDeliverOpen(false)
                      openReviewSheet()
                    }}
                  >
                    <ScanEye size={15} />
                    <span className="vq-menu-copy">
                      <strong>评审对照</strong>
                      <small>评审说过的问题框在画面上，编号对得上；打印或存 PDF</small>
                    </span>
                  </button>
                  <div className="vq-menu-sep" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDeliverOpen(false)
                      void exportZip()
                    }}
                  >
                    <Package size={15} />
                    <span className="vq-menu-copy">
                      <strong>交付包</strong>
                      <small>.zip：交付稿 + 现场页 + 评审对照 + 两版对照 + 帧图，解压就能看；标记交付时另存一份，工作台「交出去的」可原样下载</small>
                    </span>
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="vq-button vq-button--ghost"
              onClick={openShare}
              title={data.share ? '这条作品正在只读分享' : '生成一条只读链接发给没有账号的人'}
            >
              <Share2 size={14} />
              分享
              {data.share ? <span className="vq-share-live" aria-label="分享中" /> : null}
            </button>
            <button type="button" className="vq-button vq-button--danger" onClick={() => void remove()} disabled={busy === 'delete'}>
              <Trash2 size={14} />
              删除
            </button>
          </>
        }
      />

      <section className="vq-next vq-project-hero" aria-labelledby="vq-project-next">
        <div className="vq-next-main">
          <span className="vq-next-label">{step.label}</span>
          <h2 id="vq-project-next">{step.title}</h2>
          <p className="vq-project-hint">{step.hint}</p>
          {issueDelta && currentIssueLine ? (
            <p className={'vq-project-issue-line is-' + issueDelta.tone}>
              这一版 {currentIssueLine}
              <span className="vq-project-issue-delta">
                比第 {previousVersion} 版{issueDelta.delta < 0 ? '少' : '多'} {Math.abs(issueDelta.delta)} 个
                {ISSUE_LABEL[issueDelta.level]}
              </span>
            </p>
          ) : null}
          <button
            type="button"
            className="vq-next-cta"
            disabled={busy === 'canvas'}
            onClick={() => {
              if (step.key === 'review') onOpenReview(project.id)
              // 评审通过了：主卡直接把人带到「交付这一版」那个菜单，不再让人自己去找页头
              else if (step.key === 'deliver') setDeliverOpen(true)
              else if (!project.flowId && !script) beginScript()
              else void openCanvas()
            }}
          >
            {busy === 'canvas' ? '正在生成工作流…' : !project.flowId && !script ? '先写一条脚本' : step.cta}
            <ArrowRight size={15} />
          </button>
        </div>
        <dl className="vq-next-stats">
          <div>
            <dt>脚本</dt>
            <dd>{script ? script.structure.length : 0}</dd>
          </div>
          <div>
            <dt>分镜</dt>
            <dd>{template ? template.shots : 0}</dd>
          </div>
          <div>
            <dt>评审</dt>
            <dd>{reviews.length}</dd>
          </div>
          <div>
            <dt>运行</dt>
            <dd>{data.runTotal}</dd>
          </div>
        </dl>
      </section>

      {project.version ? (
        <section className="vq-project-versions" aria-labelledby="vq-project-versions-head">
          <div className="vq-project-versions-head">
            <h2 id="vq-project-versions-head">
              版本对照
              <span className="vq-mono">{project.version} 版</span>
            </h2>
            <p className="vq-project-versions-note">
              开新版时会把这一版的脚本存一份快照，再改只影响新版；每一行写清「比上一版改了什么」，点脚本段数能翻开那一版的原文。归档版还能「以这一版为底」再开一版：工作流和脚本回到那一版，当前版归档，记录都保留；那一行会标出底座，改动也按底座算。右上「两版对照」可以任选两版，逐项看工作流节点与脚本口播，只读、不扣积分。
            </p>
            <div className="vq-project-versions-actions">
              <button
                type="button"
                className="vq-button vq-button--ghost"
                onClick={() => setCompareOpen(true)}
                disabled={project.version < 2 || busy === 'version' || busy === 'rebase'}
                title={project.version < 2 ? '至少要有两版才能对照' : '只读对照任意两版：工作流节点与脚本口播逐项列出来'}
              >
                <ScanEye size={14} />
                两版对照
              </button>
              <button
                type="button"
                className="vq-button vq-button--ghost"
                onClick={() => void startVersion()}
                disabled={busy === 'version' || busy === 'rebase'}
              >
                <CopyPlus size={14} />
                {busy === 'version' ? '正在复制工作流…' : '开一版新的'}
              </button>
            </div>
          </div>
          <ol className="vq-version-list">
            {versionRows.map((row) => {
              const counter = reviewsForVersion(data.versionCounts, row.n)
              const runCount = runsForVersion(data.runCounts || {}, row.n)
              // 以旧版为底的那一版：优先用服务端算好的「跟底座比」，标签也换成底座；
              // 没有这一项就还是原来的「比上一版」，老版本数据不受影响（v0.9.116）
              const baseChange = data.versionBaseChanges?.[row.n]
              const changeText = baseChange?.text || versionChanges[row.n]
              const changeBase = baseChange?.base || row.n - 1
              // 问题数与「比上一版多了还是少了」都从同一份统计现算，不另存（v0.9.84）
              const issueText = issueLine(counter.issues)
              const issueMissing = issueGap(counter.issues)
              const rowDelta = row.n > 1 ? issueCompare(reviewsForVersion(data.versionCounts, row.n - 1).issues, counter.issues) : null
              // 交出去之后这一版又被评成了别的结论没有：拿交时快照和这一版最近一评比（v0.9.86）
              const rowDrift = deliveryDrift(deliveredVersions.get(row.n)?.review, { verdict: counter.lastVerdict, issues: counter.issues })
              // 这一版的评审逐条列出来：点一条直接看当时的证据原图，别只留一个「2 次评审」
              const rowReviews = reviewsOfVersion(reviews, row.n)
              return (
                <li className={'vq-version-row' + (row.current ? ' is-current' : '')} key={row.n}>
                  <span className="vq-version-n vq-mono">v{row.n}</span>
                  <div className="vq-version-main">
                    <strong>{row.name}</strong>
                    <span className="vq-version-meta">
                      <span className="vq-mono">{row.current ? '最新' : '归档 ' + stamp(row.archivedAt)}</span>
                      {row.basedOn ? (
                        <span
                          className="vq-version-lineage"
                          title={
                            '这一版开版时复制的是 v' + row.basedOn + ' 的工作流和脚本；下方的改动也按 v' + row.basedOn + ' 算'
                          }
                        >
                          以 v{row.basedOn} 为底
                        </span>
                      ) : null}
                      <span>{row.nodes} 节点</span>
                      {/* 没存快照的旧版本写清楚：不能让人以为「那一版就是现在的脚本」 */}
                      {row.scriptBeats ? (
                        row.current ? (
                          <span>{row.scriptBeats} 段脚本</span>
                        ) : (
                          <button
                            type="button"
                            className="vq-version-script"
                            onClick={() => void openVersionScript(row)}
                            title={'读 v' + row.n + ' 开新版时存下的脚本原文'}
                          >
                            {row.scriptBeats} 段脚本
                            <ArrowRight size={11} />
                          </button>
                        )
                      ) : (
                        <span>{row.current ? '没写脚本' : '脚本没存快照'}</span>
                      )}
                      <span>{counter.count ? counter.count + ' 次评审' : '未评审'}</span>
                      {issueText ? (
                        <span
                          className="vq-version-issues"
                          title={
                            '这一版最近一次评审的问题数（按严重度）' +
                            (issueMissing ? '；另有 ' + issueMissing + ' 条没记严重度' : '')
                          }
                        >
                          最近一评 {issueText}
                        </span>
                      ) : null}
                      {rowDelta ? (
                        <span className={'vq-version-delta is-' + rowDelta.tone}>
                          比 v{row.n - 1} {rowDelta.delta < 0 ? '少' : '多'} {Math.abs(rowDelta.delta)} 个
                          {ISSUE_LABEL[rowDelta.level]}
                        </span>
                      ) : null}
                      <span>{runCount ? runCount + ' 次运行' : '没跑过'}</span>
                      {deliveredVersions.has(row.n) ? (
                        <>
                          <span
                            className="vq-version-delivered"
                            title="这一版交出去过；重新打开这一版会收回这条记录，开新版会把它留在上一版"
                          >
                            交付过
                            {deliveredVersions.get(row.n)?.at ? ' · ' + stamp(deliveredVersions.get(row.n)?.at as string) : ' · 时间没记录'}
                          </span>
                          {/* 交出去那一刻的评审：之后这一版再重评，这条记录也不改 */}
                          <span
                            className="vq-version-delivered-review"
                            title="交付时存下的评审快照：之后这一版重评，这条记录也不会被改写"
                          >
                            交时评审：{deliveryReviewText(deliveredVersions.get(row.n)?.review)}
                          </span>
                          {/* 交出去之后这一版又被评成了别的结论：记录不改，后来变了什么要说（v0.9.86） */}
                          {rowDrift ? (
                            <span
                              className={'vq-version-drift is-' + rowDrift.tone}
                              title="交出去之后这一版又被评过：这句写的是最近一评；交付记录本身不改，同一版重新标记交付才会写新快照"
                            >
                              · {deliveryDriftText(rowDrift)}
                            </span>
                          ) : null}
                        </>
                      ) : null}
                    </span>
                    {changeText ? (
                      <p
                        className={'vq-version-change' + (baseChange ? ' is-based' : '')}
                        title={
                          baseChange
                            ? '这一版以 v' + baseChange.base + ' 为底：这句是相对底座算的，不是相对上一版；节点只比类型与配置，脚本按段名比口播'
                            : '节点只比类型与配置，移动位置或改标题不算；脚本按段名比口播，开新版时存的快照才算'
                        }
                      >
                        <span className="vq-mono">比 v{changeBase}</span>
                        {changeText}
                      </p>
                    ) : null}
                    {rowReviews.length ? (
                      <ul className="vq-version-reviews">
                        {rowReviews.slice(0, 3).map((review) => (
                          <li key={review.id}>
                            <button
                              type="button"
                              className={'vq-version-review is-' + (review.verdict || 'none')}
                              onClick={() => onOpenReviewRecord(review.id)}
                              title={'看这次评审的证据原图（' + (VERDICT_LABEL[review.verdict] || '未记录') + '）'}
                            >
                              <span className="vq-version-review-verdict">{VERDICT_LABEL[review.verdict] || '未记录'}</span>
                              <span className="vq-mono">{stamp(review.createdAt)}</span>
                              <ArrowRight size={11} />
                            </button>
                          </li>
                        ))}
                        {rowReviews.length > 3 ? (
                          <li className="vq-version-review-more vq-mono">还有 {rowReviews.length - 3} 条在右边「评审」里</li>
                        ) : null}
                      </ul>
                    ) : null}
                  </div>
                  <div className="vq-version-actions">
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-version-open"
                      onClick={() => onOpenFlow(row.flowId)}
                      disabled={!row.available || busy === 'version' || busy === 'rebase'}
                      title={row.available ? '在工作流里打开 v' + row.n : '这一版的工作流已被删除'}
                    >
                      {row.available ? '打开工作流' : '工作流已删除'}
                      {row.available ? <ArrowRight size={13} /> : null}
                    </button>
                    {!row.current ? (
                      <button
                        type="button"
                        className={'vq-button vq-button--ghost vq-version-rebase' + (rebaseArmed === row.n ? ' is-armed' : '')}
                        onClick={() => void rebaseVersion(row)}
                        disabled={busy === 'version' || busy === 'rebase' || !row.scriptBeats}
                        title={
                          row.scriptBeats
                            ? '以 v' + row.n + ' 的工作流和脚本为底开 v' + (project.version + 1) +
                              '；v' + project.version + ' 会归档，所有记录都保留'
                            : '这一版开版时没存脚本快照，没法整版回到当时'
                        }
                      >
                        <RotateCcw size={13} />
                        {rebaseArmed === row.n ? '再点一次 · 开 v' + (project.version + 1) : '以这一版为底'}
                      </button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}

      {archive.rows.length ? (
        <section className="vq-project-archive" id="vq-project-archive" aria-labelledby="vq-project-archive-head">
          <div className="vq-project-archive-head">
            <h2 id="vq-project-archive-head">
              交付档案
              <span className="vq-mono">
                {archive.sealed} 个包
                {archive.sealed ? ' · ' + packageBytesLabel(archive.bytes) : ''}
                {archive.legacy ? ' · ' + archive.legacy + ' 版没包' : ''}
              </span>
            </h2>
            <p className="vq-project-archive-note">
              标记交付时封存的那一份，之后改模板、改脚本、开新版都不会变。手里那份拖进「核对」在本机算，服务器上那份点「查一遍哈希」在服务端算，两头都对上才算数；包里那份不用解压，点清单里的文件名就能看。收包人验完会发回一段收据，贴进「收据」就能对一遍，结论记在这一行上。包只认登录态，不走公开分享。
            </p>
          </div>
          {/* 从工作台点进来的那一条（v0.9.140）：先落在哪一版、这一版有没有包、贴没贴过回执 */}
          {landing ? (
            <p className={'vq-archive-landing' + (landing.missing ? ' is-miss' : '')} role="status">
              {deliveryLandingText(landing)}
            </p>
          ) : null}
          {auditSummary ? (
            <p className={'vq-project-archive-audit' + (audits.problems ? ' is-bad' : '')}>{auditSummary}</p>
          ) : null}
          <ul className="vq-archive-list">
            {archive.rows.map((row) => {
              const pkg = row.package
              const sealed = Boolean(row.id && pkg)
              const files = sealed && pkg?.files ? pkg.files : []
              const open = sealed && archiveOpen === row.version
              // 包里那份（v0.9.129）：档案记的清单和包内目录对不上时的那句话；对得上时是空串
              const manifestNote = open && contents.version === row.version ? packageManifestNote(contents.result?.manifest) : ''
              // 体检说坏的那几条，在清单里也标出来：不用回头对名字
              const auditResult = open && audit.version === row.version ? audit.result : null
              const badEntries = new Set(auditResult && auditResult.state === 'ok' ? auditResult.failed.map((item) => item.name) : [])
              // 上次巡检对这一版的结论：有就写一行，没有就不出现
              const rowAudit = sealed && row.id ? audits.byId[row.id] || null : null
              // 又贴过一次时和上一次比变了哪一项（v0.9.141）：只贴过一次时为 null，不占地方
              const receiptChange = row.receipt ? receiptChangeOf(row.receipts) : null
              // 对不上之后做什么（v0.9.142）：从逐项推出来的那句判断与下一步；对得上时为 null
              const advice = row.receipt ? receiptAdvice(row.receipt) : null
              // 要发给收包人的那段话（v0.9.143）：对得上时为空，不再多一个按钮
              const outreach = row.receipt ? receiptOutreach(row.receipt) : ''
              // 这条链接又发过几次（v0.9.146）：与打开情况合成一行灰字，不并成两行
              const resend = deliveryResendBrief(row.resends)
              // 换过几条地址（v0.9.147）：换过之后重发次数清零，两个数一起才说得清试过几条链接
              const relink = deliveryRelinkBrief(row.relinks)
              const openLine = deliveryArchiveLine(row.visits, resend, relink)
              return (
                <li
                  className={
                    'vq-archive-row' +
                    (landing && !landing.missing && landing.version === row.version ? ' is-landed' : '')
                  }
                  id={'vq-archive-row-v' + row.version}
                  key={sealed ? row.id : 'v' + row.version}
                >
                  <span className="vq-version-n vq-mono">v{row.version}</span>
                  <div className="vq-archive-main">
                    <strong title={sealed ? pkg?.fileName : '这一版交出去时还没封存包'}>
                      {sealed ? pkg?.fileName : '这一版没封存包'}
                    </strong>
                    <span className="vq-mono vq-archive-meta">
                      <span>{row.at ? '交付于 ' + stamp(row.at) : '交付时间没记录'}</span>
                      <span>交时评审 {deliveryReviewText(row.review)}</span>
                      {sealed && pkg ? (
                        <span>
                          {pkg.fileCount ? pkg.fileCount + ' 个文件 · ' : ''}
                          {packageBytesLabel(pkg.bytes)}
                        </span>
                      ) : null}
                    </span>
                    {sealed && pkg ? (
                      <button
                        type="button"
                        className="vq-archive-sha vq-mono"
                        onClick={() => void copyPackageSha(pkg.sha256)}
                        title={'复制完整 SHA-256，发给收件人核对：' + pkg.sha256}
                      >
                        SHA-256 {packageShortSha(pkg.sha256)}
                        <Copy size={11} />
                      </button>
                    ) : (
                      <span className="vq-archive-legacy-note">v0.9.125 之前的交付只记了哪一版，没有存包</span>
                    )}
                    {row.receipt ? (
                      <span
                        className={'vq-archive-receiptline is-' + row.receipt.state}
                        title={row.receipt.summary || '收包人贴回来的收据比过之后记在这里'}
                      >
                        {deliveryReceiptLine(row.receipt)}
                      </span>
                    ) : null}
                    {/* 回执链接被打开过没有（v0.9.145）：一句灰字，不占一枚胶囊。
                        「发出后还没被打开」只对发链接时已经开始记的那几条说——老链接不猜。 */}
                    {openLine ? (
                      <span
                        className={'vq-archive-openline' + (deliveryOpenCount(row.visits) ? '' : ' is-unopened')}
                        title={[
                          deliveryOpenHint(row.visits),
                          deliveryResendHint(resend),
                          deliveryRelinkHint(relink),
                        ]
                          .filter(Boolean)
                          .join('。')}
                      >
                        {openLine}
                      </span>
                    ) : null}
                    {sealed && pkg && packageDiskAlert(pkg) ? (
                      <span className="vq-archive-disk-alert" role="status">
                        {packageDiskAlert(pkg)}
                      </span>
                    ) : null}
                    {rowAudit ? (
                      <span
                        className={'vq-archive-auditline' + (rowAudit.ok ? '' : ' is-bad')}
                        title="定时任务每天验一遍；要现在验，展开清单点「体检整包」"
                      >
                        巡检 {stamp(audits.at)} · {packageAuditLine(rowAudit)}
                      </span>
                    ) : null}
                  </div>
                  {sealed && pkg ? (
                    <div className="vq-archive-actions">
                      {pkg.fileCount && files.length ? (
                        <button
                          type="button"
                          className="vq-button vq-button--quiet vq-button--sm"
                          aria-expanded={open}
                          onClick={() => toggleArchive(row.version, row.id || '')}
                          title={open ? '收起包内清单' : '读盘上那份的目录：里面有什么、点开就能看'}
                        >
                          {open ? '收起' : '清单 ' + (pkg.fileCount || files.length)}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={
                          'vq-button vq-button--quiet vq-button--sm' +
                          (verifyOpen === row.version ? ' is-armed' : '')
                        }
                        aria-expanded={verifyOpen === row.version}
                        onClick={() => setVerifyOpen(verifyOpen === row.version ? 0 : row.version)}
                        title="把下载到的包拖进来，本机算 SHA-256，看还是不是这一份"
                      >
                        <FileCheck2 size={12} />
                        核对
                      </button>
                      <button
                        type="button"
                        className={
                          'vq-button vq-button--quiet vq-button--sm' +
                          (receiptOpen === row.version ? ' is-armed' : '')
                        }
                        aria-expanded={receiptOpen === row.version}
                        onClick={() => toggleReceipt(row.version)}
                        title="把收包人发回的收据贴进来，跟这一条封存包对一遍"
                      >
                        <ClipboardCheck size={12} />
                        收据
                      </button>
                      {pkg.disk && !pkg.disk.present ? (
                        <span
                          className="vq-button vq-button--quiet vq-button--sm is-disabled"
                          title="服务器上这份封存包已经不在了，下载不了；档案里的哈希与大小仍然在"
                        >
                          包没了
                        </span>
                      ) : (
                        <a
                          className="vq-button vq-button--quiet vq-button--sm"
                          href={deliveryPackageUrl(project.id, row.id || '')}
                          download
                          title={'下载封存的那一份（' + pkg.bytes.toLocaleString('zh-CN') + ' B，之后改模板也不会变）'}
                        >
                          下载包
                          <Download size={12} />
                        </a>
                      )}
                    </div>
                  ) : null}
                  {sealed && pkg && verifyOpen === row.version ? (
                    <div className="vq-archive-verify">
                      <label
                        className="vq-archive-verify-drop"
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault()
                          const file = event.dataTransfer.files?.[0]
                          if (file) void verifyPackage(row.version, pkg, file)
                        }}
                      >
                        <input
                          type="file"
                          accept=".zip,application/zip,application/x-zip-compressed"
                          aria-label={'选择下载到的 v' + row.version + ' 封存包'}
                          onChange={(event) => {
                            const input = event.currentTarget
                            const file = input.files?.[0]
                            input.value = ''
                            if (file) void verifyPackage(row.version, pkg, file)
                          }}
                        />
                        <Upload size={13} />
                        <span>把下载到的包拖进来，或点这里选文件</span>
                      </label>
                      <p className="vq-archive-verify-hint">
                        只在本机读这个文件、算 SHA-256，不上传也不写出；对上档案里的 {packageShortSha(pkg.sha256)} 与 {packageBytesLabel(pkg.bytes)} 才算这一份。
                      </p>
                      {verify.version === row.version && verify.status === 'reading' ? (
                        <p className="vq-archive-verify-note" role="status">
                          正在算 {verify.fileName} 的 SHA-256…
                        </p>
                      ) : null}
                      {verify.version === row.version && verify.status === 'error' ? (
                        <p className="vq-archive-verify-note is-bad" role="status">
                          {verify.error}
                        </p>
                      ) : null}
                      {verify.version === row.version && verify.status === 'done' && verify.check ? (
                        <div
                          className={'vq-archive-verify-result is-' + (verify.check.ok ? 'ok' : 'bad')}
                          role="status"
                        >
                          <strong>
                            {verify.check.ok ? <Check size={13} /> : <X size={13} />}
                            {verify.check.text}
                          </strong>
                          <span className="vq-mono">
                            {verify.fileName} · {packageBytesLabel(verify.actualBytes)} · SHA-256{' '}
                            {packageShortSha(verify.actualSha)}
                          </span>
                          {!verify.check.ok ? (
                            <div className="vq-archive-verify-diff">
                              <span className="vq-mono">档案记的是 {packageShortSha(pkg.sha256)}</span>
                              <button
                                type="button"
                                className="vq-archive-sha vq-mono"
                                onClick={() => void copyPackageSha(verify.actualSha)}
                                title="复制这个文件的完整 SHA-256，发给对方排查"
                              >
                                复制这个文件的 SHA-256
                                <Copy size={11} />
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {/* 服务器上那一份（v0.9.128）：上一段核「你手里这个文件」，这一段核「盘上封存的那一份」 */}
                      <div className="vq-archive-verify-server">
                        <div className="vq-archive-verify-server-head">
                          <span className="vq-archive-verify-server-title">服务器上封存的那份</span>
                          {pkg.disk ? (
                            <span
                              className={'vq-archive-server-badge' + (pkg.disk.present ? '' : ' is-bad')}
                              title={
                                pkg.disk.present
                                  ? '盘上还有这个文件（这里只看大小，点「查一遍哈希」才重算内容）'
                                  : '档案还在，盘上的文件已经没了'
                              }
                            >
                              {pkg.disk.present ? '盘上 ' + packageBytesLabel(pkg.disk.bytes) : '盘上没了'}
                            </span>
                          ) : null}
                          <button
                            type="button"
                            className="vq-button vq-button--quiet vq-button--sm"
                            onClick={() => void checkServerPackage(row.version, row.id || '')}
                            disabled={serverCheck.busy && serverCheck.version === row.version}
                            title="让服务端读一遍盘上这一份、算 SHA-256 与档案比；只读，不改文件"
                          >
                            <RefreshCw size={12} />
                            {serverCheck.busy && serverCheck.version === row.version ? '正在算…' : '查一遍哈希'}
                          </button>
                        </div>
                        <p className="vq-archive-verify-hint">
                          档案记的是封存那一刻的哈希；盘上的文件被截断或换掉，只有重算一遍才发现。
                        </p>
                        {serverCheck.version === row.version && serverCheck.error ? (
                          <p className="vq-archive-verify-note is-bad" role="status">
                            {serverCheck.error}
                          </p>
                        ) : null}
                        {serverCheck.version === row.version && serverCheck.result ? (
                          <div
                            className={'vq-archive-verify-result is-' + (serverCheck.result.ok ? 'ok' : 'bad')}
                            role="status"
                          >
                            <strong>
                              {serverCheck.result.ok ? <Check size={13} /> : <X size={13} />}
                              {serverPackageText(serverCheck.result)}
                            </strong>
                            <span className="vq-mono">
                              {serverCheck.result.actual
                                ? packageBytesLabel(serverCheck.result.actual.bytes) +
                                  ' · SHA-256 ' +
                                  packageShortSha(serverCheck.result.actual.sha256)
                                : '盘上没有文件'}
                            </span>
                            {!serverCheck.result.ok && serverCheck.result.actual ? (
                              <div className="vq-archive-verify-diff">
                                <span className="vq-mono">档案记的是 {packageShortSha(pkg.sha256)}</span>
                                <button
                                  type="button"
                                  className="vq-archive-sha vq-mono"
                                  onClick={() => void copyPackageSha(serverCheck.result?.actual?.sha256 || '')}
                                  title="复制服务器上这一份的完整 SHA-256"
                                >
                                  复制服务器上这一份的 SHA-256
                                  <Copy size={11} />
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {sealed && pkg && receiptOpen === row.version ? (
                    <div className="vq-archive-receipt">
                      <p className="vq-archive-receipt-hint">
                        收包人把包解开、双击「校验.html」拖进 zip 核对完，会得到一段「带走这份结论」；
                        让他把那段发回来，整段贴在这里。只读里面的版次、包名、字节与整包 SHA-256，跟这一条封存包对一遍；
                        只比对文字，不重新打包、也不碰盘上那份。
                      </p>
                      {/* 他点过「收到了」（v0.9.151）：还没验，但至少不用再猜东西有没有送到——
                          这一句放在回执链接上面：先说「人那边回话了」，再说链接怎么发。 */}
                      {row.ack?.at ? (
                        <p className="vq-archive-receipt-ack">
                          <Check size={12} />
                          {deliveryAckText(row.ack)}
                        </p>
                      ) : null}
                      {/* 这一条是给谁的（v0.9.152）：同时交出去两三份时，先在这一条上写清「给谁」。
                          写的是一个称呼，不进包、不给收包人看；工作台那一行与复制出去的话都跟着它走。 */}
                      <div className="vq-archive-recipient">
                        <label className="vq-archive-recipient-field">
                          <span className="vq-archive-receipt-label">给谁</span>
                          <input
                            className="vq-archive-recipient-input"
                            type="text"
                            spellCheck={false}
                            maxLength={RECIPIENT_LIMIT}
                            aria-label={'v' + row.version + ' 这一条发给谁'}
                            placeholder={recipientPlaceholder()}
                            value={recipientDrafts[row.id || ''] ?? normalizeRecipient(row.recipient)}
                            onChange={(event) => {
                              // 先把值取出来再进更新函数：React 会在处理完之后把 currentTarget 置空，
                              // 在函数式更新里读它会在下一次渲染时抛错，整页跟着白掉（2026-11-15 实测）。
                              const value = event.currentTarget.value
                              setRecipientDrafts((prev) => ({ ...prev, [row.id || '']: value }))
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="vq-button vq-button--quiet vq-button--sm"
                          disabled={
                            recipientBusy === (row.id || '') ||
                            normalizeRecipient(recipientDrafts[row.id || ''] ?? row.recipient) ===
                              normalizeRecipient(row.recipient)
                          }
                          onClick={() => void saveRecipient(row.id || '', recipientDrafts[row.id || ''] ?? row.recipient ?? '')}
                        >
                          {recipientBusy === (row.id || '') ? '正在记…' : '记下'}
                        </button>
                        {row.recipient ? (
                          <button
                            type="button"
                            className="vq-button vq-button--ghost vq-button--sm"
                            disabled={recipientBusy === (row.id || '')}
                            onClick={() => void saveRecipient(row.id || '', '')}
                            title="清掉之后这一条回到「没写收件人」，包、收据、链接都不动"
                          >
                            清掉
                          </button>
                        ) : null}
                        <span className="vq-archive-recipient-hint">
                          {/* 没写的时候先说「还没写」，再说这个称呼会出现在哪：空着不等于出错 */}
                          {row.recipient ? '' : recipientEmptyText() + ' · '}
                          {recipientHint()}
                        </span>
                      </div>
                      {/* 他回了什么（v0.9.153）：收据只给一个结论（对得上 / 对不上），
                          他真正说的那句「第 3 张背景色偏了」记在这里——跟着版次与包走，
                          下一版要改哪几张从这里直接看，不用回聊天记录里翻。 */}
                      <div className="vq-archive-reply">
                        <label className="vq-archive-reply-field">
                          <span className="vq-archive-receipt-label">他回了什么</span>
                          <textarea
                            className="vq-archive-reply-input"
                            rows={2}
                            spellCheck={false}
                            maxLength={REPLY_LIMIT}
                            aria-label={'v' + row.version + ' 他回了什么'}
                            placeholder={replyPlaceholder()}
                            value={replyDrafts[row.id || ''] ?? normalizeReply(row.reply?.text)}
                            onChange={(event) => {
                              // 与收件人那一行同一个坑：先取值，再进更新函数（React 之后会置空 currentTarget）
                              const value = event.currentTarget.value
                              setReplyDrafts((prev) => ({ ...prev, [row.id || '']: value }))
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="vq-button vq-button--quiet vq-button--sm"
                          disabled={
                            replyBusy === (row.id || '') ||
                            normalizeReply(replyDrafts[row.id || ''] ?? row.reply?.text) ===
                              normalizeReply(row.reply?.text)
                          }
                          onClick={() => void saveReply(row.id || '', replyDrafts[row.id || ''] ?? row.reply?.text ?? '')}
                        >
                          {replyBusy === (row.id || '') ? '正在记…' : '记下'}
                        </button>
                        {row.reply?.text ? (
                          <button
                            type="button"
                            className="vq-button vq-button--ghost vq-button--sm"
                            disabled={replyBusy === (row.id || '')}
                            onClick={() => void saveReply(row.id || '', '')}
                            title="清掉之后这一条回到「还没记」，包、收据、链接都不动"
                          >
                            清掉
                          </button>
                        ) : null}
                        <span className="vq-archive-reply-hint">
                          {/* 记着的时候先说「哪天记的」，没记的时候说「还没记」——两种都不是结论 */}
                          {row.reply?.text ? replySavedAt(row.reply) + ' · ' : replyEmptyText() + ' · '}
                          {replyHint()}
                        </span>
                      </div>
                      <div className="vq-archive-receipt-link">
                        <div className="vq-archive-receipt-linkhead">
                          <span className="vq-archive-receipt-label">回执链接</span>
                          <span className="vq-archive-receipt-linkhint">
                            发给他，他自己贴；贴完这一条自己就变成结论，不用再把文字转回来
                          </span>
                        </div>
                        {row.receiptToken ? (
                          <>
                            <div className="vq-archive-receipt-linkrow">
                              <code className="vq-archive-receipt-url vq-mono">{receiptLinkUrl(row.receiptToken)}</code>
                              <div className="vq-archive-receipt-linkacts">
                                <button
                                  type="button"
                                  className="vq-button vq-button--quiet vq-button--sm"
                                  onClick={() => void copyReceiptLink(row.receiptToken || '')}
                                  title="复制这条地址，发给收包人；他不用注册"
                                >
                                  <Copy size={11} />
                                  复制
                                </button>
                                {/* 换到头了（v0.9.150）：换过两次就不再给换——换的是地址，不是渠道。
                                    工作台那一条路也拦着（409 LINK_ROTATE_LIMIT），两条路说法一致。 */}
                                {(row.relinks || []).length >= RELINK_LIMIT ? (
                                  <span className="vq-archive-receipt-linkhint">
                                    已经换过 {(row.relinks || []).length} 次地址都没被打开：不再换地址了，先问他一句，或者换个收件人
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className="vq-button vq-button--quiet vq-button--sm"
                                    disabled={receiptLinkBusy !== ''}
                                    onClick={() => void ensureReceiptLink(row.id || '', true)}
                                    title="换一枚 token：已经发出去的旧地址立刻失效"
                                  >
                                    {receiptLinkBusy === 'rotate' ? '正在换…' : '换一条'}
                                  </button>
                                )}
                              </div>
                            </div>
                            <p className="vq-archive-receipt-linknote">
                              这一条地址只认这一份包：打开它看不到作品的其他内容，也改不到包里的任何东西。
                            </p>
                          </>
                        ) : (
                          <div className="vq-archive-receipt-linkrow is-empty">
                            <span className="vq-archive-receipt-url is-empty">
                              这一条是升级前封存的，还没有回执链接
                            </span>
                            <div className="vq-archive-receipt-linkacts">
                              <button
                                type="button"
                                className="vq-button vq-button--sm"
                                disabled={receiptLinkBusy !== ''}
                                onClick={() => void ensureReceiptLink(row.id || '', false)}
                              >
                                {receiptLinkBusy === 'issue' ? '正在生成…' : '生成回执链接'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {/* 不再等这一份的回执（v0.9.158）：这一份是「还在等」还是「不等了」，由发件人自己定。
                          收口之后工作台不再把它算进「还没回来」，也不给催收动作；
                          档案、封存包与回执链接都照留，他之后贴回来的收据照样记。点错了再点一次就能继续等。 */}
                      <div className={'vq-archive-wait' + (row.waitClosedAt ? ' is-closed' : '')}>
                        <span className="vq-archive-receipt-label">等不等回执</span>
                        <p className="vq-archive-wait-text">
                          {row.waitClosedAt
                            ? row.receipt && deliveryWaitReturned(String(row.receipt.at || ''), row.waitClosedAt)
                              ? // 收口之后又回来了（v0.9.160）：两件事都发生过，档案里两件都记着
                                stamp(row.waitClosedAt) +
                                ' 你收口了这一份；' +
                                (row.receipt.at ? stamp(row.receipt.at) + ' 他把收据贴了回来' : '他后来把收据贴了回来') +
                                '：收口之后又回来了。这一条按回执说话，收口那件事仍记在档案里——不因此推断他为什么回来，也不重算催过的账。'
                              : stamp(row.waitClosedAt) +
                                ' 你收口了这一份：不再等它的回执。工作台不再把它算进「还没回来」，也不给催收动作；档案、封存包与回执链接都照留，他之后贴回来的收据照样记。'
                            : '客户口头说过、当面看过、或者这版本来就作废了——这些都可以收口。收口只记「你不再等了」，不说他没验；档案、封存包与回执链接都照留。'}
                        </p>
                        <button
                          type="button"
                          className="vq-button vq-button--quiet vq-button--sm vq-archive-wait-toggle"
                          disabled={waitBusy === (row.id || '') || Boolean(row.receipt)}
                          onClick={() => void toggleWaitClosed(row.id || '', !row.waitClosedAt)}
                          title={
                            // 与工作台行尾那一枚同一句话（v0.9.159）：两处都在问「还等不等」
                            row.receipt
                              ? row.waitClosedAt && deliveryWaitReturned(String(row.receipt.at || ''), row.waitClosedAt)
                                ? '这一份已经有回执了，而且是在你收口之后才回来的：等的事已经结束，不用再改；档案里两件事都记着'
                                : '这一份已经有回执了：等的事已经结束，不用再收口'
                              : deliveryWaitToggleHint(Boolean(row.waitClosedAt))
                          }
                        >
                          {waitBusy === (row.id || '')
                            ? '正在记…'
                            : deliveryWaitToggleLabel(Boolean(row.waitClosedAt))}
                        </button>
                      </div>
                      <label className="vq-archive-receipt-field">
                        <span className="vq-archive-receipt-label">收据</span>
                        <textarea
                          className="vq-archive-receipt-input"
                          rows={5}
                          spellCheck={false}
                          aria-label={'收包人发回的 v' + row.version + ' 收据'}
                          value={receiptOpen === row.version ? receiptDraft : ''}
                          onChange={(event) => setReceiptDraft(event.currentTarget.value)}
                          placeholder={
                            'VisionQA 交付包核对 · ' + project.title + ' v' + row.version + '\n' +
                            '包：' + pkg.fileName + '\n' +
                            '结论：都对得上 · …\n' +
                            '整包：' + pkg.bytes.toLocaleString('zh-CN') + ' B · SHA-256 …\n' +
                            '时间：…'
                          }
                        />
                      </label>
                      <div className="vq-archive-receipt-actions">
                        <button
                          type="button"
                          className="vq-button vq-button--sm"
                          disabled={receiptBusy || !receiptDraft.trim()}
                          onClick={() => void submitReceipt(row.version, row.id || '')}
                        >
                          {receiptBusy ? '正在对…' : '对一遍'}
                        </button>
                        <button
                          type="button"
                          className="vq-button vq-button--quiet vq-button--sm"
                          disabled={receiptBusy || !receiptDraft}
                          onClick={() => {
                            setReceiptDraft('')
                            setReceiptError('')
                          }}
                        >
                          清空
                        </button>
                        <span className="vq-archive-receipt-hint is-inline">
                          收据对得上才算「他验的就是我封存的那一份」；对不上时下面会写清哪一项不一样。
                        </span>
                      </div>
                      {receiptError ? (
                        <p className="vq-archive-receipt-note is-bad" role="status">
                          {receiptError}
                        </p>
                      ) : null}
                      {row.receipt ? (
                        <div className={'vq-archive-receipt-result is-' + row.receipt.state} role="status">
                          <strong>
                            {row.receipt.state === 'match' ? <Check size={13} /> : <X size={13} />}
                            {row.receipt.summary || deliveryReceiptLine(row.receipt)}
                          </strong>
                          <span className="vq-mono">
                            {row.receipt.claimed?.at ? '收据上的时间 ' + row.receipt.claimed.at : '收据上没写时间'}
                            {row.receipt.claimed?.kind ? ' · ' + row.receipt.claimed.kind + '核对' : ''}
                            {' · 核对于 ' + stamp(row.receipt.at)}
                          </span>
                          <span className="vq-archive-receipt-via">{receiptViaText(row.receipt.via)}</span>
                          {receiptChange ? (
                            <p className={'vq-archive-receipt-change is-' + receiptChange.tone} role="status">
                              {receiptChange.text}
                            </p>
                          ) : null}
                          {row.receipt.checks?.length ? (
                            <ul className="vq-archive-receipt-checks">
                              {row.receipt.checks.map((check) => (
                                <li key={check.k} className={check.ok ? 'is-ok' : 'is-bad'}>
                                  <span className="vq-archive-receipt-k">{receiptCheckLabel(check.k)}</span>
                                  {check.ok ? (
                                    <span className="vq-archive-receipt-got vq-mono">{check.want}</span>
                                  ) : (
                                    <span className="vq-archive-receipt-pair">
                                      <span className="vq-archive-receipt-got vq-mono">
                                        <span className="vq-archive-receipt-tag">收据</span>
                                        {check.got || '没写'}
                                      </span>
                                      <span className="vq-archive-receipt-want vq-mono">
                                        <span className="vq-archive-receipt-tag">这一条</span>
                                        {check.want || '没记'}
                                      </span>
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {row.receipt.problems?.filter((line) => stripStop(line) !== stripStop(row.receipt?.summary)).length ? (
                            <ul className="vq-archive-receipt-problems">
                              {row.receipt.problems
                                .filter((line) => stripStop(line) !== stripStop(row.receipt?.summary))
                                .map((line) => (
                                  <li key={line}>{line}</li>
                                ))}
                            </ul>
                          ) : null}
                          {advice ? (
                            <div className={'vq-archive-receipt-advice is-' + advice.tone} role="note">
                              <strong>{advice.title}</strong>
                              <span>{advice.text}</span>
                              {outreach ? (
                                <button
                                  type="button"
                                  className="vq-button vq-button--quiet vq-button--sm vq-archive-receipt-advice-copy"
                                  onClick={() => void copyReceiptOutreach(outreach)}
                                >
                                  复制这段话
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                          {row.receipts && row.receipts.length > 1 ? (
                            <div className="vq-archive-receipt-log">
                              <span className="vq-archive-receipt-loghead">
                                这一条前前后后贴过 {row.receipts.length} 次，更早的记在这里
                              </span>
                              <ol className="vq-archive-receipt-loglist">
                                {row.receipts
                                  .slice(0, -1)
                                  .reverse()
                                  .map((earlier) => (
                                    <li key={earlier.at} className={'is-' + earlier.state}>
                                      <span className="vq-archive-receipt-logstate">
                                        {receiptStateText(earlier.state)}
                                      </span>
                                      <span className="vq-archive-receipt-logmeta vq-mono">
                                        {stamp(earlier.at)}
                                        {' · '}
                                        {earlier.via === 'link' ? '他自己贴的' : '你贴的'}
                                      </span>
                                      <span className="vq-archive-receipt-logsum">
                                        {earlier.summary || deliveryReceiptLine(earlier)}
                                      </span>
                                    </li>
                                  ))}
                              </ol>
                              <p className="vq-archive-receipt-linknote">
                                上面那次是最后一次；流水只留最近 5 次，包里的字节与哈希一次都没被它改过。
                              </p>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {open && pkg ? (
                    <div className="vq-archive-contents">
                      {contents.version === row.version && contents.busy ? (
                        <p className="vq-archive-contents-note">正在读盘上那份的目录…</p>
                      ) : null}
                      {contents.version === row.version && contents.error ? (
                        <>
                          <p className="vq-archive-contents-note is-bad">{contents.error}</p>
                          <p className="vq-archive-contents-note">盘上那份读不到，下面是档案里记的清单；点不开预览，下载下来看。</p>
                          <ul className="vq-archive-files">
                            {files.map((file) => (
                              <li key={file.name}>
                                <span title={file.name}>{file.name}</span>
                                <span className="vq-mono">{packageBytesLabel(file.bytes)}</span>
                              </li>
                            ))}
                          </ul>
                          {pkg.fileCount && pkg.fileCount > files.length ? (
                            <p className="vq-archive-more vq-mono">
                              还有 {pkg.fileCount - files.length} 个文件没列，包里都在
                            </p>
                          ) : null}
                        </>
                      ) : null}
                      {contents.version === row.version && contents.result && !contents.result.ok ? (
                        <>
                          <p className="vq-archive-contents-note is-bad">{contents.result.error || '包里的目录读不出来'}</p>
                          <p className="vq-archive-contents-note">下面是档案里记的清单；点不开预览，下载下来看。</p>
                          <ul className="vq-archive-files">
                            {files.map((file) => (
                              <li key={file.name}>
                                <span title={file.name}>{file.name}</span>
                                <span className="vq-mono">{packageBytesLabel(file.bytes)}</span>
                              </li>
                            ))}
                          </ul>
                          {pkg.fileCount && pkg.fileCount > files.length ? (
                            <p className="vq-archive-more vq-mono">
                              还有 {pkg.fileCount - files.length} 个文件没列，包里都在
                            </p>
                          ) : null}
                        </>
                      ) : null}
                      {contents.version === row.version && contents.result?.ok && contents.result.entries ? (
                        <>
                          <div className="vq-archive-contents-head">
                            <p className="vq-archive-contents-note">
                              目录是从盘上那份按偏移读的：{contents.result.entries.length} 个文件
                              {contents.result.readBytes ? '，只读了 ' + packageBytesLabel(contents.result.readBytes) : ''}
                              {contents.result.bytes ? '（包 ' + packageBytesLabel(contents.result.bytes) + '）' : ''}
                              {contents.result.manifest ? '，档案记了 ' + contents.result.manifest.recorded + ' 个' : ''}
                              {contents.result.entries.length ? '；点一条就在这儿看，不用整包解压。' : '。'}
                            </p>
                            {contents.result.entries.length ? (
                              <button
                                type="button"
                                className="vq-button vq-button--quiet vq-button--sm"
                                disabled={audit.version === row.version && audit.state === 'busy'}
                                onClick={() => void auditPackage(row.version, row.id || '')}
                                title="把包里每一条都解开、重算一遍 CRC32；只读，不改文件"
                              >
                                {audit.version === row.version && audit.state === 'busy'
                                  ? '正在体检…'
                                  : auditResult
                                    ? '再体检一遍'
                                    : '体检整包'}
                              </button>
                            ) : null}
                          </div>
                          {manifestNote ? <p className="vq-archive-contents-note is-bad">{manifestNote}</p> : null}
                          {audit.version === row.version && audit.state === 'error' ? (
                            <p className="vq-archive-audit-note is-bad">{audit.error}</p>
                          ) : null}
                          {auditResult ? (
                            <div
                              className={
                                'vq-archive-audit' +
                                (auditResult.state === 'unreadable' ? ' is-bad' : auditResult.ok ? ' is-ok' : ' is-warn')
                              }
                              role="status"
                            >
                              <div className="vq-archive-audit-head">
                                <strong>
                                  {auditResult.state === 'unreadable'
                                    ? '整包体检做不了'
                                    : auditResult.ok
                                      ? '整包体检通过'
                                      : '整包体检发现问题'}
                                </strong>
                                {auditResult.state === 'ok' ? (
                                  <span className="vq-archive-audit-meta">
                                    <span className="vq-mono">
                                      读了 {packageBytesLabel(auditResult.readBytes)} / 包 {packageBytesLabel(auditResult.bytes)}
                                    </span>
                                    <span> · 用了 {auditResult.ms} ms</span>
                                  </span>
                                ) : null}
                              </div>
                              <p className="vq-archive-audit-text">{packageAuditText(auditResult)}</p>
                              {auditResult.failed.length ? (
                                <ul className="vq-archive-audit-failed">
                                  {auditResult.failed.map((item) => (
                                    <li key={item.name}>
                                      <span title={item.name}>{item.name}</span>
                                      <span>{packageAuditFaultLabel(item.reason)}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                              <p className="vq-archive-audit-hint">
                                体检只说明包在盘上没坏；内容对不对，得看评审和现场页。
                              </p>
                            </div>
                          ) : null}
                          {contents.result.entries.length ? (
                            <ul className="vq-archive-entries">
                              {contents.result.entries.map((entry) => (
                                <li key={entry.name}>
                                  <button
                                    type="button"
                                    className={
                                      'vq-archive-entry' +
                                      (preview.version === row.version && preview.name === entry.name ? ' is-open' : '') +
                                      (badEntries.has(entry.name) ? ' is-bad' : '')
                                    }
                                    aria-expanded={preview.version === row.version && preview.name === entry.name}
                                    onClick={() => void openPackageEntry(row.version, row.id || '', entry)}
                                    title={
                                      badEntries.has(entry.name)
                                        ? '体检说这一条坏了，打开也不该拿来当内容'
                                        : entry.kind === 'other'
                                          ? '这种文件不能在这里看，下载包来解压'
                                          : '点开看包里这一份'
                                    }
                                  >
                                    <span>{entry.name}</span>
                                    <span className="vq-mono">{packageBytesLabel(entry.bytes)}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {preview.version === row.version && preview.status !== 'idle' ? (
                            <div className="vq-archive-preview">
                              <div className="vq-archive-preview-head">
                                <strong>{preview.name}</strong>
                                <div className="vq-archive-preview-actions">
                                  {preview.kind === 'html' ? (
                                    <a
                                      className="vq-button vq-button--quiet vq-button--sm"
                                      href={deliveryPackageEntryUrl(project.id, preview.deliveryId, preview.name)}
                                      target="_blank"
                                      rel="noreferrer"
                                      title="在新标签里按原样打开这份页面（还是包里那一份）"
                                    >
                                      原样打开
                                      <ExternalLink size={12} />
                                    </a>
                                  ) : null}
                                  <button type="button" className="vq-button vq-button--quiet vq-button--sm" onClick={closePreview}>
                                    收起预览
                                  </button>
                                </div>
                              </div>
                              {preview.status === 'loading' ? <p className="vq-archive-preview-note">正在读…</p> : null}
                              {preview.status === 'error' ? (
                                <p className="vq-archive-preview-note is-bad">{preview.error}</p>
                              ) : null}
                              {preview.status === 'ready' && preview.kind === 'image' ? (
                                <img
                                  src={deliveryPackageEntryUrl(project.id, preview.deliveryId, preview.name)}
                                  alt={preview.name}
                                  onError={() =>
                                    setPreview((current) => ({
                                      ...current,
                                      status: 'error',
                                      error: '这一张读不出来：包里这一块可能是坏的',
                                    }))
                                  }
                                />
                              ) : null}
                              {preview.status === 'ready' && preview.kind === 'html' ? (
                                // allow-same-origin 只为了让页面里的相对帧图按同源取、CSP 的 'self' 生效；
                                // 没有 allow-scripts，页面里的脚本仍然跑不起来
                                <iframe
                                  title={preview.name}
                                  sandbox="allow-same-origin"
                                  loading="lazy"
                                  src={deliveryPackageEntryUrl(project.id, preview.deliveryId, preview.name)}
                                />
                              ) : null}
                              {preview.status === 'ready' && preview.kind === 'text' ? (
                                <>
                                  <pre>{preview.text}</pre>
                                  {preview.note ? <p className="vq-archive-preview-note">{preview.note}</p> : null}
                                </>
                              ) : null}
                              {preview.status === 'ready' && preview.kind === 'other' ? (
                                <p className="vq-archive-preview-note">这种文件不能在这里看，下载包来解压。</p>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {project.version ? (
        <section className="vq-project-runs" aria-labelledby="vq-project-runs-head">
          <div className="vq-project-runs-head">
            <h2 id="vq-project-runs-head">
              运行记录
              <span className="vq-mono">{data.runTotal} 次</span>
            </h2>
            <p className="vq-project-runs-note">
              一个作品的运行跨版本归集：旧版工作流跑过的记录还在，开新版不会把它们藏起来。
            </p>
          </div>
          {data.runs.length ? (
            <ol className="vq-run-list">
              {data.runs.map((run) => {
                const ok = run.status === 'success'
                // 中断不是失败：服务重启打断和用户主动停止都走中性色，别用报错红。
                const stopped = run.canceled || run.status === 'interrupted'
                const live = run.status === 'running' || run.status === 'queued'
                const tone = ok ? 'pass' : stopped ? 'stop' : 'fail'
                return (
                  <li className="vq-run-row" key={run.id}>
                    <span className={'vq-run-dot is-' + tone} aria-hidden="true" />
                    <div className="vq-run-main">
                      <span className="vq-run-title">
                        <strong className="vq-mono">{run.id}</strong>
                        <span className="vq-version-n vq-mono vq-run-version">v{run.version}</span>
                        <span className={'vq-run-status is-' + tone}>
                          {ok ? '成功' : run.canceled ? '已停止' : run.status === 'interrupted' ? '已中断' : live ? '运行中' : '失败'}
                        </span>
                      </span>
                      <span className="vq-run-meta">
                        <span>{run.total} 节点{run.failed ? ' · ' + run.failed + ' 个失败' : ''}</span>
                        {(run.queuedMs ?? 0) >= 1000 ? <span>排队 {duration(run.queuedMs ?? 0)}</span> : null}
                        <span>{duration(run.durationMs)}</span>
                        <span>
                          {run.credits && run.credits.cost
                            ? run.credits.kept != null
                              ? '已跑 ' + run.credits.kept + ' 积分 · 已退 ' + (run.credits.refundedAmount ?? 0)
                              : run.credits.cost + ' 积分' + (run.credits.refunded ? '（已退）' : '')
                            : '不计费'}
                        </span>
                        <span className="vq-mono">{stamp(run.startedAt)}</span>
                      </span>
                      {run.error ? <p className={'vq-run-error' + (run.canceled ? ' is-stopped' : '')}>{run.error}</p> : null}
                    </div>
                    <div className="vq-run-actions">
                      {!live && (run.available || run.hasSnapshot) ? (
                        <button
                          type="button"
                          className="vq-button vq-button--ghost vq-button--sm vq-run-view"
                          onClick={() => onViewRun(run.flowId, run.id)}
                          title={
                            run.available
                              ? '在工作流上只读回看这次运行：有工作流快照时连当时的位置与参数一起回放；不改工作流、不扣积分'
                              : '这条工作流已经删除，但这次运行留下了工作流快照：仍可只读回看当时的位置与参数；不改任何内容、不扣积分'
                          }
                        >
                          <ScanEye size={13} />
                          查看运行
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="vq-button vq-button--ghost vq-button--sm vq-run-open"
                        onClick={() => onOpenFlow(run.flowId)}
                        disabled={!run.available}
                        title={run.available ? '打开 v' + run.version + ' 的工作流' : '这次运行的工作流已被删除，记录仍留着'}
                      >
                        {run.available ? '打开工作流' : '工作流已删除'}
                        {run.available ? <ArrowRight size={13} /> : null}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ol>
          ) : (
            <div className="vq-project-empty">
              <strong>这条作品还没跑过工作流</strong>
              <span>打开工作流点一次运行：每个节点的耗时、输出与失败原因都会记在这里，并按版本归集。</span>
              <button type="button" className="vq-button vq-button--ghost" onClick={() => void openCanvas()}>
                <Clapperboard size={13} />
                打开工作流去运行
              </button>
            </div>
          )}
        </section>
      ) : null}

      <div className="vq-project-body">
        <div className="vq-project-col">
          <section className="vq-project-panel">
            <div className="vq-project-panel-head">
              <h2>脚本</h2>
              <div className="vq-script-head">
                <span className="vq-mono">
                  {script ? script.structure.length + ' 段' : '没有脚本'}
                  {script ? (script.source === 'project' ? ' · 这条作品的版本' : ' · 来自模板') : ''}
                  {data.templateSaves?.length ? ' · 沉淀过 ' + data.templateSaves.length + ' 条模板' : ''}
                </span>
                {scriptEditing ? (
                  // 8 段的脚本表单比一屏长：保存/取消在页头也留一份，改完一段不用滚到底
                  <>
                    <button type="button" className="vq-script-link" onClick={cancelScript} disabled={busy === 'script'}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="vq-button vq-button--primary vq-script-save-top"
                      onClick={() => void saveScript()}
                      disabled={busy === 'script'}
                    >
                      {busy === 'script' ? '保存中…' : '保存脚本'}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="vq-script-link" onClick={beginScript}>
                      <Pencil size={12} />
                      {script ? '改脚本' : '写一条脚本'}
                    </button>
                    <button
                      type="button"
                      className="vq-script-link"
                      onClick={() => onOpenAgents(data.project.id)}
                      title="带着这条作品这一版的要求去对话预设页；草稿写完点「写进作品」就换成本版的脚本（模板不动）"
                    >
                      <Bot size={12} />
                      让 AI 起草
                    </button>
                    <button
                      type="button"
                      className="vq-script-link"
                      onClick={openTemplateSheet}
                      title="把这一版的脚本沉淀成模板库里的模板：脚本用这条作品的，分镜沿用绑定模板的取景；作品与模板都不动"
                    >
                      <BookmarkPlus size={12} />
                      存成模板
                    </button>
                    {script?.source === 'project' ? (
                      <button type="button" className="vq-script-link" onClick={() => void restoreScript()} disabled={busy === 'script'}>
                        <RotateCcw size={12} />
                        恢复模板脚本
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </div>
            {tplSheet.open ? (
              tplSheet.done ? (
                <div className="vq-tpl-sheet" role="region" aria-label="已存成模板">
                  <p className="vq-tpl-sheet-line">
                    <Check size={14} className="vq-tpl-check" />
                    <strong>已存成模板《{tplSheet.done.title}》</strong>
                    <span className="vq-mono">
                      {tplSheet.done.beats} 段 · {tplSheet.done.shots} 镜 ·{' '}
                      {tplSheet.done.projectVersion ? '第 ' + tplSheet.done.projectVersion + ' 版' : '还没开工作流'}
                    </span>
                  </p>
                  <p className="vq-tpl-sheet-note">
                    它在模板库里可以再改编、再套用；这条作品与它绑定的模板一个字没动，也不会多开一个版本。
                  </p>
                  <div className="vq-tpl-sheet-actions">
                    <button type="button" className="vq-button vq-button--ghost" onClick={closeTemplateSheet}>
                      知道了
                    </button>
                    <button type="button" className="vq-button vq-button--ghost" onClick={onBrowseTemplates}>
                      去模板库
                      <ArrowRight size={13} />
                    </button>
                  </div>
                </div>
              ) : (
                <form
                  className="vq-tpl-sheet"
                  aria-label="存成模板"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitTemplate()
                  }}
                >
                  <div className="vq-tpl-sheet-head">
                    <strong>把这一版存成模板</strong>
                    <button type="button" className="vq-button vq-button--icon" onClick={closeTemplateSheet} aria-label="收起">
                      <X size={14} />
                    </button>
                  </div>
                  <label className="vq-tpl-field">
                    <span>模板标题</span>
                    <input
                      className="vq-script-input"
                      value={tplSheet.title}
                      maxLength={120}
                      placeholder="下一条作品从这条模板开始"
                      onChange={(event) => setTplSheet((current) => ({ ...current, title: event.target.value }))}
                    />
                  </label>
                  <p className="vq-tpl-sheet-line">
                    存的是这一版的脚本 <strong>{script ? script.structure.length : 0} 段</strong>
                    {script ? '（' + (script.source === 'project' ? '这条作品的版本' : '来自模板') + '）' : ''}
                    {template ? '，分镜 ' : ''}
                    {template ? <strong>{template.shots} 镜</strong> : null}
                    {template ? '沿用《' + template.title + '》的取景文字（原片帧图与互动数据不复制）' : ''}
                  </p>
                  {!template ? (
                    <p className="vq-tpl-sheet-note is-warn">
                      这条作品没有分镜（它不是从模板起的），存不成模板：模板要能被再改编，分镜得有着落。从工作流起的作品，用工作流里的「另存为模板」。
                    </p>
                  ) : script?.source === 'project' ? null : (
                    <p className="vq-tpl-sheet-note is-warn">
                      这一版的脚本还是模板那份，没改过：存出来会是一条和《{template.title}》几乎一样的模板。要沉淀新东西，先改一版脚本。
                    </p>
                  )}
                  {tplSheet.error ? <p className="vq-tpl-sheet-note is-danger">{tplSheet.error}</p> : null}
                  <div className="vq-tpl-sheet-actions">
                    <button type="button" className="vq-button vq-button--ghost" onClick={closeTemplateSheet}>
                      取消
                    </button>
                    <button
                      type="submit"
                      className="vq-button vq-button--primary"
                      disabled={tplSheet.busy || !template || !script?.structure.length}
                      title={!template ? '这条作品没有分镜，存不成模板' : '存进模板库；作品与它绑定的模板都不动'}
                    >
                      {tplSheet.busy ? '保存中…' : '存成模板'}
                    </button>
                  </div>
                </form>
              )
            ) : null}
            {scriptEditing && scriptDraft ? (
              <form
                className="vq-script-edit"
                onSubmit={(event) => {
                  event.preventDefault()
                  void saveScript()
                }}
              >
                <label className="vq-script-field">
                  <span>开头钩子</span>
                  <textarea
                    className="vq-script-input"
                    rows={2}
                    value={scriptDraft.hook}
                    maxLength={400}
                    placeholder="第一句怎么把人留下（可空）"
                    onChange={(event) => setScriptDraft({ ...scriptDraft, hook: event.target.value })}
                  />
                </label>
                <ol className="vq-beat-list">
                  {scriptDraft.structure.map((beat, index) => (
                    <li className="vq-beat-row vq-beat-row--edit" key={index}>
                      <span className="vq-mono vq-beat-index">{pad2(index + 1)}</span>
                      <div className="vq-beat-copy">
                        <input
                          className="vq-script-input vq-script-input--beat"
                          value={beat.beat}
                          maxLength={60}
                          placeholder={'第 ' + (index + 1) + ' 段的名字'}
                          aria-label={'第 ' + (index + 1) + ' 段的段落名'}
                          onChange={(event) => patchScriptBeat(index, { beat: event.target.value })}
                        />
                        <textarea
                          className="vq-script-input"
                          rows={2}
                          value={beat.voiceover}
                          maxLength={600}
                          placeholder="这一段要念的口播"
                          aria-label={'第 ' + (index + 1) + ' 段的口播'}
                          onChange={(event) => patchScriptBeat(index, { voiceover: event.target.value })}
                        />
                        <input
                          className="vq-script-input"
                          value={beat.onScreen}
                          maxLength={200}
                          placeholder="屏幕字（可空）"
                          aria-label={'第 ' + (index + 1) + ' 段的屏幕字'}
                          onChange={(event) => patchScriptBeat(index, { onScreen: event.target.value })}
                        />
                        <div className="vq-script-beat-foot">
                          <span className="vq-mono">
                            {beat.startSec || beat.endSec ? (beat.startSec || 0) + '–' + (beat.endSec || 0) + ' 秒 · ' : ''}
                            时长保存后按口播重算
                          </span>
                          <button
                            type="button"
                            className="vq-script-link is-danger"
                            onClick={() => removeScriptBeat(index)}
                            disabled={scriptDraft.structure.length <= 1}
                          >
                            删掉这段
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
                <div className="vq-script-edit-foot">
                  <button type="button" className="vq-button vq-button--ghost" onClick={addScriptBeat} disabled={scriptDraft.structure.length >= 12}>
                    <Plus size={13} />
                    加一段
                  </button>
                  <span className="vq-script-note">
                    保存后按口播重估「要念几秒」；工作流里自动生成的复刻提示词会一起换成新脚本，模板不动。
                  </span>
                  <button type="button" className="vq-button vq-button--ghost" onClick={cancelScript}>
                    取消
                  </button>
                  <button type="submit" className="vq-button vq-button--primary" disabled={busy === 'script'}>
                    {busy === 'script' ? '保存中…' : '保存脚本'}
                  </button>
                </div>
              </form>
            ) : script && script.structure.length ? (
              <>
                {script.hook ? <p className="vq-project-hook">开头钩子 · {script.hook}</p> : null}
                <ol className="vq-beat-list">
                  {script.structure.map((beat, index) => (
                    <li key={index} className="vq-beat-row">
                      <span className="vq-mono vq-beat-index">{pad2(index + 1)}</span>
                      <div className="vq-beat-copy">
                        <span className="vq-beat-name">
                          {beat.beat}
                          <span className="vq-mono">
                            {beat.startSec || beat.endSec ? (beat.startSec || 0) + '–' + (beat.endSec || 0) + ' 秒' : '时间待定'}
                            {beat.expectedSec ? ' · 要念 ' + beat.expectedSec + ' 秒' : ''}
                          </span>
                        </span>
                        <p>{beat.voiceover || '（这段没有口播）'}</p>
                        {beat.onScreen ? <span className="vq-beat-onscreen">屏幕字 · {beat.onScreen}</span> : null}
                      </div>
                    </li>
                  ))}
                </ol>
                {script.timing && script.timing.estimatedSec ? (
                  <p className="vq-project-timing">
                    口播约需 {script.timing.estimatedSec} 秒 · {describeTiming(script.timing).replace('镜头', '段')}
                  </p>
                ) : null}
                <p className="vq-project-note">
                  {script.source === 'project'
                    ? '这是这条作品自己的脚本：模板再改也不影响它。'
                    : '脚本跟着模板走；点「改脚本」会存成这条作品自己的版本，模板不动。'}
                </p>
              </>
            ) : (
              <div className="vq-project-empty">
                <strong>这条作品还没有脚本</strong>
                <span>
                  {template
                    ? '这条模板还没解析出脚本段落；也可以直接写一条这条作品自己的话。'
                    : '绑定的模板已删除或不在当前账号下；脚本可以直接在这里写，开工作流时用它生成复刻提示词。'}
                </span>
                <div className="vq-project-empty-actions">
                  <button type="button" className="vq-button vq-button--ghost" onClick={beginScript}>
                    <Pencil size={13} />
                    写一条脚本
                  </button>
                  {template ? null : (
                    <button type="button" className="vq-button vq-button--ghost" onClick={onBrowseTemplates}>
                      去模板库
                      <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="vq-project-panel">
            <div className="vq-project-panel-head">
              <h2>分镜</h2>
              <div className="vq-shot-head-tools">
                <span className="vq-mono">{template ? template.shots + ' 镜 · 跟模板' : '没有分镜'}</span>
                {template && template.storyboard.length ? (
                  <button
                    type="button"
                    className="vq-shot-allcopy"
                    title={'把这一版 ' + template.storyboard.length + ' 镜的提示词按顺序一次复制走：想贴到别处出图可以拿走；要现成画面就点每一镜的「出这一镜」'}
                    onClick={() => void copyShotText(0, true)}
                  >
                    <Copy size={12} />
                    复制全部提示词
                  </button>
                ) : null}
              </div>
            </div>
            {/* 写进作品（v0.9.30）只写脚本：这一版的脚本是自己的、分镜仍是模板那几镜时要说清楚，
                不让人以为「换了脚本」连镜头也换了 */}
            {template && template.storyboard.length && script?.source === 'project' ? (
              <p className="vq-project-note">
                脚本是这条作品自己的（{script.structure.length} 段），分镜仍是模板那 {template.shots} 镜；
                分镜要换，就在模板里改编这一版。
              </p>
            ) : null}
            {template && template.storyboard.length ? (
              <ol className="vq-shot-list">
                {template.storyboard.map((shot, index) => {
                  const shotNo = Math.max(1, Math.round(Number(shot.shotNo) || index + 1))
                  const own = data.project.shots?.[String(shotNo)] || null
                  const source = own ? '/media/' + own.media : shot.frameUrl || ''
                  const busy = shotBusy === shotNo
                  // 逐镜出图（r276）：这一镜此刻在画还是在贴、上次失败说了什么
                  const gen = shotGen[shotNo]
                  const genBusy = gen?.state === 'running' || gen?.state === 'attach'
                  const genInsufficient = Boolean(imageModel?.price && balance !== null && balance < imageModel.price)
                  return (
                    <li key={index} className="vq-shot-row">
                      <span className="vq-mono vq-shot-index">{pad2(shotNo)}</span>
                      <div className={'vq-shot-figure' + (own ? ' is-own' : '')}>
                        {source ? (
                          <img
                            src={source}
                            alt={'第 ' + shotNo + ' 镜的画面'}
                            loading="lazy"
                            onError={(event) => {
                              // 原片帧被清过时图会裂：就地收起这张图，写「没有帧图」，不让人对着破图猜
                              event.currentTarget.parentElement?.classList.add('is-missing')
                            }}
                          />
                        ) : null}
                        <span className="vq-shot-figure-empty">没有帧图</span>
                        <span className="vq-shot-figure-tag">{own ? '你的画面' : '原片帧'}</span>
                      </div>
                      <div className="vq-shot-copy">
                        <span className="vq-shot-head">
                          {shot.camera || '机位待定'}
                          <span className="vq-mono">{(shot.startSec ?? 0) + '–' + (shot.endSec ?? 0) + ' 秒'}</span>
                        </span>
                        <p>{shot.visual || '（画面待补）'}</p>
                        {shot.caption ? <span className="vq-shot-caption">字幕 · {shot.caption}</span> : null}
                      </div>
                      <div className="vq-shot-actions">
                        {/* 逐镜出图（r276）：这一镜的提示词本来就在这一页现拼，出图也收回来。
                            只有点这一下才花钱；价格与余额写在按钮上，不够就按住并写「还差 N 积分」。 */}
                        <button
                          type="button"
                          className="vq-button vq-button--ghost vq-button--sm vq-shot-gen"
                          disabled={genBusy || !imageModel || genInsufficient}
                          title={
                            !imageModel
                              ? (imageModelNote || '出图通道还没就绪')
                              : genInsufficient
                                ? '积分不够：去「充值」页充一档再回来出这一镜'
                                : '用这一镜的提示词在平台里真画一张（' + imageModel.label + '），画完自动贴到这一镜；一次 ' + (imageModel.price ?? 0) + ' 积分'
                          }
                          onClick={() => void generateShotFrame(shotNo)}
                        >
                          <Sparkles size={12} />
                          {gen?.state === 'running' ? gen.label : gen?.state === 'attach' ? '正在贴' : '出这一镜 · ' + shotGenPriceLabel(imageModel?.price, balance)}
                        </button>
                        <label
                          className={'vq-button vq-button--ghost vq-button--sm vq-shot-attach' + (busy ? ' is-busy' : '')}
                          title={
                            own
                              ? '换一张你自己出的画面：只换这一条作品的第 ' + shotNo + ' 镜，模板不动'
                              : '把你出的画面贴到第 ' + shotNo + ' 镜：jpg / png / webp，≤ 8 MB'
                          }
                        >
                          <Upload size={12} />
                          {busy ? '正在贴' : own ? '换一张' : '贴画面'}
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            className="vq-shot-file"
                            disabled={busy}
                            onChange={(event) => {
                              const file = event.target.files?.[0] || null
                              event.target.value = ''
                              void attachShotFrame(shotNo, file)
                            }}
                          />
                        </label>
                        {own ? (
                          <button
                            type="button"
                            className="vq-shot-clear"
                            disabled={busy}
                            title="这一镜不用你的画面了，回到模板抽出来的原片帧"
                            onClick={() => void clearShotFrame(shotNo)}
                          >
                            用回原片
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="vq-shot-prompt-toggle"
                          aria-expanded={promptNo === shotNo}
                          title="看这一镜的出图提示词：由分镜与脚本现拼，点「出这一镜」就是用这一条去画"
                          onClick={() => setPromptNo(promptNo === shotNo ? 0 : shotNo)}
                        >
                          <FileText size={12} />
                          提示词
                        </button>
                      </div>
                      {/* 出图失败那行：钱退没退、要不要充值写在同一句里，不用去别处对账 */}
                      {gen?.state === 'failed' ? (
                        <p className="vq-shot-gen-note" role="status">
                          <AlertCircle size={12} />
                          <span>
                            {gen.message}
                            {gen.note ? ' ' + gen.note : ''}
                            {gen.topUp ? (
                              <>
                                {' '}
                                <a className="vq-link" href="#/recharge" title="去充值页选一档，到账后回来再点一次">去充值</a>
                              </>
                            ) : null}
                          </span>
                        </p>
                      ) : null}
                      {promptNo === shotNo ? (
                        <div className="vq-shot-prompt" role="region" aria-label={'第 ' + shotNo + ' 镜的出图提示词'}>
                          <p className="vq-shot-prompt-text">
                            {shotPrompt(shot, beatForShot(shot, promptBeats), { platform: promptPlatform, scriptSource: promptScriptSource === 'own' ? 'own' : promptScriptSource === 'template' ? 'template' : undefined })}
                          </p>
                          <div className="vq-shot-prompt-foot">
                            <span className="vq-shot-prompt-hint">{shotPromptHint(promptScriptSource)}</span>
                            <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={() => void copyShotText(shotNo)}>
                              <Copy size={12} />
                              复制这一镜
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            ) : (
              <div className="vq-project-empty">
                <strong>还没有分镜</strong>
                <span>分镜跟着模板走：解析一条原片，或在模板里改编出你自己的一版。</span>
              </div>
            )}
          </section>
        </div>

        <aside className="vq-project-side">
          <section className="vq-project-panel">
            <div className="vq-project-panel-head">
              <h2>工作流</h2>
              <Workflow size={14} />
            </div>
            {flow ? (
              <>
                <strong className="vq-project-flow-name">{flow.name}</strong>
                <p className="vq-project-flow-meta vq-mono">
                  {flow.nodes} 个节点 · 更新 {stamp(flow.updatedAt)}
                </p>
                <button type="button" className="vq-button vq-button--primary vq-project-full" onClick={() => void openCanvas()}>
                  打开工作流
                  <ArrowRight size={13} />
                </button>
              </>
            ) : (
              <div className="vq-project-empty">
                <strong>还没开工作流</strong>
                <span>
                  {data.script
                    ? '用这条作品现在的脚本开一条工作流：复刻脚本' +
                      (storyboardShots ? ' + ' + storyboardShots + ' 镜出图节点' : '（输入带钩子、复刻带完整提示词）') +
                      (storyboardShots
                        ? '。节点本身不扣积分，跑一次每张画扣 ' + (shotEachPrice || 5) + ' 积分，画失败会退回。'
                        : '。')
                    : '先在左边写一条脚本（或从模板库套一条），再来开工作流。'}
                </span>
                <button
                  type="button"
                  className="vq-button vq-button--ghost"
                  onClick={() => void openCanvas()}
                  disabled={busy === 'canvas' || !data.script}
                >
                  <Clapperboard size={13} />
                  {busy === 'canvas' ? '生成中…' : '开工作流'}
                </button>
              </div>
            )}
          </section>

          {/* 花费（v0.9.65）：钱花在这条作品的哪一步。只算评审与工作流运行——
              检索、复刻与对话记在账号上，账本里没有作品，不摊过来 */}
          {spend ? (
            <section className="vq-project-panel vq-project-spend" aria-labelledby="vq-project-spend-head">
              <div className="vq-project-panel-head">
                <h2 id="vq-project-spend-head">花费</h2>
                <span className="vq-project-spend-head">
                  <span className="vq-mono">
                    {spend.total.toLocaleString('zh-CN')} {spend.unit}
                  </span>
                  <button
                    type="button"
                    className="vq-spend-toggle"
                    aria-expanded={spendOpen}
                    aria-controls="vq-project-spend-detail"
                    onClick={toggleSpend}
                  >
                    {spendOpen ? '收起' : '明细'}
                    <ChevronDown size={12} className={spendOpen ? 'is-open' : ''} />
                  </button>
                </span>
              </div>
              {spend.total > 0 ? (
                <div className="vq-project-spend-split">
                  <p className="vq-project-spend-row">
                    <span>评审</span>
                    <b>{spend.reviews.count} 次</b>
                    <i>
                      {spend.reviews.credits.toLocaleString('zh-CN')} {spend.unit}
                    </i>
                  </p>
                  <p className="vq-project-spend-row">
                    <span>工作流运行</span>
                    <b>{spend.runs.count} 次</b>
                    <i>
                      {spend.runs.credits.toLocaleString('zh-CN')} {spend.unit}
                    </i>
                  </p>
                </div>
              ) : (
                <p className="vq-project-note">这条作品还没花过积分：评一次或跑一次工作流，这里就会出现数字。</p>
              )}
              {spend.lastAt ? (
                <p className="vq-project-note vq-mono">最近一次 · {stamp(spend.lastAt)}</p>
              ) : null}
              <p className="vq-project-note">
                退过款的运行不算（钱已经退回）；检索、复刻与对话记在账号上，去设置页「本月花在哪」看。
              </p>
              {spendOpen ? (
                <div className="vq-project-spend-detail" id="vq-project-spend-detail">
                  {spendBusy ? <p className="vq-project-note">正在读明细…</p> : null}
                  {spendError ? <p className="vq-project-note">明细没读出来：{spendError}</p> : null}
                  {spendDetail ? (
                    <>
                      <div className="vq-spend-scope" role="group" aria-label="花费时间范围">
                        <button
                          type="button"
                          className={'vq-filter-chip' + (spendScope === '' ? ' is-active' : '')}
                          aria-pressed={spendScope === ''}
                          onClick={() => pickSpendScope('')}
                        >
                          累计
                          <span className="vq-filter-chip__count">{spendTotalAll.toLocaleString('zh-CN')}</span>
                        </button>
                        <button
                          type="button"
                          className={'vq-filter-chip' + (spendScope !== '' ? ' is-active' : '')}
                          aria-pressed={spendScope !== ''}
                          onClick={() => pickSpendScope(spendDetail.month)}
                        >
                          {monthLabel(spendDetail.month)}
                          <span className="vq-filter-chip__count">{spendTotalMonth.toLocaleString('zh-CN')}</span>
                        </button>
                      </div>
                      <p className="vq-spend-scope-line">
                        {spendScope === '' ? '累计 · ' : monthLabel(spendScope) + ' · '}
                        {spendDetail.total.toLocaleString('zh-CN')} {spendDetail.unit} · 评审{' '}
                        {spendDetail.reviews.credits.toLocaleString('zh-CN')} · 运行{' '}
                        {spendDetail.runs.credits.toLocaleString('zh-CN')}
                        {spendDetail.refunded.count ? (
                          <span className="vq-spend-refunded">
                            {' · 已退回 '}
                            {spendDetail.refunded.count}
                            {' 次共 '}
                            {spendDetail.refunded.credits.toLocaleString('zh-CN')}
                          </span>
                        ) : null}
                      </p>
                      {spendDetail.byVersion.length ? (
                        <div className="vq-spend-versions">
                          {spendDetail.byVersion.map((row) => (
                            <p className="vq-spend-version" key={row.version}>
                              <span className="vq-spend-version-n">第 {row.version} 版</span>
                              <span>
                                评审 {row.reviews.count} 次 {row.reviews.credits.toLocaleString('zh-CN')} · 运行{' '}
                                {row.runs.count} 次 {row.runs.credits.toLocaleString('zh-CN')}
                              </span>
                              <b>
                                合计 {row.total.toLocaleString('zh-CN')} {spendDetail.unit}
                              </b>
                            </p>
                          ))}
                        </div>
                      ) : null}
                      {spendDetail.items.length ? (
                        <ol className="vq-spend-items">
                          {spendDetail.items.map((entry) => (
                            <li
                              className={'vq-spend-item' + (entry.refunded ? ' is-refunded' : '')}
                              key={entry.kind + ':' + entry.id}
                            >
                              <span className="vq-spend-item-time vq-mono">{shortStamp(entry.at)}</span>
                              <span className="vq-spend-item-text">
                                {entry.kind === 'review' ? '视觉评审' : '工作流运行'}
                                {entry.version ? ' · 第 ' + entry.version + ' 版' : ''}
                                {entry.kind === 'review'
                                  ? ' · ' + (VERDICT_LABEL[entry.verdict || ''] || '结论未记录')
                                  : entry.note
                                    ? ' · ' + entry.note
                                    : ''}
                              </span>
                              <b className="vq-spend-item-credits">
                                {entry.credits
                                  ? entry.credits.toLocaleString('zh-CN') + ' ' + spendDetail.unit
                                  : '未扣积分'}
                                {entry.refunded ? ' · 已退回' : ''}
                              </b>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="vq-project-note">
                          {spendScope === '' ? '这条作品还没花过积分。' : monthLabel(spendScope) + '还没花过积分。'}
                        </p>
                      )}
                      {spendDetail.count > spendDetail.shown ? (
                        <p className="vq-project-note">
                          只列最近 {spendDetail.shown} 笔（共 {spendDetail.count} 笔），更早的按月切换看。
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="vq-project-panel">
            <div className="vq-project-panel-head">
              <h2>评审</h2>
              <span className="vq-mono">{reviews.length ? reviews.length + ' 次' : '还没评过'}</span>
            </div>
            {/* 人工复核：模型给结论，人拍板。拍板不改评审记录，只回答「这一版谁拍的板」，
                胶囊、下一步、交付稿与两张纸都跟着换口径（v0.9.21） */}
            {currentReviews.count ? (
              <div className={'vq-review-decision' + (decision ? ' is-' + decision.decision : '')}>
                <div className="vq-review-decision-head">
                  <span className="vq-review-decision-kicker">人工复核</span>
                  <span className="vq-mono">
                    {decision
                      ? '你 ' + reviewTimeLabel(decision.at) + ' 拍板' + (decision.decision === 'pass' ? '通过' : '不通过')
                      : canDecide
                        ? '模型结论：' + (VERDICT_LABEL[currentReviews.lastVerdict] || '需人工确认') + ' · 还没人拍板'
                        : '模型说通过，不需要人工确认'}
                  </span>
                </div>
                {canDecide || decision ? (
                  <>
                    <p className="vq-review-decision-hint">
                      {decision
                        ? '拍板会写在交付稿与评审对照纸上；再评出新结论后需要重新拍板。'
                        : '看过证据再拍：拍板会写进交付稿与评审对照纸，状态胶囊与下一步跟着换。'}
                    </p>
                    <label className="vq-review-decision-field">
                      <span>一句话备注（可选，会印在纸上）</span>
                      <input
                        value={noteValue}
                        maxLength={80}
                        placeholder="为什么放行 / 为什么不发"
                        disabled={decideBusy !== ''}
                        onChange={(event) => setDecisionNote(event.target.value)}
                      />
                    </label>
                    <div className="vq-review-decision-actions">
                      {decision ? (
                        <>
                          <button
                            type="button"
                            className="vq-button vq-button--ghost"
                            onClick={() => void undoDecision()}
                            disabled={decideBusy !== ''}
                            title="只撤这一版这一次评审的拍板；早先几版的记录留在下面的拍板记录里"
                          >
                            {decideBusy === 'undo' ? '正在撤销…' : '撤销这一版'}
                          </button>
                          <button
                            type="button"
                            className="vq-button vq-button--ghost"
                            onClick={() => void decide(decision.decision === 'pass' ? 'reject' : 'pass')}
                            disabled={decideBusy !== ''}
                          >
                            改判为{decision.decision === 'pass' ? '不通过' : '通过'}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="vq-button vq-button--primary"
                            onClick={() => void decide('pass')}
                            disabled={decideBusy !== ''}
                          >
                            {decideBusy === 'pass' ? '正在记…' : '拍板通过'}
                          </button>
                          <button
                            type="button"
                            className="vq-button vq-button--danger"
                            onClick={() => void decide('reject')}
                            disabled={decideBusy !== ''}
                          >
                            {decideBusy === 'reject' ? '正在记…' : '这一版不行'}
                          </button>
                        </>
                      )}
                    </div>
                  </>
                ) : null}
                {/* 第三个出口：看过了、这一版先不改。它不动结论，只把这条从工作台待办里拿开；
                    这一版再评出结论、或开了新版，它自己会回来。 */}
                {delivered || !canDecide || decision ? null : (
                  <div className="vq-review-ack">
                    {ack ? (
                      <>
                        <span className="vq-mono">你 {reviewTimeLabel(ack.at)} 看过这一版 · 先不改</span>
                        <button
                          type="button"
                          className="vq-link"
                          onClick={() => void undoSeen()}
                          disabled={ackBusy !== ''}
                        >
                          {ackBusy === 'undo' ? '撤销中…' : '撤销已看过'}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="vq-link"
                        onClick={() => void markSeen()}
                        disabled={ackBusy !== ''}
                        title="看过了，这一版先不改：从工作台的待办里拿掉；结论不变，这一版再评出结论它会自己回来"
                      >
                        {ackBusy === 'ack' ? '记下中…' : '已看过 · 这一版先不改'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : null}
            {/* 拍板记录（v0.9.26）：改判、撤销、开新版之后，旧的那几条不是消失了，而是躺在这一格里。
                每行写清哪一版、那次评审模型说了什么、当时为什么放行；还算不算数由服务端算（state）。 */}
            {decisionLog.length ? (
              <div className="vq-decision-log">
                <div className="vq-decision-log-head">
                  <span className="vq-decision-log-kicker">拍板记录</span>
                  <span className="vq-mono">{decisionLog.length} 条 · 新的在上</span>
                </div>
                <ul className="vq-decision-log-list">
                  {decisionLog.map((entry) => {
                    const review = reviewByCreatedAt.get(entry.reviewAt)
                    const stateText =
                      entry.state === 'current'
                        ? '管这一版'
                        : entry.state === 'stale'
                          ? '这一版重评过 · 已失效'
                          : '早先那一版'
                    // 一行里说完：什么时候拍的、那次评审模型说了什么（中文里不要再插空格）
                    const metaText =
                      reviewTimeLabel(entry.at) + ' 拍 · 那次评审：' + (VERDICT_LABEL[entry.verdict] || '未记录结论')
                    const inner = (
                      <>
                        <span className="vq-decision-log-flags">
                          <span className={'vq-decision-log-tag is-' + entry.decision}>
                            {entry.decision === 'pass' ? '人工通过' : '人工不通过'}
                          </span>
                          <span className="vq-mono vq-decision-log-version">v{entry.version}</span>
                        </span>
                        <span className="vq-decision-log-body">
                          <span className={'vq-decision-log-state is-' + (entry.state || 'past')}>{stateText}</span>
                          <span className="vq-decision-log-meta">{metaText}</span>
                          {entry.note ? <span className="vq-decision-log-note">备注：{entry.note}</span> : null}
                        </span>
                        {review ? <ArrowRight size={13} className="vq-decision-log-go" /> : null}
                      </>
                    )
                    return (
                      <li key={entry.id}>
                        {review ? (
                          <button
                            type="button"
                            className="vq-decision-log-row"
                            onClick={() => onOpenReviewRecord(review.id)}
                            title="看这次评审的证据原图"
                          >
                            {inner}
                          </button>
                        ) : (
                          <div className="vq-decision-log-row is-static">{inner}</div>
                        )}
                      </li>
                    )
                  })}
                </ul>
                <div className="vq-decision-log-foot">
                  <span>撤销只拿走这一版；早先几版的记录留着。</span>
                  <button
                    type="button"
                    className="vq-link"
                    onClick={() => void clearDecisionLog()}
                    disabled={decideBusy !== ''}
                    title="连早先几版的记录一起删掉：点两下才动手"
                  >
                    {decideBusy === 'clear'
                      ? '正在清空…'
                      : clearLogArmed
                        ? '再点一次：清空 ' + decisionLog.length + ' 条'
                        : '清空拍板记录'}
                  </button>
                </div>
              </div>
            ) : null}
            {reviews.length ? (
              <>
                <p className="vq-project-review-hint">点一条看当时的证据原图与问题锚点。</p>
                <ul className="vq-project-reviews">
                  {reviews.map((review) => (
                    <li key={review.id}>
                      <button
                        type="button"
                        className="vq-project-review-row"
                        onClick={() => onOpenReviewRecord(review.id)}
                        title="看这次评审的证据原图"
                      >
                        <span className="vq-project-review-flags">
                          <span className={'vq-project-verdict is-' + (review.verdict || 'none')}>
                            {VERDICT_LABEL[review.verdict] || '未记录'}
                          </span>
                          {review.version ? (
                            <span className="vq-mono vq-project-review-version">v{review.version}</span>
                          ) : null}
                        </span>
                        <span className="vq-project-review-body">
                          <span className="vq-project-review-summary">
                            {review.summary || review.intent || '这次评审没有留下结论摘要'}
                          </span>
                          <span className="vq-mono vq-project-review-time">{stamp(review.createdAt)}</span>
                        </span>
                        <ArrowRight size={13} className="vq-project-review-go" />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="vq-project-empty">
                <strong>这一版还没进评审</strong>
                <span>拿你这一版的画面跑一次视觉评审，结论会记在这条作品下。</span>
              </div>
            )}
            <button type="button" className="vq-button vq-button--ghost vq-project-full" onClick={() => onOpenReview(project.id)}>
              <ScanEye size={13} />
              {currentReviews.count ? '再评一次' : '用评审看这版'}
            </button>
          </section>

          <section className="vq-project-panel">
            <div className="vq-project-panel-head">
              <h2>来源</h2>
              <span className="vq-mono">{template ? KIND_LABEL[template.kind] || template.kind : '—'}</span>
            </div>
            {template ? (
              <>
                <dl className="vq-project-source">
                  <div>
                    <dt>模板</dt>
                    <dd>
                      {onOpenTemplate ? (
                        <button
                          type="button"
                          className="vq-project-source-link"
                          onClick={() => onOpenTemplate(template.id)}
                          title="在模板库打开这条模板：脚本、分镜与它的原片都在那儿"
                        >
                          {template.title}
                          <ArrowRight size={12} />
                        </button>
                      ) : (
                        template.title
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>内容类型</dt>
                    <dd>{template.contentType || '—'}</dd>
                  </div>
                  {/* 只有真原片才写原片时长：工作流 / 对话预设来的模板没有原片，写 0.0s 是编的 */}
                  {template.origin?.kind === 'original' ? (
                    <div>
                      <dt>原片时长</dt>
                      <dd className="vq-project-source-num">{seconds(template.durationSec)}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>复用</dt>
                    <dd className="vq-mono">{template.reuseCount} 次</dd>
                  </div>
                </dl>
                {template.origin?.kind === 'original' ? (
                  <div className="vq-project-origin">
                    <div className="vq-project-origin-head">
                      <span className="vq-mono">原片</span>
                      <a className="vq-project-origin-link" href={template.origin.url} target="_blank" rel="noreferrer">
                        打开原片
                        <ArrowRight size={12} />
                      </a>
                    </div>
                    <p className="vq-project-origin-line">
                      {[template.origin.platformLabel || template.origin.platform, template.origin.author]
                        .filter(Boolean)
                        .join(' · ') || '平台与作者未记录'}
                    </p>
                    {template.origin.stats ? (
                      <p className="vq-project-origin-stats vq-mono">
                        <span>点赞 {formatCount(template.origin.stats.likes)}</span>
                        <span>收藏 {formatCount(template.origin.stats.collects)}</span>
                        <span>评论 {formatCount(template.origin.stats.comments)}</span>
                      </p>
                    ) : null}
                  </div>
                ) : template.origin ? (
                  <p className="vq-project-note">
                    {template.origin.kind === 'canvas'
                      ? '这条模板是从工作流另存的，没有原片可回看。'
                      : '这条模板是对话预设草稿存的，没有原片可回看。'}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="vq-project-note">绑定的模板已被删除或不在当前账号下；作品本身还在，工作流与评审不受影响。</p>
            )}
          </section>
        </aside>
      </div>

      {shareOpen ? (
        <div className="vq-modal-backdrop" onMouseDown={() => setShareOpen(false)}>
          <div
            className="vq-share-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vq-share-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="vq-share-head">
              <div>
                <span className="vq-mono">只读分享 / READ ONLY</span>
                <h2 id="vq-share-title">把这条作品发给别人看</h2>
              </div>
              <button type="button" className="vq-button vq-button--icon" aria-label="关闭分享" onClick={() => setShareOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <p className="vq-share-copy">
              拿到链接的人不用登录就能看：开头钩子、脚本分段与口播时长、分镜、评审与运行的次数，
              还有一张评审对照纸（评审说的问题框在当时的画面上，可打印或存 PDF）。
              两版对照默认不带；需要给甲方看「这一版改了什么」时，在链接下面单独打开。
              看不到账号、积分与完整工作流。
            </p>

            {data.share ? (
              <>
                <label className="vq-share-label" htmlFor="vq-share-link">
                  分享链接
                </label>
                <div className="vq-share-row">
                  <input
                    id="vq-share-link"
                    className="vq-share-input"
                    readOnly
                    value={shareLink}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="vq-button vq-button--primary"
                    onClick={() => void copyShareLink()}
                    disabled={shareBusy === 'copy'}
                  >
                    {shareCopied ? (
                      <>
                        <Check size={14} />
                        已复制
                      </>
                    ) : (
                      <>
                        <Link2 size={14} />
                        复制链接
                      </>
                    )}
                  </button>
                </div>
                <div className="vq-share-actions">
                  <a className="vq-button vq-button--ghost" href={shareLink} target="_blank" rel="noreferrer">
                    在新标签打开
                    <ArrowRight size={13} />
                  </a>
                  <button
                    type="button"
                    className="vq-button vq-button--danger"
                    onClick={() => void stopShare()}
                    disabled={shareBusy === 'disable'}
                  >
                    {shareBusy === 'disable' ? '正在停止…' : '停止分享'}
                  </button>
                </div>
                {data.project.version > 1 ? (
                  <div className="vq-share-compare">
                    <div className="vq-share-compare-main">
                      <span className="vq-share-compare-title">
                        <GitCompare size={14} />
                        分享页带上两版对照
                      </span>
                      <p className="vq-share-compare-copy">
                        v{data.project.version - 1} → v{data.project.version} 的工作流参数、脚本口播、评审与交付并排；
                        默认关，打开后拿到链接的人也能打印这张 A4。
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={data.share.compare}
                      aria-label="分享页带上两版对照"
                      className={'vq-share-switch' + (data.share.compare ? ' is-on' : '')}
                      onClick={() => void toggleShareCompare()}
                      disabled={shareBusy === 'compare'}
                    >
                      <span aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <p className="vq-share-note">这条作品还没有上一版：开出第二版后，分享页可以带上两版对照。</p>
                )}
                <div className="vq-share-visits">
                  <div className="vq-share-visits-head">
                    <span className="vq-share-visits-label">链接打开情况</span>
                    <span className="vq-mono">只记次数与设备类型</span>
                  </div>
                  {data.share.visits && data.share.visits.opens > 0 ? (
                    <>
                      <p className="vq-share-visits-main">
                        <strong>{data.share.visits.opens}</strong> 次打开 · {visitLine(data.share.visits)}
                      </p>
                      <p className="vq-share-visits-sub">
                        第一次打开 {stamp(data.share.visits.firstAt)}。一分钟内的连续刷新算同一次；不记录是谁、也不记录 IP。
                      </p>
                    </>
                  ) : (
                    <p className="vq-share-visits-sub">
                      还没有人打开过这条链接。发出去之后回这里看，就能知道对方点开过几次、最近一次是什么时候。
                    </p>
                  )}
                </div>
                <p className="vq-share-note">
                  停止后这个地址立即失效，已经发出去的链接打不开；再开一次会换一条新链接。链接是这个账号开的，只有你能停。
                </p>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="vq-button vq-button--primary"
                  onClick={() => void startShare()}
                  disabled={shareBusy === 'enable'}
                >
                  <Share2 size={14} />
                  {shareBusy === 'enable' ? '正在生成…' : '生成分享链接'}
                </button>
                <p className="vq-share-note">链接挂在这条作品上，不用了随时停止；作品删除后链接也会一起失效。</p>
              </>
            )}
            {data.shareHistory.length ? (
              <div className="vq-share-history">
                <div className="vq-share-visits-head">
                  <span className="vq-share-visits-label">以前的链接</span>
                  <span className="vq-mono">停用后打不开，记录留着</span>
                </div>
                <ul className="vq-share-history-list">
                  {data.shareHistory.map((entry) => (
                    <li className="vq-share-history-row" key={entry.closedAt + entry.createdAt}>
                      <span className="vq-mono vq-share-history-when">{stamp(entry.closedAt)} 停用</span>
                      <span className="vq-share-history-text">
                        {entry.visits.opens > 0 ? (
                          <>
                            <strong>{entry.visits.opens}</strong> 次打开 · {visitLine(entry.visits)}
                          </>
                        ) : (
                          '没人打开过'
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {compareOpen ? (
        <VersionCompareModal
          projectId={project.id}
          versions={versionRows.map((row) => ({ n: row.n, name: row.name, current: row.current }))}
          initialBase={project.basedOn || (project.version > 1 ? project.version - 1 : 1)}
          initialTarget={project.version}
          onClose={() => setCompareOpen(false)}
          onPrint={openPaper}
        />
      ) : null}

      <VersionScriptModal state={versionScript} onClose={() => setVersionScript((prev) => ({ ...prev, open: false }))} />
    </div>
  )
}
