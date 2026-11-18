import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Clapperboard,
  Image as ImageIcon,
  Clock,
  Copy,
  Download,
  FolderOpen,
  History,
  Layers,
  LayoutTemplate,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  OUTPUT_TYPES,
  chatWithAgent,
  clearAgentHistory,
  deleteAgent,
  formatClock,
  formatRelative,
  clearPendingAgentProject,
  clearPendingSelectAgent,
  listAgentHistory,
  listAgents,
  peekPendingAgentProject,
  peekPendingSelectAgent,
  saveAgentDraftAsTemplate,
  sendAgentDraftToCanvas,
  writeAgentDraftToProject,
} from '../api/agents'
import type { AgentArtifact, AgentDraft, AgentRecord, AgentRunRecord, AgentsList, AgentToolsResult, OutputType } from '../api/agents'
import {
  generateMediaImage,
  generateMediaVideo,
  getMediaTask,
  listMediaAssets,
  listMediaModels,
  listMediaTasks,
  uploadMediaAsset,
} from '../api/media-gen'
import { RECENT_PAGE_SIZE, mergeRecentTasks } from '../domain/media-recent'
import { probeMediaFile } from '../domain/media-file'
import { peekRefHandoff, takeRefHandoff } from '../domain/media-handoff'
import type { RefHandoff } from '../domain/media-handoff'
import { planRefAttach, refAttachNote, refFileName } from '../domain/media-refs'
import type { RefKind } from '../domain/media-refs'
import type { MediaAsset, MediaKind, MediaModel, MediaModelList, MediaTask } from '../api/media-gen'
import { getCredits, getModelService, recheckModelService, type CreditsResponse, type ModelServiceState } from '../api/credits'
import { getProject, listProjects } from '../api/projects'
import type { ProjectSummary } from '../domain/project'
import { getPreferences } from '../api/preferences'
import { useUiMode } from '../api/app'
import PageHead from '../components/PageHead'
import QuickChat from '../components/QuickChat'
import { useModelOptions } from '../components/ModelSwitch'
import { Tag } from '../components/ui'
import { renderMarkdown } from '../lib/markdown'
import '../styles/agents.css'

// 创作方式：一个输入框，三种去向。对话交给对话预设，图片 / 视频走服务端生成通道。
const COMPOSER_MODES: { id: 'chat' | MediaKind; label: string }[] = [
  { id: 'chat', label: '对话' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
]

type ChatMessage = {
  id: string
  role: 'user' | 'agent'
  content: string
  model?: string
  latencyMs?: number
  tools?: AgentToolsResult
  // 结构化草稿：有它才显示三个出口（存为模板 / 送到工作流 / 写进作品）
  draft?: AgentDraft | null
  at: number
}

// 每个出口的状态按消息 id 记：同一条回复存过模板之后，按钮变成「已存为模板 + 打开」，
// 下次刷新（本地历史）也还是这个状态，不需要再点一次。
type DraftAction = {
  busy: '' | 'template' | 'canvas' | 'project'
  error: string
  template?: { id: string; title: string }
  flow?: { id: string; name: string }
  /** 已经写进这条作品：标题 / 版次 / 段数与工作流那边发生了什么 */
  project?: { id: string; title: string; version: number; beats: number; canvas: { synced: boolean; reason: string } }
  /** 「写进作品」展开后的选作品面板：选哪一条、这条现在的脚本是什么 */
  picker?: {
    open: boolean
    id: string
    loading: boolean
    error: string
    detail: null | { title: string; version: number; beats: number; source: '' | 'project' | 'template' }
  }
}

// 作品页「让 AI 起草」带过来的上下文：标题、版次与这一版现在的脚本（标题与段数）。
// 只用来写一句「在帮哪条作品」和预填输入框，不往对话里塞任何作品内部数据。
type AgentProjectContext = {
  id: string
  title: string
  version: number
  beats: number
  source: '' | 'project' | 'template'
  hook: string
}

const versionLabel = (version: number) => (version > 0 ? '第 ' + version + ' 版' : '还没开工作流')

function projectPrompt(context: AgentProjectContext) {
  const lines = ['帮我改《' + context.title + '》这一版（' + versionLabel(context.version) + '）的脚本。']
  lines.push(
    context.beats
      ? '现在这一版有 ' + context.beats + ' 段' + (context.hook ? '，开头钩子是「' + context.hook + '」' : '') + '。'
      : '这一版还没有脚本。',
  )
  lines.push('保留段落结构，重写钩子和每段口播，控制在 6 段以内。')
  return lines.join('\n')
}

type HistoryEntry = {
  id: string
  agentId: string
  agentName: string
  title: string
  at: string
  messages: ChatMessage[]
}

type Failure = { message: string; suggestion: string; detail: string; prompt: string }

const HISTORY_KEY = 'vq:agents:history:v1'
const RUN_PAGE = 10

function downloadArtifact(artifact: AgentArtifact) {
  const blob = new Blob([artifact.content], { type: artifact.type || 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = artifact.name || 'agent-output.json'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

const nextId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)

function readHistory(): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return (parsed as HistoryEntry[])
      .filter((item) => item && typeof item.id === 'string' && Array.isArray(item.messages))
      .slice(0, 12)
  } catch {
    return []
  }
}

function writeHistory(entries: HistoryEntry[]) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 12)))
  } catch {
    // 本地历史只是便利功能，写不进去不影响对话
  }
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    // 退化到旧接口，仍然是用户点击触发的复制
  }
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

function Capsule({
  label,
  value,
  options,
  onChange,
  disabled,
  title,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const current = options.find((option) => option.value === value) ?? options[0]

  // 参数胶囊用自绘下拉：系统 select 的弹出层会盖住输入框底部，也没法和整页的发丝线风格对齐。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="agx-capsule" title={title} ref={boxRef}>
      <span>{label}</span>
      <button
        type="button"
        className="agx-capsule-trigger"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <em>{current?.label ?? '未选择'}</em>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="agx-capsule-menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? 'is-active' : ''}
              key={option.value || option.label}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// 切到某个对话预设时，输出类型跟着它的主场景走；用户仍可在参数行手动改。
const OUTPUT_TYPE_BY_CATEGORY: Record<string, OutputType> = {
  内容复刻: '脚本',
  视觉评审: '评审',
  脚本分镜: '分镜',
  投放素材: '文案',
}

const DEFAULT_OUTPUT_TYPE: OutputType = '脚本'

// 结构化草稿卡：回复下面的一条「可以继续用的东西」。
// 两个出口都在这里，不跳页：存完模板、建完工作流之后原件还在，链接点了再走。
// 结构化草稿卡：回复下面的一条「可以继续用的东西」。
// 三个出口都在这里，不跳页：存完模板、建完工作流、写进作品之后原件还在，链接点了再走。
function DraftCard({
  draft,
  action,
  works,
  worksLoading,
  worksError,
  onSaveTemplate,
  onSendCanvas,
  onOpenTemplates,
  onOpenCanvas,
  onOpenPicker,
  onPick,
  onWriteProject,
  onCancelPicker,
  onOpenProject,
}: {
  draft: AgentDraft
  action: DraftAction
  works: ProjectSummary[] | null
  worksLoading: boolean
  worksError: string
  onSaveTemplate: () => void
  onSendCanvas: () => void
  onOpenTemplates: () => void
  onOpenCanvas: (flowId: string) => void
  onOpenPicker: () => void
  onPick: (projectId: string) => void
  onWriteProject: () => void
  onCancelPicker: () => void
  onOpenProject: (projectId: string) => void
}) {
  const busy = action.busy !== ''
  // 先取出再判空：闭包里用 action.flow.id 会把「已经判过」的窄化丢掉
  const savedTemplate = action.template
  const savedFlow = action.flow
  const savedProject = action.project
  const picker = action.picker
  const picked = picker?.detail ?? null
  // 写进去的是脚本：草稿里没有段落（只有分镜）就没有这个出口，也不留一个点了会报错的按钮
  const canWrite = Boolean(picker?.open && picker.id && picked && !picker.loading && !busy)
  // 覆盖前先把「现在是什么」摆出来：这条作品有没有自己的脚本、段数是多少、换掉之后模板不动
  const note = (() => {
    if (!picker?.open) return ''
    if (worksError) return '作品列表没读到：' + worksError
    if (worksLoading) return '正在读作品列表…'
    if (!works || !works.length) return '还没有作品：先去作品页建一条，草稿就能写进去'
    if (picker.loading) return '正在读这条作品现在的脚本…'
    if (picker.error) return picker.error
    if (!picked) return '选一条作品：写进去的是这一版的脚本（钩子 + ' + draft.stats.beats + ' 段），分镜不跟着走'
    const source = picked.source === 'template' ? '来自模板' : picked.source === 'project' ? '这条作品的版本' : ''
    const now = picked.beats ? '脚本 ' + picked.beats + ' 段' + (source ? '（' + source + '）' : '') : '还没有脚本'
    const after = picked.beats
      ? '换成这份草稿的 ' + draft.stats.beats + ' 段；模板与别的作品不动'
      : '写这份草稿的 ' + draft.stats.beats + ' 段（钩子 + 段落）；之后它有自己的脚本，模板再改不影响这条'
    return '现在：《' + picked.title + '》· ' + versionLabel(picked.version) + ' · ' + now + ' → ' + after
  })()
  return (
    <div className="agx-draft" role="group" aria-label="结构化草稿">
      <div className="agx-draft-head">
        <span className="agx-draft-kicker">结构化草稿</span>
        <strong>{draft.title}</strong>
      </div>
      <div className="agx-draft-stats">
        {draft.stats.beats > 0 ? <span>{draft.stats.beats} 段脚本</span> : null}
        {draft.stats.shots > 0 ? <span>{draft.stats.shots} 个分镜</span> : null}
        {draft.stats.voiceoverSec > 0 ? <span>口播约 {draft.stats.voiceoverSec} 秒</span> : null}
      </div>
      {action.error ? (
        <p className="agx-draft-error" role="alert">
          {action.error}
        </p>
      ) : null}
      <div className="agx-draft-actions">
        {savedTemplate ? (
          <span className="agx-draft-done">
            <Check size={12} />
            已存为模板 · {savedTemplate.title}
            <button type="button" onClick={onOpenTemplates}>
              打开模板库
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="vq-button vq-button--primary"
            onClick={onSaveTemplate}
            disabled={busy}
            title="存成一条可套用的脚本模板，模板库和作品页都能用"
          >
            <LayoutTemplate size={13} />
            {action.busy === 'template' ? '保存中' : '存为模板'}
          </button>
        )}
        {savedFlow ? (
          <span className="agx-draft-done">
            <Check size={12} />
            已送到工作流 · {savedFlow.name}
            <button type="button" onClick={() => onOpenCanvas(savedFlow.id)}>
              打开工作流
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="vq-button vq-button--ghost"
            onClick={onSendCanvas}
            disabled={busy}
            title="开一张新工作流：脚本进了复刻提示词，可以接着改、接着跑"
          >
            <Layers size={13} />
            {action.busy === 'canvas' ? '创建中' : '送到工作流'}
          </button>
        )}
        {savedProject ? (
          <span className="agx-draft-done">
            <Check size={12} />
            已写进《{savedProject.title}》· {versionLabel(savedProject.version)} · {savedProject.beats} 段
            <button type="button" onClick={() => onOpenProject(savedProject.id)}>
              打开作品
            </button>
            {savedProject.canvas.synced ? (
              <em className="agx-draft-fact">工作流里的复刻提示词就是这份脚本</em>
            ) : savedProject.canvas.reason === 'hand-edited' ? (
              <em className="agx-draft-fact">工作流提示词你手改过，没动</em>
            ) : null}
          </span>
        ) : draft.stats.beats > 0 ? (
          <button
            type="button"
            className="vq-button vq-button--ghost"
            onClick={onOpenPicker}
            disabled={busy || Boolean(picker?.open)}
            title="把这份草稿写进一条作品这一版的脚本；写进去之后模板与别的作品不动"
          >
            <Clapperboard size={13} />
            {action.busy === 'project' ? '写入中' : '写进作品'}
          </button>
        ) : (
          <span className="agx-draft-note">只有分镜的草稿写不进作品：作品脚本只认段落，要镜头就送到工作流</span>
        )}
      </div>
      {picker?.open && !savedProject ? (
        <div className="agx-draft-pick">
          <label className="agx-draft-pick-row">
            <span className="agx-draft-pick-label">写进作品</span>
            <select
              className="agx-draft-select"
              value={picker.id}
              onChange={(event) => onPick(event.target.value)}
              disabled={busy || worksLoading || !(works && works.length)}
            >
              <option value="">{worksLoading ? '读作品列表…' : '选一条作品'}</option>
              {/* 下拉只放标题：版次与「这一版现在是什么」写在下面那行注释里，
                  窄屏上标题本来就会截断，再塞版次只会剩下一个挂着的「·」 */}
              {(works || []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <p className="agx-draft-pick-note">{note}</p>
          <div className="agx-draft-pick-actions">
            <button type="button" className="vq-button vq-button--primary" onClick={onWriteProject} disabled={!canWrite}>
              {action.busy === 'project' ? '写入中' : picked?.beats ? '覆盖这一版脚本' : '写进这一版'}
            </button>
            <button type="button" className="vq-button vq-button--ghost" onClick={onCancelPicker} disabled={busy}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

// 最近生成那一行要能用一句话说清「多大、什么比例、几秒」，否则清单只是堆任务号
function describeTask(task: MediaTask) {
  const parts: string[] = []
  if (task.ratio) parts.push(task.ratio)
  if (task.kind === 'video') {
    if (task.duration) parts.push(task.duration + 's')
    if (task.resolution) parts.push(task.resolution)
  }
  if (task.assets?.length) parts.push('参考 ' + task.assets.length)
  if (task.status === 'succeeded' && task.file?.bytes) parts.push(formatBytes(task.file.bytes))
  return parts.join(' · ') || (task.kind === 'image' ? '图片' : '视频')
}

// 清单里的时间要能一眼分辨「哪一条是上午那条」，同一提示词跑过几次时尤其要靠它
function shortTimeOf(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

// 一行里要说清「什么时候、多大、什么比例」
function recentMetaOf(task: MediaTask) {
  return [shortTimeOf(task.createdAt), describeTask(task)].filter(Boolean).join(' · ')
}

function clockOf(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}

// （比例 / 时长 / 清晰度的选项不再写死在这里：全部由 /api/media/models 按模型下发）

// ---------- 快捷创作：图片 / 视频生成表单 ----------
//
// 与晨羽智云原型对齐的四件事（用户 2026-11-18 要求）：
//  1) 参考图 / 参考视频能上传；视频要能读出「几秒、多大」，不能只给一个文件名；
//  2) 模型能选、能切；换模型后比例 / 时长 / 清晰度按新模型的规格重画，不留上一档的残留；
//  3) 图片与视频各自保留提示词和参数：两个面板都挂着、只把非当前的隐藏掉，切回来文字还在；
//  4) 提示词始终可改 —— 这是表单，不是一次性弹窗。

const MEDIA_MAX_PROMPT = 1200

function formatDuration(seconds: number | null | undefined) {
  if (!seconds || !Number.isFinite(seconds)) return ''
  return (Math.round(seconds * 10) / 10).toFixed(1) + 's'
}

// 一张参考素材下面那行小字：视频要说清「几秒、多大」，图片说明大小，别的都是废话。
// 数字和单位之间用不换行空格粘住：390 宽这一行会被挤成两行，别让「KB」单独掉到下一行。
function describeRef(asset: MediaAsset) {
  const parts: string[] = []
  const duration = formatDuration(asset.duration)
  if (duration) parts.push(duration.replace(' ', '\u00a0'))
  if (asset.width && asset.height) parts.push(asset.width + '×' + asset.height)
  parts.push(formatBytes(asset.bytes).replace(' ', '\u00a0'))
  return parts.join(' · ')
}

type MediaSelection = { model: string; mode: string; ratio: string; duration: number; resolution: string }

function MediaComposer({
  kind,
  catalog,
  defaultModel,
  onCreditsChanged,
  onToast,
  handoff,
  onHandoffDone,
}: {
  kind: MediaKind
  catalog: MediaModel[]
  defaultModel: string
  onCreditsChanged: () => void
  onToast?: (message: string) => void
  /** 从作品流带过来的素材号：素材清单回来后挂进托架（r229） */
  handoff?: RefHandoff | null
  onHandoffDone?: () => void
}) {
  const image = kind === 'image'
  const [selected, setSelected] = useState<MediaSelection>({ model: '', mode: '', ratio: '', duration: 0, resolution: '' })
  const [prompt, setPrompt] = useState('')
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [library, setLibrary] = useState<MediaAsset[]>([])
  // 素材清单回来过没有：作品流带过来的素材要等它回来才挂得上，挂不上也要有个结论
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  // 哪一条结果正在被「用作参考」：同一条按钮变「加入中…」，别让人点两遍传两份
  const [refBusyId, setRefBusyId] = useState('')
  const [refError, setRefError] = useState('')
  const [task, setTask] = useState<MediaTask | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [recent, setRecent] = useState<MediaTask[]>([])
  const [recentError, setRecentError] = useState('')
  const [recentToken, setRecentToken] = useState(0)
  const [recentHasMore, setRecentHasMore] = useState(false)
  const [recentCapped, setRecentCapped] = useState(false)
  const [recentLoading, setRecentLoading] = useState(false)
  // 翻过页没有：决定这次刷新是整页替换，还是只补新出现的那几条
  const recentPagedRef = useRef(false)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 选中的东西都做「按当前模型规格兜底」：换模型后旧比例 / 旧时长不合法，渲染时自动落到新模型的默认值，
  // 不用在 effect 里回头改 state（那样容易写出渲染与状态打架的循环）。
  const fallbackModel = catalog.find((item) => item.id === defaultModel) ?? catalog[0]
  const model = catalog.find((item) => item.id === selected.model) ?? fallbackModel
  const mode = model?.modes.find((item) => item.id === selected.mode) ?? model?.modes[0] ?? null
  // 默认比例取模型表的第一个（图片 1:1、视频 9:16），与这轮之前的默认值一致：
  // 换模型时只落在新模型的合法值上，不替用户偷偷改成另一个方向。
  const ratio = model && model.ratios.includes(selected.ratio) ? selected.ratio : (model?.ratios[0] ?? '')
  const duration = model && model.durations.includes(selected.duration) ? selected.duration : (model?.durations[0] ?? 4)
  const resolution =
    model && model.resolutions.includes(selected.resolution)
      ? selected.resolution
      : (model?.resolutions[0] ?? '720p')
  const maxRefs = mode?.maxRefs ?? 0
  const minRefs = mode?.minRefs ?? 0

  // 「最近生成」：关掉窗口之后还能把上一次的文件找回来——任务号没人记得，光存在服务端等于找不到。
  useEffect(() => {
    let alive = true
    // 永远只取第一页：条数不跟翻页长大，也就不会被接口的 24 条上限截断
    listMediaTasks(kind, RECENT_PAGE_SIZE)
      .then((response) => {
        if (!alive) return
        const tasks = response.tasks || []
        // 翻过页就只合并、不替换：已经翻出来的更早行不能因为一次刷新就没了
        setRecent((items) => mergeRecentTasks(items, tasks, recentPagedRef.current))
        if (!recentPagedRef.current) {
          setRecentHasMore(Boolean(response.hasMore))
          setRecentCapped(Boolean(response.capped))
        }
        setRecentError('')
      })
      .catch((caught) => {
        if (!alive) return
        setRecentError(caught instanceof Error ? caught.message : '读取最近生成失败')
      })
    return () => {
      alive = false
    }
  }, [kind, recentToken])

  // 我传过的参考素材：换设备 / 刷新之后还能直接挑回来，不用重传
  useEffect(() => {
    let alive = true
    listMediaAssets(20)
      .then((response) => {
        if (!alive) return
        setLibrary(response.assets || [])
        setLibraryLoaded(true)
      })
      .catch(() => {
        // 清单读不到不影响上传；真正的错误在上传那一步会报出来
      })
    return () => {
      alive = false
    }
  }, [])

  // 清单里有任务在跑：每 5 秒重取一次清单（只读元数据，不打上游、不扣积分）。
  const recentRunning = recent.some((item) => item.status === 'processing')
  useEffect(() => {
    if (!recentRunning) return
    const timer = window.setInterval(() => setRecentToken((value) => value + 1), 5000)
    return () => window.clearInterval(timer)
  }, [recentRunning])

  // 「看更早的」：拿这一页最后一条的任务号当 cursor，只追加、不重排已经看到的
  const loadOlder = async () => {
    const last = recent[recent.length - 1]
    if (!last || recentLoading) return
    setRecentLoading(true)
    try {
      const response = await listMediaTasks(kind, RECENT_PAGE_SIZE, last.id)
      recentPagedRef.current = true
      setRecent((items) => {
        const seen = new Set(items.map((entry) => entry.id))
        return items.concat((response.tasks || []).filter((entry) => !seen.has(entry.id)))
      })
      setRecentHasMore(Boolean(response.hasMore))
      setRecentCapped(Boolean(response.capped))
      setRecentError('')
    } catch (caught) {
      setRecentError(caught instanceof Error ? caught.message : '读取更早的任务失败')
    } finally {
      setRecentLoading(false)
    }
  }

  const active = busy || task?.status === 'processing'
  const pollTaskId = task?.status === 'processing' ? task.id : ''

  useEffect(() => {
    let alive = true
    getCredits(1)
      .then((next) => {
        if (alive) setCredits(next)
      })
      .catch(() => {
        // 价格读不到时按模型表上的积分显示；真正扣费仍以服务端为准
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => promptRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!task || task.status !== 'processing') return
    const startedAt = new Date(task.createdAt).getTime()
    const update = () => setElapsed(Math.max(0, Date.now() - startedAt))
    const first = window.setTimeout(update, 0)
    const timer = window.setInterval(update, 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [task])

  useEffect(() => {
    if (!pollTaskId) return
    let alive = true
    let timer = 0
    const poll = async () => {
      try {
        const response = await getMediaTask(pollTaskId)
        if (!alive) return
        setTask(response.task)
        if (response.task.status !== 'processing') setRecentToken((value) => value + 1)
        setPollError(response.warning || '')
        if (response.task.status === 'processing') {
          timer = window.setTimeout(poll, 2500)
        }
      } catch (caught) {
        if (!alive) return
        setPollError('查询进度失败，正在重试：' + (caught instanceof Error ? caught.message : '网络错误'))
        timer = window.setTimeout(poll, 3500)
      }
    }
    timer = window.setTimeout(poll, 1200)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [pollTaskId])

  // 把一条已经落到服务端的素材挂进托架：换不换方式、放不放得下都按 domain/media-refs 的结论走。
  // 上传、从素材库挑、把生成结果当参考，三个入口共用这一段，规则不会各写一套。
  const attachAsset = (asset: MediaAsset): boolean => {
    const plan = planRefAttach({
      modes: model?.modes ?? [],
      current: mode,
      kind: asset.kind,
      count: assets.length,
      alreadyIn: assets.some((item) => item.id === asset.id),
    })
    if (!plan.ok) {
      setRefError(refAttachNote(plan))
      return false
    }
    if (plan.switched) setSelected((current) => ({ ...current, mode: plan.modeId }))
    setAssets((items) => items.concat(asset))
    setLibrary((items) => [asset, ...items.filter((item) => item.id !== asset.id)])
    setRefError('')
    onToast?.(refAttachNote(plan))
    return true
  }

  // 作品流里点「用作参考」跳过来的：素材在作品页已经传好了，这里只差挂上去。
  // 等素材清单回来才动手——挂的时候要先知道这个方式收不收、放不放得下。
  // 挂不上（比如这个方式已经放满、或者那条素材刚被删）也算用掉：原因留在 refError 里，
  // 不然每次进这一页都重试一遍。
  const handoffId = handoff ? handoff.assetId : ''
  const handoffRatio = handoff?.ratio ?? ''
  // 挂在哪个方式上要用当前的 model / assets，而这两个每次渲染都是新闭包：
  // 经 ref 取最新的那一份，effect 的依赖就只剩「素材清单回来没有、模型表回来没有」。
  const attachRef = useRef<(asset: MediaAsset) => boolean>(() => false)
  const handoffDoneRef = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    attachRef.current = attachAsset
    handoffDoneRef.current = onHandoffDone
  })
  useEffect(() => {
    // 模型表还没回来就先等：这时候判不出这个方式收不收，挂了也会判错
    if (!handoffId || !libraryLoaded || !model) return
    const asset = library.find((item) => item.id === handoffId)
    if (asset) {
      const attached = attachRef.current(asset)
      // 比例跟着作品走：带过来的是 9:16 的图，出图就别默认落回 1:1
      if (attached && handoffRatio && model.ratios.includes(handoffRatio)) {
        setSelected((current) => ({ ...current, ratio: handoffRatio }))
      }
    }
    // oxlint-disable-next-line react/set-state-in-effect
    else setRefError('带过来的那条素材没找到了，可能已经删掉：回「作品」再点一次「用作参考」')
    handoffDoneRef.current?.()
  }, [handoffId, handoffRatio, libraryLoaded, library, model])

  // 先判「放不放得下」再传：传完才发现这个方式不收、或者已经放满，等于让人白等一次上传
  const precheckRef = (kind: RefKind): boolean => {
    const plan = planRefAttach({
      modes: model?.modes ?? [],
      current: mode,
      kind,
      count: assets.length,
      alreadyIn: false,
    })
    if (plan.ok) return true
    setRefError(refAttachNote(plan))
    return false
  }

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!mode) return
    if (!precheckRef(file.type.startsWith('video/') ? 'video' : 'image')) return
    setUploading(true)
    try {
      const meta = await probeMediaFile(file)
      const response = await uploadMediaAsset({ file, ...meta })
      attachAsset(response.asset)
    } catch (caught) {
      setRefError(caught instanceof Error ? caught.message : '上传参考素材失败')
    } finally {
      setUploading(false)
    }
  }

  const toggleAsset = (asset: MediaAsset) => {
    if (assets.some((item) => item.id === asset.id)) {
      setRefError('')
      setAssets((items) => items.filter((item) => item.id !== asset.id))
      return
    }
    attachAsset(asset)
  }

  // 「最近生成」里的结果直接当参考：出一张图 → 拿它接着改 / 当首帧出视频，是复刻最常走的一步。
  // 以前这里只有下载，用户要自己把文件再传一遍才算「用上了刚生成的东西」。
  // 走的是同一条上传接口（取回字节 → 读真实宽高 / 时长 → 传），不新增接口、不扣积分。
  // 名字不能以 use 开头：那会被当成 Hook，只能在组件顶层调用
  const addTaskResultAsRef = async (item: MediaTask) => {
    if (refBusyId || item.status !== 'succeeded' || !item.downloadUrl) return
    const kind: RefKind = item.kind === 'video' ? 'video' : 'image'
    if (!precheckRef(kind)) return
    const name = refFileName(item, item.file?.mime ?? '')
    // 同一条结果点第二次时，素材库里已经有同名的那份了：直接用，不再传一份占配额
    const existing = library.find((asset) => asset.name === name && asset.kind === kind)
    if (existing) {
      attachAsset(existing)
      return
    }
    setRefBusyId(item.id)
    try {
      const response = await fetch(item.downloadUrl, { credentials: 'same-origin' })
      if (!response.ok) throw new Error('取回这条结果失败（HTTP ' + response.status + '）')
      const blob = await response.blob()
      const type = blob.type || item.file?.mime || (kind === 'video' ? 'video/mp4' : 'image/png')
      const file = new File([blob], name, { type })
      const meta = await probeMediaFile(file)
      const uploaded = await uploadMediaAsset({ file, ...meta })
      attachAsset(uploaded.asset)
    } catch (caught) {
      setRefError(caught instanceof Error ? caught.message : '把这条结果加进参考失败')
    } finally {
      setRefBusyId('')
    }
  }

  const submit = async () => {
    const text = prompt.trim()
    if (!text || active || !model || !mode) return
    if (assets.length < minRefs) {
      setError('「' + mode.label + '」需要先加参考素材')
      return
    }
    setBusy(true)
    setError('')
    setPollError('')
    setTask(null)
    try {
      const input = {
        prompt: text,
        model: model.id,
        mode: mode.id,
        ratio,
        // 文生模式不收素材：素材留在托架里不丢，但这次不发给上游（服务端也会拒）
        assets: maxRefs > 0 ? assets.map((asset) => asset.id) : [],
      }
      const response = image
        ? await generateMediaImage(input)
        : await generateMediaVideo({ ...input, duration, resolution })
      setTask(response.task)
      if (response.task.status !== 'processing') setRecentToken((value) => value + 1)
      if (response.task.status === 'failed') setError(response.task.error || '生成失败')
      onCreditsChanged()
    } catch (caught) {
      const failure = caught as Error & {
        body?: { code?: string; balance?: number; cost?: number; needed?: number }
      }
      if (failure.body?.code === 'CREDIT_INSUFFICIENT') {
        setError('积分不足：本次需要 ' + (failure.body.cost ?? model.credits) + ' 积分，当前余额 ' + (failure.body.balance ?? '—') + ' 积分。')
      } else {
        setError(failure.message || '生成失败')
      }
      onCreditsChanged()
    } finally {
      setBusy(false)
      getCredits(1).then(setCredits).catch(() => undefined)
    }
  }

  const reset = () => {
    if (active) return
    setTask(null)
    setError('')
    setPollError('')
    setElapsed(0)
  }

  const title = image ? '生图' : '生视频'
  const blockedReason = !prompt.trim()
    ? image
      ? '先写一句要画什么'
      : '先写一句要拍什么'
    : !model
      ? '正在读取可用模型…'
      : assets.length < minRefs
        ? '「' + (mode?.label ?? '') + '」需要先加参考素材'
        : ''
  const price = model?.credits ?? (image ? 5 : 15)
  const canSubmit =
    Boolean(prompt.trim()) && !active && Boolean(model) && Boolean(mode) && assets.length >= minRefs && !uploading

  return (
    <section className="agx-media-panel" aria-label={title}>
      <header className="agx-media-head">
        <span className="agx-media-icon">{image ? <ImageIcon size={18} /> : <Clapperboard size={18} />}</span>
        <div className="agx-media-heading">
          <h2>{title}</h2>
          <p>
            {model ? model.label + ' · 每次 ' + price + ' 积分' : '正在读取可用模型…'}
            {model && !model.verified ? ' · 未真调' : ''}
          </p>
        </div>
      </header>

      <div className="agx-media-body">
        <div className="agx-qc-params" role="group" aria-label="生成参数">
          <Capsule
            label="模型"
            value={model?.id ?? ''}
            options={catalog.map((item) => ({
              value: item.id,
              // 没真调过的模型在菜单里就标出来，免得用户以为它和主模型一样验过
              label: item.verified ? item.label : item.label + ' · 未真调',
            }))}
            onChange={(value) => setSelected({ model: value, mode: '', ratio: '', duration: 0, resolution: '' })}
            disabled={active || catalog.length === 0}
            title="换模型会按新模型的规格重画比例、时长与清晰度"
          />
          <Capsule
            label="方式"
            value={mode?.id ?? ''}
            options={(model?.modes ?? []).map((item) => ({ value: item.id, label: item.label }))}
            onChange={(value) => setSelected((current) => ({ ...current, mode: value }))}
            disabled={active || !model}
            title={mode?.hint}
          />
          <Capsule
            label="比例"
            value={ratio}
            options={(model?.ratios ?? []).map((item) => ({ value: item, label: item }))}
            onChange={(value) => setSelected((current) => ({ ...current, ratio: value }))}
            disabled={active || !model}
          />
          {!image ? (
            <Capsule
              label="时长"
              value={String(duration)}
              options={(model?.durations ?? []).map((item) => ({ value: String(item), label: item + 's' }))}
              onChange={(value) => setSelected((current) => ({ ...current, duration: Number(value) }))}
              disabled={active || !model}
            />
          ) : null}
          {!image ? (
            <Capsule
              label="清晰度"
              value={resolution}
              options={(model?.resolutions ?? []).map((item) => ({ value: item, label: item }))}
              onChange={(value) => setSelected((current) => ({ ...current, resolution: value }))}
              disabled={active || !model}
            />
          ) : null}
        </div>

        <div className={'agx-qc-refs' + (maxRefs === 0 ? ' is-off' : '')}>
          <div className="agx-qc-refs-head">
            <span>
              参考素材
              <b>{maxRefs === 0 ? '当前方式不收' : assets.length + ' / ' + maxRefs}</b>
            </span>
            <div className="agx-qc-refs-actions">
              <button
                type="button"
                className="vq-button vq-button--ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={active || uploading || maxRefs === 0}
              >
                <Upload size={13} />
                {uploading ? '上传中…' : '上传'}
              </button>
              <button
                type="button"
                className="vq-button vq-button--ghost"
                onClick={() => {
                  // 打开素材库时重取一次：另一个页签刚传的素材也要能直接挑到
                  if (!pickerOpen) {
                    listMediaAssets(20)
                      .then((response) => setLibrary(response.assets || []))
                      .catch(() => undefined)
                  }
                  setPickerOpen((value) => !value)
                }}
                disabled={active}
              >
                <FolderOpen size={13} />
                素材库
                {library.length ? ' · ' + library.length : ''}
              </button>
            </div>
          </div>

          {assets.length > 0 ? (
            <ul className="agx-qc-ref-grid">
              {assets.map((asset) => (
                <li className="agx-qc-ref" key={asset.id}>
                  <span className="agx-qc-ref-thumb">
                    {asset.kind === 'video' ? (
                      <video src={asset.previewUrl} muted playsInline preload="metadata" />
                    ) : (
                      <img src={asset.previewUrl} alt={asset.name} />
                    )}
                    {asset.kind === 'video' ? <em className="agx-qc-ref-kind">视频</em> : null}
                  </span>
                  <span className="agx-qc-ref-copy">
                    <strong title={asset.name}>{asset.name}</strong>
                    <small>{describeRef(asset)}</small>
                  </span>
                  <button
                    type="button"
                    className="agx-qc-ref-remove"
                    onClick={() => setAssets((items) => items.filter((item) => item.id !== asset.id))}
                    disabled={active}
                    aria-label={'移除 ' + asset.name}
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="agx-qc-refs-hint">{mode?.hint || '添加参考素材后按它生成'}</p>
          )}
          {maxRefs === 0 && assets.length > 0 ? (
            <p className="agx-qc-refs-hint">
              当前方式不用参考素材：切到「{model?.modes.find((item) => item.maxRefs > 0)?.label ?? '参考'}」才会带上。
            </p>
          ) : null}

          {pickerOpen ? (
            <div className="agx-qc-library">
              <div className="agx-qc-library-head">
                <span>我的素材 · 只列自己传的</span>
                <button type="button" onClick={() => setPickerOpen(false)} aria-label="收起素材库">
                  <X size={12} />
                </button>
              </div>
              {library.length === 0 ? (
                <p className="agx-qc-refs-hint">还没有传过素材：点「上传」传一张图或一段视频。</p>
              ) : (
                <ul>
                  {library.map((asset) => {
                    const picked = assets.some((item) => item.id === asset.id)
                    return (
                      <li key={asset.id}>
                        <button
                          type="button"
                          className={picked ? 'is-picked' : ''}
                          onClick={() => toggleAsset(asset)}
                          aria-pressed={picked}
                        >
                          <span className="agx-qc-lib-thumb">
                            {asset.kind === 'video' ? (
                              <video src={asset.previewUrl} muted playsInline preload="metadata" />
                            ) : (
                              <img src={asset.previewUrl} alt={asset.name} />
                            )}
                          </span>
                          <span className="agx-qc-lib-copy">
                            <strong>{asset.name}</strong>
                            <small>{describeRef(asset)}</small>
                          </span>
                          {picked ? <Check size={13} /> : <Plus size={13} />}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ) : null}

          {refError ? (
            <p className="agx-qc-refs-error" role="alert">
              {refError}
            </p>
          ) : null}
          <input ref={fileInputRef} type="file" accept="image/*,video/*" hidden onChange={pickFile} />
        </div>

        <label className="agx-media-field">
          <span>
            提示词
            <b>
              {prompt.length}/{MEDIA_MAX_PROMPT}
            </b>
          </span>
          <textarea
            ref={promptRef}
            rows={3}
            value={prompt}
            maxLength={MEDIA_MAX_PROMPT}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={
              image
                ? '描述画面主体、风格、光线与构图，例如：一只橘猫坐在窗台上，清晨侧光，35mm 胶片质感'
                : '描述镜头、动作与氛围，例如：海边日落，慢镜头推近，暖色逆光'
            }
            disabled={active}
          />
        </label>

        <div className="agx-media-cost">
          <span>
            本次 <strong>{price}</strong> 积分
            {credits?.balance !== null && credits?.balance !== undefined ? (
              <>
                {' '}· 当前余额 <strong>{credits.balance}</strong> 积分
              </>
            ) : null}
          </span>
          <span className="agx-mono">{blockedReason || '失败全额退回'}</span>
        </div>

        {error && !task ? (
          <div className="agx-media-error" role="alert">
            <AlertCircle size={15} />
            <div>
              <strong>没有生成</strong>
              <p>{error}</p>
              <small>本次未扣积分{error.includes('积分不足') ? '，充值通道未开通，请联系管理员发放' : ''}</small>
            </div>
          </div>
        ) : null}

        {busy && !task ? (
          <div className="agx-media-running" role="status">
            <span className="agx-media-spinner" />
            <div>
              <strong>{image ? '正在生成图片' : '正在提交视频任务'}</strong>
              <p>{image ? '平台通道已收到请求，完成后会自动显示结果。' : '提交成功后每 2.5 秒查询一次进度。'}</p>
            </div>
          </div>
        ) : null}

        {task?.status === 'processing' ? (
          <div className="agx-media-progress" role="status">
            <div className="agx-media-progress-head">
              <span className="agx-media-spinner" />
              <strong>
                {image ? '出图生成中' : '视频生成中'} · 已用时 <span className="agx-mono">{clockOf(elapsed)}</span>
              </strong>
              <span className="agx-mono">每 2.5s 查询</span>
            </div>
            <div className={'agx-media-progress-track' + (task.progress === null ? ' is-indeterminate' : '')}>
              <span style={task.progress === null ? undefined : { width: task.progress + '%' }} />
            </div>
            <p>
              {image
                ? '任务已经交给上游，出图一般 20～90 秒，最长等到 4 分钟；关掉这个窗口也会继续跑完，结果会留在下面的「最近生成」里。'
                : task.progress === null
                  ? '上游还没有返回百分比；页面按任务状态与已用时间如实显示，不编进度。'
                  : '上游进度 ' + task.progress + '%。'}
            </p>
            {pollError ? <p className="agx-media-poll-warning">{pollError}</p> : null}
          </div>
        ) : null}

        {task?.status === 'succeeded' ? (
          <div className="agx-media-result">
            <div className="agx-media-result-head">
              <span className="agx-chip agx-chip--pass">生成完成</span>
              <span className="agx-mono">
                {(image ? '图片' : '视频') + ' · ' + formatBytes(task.file?.bytes ?? 0)}
                {task.assets.length ? ' · 参考 ' + task.assets.length : ''}
              </span>
            </div>
            {image ? (
              <img className="agx-media-image" src={task.downloadUrl} alt={task.prompt} />
            ) : (
              <video className="agx-media-video" src={task.downloadUrl} controls playsInline preload="metadata" />
            )}
            <div className="agx-media-result-foot">
              <span className="agx-mono">{task.id}</span>
              <span className="agx-media-result-actions">
                {/* 刚生成出来的这张图 / 这条视频，下一步通常就是拿它接着改或当首帧：给一个直接入口 */}
                <button
                  type="button"
                  className="vq-button vq-button--ghost"
                  onClick={() => void addTaskResultAsRef(task)}
                  disabled={Boolean(refBusyId)}
                  title={refBusyId === task.id ? '正在加入参考素材' : image ? '把这张图加进参考图，接着改' : '把这条视频加进参考视频'}
                >
                  <Plus size={13} />
                  {refBusyId === task.id ? '加入参考中…' : '用作参考'}
                </button>
                <a className="vq-button vq-button--ghost" href={task.downloadUrl} download>
                  <Download size={13} />
                  下载{image ? '图片' : '视频'}
                </a>
              </span>
            </div>
          </div>
        ) : null}

        {task?.status === 'failed' ? (
          <div className="agx-media-error" role="alert">
            <AlertCircle size={15} />
            <div>
              <strong>生成失败</strong>
              <p>{error || task.error || '上游没有返回结果'}</p>
              <small>
                {task.credits.refunded
                  ? '已全额退还 ' + task.credits.cost + ' 积分（任务号 ' + task.id + '）'
                  : '退款未完成：账本未确认退回，请联系管理员并带上任务号 ' + task.id}
              </small>
            </div>
          </div>
        ) : null}

        {recent.length > 0 ? (
          <div className="agx-media-recent">
            <div className="agx-media-recent-head">
              <span>最近生成</span>
              <span>只列你自己的任务 · 已列 {recent.length} 条</span>
            </div>
            <ul>
              {recent.map((item) => (
                <li key={item.id} className={'agx-media-recent-row' + (item.id === task?.id ? ' is-current' : '')}>
                  <button
                    type="button"
                    className="agx-media-recent-open"
                    onClick={() => {
                      setTask(item)
                      setError(item.status === 'failed' ? item.error || '生成失败' : '')
                      setPollError('')
                    }}
                    disabled={active}
                    title="打开这一条"
                  >
                    <span className="agx-media-recent-prompt">{item.prompt}</span>
                    <span className="agx-media-recent-meta">{recentMetaOf(item)}</span>
                  </button>
                  {item.status === 'succeeded' ? (
                    <>
                      <button
                        type="button"
                        className="agx-media-recent-ref"
                        onClick={() => void addTaskResultAsRef(item)}
                        disabled={Boolean(refBusyId) || active}
                        title={image ? '把这条结果加进参考图，接着改' : '把这条结果加进参考视频'}
                      >
                        {refBusyId === item.id ? '加入中…' : '用作参考'}
                      </button>
                      <a className="agx-media-recent-download" href={item.downloadUrl} download>
                        下载
                      </a>
                    </>
                  ) : (
                    <span className="agx-media-recent-state">
                      {item.status === 'failed' ? '失败 · 已退 ' + item.credits.cost + ' 积分' : '进行中'}
                    </span>
                  )}
                  {item.status === 'failed' && item.error ? (
                    <p className="agx-media-recent-why" title={item.error}>
                      {item.error}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            {recentHasMore ? (
              <button type="button" className="agx-media-recent-more" onClick={() => void loadOlder()} disabled={recentLoading}>
                {recentLoading ? '读取中…' : '看更早的'}
              </button>
            ) : recentCapped ? (
              <p className="agx-media-recent-end">只往回找最近 240 个任务，更早的不在这个清单里</p>
            ) : null}
            {recentError ? <p className="agx-media-poll-warning">{recentError}</p> : null}
          </div>
        ) : null}
      </div>

      <footer className="agx-media-foot">
        <span>结果只存在你自己的账号里，别人看不到也下不了。</span>
        <div>
          {task?.status === 'succeeded' ? (
            <button type="button" className="vq-button vq-button--primary" onClick={reset}>
              <Plus size={14} />
              再生成
            </button>
          ) : task?.status === 'failed' ? (
            <button type="button" className="vq-button vq-button--primary" onClick={() => void submit()} disabled={!canSubmit}>
              <RotateCcw size={14} />
              重试
            </button>
          ) : (
            <button
              type="button"
              className="vq-button vq-button--primary"
              onClick={() => void submit()}
              disabled={!canSubmit}
              title={blockedReason || undefined}
            >
              {busy || task?.status === 'processing' ? (
                <span className="agx-media-spinner agx-media-spinner--ink" />
              ) : image ? (
                <ImageIcon size={14} />
              ) : (
                <Clapperboard size={14} />
              )}
              {busy ? '提交中…' : task?.status === 'processing' ? '生成中…' : image ? '生成图片' : '提交视频'}
            </button>
          )}
        </div>
      </footer>
    </section>
  )
}
export function AgentsPage({
  onCreate,
  onOpenAgent,
  onOpenTemplates,
  onOpenCanvas,
  onOpenProject,
  onToast,
}: {
  onCreate: () => void
  onOpenAgent: (name: string) => void
  onOpenTemplates: () => void
  onOpenCanvas: (flowId: string) => void
  onOpenProject: (projectId: string) => void
  onToast?: (message: string) => void
}) {
  const [data, setData] = useState<AgentsList | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [category, setCategory] = useState('全部')
  const [selectedId, setSelectedId] = useState('')
  const [model, setModel] = useState('')
  const [outputType, setOutputType] = useState<OutputType>(DEFAULT_OUTPUT_TYPE)
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [conversationId, setConversationId] = useState('')
  const [pending, setPending] = useState<{ startedAt: number; agentId: string } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>(readHistory)
  const [historyOpen, setHistoryOpen] = useState(false)
  // 历史弹层两栏：本机对话（可恢复上下文）与服务端运行记录（成败、耗时、扣退积分都在）
  const [historyTab, setHistoryTab] = useState<'chat' | 'runs'>('chat')
  const [runs, setRuns] = useState<AgentRunRecord[]>([])
  const [runsTotal, setRunsTotal] = useState(0)
  const [runsLoading, setRunsLoading] = useState(false)
  const [runsError, setRunsError] = useState('')
  const [runsLoadedId, setRunsLoadedId] = useState('')
  const [expandedRun, setExpandedRun] = useState('')
  const [armedClear, setArmedClear] = useState(false)
  const [copiedRun, setCopiedRun] = useState('')
  const [copiedId, setCopiedId] = useState('')
  const [armedDelete, setArmedDelete] = useState('')
  const [actionError, setActionError] = useState('')
  // 对话按次扣积分：输入框上方常驻「余额 / 单价」，402 时不再是一句干巴巴的失败
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  // 预设的窗口工具：生图 / 生视频，打开的是生成表单而不是对话
  // 创作方式：对话走对话预设，图片 / 视频走同一条生成表单（不再开单独的窗口）
  // 从「作品」点「用作参考」跳过来时，素材已经传好了：先看一眼（不删）决定落在哪个页签，
  // 挂进托架之后才算用掉（r229）。
  const [pendingRef, setPendingRef] = useState<RefHandoff | null>(() => peekRefHandoff(window.sessionStorage))
  const [composerMode, setComposerMode] = useState<'chat' | MediaKind>(
    pendingRef ? (pendingRef.kind === 'video' ? 'video' : 'image') : 'chat',
  )
  // 对话有两种：平台对话（默认，一页 DeepSeek）与对话预设（带结构化草稿，能存模板/送工作流/写作品）。
  // 从作品页「让 AI 起草」进来时切到预设：那条路要用到草稿的三个出口，平台对话给不了。
  const [chatSurface, setChatSurface] = useState<'platform' | 'preset'>('platform')
  // 平台对话面板一旦打开过就常驻，切走时只隐藏不卸载（r225）：卸载会连写了一半的提示词、
  // 正在生成的回答、附件一起丢掉——用户只是切过去看一眼图片或预设。
  const [chatMounted, setChatMounted] = useState(composerMode === 'chat')
  // 手机端「对话预设」选好一个之后，预设库收成一行（r226）：这时人要写东西，不是继续挑。
  // 默认 true——刚进「对话预设」时还是要先看见有哪几个预设可选（列表回来时会自动选中第一个，
  // 那是服务端的默认值，不是用户挑的）。桌面不受影响，预设库一直展开。
  const [presetShelfOpen, setPresetShelfOpen] = useState(true)
  // 可用的生成模型与规格：服务端 media-models 是唯一真源，界面不自己写死模型名
  const [mediaModels, setMediaModels] = useState<MediaModelList | null>(null)
  // 模型服务状态：额度 / 凭证这类账号级故障要在输入前就说清楚，而不是让人白点一次
  const [modelState, setModelState] = useState<ModelServiceState | null>(null)
  const [rechecking, setRechecking] = useState(false)
  // 每条回复的三个出口各自记状态：存过模板的那条不再显示「存为模板」按钮
  const [draftActions, setDraftActions] = useState<Record<string, DraftAction>>({})
  // 「写进作品」要选一条：列表按需取一次，读完留着；作品上下文来自作品页的「让 AI 起草」
  const [works, setWorks] = useState<ProjectSummary[] | null>(null)
  const [worksLoading, setWorksLoading] = useState(false)
  const [worksError, setWorksError] = useState('')
  const [projectContext, setProjectContext] = useState<AgentProjectContext | null>(null)
  // 从作品页「让 AI 起草」进来：那条路要用草稿的三个出口，自动落到「对话预设」，不要停在平台对话里
  useEffect(() => {
    if (projectContext) setChatSurface('preset')
  }, [projectContext])
  const { internal } = useUiMode()
  // 顶栏选择的模型保存在服务端；对话预设本身没绑模型时用它作为默认值
  const preferredModelRef = useRef('')

  const draftRef = useRef<HTMLTextAreaElement>(null)
  const stageRef = useRef<HTMLElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const agents = useMemo(() => data?.items ?? [], [data])
  const selectedAgent = useMemo(() => agents.find((item) => item.id === selectedId) ?? null, [agents, selectedId])

  useEffect(() => {
    let alive = true
    getPreferences()
      .then((prefs) => {
        if (!alive) return
        preferredModelRef.current = prefs.model
        setModel((current) => current || prefs.model)
      })
      .catch(() => {
        // 偏好接口不可用时按平台默认，不阻塞对话
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    getCredits(1)
      .then((next) => { if (alive) setCredits(next) })
      .catch(() => { if (alive) setCredits(null) })
    getModelService()
      .then((next) => { if (alive) setModelState(next.model) })
      .catch(() => { if (alive) setModelState(null) })
    // 快捷创作能选哪些模型：服务端说了算，界面照它画下拉
    listMediaModels()
      .then((next) => { if (alive) setMediaModels(next) })
      .catch(() => { if (alive) setMediaModels(null) })
    return () => { alive = false }
  }, [])

  const recheckModel = useCallback(async () => {
    setRechecking(true)
    try {
      await recheckModelService()
      const next = await getModelService()
      setModelState(next.model)
    } catch {
      // 状态接口本身不可用时不伪装成功：下一次发送会给出真实原因
    } finally {
      setRechecking(false)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      // 列表与账号偏好一起拿：避免列表先回来、把「平台默认」写进输入框后再也换不掉
      const [result, prefs] = await Promise.all([listAgents(), getPreferences().catch(() => ({ model: '' }))])
      preferredModelRef.current = prefs.model || preferredModelRef.current
      const requested = peekPendingSelectAgent()
      const nextId =
        requested && result.items.some((item) => item.id === requested)
          ? requested
          : (result.items[0]?.id ?? '')
      const nextAgent = result.items.find((item) => item.id === nextId)
      setData(result)
      setSelectedId(nextId)
      setModel(prefs.model || nextAgent?.model || preferredModelRef.current || result.defaultModel)
      setOutputType(
        nextAgent ? (OUTPUT_TYPE_BY_CATEGORY[nextAgent.category] ?? DEFAULT_OUTPUT_TYPE) : DEFAULT_OUTPUT_TYPE,
      )
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : '对话预设列表加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // 列表来自服务端：属于外部系统同步，load 内部会先置 loading
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
  }, [load])

  const loadRuns = useCallback(async (agentId: string, offset = 0) => {
    if (!agentId) return
    setRunsLoading(true)
    setRunsError('')
    try {
      const data = await listAgentHistory(agentId, { limit: RUN_PAGE, offset })
      setRuns((current) => (offset === 0 ? data.items : [...current, ...data.items]))
      setRunsTotal(data.total)
      setRunsLoadedId(agentId)
    } catch (caught) {
      setRunsError(caught instanceof Error ? caught.message : '运行记录加载失败')
    } finally {
      setRunsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!historyOpen || historyTab !== 'runs' || !selectedId) return
    if (runsLoadedId === selectedId) return
    // oxlint-disable-next-line react/set-state-in-effect
    void loadRuns(selectedId, 0)
  }, [historyOpen, historyTab, loadRuns, runsLoadedId, selectedId])

  useEffect(() => {
    if (!armedClear) return
    const timer = window.setTimeout(() => setArmedClear(false), 3200)
    return () => window.clearTimeout(timer)
  }, [armedClear])

  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => setElapsed(Date.now() - pending.startedAt), 100)
    return () => window.clearInterval(timer)
  }, [pending])

  useEffect(() => {
    const area = draftRef.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = Math.min(area.scrollHeight, 220) + 'px'
  }, [draft])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' })
  }, [messages.length, pending])

  // 从作品页的「让 AI 起草」进来：读一眼这条作品现在这一版，写进横幅、预填一次输入框。
  // 一次性交接，读完就清掉——之后再进对话预设页不该还挂着上一条作品。
  useEffect(() => {
    const staged = peekPendingAgentProject()
    if (!staged) return
    clearPendingAgentProject()
    let alive = true
    getProject(staged)
      .then((detail) => {
        if (!alive) return
        const next: AgentProjectContext = {
          id: detail.project.id,
          title: detail.project.title,
          version: detail.project.version,
          beats: Array.isArray(detail.script?.structure) ? detail.script.structure.length : 0,
          source: detail.script?.source || '',
          hook: detail.script?.hook || '',
        }
        setProjectContext(next)
        setDraft((current) => current || projectPrompt(next))
      })
      .catch(() => {
        // 读不到就退回到「没有上下文」：草稿照样能存模板、送工作流、选一条作品写进去
        if (alive) onToast?.('那条作品的上下文没读到：写完草稿再选作品也一样能写进去')
      })
    return () => {
      alive = false
    }
  }, [onToast])

  useEffect(() => {
    if (!armedDelete) return
    const timer = window.setTimeout(() => setArmedDelete(''), 3200)
    return () => window.clearTimeout(timer)
  }, [armedDelete])

  const resetConversation = useCallback(() => {
    setMessages([])
    setConversationId('')
    setFailure(null)
  }, [])

  const selectAgent = useCallback(
    (id: string) => {
      clearPendingSelectAgent()
      setSelectedId(id)
      // 换对话预设时把上一台的运行记录清掉，避免弹层里先闪一下别人的记录
      setRuns([])
      setRunsTotal(0)
      setRunsLoadedId('')
      setRunsError('')
      setExpandedRun('')
      const agent = agents.find((item) => item.id === id)
      // 顶栏的账号偏好优先；没有偏好时沿用对话预设自己的模型
      setModel(preferredModelRef.current || agent?.model || '')
      if (agent) {
        setOutputType(OUTPUT_TYPE_BY_CATEGORY[agent.category] ?? DEFAULT_OUTPUT_TYPE)
      }
      if (messages.length || pending) resetConversation()
    },
    [agents, messages.length, pending, resetConversation],
  )

  const selectFromCard = useCallback(
    (id: string) => {
      selectAgent(id)
      setPresetShelfOpen(false)
      window.setTimeout(() => stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
    },
    [selectAgent],
  )

  const submit = useCallback(
    async (override?: string, options: { appendUser?: boolean } = {}) => {
      const content = (override ?? draft).trim()
      const agent = selectedAgent
      if (!content || !agent || pending) return
      const appendUser = options.appendUser !== false
      const activeConversationId = conversationId || nextId()
      const userMessage: ChatMessage = { id: nextId(), role: 'user', content, at: Date.now() }
      const nextMessages = appendUser ? [...messages, userMessage] : messages
      // 会话记忆：把这一轮之前的对话按 user / assistant 交给服务端，服务端只保留最近几轮
      const history = nextMessages
        .slice(0, appendUser ? -1 : undefined)
        .filter((item) => item.role === 'user' || item.role === 'agent')
        .slice(-8)
        .map((item) => ({ role: item.role === 'user' ? ('user' as const) : ('assistant' as const), content: item.content }))
      if (appendUser) {
        setMessages(nextMessages)
        if (!conversationId) setConversationId(activeConversationId)
      }
      setDraft('')
      setFailure(null)
      setElapsed(0)
      setPending({ startedAt: Date.now(), agentId: agent.id })
      try {
        const result = await chatWithAgent(agent.id, {
          message: content,
          outputType,
          model: model || agent.model,
          history,
          conversationId: activeConversationId,
        })
        const replyMessage: ChatMessage = {
          id: nextId(),
          role: 'agent',
          content: result.reply,
          model: result.model,
          latencyMs: result.latencyMs,
          tools: result.tools,
          draft: result.draft ?? null,
          at: Date.now(),
        }
        const finalMessages = [...nextMessages, replyMessage]
        setMessages(finalMessages)
        // 服务端已落一条运行记录：把这条摘要补进已展开的「运行记录」，不用重新请求
        if (result.run && runsLoadedId === agent.id) {
          const record: AgentRunRecord = {
            id: result.run.id,
            agentId: agent.id,
            agentName: agent.name,
            status: 'success',
            conversationId: activeConversationId,
            message: content,
            reply: result.reply,
            error: '',
            model: result.model,
            outputType,
            latencyMs: result.latencyMs,
            credits: result.run.credits,
            tools: result.tools
              ? {
                  used: result.tools.used,
                  skipped: result.tools.skipped,
                  artifacts: result.tools.artifacts.map((artifact) => ({
                    name: artifact.name,
                    type: artifact.type,
                    bytes: artifact.bytes,
                  })),
                }
              : null,
            createdAt: result.run.createdAt,
          }
          setRuns((current) => [record, ...current])
          setRunsTotal((total) => total + 1)
        }
        // 对话完成后写入本地历史（完整一轮才写入），刷新后可以从「历史」找回
        const first = finalMessages.find((item) => item.role === 'user')
        const entry: HistoryEntry = {
          id: activeConversationId,
          agentId: agent.id,
          agentName: agent.name,
          title: (first?.content ?? content).slice(0, 42),
          at: new Date().toISOString(),
          // 下载文件的内容不写进 localStorage（12 条对话会撑爆配额），恢复时只保留工具摘要
          messages: finalMessages.map((message) =>
            message.tools
              ? { ...message, tools: { used: message.tools.used, skipped: message.tools.skipped, artifacts: [] } }
              : message,
          ),
        }
        const nextHistory = [entry, ...readHistory().filter((item) => item.id !== activeConversationId)].slice(0, 12)
        writeHistory(nextHistory)
        setHistory(nextHistory)
        setData((current) =>
          current
            ? {
                ...current,
                runs: current.runs + 1,
                items: current.items.map((item) =>
                  item.id === agent.id
                    ? { ...item, runCount: result.agent.runCount, lastRunAt: result.agent.lastRunAt, lastModel: result.model }
                    : item,
                ),
              }
            : current,
        )
      } catch (caught) {
        const error = caught as Error & {
          suggestion?: string
          code?: string
          upstreamStatus?: number
          body?: { code?: string; balance?: number; cost?: number }
        }
        const insufficient = error.body?.code === 'CREDIT_INSUFFICIENT'
        setFailure({
          message: error.message || '运行失败',
          suggestion: insufficient
            ? '积分不足：每次对话消耗 ' + (error.body?.cost ?? '—') + ' 积分，当前余额 ' + (error.body?.balance ?? '—') + ' 积分。充值通道未开通，请联系管理员发放。'
            : error.suggestion || '',
          detail: [error.code, error.upstreamStatus ? 'HTTP ' + error.upstreamStatus : ''].filter(Boolean).join(' · '),
          prompt: content,
        })
        if (insufficient) getCredits(1).then(setCredits).catch(() => undefined)
        // 服务端说模型不可用时，同步刷新顶部提示，避免再点一次还是一样的结果
        if (error.body?.code === 'MODEL_UNAVAILABLE') {
          getModelService().then((next) => setModelState(next.model)).catch(() => undefined)
        }
        // 失败也会在服务端留一条运行记录；已展开过就重新拉第一页，避免界面还是旧的
        if (runsLoadedId === agent.id) void loadRuns(agent.id, 0)
      } finally {
        setPending(null)
        getCredits(1).then(setCredits).catch(() => undefined)
      }
    },
    [conversationId, draft, loadRuns, messages, model, outputType, pending, runsLoadedId, selectedAgent],
  )

  const handleCopy = useCallback(async (message: ChatMessage) => {
    const ok = await copyText(message.content)
    setCopiedId(ok ? message.id : '')
    if (ok) window.setTimeout(() => setCopiedId((current) => (current === message.id ? '' : current)), 1600)
  }, [])

  const markDraftAction = useCallback((id: string, patch: Partial<DraftAction>) => {
    setDraftActions((current) => {
      const previous: DraftAction = current[id] ?? { busy: '', error: '' }
      return { ...current, [id]: { ...previous, ...patch } }
    })
  }, [])

  const saveDraftAsTemplate = useCallback(
    async (message: ChatMessage) => {
      const agent = selectedAgent
      const draft = message.draft
      if (!agent || !draft) return
      markDraftAction(message.id, { busy: 'template', error: '' })
      try {
        const result = await saveAgentDraftAsTemplate(agent.id, draft)
        markDraftAction(message.id, { busy: '', template: { id: result.template.id, title: result.template.title } })
        onToast?.(
          '已存为模板：' + result.template.title + '（' + result.template.beats + ' 段 / ' + result.template.shots + ' 镜）',
        )
      } catch (caught) {
        markDraftAction(message.id, { busy: '', error: caught instanceof Error ? caught.message : '存为模板失败' })
      }
    },
    [markDraftAction, onToast, selectedAgent],
  )

  const sendDraftToCanvas = useCallback(
    async (message: ChatMessage) => {
      const agent = selectedAgent
      const draft = message.draft
      if (!agent || !draft) return
      markDraftAction(message.id, { busy: 'canvas', error: '' })
      try {
        const result = await sendAgentDraftToCanvas(agent.id, draft)
        markDraftAction(message.id, { busy: '', flow: { id: result.flow.id, name: result.flow.name } })
        onToast?.('已送到工作流：' + result.flow.name)
      } catch (caught) {
        markDraftAction(message.id, { busy: '', error: caught instanceof Error ? caught.message : '送到工作流失败' })
      }
    },
    [markDraftAction, onToast, selectedAgent],
  )

  // ---- 写进作品：第三条出口（v0.9.30）----
  // 作品列表按需取一次；选中的那条再读一次详情，把「现在是什么」摆出来再让人点覆盖。
  const loadWorks = async () => {
    if (worksLoading) return
    setWorksLoading(true)
    setWorksError('')
    try {
      const result = await listProjects()
      setWorks(result.items)
    } catch (caught) {
      setWorksError(caught instanceof Error ? caught.message : '作品列表没读到')
    } finally {
      setWorksLoading(false)
    }
  }

  const patchPicker = (id: string, patch: Partial<NonNullable<DraftAction['picker']>>) => {
    setDraftActions((current) => {
      const previous: DraftAction = current[id] ?? { busy: '', error: '' }
      const picker = previous.picker ?? { open: true, id: '', loading: false, error: '', detail: null }
      return { ...current, [id]: { ...previous, picker: { ...picker, ...patch } } }
    })
  }

  const loadPickDetail = async (id: string, projectId: string) => {
    patchPicker(id, { id: projectId, loading: true, error: '', detail: null })
    try {
      const detail = await getProject(projectId)
      patchPicker(id, {
        loading: false,
        detail: {
          title: detail.project.title,
          version: detail.project.version,
          beats: Array.isArray(detail.script?.structure) ? detail.script.structure.length : 0,
          source: detail.script?.source || '',
        },
      })
    } catch (caught) {
      patchPicker(id, {
        loading: false,
        error: (caught instanceof Error ? caught.message : '读不到这条作品现在的脚本') + '：刷新再试',
      })
    }
  }

  const openDraftPicker = (message: ChatMessage) => {
    // 从作品页来的那条默认就在选中位置：少一个下拉动作，也不容易写错作品
    const preset = projectContext?.id || ''
    setDraftActions((current) => {
      const previous: DraftAction = current[message.id] ?? { busy: '', error: '' }
      return {
        ...current,
        [message.id]: {
          ...previous,
          picker: { open: true, id: preset, loading: false, error: '', detail: null },
        },
      }
    })
    if (!works && !worksLoading) void loadWorks()
    if (preset) void loadPickDetail(message.id, preset)
  }

  const cancelDraftPicker = (id: string) => {
    patchPicker(id, { open: false, id: '', loading: false, error: '', detail: null })
  }

  const writeDraft = async (message: ChatMessage) => {
    const agent = selectedAgent
    const draft = message.draft
    const projectId = draftActions[message.id]?.picker?.id || ''
    if (!agent || !draft || !projectId) return
    markDraftAction(message.id, { busy: 'project', error: '' })
    patchPicker(message.id, { error: '' })
    try {
      const result = await writeAgentDraftToProject(agent.id, draft, projectId)
      const beats = Array.isArray(result.script?.structure) ? result.script.structure.length : 0
      markDraftAction(message.id, {
        busy: '',
        project: {
          id: result.project.id,
          title: result.project.title,
          version: result.project.version,
          beats,
          canvas: result.canvas,
        },
      })
      // 工作流那边到底动没动，要在这一句里说清楚：手改过的提示词我们没碰
      const canvasNote = result.canvas.synced
        ? '，工作流里的复刻提示词就是这份脚本'
        : result.canvas.reason === 'hand-edited'
          ? '，工作流提示词你手改过没动'
          : ''
      onToast?.('已写进《' + result.project.title + '》· ' + versionLabel(result.project.version) + '（' + beats + ' 段' + canvasNote + '）')
      // 列表缓存与横幅上的版次一起刷新：同一份草稿再写一次，读到的不能是旧的
      setWorks((current) =>
        current
          ? current.map((item) =>
              item.id === result.project.id
                ? { ...item, version: result.project.version, updatedAt: result.project.updatedAt }
                : item,
            )
          : current,
      )
      setProjectContext((current) =>
        current && current.id === result.project.id
          ? { ...current, version: result.project.version, beats, source: 'project', hook: result.script?.hook || '' }
          : current,
      )
    } catch (caught) {
      patchPicker(message.id, { error: caught instanceof Error ? caught.message : '没写进去' })
      markDraftAction(message.id, { busy: '' })
    }
  }

  const clearRuns = useCallback(async () => {
    if (!selectedId) return
    if (!armedClear) {
      setArmedClear(true)
      return
    }
    setArmedClear(false)
    setRunsError('')
    try {
      await clearAgentHistory(selectedId)
      setRuns([])
      setRunsTotal(0)
      setExpandedRun('')
    } catch (caught) {
      setRunsError(caught instanceof Error ? caught.message : '清空失败')
    }
  }, [armedClear, selectedId])

  const copyRun = useCallback(async (run: AgentRunRecord) => {
    const ok = await copyText(run.status === 'error' ? run.error || '运行失败' : run.reply)
    setCopiedRun(ok ? run.id : '')
    if (ok) window.setTimeout(() => setCopiedRun((current) => (current === run.id ? '' : current)), 1600)
  }, [])

  const openAgentEditor = useCallback((agent: AgentRecord) => onOpenAgent(agent.name), [onOpenAgent])

  const removeAgent = useCallback(
    async (agent: AgentRecord) => {
      if (armedDelete !== agent.id) {
        setArmedDelete(agent.id)
        return
      }
      setArmedDelete('')
      setActionError('')
      try {
        await deleteAgent(agent.id)
        setData((current) => {
          if (!current) return current
          const nextItems = current.items.filter((item) => item.id !== agent.id)
          return {
            ...current,
            items: nextItems,
            total: Math.max(0, current.total - 1),
            byCategory: { ...current.byCategory, [agent.category]: Math.max(0, (current.byCategory[agent.category] || 1) - 1) },
          }
        })
        if (selectedId === agent.id) setSelectedId('')
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : '删除失败')
      }
    },
    [armedDelete, selectedId],
  )

  const restoreHistory = useCallback(
    (entry: HistoryEntry) => {
      setMessages(entry.messages)
      setConversationId(entry.id)
      setFailure(null)
      setHistoryOpen(false)
      if (agents.some((item) => item.id === entry.agentId)) setSelectedId(entry.agentId)
      window.setTimeout(() => stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
    },
    [agents],
  )

  const tabs = useMemo(() => {
    const categories = data?.categories ?? []
    return [
      { id: '全部', label: '全部', count: data?.total ?? 0 },
      ...categories.map((item) => ({ id: item.id, label: item.label, count: data?.byCategory[item.id] ?? 0 })),
    ]
  }, [data])

  const visibleAgents = category === '全部' ? agents : agents.filter((item) => item.category === category)
  // 模型一律显示产品口径（VisionQA 通用 / 视觉 / 对话模型），真实 id 只用于请求
  const catalogModels = useModelOptions()
  const modelLabels = useMemo(() => {
    const map = new Map<string, string>()
    catalogModels.forEach((item) => map.set(item.id, item.label))
    return map
  }, [catalogModels])
  const modelLabel = useCallback(
    (id?: string) => (id ? modelLabels.get(id) || 'VisionQA 模型' : ''),
    [modelLabels],
  )
  const modelOptions = useMemo(() => {
    const values = new Set(data?.models ?? [])
    if (model) values.add(model)
    const options = [...values].map((value) => ({ value, label: modelLabels.get(value) || 'VisionQA 模型' }))
    return options.length ? options : [{ value: '', label: '未配置模型' }]
  }, [data?.models, model, modelLabels])

  const agentOptions = useMemo(
    () => (agents.length ? agents.map((item) => ({ value: item.id, label: item.name })) : [{ value: '', label: '还没有对话预设' }]),
    [agents],
  )

  // 模型服务确认不可用时不再让用户白点：先看提示，或点「重新检测」放行一次
  const modelBlocked = modelState?.available === false
  const canSend = Boolean(selectedAgent && draft.trim() && !pending && !loading && !modelBlocked)

  return (
    <div className="page agx-page">
      <PageHead
        kicker="快捷创作 / 对话"
        title="快捷创作"
        desc="写文案、出图片、出视频都在这一个输入框里：选好方式，说清要什么。"
        actions={composerMode === 'chat' && chatSurface === 'platform' ? null : (
          <div className="agx-head-actions">
          <div className="agx-history-wrap">
            <button className="vq-button vq-button--ghost" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen}>
              <History size={15} />
              历史
              {history.length > 0 && <em className="vq-btn-count">{history.length}</em>}
            </button>
            {historyOpen && (
              <>
                <button className="agx-backdrop" aria-label="关闭历史" onClick={() => setHistoryOpen(false)} />
                <div className="agx-popover" role="dialog" aria-label="历史">
                  <div className="agx-popover-head">
                    <div className="agx-popover-tabs" role="tablist" aria-label="历史类型">
                      <button
                        role="tab"
                        aria-selected={historyTab === 'chat'}
                        className={historyTab === 'chat' ? 'is-active' : ''}
                        onClick={() => setHistoryTab('chat')}
                      >
                        本机对话
                      </button>
                      <button
                        role="tab"
                        aria-selected={historyTab === 'runs'}
                        className={historyTab === 'runs' ? 'is-active' : ''}
                        onClick={() => setHistoryTab('runs')}
                      >
                        运行记录
                        {runsLoadedId === selectedId && runsTotal > 0 && <em>{runsTotal}</em>}
                      </button>
                    </div>
                    <button className="vq-button vq-button--icon" onClick={() => setHistoryOpen(false)} aria-label="关闭">
                      <X size={13} />
                    </button>
                  </div>
                  {historyTab === 'chat' ? (
                    <>
                      {history.length === 0 && <p className="agx-popover-empty">还没有对话记录</p>}
                      {history.map((entry) => (
                        <button className="agx-history-item" key={entry.id} onClick={() => restoreHistory(entry)}>
                          <strong>{entry.title}</strong>
                          <span>
                            {entry.agentName} · {formatRelative(entry.at)}
                          </span>
                        </button>
                      ))}
                      <p className="agx-popover-note">本机对话只存在这台浏览器；换设备请看「运行记录」。</p>
                    </>
                  ) : (
                    <div className="agx-runs">
                      {runs.length > 0 && (
                        <div className="agx-runs-toolbar">
                          <span>
                            {selectedAgent?.name ?? '对话预设'} · 共 {runsTotal} 次
                          </span>
                          <button
                            type="button"
                            className={'agx-runs-clear' + (armedClear ? ' is-armed' : '')}
                            onClick={() => void clearRuns()}
                          >
                            {armedClear ? '确认清空' : '清空'}
                          </button>
                        </div>
                      )}
                      {runsError && <p className="agx-popover-empty">{runsError}</p>}
                      {!runsError && runs.length === 0 && (
                        <p className="agx-popover-empty">{runsLoading ? '正在读取运行记录…' : '这个对话预设还没有运行记录'}</p>
                      )}
                      {runs.map((run) => {
                        const open = expandedRun === run.id
                        return (
                          <div className={'agx-run' + (run.status === 'error' ? ' is-error' : '')} key={run.id}>
                            <button
                              type="button"
                              className="agx-run-head"
                              onClick={() => setExpandedRun(open ? '' : run.id)}
                              aria-expanded={open}
                            >
                              <span className="agx-run-state">{run.status === 'error' ? '失败' : '成功'}</span>
                              <span className="agx-run-msg">{run.message || '（没有记录输入）'}</span>
                              <span className="agx-run-meta">
                                {formatRelative(run.createdAt)} · {run.outputType || '输出'} · {(run.latencyMs / 1000).toFixed(1)}s
                                {run.credits
                                  ? ' · ' + (run.credits.refunded ? '已退 ' : '') + run.credits.cost + ' 积分'
                                  : ''}
                              </span>
                            </button>
                            {open && (
                              <div className="agx-run-detail">
                                {run.tools?.used.length ? (
                                  <p>工具：{run.tools.used.map((tool) => tool.label + '（' + tool.detail + '）').join('；')}</p>
                                ) : null}
                                {run.tools?.skipped.length ? (
                                  <p>{run.tools.skipped.map((tool) => tool.label + '：' + tool.reason).join('；')}</p>
                                ) : null}
                                {run.status === 'error' ? (
                                  <p className="agx-run-error">{run.error || '运行失败'}</p>
                                ) : (
                                  <pre className="agx-run-reply">{run.reply}</pre>
                                )}
                                <button type="button" className="vq-button vq-button--ghost" onClick={() => void copyRun(run)}>
                                  {copiedRun === run.id ? <Check size={12} /> : <Copy size={12} />}
                                  {copiedRun === run.id ? '已复制' : run.status === 'error' ? '复制原因' : '复制回复'}
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                      {runs.length > 0 && runs.length < runsTotal && (
                        <button
                          type="button"
                          className="agx-runs-more"
                          onClick={() => selectedId && void loadRuns(selectedId, runs.length)}
                          disabled={runsLoading}
                        >
                          {runsLoading ? '加载中…' : '加载更多'}
                        </button>
                      )}
                      <p className="agx-popover-note">运行记录存在服务端，成功与失败都会留档；清空只删这个对话预设的记录。</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
            <button className="vq-button vq-button--primary" onClick={onCreate}>
              <Plus size={15} />
              新建对话预设
            </button>
          </div>
        )}
      />

      <section className="agx-stage" ref={stageRef}>
        {projectContext ? (
          <div className="agx-project" role="status">
            <span className="agx-project-kicker">在帮</span>
            <strong>
              《{projectContext.title}》· {versionLabel(projectContext.version)}
            </strong>
            <span className="agx-project-meta">
              {projectContext.beats
                ? '脚本 ' + projectContext.beats + ' 段 · ' + (projectContext.source === 'project' ? '这条作品的版本' : '来自模板')
                : '还没有脚本'}
            </span>
            <div className="agx-project-actions">
              <button type="button" className="vq-button vq-button--ghost" onClick={() => onOpenProject(projectContext.id)}>
                打开作品
              </button>
              <button
                type="button"
                className="vq-button vq-button--ghost"
                onClick={() => setProjectContext(null)}
                title="不帮这条作品了：草稿照样能存为模板、送到工作流，或写进别的作品"
              >
                不帮了
              </button>
            </div>
          </div>
        ) : null}
        <div className="agx-composer-wrap">
          <div className="agx-mode-tabs agx-mode-tabs--top" role="tablist" aria-label="创作方式">
            {COMPOSER_MODES.map((mode) => (
              <button
                key={mode.id}
                role="tab"
                aria-selected={composerMode === mode.id}
                className={composerMode === mode.id ? 'is-active' : ''}
                onClick={() => {
                  setComposerMode(mode.id)
                  // 从图片 / 视频切回对话：平台对话面板第一次出现时要挂上（之后一直常驻）
                  if (mode.id === 'chat') setChatMounted(true)
                }}
              >
                {mode.id === 'image' ? <ImageIcon size={14} /> : mode.id === 'video' ? <Clapperboard size={14} /> : <Bot size={14} />}
                {mode.label}
              </button>
            ))}
          </div>
          {composerMode === 'chat' ? (
            <div className="agx-surface-switch" role="tablist" aria-label="对话方式">
              <button
                type="button"
                role="tab"
                aria-selected={chatSurface === 'platform'}
                className={chatSurface === 'platform' ? 'is-active' : ''}
                onClick={() => setChatSurface('platform')}
              >
                平台对话
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={chatSurface === 'preset'}
                className={chatSurface === 'preset' ? 'is-active' : ''}
                onClick={() => setChatSurface('preset')}
              >
                对话预设
              </button>
              <span className="agx-surface-note">
                {chatSurface === 'platform'
                  ? '长上下文 · 联网搜索 · 读链接 · 思考模式'
                  : '带输出类型与草稿出口：存模板 / 送工作流 / 写进作品'}
              </span>
            </div>
          ) : null}
          {/* 平台对话面板常驻：切到「对话预设」或图片 / 视频时只隐藏、不卸载（r225）。
              .qc-root 是 display:grid，hidden 属性在它身上不生效，所以外面套一层容器。 */}
          {chatMounted ? (
            <div className="agx-quickchat" hidden={!(composerMode === 'chat' && chatSurface === 'platform')}>
              <QuickChat onToast={onToast} />
            </div>
          ) : null}
          {composerMode === 'chat' && chatSurface === 'preset' && messages.length > 0 && (
            <div className="agx-thread-head">
              <button className="vq-button vq-button--ghost" onClick={resetConversation} disabled={Boolean(pending)}>
                <ArrowLeft size={13} />
                新建对话
              </button>
              <span className="agx-mono">
                {selectedAgent?.name ?? '未选择预设'} · {outputType} · {messages.length} 条
              </span>
            </div>
          )}
          {composerMode === 'chat' && chatSurface === 'preset' && messages.length > 0 && (
            <div className="agx-thread">
              {messages.map((message) => (
                <div className={'agx-msg agx-msg--' + message.role} key={message.id}>
                  <div className="agx-bubble">
                    {message.role === 'agent' ? <div className="agx-md">{renderMarkdown(message.content)}</div> : message.content}
                  </div>
                  {message.role === 'agent' && message.draft ? (
                    <DraftCard
                      draft={message.draft}
                      action={draftActions[message.id] || { busy: '', error: '' }}
                      works={works}
                      worksLoading={worksLoading}
                      worksError={worksError}
                      onSaveTemplate={() => void saveDraftAsTemplate(message)}
                      onSendCanvas={() => void sendDraftToCanvas(message)}
                      onOpenTemplates={onOpenTemplates}
                      onOpenCanvas={onOpenCanvas}
                      onOpenPicker={() => openDraftPicker(message)}
                      onPick={(projectId) => void loadPickDetail(message.id, projectId)}
                      onWriteProject={() => void writeDraft(message)}
                      onCancelPicker={() => cancelDraftPicker(message.id)}
                      onOpenProject={onOpenProject}
                    />
                  ) : null}
                  <div className="agx-msg-meta">
                    <span>
                      {message.role === 'user' ? '你' : selectedAgent?.name ?? '对话预设'} · {formatClock(new Date(message.at).toISOString())}
                      {message.model ? ' · ' + modelLabel(message.model) : ''}
                      {message.latencyMs ? ' · ' + (message.latencyMs / 1000).toFixed(1) + 's' : ''}
                    </span>
                    <button onClick={() => void handleCopy(message)}>
                      {copiedId === message.id ? <Check size={11} /> : <Copy size={11} />}
                      {copiedId === message.id ? '已复制' : '复制'}
                    </button>
                  </div>
                  {message.tools &&
                    (message.tools.used.length > 0 || message.tools.artifacts.length > 0 || message.tools.skipped.length > 0) && (
                      <div className="agx-msg-tools">
                        {message.tools.used.map((tool) => (
                          <span key={tool.id}>
                            {tool.label} · {tool.detail}
                          </span>
                        ))}
                        {message.tools.skipped.map((tool) => (
                          <span key={tool.id} className="is-muted">
                            {tool.label} · {tool.reason}
                          </span>
                        ))}
                        {message.tools.artifacts.map((artifact) => (
                          <button type="button" key={artifact.name} onClick={() => downloadArtifact(artifact)}>
                            <Download size={11} />
                            {artifact.name}
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              ))}
              {pending && (
                <div className="agx-msg agx-msg--agent">
                  <div className="agx-bubble agx-bubble--running">
                    <div className="agx-running">
                      <span className="agx-running-dot" />
                      运行中 · 已用时 {(elapsed / 1000).toFixed(1)} 秒
                    </div>
                    <div className="agx-skeleton">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
              )}
              {failure && (
                <div className="agx-failure" role="alert">
                  <strong>运行失败</strong>
                  <p>{failure.message}</p>
                  {failure.suggestion && <p className="agx-failure-suggestion">建议：{failure.suggestion}</p>}
                  {internal && failure.detail ? <small>{failure.detail}</small> : null}
                  <div>
                    <button
                      className="vq-button vq-button--ghost"
                      onClick={() => void submit(failure.prompt, { appendUser: false })}
                      disabled={Boolean(pending)}
                    >
                      <RotateCcw size={13} />
                      重试
                    </button>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}

          <div className={'agx-composer' + (composerMode === 'chat' && !selectedAgent ? ' is-disabled' : '')} hidden={composerMode === 'chat' && chatSurface === 'platform'}>
            {composerMode === 'chat' ? (
              <>
            {credits ? (
              <div className="agx-credit-line">
                余额 <strong>{credits.balance ?? '—'}</strong> {credits.unit} · 每次对话 <strong>{credits.prices.chat}</strong> {credits.unit}
                {credits.balance !== null && credits.balance < credits.prices.chat ? ' · 余额不足，请管理员发放' : ''}
              </div>
            ) : null}
            {modelBlocked ? (
              <div className="agx-model-note" role="status">
                <AlertCircle size={13} />
                <div className="agx-model-note-text">
                  <span>{modelState?.message || '模型服务暂时不可用。本次未扣积分，请稍后再试。'}</span>
                  {internal && modelState?.detail ? <small>{modelState.detail}</small> : null}
                </div>
                <button type="button" className="vq-button vq-button--ghost" onClick={() => void recheckModel()} disabled={rechecking}>
                  {rechecking ? '检测中' : '重新检测'}
                </button>
              </div>
            ) : null}
            <textarea
              ref={draftRef}
              className="agx-textarea"
              rows={3}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder={
                loading
                  ? '正在读取对话预设列表…'
                  : selectedAgent
                    ? '描述你要它做的事，例如：把这条 30 秒口播拆成分镜表'
                    : '还没有对话预设：先新建一个，保存后就能直接对话'
              }
              disabled={!selectedAgent || loading}
            />
            <div className="agx-composer-bar">
              <div className="agx-params">
                <Capsule label="对话预设" value={selectedId} options={agentOptions} onChange={selectAgent} disabled={Boolean(pending)} />
                <Capsule
                  label="输出"
                  value={outputType}
                  options={OUTPUT_TYPES.map((item) => ({ value: item, label: item }))}
                  onChange={(value) => setOutputType(value as OutputType)}
                  disabled={Boolean(pending)}
                />
                <Capsule label="模型" value={model} options={modelOptions} onChange={setModel} disabled={Boolean(pending)} />
              </div>
              <div className="agx-composer-actions">
                <span className="agx-shortcut">Ctrl + Enter</span>
                <button className="agx-send" onClick={() => void submit()} disabled={!canSend} aria-label="发送" title="发送（Ctrl + Enter）">
                  <ArrowUp size={18} />
                </button>
              </div>
            </div>
              </>
            ) : (
              // 图片 / 视频两个面板都挂着，只把非当前的隐藏：来回切的时候提示词、参数、
              // 参考素材、正在跑的任务都还在原处（用户 2026-11-18 明确要求文本可保留可调整）。
              (['image', 'video'] as MediaKind[]).map((mode) => (
                <div key={mode} hidden={composerMode !== mode}>
                  <MediaComposer
                    kind={mode}
                    catalog={mediaModels?.[mode] ?? []}
                    defaultModel={mediaModels?.defaults[mode] ?? ''}
                    handoff={pendingRef && pendingRef.kind === mode ? pendingRef : null}
                    onHandoffDone={() => {
                      takeRefHandoff(window.sessionStorage)
                      setPendingRef(null)
                    }}
                    onCreditsChanged={() => {
                      getCredits(1).then(setCredits).catch(() => undefined)
                    }}
                    onToast={onToast}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* 手机端「平台对话」时，下面这一整块自建预设跟当前这段对话无关：
          它把页面拉长一倍（r225 实测 390 宽 979px），还会把贴底的输入框顶出视口
          （滚到预设卡片时输入框已经跑到屏幕上方 -339px）。
          手机上收起来；要挑预设就切上面那枚「对话预设」页签，那里才是它的位置。
          桌面（>900）不受影响：这块仍是这一页的主要内容。 */}
      {/* 手机端「对话预设」选好一个之后的替代入口（r226）：预设库收起来，但换预设 /
          编辑 / 删除都还在这条上，点一下展开。桌面不显示这条，预设库一直展开。 */}
      {composerMode === 'chat' && chatSurface === 'preset' && selectedAgent && !presetShelfOpen ? (
        <div className="agx-library-bar">
          <span className="agx-library-bar-text">当前「{selectedAgent.name}」</span>
          <button
            type="button"
            className="vq-button vq-button--ghost"
            aria-expanded={presetShelfOpen}
            onClick={() => setPresetShelfOpen((value) => !value)}
          >
            {'换一个预设'}
          </button>
        </div>
      ) : null}

      <section
        className={
          'agx-library'
          + (composerMode === 'chat' && chatSurface === 'platform' ? ' is-in-platform-chat' : '')
          + (composerMode === 'chat' && chatSurface === 'preset' && selectedAgent && !presetShelfOpen ? ' is-shelf-closed' : '')
        }
      >
        <div className="agx-library-head">
          <h2>已自建对话预设</h2>
          <span className="agx-library-meta">
            {agents.length} 个 · 累计 {data?.runs ?? 0} 次运行
          </span>
        </div>

        {actionError && (
          <div className="agx-alert">
            <AlertCircle size={14} />
            {actionError}
          </div>
        )}

        {!loading && !loadError && agents.length > 0 && (
          <div className="agx-tabs" role="tablist" aria-label="按分类筛选">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={category === tab.id}
                className={category === tab.id ? 'is-active' : ''}
                onClick={() => setCategory(tab.id)}
              >
                {tab.label}
                <em>{tab.count}</em>
              </button>
            ))}
          </div>
        )}

        {loading && (
          <div className="agx-grid" aria-busy="true">
            <div className="agx-skeleton-card" />
            <div className="agx-skeleton-card" />
            <div className="agx-skeleton-card" />
          </div>
        )}

        {!loading && loadError && (
          <div className="agx-alert" role="alert">
            <AlertCircle size={14} />
            <span>{loadError}</span>
            <button className="vq-button vq-button--ghost" onClick={() => void load()}>
              <RotateCcw size={13} />
              重试
            </button>
          </div>
        )}

        {!loading && !loadError && agents.length === 0 && (
          <div className="agx-empty">
            <div className="agx-empty-icon">
              <Bot size={19} />
            </div>
            <strong>还没有自建对话预设</strong>
            <p>把一次性的创作判断写成系统提示词和知识，保存后就能在这里反复调用。</p>
            <button className="vq-button vq-button--primary" onClick={onCreate}>
              <Plus size={14} />
              新建对话预设
            </button>
          </div>
        )}

        {!loading && !loadError && agents.length > 0 && visibleAgents.length === 0 && (
          <div className="agx-empty">
            <div className="agx-empty-icon">
              <Bot size={19} />
            </div>
            <strong>这个分类还没有对话预设</strong>
            <p>换一个分类看看，或者新建一个「{category}」方向的对话预设。</p>
            <button className="vq-button vq-button--ghost" onClick={onCreate}>
              <Plus size={14} />
              新建对话预设
            </button>
          </div>
        )}

        {!loading && !loadError && visibleAgents.length > 0 && (
          <div className="agx-grid">
            {visibleAgents.map((agent) => (
              <article className={'agx-card' + (agent.id === selectedId ? ' is-active' : '')} key={agent.id}>
                <button className="agx-card-main" onClick={() => selectFromCard(agent.id)} aria-label={'选择 ' + agent.name}>
                  <div className="agx-card-top">
                    <span className="agx-card-name">{agent.name}</span>
                    <span className="agx-card-tags">
                      {agent.id === selectedId ? <span className="agx-card-current">当前</span> : null}
                      <Tag>{agent.category}</Tag>
                    </span>
                  </div>
                  <p className="agx-card-role">{agent.role}</p>
                  <div className="agx-card-meta">
                    <span>
                      <span>模型</span>
                      <span className="agx-mono">{modelLabel(agent.model) || '默认'}</span>
                    </span>
                    <span>
                      <span>最近运行</span>
                      <span className="agx-mono">
                        <Clock size={10} /> {formatRelative(agent.lastRunAt)}
                      </span>
                    </span>
                    <span>
                      <span>使用次数</span>
                      <span className="agx-mono">{agent.runCount} 次</span>
                    </span>
                  </div>
                </button>
                <div className="agx-card-actions">
                  <button className="vq-button vq-button--icon" onClick={() => openAgentEditor(agent)} aria-label={'编辑 ' + agent.name} title="编辑">
                    <Pencil size={13} />
                  </button>
                  <button
                    className={'vq-button vq-button--icon' + (armedDelete === agent.id ? ' is-armed' : '')}
                    onClick={() => void removeAgent(agent)}
                    aria-label={armedDelete === agent.id ? '再次点击确认删除' : '删除 ' + agent.name}
                    title={armedDelete === agent.id ? '再次点击确认删除' : '删除'}
                  >
                    {armedDelete === agent.id ? <Check size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

    </div>
  )
}