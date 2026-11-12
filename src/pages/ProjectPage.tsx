import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronDown, Clapperboard, CopyPlus, Download, FileText, Link2, Package, Pencil, Plus, Printer, RefreshCw, RotateCcw, ScanEye, Share2, Trash2, Workflow, X } from 'lucide-react'
import PageHead from '../components/PageHead'
import ProjectStatusPill from '../components/ProjectStatus'
import {
  deleteProject,
  deliverablePrintUrl,
  disableProjectShare,
  downloadProjectDeliverable,
  downloadProjectDeliverableZip,
  enableProjectShare,
  getProject,
  openProjectCanvas,
  resetProjectScript,
  reviewSheetUrl,
  saveProjectScript,
  setSheetUrl,
  startProjectVersion,
  updateProject,
} from '../api/projects'
import { describeTiming, type ScriptBeat } from '../domain/radar'
import { deliveredCurrent, deliveryOf, projectStep, reviewsForVersion, runsForVersion, type ProjectDetail } from '../domain/project'
import { ackReview, decideReview, clearReviewDecision, unackReview } from '../api/review'
import { REVIEW_VERDICT_LABEL as VERDICT_LABEL, reviewTimeLabel, reviewsOfVersion } from '../domain/review'
import { stampTime as stamp, visitLine } from '../domain/share'
import '../styles/projects.css'

// 保存脚本之后画布那边发生了什么：直接说人话，不把 reason 漏到界面上
const SCRIPT_CANVAS_NOTE: Record<string, string> = {
  synced: '画布里的复刻提示词也换成新脚本了',
  'no-canvas': '还没开画布，开画布时会用这条脚本生成提示词',
  'canvas-missing': '这条作品绑的画布不在了，脚本已经存下',
  'hand-edited': '画布里的提示词是手改过的，没有覆盖',
  'save-failed': '画布提示词这次没写进去，稍后再存一次脚本',
  'no-script': '',
}

const KIND_LABEL: Record<string, string> = { replica: '原片拆解', adapted: '改编版', flow: '工作流', saved: '待解析' }

const pad2 = (value: number) => String(value).padStart(2, '0')

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

/**
 * 作品页：一条内容的完整现场。
 * 首屏只回答「下一步点哪里」（用脚本开画布 → 送评审 → 继续改 → 交付），
 * 然后是版本对照，下面才是现场：脚本、分镜、画布、评审。
 * 脚本默认跟随模板，在页内改过就复制成作品自己的版本（copy-on-write）；版本只存画布指针。
 */
export default function ProjectPage({
  projectId,
  onBack,
  onOpenFlow,
  onOpenReview,
  onOpenReviewRecord,
  onBrowseTemplates,
  onToast,
}: {
  projectId: string
  onBack: () => void
  onOpenFlow: (flowId: string) => void
  onOpenReview: (projectId: string) => void
  /** 打开某一条评审的记录页：那里有当时的证据原图与问题锚点 */
  onOpenReviewRecord: (reviewId: string) => void
  onBrowseTemplates: () => void
  onToast: (message: string) => void
}) {
  const [data, setData] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'' | 'canvas' | 'done' | 'delete' | 'title' | 'version' | 'script' | 'export' | 'zip'>('')
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  // 脚本就地编辑：草稿只在内存里，保存后才写进作品（copy-on-write）
  const [scriptEditing, setScriptEditing] = useState(false)
  const [scriptDraft, setScriptDraft] = useState<{ hook: string; structure: ScriptBeat[] } | null>(null)
  // 只读分享：链接在这个作品上，弹窗里开、停、复制；token 只从作品详情拿
  const [shareOpen, setShareOpen] = useState(false)
  const [shareBusy, setShareBusy] = useState<'' | 'enable' | 'disable' | 'copy'>('')
  const [shareCopied, setShareCopied] = useState(false)
  // 交付菜单：五种产物（交付稿 / 打印稿 / 现场页 / 评审对照 / 交付包）收在一个入口里，
  // 页头就不会排到七个按钮；点空白处或 Esc 收起（和账号菜单同一套习惯）
  const [deliverOpen, setDeliverOpen] = useState(false)
  const deliverRef = useRef<HTMLDivElement | null>(null)
  // 人工复核：一句话备注，加上正在提交的那一档（拍通过 / 拍不通过 / 撤销）
  // null 表示「跟着这条拍板的备注走」：改判或撤销后不用手动清空，渲染时现算
  const [decisionNote, setDecisionNote] = useState<string | null>(null)
  const [decideBusy, setDecideBusy] = useState<'' | 'pass' | 'reject' | 'undo' | 'clear'>('')
  // 「清空拍板记录」要点两下：第一下只是把按钮换成「再点一次」，5 秒没有第二下就缩回去
  const [clearLogArmed, setClearLogArmed] = useState(false)
  // 「已看过」也在作品页原地做：人点进来看了，就不该再回工作台点一下
  const [ackBusy, setAckBusy] = useState<'' | 'ack' | 'undo'>('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await getProject(projectId))
    } catch (caught) {
      setData(null)
      setError(caught instanceof Error ? caught.message : '作品读取失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])


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

  // 作品第一次开画布就是这里：服务端用这条作品**现在的脚本**生成输入 + 复刻两个节点，
  // 建完立刻绑上作品（v1），再打开画布。脚本改过也不怕：画布拿到的就是新词。
  const openCanvas = useCallback(async () => {
    if (!data) return
    if (data.project.flowId) {
      onOpenFlow(data.project.flowId)
      return
    }
    setBusy('canvas')
    try {
      const result = await openProjectCanvas(data.project.id)
      onToast((result.created ? '已按这条脚本生成画布：' : '画布已就绪：') + result.flow.name)
      onOpenFlow(result.flow.id)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '开画布失败')
    } finally {
      setBusy('')
    }
  }, [data, onOpenFlow, onToast])

  // 只读分享：开 / 停 / 复制。链接是这条作品的地址，不是账号的，所以停止只影响这一条。
  const shareLink = data?.share ? window.location.origin + '/#/share/project/' + data.share.token : ''

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
      setData({ ...data, share: { token: result.token, createdAt: result.createdAt } })
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

  // 标记交付会记下「哪一版、什么时候」（服务端落一条交付记录）；重新打开只改状态，记录留着
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
          ? '已标记交付：v' + (delivery?.version ?? result.project.version) + (delivery?.at ? ' · ' + stamp(delivery.at) : '')
          : '已重新打开：这一版的交付记录也撤掉了',
      )
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '状态没保存成功')
    } finally {
      setBusy('')
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
    if (!window.confirm('删除这条作品？画布与评审不会被删掉，只解除关联。')) return
    setBusy('delete')
    try {
      await deleteProject(data.project.id)
      onToast('已删除作品，画布与评审仍在')
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

  // 开新版＝复制当前画布；旧画布归档成 vN，作品立刻指向新画布。
  const startVersion = async () => {
    if (!data) return
    setBusy('version')
    try {
      const result = await startProjectVersion(data.project.id)
      await load()
      onToast('已开 v' + result.project.version + '：画布从上一版复制过来，接着改这一版')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '开新版本失败')
    } finally {
      setBusy('')
    }
  }

  // 进入脚本编辑：用自己的版本，没有就把当前看到的（模板脚本）拷一份草稿出来，
  // 保存时才真正落库——不想改就取消，作品不会平白多一份副本。
  const beginScript = () => {
    const script = data?.script
    const structure: ScriptBeat[] = script?.structure?.length
      ? script.structure.map((beat) => ({ ...beat }))
      : [{ beat: '', startSec: 0, endSec: 0, voiceover: '', onScreen: '', purpose: '' }]
    setScriptDraft({ hook: script?.hook || '', structure })
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
    setScriptEditing(false)
    setScriptDraft(null)
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
      setScriptEditing(false)
      setScriptDraft(null)
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
      onToast(result.script ? '已恢复成模板的脚本，画布提示词也跟着回去了' : '已清掉作品自己的脚本')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '恢复失败')
    } finally {
      setBusy('')
    }
  }

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
  // 脚本是作品页自己的视图：改过就是这条作品自己的版本，没改过则跟随模板
  const script = data.script
  // 状态与「下一步」只看当前这一版评过没有：新版刚开出来时不能因为上一版评过就跳过评审
  const currentReviews = reviewsForVersion(data.versionCounts, project.version)
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
  const deliveredVersions = new Map<number, string>(
    (Array.isArray(project.deliveries) ? project.deliveries : []).map((entry) => [entry.version, entry.at]),
  )
  // 老记录没有交付条目：状态是已交付就当当前这一版交过，只是时间没记录
  if (delivered && !delivery && project.version) deliveredVersions.set(project.version, '')
  const versionRows = [
    {
      n: project.version,
      flowId: project.flowId,
      // 当前版用作品名：画布名是建版本那一刻的标题，改名后拿它当行标题会显得对不上
      name: project.title,
      archivedAt: '',
      available: Boolean(flow),
      nodes: flow ? flow.nodes : 0,
      scriptBeats,
      current: true,
    },
    ...data.versions.map((item) => ({ ...item, current: false })),
  ].sort((a, b) => b.n - a.n)

  return (
    <div className="page vq-page vq-project-page">
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
                title="交付这一版：Markdown 全文、A4 打印稿、现场页、评审对照、交付包"
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
                    <p className="vq-export-note">
                      导出不会改状态：交出去之后点页头「标记交付」，会记下这一版与交付时间；开新版也查得到。
                    </p>
                  )}
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
                      <small>.zip：交付稿 + 现场页 + 评审对照 + 帧图，解压就能看</small>
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
            <button type="button" className="vq-button vq-button--ghost is-danger" onClick={() => void remove()} disabled={busy === 'delete'}>
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
            {busy === 'canvas' ? '正在生成画布…' : !project.flowId && !script ? '先写一条脚本' : step.cta}
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
              开新版时会把这一版的脚本存一份快照，再改只影响新版；旧版本的画布还能打开看，但改它不会写回那一版。
            </p>
            <button
              type="button"
              className="vq-button vq-button--ghost"
              onClick={() => void startVersion()}
              disabled={busy === 'version'}
            >
              <CopyPlus size={14} />
              {busy === 'version' ? '正在复制画布…' : '开一版新的'}
            </button>
          </div>
          <ol className="vq-version-list">
            {versionRows.map((row) => {
              const counter = reviewsForVersion(data.versionCounts, row.n)
              const runCount = runsForVersion(data.runCounts || {}, row.n)
              // 这一版的评审逐条列出来：点一条直接看当时的证据原图，别只留一个「2 次评审」
              const rowReviews = reviewsOfVersion(reviews, row.n)
              return (
                <li className={'vq-version-row' + (row.current ? ' is-current' : '')} key={row.n}>
                  <span className="vq-version-n vq-mono">v{row.n}</span>
                  <div className="vq-version-main">
                    <strong>{row.name}</strong>
                    <span className="vq-version-meta">
                      <span className="vq-mono">{row.current ? '最新' : '归档 ' + stamp(row.archivedAt)}</span>
                      <span>{row.nodes} 节点</span>
                      {/* 没存快照的旧版本写清楚：不能让人以为「那一版就是现在的脚本」 */}
                      <span>{row.scriptBeats ? row.scriptBeats + ' 段脚本' : row.current ? '没写脚本' : '脚本没存快照'}</span>
                      <span>{counter.count ? counter.count + ' 次评审' : '未评审'}</span>
                      <span>{runCount ? runCount + ' 次运行' : '没跑过'}</span>
                      {deliveredVersions.has(row.n) ? (
                        <span
                          className="vq-version-delivered"
                          title="这一版交出去过；重新打开这一版会收回这条记录，开新版会把它留在上一版"
                        >
                          交付过
                          {deliveredVersions.get(row.n) ? ' · ' + stamp(deliveredVersions.get(row.n) as string) : ' · 时间没记录'}
                        </span>
                      ) : null}
                    </span>
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
                  <button
                    type="button"
                    className="vq-button vq-button--ghost vq-version-open"
                    onClick={() => onOpenFlow(row.flowId)}
                    disabled={!row.available}
                    title={row.available ? '在画布里打开 v' + row.n : '这一版的画布已被删除'}
                  >
                    {row.available ? '打开画布' : '画布已删除'}
                    {row.available ? <ArrowRight size={13} /> : null}
                  </button>
                </li>
              )
            })}
          </ol>
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
              一个作品的运行跨版本归集：旧版画布跑过的记录还在，开新版不会把它们藏起来。
            </p>
          </div>
          {data.runs.length ? (
            <ol className="vq-run-list">
              {data.runs.map((run) => {
                const ok = run.status === 'success'
                return (
                  <li className="vq-run-row" key={run.id}>
                    <span className={'vq-run-dot is-' + (ok ? 'pass' : 'fail')} aria-hidden="true" />
                    <div className="vq-run-main">
                      <span className="vq-run-title">
                        <strong className="vq-mono">{run.id}</strong>
                        <span className="vq-version-n vq-mono vq-run-version">v{run.version}</span>
                        <span className={'vq-run-status is-' + (ok ? 'pass' : 'fail')}>{ok ? '成功' : '失败'}</span>
                      </span>
                      <span className="vq-run-meta">
                        <span>{run.total} 节点{run.failed ? ' · ' + run.failed + ' 个失败' : ''}</span>
                        <span>{duration(run.durationMs)}</span>
                        <span>
                          {run.credits && run.credits.cost
                            ? run.credits.cost + ' 积分' + (run.credits.refunded ? '（已退）' : '')
                            : '不计费'}
                        </span>
                        <span className="vq-mono">{stamp(run.startedAt)}</span>
                      </span>
                      {run.error ? <p className="vq-run-error">{run.error}</p> : null}
                    </div>
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-run-open"
                      onClick={() => onOpenFlow(run.flowId)}
                      disabled={!run.available}
                      title={run.available ? '打开 v' + run.version + ' 的画布' : '这次运行的画布已被删除，记录仍留着'}
                    >
                      {run.available ? '打开画布' : '画布已删除'}
                      {run.available ? <ArrowRight size={13} /> : null}
                    </button>
                  </li>
                )
              })}
            </ol>
          ) : (
            <div className="vq-project-empty">
              <strong>这条作品还没跑过画布</strong>
              <span>打开画布点一次运行：每个节点的耗时、输出与失败原因都会记在这里，并按版本归集。</span>
              <button type="button" className="vq-button vq-button--ghost" onClick={() => void openCanvas()}>
                <Clapperboard size={13} />
                打开画布去运行
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
                    保存后按口播重估「要念几秒」；画布里自动生成的复刻提示词会一起换成新脚本，模板不动。
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
                    : '绑定的模板已删除或不在当前账号下；脚本可以直接在这里写，开画布时用它生成复刻提示词。'}
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
              <span className="vq-mono">{template ? template.shots + ' 镜' : '没有分镜'}</span>
            </div>
            {template && template.storyboard.length ? (
              <ol className="vq-shot-list">
                {template.storyboard.map((shot, index) => (
                  <li key={index} className="vq-shot-row">
                    <span className="vq-mono vq-shot-index">{pad2(shot.shotNo ?? index + 1)}</span>
                    <div className="vq-shot-copy">
                      <span className="vq-shot-head">
                        {shot.camera || '机位待定'}
                        <span className="vq-mono">{(shot.startSec ?? 0) + '–' + (shot.endSec ?? 0) + ' 秒'}</span>
                      </span>
                      <p>{shot.visual || '（画面待补）'}</p>
                      {shot.caption ? <span className="vq-shot-caption">字幕 · {shot.caption}</span> : null}
                    </div>
                  </li>
                ))}
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
              <h2>画布</h2>
              <Workflow size={14} />
            </div>
            {flow ? (
              <>
                <strong className="vq-project-flow-name">{flow.name}</strong>
                <p className="vq-project-flow-meta vq-mono">
                  {flow.nodes} 个节点 · 更新 {stamp(flow.updatedAt)}
                </p>
                <button type="button" className="vq-button vq-button--primary vq-project-full" onClick={() => void openCanvas()}>
                  打开画布
                  <ArrowRight size={13} />
                </button>
              </>
            ) : (
              <div className="vq-project-empty">
                <strong>还没开画布</strong>
                <span>
                  {data.script
                    ? '用这条作品现在的脚本生成一张画布草稿：输入节点带钩子，复刻节点带完整提示词。'
                    : '先在左边写一条脚本（或从模板库套一条），再来开画布。'}
                </span>
                <button
                  type="button"
                  className="vq-button vq-button--ghost"
                  onClick={() => void openCanvas()}
                  disabled={busy === 'canvas' || !data.script}
                >
                  <Clapperboard size={13} />
                  {busy === 'canvas' ? '生成中…' : '开画布'}
                </button>
              </div>
            )}
          </section>

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
                            className="vq-button vq-button--ghost is-danger"
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
              <dl className="vq-project-source">
                <div>
                  <dt>模板</dt>
                  <dd>{template.title}</dd>
                </div>
                <div>
                  <dt>内容类型</dt>
                  <dd>{template.contentType || '—'}</dd>
                </div>
                <div>
                  <dt>原片时长</dt>
                  <dd className="vq-mono">{seconds(template.durationSec)}</dd>
                </div>
                <div>
                  <dt>复用</dt>
                  <dd className="vq-mono">{template.reuseCount} 次</dd>
                </div>
              </dl>
            ) : (
              <p className="vq-project-note">绑定的模板已被删除或不在当前账号下；作品本身还在，画布与评审不受影响。</p>
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
              <button type="button" className="vq-icon-button" aria-label="关闭分享" onClick={() => setShareOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <p className="vq-share-copy">
              拿到链接的人不用登录就能看：开头钩子、脚本分段与口播时长、分镜、评审与运行的次数，
              还有一张评审对照纸（评审说的问题框在当时的画面上，可打印或存 PDF）。
              看不到账号、积分与画布内容。
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
                    className="vq-button vq-button--ghost is-danger"
                    onClick={() => void stopShare()}
                    disabled={shareBusy === 'disable'}
                  >
                    {shareBusy === 'disable' ? '正在停止…' : '停止分享'}
                  </button>
                </div>
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
    </div>
  )
}
