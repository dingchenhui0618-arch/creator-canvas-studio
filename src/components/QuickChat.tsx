import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Brain, Check, ChevronDown, Copy, FileText, Link2, Loader2, MessageSquarePlus, Paperclip, Search, Square, Trash2, X } from 'lucide-react'
import {
  createChatConversation,
  deleteChatConversation,
  getChatConversation,
  listChatConversations,
  chatFileRawUrl,
  getChatSearch,
  streamChatMessage,
  uploadChatFile,
} from '../api/chat'
import type { ChatConversation, ChatFile, ChatMediaOptions, ChatSearchStatus, ChatSummary, ChatToolOptions } from '../api/chat'
import { getCredits } from '../api/credits'
import { safeFetch } from '../api/client'
import { renderMarkdown } from '../lib/markdown'
import { markdownPlainText } from '../lib/markdown-parse'
import MediaTaskCard from './MediaTaskCard'
import type { ToastFn } from '../domain/toast'

// 快捷创作的「对话」（r214）：一页 DeepSeek —— 长上下文、联网搜索、读链接、思考模式。
// 为什么单独一个组件：原来那块是「对话预设」的短轮问答（带输出类型与结构化草稿），
// 数据形状、扣费口径、上下文长度都不一样；混在一个组件里两边都会越改越乱。
//
// 取舍（写清楚，免得后面有人以为漏了）：
//  - 流式输出（r217）：一边生成一边显示，第一段字通常在 1 秒级出现；
//    右上角按钮变成「停止」，停止 = 断开连接，服务端中止上游并全额退款，不留半截回答；
//  - 失败、空回复、停止都全额退回，界面明说「积分已退回」，余额当场刷新；
//  - 会话在服务端：换设备、关页面回来都还在，最多 30 条会话、每条留 200 条消息；
//  - 两处上限都不静默：会话满了说挪掉的是哪条（r247），消息超过 200 条说少了多少条（r248）；
//  - 附件（r218）：脚本、Word、Excel、PDF 先在服务端读成文字，再连同问题一起问模型；
//    解析在本地做（不上传原始文件给上游），扫描件里的字读不出会直说，不做假 OCR。
// short：手机上输入框常驻贴底，四个能力一行放不下四个字的标签，
// 窄屏只留两个字（搜索 / 链接 / 思考 / 附件），完整说明挂在 title 与 aria-label 上。
// r247：Enter 发送、Shift+Enter 换行（输入法组词时不发）；每段回答一键复制纯文本；
// 会话列表满 30 条、最早一条被腾掉时明确说出来（以前是悄悄删）。
const TOOL_ITEMS: { id: keyof ChatToolOptions; label: string; short: string; hint: string; icon: typeof Search }[] = [
  { id: 'search', label: '联网搜索', short: '联网', hint: '平台自己搜一遍最新信息，再把前几条网页读成文字', icon: Search },
  { id: 'readUrl', label: '读链接', short: '链接', hint: '消息里带网址时，先把页面读下来再回答', icon: Link2 },
  { id: 'thinking', label: '思考模式', short: '思考', hint: '先推理再回答，慢一些，适合拆结构', icon: Brain },
]

const TOOLS_KEY = 'vq:chatTools'
// 附件上限与界面提示要与服务端一致（server/chat-files.mjs 的 CHAT_FILE_LIMITS）：
// 服务端才是真拒绝的地方，这里只提前告诉用户，不靠它兜底。
const MAX_ATTACH = 5
const MAX_FILE_BYTES = 8 * 1024 * 1024
// r245：图片也走同一个附件入口，但本地不转文字——原图随这一轮交给模型看，图里的字由模型自己读。
const ATTACH_ACCEPT = '.txt,.md,.markdown,.csv,.tsv,.json,.log,.srt,.docx,.xlsx,.pdf,.ts,.tsx,.js,.jsx,.py,.html,.htm,.css,.yaml,.yml,.png,.jpg,.jpeg,.webp,.gif'

function isImageFile(file: ChatFile) {
  return file.kind === 'image'
}

/**
 * 这一句看起来像生成指令吗（r288 / r293）——**只用来提前说清要扣费**，不参与判定。
 * 真判定在 server/media-intent.mjs；这里漏判最多是少一句提示，误判也不会让服务端多扣钱。
 */
function looksLikeGenCommand(draft: string) {
  const text = draft.replace(/^\s+/, '')
  if (/^\/(生图|生视频|图|视频|画图)(\s|$)/.test(text)) return true
  const polite = /^(请|帮我|帮忙|麻烦|给我|我想|我要|能不能|可以)+/.exec(text)
  const rest = polite ? text.slice(polite[0].length) : text
  return /^(出|做|来|拍|整|生成|搞|画)(一|两|个|条|段|支|张|幅|期){0,2}\s*(短视频|视频|图片|图|海报|封面)/.test(rest)
}

// ── 生成设置（r342） ────────────────────────────────────────────────────────
// 用户在对话框里选的比例 / 画质 / 时长 / 分辨率走请求体的 media 字段，不再写进提示词、也不被
// 服务端的默认档顶掉。三件事在这里定死口径：
//  ① 「跟随提示词 / 跟随默认」= 空值 = 这个键根本不发（服务端契约就是「未选不传」），
//     所以默认状态下这一整块控件等于不存在，行为和这条改动之前完全一致；
//  ② 档位只画控件、不做判定：哪一档有效、上游收不收在服务端（server/media-models.mjs 的
//     IMAGE_QUALITIES / VIDEO_RATIOS / VIDEO_DURATIONS / VIDEO_RESOLUTIONS），前端写死一套迟早对不上；
//  ③ 界面写中文、请求发服务端的值：用户认的是「高清」，不是 high。
type GenChoice = { value: string; label: string; short: string }

// 比例给的是「在对话框里能选」的那几个常用档，不是全部：要更冷门的比例仍然可以直接写在提示词里
// （服务端认写死的参数并原样提交），两个入口都留着。
const GEN_IMAGE_RATIOS: GenChoice[] = [
  { value: '', label: '跟随提示词', short: '提示词' },
  { value: '1:1', label: '1:1', short: '1:1' },
  { value: '9:16', label: '9:16', short: '9:16' },
  { value: '16:9', label: '16:9', short: '16:9' },
  { value: '3:4', label: '3:4', short: '3:4' },
  { value: '4:5', label: '4:5', short: '4:5' },
]

const GEN_VIDEO_RATIOS: GenChoice[] = [
  { value: '', label: '跟随提示词', short: '提示词' },
  { value: '9:16', label: '9:16', short: '9:16' },
  { value: '16:9', label: '16:9', short: '16:9' },
  { value: '1:1', label: '1:1', short: '1:1' },
]

// 画质三档的值与服务端白名单同名（low / medium / high）：界面上的中文只是显示名。
const GEN_QUALITIES: GenChoice[] = [
  { value: '', label: '跟随默认', short: '默认' },
  { value: 'low', label: '快速', short: '快速' },
  { value: 'medium', label: '标准', short: '标准' },
  { value: 'high', label: '高清', short: '高清' },
]

const GEN_DURATIONS: GenChoice[] = [
  { value: '', label: '跟随提示词', short: '提示词' },
  { value: '4', label: '4 秒', short: '4 秒' },
  { value: '8', label: '8 秒', short: '8 秒' },
]

const GEN_RESOLUTIONS: GenChoice[] = [
  { value: '', label: '跟随提示词', short: '提示词' },
  { value: '480p', label: '480p', short: '480p' },
  { value: '720p', label: '720p', short: '720p' },
]

/**
 * 这一句是出图还是出视频（r342）：只决定参数行画哪几个控件。
 * 真判定仍在服务端（server/media-intent.mjs）——这里认错最多是多画 / 少画一个下拉，
 * 不会让服务端按错的参数扣费，所以用一个够用的词序判断，不做第二套语法。
 */
function genCommandKind(draft: string): '' | 'image' | 'video' {
  const text = draft.replace(/^\s+/, '')
  if (!looksLikeGenCommand(text)) return ''
  // 只看开头一小段：「参考这个视频的节奏，出一张图」不该因为后半句有「视频」就被当成出视频
  const head = text.slice(0, 24)
  const video = head.search(/视频|短片|影片/)
  const image = head.search(/图片|图|海报|封面|插画|照片|头像|壁纸/)
  if (video >= 0 && (image < 0 || video < image)) return 'video'
  if (image >= 0) return 'image'
  return /^\/生视频/.test(text) ? 'video' : 'image'
}

/**
 * 这一轮要发给服务端的 media（r342）：只放真正选了的键，一个都没选就整块不带。
 * 取值都先对一遍档位：切图片 / 视频时上一档可能不在新控件的档位里（3:4 没有视频档），
 * 对不上的当没选——渲染出的当前值也是同一套口径，界面看到的和发出去的不会两样。
 */
function mediaChoiceOf(
  draft: string,
  picked: { ratio: string; quality: string; duration: string; resolution: string },
): ChatMediaOptions | undefined {
  const kind = genCommandKind(draft)
  if (!kind) return undefined
  const valid = (options: GenChoice[], value: string) =>
    options.some((option) => option.value === value) ? value : ''
  const choice: ChatMediaOptions = {}
  const ratio = valid(kind === 'video' ? GEN_VIDEO_RATIOS : GEN_IMAGE_RATIOS, picked.ratio)
  if (ratio) choice.ratio = ratio
  if (kind === 'video') {
    const duration = valid(GEN_DURATIONS, picked.duration)
    if (duration) choice.duration = Number(duration)
    const resolution = valid(GEN_RESOLUTIONS, picked.resolution)
    if (resolution) choice.resolution = resolution
  } else {
    const quality = valid(GEN_QUALITIES, picked.quality)
    // 档位表里只有这三档，对上了才发：服务端的白名单之外它会直接拒（MEDIA_QUALITY）
    if (quality === 'low' || quality === 'medium' || quality === 'high') choice.quality = quality
  }
  return Object.keys(choice).length ? choice : undefined
}

/**
 * 生成设置的一枚下拉胶囊（r342）：与输入卡里的能力按钮同一套 28px 胶囊语言。
 * 为什么是下拉而不是把档位摊平：390 宽一行放不下「6 个比例 + 4 档画质」，
 * 摊平会折成三四行、把输入框往上顶；下拉是同一条紧凑行，当前值照样一眼看得见。
 */
function GenSelect({
  label,
  value,
  options,
  onChange,
  disabled,
  title,
}: {
  label: string
  value: string
  options: GenChoice[]
  onChange: (value: string) => void
  disabled?: boolean
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLSpanElement | null>(null)
  const current = options.find((option) => option.value === value) ?? options[0]

  // 点空白处 / Esc 收起：和参数胶囊的菜单同一套关闭方式，键盘用户不至于卡在菜单里出不来
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
    <span className="qc-gen-select" ref={boxRef}>
      <button
        type="button"
        className={'qc-gen-chip' + (value ? ' is-set' : '')}
        onClick={() => setOpen((state) => !state)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label + '：' + current.label}
        title={title}
      >
        <span className="qc-gen-chip-label">{label}</span>
        <em>{current.short}</em>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <span className="qc-gen-menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={'qc-gen-opt' + (option.value === value ? ' is-active' : '')}
              key={option.value || option.label}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  )
}

/** 图片没有「多少字」，只能报体积；四舍五入到 KB，小图别显示成 0 KB。 */
function bytesLabel(bytes: number) {
  if (!bytes) return '图片'
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

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

export default function QuickChat({ onToast }: { onToast?: ToastFn }) {
  const [items, setItems] = useState<ChatSummary[]>([])
  const [current, setCurrent] = useState<ChatConversation | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [opening, setOpening] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [error, setError] = useState('')
  const [tools, setTools] = useState<ChatToolOptions>(() => loadTools())
  // 搜索服务通没通（r246）：没接通时开关是禁用的，并且写明为什么——不做一个点了没反应的开关
  const [searchStatus, setSearchStatus] = useState<ChatSearchStatus | null>(null)
  const [credits, setCredits] = useState<{ balance: number | null; unit: string; price: number } | null>(null)
  // 附件：attached 是这一轮要带的，preview 是「平台读到的到底是什么字」的原文预览
  const [attached, setAttached] = useState<ChatFile[]>([])
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState('')
  const [preview, setPreview] = useState<{ id: string; name: string; text: string; note: string; image: boolean } | null>(null)
  // 带图那一轮要等模型看完才回，提示语得跟纯文字区分开，否则「正在回答…」会让人以为图没传上
  const [sendingImages, setSendingImages] = useState(false)
  // 手机上一列排（≤900px）：会话列表默认收成一条窄条，点开才展开。
  // 桌面左栏不受影响——这个状态只决定窄屏那条列表展不展开（CSS 里只在窄屏生效）。
  const [listOpen, setListOpen] = useState(false)
  // 生成设置（r342）：比例 / 画质 / 时长 / 分辨率。空串 = 跟随提示词（那个键不发给服务端）。
  // 为什么是四个独立的 state 而不是按图片 / 视频各存一份：一张对话里这两个指令会交替出现，
  // 各自记着上次选的档反而会在「上一条是视频」时把图片的比例顶成空——渲染时按当前控件档位兜底更省事。
  const [mediaRatio, setMediaRatio] = useState('')
  const [mediaQuality, setMediaQuality] = useState('')
  const [mediaDuration, setMediaDuration] = useState('')
  const [mediaResolution, setMediaResolution] = useState('')
  // 哪一段回答刚复制过：按钮上给 1.6 秒「已复制」，不然点完没有任何反馈
  const [copiedId, setCopiedId] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // 只有「本来就在底部」才跟着滚：长回答往上翻着看的时候，每来一段就把人拽回底部很难用
  const stickRef = useRef(true)

  const messages = current?.messages ?? []
  // 搜索服务通没通：还没拿到状态时按「可用」处理（老部署没有这个接口也不该把开关整个封死），
  // 明确告诉没接通时才禁用，并在 title 里写清原因。
  const searchAvailable = searchStatus ? searchStatus.configured : true

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

  // 搜索服务有没有接通：没接通时把「联网搜索」关掉并说明原因，
  // 免得用户打开一个开关、以为搜过了（r246 之前这里其实一直没真正搜过）
  useEffect(() => {
    getChatSearch()
      .then((data) => {
        setSearchStatus({ configured: Boolean(data.configured), providerLabel: data.providerLabel || '', note: data.note || '' })
        if (!data.configured) {
          setTools((currentTools) => {
            if (!currentTools.search) return currentTools
            const next = { ...currentTools, search: false }
            try { window.localStorage.setItem(TOOLS_KEY, JSON.stringify(next)) } catch { /* 隐私模式忽略 */ }
            return next
          })
        }
      })
      .catch(() => undefined)
  }, [])

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
      const response = await safeFetch('/api/chat/files/' + id)
      const body = (await response.json()) as { ok?: boolean; file?: ChatFile; text?: string; error?: string }
      if (!response.ok || !body?.file) throw new Error(body?.error || 'HTTP ' + response.status)
      setPreview({
        id: body.file.id,
        name: body.file.name || name,
        text: body.text || '',
        note: body.file.note || '',
        image: isImageFile(body.file),
      })
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

  // 复制回答（r247）：复制的是模型原文排成的纯文本（不带 ** 和 |），粘到文档 / 剪辑软件里能直接用。
  const copyAnswer = useCallback(async (id: string, content: string) => {
    const text = markdownPlainText(content)
    if (!text) {
      onToast?.('这段回答是空的，没有可复制的内容')
      return
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('这个浏览器没有剪贴板接口')
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      window.setTimeout(() => setCopiedId((value) => (value === id ? '' : value)), 1600)
    } catch {
      // 复制失败不假装成功：老浏览器 / 非安全上下文里没有剪贴板接口
      onToast?.('这个浏览器不让网页写剪贴板：在回答上选中文字手动复制')
    }
  }, [onToast])

  const send = useCallback(async () => {
    const content = draft.trim()
    if (!content || sending || attaching) return
    const files = attached
    // 生成设置要在这一句还留在 draft 里的时候算：下面 setDraft('') 之后就算不出「这句是图还是视频」了
    const media = mediaChoiceOf(content, {
      ratio: mediaRatio,
      quality: mediaQuality,
      duration: mediaDuration,
      resolution: mediaResolution,
    })
    setSending(true)
    setSendingImages(files.some(isImageFile))
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
        // 会话列表满了（最多 30 条）时服务端会腾出最早的一条：这件事必须说出来，
        // 不然用户只会发现「昨天那条长对话不见了」，却不知道是自己点了新对话（r247）
        const retired = created.conversation.retired
        if (retired?.title) onToast?.('会话列表满了：最早那条「' + retired.title + '」已经挪掉（最多 30 条）')
      }
      conversationId = conversation.id
      const result = await streamChatMessage(
        conversation.id,
        { content, tools, files: files.map((item) => item.id), media },
        {
          signal: controller.signal,
          onDelta: (text) => setStreaming((value) => value + text),
        },
      )
      setStreaming('')
      setCurrent(result.conversation)
      // 一条会话最多留 200 条消息：超出时服务端从最早的开始挪掉，这件事必须说出来，
      // 不然用户只会发现「第一句问的话没了」，还会以为模型忘了（r248）
      const trimmed = Number(result.conversation.trimmedNow) || 0
      if (trimmed > 0) onToast?.('这条对话到 200 条上限了：最早的 ' + trimmed + ' 条已经从存档里挪掉，再往前翻不到了')
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
          // 失败的那一轮也可能已经挤掉了旧消息（用户那句先落库，再去问上游）：同样要说一声（r248）
          const lost = (Number(fresh.conversation.dropped) || 0) - (Number(before?.dropped) || 0)
          if (lost > 0) onToast?.('这条对话到 200 条上限了：最早的 ' + lost + ' 条已经从存档里挪掉，再往前翻不到了')
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
      setSendingImages(false)
      abortRef.current = null
      // 积分实时（r342）：这一轮扣了钱（生成指令还会再扣一笔生成积分），失败 / 停止那一轮也可能已经退回，
      // 不管成败都让外壳重读一次余额——以前只有换路由才刷新，右上角会一直停在旧数字上（今天的投诉）。
      window.dispatchEvent(new Event('vq:credits'))
    }
  }, [
    attached,
    attaching,
    current,
    draft,
    mediaDuration,
    mediaQuality,
    mediaRatio,
    mediaResolution,
    onToast,
    refreshList,
    sending,
    tools,
  ])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const toolCount = useMemo(() => TOOL_ITEMS.filter((item) => tools[item.id]).length, [tools])
  // 这一条会不会被当成生成指令（r288 / r293）：与服务端同一组前缀，只用来提前说清「要扣生成积分」。
  // 真正的判定在 server/media-intent.mjs，这里重复的只是那句提示，不参与扣费；
  // r293 起口语也算指令（「帮我出个视频」「做个卖毛衣的短视频」），这句提示要跟着亮。
  const genCommand = looksLikeGenCommand(draft)
  // r342：生成设置那一行只在「这句要生成」时出现；是图还是视频决定画哪几个控件。
  const genKind = genCommandKind(draft)
  const genRatioOptions = genKind === 'video' ? GEN_VIDEO_RATIOS : GEN_IMAGE_RATIOS
  // 渲染时按当前档位兜底：切到视频后上一档的 3:4 不在视频档里，控件显示「跟随提示词」，
  // 发出去的也是空（mediaChoiceOf 同一套口径），不会出现「界面写着 3:4、发出去却不是它」。
  const ratioValue = genRatioOptions.some((option) => option.value === mediaRatio) ? mediaRatio : ''
  const qualityValue = GEN_QUALITIES.some((option) => option.value === mediaQuality) ? mediaQuality : ''
  const durationValue = GEN_DURATIONS.some((option) => option.value === mediaDuration) ? mediaDuration : ''
  const resolutionValue = GEN_RESOLUTIONS.some((option) => option.value === mediaResolution) ? mediaResolution : ''
  // 参考图会怎么用（r342）：带图生成只按第 1 张当参考；没带附件时服务端沿用这条对话里最近那张。
  // 这句必须说出来——不说的话用户只会看到「出的图和参考图没关系」，以为是模型没照做。
  const attachedImages = attached.filter(isImageFile)
  const lastConversationImage = useMemo(() => {
    const list = current?.messages ?? []
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      if (message.role !== 'user' || !message.files?.length) continue
      const image = message.files.find(isImageFile)
      if (image) return image
    }
    return null
  }, [current])
  const genRefNote = !genKind
    ? ''
    : attachedImages.length
      ? '这次带 ' + attachedImages.length + ' 张图，生成按第 1 张当参考'
      : lastConversationImage
        ? '沿用这条对话里最近那张图当参考：' + lastConversationImage.name
        : ''

  return (
    <div className="qc-root">
      <aside className={'qc-side' + (listOpen ? ' is-open' : '')} aria-label="对话列表">
        <div className="qc-side-head">
          <button type="button" className="qc-new" onClick={newConversation}>
            <MessageSquarePlus size={15} />
            新对话
          </button>
          {items.length > 0 ? <span className="qc-count">共 {items.length} 个</span> : null}
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
              <button
                type="button"
                className="qc-conv-main"
                onClick={() => void openConversation(item.id)}
                disabled={Boolean(opening)}
                title={item.title}
              >
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
        {/* r294：这句原来三到四行常驻左栏底部，把清单压掉一截。现在只留一行，全文在 title 里。 */}
        <p
          className="qc-side-note"
          title="会话存在服务端，换设备回来还在；最多 30 条、每条留 200 条消息，超出时从最早的挪掉并告诉你"
        >
          服务端保存 · 最多 30 个
        </p>
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
          {current?.dropped ? (
            <p className="qc-trimmed">
              再往前 {current.dropped} 条已经不在存档里：一条对话最多留 200 条消息，超出的从最早的开始挪掉。
            </p>
          ) : null}
          {messages.length === 0 ? (
            <div className="qc-empty">
              <strong>一页能记住上下文的对话</strong>
              <p>写脚本、拆爆款结构、改分镜、问平台怎么用，都可以直接说。</p>
              {/* r287：四条并成两条——原来这一屏上「能力」被说了三遍（这四条、下面那排开关、
                  AgentsPage 的对话方式那一行），空状态不该比对话本身还重。 */}
              <ul>
                <li>
                  直接生成：「/生视频 咖啡店门口的雨夜」或「帮我出个视频 …」都行，没说画面我替你补；
                  比例 / 尺寸 / 秒数写死就照原样提交（4:5、1080p 12 秒），上游不收就全额退回
                </li>
                <li>边生成边显示，首段一两秒就到；中途可以停，停止与失败都不计费</li>
                <li>
                  附件丢脚本 / Word / Excel / PDF 与截图（图不做 OCR）；带链接先开「读链接」
                  {searchAvailable ? '，要最新信息再开「联网搜索」' : '（联网搜索还没接通）'}；上下文带最近 30 条
                </li>
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
                {message.meta?.media ? <MediaTaskCard media={message.meta.media} /> : null}
                {message.files?.length ? (
                  <div className="qc-files">
                    {message.files.map((file) => (
                      <button
                        type="button"
                        key={file.id}
                        className={'qc-file' + (isImageFile(file) ? ' qc-file--image' : '')}
                        title={file.note || (isImageFile(file) ? '看这一轮发给模型的图' : '看平台读到的文字')}
                        onClick={() => void openPreview(file.id, file.name)}
                      >
                        {isImageFile(file) ? (
                          <img className="qc-file-thumb" src={chatFileRawUrl(file.id)} alt="" loading="lazy" />
                        ) : (
                          <FileText size={12} />
                        )}
                        <span className="qc-file-name">{file.name}</span>
                        <span className="qc-file-meta">
                          {isImageFile(file) ? bytesLabel(file.bytes) : file.chars + ' 字' + (file.truncated ? ' · 已截断' : '')}
                        </span>
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
                {message.search ? (
                  <div className={'qc-search' + (message.search.ok ? '' : ' is-failed')}>
                    <div className="qc-search-head">
                      <Search size={12} />
                      <span>
                        {message.search.ok
                          ? '联网搜索：' + (message.search.query || '') + ' · ' + message.search.results.length + ' 条来源'
                          : '联网搜索没成：' + (message.search.note || '这次没搜到')}
                      </span>
                    </div>
                    {message.search.ok && message.search.results.length ? (
                      <div className="qc-search-list">
                        {message.search.results.map((row) => (
                          <a
                            className="qc-search-item"
                            key={row.url}
                            href={row.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            title={row.url}
                          >
                            <span className="qc-search-title">{row.title || hostOf(row.url)}</span>
                            <span className="qc-search-site">{row.site || hostOf(row.url)}</span>
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="qc-msg-meta">
                  <span>{message.role === 'user' ? '你' : '平台对话模型'}</span>
                  <span>{when(message.at)}</span>
                  {message.model ? <span>{message.model}</span> : null}
                  {message.ms ? <span>{(message.ms / 1000).toFixed(1)}s</span> : null}
                  {message.role === 'assistant' ? (
                    <button
                      type="button"
                      className={'qc-copy' + (copiedId === message.id ? ' is-done' : '')}
                      onClick={() => void copyAnswer(message.id, message.content)}
                      title="复制这段回答（纯文本，不带 ** 这类记号）"
                    >
                      {copiedId === message.id ? <Check size={12} /> : <Copy size={12} />}
                      {copiedId === message.id ? '已复制' : '复制'}
                    </button>
                  ) : null}
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
                  {sendingImages
                    ? '正在看图并回答…（带图这一轮整段给，不逐字）'
                    : tools.thinking
                      ? '正在思考并回答…'
                      : tools.search
                        ? '正在联网搜索并读前几条网页…（要几十秒，读到就接着回答）'
                        : '正在回答…'}
                </div>
              )}
            </div>
          )}
          <div ref={bottomRef} className="qc-bottom" />
        </div>

        {error && <div className="qc-error" role="alert">{error}</div>}

        <div className="qc-composer">
          {/* 生成设置（r342）：只在这句会被当成生成指令时出现，放在能力行上方。
              默认全是「跟随提示词 / 跟随默认」＝一个键都不发，行为与改动前一致；
              选了就以这里为准，参数不再需要写进提示词（写进来的由服务端认并去掉）。 */}
          {genKind ? (
            <div className="qc-gen" role="group" aria-label="生成设置">
              <div className="qc-gen-row">
                <GenSelect
                  label="比例"
                  value={ratioValue}
                  options={genRatioOptions}
                  onChange={setMediaRatio}
                  disabled={sending}
                  title="这次的比例。选「跟随提示词」就由服务端从你这句里认，认不出按各自默认档"
                />
                {genKind === 'video' ? (
                  <>
                    <GenSelect
                      label="时长"
                      value={durationValue}
                      options={GEN_DURATIONS}
                      onChange={setMediaDuration}
                      disabled={sending}
                      title="这次的秒数。选「跟随提示词」就由服务端从你这句里认"
                    />
                    <GenSelect
                      label="分辨率"
                      value={resolutionValue}
                      options={GEN_RESOLUTIONS}
                      onChange={setMediaResolution}
                      disabled={sending}
                      title="这次的清晰度。选「跟随提示词」就由服务端从你这句里认，认不出用 720p"
                    />
                  </>
                ) : (
                  <GenSelect
                    label="画质"
                    value={qualityValue}
                    options={GEN_QUALITIES}
                    onChange={setMediaQuality}
                    disabled={sending}
                    title="这次出图的画质。默认跟上上游自己的默认档；选了就按这一档提交，上游不接受会失败并全额退回"
                  />
                )}
              </div>
              {genRefNote ? <p className="qc-gen-note">{genRefNote}</p> : null}
            </div>
          ) : null}
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
                  title={item.id === 'search' && !searchAvailable ? (searchStatus?.note || '联网搜索还没接通') : item.hint}
                  onClick={() => toggleTool(item.id)}
                  disabled={sending || (item.id === 'search' && !searchAvailable)}
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
              title="附件：脚本、Word、Excel、PDF、图片（截图直接交给模型看）；最多 5 个（图片 2 张），单个 8 MB"
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
                    title={file.note || (isImageFile(file) ? '看这一轮要发给模型的图' : '看平台读到的文字')}
                    onClick={() => void openPreview(file.id, file.name)}
                  >
                    {isImageFile(file) ? (
                      <img className="qc-file-thumb" src={chatFileRawUrl(file.id)} alt="" loading="lazy" />
                    ) : (
                      <FileText size={12} />
                    )}
                    <span className="qc-chip-name">{file.name}</span>
                    <span className="qc-chip-meta">
                      {isImageFile(file) ? bytesLabel(file.bytes) : file.chars + ' 字' + (file.truncated ? ' · 已截断' : '')}
                    </span>
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
              {preview.image ? (
                // 图片没有「读出来的文字」可看，能核对的就是原图本身
                <img className="qc-preview-img" src={chatFileRawUrl(preview.id)} alt={preview.name} />
              ) : (
                <pre className="qc-preview-body">{preview.text.slice(0, 1200)}{preview.text.length > 1200 ? '\n…' : ''}</pre>
              )}
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
              placeholder="说清你要什么，例如：口播拆分镜（Enter 发送）"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                // 输入法正在组词时按 Enter 是「选字」，不是发送：中文用户十次里九次会撞上
                if (event.nativeEvent.isComposing) return
                // Shift + Enter 换行；其余情况（含 Ctrl / Cmd + Enter）直接发送，跟一页 DeepSeek 一致
                if (event.shiftKey) return
                event.preventDefault()
                void send()
              }}
              disabled={sending}
            />
            {sending ? (
              <button type="button" className="qc-send qc-send--stop" onClick={stop} aria-label="停止生成" title="停止生成（这次不计费，积分全额退回）">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button type="button" className="qc-send" onClick={() => void send()} disabled={!draft.trim() || attaching} aria-label="发送" title="发送（Enter，Shift + Enter 换行）">
                <ArrowUp size={18} />
              </button>
            )}
          </div>
          <div className="qc-hint">
            <span>
              {sending
                ? '生成中点方块可停止，停止不计费'
                : genCommand
                  ? attached.length
                    ? '以 / 开头：会带上这 ' + attached.length + ' 个附件；生成一次最多用 1 张参考图'
                    : '以 / 开头：这条直接生成，按图片 / 视频的积分价扣费'
                  : !tools.readUrl && /https?:\/\//i.test(draft)
                    ? '消息里有链接：打开「读链接」，我才会先把页面读下来'
                    : 'Enter 发送 · Shift + Enter 换行'}
            </span>
            <span>{toolCount ? toolCount + ' 项能力已打开' : '能力全关：只按对话回答'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
