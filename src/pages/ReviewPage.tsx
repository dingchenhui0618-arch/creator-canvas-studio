import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight, ChevronDown, Clapperboard, Crosshair, ImagePlus, Loader2, Play, RefreshCw, ScanEye, TriangleAlert } from 'lucide-react'
import { getReview, getReviewCandidates, getReviewStatus, listReviews, runReview, type JudgeResult, type ReviewCandidates, type ReviewResult, type ReviewStatus, type ReviewSummary } from '../api/review'
import { getCredits, getModelService, recheckModelService, type CreditsResponse, type ModelServiceState } from '../api/credits'
import { listTemplates, coverSrc } from '../api/radar'
import { uploadRejection, uploadReviewImage } from '../api/media'
import { getProject } from '../api/projects'
import {
  ISSUE_LABEL,
  ISSUE_TONE,
  issueCountsOf,
  issueGap,
  issueLine,
  REVIEW_VERDICT_LABEL as VERDICT_LABEL,
  reviewTimeLabel,
  reviewVersionLabel,
} from '../domain/review'
import { anchorNumber, evidenceAreaLabel, reviewAnchorBadges, reviewAnchorMarks } from '../domain/review-anchors'
import type { ReplicaTemplate } from '../domain/radar'
import { consumeReviewTarget, onReviewRequest, type ReviewTarget } from '../state/review'
import { useUiMode } from '../api/app'
import PageHead from '../components/PageHead'
import ReviewHistoryModal from '../components/ReviewHistoryModal'
import { ReviewHistoryRow } from '../components/ReviewHistoryRow'
import { Pill, Tag } from '../components/ui'
import '../styles/review.css'

// 严重度四级（ISSUE_LABEL / ISSUE_TONE）与版本对照、交付纸共用 domain/review.ts 那一份，
// 这里不再各写一套，免得一处写「阻塞」一处写「阻断」
const SUPPORT_LABEL: Record<string, string> = {
  supported: '一致',
  too_strict: '偏严',
  too_lenient: '偏松',
}
const RISK_LABEL = ['可以直接发布', '小修后可以发布', '必须先解决问题再发布']

function percent(value: number | null | undefined) {
  if (value === null || value === undefined) return '—'
  return Math.round(value * 100) + '%'
}

/**
 * 这一次评审的问题数（v0.9.84）：结论下面先给一行数字，再往下看逐条。
 * 严重度没记全时把「另有 N 条」写出来——0 个阻塞和「没记」不是一回事。
 */
function ReviewIssueSummary({ observations }: { observations: ReviewResult['observations'] }) {
  const issues = issueCountsOf(observations)
  const line = issueLine(issues)
  if (!line) return null
  const gap = issueGap(issues)
  return (
    <p className="review-issue-summary vq-mono">
      {issues.observations} 条问题 · {line}
      {gap ? <span className="review-issue-gap">另有 {gap} 条没记严重度</span> : null}
    </p>
  )
}

/**
 * 判断层（TypeSafe / Jev）：视觉模型出结论，判断模型判「这份结论站不站得住」。
 * 只展示依据，不改结论 —— 两个模型口径不同，改结论就说不清是谁的责任。
 */
function JudgePanel({ judge }: { judge: JudgeResult }) {
  if (judge.status === 'disabled') {
    return (
      <div className="review-judge is-off">
        <div className="review-judge-head">
          <h3>判断模型 · Jev</h3>
          <span className="vq-mono">未启用</span>
        </div>
        <p>{judge.note}</p>
      </div>
    )
  }
  if (judge.status === 'failed') {
    return (
      <div className="review-judge is-off">
        <div className="review-judge-head">
          <h3>判断模型 · Jev</h3>
          <span className="vq-mono">调用失败</span>
        </div>
        <p>判断层这次没跑通，上面的评审结论不受影响；后台「路由决策」里能看到原因。</p>
      </div>
    )
  }
  const risk = judge.publishRisk
  const support = judge.verdictSupport
  const riskLabel = risk
    ? risk.legend?.[String(Math.round(risk.score))] || RISK_LABEL[Math.round(risk.score)] || risk.score.toFixed(1)
    : '—'
  return (
    <div className="review-judge">
      <div className="review-judge-head">
        <h3>判断模型 · Jev</h3>
        <span className="vq-mono">{judge.model} · {judge.ms} ms</span>
      </div>
      <div className="review-judge-grid">
        <div><span>结论有画面依据</span><strong>{percent(judge.evidenceConsistent)}</strong></div>
        <div><span>结论与问题一致</span><strong>{support ? SUPPORT_LABEL[support.choice] || support.choice : '—'}</strong></div>
        <div><span>建议可直接执行</span><strong>{percent(judge.actionable)}</strong></div>
        <div><span>发布前风险</span><strong>{riskLabel}</strong></div>
      </div>
      <p className="review-judge-note">判断层只给依据，不改上面的结论；两者不一致时以视觉证据为准，再人工确认。</p>
    </div>
  )
}

type Picked = { media?: string; imageUrl?: string; label: string; preview: string }

export default function ReviewPage({
  projectId,
  reviewId,
  onOpenProject,
  onOpenReview,
  onReviewProject,
  onClearReview,
  onOpenProjects,
}: {
  projectId?: string
  reviewId?: string
  onOpenProject?: (projectId: string) => void
  /** 打开某一条历史评审：地址换成 #/review/<评审 id>，刷新与后退都能回到那条 */
  onOpenReview?: (reviewId: string) => void
  /** 接着评这条作品当前这一版：新评审挂在作品下，有归属 */
  onReviewProject?: (projectId: string) => void
  /** 回到不带记录的自由评审 */
  onClearReview?: () => void
  /** 候选之外的「还有 N 条」去作品列表 */
  onOpenProjects?: () => void
} = {}) {
  const { internal } = useUiMode()
  // 从作品页进来时，这次评审的结论会挂在那条作品下；标题只为把话说清楚（读不到就不显示名字）
  const [projectTitle, setProjectTitle] = useState('')
  const [status, setStatus] = useState<ReviewStatus | null>(null)
  const [templates, setTemplates] = useState<ReplicaTemplate[]>([])
  const [picked, setPicked] = useState<Picked | null>(null)
  const [result, setResult] = useState<ReviewResult | null>(null)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [active, setActive] = useState<string | null>(null)
  // 钉住：悬停只是预览，钉住才是「现在就看这一条」；再点一次或按 Esc 取消
  const [pinned, setPinned] = useState<string | null>(null)
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  // 模型服务状态：额度 / 凭证故障时先说明，不让人点一次再退一次积分
  const [modelState, setModelState] = useState<ModelServiceState | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [reviews, setReviews] = useState<ReviewSummary[]>([])
  // 历史存 200 条，左侧只放最近 6 条；总数用来在标题旁写「共 N 条」并给出「查看全部」
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyError, setHistoryError] = useState('')
  // 打开的是历次评审里的哪一条：历史只读，所以要说清它记在哪条作品的第几版
  const [openedScope, setOpenedScope] = useState<{ id: string; title: string; version: number } | null>(null)
  // 现在打开的是不是一条已落库的评审：是就只读，不给「再来一次」把结论盖成一条没归属的新记录
  const [openedId, setOpenedId] = useState<string | null>(null)
  const [openError, setOpenError] = useState('')
  // 证据原图被删过（模板帧清理 / 远程图片失效）：说清楚，不留一张破图
  const [previewBroken, setPreviewBroken] = useState(false)
  const [manualUrl, setManualUrl] = useState('')
  // 自己传一张图（v0.9.87）：传完就当成「已挑好画面」——评审那条链路认的是 media 路径，与模板帧同一套
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadNote, setUploadNote] = useState('')
  const [uploadDrag, setUploadDrag] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  // 首屏先问「评哪条作品的哪一版」：没有作品、或从作品页进来要挑画面时，才回到挑一张图
  const [candidates, setCandidates] = useState<ReviewCandidates | null>(null)
  const [candidatesError, setCandidatesError] = useState('')
  // 「单独评一张画面」默认收着；null = 用户没动过，按上下文自动定（见 pickerExpanded）
  const [pickerOpen, setPickerOpen] = useState<boolean | null>(null)
  const timerRef = useRef<number | null>(null)
  const startedRef = useRef(0)
  // 钉住锚点时把画面滚进视野（窄屏上问题行在画面下面）
  const canvasRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!projectId) return
    let alive = true
    getProject(projectId)
      .then((data) => {
        if (alive) setProjectTitle(data.project.title)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [projectId])

  const pick = useCallback((target: Picked) => {
    setPicked(target)
    // 换成模板帧 / 图片地址时，上传栏那句「已选 …」不再成立（上传成功后它自己会再写上）
    setUploadNote('')
    setResult(null)
    setError('')
    setActive(null)
    setPinned(null)
    setOpenedScope(null)
    setOpenedId(null)
    setOpenError('')
    setPreviewBroken(false)
  }, [])


  /**
   * 传一张自己的图当这次评审的画面（v0.9.87）：传完直接选中，评审走原来那条链路。
   * 本机先拦一次大小与类型，省得 8 MB 的请求体发出去再被拒；服务端还会按文件头再判一次。
   */
  const uploadImage = useCallback(
    async (file: File) => {
      const rejection = uploadRejection(file)
      if (rejection) {
        setUploadError(rejection)
        setUploadNote('')
        return
      }
      setUploadBusy(true)
      setUploadError('')
      setUploadNote('')
      try {
        const saved = await uploadReviewImage(file)
        if (reviewId) onClearReview?.()
        pick({ media: saved.media, label: '我传的图 · ' + file.name, preview: saved.imageUrl })
        setUploadNote(
          '已选 ' + file.name + ' · 第 ' + saved.usage.files + ' / ' + saved.usage.maxFiles + ' 张' +
            (saved.replaced ? '（顶掉了 ' + saved.replaced + ' 张旧图）' : ''),
        )
      } catch (reason) {
        setUploadError(reason instanceof Error ? reason.message : '上传失败，稍后再试')
      } finally {
        setUploadBusy(false)
      }
    },
    [onClearReview, pick, reviewId],
  )

  // Ctrl+V 直接贴截图：对「把这一版的画面贴进来最准」这句话来说，这是最短的一步。
  // 焦点在输入框里时不抢——那多半是在粘一个图片地址，不是在贴图。
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items
      if (!items?.length) return
      const active = document.activeElement as HTMLElement | null
      if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return
      const file = Array.from(items).find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile()
      if (!file) return
      event.preventDefault()
      void uploadImage(file)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [uploadImage])

  useEffect(() => {
    let alive = true
    getCredits(1).then((next) => { if (alive) setCredits(next) }).catch(() => { if (alive) setCredits(null) })
    getModelService()
      .then((next) => { if (alive) setModelState(next.model) })
      .catch(() => { if (alive) setModelState(null) })
    listReviews({ limit: 6 })
      .then((data) => {
        if (!alive) return
        setReviews(data.items)
        setHistoryTotal(data.total)
      })
      .catch((caught) => { if (alive) setHistoryError(caught instanceof Error ? caught.message : '评审历史读取失败') })
    // 候选：按最近改动排的四条作品，口径在服务端（review-candidates.mjs）
    getReviewCandidates(4)
      .then((data) => { if (alive) setCandidates(data) })
      .catch((caught) => { if (alive) setCandidatesError(caught instanceof Error ? caught.message : '作品列表读取失败') })
    Promise.all([getReviewStatus(), listTemplates({})])
      .then(([health, list]) => {
        if (!alive) return
        setStatus(health)
        setTemplates(list.items)
      })
      .catch(() => undefined)
    const stop = onReviewRequest((target: ReviewTarget) => {
      pick({
        media: target.media,
        imageUrl: target.imageUrl,
        label: target.label,
        preview: target.imageUrl || (target.media ? '/media/' + target.media.replace(/^media\//, '') : ''),
      })
    })
    const pending = consumeReviewTarget()
    if (pending) {
      window.setTimeout(() => {
        pick({ media: pending.media, imageUrl: pending.imageUrl, label: pending.label, preview: pending.imageUrl || (pending.media ? '/media/' + pending.media : '') })
      }, 0)
    }
    return () => {
      alive = false
      stop()
    }
  }, [pick])

  useEffect(() => {
    if (!running) return
    timerRef.current = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedRef.current) / 1000))
    }, 500)
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [running])

  const recheckModel = async () => {
    setRechecking(true)
    try {
      await recheckModelService()
      const next = await getModelService()
      setModelState(next.model)
    } catch {
      // 状态接口不可用时不伪装成功
    } finally {
      setRechecking(false)
    }
  }

  const modelBlocked = modelState?.available === false

  const run = async () => {
    if (!picked) return
    startedRef.current = Date.now()
    setElapsed(0)
    setRunning(true)
    setError('')
    setResult(null)
    setOpenedScope(null)
    try {
      const next = await runReview({
        media: picked.media,
        imageUrl: picked.imageUrl,
        intent: picked.label,
        label: picked.label,
        projectId: projectId || undefined,
      })
      setResult(next)
      setActive(next.observations[0]?.id ?? null)
      setPinned(null)
      // 评审已落库：刷新历史与余额，不靠本地缓存假装有记录
      void listReviews({ limit: 6 })
        .then((data) => {
          setReviews(data.items)
          setHistoryTotal(data.total)
        })
        .catch(() => undefined)
    } catch (reason) {
      setError(String((reason as Error)?.message || reason))
      // 失败后同步一次服务状态：额度 / 凭证问题会在页头与提示条上显示
      getModelService().then((next) => setModelState(next.model)).catch(() => undefined)
    } finally {
      setRunning(false)
      getCredits(1).then(setCredits).catch(() => undefined)
    }
  }

  /**
   * 打开一条已经落库的评审：画面、结论、锚点都从记录里读。
   * 归属用记录自己的 project（服务端现算），不依赖「最近评审」那 6 条——
   * 从作品页点开的往往是更早的评审，根本不在最近列表里。
   */
  const loadRecord = useCallback(async (id: string) => {
    try {
      // 先拿到记录再动状态：效果里只发起请求，不在同一帧里连锁改状态
      const record = await getReview(id)
      const media = record.source.media || ''
      const imageUrl = record.source.imageUrl || ''
      setPicked({
        media: media || undefined,
        imageUrl: imageUrl || undefined,
        label: record.source.label || record.intent || '历史评审',
        preview: imageUrl || (media ? '/media/' + media.replace(/^media\//, '') : ''),
      })
      setResult(record.result)
      setActive(record.result.observations?.[0]?.id ?? null)
      setPinned(null)
      setOpenedId(record.id)
      setOpenedScope(record.project ? { id: record.project.id, title: record.project.title, version: record.version || 0 } : null)
      setOpenError('')
      setPreviewBroken(false)
    } catch (caught) {
      // 记录读不到（删了、或不是这个账号的）就退回可选画面的状态，并把原因说出来
      setPicked(null)
      setResult(null)
      setOpenedId(null)
      setOpenedScope(null)
      setOpenError(caught instanceof Error ? caught.message : '读取评审记录失败')
    }
  }, [])

  // 地址里带评审 id：进入就打开那一条，刷新、前进后退、直接分享链接都落到同一份记录。
  // 与作品页同一套写法：先让这一帧画完再发请求，免得同一帧里连锁改状态。
  useEffect(() => {
    if (!reviewId) return
    const timer = window.setTimeout(() => {
      void loadRecord(reviewId)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [reviewId, loadRecord])

  /** 收起这条历史记录，回到可以另选画面/另开评审的状态；地址里的评审 id 一并去掉 */
  const clearRecord = useCallback(() => {
    setPicked(null)
    setResult(null)
    setActive(null)
    setPinned(null)
    setOpenedScope(null)
    setOpenedId(null)
    setOpenError('')
    setPreviewBroken(false)
    onClearReview?.()
  }, [onClearReview])

  // 图上的编号与右侧问题行共用一套序号：没有证据的问题不画框，但序号不跳（否则和模型给的顺序错位）
  const marks = useMemo(() => reviewAnchorMarks(result?.observations), [result])
  const markedIds = useMemo(() => new Set(marks.map((mark) => mark.id)), [marks])
  // 编号落点：两块证据重合时把编号挪到别的角/错开一圈，不叠成一串
  const badges = useMemo(() => new Map(reviewAnchorBadges(marks).map((badge) => [badge.id, badge])), [marks])
  // 钉住优先于悬停：悬停只是预览，钉住才是「正看这一条」
  const focusId = pinned ?? active

  /** 钉住一条问题的锚点：再点一次或按 Esc 取消；顺手把画面滚进视野 */
  const togglePin = useCallback((id: string) => {
    setPinned((current) => (current === id ? null : id))
    setActive(id)
    window.setTimeout(() => {
      canvasRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 0)
  }, [])

  // Esc 取消钉住：键盘用户不用再摸鼠标回到那个框上
  useEffect(() => {
    if (!pinned) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPinned(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pinned])

  // 正在打开地址里那条评审：打开的还是另一条（或还没打开）就算加载中，不用另存一个状态
  const recordLoading = Boolean(reviewId) && openedId !== reviewId && !openError

  /**
   * 左侧「单独评一张画面」展开还是收着。
   * 从作品页进来要挑这一版的画面、库里还没有作品（不收就没得选）这两种必须展开；
   * 其余先收着——首屏的主角是「评哪条作品」，不是 26 张别人的首帧。
   */
  const pickerExpanded = pickerOpen ?? (Boolean(projectId) || !candidates || candidates.total === 0)

  return (
    <div className="review-page">
      <PageHead
        kicker="VisionQA · visual-baseline"
        title="视觉评审"
        desc="评的是你这条作品的这一版能不能发：选这一版的画面、按 visual-baseline 出结论、逐条看证据锚点；也能单独评一张图，那种结论不挂作品。"
        actions={
          <div className="review-head-status">
            <Pill tone={status?.service ? 'pass' : 'warn'}>
              <ScanEye size={13} /> 评审引擎 {status?.service ? '本地服务' : '平台模型'}
            </Pill>
            <Pill tone={status?.model && !modelBlocked ? 'pass' : 'fail'}>
              评审模型 {status?.model ? (modelBlocked ? '暂时不可用' : '可用') : '未配置'}
            </Pill>
            {credits ? (
              <Pill title="评审按次扣积分，失败原路退回">
                每次 {credits.prices.review} {credits.unit} · 余额 {credits.balance ?? '—'}
              </Pill>
            ) : null}
          </div>
        }
      />

      {modelBlocked ? (
        <div className="review-model-note" role="status">
          <TriangleAlert size={14} />
          <div className="review-model-note-text">
            <span>{modelState?.message || '模型服务暂时不可用。本次未扣积分，请稍后再试。'}</span>
            {internal && modelState?.detail ? <small>{modelState.detail}</small> : null}
          </div>
          <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={() => void recheckModel()} disabled={rechecking}>
            <RefreshCw size={12} /> {rechecking ? '检测中' : '重新检测'}
          </button>
        </div>
      ) : null}

      <div className="review-body">
        <aside className="review-picker">
          {projectId ? (
            <div className="review-project-scope" role="note">
              <Clapperboard size={14} strokeWidth={1.75} />
              <div>
                <strong>记入作品：{projectTitle || '正在读取作品…'}</strong>
                <span>这次结论会挂在这条作品下。把这一版要发的画面传上来最准（下面可以直接传图或 Ctrl+V 贴截图）；没有截图时拿模板首帧也能评，但那是原片那一帧。</span>
              </div>
            </div>
          ) : null}
          <div className="review-picker-head">
            <h2>{projectId ? '给这一版挑一张画面' : '单独评一张画面'}</h2>
            <button
              type="button"
              className="review-picker-toggle"
              aria-expanded={pickerExpanded}
              title={pickerExpanded ? '收起模板首帧' : '展开模板首帧与图片地址'}
              onClick={() => setPickerOpen(!pickerExpanded)}
            >
              {templates.length} 个模板首帧
              <ChevronDown size={12} className={pickerExpanded ? 'is-open' : undefined} />
            </button>
          </div>

          {/* 传一张自己的图（v0.9.87）：以前只能从模板帧或图片地址里选，
              而作品页那句「把这一版要发的画面贴进来最准」一直没有入口能把图放进来。 */}
          <div
            className={'review-upload' + (uploadDrag ? ' is-dragging' : '') + (uploadBusy ? ' is-busy' : '')}
            onDragEnter={(event) => { event.preventDefault(); if (!uploadBusy) setUploadDrag(true) }}
            onDragOver={(event) => { event.preventDefault(); if (!uploadBusy) setUploadDrag(true) }}
            onDragLeave={() => setUploadDrag(false)}
            onDrop={(event) => {
              event.preventDefault()
              setUploadDrag(false)
              if (uploadBusy) return
              const file = event.dataTransfer?.files?.[0]
              if (file) void uploadImage(file)
            }}
          >
            <input
              ref={uploadInputRef}
              className="review-upload-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0]
                // 清空 value：同一个文件改完再选一次，change 也要能触发
                event.target.value = ''
                if (file) void uploadImage(file)
              }}
            />
            <div className="review-upload-text">
              <strong>{uploadBusy ? '正在传这张图…' : '传一张自己的图'}</strong>
              <span>{uploadNote || '拖进来、按 Ctrl+V 贴截图，或点右边选文件 · jpg / png / webp，≤ 8 MB'}</span>
            </div>
            <button
              type="button"
              className="vq-button vq-button--ghost vq-button--sm"
              onClick={() => uploadInputRef.current?.click()}
              disabled={uploadBusy}
              title="从电脑里选一张图：只评这一张，不动作品里的画布"
            >
              {uploadBusy ? <Loader2 size={13} className="vq-spin" /> : <ImagePlus size={13} />}
              {uploadBusy ? '上传中' : '选图'}
            </button>
          </div>
          {uploadError ? (
            <p className="review-upload-error" role="alert">
              <TriangleAlert size={13} /> {uploadError}
            </p>
          ) : null}
          {pickerExpanded ? (
            <>
              <div className="review-grid">
                {templates.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`review-thumb ${picked?.label === item.title ? 'is-active' : ''}`}
                    onClick={() => {
                      if (reviewId) onClearReview?.()
                      pick({ imageUrl: item.thumb ? undefined : coverSrc(item.cover), media: item.thumb ? item.thumb.replace(/^\/media\//, '') : undefined, label: item.title, preview: item.thumb || coverSrc(item.cover) })
                    }}
                    title={item.title}
                  >
                    {item.thumb || item.cover ? <img src={item.thumb || coverSrc(item.cover)} alt="" loading="lazy" /> : <span className="review-thumb-fallback">{item.contentType}</span>}
                    <span className="review-thumb-name">{item.title}</span>
                  </button>
                ))}
                {!templates.length ? <p className="review-empty">模板库还是空的，先去「发现」复刻一条。</p> : null}
              </div>

              <div className="review-manual">
                <label htmlFor="review-url">或粘贴图片地址</label>
                <div className="review-manual-row">
                  <input
                    id="review-url"
                    value={manualUrl}
                    placeholder="https://…jpg"
                    onChange={(event) => setManualUrl(event.target.value)}
                  />
                  <button
                    type="button"
                    className="vq-button vq-button--ghost vq-button--sm"
                    onClick={() => {
                      const value = manualUrl.trim()
                      if (!value) return
                      if (reviewId) onClearReview?.()
                      pick({ imageUrl: value, label: value.split('/').pop() || '远程图片', preview: value })
                    }}
                  >
                    载入
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="review-empty">
              评的是你这条作品这一版能不能发；只想单独评一张图（结论不挂作品）时，点上面「{templates.length} 个模板首帧」展开。
            </p>
          )}

          <div className="review-history">
            <div className="review-picker-head">
              <span className="vq-mono">最近评审</span>
              {historyTotal ? (
                <button type="button" className="review-history-more" onClick={() => setHistoryOpen(true)}>
                  查看全部 {historyTotal} 条 <ArrowRight size={11} />
                </button>
              ) : (
                <span className="vq-mono">{reviews.length}</span>
              )}
            </div>
            {historyError ? <p className="review-empty">{historyError}</p> : null}
            {reviews.length ? (
              <ul>
                {reviews.map((item) => (
                  <li key={item.id}>
                    <ReviewHistoryRow
                      item={item}
                      current={item.id === openedId}
                      onOpen={(id) => (onOpenReview ? onOpenReview(id) : void loadRecord(id))}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="review-empty">还没有评审记录；评审成功一次就会出现在这里。</p>
            )}
          </div>
        </aside>

        <section className="review-stage">
          {openedScope ? (
            <div className="review-project-scope review-scope-bar" role="note">
              <Clapperboard size={14} strokeWidth={1.75} />
              <div>
                <strong>这条评审记入：{openedScope.title} · {reviewVersionLabel(openedScope.version)}</strong>
                <span>历史记录，结论不会再变；想接着评这一版，用「评这一版」进那条作品的评审页。</span>
              </div>
              <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={() => onOpenProject?.(openedScope.id)}>
                回作品 <ArrowRight size={12} />
              </button>
            </div>
          ) : null}
          {picked ? (
            <div className="review-canvas" ref={canvasRef}>
              <div className="review-canvas-frame vq-frame">
                <div className={`review-canvas-shot${pinned ? ' is-pinned' : ''}`}>
                  {picked.preview && !previewBroken ? (
                    <>
                      <img src={picked.preview} alt={picked.label} onError={() => setPreviewBroken(true)} />
                      {marks.map((mark) => (
                        <button
                          key={mark.id}
                          type="button"
                          className={`review-anchor is-${mark.severity} ${focusId === mark.id ? 'is-active' : ''}`}
                          style={{
                            left: mark.evidence.x * 100 + '%',
                            top: mark.evidence.y * 100 + '%',
                            width: mark.evidence.w * 100 + '%',
                            height: mark.evidence.h * 100 + '%',
                          }}
                          title={anchorNumber(mark.index) + ' ' + mark.statement}
                          aria-label={'定位问题 ' + mark.index + '：' + mark.statement}
                          aria-pressed={pinned === mark.id}
                          onClick={() => togglePin(mark.id)}
                          onFocus={() => setActive(mark.id)}
                          onMouseEnter={() => setActive(mark.id)}
                        >
                          <span
                            className={'review-anchor-no is-' + (badges.get(mark.id)?.corner || 'tl')}
                            style={
                              {
                                '--badge-dx': (badges.get(mark.id)?.dx || 0) + 'px',
                                '--badge-dy': (badges.get(mark.id)?.dy || 0) + 'px',
                              } as CSSProperties
                            }
                          >
                            {anchorNumber(mark.index)}
                          </span>
                        </button>
                      ))}
                    </>
                  ) : (
                    // 原图没了也要能看懂：结论、锚点、修正建议都还在，只是画面不在了
                    <div className="review-canvas-missing" role="status">
                      <TriangleAlert size={16} />
                      <strong>评审时的画面已经不在了</strong>
                      <span>模板帧被清理、或远程图片失效；这条结论与下面每条问题的锚点仍然有效。</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="review-canvas-meta">
                <span className="vq-mono">{picked.label}</span>
                <div className="review-canvas-actions">
                  {openedId ? (
                    // 历史评审只读：在这里再评一次会是一条没归属的新记录，所以要评就回那条作品
                    openedScope ? (
                      <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={() => onReviewProject?.(openedScope.id)}>
                        评这一版 <ArrowRight size={12} />
                      </button>
                    ) : (
                      <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={clearRecord}>
                        回到评审页 <ArrowRight size={12} />
                      </button>
                    )
                  ) : (
                    <button type="button" className="vq-button vq-button--primary vq-button--sm" disabled={running || !status?.model || modelBlocked} onClick={run}>
                      {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                      {running ? '评审中 ' + elapsed + 's' : result ? '重新评审' : '开始评审'}
                    </button>
                  )}
                </div>
              </div>
              {marks.length ? (
                <p className="review-canvas-hint">
                  图上的编号与右侧问题一一对应：点编号或问题行钉住这一处，再点一下或按 Esc 取消。两块证据几乎重合时编号会自动错开。
                </p>
              ) : null}
            </div>
          ) : recordLoading ? (
            <div className="review-empty-state">
              <div className="review-empty-head">
                <Loader2 size={18} strokeWidth={1.5} className="spin" />
                <div>
                  <strong>正在打开这条评审</strong>
                  <span>画面、结论与问题锚点都从记录里读。</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="review-empty-state">
              <div className="review-empty-head">
                <Crosshair size={18} strokeWidth={1.5} />
                <div>
                  <strong>{projectId ? '给这条作品的这一版挑一张画面' : '先选一条作品：评的是这一版能不能发'}</strong>
                  <span>
                    {projectId
                      ? '左侧挑模板首帧，或粘贴这一版的截图地址；结论会挂在这条作品下。'
                      : '按最近改动排，点一行进那条作品的评审页；结论挂在这条作品下。'}
                  </span>
                </div>
              </div>

              {/* 从作品进来时对象已经定了：这一步只挑画面，不再列作品 */}
              {!projectId ? (
                <>
                  {candidatesError ? <p className="review-empty">作品列表读取失败：{candidatesError}</p> : null}
                  {candidates?.items.length ? (
                    <ul className="review-candidates">
                      {candidates.items.map((row) => (
                        <li key={row.projectId}>
                          <button
                            type="button"
                            className="review-candidate"
                            onClick={() => (row.hasCanvas ? onReviewProject?.(row.projectId) : onOpenProject?.(row.projectId))}
                          >
                            <span className="review-candidate-main">
                              <span className="review-candidate-title">{row.title}</span>
                              <span className="review-candidate-meta">
                                <span className="vq-mono">{row.versionLabel}</span>
                                <span aria-hidden="true">·</span>
                                {row.reviews.count ? (
                                  <>评过 {row.reviews.count} 次 · 最近 {reviewTimeLabel(row.reviews.lastAt)}</>
                                ) : (
                                  <>这一版还没评过</>
                                )}
                              </span>
                            </span>
                            <Pill tone={row.status.tone} title={row.status.text}>
                              {row.status.text}
                            </Pill>
                            <span className="review-candidate-go">
                              {row.hasCanvas ? '评这一版' : row.delivered ? '打开作品' : '先开画布'}
                              <ArrowRight size={13} />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : candidates ? (
                    <p className="review-empty">
                      库里还没有作品。先在模板库挑一条开成作品，评审结论才挂在一条作品上；眼下也能从左栏挑一张图单独评。
                    </p>
                  ) : null}
                  {candidates && candidates.total > candidates.items.length ? (
                    <button type="button" className="review-candidates-more" onClick={() => onOpenProjects?.()}>
                      还有 {candidates.total - candidates.items.length} 条在作品里
                      <ArrowRight size={13} />
                    </button>
                  ) : null}
                </>
              ) : null}

              <ol className="review-steps">
                <li>
                  <span className="vq-mono">01</span>
                  <div>
                    <strong>{projectId ? '挑画面' : '选版本'}</strong>
                    <p>
                      {projectId
                        ? '把这一版要发的截图贴进来最准；没有截图时模板首帧也能评（那是原片那一帧）。画幅越接近投放尺寸，结论越可靠。'
                        : '评的是作品的某一版；还没开画布的作品先开画布，先有这一版才谈得上能不能发。'}
                    </p>
                  </div>
                </li>
                <li>
                  <span className="vq-mono">02</span>
                  <div>
                    <strong>出结论</strong>
                    <p>
                      {internal ? '按 visual-baseline 七项维度评审' : '按七项视觉维度评审'}，结论只有通过 / 需人工确认 / 不通过三种。
                      每条问题带维度、严重度（阻塞 / 主要 / 次要 / 信息）和置信度——置信是模型对这条判断有多确定，不是问题有多严重。
                    </p>
                  </div>
                </li>
                <li>
                  <span className="vq-mono">03</span>
                  <div><strong>看证据</strong><p>每条判断带像素锚点：点问题行或图上编号钉住对应区域，再点一下或按 Esc 取消；没有证据的写进「无法判断」。</p></div>
                </li>
              </ol>
              <p className="review-empty-note">
                {status?.service
                  ? internal
                    ? '当前由 VisionQA 插件服务出结论；fixture provider 只证明链路可用，不代表模型准确率。'
                    : '当前由本地评审服务出结论，结果里会标明来源。'
                  : internal
                    ? 'VisionQA 插件服务未启动（127.0.0.1:6300），当前由本地视觉模型按同一套 visual-baseline 规则评审，provider 会写进结果。'
                    : '本次由平台视觉模型按同一套评审规则出结论，结果里会标明来源。'}
              </p>
            </div>
          )}

          {error ? (
            <div className="review-error">
              <TriangleAlert size={14} />
              <span>{error}</span>
              <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={run}>
                <RefreshCw size={12} /> 重试
              </button>
            </div>
          ) : null}

          {/* 地址里那条评审读不到（删了 / 不是本账号的）：说清楚，并给一条回到评审页的路 */}
          {openError ? (
            <div className="review-error">
              <TriangleAlert size={14} />
              <span>{openError}</span>
              <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={clearRecord}>
                回到评审页
              </button>
            </div>
          ) : null}

          {result ? (
            <div className="review-result">
              <div className="review-verdict">
                <Pill lg tone={result.verdict}>{VERDICT_LABEL[result.verdict]}</Pill>
                <p>{result.summary}</p>
                <span className="vq-mono">{result.provider} · {(result.ms / 1000).toFixed(1)}s</span>
              </div>

              <ReviewIssueSummary observations={result.observations} />

              {result.judge ? <JudgePanel judge={result.judge} /> : null}

              <ol className="review-observations">
                {result.observations.map((item, position) => (
                  <li
                    key={item.id}
                    className={`review-obs ${focusId === item.id ? 'is-active' : ''} ${pinned === item.id ? 'is-pinned' : ''} sev-${item.severity}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={pinned === item.id}
                    title={pinned === item.id ? '再点一次（或按 Esc）取消定位' : '点一下钉住图上对应区域'}
                    onClick={() => togglePin(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        togglePin(item.id)
                      }
                    }}
                    onMouseEnter={() => setActive(item.id)}
                    onFocus={() => setActive(item.id)}
                  >
                    <div className="review-obs-head">
                      <span className={`review-obs-no${markedIds.has(item.id) ? ' has-anchor' : ''}`}>{anchorNumber(position + 1)}</span>
                      <span className="vq-mono">{item.dimension}</span>
                      <Tag tone={ISSUE_TONE[item.severity] || 'plain'}>{ISSUE_LABEL[item.severity]}</Tag>
                      {item.evidence ? (
                        <>
                          <span className="vq-mono" title="模型对这条判断的置信度">置信 {Math.round(item.confidence * 100)}%</span>
                          <span
                            className="vq-mono review-obs-area"
                            title={'框住的区域约占画面 ' + evidenceAreaLabel(item.evidence) + '；框越小越能指到具体位置'}
                          >
                            面积 {evidenceAreaLabel(item.evidence)}
                          </span>
                        </>
                      ) : (
                        <span className="vq-mono">无锚点</span>
                      )}
                    </div>
                    <p>{item.statement}</p>
                  </li>
                ))}
              </ol>

              {result.fixes.length ? (
                <div className="review-fixes">
                  <h3>有界修正建议</h3>
                  <ul>
                    {result.fixes.map((item) => (
                      <li key={item.title}>
                        <strong>{item.title}</strong>
                        <span>{item.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {result.notAssessable.length ? (
                <div className="review-gaps">
                  <h3>无法判断</h3>
                  <ul>
                    {result.notAssessable.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
              ) : null}

              <p className="review-note">{result.note}</p>
            </div>
          ) : null}
        </section>
      </div>

      {historyOpen ? (
        <ReviewHistoryModal
          currentId={openedId || undefined}
          onClose={() => setHistoryOpen(false)}
          onOpenReview={(id) => (onOpenReview ? onOpenReview(id) : void loadRecord(id))}
        />
      ) : null}
    </div>
  )
}
