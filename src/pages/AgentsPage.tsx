import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Clapperboard,
  Clock,
  Copy,
  Download,
  History,
  Layers,
  LayoutTemplate,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
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
import { getCredits, getModelService, recheckModelService, type CreditsResponse, type ModelServiceState } from '../api/credits'
import { getProject, listProjects } from '../api/projects'
import type { ProjectSummary } from '../domain/project'
import { getPreferences } from '../api/preferences'
import { useUiMode } from '../api/app'
import PageHead from '../components/PageHead'
import { useModelOptions } from '../components/ModelSwitch'
import { Tag } from '../components/ui'
import '../styles/agents.css'

type ChatMessage = {
  id: string
  role: 'user' | 'agent'
  content: string
  model?: string
  latencyMs?: number
  tools?: AgentToolsResult
  // 结构化草稿：有它才显示三个出口（存为模板 / 送到画布 / 写进作品）
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
  /** 已经写进这条作品：标题 / 版次 / 段数与画布那边发生了什么 */
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

// 作品页「让智能体写」带过来的上下文：标题、版次与这一版现在的脚本（标题与段数）。
// 只用来写一句「在帮哪条作品」和预填输入框，不往对话里塞任何作品内部数据。
type AgentProjectContext = {
  id: string
  title: string
  version: number
  beats: number
  source: '' | 'project' | 'template'
  hook: string
}

const versionLabel = (version: number) => (version > 0 ? '第 ' + version + ' 版' : '还没开画布')

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

// 极简 Markdown 渲染：只覆盖模型常见的标题 / 列表 / 表格 / 加粗 / 行内代码 / 代码块，
// 不引入新依赖，也不使用 dangerouslySetInnerHTML。
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
      nodes.push(<strong key={keyBase + '-' + match.index}>{token.slice(2, -2)}</strong>)
    } else {
      nodes.push(<code key={keyBase + '-' + match.index}>{token.slice(1, -1)}</code>)
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/

function splitRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isBlockStart(line: string, next?: string) {
  if (!line.trim()) return true
  if (line.trim().startsWith('```')) return true
  if (/^(#{1,6})\s+/.test(line)) return true
  if (/^\s*[-*]\s+/.test(line)) return true
  if (/^\s*\d+[.、)]\s+/.test(line)) return true
  if (line.trim().startsWith('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-')) return true
  return false
}

function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  let key = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    if (line.trim().startsWith('```')) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index])
        index += 1
      }
      index += 1
      blocks.push(
        <pre className="agx-md-code" key={'code-' + key++}>
          <code>{code.join('\n')}</code>
        </pre>,
      )
      continue
    }
    if (line.trim().startsWith('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]) && lines[index + 1].includes('-')) {
      const header = splitRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      blocks.push(
        <div className="agx-md-table" key={'table-' + key++}>
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={cellIndex}>{renderInline(cell, 'th-' + key + '-' + cellIndex)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell, 'td-' + key + '-' + rowIndex + '-' + cellIndex)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const Tag = heading[1].length <= 2 ? 'h3' : 'h4'
      blocks.push(
        <Tag className="agx-md-heading" key={'h-' + key++}>
          {renderInline(heading[2], 'h-' + key)}
        </Tag>,
      )
      index += 1
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''))
        index += 1
      }
      blocks.push(
        <ul className="agx-md-list" key={'ul-' + key++}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, 'ul-' + key + '-' + itemIndex)}</li>
          ))}
        </ul>,
      )
      continue
    }
    if (/^\s*\d+[.、)]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+[.、)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.、)]\s+/, ''))
        index += 1
      }
      blocks.push(
        <ol className="agx-md-list" key={'ol-' + key++}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, 'ol-' + key + '-' + itemIndex)}</li>
          ))}
        </ol>,
      )
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && !isBlockStart(lines[index], lines[index + 1])) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    if (paragraph.length) {
      blocks.push(
        <p key={'p-' + key++}>
          {paragraph.map((part, partIndex) => (
            <span key={partIndex}>
              {renderInline(part, 'p-' + key + '-' + partIndex)}
              {partIndex < paragraph.length - 1 ? <br /> : null}
            </span>
          ))}
        </p>,
      )
    } else {
      // 兜底：不认识的块按原文输出，避免死循环
      blocks.push(<p key={'raw-' + key++}>{renderInline(line, 'raw-' + key)}</p>)
      index += 1
    }
  }
  return blocks
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

// 切到某个智能体时，输出类型跟着它的主场景走；用户仍可在参数行手动改。
const OUTPUT_TYPE_BY_CATEGORY: Record<string, OutputType> = {
  内容复刻: '脚本',
  视觉评审: '评审',
  脚本分镜: '分镜',
  投放素材: '文案',
}

const DEFAULT_OUTPUT_TYPE: OutputType = '脚本'

// 结构化草稿卡：回复下面的一条「可以继续用的东西」。
// 两个出口都在这里，不跳页：存完模板、建完画布之后原件还在，链接点了再走。
// 结构化草稿卡：回复下面的一条「可以继续用的东西」。
// 三个出口都在这里，不跳页：存完模板、建完画布、写进作品之后原件还在，链接点了再走。
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
            className="agx-btn agx-btn--ink"
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
            已送到画布 · {savedFlow.name}
            <button type="button" onClick={() => onOpenCanvas(savedFlow.id)}>
              打开画布
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="agx-btn"
            onClick={onSendCanvas}
            disabled={busy}
            title="开一张新画布：脚本进了复刻提示词，可以接着改、接着跑"
          >
            <Layers size={13} />
            {action.busy === 'canvas' ? '创建中' : '送到画布'}
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
              <em className="agx-draft-fact">画布里的复刻提示词就是这份脚本</em>
            ) : savedProject.canvas.reason === 'hand-edited' ? (
              <em className="agx-draft-fact">画布提示词你手改过，没动</em>
            ) : null}
          </span>
        ) : draft.stats.beats > 0 ? (
          <button
            type="button"
            className="agx-btn"
            onClick={onOpenPicker}
            disabled={busy || Boolean(picker?.open)}
            title="把这份草稿写进一条作品这一版的脚本；写进去之后模板与别的作品不动"
          >
            <Clapperboard size={13} />
            {action.busy === 'project' ? '写入中' : '写进作品'}
          </button>
        ) : (
          <span className="agx-draft-note">只有分镜的草稿写不进作品：作品脚本只认段落，要镜头就送到画布</span>
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
            <button type="button" className="agx-btn agx-btn--ink" onClick={onWriteProject} disabled={!canWrite}>
              {action.busy === 'project' ? '写入中' : picked?.beats ? '覆盖这一版脚本' : '写进这一版'}
            </button>
            <button type="button" className="agx-btn agx-btn--quiet" onClick={onCancelPicker} disabled={busy}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
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
  // 模型服务状态：额度 / 凭证这类账号级故障要在输入前就说清楚，而不是让人白点一次
  const [modelState, setModelState] = useState<ModelServiceState | null>(null)
  const [rechecking, setRechecking] = useState(false)
  // 每条回复的三个出口各自记状态：存过模板的那条不再显示「存为模板」按钮
  const [draftActions, setDraftActions] = useState<Record<string, DraftAction>>({})
  // 「写进作品」要选一条：列表按需取一次，读完留着；作品上下文来自作品页的「让智能体写」
  const [works, setWorks] = useState<ProjectSummary[] | null>(null)
  const [worksLoading, setWorksLoading] = useState(false)
  const [worksError, setWorksError] = useState('')
  const [projectContext, setProjectContext] = useState<AgentProjectContext | null>(null)
  const { internal } = useUiMode()
  // 顶栏选择的模型保存在服务端；智能体本身没绑模型时用它作为默认值
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
      setLoadError(caught instanceof Error ? caught.message : '智能体列表加载失败')
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

  // 从作品页的「让智能体写」进来：读一眼这条作品现在这一版，写进横幅、预填一次输入框。
  // 一次性交接，读完就清掉——之后再进智能体页不该还挂着上一条作品。
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
        // 读不到就退回到「没有上下文」：草稿照样能存模板、送画布、选一条作品写进去
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
      // 换智能体时把上一台的运行记录清掉，避免弹层里先闪一下别人的记录
      setRuns([])
      setRunsTotal(0)
      setRunsLoadedId('')
      setRunsError('')
      setExpandedRun('')
      const agent = agents.find((item) => item.id === id)
      // 顶栏的账号偏好优先；没有偏好时沿用智能体自己的模型
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
        onToast?.('已送到画布：' + result.flow.name)
      } catch (caught) {
        markDraftAction(message.id, { busy: '', error: caught instanceof Error ? caught.message : '送到画布失败' })
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
      // 画布那边到底动没动，要在这一句里说清楚：手改过的提示词我们没碰
      const canvasNote = result.canvas.synced
        ? '，画布里的复刻提示词就是这份脚本'
        : result.canvas.reason === 'hand-edited'
          ? '，画布提示词你手改过没动'
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
    () => (agents.length ? agents.map((item) => ({ value: item.id, label: item.name })) : [{ value: '', label: '还没有智能体' }]),
    [agents],
  )

  // 模型服务确认不可用时不再让用户白点：先看提示，或点「重新检测」放行一次
  const modelBlocked = modelState?.available === false
  const canSend = Boolean(selectedAgent && draft.trim() && !pending && !loading && !modelBlocked)

  return (
    <div className="page agx-page">
      <PageHead
        kicker="智能体 / 对话"
        title="智能体"
        desc="选择一个智能体，描述你要它做的事。"
        actions={
          <div className="agx-head-actions">
          <div className="agx-history-wrap">
            <button className="agx-btn" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen}>
              <History size={15} />
              历史
              {history.length > 0 && <em>{history.length}</em>}
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
                    <button className="agx-icon-btn" onClick={() => setHistoryOpen(false)} aria-label="关闭">
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
                            {selectedAgent?.name ?? '智能体'} · 共 {runsTotal} 次
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
                        <p className="agx-popover-empty">{runsLoading ? '正在读取运行记录…' : '这个智能体还没有运行记录'}</p>
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
                                <button type="button" className="agx-btn agx-btn--quiet" onClick={() => void copyRun(run)}>
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
                      <p className="agx-popover-note">运行记录存在服务端，成功与失败都会留档；清空只删这个智能体的记录。</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
            <button className="agx-btn agx-btn--ink" onClick={onCreate}>
              <Plus size={15} />
              新建智能体
            </button>
          </div>
        }
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
              <button type="button" className="agx-btn" onClick={() => onOpenProject(projectContext.id)}>
                打开作品
              </button>
              <button
                type="button"
                className="agx-btn agx-btn--quiet"
                onClick={() => setProjectContext(null)}
                title="不帮这条作品了：草稿照样能存为模板、送到画布，或写进别的作品"
              >
                不帮了
              </button>
            </div>
          </div>
        ) : null}
        <div className="agx-composer-wrap">
          {messages.length > 0 && (
            <div className="agx-thread-head">
              <button className="agx-btn agx-btn--quiet" onClick={resetConversation} disabled={Boolean(pending)}>
                <ArrowLeft size={13} />
                新建对话
              </button>
              <span className="agx-mono">
                {selectedAgent?.name ?? '未选择智能体'} · {outputType} · {messages.length} 条
              </span>
            </div>
          )}
          {messages.length > 0 && (
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
                      {message.role === 'user' ? '你' : selectedAgent?.name ?? '智能体'} · {formatClock(new Date(message.at).toISOString())}
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
                      className="agx-btn agx-btn--quiet"
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

          <div className={'agx-composer' + (selectedAgent ? '' : ' is-disabled')}>
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
                <button type="button" className="agx-btn agx-btn--quiet" onClick={() => void recheckModel()} disabled={rechecking}>
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
                  ? '正在读取智能体列表…'
                  : selectedAgent
                    ? '描述你要它做的事，例如：把这条 30 秒口播拆成分镜表'
                    : '还没有智能体：先新建一个，保存后就能直接对话'
              }
              disabled={!selectedAgent || loading}
            />
            <div className="agx-composer-bar">
              <div className="agx-params">
                <Capsule label="智能体" value={selectedId} options={agentOptions} onChange={selectAgent} disabled={Boolean(pending)} />
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
          </div>
        </div>
      </section>

      <section className="agx-library">
        <div className="agx-library-head">
          <h2>已自建智能体</h2>
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
            <button className="agx-btn agx-btn--quiet" onClick={() => void load()}>
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
            <strong>还没有自建智能体</strong>
            <p>把一次性的创作判断写成系统提示词和知识，保存后就能在这里反复调用。</p>
            <button className="agx-btn agx-btn--ink" onClick={onCreate}>
              <Plus size={14} />
              新建智能体
            </button>
          </div>
        )}

        {!loading && !loadError && agents.length > 0 && visibleAgents.length === 0 && (
          <div className="agx-empty">
            <div className="agx-empty-icon">
              <Bot size={19} />
            </div>
            <strong>这个分类还没有智能体</strong>
            <p>换一个分类看看，或者新建一个「{category}」方向的智能体。</p>
            <button className="agx-btn" onClick={onCreate}>
              <Plus size={14} />
              新建智能体
            </button>
          </div>
        )}

        {!loading && !loadError && visibleAgents.length > 0 && (
          <div className="agx-grid">
            {visibleAgents.map((agent) => (
              <article className="agx-card" key={agent.id}>
                <button className="agx-card-main" onClick={() => selectFromCard(agent.id)} aria-label={'选择 ' + agent.name}>
                  <div className="agx-card-top">
                    <span className="agx-card-name">{agent.name}</span>
                    <Tag>{agent.category}</Tag>
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
                  <button className="agx-icon-btn" onClick={() => openAgentEditor(agent)} aria-label={'编辑 ' + agent.name} title="编辑">
                    <Pencil size={13} />
                  </button>
                  <button
                    className={'agx-icon-btn' + (armedDelete === agent.id ? ' is-armed' : '')}
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