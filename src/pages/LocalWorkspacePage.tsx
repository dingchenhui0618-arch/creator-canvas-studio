// 本地工作区：桌面端专属。loop、工具、会话记忆都在这台机器上，
// 服务端只负责「用平台 Key 做一次补全」，所以密钥不进安装包。
// 网页版打开 #/local 会看到一页说明，而不是一个假界面。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Brain, FolderOpen, Loader2, Plus, ShieldCheck, Square, Trash2, X } from 'lucide-react'
import PageHead from '../components/PageHead'
import {
  getDesktop,
  type DesktopBridge,
  type DesktopEvent,
  type DesktopInfo,
  type LocalThread,
  type LocalThreadSummary,
  type MemoryEntry,
  type ThreadMessage,
} from '../desktop/bridge'
import '../styles/local-workspace.css'

type ToolItem = {
  kind: 'tool'
  key: number
  tool: string
  args?: Record<string, unknown>
  why?: string
  phase: 'call' | 'done' | 'denied'
  ok?: boolean
  output?: string
}

type ApprovalItem = {
  kind: 'approval'
  key: number
  id: string
  tool: string
  args?: Record<string, unknown>
  why?: string
  decided?: 'allow' | 'deny'
}

type FeedItem =
  | { kind: 'user'; key: number; text: string }
  | { kind: 'assistant'; key: number; text: string }
  | { kind: 'note'; key: number; text: string }
  | { kind: 'error'; key: number; text: string; detail?: string }
  | { kind: 'compact'; key: number; text: string }
  | ToolItem
  | ApprovalItem

type Meta = { enabled: boolean; models: string[]; defaultModel: string }

const STARTERS = [
  '列一下这个工作区里有什么，按目录和文件分开说',
  '读 package.json，告诉我有哪些脚本可以跑',
  '看看最近改过的文件，帮我总结这次改了什么',
]

const ARG_LABELS: Record<string, string> = {
  path: '路径',
  content: '内容',
  command: '命令',
  cwd: '目录',
  offset: '起始行',
  limit: '行数',
  query: '找什么',
  glob: '文件范围',
  old: '原内容',
  new: '新内容',
  text: '记忆内容',
}

// 工具参数不整段 JSON 甩给用户：路径/命令直接看，长内容压成一行预览 + 体量说明。
function ArgsView({ args }: { args?: Record<string, unknown> }) {
  if (!args) return null
  const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== '')
  if (entries.length === 0) return null
  return (
    <dl className="lw-args">
      {entries.map(([key, value]) => {
        const text = typeof value === 'string' ? value : shortJson(value)
        const long = text.length > 120
        return (
          <div key={key} className="lw-args-row">
            <dt>{ARG_LABELS[key] || key}</dt>
            <dd>
              <code>{long ? text.slice(0, 120).replace(/\n/g, ' ⏎ ') + '…' : text.replace(/\n/g, ' ⏎ ')}</code>
              {long ? (
                <em>
                  {text.split('\n').length} 行 · {text.length} 字
                </em>
              ) : null}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

function shortJson(value: unknown): string {
  if (value === undefined) return ''
  const text = JSON.stringify(value)
  return text && text.length > 220 ? text.slice(0, 220) + '…' : String(text || '')
}

function toFeed(messages: ThreadMessage[]): FeedItem[] {
  const items: FeedItem[] = []
  let key = 0
  for (const message of messages) {
    key += 1
    if (message.tool) {
      items.push({
        kind: 'tool',
        key,
        tool: message.tool.name,
        args: message.tool.args,
        phase: 'done',
        ok: message.tool.ok,
        output: message.tool.output,
      })
      continue
    }
    if (message.note) {
      items.push({ kind: 'note', key, text: message.content })
      continue
    }
    // 协议 JSON 是留给模型看的，界面上不重复显示一遍
    if (message.protocol) continue
    if (message.role === 'user') items.push({ kind: 'user', key, text: message.content })
    else if (message.role === 'assistant') items.push({ kind: 'assistant', key, text: message.content })
  }
  return items
}

function formatTime(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function LocalWorkspacePage() {
  const bridge = useMemo<DesktopBridge | null>(() => getDesktop(), [])
  const [info, setInfo] = useState<DesktopInfo | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [threads, setThreads] = useState<LocalThreadSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [memoryItems, setMemoryItems] = useState<MemoryEntry[]>([])
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [recalled, setRecalled] = useState<{ id: string; text: string }[]>([])
  const activeRef = useRef<string | null>(null)
  const keyRef = useRef(0)
  const feedRef = useRef<HTMLDivElement | null>(null)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)

  const nextKey = useCallback(() => {
    keyRef.current += 1
    return keyRef.current
  }, [])

  const openThread = useCallback(
    async (id: string) => {
      if (!bridge) return
      setBusy(true)
      setError('')
      try {
        const thread: LocalThread = await bridge.agent.getThread(id)
        setActiveId(thread.id)
        activeRef.current = thread.id
        const items = toFeed(thread.messages)
        keyRef.current = items.length
        setFeed(items)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [bridge],
  )

  const refreshMemory = useCallback(async () => {
    if (!bridge) return
    try {
      setMemoryItems(await bridge.memory.list())
    } catch {
      // 记忆读不到不影响对话：面板会显示「还没有记忆」
    }
  }, [bridge])

  const refreshThreads = useCallback(async () => {
    if (!bridge) return [] as LocalThreadSummary[]
    try {
      const items = await bridge.agent.listThreads()
      setThreads(items)
      return items
    } catch {
      return [] as LocalThreadSummary[]
    }
  }, [bridge])

  const handleEvent = useCallback(
    (payload: { threadId: string; event: DesktopEvent }) => {
      if (payload.threadId !== activeRef.current) return
      const event = payload.event
      if (event.type === 'user') {
        // 发送时已经乐观上屏，服务端回声不重复显示；但它确实多了一条，会话栏的条数跟着加
        setThreads((items) => items.map((item) => (item.id === payload.threadId ? { ...item, messages: item.messages + 1 } : item)))
        return
      }
      if (event.type === 'title') {
        setThreads((items) => items.map((item) => (item.id === payload.threadId ? { ...item, title: event.text } : item)))
        return
      }
      if (event.type === 'assistant') {
        setFeed((items) => [...items, { kind: 'assistant', key: nextKey(), text: event.text }])
        setRunning(false)
        void refreshThreads()
        return
      }
      if (event.type === 'tool') {
        setFeed((items) => {
          if (event.phase === 'call') {
            return [
              ...items,
              {
                kind: 'tool',
                key: nextKey(),
                tool: event.tool,
                args: event.args,
                why: event.why,
                phase: 'call',
              },
            ]
          }
          if (event.phase === 'denied') {
            return items.map((item) =>
              item.kind === 'tool' && item.phase === 'call' && item.tool === event.tool ? { ...item, phase: 'denied' } : item,
            )
          }
          // 结果回到最近一次同类调用上：一次对话里同一个工具可能被调多次
          let index = -1
          for (let cursor = items.length - 1; cursor >= 0; cursor -= 1) {
            const item = items[cursor]
            if (item.kind === 'tool' && item.phase === 'call' && item.tool === event.tool) {
              index = cursor
              break
            }
          }
          if (index === -1) return items
          const next = [...items]
          next[index] = { ...(next[index] as ToolItem), phase: 'done', ok: event.ok, output: event.output }
          return next
        })
        return
      }
      if (event.type === 'approval') {
        setFeed((items) => [
          ...items,
          { kind: 'approval', key: nextKey(), id: event.id, tool: event.tool, args: event.args, why: event.why },
        ])
        return
      }
      if (event.type === 'compact') {
        if (event.phase !== 'done') return
        const text =
          '已压缩 ' +
          (event.removed ?? 0) +
          ' 条早期对话，保留最近 ' +
          (event.kept ?? 0) +
          ' 条；摘要 ' +
          (event.summary ? event.summary.length : 0) +
          ' 字。'
        setFeed((items) => [...items, { kind: 'compact', key: nextKey(), text }])
        void refreshThreads()
        return
      }
      if (event.type === 'memory') {
        if (event.phase === 'changed') void refreshMemory()
        else setRecalled(event.entries || [])
        return
      }
      if (event.type === 'turn-end') {
        void refreshThreads()
        return
      }
      if (event.type === 'note') {
        setFeed((items) => [...items, { kind: 'note', key: nextKey(), text: event.text }])
        return
      }
      if (event.type === 'error') {
        setFeed((items) => [...items, { kind: 'error', key: nextKey(), text: event.message, detail: event.detail }])
        setRunning(false)
        return
      }
      if (event.type === 'aborted') {
        setFeed((items) => [...items, { kind: 'note', key: nextKey(), text: '已停止这一轮；已经执行过的工具和结果都还在。' }])
        setRunning(false)
      }
    },
    [nextKey, refreshMemory, refreshThreads],
  )

  useEffect(() => {
    if (!bridge) return
    let alive = true
    const off = bridge.agent.onEvent((payload) => {
      if (alive) handleEvent(payload)
    })
    void (async () => {
      try {
        const [desktopInfo, list, memories] = await Promise.all([bridge.info(), bridge.agent.listThreads(), bridge.memory.list()])
        if (!alive) return
        setInfo(desktopInfo)
        setThreads(list)
        setMemoryItems(memories)
        if (list[0]) await openThread(list[0].id)
      } catch (caught) {
        if (alive) setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
    return () => {
      alive = false
      off()
    }
  }, [bridge, handleEvent, openThread])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const response = await fetch('/api/local-agent/meta')
        const payload = (await response.json()) as Meta
        if (alive && response.ok) setMeta(payload)
      } catch {
        // 元数据拿不到不影响使用：模型名那一行会显示「未取到」
      }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const node = feedRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [feed])

  const createThread = useCallback(async () => {
    if (!bridge) return
    setBusy(true)
    try {
      const thread = await bridge.agent.createThread()
      setActiveId(thread.id)
      activeRef.current = thread.id
      keyRef.current = 0
      setFeed([])
      await refreshThreads()
      draftRef.current?.focus()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [bridge, refreshThreads])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!bridge || !text || running) return
    // 还没有会话时，第一句话就顺手开一个：不该逼用户先点「+」才能开始
    let target = activeId
    if (!target) {
      try {
        const thread = await bridge.agent.createThread()
        target = thread.id
        setActiveId(thread.id)
        activeRef.current = thread.id
        await refreshThreads()
      } catch (caught) {
        setFeed((items) => [...items, { kind: 'error', key: nextKey(), text: caught instanceof Error ? caught.message : String(caught) }])
        return
      }
    }
    setDraft('')
    setRunning(true)
    setRecalled([])
    void refreshThreads()
    setFeed((items) => [...items, { kind: 'user', key: nextKey(), text }])
    try {
      const result = await bridge.agent.send(target, text)
      if (!result.ok) {
        setFeed((items) => [...items, { kind: 'error', key: nextKey(), text: result.error || '这一轮没有跑起来' }])
        setRunning(false)
      }
    } catch (caught) {
      setFeed((items) => [...items, { kind: 'error', key: nextKey(), text: caught instanceof Error ? caught.message : String(caught) }])
      setRunning(false)
    }
  }, [activeId, bridge, draft, nextKey, refreshThreads, running])

  const stop = useCallback(async () => {
    if (!bridge) return
    await bridge.agent.abort()
  }, [bridge])

  const decide = useCallback(
    async (item: ApprovalItem, allow: boolean) => {
      if (!bridge) return
      setFeed((items) =>
        items.map((entry) => (entry.kind === 'approval' && entry.key === item.key ? { ...entry, decided: allow ? 'allow' : 'deny' } : entry)),
      )
      await bridge.agent.approve(item.id, allow)
    },
    [bridge],
  )

  const pickWorkspace = useCallback(async () => {
    if (!bridge) return
    const workspace = await bridge.workspace.choose()
    setInfo((current) => (current ? { ...current, workspace } : current))
  }, [bridge])

  const removeThread = useCallback(
    async (id: string) => {
      if (!bridge) return
      await bridge.agent.deleteThread(id)
      const list = await refreshThreads()
      if (activeId === id) {
        const fallback = list[0]
        if (fallback) await openThread(fallback.id)
        else {
          setActiveId(null)
          activeRef.current = null
          setFeed([])
        }
      }
    },
    [activeId, bridge, openThread, refreshThreads],
  )

  const removeMemory = useCallback(
    async (id: string) => {
      if (!bridge) return
      const result = await bridge.memory.remove(id)
      if (result.ok) setMemoryItems((items) => items.filter((item) => item.id !== id))
    },
    [bridge],
  )

  const clearMemory = useCallback(async () => {
    if (!bridge) return
    const result = await bridge.memory.clear()
    if (result.ok) setMemoryItems([])
  }, [bridge])

  const pending = feed.some((item) => item.kind === 'approval' && !item.decided)
  const status = pending ? '待批准' : running ? '运行中' : '就绪'

  if (!bridge) {
    return (
      <div className="page vq-page lw-page">
        <PageHead
          kicker="本机"
          title="本地工作区"
          desc="在你自己电脑上读写文件、执行命令，每一步有副作用的操作都要你点头。"
        />
        <section className="lw-offline">
          <h2>这一页只在桌面端打开</h2>
          <p>网页版拿不到你电脑上的文件和命令，也不会假装拿到。本地工作区跑在 VisionQA 桌面外壳里：agent loop、工具执行、会话记忆都在本机，只有模型补全走服务端。</p>
          <p className="lw-offline-note">现在你在浏览器里，所以这里没有可用的本地能力。</p>
        </section>
      </div>
    )
  }

  return (
    <div className="page vq-page lw-page">
      <PageHead
        kicker="本机"
        title="本地工作区"
        desc="本机读写文件、执行命令；模型补全走 VisionQA 账号，密钥不在安装包里。"
        actions={
          <div className="lw-head-actions">
            <button type="button" className="lw-btn" onClick={() => void pickWorkspace()}>
              <FolderOpen size={14} />
              <span className="lw-path" title={info?.workspace || ''}>{info?.workspace || '选择工作区目录'}</span>
            </button>
            <div className="lw-memory-wrap">
              <button
                type="button"
                className={'lw-btn lw-memory-btn' + (memoryOpen ? ' is-open' : '')}
                onClick={() => setMemoryOpen((open) => !open)}
                aria-expanded={memoryOpen}
                title="这个工作区的长期记忆（跨会话保留）"
              >
                <Brain size={14} />
                <span>记忆</span>
                <span className="lw-count">{memoryItems.length}</span>
              </button>
              {memoryOpen ? (
                <div className="lw-memory" role="dialog" aria-label="这个工作区的长期记忆">
                  <header className="lw-memory-head">
                    <strong>这个工作区的记忆</strong>
                    <button type="button" className="lw-icon-btn" onClick={() => setMemoryOpen(false)} aria-label="关闭记忆面板">
                      <X size={14} />
                    </button>
                  </header>
                  <p className="lw-memory-note">跨会话保留，只在这台机器上；换工作区就是另一份。</p>
                  {memoryItems.length === 0 ? (
                    <p className="lw-memory-empty">还没有记忆。说一句「记住：…」直接记一条（不调模型），或者让它自己在需要时记住。</p>
                  ) : (
                    <ul className="lw-memory-list">
                      {memoryItems.map((entry) => (
                        <li key={entry.id} className="lw-memory-item">
                          <p className="lw-memory-text">{entry.text}</p>
                          <div className="lw-memory-meta">
                            <span>
                              召回 {entry.uses} 次 · {formatTime(entry.usedAt)}
                            </span>
                            <button
                              type="button"
                              className="lw-thread-del"
                              onClick={() => void removeMemory(entry.id)}
                              title="删掉这条记忆"
                              aria-label={'删掉记忆 ' + entry.text.slice(0, 20)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <footer className="lw-memory-foot">
                    <span>最多留 {info?.memory?.maxEntries ?? 40} 条，满后先淘汰最少召回的那条</span>
                    {memoryItems.length > 0 ? (
                      <button type="button" className="lw-btn lw-btn--quiet" onClick={() => void clearMemory()}>
                        清空
                      </button>
                    ) : null}
                  </footer>
                </div>
              ) : null}
            </div>
          </div>
        }
      />

      <div className="lw-grid">
        <aside className="lw-rail">
          <div className="lw-rail-head">
            <span className="lw-rail-label">会话</span>
            <button type="button" className="lw-icon-btn" onClick={() => void createThread()} disabled={busy} title="新建会话">
              <Plus size={15} />
            </button>
          </div>
          <div className="lw-threads">
            {threads.length === 0 ? <p className="lw-rail-empty">还没有会话。左边那一页就是你的工作区。</p> : null}
            {threads.map((thread) => (
              <div key={thread.id} className={'lw-thread' + (thread.id === activeId ? ' is-active' : '')}>
                <button type="button" className="lw-thread-main" onClick={() => void openThread(thread.id)}>
                  <span className="lw-thread-title">{thread.title}</span>
                  <span className="lw-thread-meta">
                    {formatTime(thread.updatedAt)} · {thread.messages} 条
                    {thread.compactions ? ' · 压缩 ' + thread.compactions + ' 次' : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className="lw-thread-del"
                  onClick={() => void removeThread(thread.id)}
                  title="删除这个会话"
                  aria-label={'删除会话 ' + thread.title}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="lw-rail-foot">
            <span className="lw-foot-kicker">上限</span>
            <span>每轮 {info?.loop.maxSteps ?? 8} 步</span>
            <span>上下文 {Math.round((info?.compaction.contextTokens ?? 64000) / 1000)}k · {(info?.compaction.thresholdPercent ?? 75)}% 触发压缩</span>
          </div>
        </aside>

        <section className="lw-main">
          <div className="lw-status">
            <span className={'lw-pill' + (pending ? ' is-warn' : running ? ' is-run' : '')}>
              {pending ? <ShieldCheck size={13} /> : running ? <Loader2 size={13} className="lw-spin" /> : <span className="lw-dot" />}
              {status}
            </span>
            <span className="lw-model">
              {meta?.enabled === false ? '模型未配置' : '模型 ' + (meta?.defaultModel || '未取到')}
            </span>
            {recalled.length > 0 ? (
              <span className="lw-recalled" title={recalled.map((entry) => entry.text).join('\n')}>
                本轮用到 {recalled.length} 条记忆
              </span>
            ) : null}
            {error ? <span className="lw-top-error">{error}</span> : null}
            <span className="lw-desktop" title="这台电脑上安装的 VisionQA 桌面端版本">
              桌面端 {info?.version ?? '—'}
            </span>
          </div>

          <div className="lw-feed" ref={feedRef}>
            {feed.length === 0 ? (
              <div className="lw-empty">
                <p className="lw-empty-title">这个工作区里能做到的事，都是真的：读目录、读文件、写文件、执行命令。</p>
                <p className="lw-empty-hint">写文件和执行命令之前会先停下来问你。先挑一句开始：</p>
                <div className="lw-starters">
                  {STARTERS.map((text) => (
                    <button
                      key={text}
                      type="button"
                      className="lw-starter"
                      onClick={() => {
                        setDraft(text)
                        draftRef.current?.focus()
                      }}
                    >
                      <span>{text}</span>
                      <ArrowRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {feed.map((item) => {
              if (item.kind === 'user') {
                return (
                  <div key={item.key} className="lw-msg lw-msg--user">
                    <div className="lw-bubble">{item.text}</div>
                  </div>
                )
              }
              if (item.kind === 'assistant') {
                return (
                  <div key={item.key} className="lw-msg">
                    <div className="lw-bubble lw-bubble--assistant">{item.text}</div>
                  </div>
                )
              }
              if (item.kind === 'tool') {
                return (
                  <article key={item.key} className={'lw-tool' + (item.ok === false ? ' is-fail' : '') + (item.phase === 'denied' ? ' is-denied' : '')}>
                    <header className="lw-tool-head">
                      <span className="lw-tool-name">{item.tool}</span>
                      <span className="lw-tool-state">
                        {item.phase === 'call' ? '执行中' : item.phase === 'denied' ? '已拒绝' : item.ok ? '成功' : '失败'}
                      </span>
                    </header>
                    <ArgsView args={item.args} />
                    {item.output ? <pre className="lw-tool-out">{item.output.slice(0, 1200)}</pre> : null}
                  </article>
                )
              }
              if (item.kind === 'approval') {
                // 批准之后只留一行记录：参数和执行结果上面的工具卡已经讲清楚了，不用再占一大块
                if (item.decided) {
                  return (
                    <p key={item.key} className={'lw-decision' + (item.decided === 'deny' ? ' is-deny' : '')}>
                      {item.decided === 'allow' ? '已允许执行' : '已拒绝'} · {item.tool}
                    </p>
                  )
                }
                return (
                  <article key={item.key} className="lw-approval">
                    <header className="lw-approval-head">
                      <ShieldCheck size={15} />
                      <strong>需要你批准：{item.tool}</strong>
                    </header>
                    {item.why ? <p className="lw-approval-why">{item.why}</p> : null}
                    <ArgsView args={item.args} />
                    <div className="lw-approval-actions">
                      <button type="button" className="lw-btn lw-btn--primary" onClick={() => void decide(item, true)}>
                        允许执行
                      </button>
                      <button type="button" className="lw-btn" onClick={() => void decide(item, false)}>
                        拒绝
                      </button>
                    </div>
                  </article>
                )
              }
              if (item.kind === 'compact') {
                return (
                  <div key={item.key} className="lw-compact">
                    <span className="lw-compact-line" aria-hidden="true" />
                    <span>{item.text}</span>
                    <span className="lw-compact-line" aria-hidden="true" />
                  </div>
                )
              }
              if (item.kind === 'error') {
                return (
                  <div key={item.key} className="lw-error">
                    <strong>{item.text}</strong>
                    {item.detail ? <code>{item.detail}</code> : null}
                  </div>
                )
              }
              return (
                <p key={item.key} className="lw-note">
                  {item.text}
                </p>
              )
            })}
          </div>

          <footer className="lw-composer">
            <textarea
              ref={draftRef}
              value={draft}
              rows={2}
              placeholder="让它在工作区里做点什么（Enter 发送，Shift + Enter 换行）"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className="lw-composer-foot">
              <span className="lw-composer-hint">有副作用的操作会先停下来等你批准</span>
              {running ? (
                <button type="button" className="lw-btn" onClick={() => void stop()}>
                  <Square size={13} /> 停止
                </button>
              ) : (
                <button type="button" className="lw-btn lw-btn--primary" onClick={() => void send()} disabled={!draft.trim()}>
                  发送
                </button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </div>
  )
}