import type { ScriptBeat, StoryboardShot, TemplateTiming } from './radar'
import type { ReviewIssues, ReviewSummary } from '../api/review'

// 作品（Project）：一条内容的主线对象。
// 它不自带脚本与分镜——那两样在它绑定的模板上，改了模板作品跟着变；
// 这里只描述「谁、用哪条模板、开的哪块画布、走到哪一步」。
export type ProjectStatus = 'active' | 'done'

export type ProjectTemplateBrief = {
  id: string
  title: string
  kind: string
  contentType: string
  durationSec: number
  beats: number
  shots: number
}

export type ProjectReviews = {
  count: number
  lastVerdict: string
  lastAt: string
  /** 这一版最近一次评审的问题数（按严重度）；老记录没有 */
  issues?: ReviewIssues | null
}

/**
 * 这条作品上花掉的积分（v0.9.65）：评审与画布运行分开记。
 * 退过款的那次运行不算（钱已经回去了），检索 / 复刻 / 智能体对话记在账号上，不摊到作品。
 */
export type ProjectSpend = {
  unit: string
  total: number
  reviews: { count: number; credits: number }
  runs: { count: number; credits: number }
  /** 最近一次花钱的时间；一次都没花过是空串（列表接口不返回这一项） */
  lastAt?: string
}

/** 花费明细里的一笔：评审或画布运行（v0.9.66）。退款的那笔照样列出，但不计入合计。 */
export type ProjectSpendEntry = {
  kind: 'review' | 'run'
  id: string
  at: string
  version: number
  credits: number
  /** 这一笔真的扣了积分没有；画布探活之类的运行是 false（金额写 0） */
  charged?: boolean
  refunded: boolean
  /** 评审结论（review）或运行状态（run），老记录可能是空串 */
  verdict?: string
  status?: string
  /** 评审意图或画布名：一行里说清「这笔是哪一次」 */
  note: string
}

export type ProjectSpendVersion = {
  version: number
  reviews: { count: number; credits: number }
  runs: { count: number; credits: number }
  total: number
  lastAt: string
}

export type ProjectSpendMonth = { month: string; total: number; reviews: number; runs: number; count: number }

/**
 * 一条作品的花费明细（v0.9.66）：口径与 ProjectSpend 同源，多给按版本、按月份与逐笔。
 * 传入 month 时只看那一个月（YYYY-MM），byMonth 与月份切换仍按全部记录算。
 */
export type ProjectSpendDetail = {
  unit: string
  /** 'all' 或 'YYYY-MM' */
  scope: string
  /** 服务端认为的「本月」，页面不按浏览器时钟猜 */
  month: string
  total: number
  reviews: { count: number; credits: number }
  runs: { count: number; credits: number }
  refunded: { count: number; credits: number }
  lastAt: string
  byVersion: ProjectSpendVersion[]
  byMonth: ProjectSpendMonth[]
  count: number
  shown: number
  items: ProjectSpendEntry[]
}

/**
 * 人工复核：人看过证据后对某一次评审拍板的结果。
 * 它不改评审记录本身（模型写了什么还是什么），只回答「这一版是谁拍的板、拍成什么」。
 * 按 reviewAt 认那次评审：同一版又评出新结论，这条就失效了。
 */
export type ProjectDecision = {
  id: string
  projectId: string
  version: number
  reviewAt: string
  verdict: string
  decision: 'pass' | 'reject'
  note: string
  at: string
  /**
   * 这条还算不算数（服务端算，页面只负责写人话）：
   *   current 管当前这一版最近一次评审 / stale 这一版后来重评过、已失效 / past 早先某一版的拍板
   */
  state?: 'current' | 'stale' | 'past'
}

/**
 * 「已看过」：人看过了、这一版先不改。
 * 它只是待办上的便利贴：结论不动、胶囊不动；按「哪一版哪一次评审」认，时间对不上就作废。
 */
export type ProjectAck = { version: number; reviewAt: string; at: string }

/**
 * 交付记录：一次「标记交付」= 哪一版、什么时候交出去。
 * 它是事实，不是开关：交付了 v2 又开 v3，v2 那条仍然在；老记录没有时间（at 是空串）。
 */
/** 交付时的评审快照：当时的结论、那次评审的时间、那一版的问题数 */
export type ProjectDeliveryReview = {
  verdict: string
  at: string
  issues: ReviewIssues | null
}

/**
 * 交付时封存的整套产物（v0.9.125）：字节数、哈希与下载名。
 * 没有这个字段 = 升级前交的 / 封存失败，界面不能给出会 404 的下载入口。
 */
export type ProjectDeliveryFile = {
  name: string
  bytes: number
}

export type ProjectDeliveryPackage = {
  bytes: number
  sha256: string
  fileName: string
  savedAt: string
  /** 服务器盘上这一份还在不在（v0.9.128）：只 stat，不算哈希；老接口没有这一项 */
  disk?: { present: boolean; bytes: number }
  /** 包内文件总数；老包（v0.9.125）没有这一项 */
  fileCount?: number
  /** 包内清单，最多 60 条；老包没有 */
  files?: ProjectDeliveryFile[]
}

/**
 * 一条交付记录：哪一版、什么时候、交的时候评审怎么说。
 * review 三种状态都要分得清：对象 = 记下了；null = 当时还没评过；没有这个字段 = 升级前的老记录（没记）。
 * id/package 同理：升级前的老记录没有封存包。
 */
/** 他点过「收到了」的那一下（v0.9.151）：只记时间，不记是谁 */
export type DeliveryAck = { at: string }

/**
 * 他回了什么（v0.9.153）：收包人回的那段话，发件人记在这一条交付上。
 * at 是「记下这段话」的那一刻——不是他回话的那一刻（那一侧没有时间戳可看）。
 * 时间读不出来时是空串：只留话，不硬编一个时间。
 */
export type DeliveryReply = { text: string; at: string }

export type ProjectDelivery = {
  id?: string
  version: number
  at: string
  review?: ProjectDeliveryReview | null
  package?: ProjectDeliveryPackage
  /** 收包人贴回来的收据比过之后的结论（v0.9.136）；没有 = 还没人贴过 */
  receipt?: DeliveryReceipt
  /**
   * 这一条交付上贴过的每一次（v0.9.138），最后一条就是 receipt。
   * 链接发出去之后可能先贴一张对不上的、后来又贴对了；只留最近一次等于把前一次的证据擦掉。
   */
  receipts?: DeliveryReceipt[]
  /** 回执链接的 token（v0.9.137）：一条免登录地址，收包人自己就能把收据贴回来；没有 = 只存发件人贴 */
  receiptToken?: string
  /**
   * 这条链接发出去的时间（v0.9.145）：从这一刻开始记「被打开过几次」。
   * 升级前发的链接没有这一项——那时候还没开始记，界面不能写成「还没被打开」。
   */
  receiptLinkAt?: string
  /** 这条回执链接被打开过几次（v0.9.145）；只有 receiptLinkAt 也在时接口才会给 */
  visits?: DeliveryVisits
  /**
   * 这条链接又被发出去过几次（v0.9.146）：只有「一次都没被打开过」才会重发，
   * 所以这个数回答的是「我发了几遍他都没收到」，与催过几次是两件事。
   */
  resends?: { at: string }[]
  /**
   * 换过几次新链接（v0.9.147）：同一条地址又发过两次还是没人打开之后，换掉的那几次。
   * 每换一次打开次数与重发次数都从零算起，所以这里只留「换过几次、换之前那条发过几次」。
   * 旧地址不存——它已经打不开了，留着只是多一份可以当凭证猜的字符串。
   */
  relinks?: { at: string; resends: number }[]
  /**
   * 换掉的那几条旧地址（v0.9.148）：只有记录键（token 的哈希前缀）、换的时间，
   * 有人点回去时再加「被点过几次、最近一次」（v0.9.149）。旧 token 本身不存。
   */
  retired?: { key: string; at: string; hits?: number; lastAt?: string }[]
  /**
   * 收包人在回执页点了「收到了」（v0.9.151）：从「链接发出去」到「收据贴回来」之间，
   * 这是对方唯一能亲口说的一句话。只记时间，不记是谁点的（那一侧没有账号），
   * 也不当收据用：验没验仍以收据为准。
   */
  ack?: DeliveryAck
  /**
   * 这一条是给谁的（v0.9.152）：发件人自己写的一个称呼，只留在自己这一侧。
   * 没有 = 没写（老记录都是这样），界面就不说这一段——不猜，也不写成「未知」。
   */
  recipient?: string
  /**
   * 他回了什么（v0.9.153）：收包人说的原话，发件人记在这一条上。
   * 没有 = 还没记（不是「他说没问题」），界面什么都不说。
   */
  reply?: DeliveryReply
}

/**
 * 回执链接被打开过几次（v0.9.145）：收包人那一侧没有账号，能记的只有「这条地址被点开过」。
 * 只记次数与首末时间，不记是谁打开的——所以界面只说「打开过几次」，不说「他看过了」。
 */
export type DeliveryVisits = {
  opens: number
  firstAt: string
  lastAt: string
}

/** 收据对账比的那五项：版次、包名、字节、整包哈希、对方结论 */
export type DeliveryReceiptCheckKey = 'version' | 'package' | 'bytes' | 'sha256' | 'verdict'

export type DeliveryReceiptCheck = {
  k: DeliveryReceiptCheckKey
  /** 这一条封存包里记的值 */
  want: string
  /** 收据上写的值 */
  got: string
  ok: boolean
}

/** 收据上对方写的那几项：只留比对用得上的，不存收据原文 */
export type DeliveryReceiptClaimed = {
  at: string
  kind: string
  title: string
  version: number
  bytes: number
  sha256: string
  packageName: string
  chip: string
  summary: string
}

/**
 * 一次收据对账的结论（v0.9.136）。
 * 四种状态分得清「对得上 / 对不上 / 对方读不出来 / 哈希对上但结论打架」——
 * 不把「比不了」说成「对得上」。
 */
export type DeliveryReceipt = {
  /** 发件人贴进来对一遍的时间 */
  at: string
  state: 'match' | 'mismatch' | 'broken' | 'conflict'
  summary: string
  problems?: string[]
  checks?: DeliveryReceiptCheck[]
  claimed?: DeliveryReceiptClaimed
  /** 这张收据是谁贴的（v0.9.137）：'link' = 收包人自己贴的，'you' = 发件人替他贴的；老记录没有 */
  via?: 'link' | 'you'
}

/** 收据对账接口回的那一份：结论 + 存下来的记录 */
export type DeliveryReceiptResult = {
  ok: boolean
  state: DeliveryReceipt['state']
  summary: string
  problems: string[]
  checks: DeliveryReceiptCheck[]
  receipt: DeliveryReceipt
}

/**
 * 收包人那一侧看到的这一份（v0.9.137）：只有「这是哪一份、之前贴过没有」。
 * 不给哈希也不给档案——有包的人在自己那张校验页上看得到，链接本身不该多给东西。
 */
export type ReceiptLinkDelivery = {
  version: number
  fileName: string
  bytes: number
  at: string
}

export type ReceiptLinkView = {
  ok: boolean
  project: { title: string }
  delivery: ReceiptLinkDelivery
  /** 他之前点过「收到了」没有（v0.9.151）：刷新页面之后还知道点过 */
  ackAt?: string
  receipt: { state: DeliveryReceipt['state']; at: string; summary: string } | null
}

/** 收包人贴完收据回的那一句：只给哪几项对上，不回期望值（v0.9.137） */
export type ReceiptLinkResult = {
  ok: boolean
  state: DeliveryReceipt['state']
  summary: string
  problems: string[]
  checks: { k: DeliveryReceiptCheckKey; ok: boolean }[]
  at: string
}

/** 谁贴的这张收据：页面上说人话，老记录一律按「发件人贴的」讲 */
export function receiptViaText(via: DeliveryReceipt['via']): string {
  return via === 'link' ? '收包人自己从回执链接贴回来的' : '你替收包人贴进来的'
}

const RECEIPT_CHECK_LABEL: Record<string, string> = {
  version: '版次',
  package: '包名',
  bytes: '字节',
  sha256: '整包 SHA-256',
  verdict: '对方结论',
}

/** 一次对账的结论怎么说（v0.9.136）：四个状态各有一句人话，不说术语。 */
export function receiptStateText(state: DeliveryReceipt['state']): string {
  return state === 'match'
    ? '对得上'
    : state === 'mismatch'
      ? '对不上'
      : state === 'broken'
        ? '对方读不出来'
        : '说法打架'
}

/** 对账结果里那一行（v0.9.136）：给人看的一句话，不说术语。 */
export function deliveryReceiptLine(receipt: DeliveryReceipt | null | undefined): string {
  if (!receipt) return ''
  const label = receiptStateText(receipt.state)
  const ms = Date.parse(String(receipt.at || ''))
  if (!Number.isFinite(ms)) return '收包人核对过 · ' + label
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return '收包人核对过 · ' + label + ' · ' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/** 对账那张小表里每项叫什么：页面上给的是这一行字，不是字段名。 */
export function receiptCheckLabel(key: string): string {
  return RECEIPT_CHECK_LABEL[key] || key
}

/**
 * 又贴了一次收据之后，和上一次比变了哪一项（v0.9.141）。
 *
 * 为什么要有它：一条交付上可能先贴一张对不上的、换了包再贴对得上；流水（v0.9.138）只按时间
 * 把每一次摆开，看的人得自己在两条之间逐项找差别。这里只做「两次之间」的差，不猜原因、
 * 不替人判断该不该重发：哪一项从对不上变成对得上（或反过来），收据上写的值换了什么，
 * 结论是变好、变坏，还是根本没变。
 *
 * 边界：
 *  - 只有同一条交付上的两次才比；只比两边都记了的项，缺的那一项不算「变了」；
 *  - 上一次那张读不出来（没有逐项）时直接说比不了，不拿「没记」当「对得上」；
 *  - 只读已经存下来的结论与摘要，不碰包、不重算哈希。
 */
export type ReceiptChangeItem = {
  /** 哪一项（「整包 SHA-256」「字节」…） */
  label: string
  /** 上一次对不对得上 */
  before: boolean
  /** 这一次对不对得上 */
  after: boolean
}

export type DeliveryReceiptChange = {
  /** 一次说清变化的一句话（界面上原样显示） */
  text: string
  /** 变了的项；两次都一样的项不列 */
  items: ReceiptChangeItem[]
  /** better 这次对上了 / worse 这次反了 / flat 没变 / unknown 上一次读不出来，比不了 */
  tone: 'better' | 'worse' | 'flat' | 'unknown'
}

const CHANGE_LABEL_MAX = 3

/** 名字多了只报个数：这一行不是给人逐个核对的。 */
function changeList(names: string[]): string {
  if (names.length <= CHANGE_LABEL_MAX) return names.join('、')
  return names.slice(0, CHANGE_LABEL_MAX).join('、') + ' 等 ' + names.length + ' 项'
}

/** 字节数带千分位，不依赖运行环境的 Intl：收据上本来就这么写。 */
function changeBytes(value: number): string {
  return String(Math.max(0, Math.round(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 64 位哈希只露头尾：两次之间差在哪一位不是这一行的重点。 */
function changeSha(value: string): string {
  const sha = normalizeSha256(value)
  return sha ? sha.slice(0, 6) + '…' + sha.slice(-4) : ''
}

/** 包名太长就截断：换的是哪个文件，认得出前几个字就够了。 */
function changeName(value: string): string {
  const name = String(value || '').trim()
  return name.length > 28 ? name.slice(0, 28) + '…' : name
}

/**
 * 和上一次比。
 * 传的是这一条交付上贴过的全部（越晚越靠后）：不到两次就没有「上一次」，返回 null。
 */
export function receiptChangeOf(receipts: DeliveryReceipt[] | null | undefined): DeliveryReceiptChange | null {
  const list = (Array.isArray(receipts) ? receipts : []).filter((entry) => entry && entry.state)
  if (list.length < 2) return null
  const prev = list[list.length - 2]
  const last = list[list.length - 1]

  const earlier = new Map<string, DeliveryReceiptCheck>()
  for (const check of prev.checks || []) {
    if (check?.k) earlier.set(check.k, check)
  }
  const items: ReceiptChangeItem[] = []
  let compared = 0
  for (const check of last.checks || []) {
    const before = check?.k ? earlier.get(check.k) : null
    if (!before) continue
    compared += 1
    if (before.ok === check.ok) continue
    items.push({ label: receiptCheckLabel(check.k), before: before.ok, after: check.ok })
  }

  const up = items.filter((item) => item.after).map((item) => item.label)
  const down = items.filter((item) => !item.after).map((item) => item.label)
  const parts: string[] = []
  if (up.length && down.length) {
    parts.push(changeList(up) + ' 对上了，' + changeList(down) + ' 反了对不上')
  } else if (up.length) {
    parts.push(up.length > 1 ? changeList(up) + ' 这 ' + up.length + ' 项从对不上变成对得上' : changeList(up) + ' 从对不上变成对得上')
  } else if (down.length) {
    parts.push(down.length > 1 ? changeList(down) + ' 这 ' + down.length + ' 项从对得上变成对不上' : changeList(down) + ' 从对得上变成对不上')
  } else if (compared) {
    parts.push(
      prev.state === last.state
        ? '每一项都没变，结论还是「' + receiptStateText(last.state) + '」'
        : '结论从「' + receiptStateText(prev.state) + '」变成「' + receiptStateText(last.state) + '」',
    )
  } else {
    parts.push('上一次那张读不出来，比不了哪一项变了')
  }
  // 变了的项里已经有「对上了 / 对不上」时，再补一句结论怎么变：
  // 四项都对了但结论还写着「说法打架」，看的人要知道这两次说的不是一回事。
  if (items.length && prev.state !== last.state) {
    parts.push('结论从「' + receiptStateText(prev.state) + '」变成「' + receiptStateText(last.state) + '」')
  }

  // 收据上写的值换没换：版次、字节、哈希、包名。换了不等于这次对得上，所以另说一句。
  const was = prev.claimed
  const now = last.claimed
  const claims: string[] = []
  if (was && now) {
    const wasVersion = Math.max(0, Math.round(Number(was.version) || 0))
    const nowVersion = Math.max(0, Math.round(Number(now.version) || 0))
    if (wasVersion !== nowVersion) {
      claims.push('版次从 ' + (wasVersion ? 'v' + wasVersion : '没写') + ' 换成 ' + (nowVersion ? 'v' + nowVersion : '没写'))
    }
    const wasBytes = Math.max(0, Math.round(Number(was.bytes) || 0))
    const nowBytes = Math.max(0, Math.round(Number(now.bytes) || 0))
    if (wasBytes !== nowBytes) {
      claims.push('字节从 ' + (wasBytes ? changeBytes(wasBytes) + ' B' : '没写') + ' 换成 ' + (nowBytes ? changeBytes(nowBytes) + ' B' : '没写'))
    }
    const wasSha = changeSha(was.sha256 || '')
    const nowSha = changeSha(now.sha256 || '')
    if (wasSha !== nowSha) claims.push('整包 SHA-256 从 ' + (wasSha || '没写') + ' 换成 ' + (nowSha || '没写'))
    if (String(was.packageName || '') !== String(now.packageName || '')) {
      claims.push(now.packageName ? '包名换成「' + changeName(now.packageName) + '」' : '包名这次没写')
    }
  }
  if (claims.length) {
    parts.push('收据上写的变了：' + claims.slice(0, 2).join('、') + (claims.length > 2 ? ' 等 ' + claims.length + ' 项' : ''))
  }

  let tone: DeliveryReceiptChange['tone'] = 'flat'
  if (!compared) tone = 'unknown'
  else if (down.length || (prev.state === 'match' && last.state !== 'match')) tone = 'worse'
  else if (up.length || (last.state === 'match' && prev.state !== 'match')) tone = 'better'
  return { text: '和上一次比：' + parts.join('。') + '。', items, tone }
}

/**
 * 对不上之后做什么（v0.9.142）。
 * 逐项已经把「差在哪一项、两边各写了什么」摆开了；这一句只说「这一种差别意味着什么、
 * 接下来该做什么」。只看存下来的那五项：推不出来的就不说，绝不替对方猜原因。
 * 对得上时不出现——好消息不需要人再动手。
 */
export type ReceiptAdvice = {
  /** bad 这一份得重发或重贴 / warn 包对得上，只是两边说法不一样 */
  tone: 'bad' | 'warn'
  /** 一句判断（界面上加粗） */
  title: string
  /** 一句下一步 */
  text: string
}

const ADVICE_REPOST = '把上面那个「交付包」重发一次，让他用包里那张「校验.html」重验。'

export function receiptAdvice(receipt: DeliveryReceipt | null | undefined): ReceiptAdvice | null {
  if (!receipt || !receipt.state) return null
  if (receipt.state === 'match') return null
  if (receipt.state === 'broken') {
    return {
      tone: 'bad',
      title: '他没验成：包在他那边读不出来',
      text: '让他解压后打开包里那张「校验.html」，把收到的 zip 拖进去，用导出的收据重贴一次；再重发一份包更稳。',
    }
  }
  if (receipt.state === 'conflict') {
    return {
      tone: 'warn',
      title: '包对得上，只是他写的结论不一样',
      text: '五项记录都对得上，只有他写的结论不是「都对得上」：让他按逐项的说法重贴一张，或你按逐项替他贴。',
    }
  }
  const checks = (receipt.checks || []).filter((check) => check && check.k)
  const bad = new Map<string, DeliveryReceiptCheck>()
  for (const check of checks) if (!check.ok) bad.set(check.k, check)
  if (!checks.length) {
    return { tone: 'bad', title: '对不上，但看不出差在哪', text: '这一张没带逐项：让他用包里那张「校验.html」重新导一张收据。' }
  }
  // 版次或包名就不对：他手里那份根本不是这一版的包，先别怀疑内容。
  if (bad.has('version') || bad.has('package')) {
    return {
      tone: 'bad',
      title: '他验的不是这一版的包',
      text: '版次或包名对不上：先问他打开的是哪个文件，再把这一版的「交付包」和回执链接重发一次。',
    }
  }
  if (bad.has('bytes')) {
    return {
      tone: 'bad',
      title: '他手上那份不是这个文件',
      text: '名字和版次都对得上，字节数不一样：多半没传全，或者解压后又压过。' + ADVICE_REPOST,
    }
  }
  const sha = bad.get('sha256')
  if (sha) {
    // 哈希空着不是「换了一串」，是那边没算出来：两条路不能写成一条。
    if (!String(sha.got || '').trim()) {
      return { tone: 'bad', title: '他那边没算出哈希', text: '收据上哈希是空的：让他把收到的 zip 拖进包里那张「校验.html」验完再导一张。' }
    }
    return {
      tone: 'bad',
      title: '字节一样，内容不一样',
      text: '名字、版次、字节数都对得上，哈希不同：重新压过，或者改过里面的字。' + ADVICE_REPOST,
    }
  }
  return { tone: 'bad', title: '有几项对不上', text: '让他用包里那张「校验.html」重新导一张收据；差在哪一项看上面逐项。' }
}

/** 字节数补千分位再带上 B：收据上本来就那么写，照抄回去两边对得起来。 */
function outreachBytes(value: string): string {
  const raw = String(value || '').trim()
  const digits = Number(raw.replace(/[,\s]/g, ''))
  return Number.isFinite(digits) && digits > 0 ? changeBytes(digits) + ' B' : raw || '没写'
}

/**
 * 替你把要给收包人的那段话写好（v0.9.143）。
 * 只把收据上真实记着的东西说回去：哪一项不一样、两边各是什么、请他怎么重验。
 * 不编原因、不承诺赔补、不写「一定」；对得上时返回空串——没有要说的。
 */
export function receiptOutreach(receipt: DeliveryReceipt | null | undefined): string {
  if (!receipt || !receipt.state || receipt.state === 'match') return ''
  const checks = (receipt.checks || []).filter((check) => check && check.k)
  const find = (key: string) => checks.find((check) => check.k === key)
  const askVerify = '麻烦解压交付包、打开里面那张「校验.html」，把收到的 zip 拖进去重验一遍，再把导出的收据发我。'
  if (receipt.state === 'broken') {
    return '你发回来的收据我这边读不出来（校验页说包读不出来）。' + askVerify + '我把这一版的包也重发一份，你看看是不是没下全。'
  }
  if (receipt.state === 'conflict') {
    const chip = String(receipt.claimed?.chip || '有问题').slice(0, 20)
    return '收据上五项都对得上，只有结论写「' + chip + '」——这一份包是好的。麻烦按逐项的说法重贴一张，结论改成「都对得上」；要是你那边确实有一项对不上，把坏在哪一项告诉我。'
  }
  if (!checks.length) {
    return '收据里没带逐项，我这边看不出差在哪。' + askVerify
  }
  const version = find('version')
  const pkg = find('package')
  if ((version && !version.ok) || (pkg && !pkg.ok)) {
    const said = [version && !version.ok ? '版次 ' + (version.got || '没写') : '', pkg && !pkg.ok ? '包名「' + (pkg.got || '没写') + '」' : '']
      .filter(Boolean)
      .join('、')
    const want = [version && !version.ok ? '版次 ' + (version.want || '没记') : '', pkg && !pkg.ok ? '包名「' + (pkg.want || '没记') + '」' : '']
      .filter(Boolean)
      .join('、')
    return '你发回来的收据上写的是 ' + said + '，我封的这一版是 ' + want + '：两边不是同一份包。我把这一版的「交付包」和回执链接再发你一次，麻烦重下一份再验。'
  }
  const bytes = find('bytes')
  if (bytes && !bytes.ok) {
    return (
      '这份包的收据我看了：包名和版次都对得上，字节数不一样（你那边 ' +
      outreachBytes(bytes.got) +
      '，我封的是 ' +
      outreachBytes(bytes.want) +
      '）。多半是没传全，或者解压后又压过。' +
      askVerify
    )
  }
  const sha = find('sha256')
  if (sha && !sha.ok) {
    if (!String(sha.got || '').trim()) {
      return '收据里没有整包 SHA-256（你那边可能没算出来）。' + askVerify
    }
    return (
      '这份包的收据我看了：包名、版次、字节数都对得上，只有整包 SHA-256 不一样（你那边 ' +
      sha.got +
      '，我这边 ' +
      (sha.want || '没记') +
      '），说明内容被改过或重新压过。' +
      askVerify
    )
  }
  return '收据上有几项对不上，具体差在哪一项我在逐项里对着了。' + askVerify
}

/** 归档的旧版本：只存画布指针与名字，画布本身仍在流程服务里 */
export type ProjectVersion = {
  n: number
  flowId: string
  name: string
  archivedAt: string
  /** 这一版是从哪一版复制来的；0 表示接着上一版改（v0.9.116） */
  basedOn?: number
}

/** 作品详情会顺手确认归档画布还在，并带上节点数 */
// 归档版本额外带上开版时存下的脚本快照段数：交付稿与版本对照都靠它说「这一版几段」
export type ProjectVersionView = ProjectVersion & {
  /** 开这一版时复制的是哪一版；0 表示接着上一版改 */
  basedOn?: number
  available: boolean
  nodes: number
  /** 开新版那一刻的脚本段数；0 表示那一版没存快照（升级前开的版本） */
  scriptBeats: number
  /** 那一版的脚本当时是自己的还是跟随模板；没快照就是空串 */
  scriptSource: '' | 'project' | 'template'
}

/** 两版对照里一侧的评审概况（v0.9.119）：这一版评过几次、最近结论、最近一评的问题数 */
export type ProjectVersionCompareReview = {
  count: number
  verdict: string
  at: string
  issues: ReviewIssues | null
}

/** 两版对照里的一侧（v0.9.117）：版次、名字、节点数、段数，以及那一侧有没有可比的数据 */
export type ProjectVersionCompareSide = {
  n: number
  name: string
  current: boolean
  nodes: number
  beats: number
  canvasAvailable: boolean
  scriptAvailable: boolean
  /** 这一版最近一评的概况；没评过 count 为 0（v0.9.119） */
  review: ProjectVersionCompareReview
  /**
   * 这一版交出去过没有；有就是交付时间（老记录可能是空串）（v0.9.119）。
   * review 是交付那一刻的评审快照（v0.9.120）：对象 = 交时评过；null = 当时还没评；
   * 没有这个字段 = 升级前的交付记录，当时没记。不能拿这一版后来的评审冒充交时结论。
   */
  delivery: { at: string; review?: ProjectDeliveryReview | null } | null
}

/** 两版之间的评审变化（v0.9.119）：只写变了什么，不替人判断要不要改 */
export type ProjectVersionCompareReviewChange = {
  text: string
  tone: 'better' | 'worse' | 'same' | 'unknown'
}

export type ProjectVersionCompareNode = {
  id: string
  title: string
}

/** 改过的节点差在哪一项参数（v0.9.118）：类型或 config 的一个键，带前后可读值与截断标记 */
export type ProjectVersionCompareField = {
  key: string
  label: string
  before: string
  after: string
  truncated: boolean
}

/** 改过口播的段：段名 + 前后各段口播（重名段落按出现顺序排） */
export type ProjectVersionCompareBeat = {
  name: string
  before: string[]
  after: string[]
}

/**
 * 任意两版对照（v0.9.117）：只读。
 * canvas / script 在一侧读不到时为 null；同时看 notes 写清哪一侧不比。
 */
export type ProjectVersionCompare = {
  ok: boolean
  base: ProjectVersionCompareSide
  target: ProjectVersionCompareSide
  summary: string
  canvas: {
    added: ProjectVersionCompareNode[]
    removed: ProjectVersionCompareNode[]
    changed: ProjectVersionCompareNode[]
    /** 改过的节点 id → 参数明细；没有参数改动时这一项不出现（v0.9.118） */
    fields?: Record<string, ProjectVersionCompareField[]>
  } | null
  script: {
    added: string[]
    removed: string[]
    changed: ProjectVersionCompareBeat[]
    hookChanged: boolean
    hookBefore: string
    hookAfter: string
  } | null
  /** 两版评审结论 / 问题数变了什么；有一版没评过时为 unknown（v0.9.119） */
  reviewChange?: ProjectVersionCompareReviewChange
  notes: string[]
}

export type Project = {
  id: string
  title: string
  templateId: string
  flowId: string
  /** 第几版：0 还没开画布，开出来就是 v1 */
  version: number
  /** 这一版是从哪一版复制来的；0 表示接着上一版改（v0.9.116） */
  basedOn?: number
  versions: ProjectVersion[]
  status: ProjectStatus
  /** 交付记录，按发生顺序；最后一条是最近一次 */
  deliveries?: ProjectDelivery[]
  createdAt: string
  updatedAt: string
}

/** 最近一次交付：交付了哪一版、什么时候（老记录 at 是空串）；从没交付过是 null */
export function deliveryOf(project: Project | null | undefined): ProjectDelivery | null {
  const list = Array.isArray(project?.deliveries) ? project.deliveries : []
  const last = list[list.length - 1]
  if (!last) return null
  // id / package 要一起带出来：标记交付后的提示靠它说「包已封存」，
  // 只返回 version/at/review 会让界面永远看不见包（v0.9.126 修）。
  return {
    ...(last.id ? { id: last.id } : {}),
    version: Math.max(0, Math.round(Number(last.version) || 0)),
    at: String(last.at || ''),
    review: last.review,
    ...(last.package ? { package: last.package } : {}),
  }
}

/**
 * 这一版交付了没有：status=done 只说明按过「标记交付」，交的是哪一版要看交付记录。
 * 交付 v2 之后开的 v3 还没交——胶囊不能再写已交付。没有交付记录的老数据照旧：done 就是这一版交了。
 */
export function deliveredCurrent(project: Project | null | undefined): boolean {
  if (project?.status !== 'done') return false
  const delivery = deliveryOf(project)
  if (!delivery) return true
  return delivery.version === Math.max(1, Math.round(Number(project?.version) || 0))
}

/** 交付档案的一行：交过的每一版都在，能不能下载看有没有封存包 */
export type ProjectDeliveryArchive = {
  /** 交付过的那几版，最近的排前面 */
  rows: ProjectDelivery[]
  /** 有包、能下载的条数 */
  sealed: number
  /** 交得早 / 封存失败，只留了记录没有包 */
  legacy: number
  /** 能下载的包合计多少字节 */
  bytes: number
}

/**
 * 作品页的交付档案（v0.9.126）：从交付记录派生，不另存一份。
 * 为什么连没有包的老记录也列出来：作品页要能回答「这条作品交过几版、哪几版没包」，
 * 只列包会让升级前交的那几版凭空消失。
 */
export function deliveryArchive(project: Project | null | undefined): ProjectDeliveryArchive {
  const list = (Array.isArray(project?.deliveries) ? project.deliveries : []).filter(
    (entry) => entry && Math.round(Number(entry.version) || 0) > 0,
  )
  const rows = list.slice().reverse()
  const sealed = rows.filter((entry) => Boolean(entry.id && entry.package))
  return {
    rows,
    sealed: sealed.length,
    legacy: rows.length - sealed.length,
    bytes: sealed.reduce((sum, entry) => sum + Math.max(0, Math.round(Number(entry.package?.bytes) || 0)), 0),
  }
}

/** 包大小给人看：小于 1 KB 写字节，小于 1 MB 写整数 KB，再大留一位小数。 */
export function packageBytesLabel(bytes: number): string {
  const n = Math.max(0, Math.round(Number(bytes) || 0))
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/** 界面上只露 SHA-256 的前 12 位：够核对，又不把一行撑爆；完整值在复制与提示里。 */
export function packageShortSha(sha: string): string {
  const value = normalizeSha256(sha)
  if (!value) return ''
  return value.slice(0, 12) + '…'
}

/** 收成 64 位小写十六进制；不是 SHA-256 就返回空串（粘贴时的大小写、空格都不算错） */
export function normalizeSha256(sha: string): string {
  const value = String(sha || '').trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(value) ? value : ''
}

/**
 * 核对一个下载到的封存包（v0.9.127）：只比 SHA-256 与字节数。
 * 为什么不在服务端对：包在用户手里，读它、算它都不该再上传一遍；
 * 哈希对上就说明还是当初封存的那一份，模型、脚本、模板后来怎么改都影响不到它。
 */
export type PackageCheck = {
  /** 哈希与大小都对上 */
  ok: boolean
  /** 哈希对上；档案没有哈希时也是 false（核对不了） */
  shaOk: boolean
  /** 字节数对上；档案没记大小时按对上算（不拦着核对） */
  sizeOk: boolean
  /** 实际比档案多（正）或少（负）多少字节 */
  sizeDelta: number
  /** 给人看的一句结论 */
  text: string
}

export function checkPackageFile(
  expected: { sha256?: string; bytes?: number } | null | undefined,
  actual: { sha256: string; bytes: number } | null | undefined,
): PackageCheck {
  const want = normalizeSha256(expected?.sha256 || '')
  const got = normalizeSha256(actual?.sha256 || '')
  const wantBytes = Math.max(0, Math.round(Number(expected?.bytes) || 0))
  const gotBytes = Math.max(0, Math.round(Number(actual?.bytes) || 0))
  const sizeOk = !wantBytes || gotBytes === wantBytes
  const shaOk = Boolean(want && got && want === got)
  const sizeDelta = wantBytes ? gotBytes - wantBytes : 0
  const ok = shaOk && sizeOk
  let text = '和封存的那一刻一致：还是同一个包'
  if (!want) text = '这一版没记 SHA-256，核对不了大小之外的改动'
  else if (!got) text = '这个文件没算出 SHA-256，核对不了'
  else if (!shaOk) text = 'SHA-256 对不上：这个文件不是这一版封存的包'
  else if (!sizeOk) text = '大小和档案差 ' + Math.abs(sizeDelta) + ' B，包可能没下载完整'
  return { ok, shaOk, sizeOk, sizeDelta, text }
}

/**
 * 服务器上那一份的核对结果（v0.9.128）：作品页按需让服务端重算盘上的 SHA-256。
 * 和 checkPackageFile 分开：那边核「你手里这个文件」，这边核「服务器上封存的那一份」；
 * 两头都对得上，才说明这份交付从封存到现在没被动过。
 */
export type PackageServerCheck = {
  ok: boolean
  /** missing 文件没了、resized 大小变了、mismatch 大小没变但内容被换过 */
  state: 'ok' | 'mismatch' | 'resized' | 'missing' | 'unverifiable'
  checkedAt: string
  expected: { sha256: string; bytes: number }
  actual: { sha256: string; bytes: number } | null
}

/** 服务器那一份的状态说成人话：丢了 / 大小变了 / 内容被换过 / 只能比大小 / 对得上。 */
export function serverPackageText(result: PackageServerCheck | null | undefined): string {
  if (!result) return ''
  const want = Math.max(0, Math.round(Number(result.expected?.bytes) || 0))
  const got = Math.max(0, Math.round(Number(result.actual?.bytes) || 0))
  const delta = Math.abs(got - want)
  switch (result.state) {
    case 'missing':
      return '服务器上这一份没了：档案还在，盘上的文件已经不在了'
    case 'resized':
      return '服务器上这一份大小和档案差 ' + delta + ' B，可能被截断了'
    case 'mismatch':
      return '服务器上这一份和档案对不上：盘上这份不是当初封存的那一份'
    case 'unverifiable':
      return '这一版没记 SHA-256，只能比大小：大小对得上'
    default:
      return '服务器上这一份也对得上：还是当初封存的那一份'
  }
}

/**
 * 盘上这一份的提示（v0.9.128）：只在不对劲的时候说话，正常时不占地方。
 * 详情里带了 disk 才判断；老接口没有这一项就不猜。
 */
export function packageDiskAlert(pkg: ProjectDeliveryPackage | null | undefined): string {
  const disk = pkg?.disk
  if (!disk) return ''
  if (!disk.present) return '服务器上包没了'
  const want = Math.max(0, Math.round(Number(pkg?.bytes) || 0))
  if (want && Math.round(Number(disk.bytes) || 0) !== want) return '服务器上大小变了'
  return ''
}

/**
 * 封存包里的一个条目（v0.9.129）：名字、字节数与类别都来自包本身（读的是盘上那份的中央目录），
 * 不是把档案里记的清单再抄一遍。
 */
export type PackageEntryKind = 'image' | 'text' | 'html' | 'other'

export type PackageEntry = {
  name: string
  bytes: number
  kind: PackageEntryKind
}

/** 档案记的清单 vs 包里真有的条目：只比名字，差在哪就说哪 */
export type PackageManifestDiff = {
  recorded: number
  archived: number
  missing: string[]
  extra: string[]
}

export type PackageContents = {
  ok: boolean
  /** ok 目录读得出来；unreadable 包被截断或尾部被改过 */
  state: 'ok' | 'unreadable'
  readAt?: string
  error?: string
  /** 包多大，以及这一回为了读目录真从盘上读了多少字节（v0.9.131：按偏移读，不翻整包） */
  bytes?: number
  readBytes?: number
  entries?: PackageEntry[]
  /** 老包没记清单时是 null：那时不比较，也不把整包说成「多出来的」 */
  manifest?: PackageManifestDiff | null
}

/**
 * 包内目录和档案对不上时的那句话（v0.9.129）：只在真差的时候说，两边一致时是空串。
 * 名字最多列三个，剩下的只报个数——界面上这一行不是给人逐个核对的。
 */
export function packageManifestNote(diff: PackageManifestDiff | null | undefined): string {
  if (!diff || !diff.recorded) return ''
  const list = (names: string[]) =>
    names.length > 3 ? names.slice(0, 3).join('、') + ' 等 ' + names.length + ' 个' : names.join('、')
  const parts: string[] = []
  if (diff.missing.length) parts.push('包里少了 ' + list(diff.missing))
  if (diff.extra.length) parts.push('包里多了 ' + list(diff.extra))
  return parts.join('；')
}

/**
 * 整包体检的结果（v0.9.130）：把包里每一条都解开、重算 CRC32 之后，包在盘上还坏没坏的结论。
 * 它只说明「盘上这份包没坏」，不说明「内容对不对」——内容对不对是评审和现场页的事。
 * 每次体检都不缓存：要的就是「现在」这一份。
 */
export type PackageAuditFault = 'crc' | 'truncated' | 'encrypted' | 'method' | 'too-large' | 'unreadable'

export type PackageAuditFailure = {
  name: string
  bytes: number
  reason: PackageAuditFault
}

export type PackageAudit = {
  /** 每一条都对得上，而且没有因为预算没走完的条目 */
  ok: boolean
  /** ok 目录读得出来；unreadable 包被截断或尾部被改过，体检做不了 */
  state: 'ok' | 'unreadable'
  verifiedAt?: string
  error?: string
  total: number
  passed: number
  /** 超过解开预算、没走完的条数：如实说没走完，不装作都对得上 */
  skipped: number
  budgetBytes?: number
  failed: PackageAuditFailure[]
  bytes: number
  readBytes: number
  ms: number
  /** 老包没记清单时是 null：那时不比较，也不把整包说成「多出来的」 */
  manifest?: PackageManifestDiff | null
}

/** 体检里那一条是哪种坏法：短标签，列表里也用这一句 */
export function packageAuditFaultLabel(reason: string): string {
  switch (reason) {
    case 'crc':
      return 'CRC32 对不上'
    case 'truncated':
      return '在包里被截断了'
    case 'encrypted':
      return '是加密的，这里解不开'
    case 'method':
      return '压缩方式认不出来'
    case 'too-large':
      return '太大，超出单条上限'
    default:
      return '解不开'
  }
}

/**
 * 体检结论说成人话：通过了说通过，没通过点名第一条，没走完就说没走完。
 * 「对得上」只到字节这一层，所以这句话里不出现「内容没问题」。
 */
export function packageAuditText(audit: PackageAudit | null | undefined): string {
  if (!audit) return ''
  if (audit.state === 'unreadable') return audit.error || '包里的目录读不出来：可能被截断，或者尾部被改过'
  if (audit.failed.length) {
    const first = audit.failed[0]
    const head =
      audit.failed.length === 1
        ? '「' + first.name + '」' + packageAuditFaultLabel(first.reason)
        : '有 ' + audit.failed.length + ' 条对不上，第一条「' + first.name + '」' + packageAuditFaultLabel(first.reason)
    return audit.passed + ' 条对得上，' + head
  }
  if (audit.skipped) return '走了 ' + audit.passed + ' 条，剩下 ' + audit.skipped + ' 条超过体检上限没走完'
  return '全部 ' + audit.total + ' 条都对得上 CRC32'
}

/**
 * 巡检记下的一个封存包（v0.9.132）：定时任务验完之后，这一包当时是什么样。
 * state 说清是「验过」还是「没验成」——没验成不写成通过。
 */
export type PackageAuditRecord = {
  deliveryId: string
  version: number
  state: 'ok' | 'missing' | 'unreadable' | 'too-large'
  ok: boolean
  total: number
  passed: number
  skipped: number
  failed: PackageAuditFailure[]
  bytes: number
  readBytes: number
  ms: number
}

/** 上一次巡检整体：什么时候跑的、看了几个包、几个有问题 */
export type PackageAuditReport = {
  /** 空串表示还没巡检过（定时任务没跑过、或还没部署） */
  at: string
  checked: number
  problems: number
  packages: PackageAuditRecord[]
}

/**
 * 巡检那一行说人话：跟体检同一口径，只到「字节对不对」这一层。
 * 没验成的（包不在了 / 目录读不出来 / 太大）直说没验成，不写「通过」。
 */
export function packageAuditLine(record: PackageAuditRecord | null | undefined): string {
  if (!record) return ''
  if (record.state === 'missing') return '盘上那份不在了'
  if (record.state === 'unreadable') return '目录读不出来'
  if (record.state === 'too-large') return '太大，没验'
  if (record.ok) return record.total + ' 条都对得上'
  const first = record.failed[0]
  if (first) return record.passed + ' 条对得上，「' + first.name + '」' + packageAuditFaultLabel(first.reason)
  if (record.skipped) return '走了 ' + record.passed + ' 条，剩下 ' + record.skipped + ' 条没走完'
  return '有问题'
}

/**
 * 浏览器里算一段字节的 SHA-256。Web Crypto 只在 https / localhost 下提供，
 * 拿不到就抛人话，让界面说清「换个地址打开」，而不是静默失败。
 */
export async function sha256HexOfBytes(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('这个地址不是 HTTPS，浏览器不给算 SHA-256')
  const digest = await subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** 一次画布运行的摘要：运行记在画布服务里，作品页把名下所有版本的运行按时间归集成一条线 */
export type ProjectRun = {
  id: string
  flowId: string
  flowName: string
  status: string
  startedAt: string
  finishedAt: string
  durationMs: number
  /** 排队等了多久（v0.9.100）：0 = 没排过队 */
  queuedMs?: number
  total: number
  /** 已经开始的节点数：主动停止时按它结算（v0.9.101） */
  startedNodes?: number
  /** 用户停止 / 页面断开导致的中断，不是服务重启 */
  canceled?: boolean
  failed: number
  error: string
  credits: { cost: number; refunded: boolean; kept?: number; refundedAmount?: number } | null
  /** 这次运行跑的是第几版画布 */
  version: number
  /** 那一版画布还在不在：被删掉后运行记录仍留着，但画布打不开 */
  available: boolean
  /** 画布已删除时，这次运行是否留下了画布快照；留下就还能只读回看 */
  hasSnapshot?: boolean
}

/**
 * 工作台那一行上的回执（v0.9.139）：只要结论、时间、谁贴的与贴过几次。
 * 逐项比对与摘要在作品页的交付档案里，工作台一页几十条，不把它们搬过来。
 */
export type ProjectDeliveryReceiptBrief = {
  state: DeliveryReceipt['state']
  at: string
  via: 'link' | 'you'
  /** 这条交付上贴过几次：老记录只有 receipt 没有流水时按一次算 */
  count: number
  /**
   * 对不上的那几项（v0.9.144）：只给项名，不给两边写过的值。
   * 一页几十条不搬 checks；但「差哪一项」是这一行唯一能当场动手的线索，值得占几个字。
   */
  bad?: string[]
}

/**
 * 交付流水的一行（工作台「交出去的」）：某一版的某一次交付。
 * current 只回答「这一版还是不是当前版」，deliveredNow 只回答「这条作品现在还在交付状态」——
 * 两个都是事实，不能合成一句「已交付」，否则开过新版之后旧交付会被说成现状。
 */
export type ProjectDeliveryRow = {
  projectId: string
  title: string
  version: number
  /** 交付时间；老数据 / 开新版补的记录没有时间，是空串 */
  at: string
  /** 时间到底记下来没有：没记下的那行写「时间没记下」，不拿别的字段冒充 */
  atKnown: boolean
  /** 这条作品现在是第几版 */
  currentVersion: number
  /** 交的是不是当前这一版 */
  current: boolean
  /** 这条作品现在还在交付状态（交付过之后没开新版） */
  deliveredNow: boolean
  /** 那一版评过几次（含交付之后的重评）、最后一次结论：版本级事实，不是「交时」的结论 */
  reviews: number
  verdict: string
  /** 交的时候评审怎么说（交付时存下的快照）；null 当时还没评过；没有这个字段是升级前的老记录 */
  review?: ProjectDeliveryReview | null
  /** 这一版最近一评的问题数：界面拿它和交时快照比，判断「之后又评成了别的结论」（v0.9.86） */
  issues?: ReviewIssues | null
  /** 封存包编号：有编号才下载得到；老记录没有 */
  deliveryId?: string
  /** 交付时封存的整套；没有这个字段说明这一条交付没封存 */
  package?: ProjectDeliveryPackage
  /** 回执的结论；没贴过就是 null（有包才谈得上回执），老记录没有包也就没有这一项（v0.9.139） */
  receipt?: ProjectDeliveryReceiptBrief | null
  /**
   * 催过几次、最近一次是哪天（v0.9.144）：收包人一直没贴收据时，从这一行点「复制提醒」
   * 发出去的那几次。只记这件事发生过，不存发出去的那段话原文（它随时能按现在的事实重写）。
   */
  reminder?: { count: number; at: string } | null
  /** 现在能不能催：有封存包、还没收到回执、回执链接还在（v0.9.144） */
  remindable?: boolean
  /** 又发过几次那条链接（v0.9.146）；没重发过就是 null */
  resend?: { count: number; at: string } | null
  /**
   * 现在能不能「再发一次链接」（v0.9.146）：有包、还没回执、链接还在，而且确知这条地址一次都没被打开过。
   * 不知道有没有人点开过（升级前发的链接）就不给这个按钮——那种情况下重发是盲发，说了也判断不了结果。
   */
  resendable?: boolean
  /** 换过几条新链接（v0.9.147）：换过几次、最近一次哪天、换之前那条发过几次。没换过就是 null */
  relink?: { count: number; at: string; resends: number } | null
  /**
   * 换掉的那条旧地址还被点过几次（v0.9.149）：点着旧的，说明新的那条多半没送到他手上。
   * 一次都没被点过就是 null——没发生的事不写成一行字。
   */
  retiredHits?: { count: number; at: string } | null
  /**
   * 现在能不能「换一条新链接」（v0.9.147）：同一条地址又发过两次还是没人打开，而且确知一次都没被打开过。
   * 打开过的、不知道打开没有的都不给——前者的地址可能正被看着，后者的地址也许已经送到，换掉只会更糟。
   * v0.9.150 起还有一条上限：换过两次就不再给换，换的是地址不是渠道。
   */
  relinkable?: boolean
  /**
   * 换到头了（v0.9.150）：已经换过两次地址，这一条还是一次都没被打开。
   * 界面据此把「换一条新链接」换成「问问收到没」——到这一步再换地址只是换个 token 重发同一条消息。
   */
  relinkCapped?: boolean
  /**
   * 这条回执链接被打开过几次（v0.9.145）。null = 不知道（没有链接，或者链接发出时还没开始记）——
   * 不知道就什么都不说，不写「还没被打开」。
   */
  visits?: DeliveryVisits | null
  /**
   * 他点过「收到了」（v0.9.151）：回执还没回来，但「没送到」已经排除了。
   * null = 没点过或者这一条没有回执链接。
   */
  ack?: DeliveryAck | null
  /**
   * 这一条是给谁的（v0.9.152）：发件人写的称呼，空串 = 没写（老记录都是这样）。
   * 界面上写成「给王老师」；没写就什么都不说。
   */
  recipient?: string
  /**
   * 他回了什么（v0.9.153）：收包人说的原话；null = 还没记。
   * 界面只说「他说了什么」，不据此判断「满意 / 不满意」。
   */
  reply?: DeliveryReply | null
}

/**
 * 按人看的一堆数（v0.9.154）：同一个收件人下面的交付条数、还欠着回执的条数，
 * 以及「点这一下落在哪一条」——优先他还欠着的那条里最近交付的一条。
 */
export type DeliveryPerson = {
  name: string
  count: number
  /** 其中封过包的条数：没有包的老交付谈不上回执，不能被说成「回执都回来了」 */
  sealed: number
  /** 还欠着回执的条数：有封存包、还没收到收据（他点了「收到了」的也算欠着，只差验） */
  pending: number
  /** 上面那些里，他自己点过「收到了」的条数（v0.9.151） */
  pendingAcked: number
  /**
   * 欠着的那几条里最早一条是哪天发出的（v0.9.155）：等得多久只看这一条。
   * 空串 = 那几条都没记下时间，界面就不说等了几天。
   */
  oldestPendingAt?: string
  /**
   * 这个人名下催过几次、最近一次哪天（v0.9.155）：一次都没催过就是 null。
   * replyAt（v0.9.156）是最近一次催收之后的第一条回执：空串 = 催完还没有回音。
   */
  reminded?: { count: number; at: string; replyAt?: string } | null
  /** 点下去要打开哪一条交付；万一哪条连 id 都没有（老记录），deliveryId 是空串 */
  target: { projectId: string; deliveryId: string; version: number }
}

/** 交付流水的整份数字按全部记录算，不因为只取了一页而变小 */
export type DeliveryLedger = {
  items: ProjectDeliveryRow[]
  total: number
  /** 交付过几条作品（不是几条记录） */
  projects: number
  /** 其中几条交的还是当前这一版 */
  currentTotal: number
  /** 其中几条交出去之后这一版又被评成了别的结论（v0.9.86）：按交付记录数，不按作品数 */
  drifted: number
  /** 最近一次交付的时间；一条带时间的都没有就是空串 */
  lastAt: string
  /** 回执的四个数（v0.9.139）：按整份记录算，sealed = matched + mismatched + unclear + pending */
  receipts: DeliveryLedgerReceipts
  /**
   * 按人看（v0.9.154）：写了收件人的那几条按人归堆，回答「谁还欠着回执」。
   * 这是整份记录的账，不随分页变；没写收件人的另算一个数。
   */
  people?: DeliveryPerson[]
  /** 没写收件人的交付条数（v0.9.154）：老交付或者还没补写，不混进任何人名下 */
  unlabeled?: number
  offset: number
  hasMore: boolean
}

/**
 * 交出去的这几份里，回执回来了几份（v0.9.139）。
 * 只有封过包的交付才谈得上回执：升级前那几条没有包，不算「还没回来」，不然会凭空多出待办。
 */
export type DeliveryLedgerReceipts = {
  /** 封过包的交付条数 */
  sealed: number
  matched: number
  mismatched: number
  /** 贴回来了，但对方读不出来，或者哈希对上而结论打架 */
  unclear: number
  /** 封了包、还没收到回执 */
  pending: number
  /**
   * pending 里已经发出超过 3 天的条数（v0.9.144）：不是第五种结论，是 pending 的一个子集，
   * 所以 sealed = matched + mismatched + unclear + pending 这条仍然成立。
   */
  pendingLate: number
  /**
   * pending 里回执链接一次都没被打开过的条数（v0.9.145）：同样是 pending 的子集。
   * 只说「没人打开过这条地址」，不说「他没收到」——链接可能被预览抓取过，也可能真没送到。
   */
  pendingUnopened: number
  /**
   * pendingUnopened 里「又发过 2 次以上、链接还是没被打开」的条数（v0.9.146），同样是 pending 的子集。
   * 这几条再发同一条地址也不会有新结果：该换渠道、换个人，或者换一条新链接。
   */
  pendingStuck: number
  /**
   * pendingUnopened 里「已经换过一条新链接、新链接还是没人打开」的条数（v0.9.147），同样是 pending 的子集。
   * 到这一步别再换地址了：两条地址都没人打开，问题多半不在链接上，该换个收件人或换个渠道。
   */
  pendingRelinked: number
  /**
   * pending 里「他点过「收到了」」的条数（v0.9.151）：pending 的子集，但与 pendingUnopened 互斥——
   * 点得动「收到了」说明他打开过、东西也到手了，这几条不该再算进「可能没送到」。
   */
  pendingAcked: number
}

/**
 * 工作台那一行上的回执怎么读（v0.9.139）。
 * 只说结论、时间与贴过几次；「谁贴的」放在 title 里，一行里不塞三句。
 */
export function ledgerReceiptText(receipt: ProjectDeliveryReceiptBrief | null | undefined): string {
  if (!receipt) return ''
  const count = Math.max(1, Math.round(Number(receipt.count) || 1))
  const at = receiptAtText(receipt.at)
  // 差在哪一项（v0.9.144）：对不上时把项名补在结论后面，这一行就不用点进去才知道差什么。
  // 只列表里认得的项，老收据没有逐项就还是只写「对不上」。
  const bad = ledgerReceiptBadText(receipt.bad)
  const line = '回执 · ' + receiptStateText(receipt.state) + (bad ? ' · 差在' + bad : '') + (at ? ' · ' + at : '')
  return count > 1 ? line + ' · 贴过 ' + count + ' 次' : line
}

/** 对不上的那几项读成人话：「整包 SHA-256」「字节数、整包 SHA-256」；没有就是空串。 */
export function ledgerReceiptBadText(bad: string[] | null | undefined): string {
  const keys = (Array.isArray(bad) ? bad : [])
    .filter((key): key is string => typeof key === 'string' && Boolean(key))
    .map((key) => receiptCheckLabel(key))
  return keys.join('、')
}

/** 回执时间只写到分钟：与作品页那行结论同一口径，不在这行里给秒。 */
function receiptAtText(at: string): string {
  const ms = Date.parse(String(at || ''))
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/**
 * 清单顶上那句回执汇总（v0.9.139）：数字要能对上，话要说得出口。
 * 「都还没回执」是一种真实情况，不能写成「0 次回执对得上，3 次还没回执」那种数数的口气。
 */
export function ledgerReceiptTotalsText(totals: DeliveryLedgerReceipts | null | undefined): string {
  const sealed = Math.max(0, Math.round(Number(totals?.sealed) || 0))
  if (!sealed) return ''
  const matched = Math.max(0, Math.round(Number(totals?.matched) || 0))
  const mismatched = Math.max(0, Math.round(Number(totals?.mismatched) || 0))
  const unclear = Math.max(0, Math.round(Number(totals?.unclear) || 0))
  const pending = Math.max(0, Math.round(Number(totals?.pending) || 0))
  if (pending === sealed) return '封过包的 ' + sealed + ' 次都还没收到回执。'
  const parts: string[] = []
  if (matched) parts.push(matched + ' 次回执对得上')
  if (mismatched) parts.push(mismatched + ' 次对不上')
  if (unclear) parts.push(unclear + ' 次贴回来了，但读不出或说法打架')
  if (pending) parts.push(pending + ' 次还没收到回执')
  return '封过包的 ' + sealed + ' 次：' + parts.join('，') + '。'
}

/**
 * 从工作台点进来落在哪一条（v0.9.140）：地址里带着交付记录的编号，
 * 作品页据此把档案展开到那一版、把收据摊开，不用进来再从几十行里找。
 * 按编号找，不按版次猜：同一版重新封过包会换一条记录，旧链接找不到就说找不到。
 */
export type DeliveryLanding = {
  /** 地址里点名的那条交付记录 */
  id: string
  /** 落在第几版；找不到是 0 */
  version: number
  /** 这一版有没有封存包：没有就只开档案，没有收据可摊 */
  hasPackage: boolean
  /** 这一版已经贴过的回执结论（没贴过就是 null） */
  receipt: { state: DeliveryReceipt['state'] } | null
  /** 档案里找不到这条记录（旧链接 / 后来重新封过包） */
  missing: boolean
}

export function deliveryLandingOf(
  project: Project | null | undefined,
  deliveryId: string | null | undefined,
): DeliveryLanding | null {
  const id = String(deliveryId || '').trim()
  if (!id) return null
  const row = deliveryArchive(project).rows.find((entry) => String(entry.id || '') === id)
  if (!row) return { id, version: 0, hasPackage: false, receipt: null, missing: true }
  return {
    id,
    version: Math.max(1, Math.round(Number(row.version) || 0)),
    hasPackage: Boolean(row.id && row.package),
    receipt: row.receipt ? { state: row.receipt.state } : null,
    missing: false,
  }
}

/**
 * 那一句「你是从哪来的」（v0.9.140）：只说得出口的事实——哪一版、有没有包、贴没贴过。
 * 找不到就不装作找到了，把「可能重新封过包」说在前面。
 */
export function deliveryLandingText(landing: DeliveryLanding | null | undefined): string {
  if (!landing) return ''
  if (landing.missing) return '从工作台点进来的那一条已经不在这份档案里了：可能这一版后来重新封过包。'
  const head = '从工作台点进来的这一条：v' + Math.max(1, Math.round(Number(landing.version) || 1))
  if (!landing.hasPackage) return head + ' · 这一版没封存包，只有交付记录。'
  if (landing.receipt) return head + ' · 回执' + receiptStateText(landing.receipt.state) + '，收据已经摊开。'
  return head + ' · 还没收到回执，下面可以贴一段收据对一遍。'
}

/**
 * 作品列表的筛法：只分「当前这一版交没交出去」，评审结论继续写在胶囊里。
 * 与状态胶囊同一口径：交付了 v2 又开 v3 的那条算「在做」，不算「已交付」。
 */
export type ProjectBucket = 'all' | 'active' | 'delivered'

/** 分面计数：按关键字算、不按当前状态算——换了状态，另一排数字仍然是真的 */
export type ProjectListFacets = { all: number; active: number; delivered: number }

export type ProjectSummary = Project & {
  template: ProjectTemplateBrief | null
  reviews: ProjectReviews
  /** 按版本分组的评审计数：状态胶囊只看当前这一版 */
  versionCounts: Record<string, ProjectReviews>
  /** 这条作品名下所有版本画布一共跑过几次 */
  runs: { count: number }
  /** 卡片上的花费：评审与画布运行加在一起，退过款的不算 */
  spend?: ProjectSpend
  /** 卡片上的分享状态；从没分享过就是 null */
  share: ProjectShareBrief | null
  /** 管当前这一版最近一次评审的人工拍板；还没人拍板就是 null */
  decision?: ProjectDecision | null
}

/**
 * 这条作品的模板「从哪来」（v0.9.35）：
 * original 是平台上的原片（有地址、作者、互动数）；canvas / agent 是自己产出的模板，本来就没有原片。
 * 老数据没有来源信息时整个 origin 是 null，页面不显示这一块，也不编一个「来源未知」。
 */
export type ProjectTemplateOrigin = {
  kind: 'original' | 'canvas' | 'agent'
  platform: string
  platformLabel: string
  author: string
  /** 原片地址；canvas / agent 一律空串 */
  url: string
  publishedAt: string
  /** 互动数；一样都抓不到时是 null（不是全 0，也不能拿 0 冒充「没人看」） */
  stats: { plays: number; likes: number; comments: number; shares: number; collects: number } | null
}

export type ProjectTemplateDetail = ProjectTemplateBrief & {
  hook: string
  hookType: string
  platformLabel: string
  structure: ScriptBeat[]
  storyboard: StoryboardShot[]
  timing: TemplateTiming | null
  cover: string
  reuseCount: number
  /** 来源：原片还是自己产出的模板；服务端现算，不落库 */
  origin?: ProjectTemplateOrigin | null
}

export type ProjectFlowBrief = { id: string; name: string; nodes: number; updatedAt: string }

/**
 * 作品页看到的脚本。
 * source=project 表示这条作品自己的版本（改过就不再跟随模板）；template 表示还在跟随模板。
 * timing 是这份脚本按当前语速档重算后的口播时长，改完口播「要念几秒」随之更新。
 */
export type ProjectScript = {
  hook: string
  structure: ScriptBeat[]
  source: 'project' | 'template'
  updatedAt: string
  timing: TemplateTiming | null
}

/**
 * 某一版开新版时存下的脚本快照（v0.9.114）。
 * 没有 timing：快照是当时的原文，不拿现在的模板重新对账。
 */
export type ProjectVersionScriptSnapshot = {
  hook: string
  structure: ScriptBeat[]
  source: 'project' | 'template'
  updatedAt: string
}

/**
 * 作品列表卡片上的分享状态：只够写一枚胶囊与一个次数。
 * 不带 token、不带记录键、不带每一轮明细——那些只在作品页的分享面板里。
 */
export type ProjectShareBrief = {
  /** 当前是否有链接正在分享 */
  live: boolean
  /** 分享过几轮：正在分享的那条也算一轮 */
  rounds: number
  /** 各轮累计打开次数（次数不是人数） */
  opens: number
  /** 最近一次被打开的时间；没人打开过是空串 */
  lastAt: string
  lastClient: ShareVisits['lastClient']
}

/** 分享链接被打开过几次：只记次数与客户端类别，不记 IP、不区分是谁 */
export type ShareVisits = {
  opens: number
  firstAt: string
  lastAt: string
  /** wechat 微信内打开 / mobile 手机或平板 / desktop 电脑浏览器 / other 未知 */
  lastClient: 'wechat' | 'mobile' | 'desktop' | 'other' | ''
}

/** 作品级只读分享：token 只在作品页的分享面板与地址里出现，列表接口不返回 */
export type ProjectShare = {
  token: string
  createdAt: string
  /** 打开后，拿到链接的人也能打印「当前版 vs 上一版」；默认关 */
  compare: boolean
  visits?: ShareVisits
}

/** 一轮已经停用的分享：地址打不开，但那次被打开过几次还留着（只留最近 8 轮） */
export type ShareHistoryEntry = { createdAt: string; closedAt: string; visits: ShareVisits }

/** 工作台的分享汇总：一条作品一行，visits 是各轮累计（次数相加，最近一次取最晚的那轮） */
export type ShareSummaryRow = {
  projectId: string
  title: string
  /** 当前是否有链接正在分享 */
  live: boolean
  /** 分享过几轮：正在分享的那条也算一轮 */
  rounds: number
  /** 最近一轮停用时间；正在分享且没有历史时为空串 */
  lastClosedAt: string
  visits: ShareVisits
}

/**
 * AI 生成内容标识（《人工智能生成合成内容标识办法》）：分享与导出都带它。
 * label 是给人看的显式标识，notice 是一句边界说明，regulation 只在说明里引用。
 */
export type AiLabel = {
  label: string
  generator: string
  aiGenerated: boolean
  regulation: string
  notice: string
  version: string
}

/** 分享页读到的公开视图：服务端白名单挑过，不含账号、画布与模板 id */
export type SharedProjectShot = {
  shotNo: number
  startSec: number
  endSec: number
  visual: string
  camera: string
  caption: string
  audio: string
  /** 分镜帧图：走带 token 的公开地址，没有那一帧时是空串 */
  frameUrl: string
}

export type SharedProject = {
  project: { title: string; status: ProjectStatus; version: number; createdAt: string; updatedAt: string }
  template: {
    title: string
    platformLabel: string
    contentType: string
    durationSec: number
    beats: number
    shots: number
  } | null
  script: { hook: string; structure: ScriptBeat[]; source: 'project' | 'template'; timing: TemplateTiming | null } | null
  storyboard: SharedProjectShot[]
  stats: { beats: number; shots: number; reviews: number; lastVerdict: string; lastAt: string; runs: number }
  /** 分享者打开了两版对照、且上一版已归档时才有；固定当前版 vs 上一版 */
  versionCompare: { base: number; target: number } | null
  sharedAt: string
  /** 这份公开视图里有 AI 生成内容：页面上要有看得见的标识 */
  aiLabel: AiLabel
}

/** 这条作品沉淀出去的一条模板：作品只记「存过」，模板正文在模板库那边。 */
export type ProjectTemplateSave = {
  id: string
  title: string
  createdAt: string
  beats: number
  shots: number
}

export type ProjectDetail = {
  project: Project
  /** 这条作品的只读分享链接状态；没开就是 null */
  share: ProjectShare | null
  /** 以前开过的链接：按停用时间倒序，停用后地址打不开，打开记录还能回看 */
  shareHistory: ShareHistoryEntry[]
  template: ProjectTemplateDetail | null
  /** 这条作品沉淀过哪几条模板（模板那边记着 projectId，这里现算；刷新还在） */
  templateSaves?: ProjectTemplateSave[]
  flow: ProjectFlowBrief | null
  /** 作品页自己的脚本：自己的版本优先，没有则回退到模板 */
  script: ProjectScript | null
  reviews: ReviewSummary[]
  /** 归档版本（不含当前版），按归档先后 */
  versions: ProjectVersionView[]
  /** 按版本分组的评审计数：键是版本号，用于版本对照 */
  versionCounts: Record<string, ProjectReviews>
  /**
   * 每个版本相对上一版改了什么（v0.9.114）：键是版本号，值是一句人话。
   * 缺这一项表示那一侧没有可比对的数据（画布被删 / 没存脚本快照），页面不硬写「没改」。
   */
  versionChanges?: Record<string, string>
  /**
   * 以旧版为底的那一版跟底座对账（v0.9.116）：键是版次，值是底座与一句人话。
   * 只给底座不是上一版的版本；页面优先读它，把「比 v3」换成「比 v1」。
   */
  versionBaseChanges?: Record<string, { base: number; text: string }>
  /** 这条作品的拍板记录（按时间倒序）；管当前那一版的那条在 decision 里 */
  decisions?: ProjectDecision[]
  decision?: ProjectDecision | null
  /**
   * 当前这一版「已看过」的便利贴：版次与评审时间都对上才有，否则是 null。
   * 它只把这条从待办里拿开，不改结论、不改胶囊——和 decision 是两回事。
   */
  ack?: ProjectAck | null
  /** 运行归集：当前版与归档版的运行合成一条时间线，按开始时间倒序 */
  runs: ProjectRun[]
  runTotal: number
  /** 按版本分组的运行次数：版本对照里写「这一版跑过几次」 */
  runCounts: Record<string, number>
  /** 这条作品花了多少积分：合计、评审与运行各多少、最近一次是什么时候 */
  spend?: ProjectSpend
}

/**
 * 状态胶囊：文案 + 语气。语气只决定颜色，不改变语义。
 * 评过不等于过了：有结论时直接写结论，「已评审」只在没有结论的老记录上出现。
 * 有人拍过板时写人的那一句：胶囊回答「这一版谁拍的板」，人拍过就不再拿模型的「需人工确认」当结论。
 * 与服务端 server/project-status.mjs 同一口径——交付稿上写的状态和这里必须是一句话。
 */
export function projectStatus(
  project: Project,
  reviews: ProjectReviews,
  decision: ProjectDecision | null = null,
): { text: string; tone: 'idle' | 'live' | 'ok' | 'warn' | 'fail' | 'done'; verdict: string; human?: 'pass' | 'reject' } {
  if (deliveredCurrent(project)) return { text: '已交付', tone: 'done', verdict: '' }
  if (!project.flowId) return { text: '待开画布', tone: 'idle', verdict: '' }
  if (!reviews.count) return { text: '在做', tone: 'live', verdict: '' }
  const verdict = reviews.lastVerdict || ''
  if (decision && (decision.decision === 'pass' || decision.decision === 'reject')) {
    return {
      text: decision.decision === 'pass' ? '评审 · 人工通过' : '评审 · 人工不通过',
      tone: decision.decision === 'pass' ? 'ok' : 'fail',
      verdict,
      human: decision.decision,
    }
  }
  if (verdict === 'pass') return { text: '评审 · 通过', tone: 'ok', verdict }
  if (verdict === 'needs_review') return { text: '评审 · 需人工确认', tone: 'warn', verdict }
  if (verdict === 'fail') return { text: '评审 · 不通过', tone: 'fail', verdict }
  return { text: '已评审', tone: 'ok', verdict: '' }
}

/**
 * 某一版评过没有：版本划分之前留下的评审记在版本 0 上，v1 要把它们算进来，
 * 否则刚上线的老作品会突然显示「这一版还没进评审」。
 */
export function reviewsForVersion(counts: Record<string, ProjectReviews>, version: number): ProjectReviews {
  const own = counts[String(version)]
  const legacy = version === 1 ? counts['0'] : undefined
  // 问题数与 lastVerdict 同一个来源：这一版最近那一次评审，不把两次评审的问题相加
  if (!own && !legacy) return { count: 0, lastVerdict: '', lastAt: '', issues: null }
  if (!own) return { ...legacy!, issues: legacy!.issues ?? null }
  if (!legacy) return { ...own, issues: own.issues ?? null }
  const latest = String(own.lastAt) >= String(legacy.lastAt) ? own : legacy
  return {
    count: own.count + legacy.count,
    lastVerdict: latest.lastVerdict,
    lastAt: latest.lastAt,
    issues: latest.issues ?? null,
  }
}

/**
 * 某一版画布跑过几次：与评审同一套口径，版本划分之前留下的运行算进 v1，
 * 否则老作品刚开版本视图时会显示「这一版没跑过」。
 */
export function runsForVersion(counts: Record<string, number>, version: number): number {
  const own = Number(counts[String(version)]) || 0
  const legacy = version === 1 ? Number(counts['0']) || 0 : 0
  return own + legacy
}

export type ProjectStepKey = 'canvas' | 'review' | 'continue' | 'deliver' | 'done'

/**
 * 下一步只有一件事：
 *   没画布 → 用这条脚本开画布；有画布没评审 → 送一次评审；评过了看结论——通过就交出去，有意见就照着改；
 *   交付了 → 收尾。作品页主卡与工作台都读这一个函数，避免两处口径分叉。
 */
export function projectStep(
  project: Project,
  reviews: ProjectReviews,
  decision: ProjectDecision | null = null,
): { key: ProjectStepKey; label: string; title: string; hint: string; cta: string } {
  if (deliveredCurrent(project)) {
    const delivery = deliveryOf(project)
    return {
      key: 'done',
      label: '下一步 · 已交付',
      title: '这条已经交付',
      // 交的是哪一版要写出来：交付稿与版本对照里也记着同一件事
      hint: delivery
        ? '交付的是 v' + delivery.version + '；画布与评审都留在记录里，开一版新的就回到「在做」，上一版的交付时间仍然查得到'
        : '画布与评审都留在记录里，随时可以重新打开照着改',
      cta: '再打开画布',
    }
  }
  if (!project.flowId) {
    return {
      key: 'canvas',
      label: '下一步 · 开画布',
      title: '先开一张画布',
      hint: '用这条作品现在的脚本生成画布草稿：输入节点带钩子、复刻节点带完整提示词',
      cta: '用这条脚本开画布',
    }
  }
  if (!reviews.count) {
    return {
      key: 'review',
      label: '下一步 · 送评审',
      title: '画布有了，送一次评审',
      hint: '拿你这一版的画面跑一遍视觉评审，结论会记在这条作品下',
      cta: '用评审看这版',
    }
  }
  // 人拍过板就听人的：拍板通过 → 交出去；拍板不通过 → 回去改。模型结论只是它下面的那一层。
  if (decision?.decision === 'pass') {
    return {
      key: 'deliver',
      label: '下一步 · 交付',
      title: '这一版你拍板通过了',
      hint: '人已经拍过板：把脚本、分镜、评审结论与运行记录打成交付稿或交付包发出去',
      cta: '交付这一版',
    }
  }
  if (decision?.decision === 'reject') {
    return {
      key: 'continue',
      label: '下一步 · 继续改',
      title: '你拍板这一版不行，按意见改',
      hint: '人已经否了这一版：按评审里指出的问题改完，再评一次；再评出新结论后需要重新拍板',
      cta: '继续画布',
    }
  }
  // 这一版评审通过了：下一步不再是改，而是把这版交出去
  if (reviews.lastVerdict === 'pass') {
    return {
      key: 'deliver',
      label: '下一步 · 交付',
      title: '这一版评审通过了',
      hint: '把脚本、分镜、评审结论与运行记录打成交付稿或交付包，发给剪辑、制片或甲方',
      cta: '交付这一版',
    }
  }
  return {
    key: 'continue',
    label: '下一步 · 继续做',
    title: reviews.lastVerdict === 'fail' ? '评审没过，按意见改一版' : '按评审意见改一版',
    hint: '评审结论里的修正建议逐条落到画布上，改完可以再评一次',
    cta: '继续画布',
  }
}