import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, MessageSquarePlus, Pencil, Plus, Send, Trash2, Users, X } from 'lucide-react'
import PageHead from '../components/PageHead'
import { listAgents, type AgentRecord } from '../api/agents'
import {
  addRoomAgent,
  createRoom,
  dissolveRoom,
  getRoom,
  listRoomMessages,
  listRooms,
  markRoomRead,
  removeRoomMember,
  roomAgoLabel,
  roomStreamUrl,
  roomTimeLabel,
  sendRoomMessage,
  updateRoom,
  type RoomDetail,
  type RoomMessage,
  type RoomSummary,
} from '../api/rooms'
import '../styles/rooms.css'

// VisionChat 房间（r315，一期 1a）。
//
// 这一版只有「人说话」：房间、成员、历史、未读、SSE 都已经是真的，
// 智能体的发言要等 1b 的接入（令牌 + MCP）接上，所以页面里没有任何
// 「智能体正在输入」「它会回答」这类假装——没接通就不演。
const PAGE_SIZE = 100

const initials = (name: string) => (name || '?').trim().slice(0, 1).toUpperCase()

export default function RoomsPage({ onToast }: { onToast?: (text: string) => void }) {
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
        if (parsed.senderKind !== 'human') void markRoomRead(activeId, parsed.seq).catch(() => {})
      } catch {
        /* 半条 JSON 不算消息：下一帧会被完整事件补上 */
      }
    })
    source.addEventListener('error', () => setStreamState('down'))
    return () => {
      source.close()
      setStreamState('idle')
    }
  }, [activeId, roomState, appendMessage])

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

  const freeAgents = myAgents.filter((agent) => !room?.agents.some((member) => member.agentId === agent.id))

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
                    <span>解散后房间从列表里消失，历史留在服务端。确定？</span>
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
                          ? '智能体已经在房间里了。它们在这里发言要等接入这一步接上——现在先把要做的事说清楚，接上之后它们从这句话接着做。'
                          : '先把要做的事说清楚：这一条作品要投给谁、想让人记住什么。需要帮手就把智能体加进右边。'}
                      </p>
                    </div>
                  ) : null}

                  {messages.map((message) => (
                    <article key={message.id} className={'rooms-msg' + (message.senderKind === 'human' ? ' is-human' : '')}>
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
                    <span>{draft.length ? draft.length + ' / 8000' : '房间里只有你在说话时也会记下来'}</span>
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
                    <strong>{member.name}</strong>
                    <em>{member.role || '智能体'}</em>
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
            <p className="rooms-members-foot">智能体接进来之后才会在这里发言；在那之前，房间只记你说的话。</p>
          </aside>
        </div>
      ) : null}
    </div>
  )
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
