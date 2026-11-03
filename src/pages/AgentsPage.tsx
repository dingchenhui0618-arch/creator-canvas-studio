import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Clock,
  Copy,
  History,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import {
  OUTPUT_TYPES,
  chatWithAgent,
  deleteAgent,
  formatClock,
  formatRelative,
  clearPendingSelectAgent,
  listAgents,
  peekPendingSelectAgent,
} from '../api/agents'
import type { AgentRecord, AgentsList, OutputType } from '../api/agents'
import '../styles/agents.css'

type ChatMessage = {
  id: string
  role: 'user' | 'agent'
  content: string
  model?: string
  latencyMs?: number
  at: number
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
  return (
    <label className="agx-capsule" title={title}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {options.map((option) => (
          <option value={option.value} key={option.value || option.label}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={12} />
    </label>
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

export function AgentsPage({ onCreate, onOpenAgent }: { onCreate: () => void; onOpenAgent: (name: string) => void }) {
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
  const [copiedId, setCopiedId] = useState('')
  const [armedDelete, setArmedDelete] = useState('')
  const [actionError, setActionError] = useState('')

  const draftRef = useRef<HTMLTextAreaElement>(null)
  const stageRef = useRef<HTMLElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const agents = useMemo(() => data?.items ?? [], [data])
  const selectedAgent = useMemo(() => agents.find((item) => item.id === selectedId) ?? null, [agents, selectedId])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await listAgents()
      const requested = peekPendingSelectAgent()
      const nextId =
        requested && result.items.some((item) => item.id === requested)
          ? requested
          : (result.items[0]?.id ?? '')
      const nextAgent = result.items.find((item) => item.id === nextId)
      setData(result)
      setSelectedId(nextId)
      setModel(nextAgent?.model || result.defaultModel)
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
      const agent = agents.find((item) => item.id === id)
      if (agent?.model) setModel(agent.model)
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
        })
        const replyMessage: ChatMessage = {
          id: nextId(),
          role: 'agent',
          content: result.reply,
          model: result.model,
          latencyMs: result.latencyMs,
          at: Date.now(),
        }
        const finalMessages = [...nextMessages, replyMessage]
        setMessages(finalMessages)
        // 对话完成后写入本地历史（完整一轮才写入），刷新后可以从「历史」找回
        const first = finalMessages.find((item) => item.role === 'user')
        const entry: HistoryEntry = {
          id: activeConversationId,
          agentId: agent.id,
          agentName: agent.name,
          title: (first?.content ?? content).slice(0, 42),
          at: new Date().toISOString(),
          messages: finalMessages,
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
        const error = caught as Error & { suggestion?: string; code?: string; upstreamStatus?: number }
        setFailure({
          message: error.message || '运行失败',
          suggestion: error.suggestion || '',
          detail: [error.code, error.upstreamStatus ? 'HTTP ' + error.upstreamStatus : ''].filter(Boolean).join(' · '),
          prompt: content,
        })
      } finally {
        setPending(null)
      }
    },
    [conversationId, draft, messages, model, outputType, pending, selectedAgent],
  )

  const handleCopy = useCallback(async (message: ChatMessage) => {
    const ok = await copyText(message.content)
    setCopiedId(ok ? message.id : '')
    if (ok) window.setTimeout(() => setCopiedId((current) => (current === message.id ? '' : current)), 1600)
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
  const modelOptions = useMemo(() => {
    const values = new Set(data?.models ?? [])
    if (model) values.add(model)
    const options = [...values].map((value) => ({ value, label: value }))
    return options.length ? options : [{ value: '', label: '未配置模型' }]
  }, [data?.models, model])

  const agentOptions = useMemo(
    () => (agents.length ? agents.map((item) => ({ value: item.id, label: item.name })) : [{ value: '', label: '还没有智能体' }]),
    [agents],
  )

  const canSend = Boolean(selectedAgent && draft.trim() && !pending && !loading)

  return (
    <div className="page agx-page">
      <header className="agx-head">
        <div>
          <div className="agx-eyebrow">创作能力 / 智能体</div>
          <h1>智能体</h1>
          <p>选择一个智能体，描述你要它做的事。</p>
        </div>
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
                <div className="agx-popover" role="dialog" aria-label="历史对话">
                  <div className="agx-popover-head">
                    <span>最近对话</span>
                    <button className="agx-icon-btn" onClick={() => setHistoryOpen(false)} aria-label="关闭">
                      <X size={13} />
                    </button>
                  </div>
                  {history.length === 0 && <p className="agx-popover-empty">还没有对话记录</p>}
                  {history.map((entry) => (
                    <button className="agx-history-item" key={entry.id} onClick={() => restoreHistory(entry)}>
                      <strong>{entry.title}</strong>
                      <span>
                        {entry.agentName} · {formatRelative(entry.at)}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button className="agx-btn agx-btn--ink" onClick={onCreate}>
            <Plus size={15} />
            新建智能体
          </button>
        </div>
      </header>

      <section className="agx-stage" ref={stageRef}>
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
                  <div className="agx-msg-meta">
                    <span>
                      {message.role === 'user' ? '你' : selectedAgent?.name ?? '智能体'} · {formatClock(new Date(message.at).toISOString())}
                      {message.model ? ' · ' + message.model : ''}
                      {message.latencyMs ? ' · ' + (message.latencyMs / 1000).toFixed(1) + 's' : ''}
                    </span>
                    <button onClick={() => void handleCopy(message)}>
                      {copiedId === message.id ? <Check size={11} /> : <Copy size={11} />}
                      {copiedId === message.id ? '已复制' : '复制'}
                    </button>
                  </div>
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
                  {failure.detail && <small>{failure.detail}</small>}
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
            <textarea
              ref={draftRef}
              className="agx-textarea"
              rows={2}
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
            <div className="agx-params">
              <Capsule label="智能体" value={selectedId} options={agentOptions} onChange={selectAgent} disabled={Boolean(pending)} />
              <Capsule
                label="输出"
                value={outputType}
                options={OUTPUT_TYPES.map((item) => ({ value: item, label: item }))}
                onChange={(value) => setOutputType(value as OutputType)}
                disabled={Boolean(pending)}
              />
              <Capsule label="模型" value={model} options={modelOptions} onChange={setModel} disabled={Boolean(pending)} title="来自服务端 VISION_MODEL / VISION_FALLBACKS" />
              <span className="agx-capsule agx-capsule--static" title="对话每次生成 1 条回复">
                <span>数量</span>
                <b>1</b>
              </span>
            </div>
            <div className="agx-composer-foot">
              <span className="agx-hint">Ctrl + Enter 发送 · 真实调用本地模型，失败会显示原因</span>
              <button className="agx-send" onClick={() => void submit()} disabled={!canSend} aria-label="发送">
                <ArrowUp size={18} />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="agx-library">
        <div className="agx-library-head">
          <div>
            <span className="agx-kicker">自建库 · {data?.runs ?? 0} 次运行</span>
            <h2>已自建智能体</h2>
          </div>
          <button className="agx-btn" onClick={onCreate}>
            <Plus size={14} />
            新建
          </button>
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
                    <span className="agx-tag">{agent.category}</span>
                  </div>
                  <p className="agx-card-role">{agent.role}</p>
                  <div className="agx-card-meta">
                    <span>
                      <span>模型</span>
                      <span className="agx-mono">{agent.model || '默认'}</span>
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