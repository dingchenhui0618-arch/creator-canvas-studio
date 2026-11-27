import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, KeyRound, Loader2, MessageSquarePlus, Pencil, Plus, Send, Trash2, Users, X } from 'lucide-react'
import PageHead from '../components/PageHead'
import { listAgents, type AgentRecord } from '../api/agents'
import {
  addRoomAgent,
  createRoom,
  createRoomPairCode,
  dissolveRoom,
  getRoom,
  getRoomPairCode,
  listRoomMessages,
  listRooms,
  markRoomRead,
  removeRoomMember,
  revokeRoomPairCode,
  roomAgoLabel,
  roomStreamUrl,
  roomTimeLabel,
  sendRoomMessage,
  updateRoom,
  type AgentTool,
  type RoomDetail,
  type RoomMember,
  type RoomMessage,
  type RoomPairCode,
  type RoomSummary,
} from '../api/rooms'
import '../styles/rooms.css'
import type { ToastFn } from '../domain/toast'

// VisionChat 房间（r315，一期 1a）。
//
// 这一版只有「人说话」：房间、成员、历史、未读、SSE 都已经是真的，
// 智能体的发言要等 1b 的接入（令牌 + MCP）接上，所以页面里没有任何
// 「智能体正在输入」「它会回答」这类假装——没接通就不演。
const PAGE_SIZE = 100

const initials = (name: string) => (name || '?').trim().slice(0, 1).toUpperCase()

export default function RoomsPage({ onToast }: { onToast?: ToastFn }) {
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [activeId, setActiveId] = useState('')
  const [room, setRoom] = useState<RoomDetail | null>(null)
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [roomState, setRoomState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')
  const [streamState, setStreamState] = useState<'idle' | 'live' | 'down'>('idle')

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [picking, setPicking] = useState(false)
  const [myAgents, setMyAgents] = useState<AgentRecord[]>([])
  // 接入智能体（r315 1b）：面板里显示一张房间专属的配对码
  const [pairOpen, setPairOpen] = useState(false)
  const [pairCode, setPairCode] = useState<RoomPairCode | null>(null)
  const [pairBusy, setPairBusy] = useState(false)
  const [pairCopied, setPairCopied] = useState(false)
  // 平台智能体回话（r317 1c）：工具清单来自服务端，typing 来自 SSE（不落库）
  const [tools, setTools] = useState<AgentTool[]>([])
  const [typing, setTyping] = useState<Record<string, string>>({})

  const threadRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const bootSeqRef = useRef(-1)

  const refreshList = useCallback(async () => {
    try {
      const result = await listRooms()
      setRooms(result.items || [])
      setListState('ready')
      return result.items || []
    } catch (reason) {
      setListState('error')
      setError(String((reason as Error)?.message || reason))
      return []
    }
  }, [])

  // 首屏：先拿房间列表；一个都没有就停在「新建房间」那个空状态上，不自动建。
  useEffect(() => {
    let alive = true
    void (async () => {
      const items = await refreshList()
      if (!alive || !items.length) return
      setActiveId((current) => current || items[0].id)
    })()
    return () => { alive = false }
  }, [refreshList])

  // 进房：详情 + 最近 100 条。bootSeqRef 记下「我手里最新到哪」，SSE 从这个位置续。
  useEffect(() => {
    if (!activeId) return undefined
    let alive = true
    bootSeqRef.current = -1
    void (async () => {
      setRoomState('loading')
      setError('')
      try {
        const [detail, page] = await Promise.all([getRoom(activeId), listRoomMessages(activeId, { limit: PAGE_SIZE })])
        if (!alive) return
        setRoom(detail.room)
        setTools(detail.tools || [])
        setMessages(page.items || [])
        setRoomState('ready')
        bootSeqRef.current = page.items?.length ? page.items[page.items.length - 1].seq : 0
        setRooms((list) => list.map((item) => (item.id === activeId ? { ...item, unread: 0 } : item)))
        if (detail.room.lastSeq) void markRoomRead(activeId, detail.room.lastSeq).catch(() => {})
      } catch (reason) {
        if (!alive) return
        setRoomState('error')
        setError(String((reason as Error)?.message || reason))
      }
    })()
    return () => { alive = false }
  }, [activeId])

  const appendMessage = useCallback((message: RoomMessage) => {
    setMessages((list) => {
      if (list.some((item) => item.id === message.id)) return list
      if (list.some((item) => item.seq === message.seq)) return list
      return [...list, message].sort((left, right) => left.seq - right.seq)
    })
  }, [])

  // SSE：连上就把状态说成 live；断了浏览器按 retry 自己重连，这里只负责说「在重连」。
  useEffect(() => {
    if (!activeId || roomState !== 'ready' || bootSeqRef.current < 0) return undefined
    const source = new EventSource(roomStreamUrl(activeId, bootSeqRef.current))
    source.addEventListener('open', () => setStreamState('live'))
    source.addEventListener('ready', () => setStreamState('live'))
    source.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as RoomMessage
        if (!parsed?.id) return
        appendMessage(parsed)
        // 它说话了就说明不在打字了：把「正在看」那行收掉（typing 事件丢了也不会一直挂着）
        setTyping((map) => {
          const key = activeId + ':' + parsed.senderMemberId
          if (!map[key]) return map
          const next = { ...map }
          delete next[key]
          return next
        })
        // 房间列表那一行也跟着变：否则左栏一直显示你刚才那句，右栏已经多了回复
        setRooms((list) =>
          list.map((item) =>
            item.id === activeId
              ? { ...item, preview: String(parsed.body || '').slice(0, 120), previewFrom: parsed.senderName, lastAt: parsed.createdAt, lastSeq: parsed.seq }
              : item,
          ),
        )
        if (parsed.senderKind !== 'human') void markRoomRead(activeId, parsed.seq).catch(() => {})
      } catch {
        /* 半条 JSON 不算消息：下一帧会被完整事件补上 */
      }
    })
    // 平台智能体开始/结束写回复（r317）：只活在这条连接上，刷新就没了，不留假消息
    source.addEventListener('typing', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { memberId?: string; name?: string; on?: boolean }
        const memberId = String(parsed.memberId || '')
        if (!memberId) return
        // 键里带房间号：换了房间之后旧房间的残留自然不会再显示，不用在 effect 里清状态
        const key = activeId + ':' + memberId
        setTyping((map) => {
          const next = { ...map }
          if (parsed.on === false) delete next[key]
          else next[key] = String(parsed.name || '智能体')
          return next
        })
      } catch {
        /* 半条 JSON 不算提示 */
      }
    })
    source.addEventListener('error', () => setStreamState('down'))
    return () => {
      source.close()
      setStreamState('idle')
    }
  }, [activeId, roomState, appendMessage])

  // 打开房间就落在最新一条（r317）：平台智能体刚回的那句话不该要用户自己往上翻。
  // 只在「房间刚打开完」这一下贴底；之后交给下面的贴底逻辑，往上翻历史时不会被拽回来。
  useEffect(() => {
    if (roomState !== 'ready') return
    const node = threadRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    stickRef.current = true
  }, [roomState, activeId])

  // 贴底：只有本来就贴着底的时候才跟着新消息走，往上翻历史时不被拽下来。
  useEffect(() => {
    if (!stickRef.current) return
    const node = threadRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages])

  const onThreadScroll = () => {
    const node = threadRef.current
    if (!node) return
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
  }

  const create = async () => {
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      const result = await createRoom({ name })
      setNewName('')
      setRooms((list) => [{ ...summaryOf(result.room), unread: 0, preview: '', previewFrom: '', lastAt: Date.now() }, ...list])
      setActiveId(result.room.id)
      setListState('ready')
      onToast?.('房间建好了')
    } catch (reason) {
      onToast?.(String((reason as Error)?.message || reason))
    } finally {
      setCreating(false)
    }
  }

  const send = async () => {
    const body = draft.trim()
    if (!body || !activeId || sending) return
    setSending(true)
    try {
      const result = await sendRoomMessage(activeId, { body, clientId: clientId() })
      appendMessage(result.message)
      setDraft('')
      stickRef.current = true
      setRooms((list) =>
        list.map((item) =>
          item.id === activeId ? { ...item, preview: body.slice(0, 120), previewFrom: '我', lastAt: Date.now(), lastSeq: result.message.seq } : item,
        ),
      )
      if (result.message.seq) void markRoomRead(activeId, result.message.seq).catch(() => {})
    } catch (reason) {
      onToast?.(String((reason as Error)?.message || reason))
    } finally {
      setSending(false)
    }
  }

  const commitRename = async () => {
    const next = renameText.trim()
    if (!room || !next || next === room.name) {
      setRenaming(false)
      return
    }
    try {
      const result = await updateRoom(room.id, { name: next })
      setRoom(result.room)
      setRooms((list) => list.map((item) => (item.id === room.id ? { ...item, name: result.room.name } : item)))
      setRenaming(false)
    } catch (reason) {
      onToast?.(String((reason as Error)?.message || reason))
    }
  }

  const dissolve = async () => {
    if (!room) return
    try {
      await dissolveRoom(room.id)
      const rest = rooms.filter((item) => item.id !== room.id)
      setRooms(rest)
      setActiveId(rest[0]?.id || '')
      setConfirming(false)
      onToast?.('房间已解散，历史还在服务端留着')
    } catch (reason) {
      onToast?.(String((reason as Error)?.message || reason))
    }
  }

  const openPicker = async () => {
    setPicking((open) => !open)
    if (myAgents.length) return
    try {
      const result = await listAgents()
      setMyAgents(result.items || [])
    } catch {
      /* 读不到就只显示「还没有智能体」，不挡建房 */
    }
  }

  const pickAgent = async (agentId: string) => {
    if (!room) return
    try {
      const result = await addRoomAgent(room.id, agentId)
      setRoom(result.room)
      setPicking(false)
      onToast?.('智能体进房间了')
    } catch (reason) {
      onToast?.(String((reason as Error)?.message || reason))
    }
  }

  const kick = async (memberId: string) => {
    if (!room) return
    try {
      const result = await removeRoomMember(room.id, memberId)
      setRoom(result.room)
    } catch (reason) {
      onToast?.(String((reason as Error)?.message || reason))
    }
  }

  // 接入：先看有没有现成的码（刷新页面不该丢），没有才生成
  const togglePair = async () => {
    if (!room) return
    if (pairOpen) {
      setPairOpen(false)
      return
    }
    setPairOpen(true)
    setPairBusy(true)
    try {
      if (pairCode) return
      const existing = await getRoomPairCode(room.id)
      if (existing.code) {
        setPairCode(existing.code)
        return
      }
      const created = await createRoomPairCode(room.id)
      setPairCode(created.code)
    } catch (reason) {
      onToast?.(String((reason as Error)?.message || reason))
    } finally {
      setPairBusy(false)
    }
  }

  const rotatePair = async () => {
    if (!room) return
    setPairBusy(true)
    try {
      const created = await createRoomPairCode(room.id)
      setPairCode(created.code)
      setPairCopied(false)
      onToast?.('换了一张新码，旧码已失效')
    } catch (reason) {
      onToast?.(String((reason as Error)?.message || reason))
    } finally {
      setPairBusy(false)
    }
  }

  const dropPair = async () => {
    if (!room) return
    setPairBusy(true)
    try {
      await revokeRoomPairCode(room.id)
      setPairCode(null)
      setPairCopied(false)
      onToast?.('码已作废，已经接进来的智能体不受影响')
    } catch (reason) {
      onToast?.(String((reason as Error)?.message || reason))
    } finally {
      setPairBusy(false)
    }
  }

  const copyPair = async () => {
    if (!pairCode) return
    try {
      await navigator.clipboard.writeText(pairCode.code)
      setPairCopied(true)
      window.setTimeout(() => setPairCopied(false), 2000)
      onToast?.('配对码已复制，去交给你的智能体')
    } catch {
      onToast?.('浏览器不让复制，手动选中这 8 位吧：' + pairCode.code)
    }
  }

  // 自动接话开关（r317）：只改 rules.platformReply，其它规则原样带回去，不顺手重置
  const toggleAutoReply = async () => {
    if (!room) return
    const next = room.rules.platformReply === false
    try {
      const result = await updateRoom(room.id, { rules: { ...room.rules, platformReply: next } })
      setRoom(result.room)
      onToast?.(next ? '平台智能体会接着你说的话回' : '自动接话已关，@ 它才回')
    } catch (reason) {
      onToast?.(String((reason as Error)?.message || reason))
    }
  }

  const freeAgents = myAgents.filter((agent) => !room?.agents.some((member) => member.agentId === agent.id))
  const platformAgents = (room?.agents || []).filter((member) => !member.provider || member.provider === 'platform')
  const autoReply = room?.rules.platformReply !== false
  const typingNames = Object.entries(typing)
    .filter(([key]) => key.startsWith(activeId + ':'))
    .map(([, name]) => name)

  return (
    <div className="rooms-page">
      <PageHead
        kicker="Chat · 房间"
        title="聊天室"
        desc="一个房间就是你 + 几个智能体。它们各自有职责，素材、模板和成片都在手边——先把房间搭起来。"
        actions={
          <button type="button" className="rooms-new" onClick={() => document.getElementById('rooms-new-name')?.focus()}>
            <Plus size={15} strokeWidth={1.8} aria-hidden="true" />
            新建房间
          </button>
        }
      />

      {listState === 'error' ? <p className="rooms-error">{error}</p> : null}

      {listState !== 'loading' && !rooms.length ? (
        <section className="rooms-blank">
          <MessageSquarePlus size={22} strokeWidth={1.6} aria-hidden="true" />
          <h2>还没有房间</h2>
          <p>一个房间可以放进多个智能体。建好之后，你在里面说的每一句都会留在房间里，智能体接进来就能接着做。</p>
          <div className="rooms-blank-form">
            <input
              id="rooms-new-name"
              value={newName}
              maxLength={40}
              placeholder="给房间起个名字，比如「双十一预热」"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void create() }}
            />
            <button type="button" onClick={() => void create()} disabled={!newName.trim() || creating}>
              {creating ? <Loader2 size={15} className="rooms-spin" aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
              建房间
            </button>
          </div>
        </section>
      ) : null}

      {rooms.length ? (
        <div className="rooms-shell">
          <aside className="rooms-list" aria-label="房间列表">
            <header className="rooms-list-head">
              <span>房间</span>
              <em>{rooms.length}</em>
            </header>
            <ul>
              {rooms.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={'rooms-row' + (item.id === activeId ? ' is-active' : '')}
                    onClick={() => setActiveId(item.id)}
                    aria-current={item.id === activeId}
                  >
                    <span className="rooms-row-top">
                      <strong>{item.name}</strong>
                      {item.unread ? <span className="rooms-badge">{item.unread > 99 ? '99+' : item.unread}</span> : null}
                    </span>
                    <span className="rooms-row-preview">{item.preview || '还没有人说话'}</span>
                    <span className="rooms-row-time">{item.preview ? roomAgoLabel(item.lastAt) : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="rooms-list-new">
              <input
                value={newName}
                maxLength={40}
                placeholder="新房间的名字"
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void create() }}
              />
              <button type="button" onClick={() => void create()} disabled={!newName.trim() || creating} aria-label="新建房间">
                <Plus size={15} aria-hidden="true" />
              </button>
            </div>
          </aside>

          <section className="rooms-main" aria-label="消息">
            {roomState === 'loading' ? (
              <div className="rooms-loading"><Loader2 size={16} className="rooms-spin" aria-hidden="true" /> 正在打开房间…</div>
            ) : null}
            {roomState === 'error' ? <div className="rooms-error">{error}</div> : null}

            {room ? (
              <>
                <header className="rooms-main-head">
                  {renaming ? (
                    <div className="rooms-rename">
                      <input
                        value={renameText}
                        maxLength={40}
                        autoFocus
                        onChange={(event) => setRenameText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void commitRename()
                          if (event.key === 'Escape') setRenaming(false)
                        }}
                      />
                      <button type="button" onClick={() => void commitRename()} aria-label="保存房间名"><Check size={14} aria-hidden="true" /></button>
                      <button type="button" onClick={() => setRenaming(false)} aria-label="取消改名"><X size={14} aria-hidden="true" /></button>
                    </div>
                  ) : (
                    <h2>{room.name}</h2>
                  )}
                  <span className="rooms-main-meta">
                    {room.agents.length} 个智能体 · {room.approvalMode === 'readonly' ? '只读' : '写操作需批准'}
                    {streamState === 'down' ? ' · 连接断了，正在重连' : ''}
                  </span>
                  {room.isOwner ? (
                    <div className="rooms-main-actions">
                      <button
                        type="button"
                        aria-label="改房间名"
                        onClick={() => { setRenameText(room.name); setRenaming(true) }}
                      >
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button type="button" aria-label="解散房间" onClick={() => setConfirming(true)}>
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </header>

                {confirming ? (
                  <div className="rooms-confirm" role="alertdialog" aria-label="确认解散">
                    <span>解散后房间从列表里消失，聊天记录仍会保留。确定？</span>
                    <button type="button" onClick={() => setConfirming(false)}>再想想</button>
                    <button type="button" className="is-danger" onClick={() => void dissolve()}>解散</button>
                  </div>
                ) : null}

                <div className="rooms-thread" ref={threadRef} onScroll={onThreadScroll}>
                  {!messages.length && roomState === 'ready' ? (
                    <div className="rooms-thread-empty">
                      <h3>房间里还没有人说话</h3>
                      <p>
                        {room.agents.length
                          ? '平台智能体会接着你说的话往下做；自己接进来的 AI 助手要等它读到新消息才回。把目标、受众和限制一次说清楚，它们都看得见。'
                          : '先把要做的事说清楚：这一条作品要投给谁、想让人记住什么。需要帮手就把智能体加进右边。'}
                      </p>
                    </div>
                  ) : null}

                  {messages.map((message) => (
                    <article
                      key={message.id}
                      className={'rooms-msg' + (message.senderKind === 'human' ? ' is-human' : '') + (message.state === 'error' ? ' is-error' : '')}
                    >
                      <div className="rooms-msg-face" aria-hidden="true">{initials(message.senderName)}</div>
                      <div className="rooms-msg-body">
                        <div className="rooms-msg-meta">
                          <strong>{message.senderName}</strong>
                          <time>{roomTimeLabel(message.createdAt)}</time>
                        </div>
                        <p>{message.body}</p>
                      </div>
                    </article>
                  ))}
                  {typingNames.length ? (
                    <div className="rooms-typing" aria-live="polite">
                      <span className="rooms-typing-dots" aria-hidden="true"><i /><i /><i /></span>
                      {typingNames.join('、')} 正在看并写回复
                    </div>
                  ) : null}
                  <div ref={bottomRef} />
                </div>

                <div className="rooms-compose">
                  <textarea
                    value={draft}
                    rows={2}
                    maxLength={8000}
                    placeholder="说点什么…（回车发送，Shift + 回车换行）"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                      event.preventDefault()
                      void send()
                    }}
                  />
                  <div className="rooms-compose-foot">
                    <span>{draft.length ? draft.length + ' / 8000' : composeHint(room, platformAgents)}</span>
                    <button type="button" onClick={() => void send()} disabled={!draft.trim() || sending}>
                      {sending ? <Loader2 size={14} className="rooms-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                      发送
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </section>

          <aside className="rooms-members" aria-label="成员">
            <header>
              <Users size={14} strokeWidth={1.8} aria-hidden="true" />
              成员
            </header>
            <div className="rooms-member-group">
              <span className="rooms-member-label">人</span>
              {room?.members.filter((member) => member.kind === 'human').map((member) => (
                <div key={member.id} className="rooms-member">
                  <span className="rooms-msg-face is-small" aria-hidden="true">{initials(member.name)}</span>
                  <span className="rooms-member-text">
                    <strong>{member.name}</strong>
                    <em>{member.role || '成员'}</em>
                  </span>
                </div>
              ))}
            </div>
            <div className="rooms-member-group">
              <span className="rooms-member-label">智能体</span>
              {!room?.agents.length ? <p className="rooms-member-none">还没有智能体</p> : null}
              {room?.agents.map((member) => (
                <div key={member.id} className="rooms-member">
                  <span className="rooms-msg-face is-small" aria-hidden="true">{initials(member.name)}</span>
                  <span className="rooms-member-text">
                    <strong>
                      {member.name}
                      {member.connected ? <span className="rooms-member-dot" aria-label="已接入" /> : null}
                    </strong>
                    <em>{member.role || '智能体'}</em>
                    <span className="rooms-member-state">{memberStateLabel(member)}</span>
                  </span>
                  {room.isOwner ? (
                    <button type="button" className="rooms-member-x" aria-label={'移出 ' + member.name} onClick={() => void kick(member.id)}>
                      <X size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              ))}
              {room?.isOwner ? (
                <button type="button" className="rooms-member-add" onClick={() => void openPicker()} aria-expanded={picking}>
                  <Plus size={14} aria-hidden="true" />
                  加智能体
                </button>
              ) : null}
              {room?.isOwner ? (
                <button type="button" className="rooms-member-add is-quiet" onClick={() => void togglePair()} aria-expanded={pairOpen}>
                  <KeyRound size={14} aria-hidden="true" />
                  接入我的智能体
                </button>
              ) : null}
              {pairOpen ? (
                <div className="rooms-pair">
                  {pairCode ? (
                    <>
                      <div className="rooms-pair-code">
                        <code>{pairCode.code}</code>
                        <button type="button" className="rooms-pair-copy" onClick={() => void copyPair()} aria-label="复制配对码">
                          {pairCopied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                        </button>
                      </div>
                      <p className="rooms-pair-note">
                        24 小时内有效 · 已接 {pairCode.used}/{pairCode.max} 个 · 只对这个房间有效
                      </p>
                      <p className="rooms-pair-hint">
                        交给你自己的 AI 助手：让它读 <a href="/visionchat.md" target="_blank" rel="noreferrer">/visionchat.md</a>，自己换令牌进房间。
                      </p>
                      <div className="rooms-pair-actions">
                        <button type="button" onClick={() => void rotatePair()} disabled={pairBusy}>
                          {pairBusy ? <Loader2 size={13} className="rooms-spin" aria-hidden="true" /> : null}
                          换一张码
                        </button>
                        <button type="button" className="is-quiet" onClick={() => void dropPair()} disabled={pairBusy}>
                          作废
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="rooms-pair-note">
                      {pairBusy ? '正在生成配对码…' : '这张码已经作废了，换一张就能继续接。'}
                    </p>
                  )}
                </div>
              ) : null}
              {picking ? (
                <div className="rooms-picker">
                  {!freeAgents.length ? <p>没有可以再加的了，先去「快捷创作」建一个。</p> : null}
                  {freeAgents.map((agent) => (
                    <button key={agent.id} type="button" onClick={() => void pickAgent(agent.id)}>
                      <strong>{agent.name}</strong>
                      <em>{agent.role}</em>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {platformAgents.length ? (
              <p className="rooms-members-foot">
                平台智能体每轮 1 积分，答不上来全额退回。
                {room?.isOwner ? (
                  <button type="button" className="rooms-auto" onClick={() => void toggleAutoReply()} aria-pressed={autoReply}>
                    {autoReply ? '自动接话：开' : '自动接话：关'}
                  </button>
                ) : null}
              </p>
            ) : (
              <p className="rooms-members-foot">
                接进来的智能体就在这个房间里说话；没接的只有你在说。令牌只给说话权——生图、生视频、评审仍然要在界面里由你点。
              </p>
            )}
            {tools.length ? (
              <p className="rooms-members-foot is-tools">
                平台智能体现在能用：{tools.filter((tool) => tool.enabled).map((tool) => tool.label).join('、') || '暂无'}
                {tools.some((tool) => !tool.enabled) ? ' · 另外 ' + tools.filter((tool) => !tool.enabled).length + ' 个还没开' : ''}
              </p>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  )
}

// 输入框下面那行提示（r317）：房间里有平台智能体时，把「它会回、回一轮多少钱」讲清楚，
// 别让人发完才在积分账本里发现扣了分。
function composeHint(room: RoomDetail | null, platform: RoomMember[]): string {
  if (!room) return ''
  if (!platform.length) return '房间里只有你在说话时也会记下来'
  if (room.rules.platformReply === false) return '自动接话已关：@ 平台智能体才回 · 每轮 1 积分'
  return platform.length === 1
    ? '平台智能体会接话 · 每轮 1 积分，失败自动退回'
    : '多个平台智能体时只接 @ 的那一个 · 每轮 1 积分'
}

// 成员行下面那行小字：接进来的说「多久前在线」，没接的说明它是平台智能体还是已经断开
function memberStateLabel(member: RoomMember): string {
  if (member.connected) return member.lastSeenAt ? '已接入 · ' + roomAgoLabel(member.lastSeenAt) + '在线' : '已接入 · 还没说过话'
  if (member.provider === 'platform' || !member.provider) return '平台智能体'
  return '已断开 · 重新接一个'
}

// 建房返回的是 RoomDetail，列表用的是 RoomSummary：只差几个统计字段，补齐即可。
function summaryOf(room: RoomDetail): RoomSummary {
  return {
    id: room.id,
    name: room.name,
    topic: room.topic,
    ownerId: room.ownerId,
    rules: room.rules,
    approvalMode: room.approvalMode,
    memberId: room.memberId,
    unread: 0,
    lastSeq: room.lastSeq,
    preview: '',
    previewFrom: '',
    lastAt: Date.now(),
    createdAt: room.createdAt,
    isOwner: room.isOwner,
  }
}

function clientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().slice(0, 32)
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
