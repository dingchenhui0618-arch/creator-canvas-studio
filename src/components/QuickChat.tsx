import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Brain, ChevronDown, FileText, Link2, Loader2, MessageSquarePlus, Paperclip, Search, Square, Trash2, X } from 'lucide-react'
import {
  createChatConversation,
  deleteChatConversation,
  getChatConversation,
  listChatConversations,
  streamChatMessage,
  uploadChatFile,
} from '../api/chat'
import type { ChatConversation, ChatFile, ChatSummary, ChatToolOptions } from '../api/chat'
import { getCredits } from '../api/credits'
import { renderMarkdown } from '../lib/markdown'

// 快捷创作的「对话」（r214）：一页 DeepSeek —— 长上下文、联网搜索、读链接、思考模式。
// 为什么单独一个组件：原来那块是「对话预设」的短轮问答（带输出类型与结构化草稿），
// 数据形状、扣费口径、上下文长度都不一样；混在一个组件里两边都会越改越乱。
//
// 取舍（写清楚，免得后面有人以为漏了）：
//  - 流式输出（r217）：一边生成一边显示，第一段字通常在 1 秒级出现；
//    右上角按钮变成「停止」，停止 = 断开连接，服务端中止上游并全额退款，不留半截回答；
//  - 失败、空回复、停止都全额退回，界面明说「积分已退回」，余额当场刷新；
//  - 会话在服务端：换设备、关页面回来都还在，最多 30 条会话、每条留 200 条消息；
//  - 附件（r218）：脚本、Word、Excel、PDF 先在服务端读成文字，再连同问题一起问模型；
//    解析在本地做（不上传原始文件给上游），扫描件里的字读不出会直说，不做假 OCR。
// short：手机上输入框常驻贴底，四个能力一行放不下四个字的标签，
// 窄屏只留两个字（搜索 / 链接 / 思考 / 附件），完整说明挂在 title 与 aria-label 上。
const TOOL_ITEMS: { id: keyof ChatToolOptions; label: string; short: string; hint: string; icon: typeof Search }[] = [
  { id: 'search', label: '联网搜索', short: '联网', hint: '回答前先搜一遍最新信息，带链接回来', icon: Search },
  { id: 'readUrl', label: '读链接', short: '链接', hint: '消息里带网址时，先把页面读下来再回答', icon: Link2 },
  { id: 'thinking', label: '思考模式', short: '思考', hint: '先推理再回答，慢一些，适合拆结构', icon: Brain },
]

const TOOLS_KEY = 'vq:chatTools'
// 附件上限与界面提示要与服务端一致（server/chat-files.mjs 的 CHAT_FILE_LIMITS）：
// 服务端才是真拒绝的地方，这里只提前告诉用户，不靠它兜底。
const MAX_ATTACH = 5
const MAX_FILE_BYTES = 8 * 1024 * 1024
const ATTACH_ACCEPT = '.txt,.md,.markdown,.csv,.tsv,.json,.log,.srt,.docx,.xlsx,.pdf,.ts,.tsx,.js,.jsx,.py,.html,.htm,.css,.yaml,.yml'

function loadTools(): ChatToolOptions {
  try {
    const raw = JSON.parse(window.localStorage.getItem(TOOLS_KEY) || '{}')
    return { search: Boolean(raw.search), readUrl: Boolean(raw.readUrl), thinking: Boolean(raw.thinking) }
  } catch {
    return { search: false, readUrl: false, thinking: false }
  }
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 40)
  }
}

function when(at: number) {
  if (!at) return ''
  const date = new Date(at)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return hh + ':' + mm
}

export default function QuickChat({ onToast }: { onToast?: (text: string) => void }) {
  const [items, setItems] = useState<ChatSummary[]>([])
  const [current, setCurrent] = useState<ChatConversation | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [opening, setOpening] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [error, setError] = useState('')
  const [tools, setTools] = useState<ChatToolOptions>(() => loadTools())
  const [credits, setCredits] = useState<{ balance: number | null; unit: string; price: number } | null>(null)
  // 附件：attached 是这一轮要带的，preview 是「平台读到的到底是什么字」的原文预览
  const [attached, setAttached] = useState<ChatFile[]>([])
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState('')
  const [preview, setPreview] = useState<{ name: string; text: string; note: string } | null>(null)
  // 手机上一列排（≤900px）：会话列表默认收成一条窄条，点开才展开。
  // 桌面左栏不受影响——这个状态只决定窄屏那条列表展不展开（CSS 里只在窄屏生效）。
  const [listOpen, setListOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // 只有「本来就在底部」才跟着滚：长回答往上翻着看的时候，每来一段就把人拽回底部很难用
  const stickRef = useRef(true)

  const messages = current?.messages ?? []

  const refreshList = useCallback(async () => {
    try {
      const result = await listChatConversations()
      setItems(result.items || [])
      return result.items || []
    } catch {
      return []
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    void refreshList()
    getCredits(1)
      .then((data) => setCredits({ balance: data.balance ?? null, unit: data.unit || '积分', price: Number(data.prices?.chat || 0) }))
      .catch(() => undefined)
  }, [refreshList])

  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, sending, streaming.length])

  const openConversation = useCallback(async (id: string) => {
    if (opening || sending) return
    setOpening(id)
    setError('')
    try {
      const result = await getChatConversation(id)
      setCurrent(result.conversation)
      // 手机上选完就把列表收起来，否则答案被挤在列表下面
      setListOpen(false)
    } catch {
      setError('这条对话读不到了，可能已被删除')
    } finally {
      setOpening('')
    }
  }, [opening, sending])

  const toggleTool = useCallback((id: keyof ChatToolOptions) => {
    setTools((currentTools) => {
      const next = { ...currentTools, [id]: !currentTools[id] }
      try { window.localStorage.setItem(TOOLS_KEY, JSON.stringify(next)) } catch { /* 隐私模式忽略 */ }
      return next
    })
  }, [])

  const newConversation = useCallback(() => {
    setCurrent(null)
    setDraft('')
    setError('')
    setAttached([])
    setAttachError('')
    setPreview(null)
    setListOpen(false)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const pickFiles = useCallback(async (list: FileList | null) => {
    if (!list || !list.length) return
    setAttachError('')
    setAttaching(true)
    const room = Math.max(0, MAX_ATTACH - attached.length)
    const pending = Array.from(list)
    if (pending.length > room) setAttachError('一条消息最多 ' + MAX_ATTACH + ' 个附件，多的这几个先没带上')
    const added: ChatFile[] = []
    for (const file of pending.slice(0, room)) {
      if (file.size > MAX_FILE_BYTES) {
        setAttachError(file.name + ' 有 ' + (file.size / 1024 / 1024).toFixed(1) + ' MB，超过 8 MB 上限：先压一下或截取要用的部分')
        continue
      }
      try {
        added.push(await uploadChatFile(file))
      } catch (caught) {
        // 服务端的拒绝都是人话（「扫描件读不出字」这类），原样显示，不自己编一个
        setAttachError(file.name + '：' + (caught instanceof Error ? caught.message : '上传失败，稍后再试'))
      }
    }
    if (added.length) setAttached((list) => [...list, ...added].slice(0, MAX_ATTACH))
    setAttaching(false)
    if (fileRef.current) fileRef.current.value = ''
  }, [attached.length])

  const removeAttached = useCallback((id: string) => {
    setAttached((list) => list.filter((item) => item.id !== id))
    setPreview(null)
  }, [])

  // 点附件名看原文：解析错了（比如 PDF 只读到半页）用户得能自己看见，而不是只信平台的说法
  const openPreview = useCallback(async (id: string, name: string) => {
    try {
      const response = await fetch('/api/chat/files/' + id)
      const body = (await response.json()) as { ok?: boolean; file?: ChatFile; text?: string; error?: string }
      if (!response.ok || !body?.file) throw new Error(body?.error || 'HTTP ' + response.status)
      setPreview({ name: body.file.name || name, text: body.text || '', note: body.file.note || '' })
    } catch (caught) {
      setAttachError((caught instanceof Error ? caught.message : '这个附件的内容读不到了'))
    }
  }, [])

  const removeConversation = useCallback(async (id: string) => {
    if (!window.confirm('删除这条对话？删了就找不回来了。')) return
    try {
      await deleteChatConversation(id)
      setItems((list) => list.filter((item) => item.id !== id))
      if (current?.id === id) setCurrent(null)
      onToast?.('已删除这条对话')
    } catch {
      onToast?.('删除失败，稍后重试')
    }
  }, [current?.id, onToast])

  const send = useCallback(async () => {
    const content = draft.trim()
    if (!content || sending || attaching) return
    const files = attached
    setSending(true)
    setError('')
    setStreaming('')
    const controller = new AbortController()
    abortRef.current = controller
    const before = current
    // 先在本地把用户这句放上去：流式首字也有延迟，空着会让人以为没点中
    const optimistic = { id: 'local-' + Date.now(), role: 'user' as const, content, at: Date.now(), files }
    // 新对话也先把这句挂上去：否则「空状态说明」会和正在生成的回答叠在一起，
    // 看起来像「还没有对话」却已经有答案在流（r217 截图时发现的排版问题）。
    setCurrent({
      ...(before ?? { id: 'local', title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }),
      messages: [...(before?.messages ?? []), optimistic],
    })
    setDraft('')
    setAttached([])
    setPreview(null)
    let conversationId = before?.id || ''
    try {
      let conversation = before
      if (!conversation) {
        const created = await createChatConversation()
        conversation = created.conversation
      }
      conversationId = conversation.id
      const result = await streamChatMessage(
        conversation.id,
        { content, tools, files: files.map((item) => item.id) },
        {
          signal: controller.signal,
          onDelta: (text) => setStreaming((value) => value + text),
        },
      )
      setStreaming('')
      setCurrent(result.conversation)
      if (typeof result.balance === 'number') setCredits((value) => (value ? { ...value, balance: result.balance } : value))
      void refreshList()
    } catch (caught) {
      setStreaming('')
      // 发送失败把附件放回输入框：不然用户得重新挑一遍文件
      if (files.length) setAttached((list) => (list.length ? list : files))
      const stopped = controller.signal.aborted
      setError(stopped ? '已停止生成，这次不计费（积分已退回）' : caught instanceof Error ? caught.message : '这次没有回上来，稍后再试')
      // 以服务端为准：用户这句话已经落库，回答要么没有、要么是上一次的；
      // 本地那份乐观消息（可能带半截回答）不能留着，否则会和服务端越走越远。
      if (conversationId) {
        try {
          const fresh = await getChatConversation(conversationId)
          setCurrent(fresh.conversation)
        } catch {
          if (before) setCurrent(before)
        }
      } else {
        setCurrent(before ?? null)
      }
      getCredits(1)
        .then((data) => setCredits((value) => (value ? { ...value, balance: data.balance ?? null } : value)))
        .catch(() => undefined)
      void refreshList()
    } finally {
      setSending(false)
      abortRef.current = null
    }
  }, [attached, attaching, current, draft, refreshList, sending, tools])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const toolCount = useMemo(() => TOOL_ITEMS.filter((item) => tools[item.id]).length, [tools])

  return (
    <div className="qc-root">
      <aside className={'qc-side' + (listOpen ? ' is-open' : '')} aria-label="对话列表">
        <div className="qc-side-head">
          <button type="button" className="qc-new" onClick={newConversation}>
            <MessageSquarePlus size={15} />
            新对话
          </button>
          <span className="qc-count">{items.length}</span>
          {/* 窄屏专用：把「历史对话」收成一条，点开才展开列表；桌面上这枚按钮不显示 */}
          <button
            type="button"
            className="qc-side-toggle"
            aria-expanded={listOpen}
            aria-controls="qc-conv-list"
            onClick={() => setListOpen((value) => !value)}
          >
            <span className="qc-side-toggle-text">{current?.title || '历史对话'}</span>
            <ChevronDown size={14} className="qc-side-toggle-icon" aria-hidden="true" />
          </button>
        </div>
        <div className="qc-list" id="qc-conv-list">
          {loadingList && <p className="qc-side-empty">正在读取…</p>}
          {!loadingList && items.length === 0 && <p className="qc-side-empty">还没有对话。写下第一句就开始。</p>}
          {items.map((item) => (
            <div className={'qc-conv' + (current?.id === item.id ? ' is-active' : '')} key={item.id}>
              <button type="button" className="qc-conv-main" onClick={() => void openConversation(item.id)} disabled={Boolean(opening)}>
                <span className="qc-conv-title">{item.title}</span>
                <span className="qc-conv-meta">
                  {item.messageCount} 条 · {when(item.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="qc-conv-del"
                aria-label={'删除对话：' + item.title}
                title="删除这条对话"
                onClick={() => void removeConversation(item.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <p className="qc-side-note">会话存在服务端，换设备回来还在；最多 30 条，旧的会自动腾位置。</p>
      </aside>

      <div className="qc-main">
        <div
          className="qc-thread"
          aria-live="polite"
          onScroll={(event) => {
            const el = event.currentTarget
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
        >
          {messages.length === 0 ? (
            <div className="qc-empty">
              <strong>一页能记住上下文的对话</strong>
              <p>写脚本、拆爆款结构、改分镜、问平台怎么用，都可以直接说。带链接时打开「读链接」，要最新信息时打开「联网搜索」。</p>
              <ul>
                <li>边生成边显示，首段字通常一两秒就到，不用干等整段</li>
                <li>生成中途点右上角方块可以停，停止不计费；失败也全额退回</li>
                <li>上下文带最近 30 条，不是只记上一句</li>
                <li>脚本、Word、Excel、PDF 可以直接丢进来，平台先在本地读成文字再回答；扫描件里的字读不出，会直接说</li>
                <li>每次对话 {credits?.price ? credits.price + ' ' + credits.unit : '按次计费'}；联网搜索与读链接都是平台自带能力</li>
              </ul>
            </div>
          ) : (
            messages.map((message) => (
              <div className={'qc-msg qc-msg--' + message.role} key={message.id}>
                {message.role === 'assistant' ? (
                  <div className="qc-bubble qc-md agx-md">{renderMarkdown(message.content)}</div>
                ) : (
                  <div className="qc-bubble">{message.content}</div>
                )}
                {message.files?.length ? (
                  <div className="qc-files">
                    {message.files.map((file) => (
                      <button
                        type="button"
                        key={file.id}
                        className="qc-file"
                        title={file.note || '看平台读到的文字'}
                        onClick={() => void openPreview(file.id, file.name)}
                      >
                        <FileText size={12} />
                        <span className="qc-file-name">{file.name}</span>
                        <span className="qc-file-meta">{file.chars} 字{file.truncated ? ' · 已截断' : ''}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {message.links?.length ? (
                  <div className="qc-links">
                    {message.links.map((link) => (
                      <span className={'qc-link' + (link.ok ? '' : ' is-failed')} key={link.url} title={link.ok ? (link.finalUrl || link.url) : link.note}>
                        <Link2 size={12} />
                        <span className="qc-link-name">{link.title || hostOf(link.url)}</span>
                        <span className="qc-link-meta">{link.ok ? link.chars + ' 字' + (link.truncated ? ' · 已截断' : '') : '没读到'}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="qc-msg-meta">
                  <span>{message.role === 'user' ? '你' : '平台对话模型'}</span>
                  <span>{when(message.at)}</span>
                  {message.model ? <span>{message.model}</span> : null}
                  {message.ms ? <span>{(message.ms / 1000).toFixed(1)}s</span> : null}
                </div>
              </div>
            ))
          )}
          {sending && (
            <div className="qc-msg qc-msg--assistant">
              {streaming ? (
                <>
                  <div className="qc-bubble qc-bubble--stream">
                    {streaming}
                    <span className="qc-caret" aria-hidden="true" />
                  </div>
                  <div className="qc-msg-meta">
                    <span>正在生成，可以随时停止</span>
                  </div>
                </>
              ) : (
                <div className="qc-bubble qc-bubble--running">
                  <Loader2 size={14} className="qc-spin" />
                  {tools.thinking ? '正在思考并回答…' : tools.search ? '正在检索并回答…' : '正在回答…'}
                </div>
              )}
            </div>
          )}
          <div ref={bottomRef} className="qc-bottom" />
        </div>

        {error && <div className="qc-error" role="alert">{error}</div>}

        <div className="qc-composer">
          <div className="qc-tools">
            {TOOL_ITEMS.map((item) => {
              const Icon = item.icon
              const active = tools[item.id]
              return (
                <button
                  type="button"
                  key={item.id}
                  className={'qc-tool' + (active ? ' is-on' : '')}
                  aria-pressed={active}
                  aria-label={item.label}
                  title={item.hint}
                  onClick={() => toggleTool(item.id)}
                  disabled={sending}
                >
                  <Icon size={14} />
                  <span className="qc-tool-full">{item.label}</span>
                  <span className="qc-tool-short">{item.short}</span>
                </button>
              )
            })}
            <button
              type="button"
              className={'qc-tool qc-tool--attach' + (attached.length ? ' is-on' : '')}
              onClick={() => fileRef.current?.click()}
              disabled={sending || attaching}
              title="附件：脚本、Word、Excel、PDF；平台先在本地读成文字再回答"
              aria-label="附件"
            >
              {attaching ? <Loader2 size={14} className="qc-spin" /> : <Paperclip size={14} />}
              {attaching ? '解析中…' : attached.length ? '附件 ' + attached.length : '附件'}
            </button>
            <input
              ref={fileRef}
              type="file"
              className="qc-file-input"
              multiple
              accept={ATTACH_ACCEPT}
              onChange={(event) => void pickFiles(event.target.files)}
            />
            <span className="qc-credit">
              {/* 单位只写一次会看不懂（r224 实测线上一直是「余额 100 积分 · 每次 1」——
                  1 什么？）：价格后面也带上同一套单位。 */}
              {credits
                ? '余额 ' + (credits.balance ?? '—') + ' ' + credits.unit + (credits.price ? ' · 每次 ' + credits.price + ' ' + credits.unit : '')
                : ''}
            </span>
          </div>
          {attached.length > 0 && (
            <div className="qc-attach-row">
              {attached.map((file) => (
                <span className="qc-chip" key={file.id}>
                  <button
                    type="button"
                    className="qc-chip-main"
                    title={file.note || '看平台读到的文字'}
                    onClick={() => void openPreview(file.id, file.name)}
                  >
                    <FileText size={12} />
                    <span className="qc-chip-name">{file.name}</span>
                    <span className="qc-chip-meta">{file.chars} 字{file.truncated ? ' · 已截断' : ''}</span>
                  </button>
                  <button
                    type="button"
                    className="qc-chip-x"
                    aria-label={'移除附件 ' + file.name}
                    title="移除这个附件"
                    onClick={() => removeAttached(file.id)}
                    disabled={sending}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {attachError && <div className="qc-error qc-error--inline" role="alert">{attachError}</div>}
          {preview && (
            <div className="qc-preview">
              <div className="qc-preview-head">
                <span>{preview.name}{preview.note ? ' · ' + preview.note : ''}</span>
                <button type="button" className="qc-chip-x" aria-label="收起附件原文" title="收起" onClick={() => setPreview(null)}>
                  <X size={12} />
                </button>
              </div>
              <pre className="qc-preview-body">{preview.text.slice(0, 1200)}{preview.text.length > 1200 ? '\n…' : ''}</pre>
            </div>
          )}
          <div className="qc-input-row">
            {/* 窄屏文本域固定两行（64px），提示语要放得下两行，否则第三个字行会被切一半；
                更长的用法示例放在空状态与「附件」的 title 里（r223） */}
            <textarea
              ref={inputRef}
              className="qc-input"
              rows={3}
              value={draft}
              placeholder="说清你要什么，例如：口播拆分镜"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  void send()
                }
              }}
              disabled={sending}
            />
            {sending ? (
              <button type="button" className="qc-send qc-send--stop" onClick={stop} aria-label="停止生成" title="停止生成（这次不计费，积分全额退回）">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button type="button" className="qc-send" onClick={() => void send()} disabled={!draft.trim() || attaching} aria-label="发送" title="发送（Ctrl + Enter）">
                <ArrowUp size={18} />
              </button>
            )}
          </div>
          <div className="qc-hint">
            <span>
              {sending
                ? '生成中点方块可停止，停止不计费'
                : !tools.readUrl && /https?:\/\//i.test(draft)
                  ? '消息里有链接：打开「读链接」，我才会先把页面读下来'
                  : 'Ctrl + Enter 发送 · 附件最多 5 个、单个 8 MB'}
            </span>
            <span>{toolCount ? toolCount + ' 项能力已打开' : '能力全关：只按对话回答'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
