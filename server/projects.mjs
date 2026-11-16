// 作品（Project）：一条内容的主线对象。
//
// 默认只存引用：脚本留在绑定的模板上，画布在流程服务里，评审在 reviews.json 里。
// 唯一例外是**脚本的 copy-on-write**：用户在作品页改脚本时，才把脚本复制成作品自己的版本
// （见 project-script.mjs）。没改过的作品仍然跟着模板走，不会平白多一份过期副本。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { canAccess } from './owner.mjs'
import { normalizeStoredScript } from './project-script.mjs'
import { visitKey } from './share-visits.mjs'
// 交付那一刻的评审结论要从评审库现读；只读、不写评审（v0.9.85）
import { reviewSummaryByVersion } from './reviews.mjs'
import { reviewsForVersion } from './project-status.mjs'
// 交付包封存（v0.9.125）：标记交付时落一份 zip，之后改模板 / 开新版都不动它
import {
  dropDeliveryPackage,
  dropProjectDeliveryPackages,
  pruneDeliveryPackages,
} from './delivery-packages.mjs'

const projectsFile = path.join(config.dataDir, 'projects.json')
const MAX_PROJECTS = 200
const STATUSES = ['active', 'done']
// 一条作品最多保留 20 版：再多就不是「对照」而是流水账，旧版本也不该无限长下去
const MAX_VERSIONS = 20
export const PROJECT_VERSION_LIMIT = MAX_VERSIONS
// 一条作品最多留 8 轮分享记录：更早的链接没人会回去看，留个上限免得作品记录无限长
const MAX_SHARE_HISTORY = 8
export const SHARE_HISTORY_LIMIT = MAX_SHARE_HISTORY
// 交付记录：一次「标记交付」= 哪一版、什么时候交出去。留 20 条，与版本上限对齐
const MAX_DELIVERIES = 20
// 收件人称呼（v0.9.152）：一条交付是发给谁的，只写给自己人看。24 个字够写「王老师 · 内容组」，
// 再长就不是称呼而是备注了——这里只放一个称呼，备注属于作品本身。
const MAX_RECIPIENT = 24
export const RECIPIENT_LIMIT = MAX_RECIPIENT
// 他回了什么（v0.9.153）：收据只给一个结论（对得上 / 对不上），他真正说的那句
// 「第 3 张背景色偏了」没有地方落。200 个字、最多 6 行：够写一段能直接拿去改的回复，
// 再长就不是「他回了一句」，而是另一份评审——那属于评审，不属于这一条交付。
const MAX_REPLY = 200
const REPLY_LINES = 6
export const REPLY_LIMIT = MAX_REPLY
/** 一条交付记录最多带多少条包内清单：和 delivery-packages.mjs 的上限保持一致。 */
const MAX_PACKAGE_FILES = 60

/**
 * 回执链接的 token（v0.9.137）：16 位十六进制，和交付包编号同一套形状，放地址里不用转义。
 * 它只决定「谁能把这张收据贴回来」，不参与包的计算；换一条就是重新生成一枚，旧的立刻不认。
 */
export function newReceiptToken() {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fsp.readFile(projectsFile, 'utf8'))
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  return cache
}

// 整文件读改写：写盘串成一条队列，避免两个请求共用一个 .tmp 互相 rename 掉对方。
function enqueueWrite(task) {
  const next = writeChain.then(task, task)
  writeChain = next.catch(() => {})
  return next
}

async function persist(list) {
  cache = list
  return enqueueWrite(async () => {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const tmp = projectsFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    // Windows 上 rename 撞上别人正好在读这份文件时是 EPERM / EBUSY（2026-11-15 本地实测：
    // 验收脚本读盘的时机压在改写那一刻，一次改名就 500 了）。这不是文件坏了，隔一会儿再来一次就过去；
    // 产业上的 Linux 不会出这种事，但桌面端就在 Windows 上跑，所以这里按「占用」重试，不按「失败」退出。
    // 三次都不行才抛：不能把一次瞬时占用当成写成功。
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fsp.rename(tmp, projectsFile)
        return
      } catch (error) {
        lastError = error
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(String(error?.code || ''))) break
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw lastError
  })
}

const clip = (value, max) => String(value ?? '').slice(0, max)

// 开新版那一刻的脚本快照：版本之间唯一能对照的「这一版说了什么」。
// 脚本本身只有一份（作品级），归档时不留快照，历史版本的口播就永远找不回来了。
function normalizeVersionScript(raw) {
  if (!raw || typeof raw !== 'object') return null
  const structure = (Array.isArray(raw.structure) ? raw.structure : [])
    .filter((beat) => beat && typeof beat === 'object')
    .slice(0, 12)
    .map((beat) => ({
      beat: clip(beat.beat, 60),
      voiceover: clip(beat.voiceover, 600),
      onScreen: clip(beat.onScreen, 200),
      purpose: clip(beat.purpose, 200),
      startSec: Number(beat.startSec) || 0,
      endSec: Number(beat.endSec) || 0,
      expectedSec: Number(beat.expectedSec) || 0,
      fit: beat.fit === 'tight' || beat.fit === 'loose' ? beat.fit : '',
    }))
  if (!structure.length) return null
  return {
    hook: clip(raw.hook, 400),
    structure,
    // 这一版的脚本当时是「自己的」还是「跟随模板」：模板之后改了，快照仍然是当时的样子
    source: raw.source === 'template' ? 'template' : 'project',
    updatedAt: String(raw.updatedAt || ''),
  }
}

// 以旧版为底（v0.9.116）：只认「更早的整数版次」，越界或指向自己一律当线性版本。
function normalizeBasedOn(raw, version) {
  const value = Math.round(Number(raw))
  const top = Math.max(1, Math.round(Number(version) || 0))
  return Number.isFinite(value) && value >= 1 && value < top ? value : 0
}

function normalizeVersion(raw, fallbackN) {
  const n = Math.round(Number(raw?.n))
  const normalizedN = Number.isFinite(n) && n > 0 ? n : fallbackN
  return {
    n: normalizedN,
    flowId: String(raw?.flowId || ''),
    name: clip(raw?.name || '未命名画布', 60),
    archivedAt: String(raw?.archivedAt || ''),
    script: normalizeVersionScript(raw?.script),
    basedOn: normalizeBasedOn(raw?.basedOn, normalizedN),
  }
}

// ---------- 分享历史 ----------
// 停用分享时 token 会被清掉（链接当场失效），但「那一轮被打开过几次」是发生过的事。
// 这里只留 token 的哈希前缀、开始与停用时间；记录键打不开链接，却能和打开记录对上。
function normalizeShareHistory(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      key: /^[0-9a-f]{16}$/.test(String(entry.key || '')) ? String(entry.key) : '',
      createdAt: String(entry.createdAt || ''),
      closedAt: String(entry.closedAt || ''),
    }))
    .filter((entry) => entry.key)
    .slice(0, MAX_SHARE_HISTORY)
}

const DELIVERY_VERDICTS = ['pass', 'needs_review', 'fail']
const ISSUE_KEYS = ['blocker', 'major', 'minor', 'info', 'counted', 'observations']

// 问题数只认六个整数字段：盘上被手改坏了也不让 NaN 流到页面上去
function normalizeIssues(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const key of ISSUE_KEYS) out[key] = Math.max(0, Math.round(Number(raw[key]) || 0))
  return out
}

// 交付时的评审快照：当时的结论、那次评审的时间、那一版的问题数。
// 三种状态都写清楚：对象 = 记下了；null = 当时确实还没评过；字段不存在 = 升级前的老记录（不知道）。
function normalizeDeliveryReview(raw) {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object') return null
  const verdict = String(raw.verdict || '')
  return {
    verdict: DELIVERY_VERDICTS.includes(verdict) ? verdict : '',
    // 时间只认字符串：盘上被改成一个数字时如实写空，不让 '7' 冒充一个时刻
    at: typeof raw.at === 'string' ? raw.at : '',
    issues: normalizeIssues(raw.issues),
  }
}

// 交付包元数据（v0.9.125）：不存磁盘路径，只存编号、字节数、哈希与下载时用的中文名。
// 老记录没有这个字段，读出来还是没有——不拿今天现打的包冒充当初封存的那一份。
function normalizeDeliveryPackage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const bytes = Math.max(0, Math.round(Number(raw.bytes) || 0))
  const sha256 = String(raw.sha256 || '').toLowerCase()
  const fileName = String(raw.fileName || '').trim().slice(0, 180)
  if (!bytes || !/^[0-9a-f]{64}$/.test(sha256) || !fileName) return null
  const base = {
    bytes,
    sha256,
    fileName,
    savedAt: String(raw.savedAt || ''),
  }
  // 包内清单（v0.9.126）：老包（v0.9.125）没有这两项，界面只说大小、不假装列得出来。
  const fileCount = Math.min(9999, Math.max(0, Math.round(Number(raw.fileCount) || 0)))
  const files = (Array.isArray(raw.files) ? raw.files : [])
    .map((file) => ({
      name: String(file?.name || '').replace(/\p{Cc}/gu, '').trim().slice(0, 160),
      bytes: Math.max(0, Math.round(Number(file?.bytes) || 0)),
    }))
    .filter((file) => file.name)
    .slice(0, MAX_PACKAGE_FILES)
  if (fileCount && files.length) {
    base.fileCount = fileCount
    base.files = files
  }
  return base
}

// 收据对账（v0.9.136）：收包人贴回来的那段收据比对完的结论，挂在交付记录上。
// 只存比对结果与对方那几项值，不存收据原文；四种状态之外一律当没核对过。
const RECEIPT_STATES = ['match', 'mismatch', 'broken', 'conflict']
const RECEIPT_CHECK_KEYS = ['version', 'package', 'bytes', 'sha256', 'verdict']
// 一条交付记录保留最后几次对账（v0.9.138）：链接发出去之后，对方可能先贴一张对不上的、
// 换了包再贴一张对得上的。只存最近一次等于把前一次的证据擦掉——所以留流水，但只留 5 条。
const MAX_RECEIPTS = 5
// 催过几次（v0.9.144）：收包人一直没贴收据时，发件人点「催一句」发出去的那几次。
// 与回执同一个上限 5 条——自己催到第六次还没动静，一天催十遍也改变不了什么。
const MAX_REMINDERS = 5
// 又发过几次（v0.9.146）：链接一次都没被打开过时，把这条地址重新发出去的那几次。
// 与「催过」分开记：一个问「验没验」，一个问「收没收到」，混在一个数里两边都说不清。
const MAX_RESENDS = 5
// 换过几次新链接（v0.9.147）：同一条地址发到两次还没被打开之后，发件人换了一枚新 token。
// 换过之后打开次数从头算，所以「又发过几次」也跟着清零——剩下的只有「这条地址换过几次、
// 上一条在换掉之前发过几次」，两条加起来才说得清「这一条到底试过几条地址」。
const MAX_RELINKS = 5

/**
 * 催过 / 又发过的记录：只有时间，不存发出去的那段话。
 * 原因：那段话是照着档案里的事实现拼的（哪一版、哪个包、多少字节、链接），
 * 存下来只会变成第二份可能过期的话；要给人看的是「催过没有、哪天催的」。
 */
function normalizeStamps(raw, max) {
  return (Array.isArray(raw) ? raw : [])
    .map((entry) => (typeof entry === 'string' ? { at: entry } : entry))
    .map((entry) => ({ at: typeof entry?.at === 'string' ? entry.at : '' }))
    .filter((entry) => entry.at)
    .slice(-max)
}

function normalizeReminders(raw) {
  return normalizeStamps(raw, MAX_REMINDERS)
}

function normalizeResends(raw) {
  return normalizeStamps(raw, MAX_RESENDS)
}

/**
 * 换链接的记录（v0.9.147）：每次只存时间与「换掉之前那条发过几次」。
 * 旧地址本身不存——它已经打不开了，留着只是多一份能当凭证猜的字符串。
 */
function normalizeRelinks(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => entry && typeof entry.at === 'string' && entry.at)
    .map((entry) => ({
      at: entry.at,
      resends: Math.min(MAX_RESENDS, Math.max(0, Math.round(Number(entry.resends) || 0))),
    }))
    .slice(-MAX_RELINKS)
}

// 换掉的那条旧地址留一个记号（v0.9.148）：收包人还会从聊天记录点回旧的，
// 那时候不能只说「链接不在了」——他会以为整条链接坏了，或者以为发件人收回了一份已经交出去的包。
// 记号用的是打开记录同一套键（token 的 SHA-256 前 16 位），不是 token 本身：
// 记录文件被看到也拿不回一条能打开的地址，只够让旧地址说一句「这一条已经换成新的了」。
const MAX_RETIRED_LINKS = 5

/**
 * 一条交付最多换几次地址（v0.9.150）：换地址换的是 token，不是渠道。
 * 第三条地址还是从微信 / 邮件里那条消息点开，前两条没送到，第三条也多半一样；
 * r157–r159 一路在文案里劝「别再换地址了」，可按钮一直还在给换——到这一版把话变成行为。
 * 换到两次还是一次都没被打开，就只剩两个动作：问他一句，或者换个人。
 */
export const RELINK_LIMIT = 2

// 换掉的那条旧地址还被点过几次（v0.9.149）：换地址只解决「地址不对」，解决不了「新的那条没送到他手上」。
// 有人点回旧地址，恰恰说明他手上留着的还是旧的那条——这正是发件人最需要知道的事，
// 不然他只看见「新地址 0 次打开」，很可能再换一条，把三条地址都发进同一个黑洞。
// 只记次数与最近一次，不记是谁、不记从哪来：这是「这条地址被点过」，不是「他点过」。
const RETIRED_HIT_DEDUPE_MS = 5000
const MAX_RETIRED_HITS = 999

function normalizeRetiredLinks(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => entry && /^[0-9a-f]{16}$/.test(String(entry.key || '')))
    .map((entry) => {
      const base = {
        key: String(entry.key),
        at: Number.isFinite(Date.parse(String(entry.at || ''))) ? String(entry.at) : '',
      }
      const hits = Math.min(MAX_RETIRED_HITS, Math.max(0, Math.round(Number(entry.hits) || 0)))
      if (!hits) return base
      const lastAt = Number.isFinite(Date.parse(String(entry.lastAt || ''))) ? String(entry.lastAt) : ''
      return { ...base, hits, lastAt }
    })
    .slice(-MAX_RETIRED_LINKS)
}

/** 换掉一条地址：旧 token 的记录键留下，旧地址从此说得出「被换成了新的」，不再一律「不在了」。 */
function withRetiredLink(record, token, at) {
  const key = visitKey(token)
  if (!key) return record
  const retired = [...normalizeRetiredLinks(record.retired), { key, at }].slice(-MAX_RETIRED_LINKS)
  return { ...record, retired }
}

function normalizeDeliveryReceipt(raw) {
  if (!raw || typeof raw !== 'object') return null
  const state = RECEIPT_STATES.includes(raw.state) ? raw.state : ''
  const at = typeof raw.at === 'string' ? raw.at : ''
  if (!state || !at) return null
  const base = { at, state }
  // 这张收据是谁贴的：'link' = 收包人自己从回执链接贴回来的，'you' = 发件人替他贴的。
  // 老记录没有这一项，读出来也没有——界面按「你贴的」讲，不编一个「对方自己贴的」。
  const via = raw.via === 'link' ? 'link' : raw.via === 'you' ? 'you' : ''
  if (via) base.via = via
  const summary = clip(raw.summary, 300)
  if (summary) base.summary = summary
  const problems = (Array.isArray(raw.problems) ? raw.problems : [])
    .map((line) => clip(line, 180))
    .filter(Boolean)
    .slice(0, 4)
  if (problems.length) base.problems = problems
  const checks = (Array.isArray(raw.checks) ? raw.checks : [])
    .map((check) => ({
      k: RECEIPT_CHECK_KEYS.includes(check?.k) ? check.k : '',
      want: clip(check?.want, 200),
      got: clip(check?.got, 200),
      ok: check?.ok === true,
    }))
    .filter((check) => check.k && (check.want || check.got))
    .slice(0, RECEIPT_CHECK_KEYS.length)
  if (checks.length) base.checks = checks
  const source = raw.claimed && typeof raw.claimed === 'object' ? raw.claimed : {}
  const claimed = {
    at: clip(source.at, 40),
    kind: clip(source.kind, 20),
    title: clip(source.title, 120),
    version: Math.max(0, Math.round(Number(source.version) || 0)),
    bytes: Math.max(0, Math.round(Number(source.bytes) || 0)),
    sha256: /^[0-9a-f]{64}$/.test(String(source.sha256 || '').toLowerCase()) ? String(source.sha256).toLowerCase() : '',
    packageName: clip(source.packageName, 180),
    chip: clip(source.chip, 20),
    summary: clip(source.summary, 300),
  }
  if (Object.values(claimed).some(Boolean)) base.claimed = claimed
  return base
}

/**
 * 一条交付记录上贴过的每一次（v0.9.138）：最新的一次永远同时写在 receipt 上，
 * 流水只是把更早的那几次留着，好让「先贴了一张对不上的、后来又贴对了」这件事看得见。
 * 老记录（只有 receipt、没有 receipts）读出来补成一条，界面不会把一次说成零次。
 */
function normalizeDeliveryReceipts(raw, latest) {
  const list = (Array.isArray(raw) ? raw : []).map((entry) => normalizeDeliveryReceipt(entry)).filter(Boolean)
  const last = list[list.length - 1]
  if (latest && (!last || last.at !== latest.at || last.state !== latest.state)) list.push(latest)
  return list.slice(-MAX_RECEIPTS)
}

/** 把新的一次对账接到流水后面，并把 receipt 指向它。只动这一条交付记录的两个字段。 */
function withReceipt(record, receipt) {
  const history = normalizeDeliveryReceipts(record.receipts, record.receipt)
  return { ...record, receipt, receipts: [...history, receipt].slice(-MAX_RECEIPTS) }
}

/**
 * 收件人称呼（v0.9.152）：这一条交付是发给谁的。
 * 只做三件事：去掉控制字符、把空白压成一个、按字截到上限（按码点算，emoji 与生僻字不会被劈成半个）。
 * 空串 = 没写，不存一个空字段——老记录与没写过的都读成「不知道发给谁」，界面就不说这一段。
 */
export function normalizeDeliveryRecipient(raw) {
  const flat = Array.from(String(raw ?? ''))
    .map((ch) => {
      const code = ch.codePointAt(0) || 0
      return code < 0x20 || code === 0x7f ? ' ' : ch
    })
    .join('')
  const text = flat.replace(/\s+/g, ' ').trim()
  return Array.from(text).slice(0, MAX_RECIPIENT).join('')
}

/**
 * 他回了什么（v0.9.153）：把收包人回的那段话原样留在这一条交付上。
 *
 * 分成两步：flattenDeliveryReply 只整理形状（去控制字符、每行空白压成一个、空行扔掉、最多 6 行），
 * normalizeDeliveryReply 再按字截到 200。分开是为了让接口能照实说「太长了」——
 * 先截断再比长度，永远比不出「他写多了」。
 */
function flattenDeliveryReply(raw) {
  const flat = Array.from(String(raw ?? ''))
    .map((ch) => {
      const code = ch.codePointAt(0) || 0
      if (code === 0x0a) return '\n'
      return code < 0x20 || code === 0x7f ? ' ' : ch
    })
    .join('')
  return flat
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, REPLY_LINES)
    .join('\n')
}

/** 整理之后有多少个字（按码点算）：接口据此判断「写不下」，不是按 UTF-16 长度。 */
export function deliveryReplyLength(raw) {
  return Array.from(flattenDeliveryReply(raw)).length
}

/** 写进来、读回来都过这一遍：整理形状 + 按字截到 200（按码点，emoji 不被劈成半个）。 */
export function normalizeDeliveryReply(raw) {
  return Array.from(flattenDeliveryReply(raw)).slice(0, MAX_REPLY).join('')
}

// 交付记录：{ id, version, at, review, package, receipt }。老记录没有时间就写空串——照样是「这一版交过」，只是不知道什么时候。
// review 同理：没有这个字段就是「当时没记评审」，不能拿这一版后来的评审冒充（v0.9.85）。
// id/package 同理：升级前的老交付记录没有封存包，界面不能给出一个点开 404 的按钮。
function normalizeDeliveries(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const base = { version: Math.max(0, Math.round(Number(entry.version) || 0)), at: String(entry.at || '') }
      const id = /^[0-9a-f]{16}$/.test(String(entry.id || '')) ? String(entry.id) : ''
      if (id) base.id = id
      if (entry.review !== undefined) base.review = normalizeDeliveryReview(entry.review)
      // 没有 id 就没有可下载的包：包按 id 寻址，缺 id 时即使盘上有文件也打不开
      const pkg = id ? normalizeDeliveryPackage(entry.package) : null
      if (pkg) base.package = pkg
      // 收据对账只挂在有封存包的记录上：没有包就没有可比的哈希
      const receipts = pkg ? normalizeDeliveryReceipts(entry.receipts, normalizeDeliveryReceipt(entry.receipt)) : []
      if (receipts.length) {
        base.receipt = receipts[receipts.length - 1]
        base.receipts = receipts
      }
      // 回执链接（v0.9.137）：给收包人一条不用登录的入口，把收据自己贴回来。
      // 只挂在有封存包的记录上——没有包就没有可比的东西；坏了就当没有这条链接。
      const token = /^[0-9a-f]{16}$/.test(String(entry.receiptToken || '')) ? String(entry.receiptToken) : ''
      if (pkg && token) base.receiptToken = token
      // 链接发出去的时间（v0.9.145）：从这里开始记「这条地址被打开过几次」。
      // 升级前发的链接没有这一项——那时候还没开始记，界面只能什么都不说，不能写「还没被打开」。
      const linkAt = pkg && token && Number.isFinite(Date.parse(String(entry.receiptLinkAt || ''))) ? String(entry.receiptLinkAt) : ''
      if (linkAt) base.receiptLinkAt = linkAt
      // 催过几次（v0.9.144）：和回执一样只挂在有封存包的记录上——没有包就没有「验没验」这回事
      const reminders = pkg ? normalizeReminders(entry.reminders) : []
      if (reminders.length) base.reminders = reminders
      // 又发过几次（v0.9.146）：链接没被打开过时重新发出去的那几次，与催过分开存
      const resends = pkg ? normalizeResends(entry.resends) : []
      if (resends.length) base.resends = resends
      // 换过几条地址（v0.9.147）：每换一条都会清掉 resends（那几次指的是旧地址），
      // 旧地址试过几次折在 relinks 的这一项里，不丢。
      const relinks = pkg ? normalizeRelinks(entry.relinks) : []
      if (relinks.length) base.relinks = relinks
      // 换掉的旧地址（v0.9.148）：只留记录键与换掉的时间。旧 token 本身不存，
      // 它已经打不开了，留着只是多一份能当凭证猜的字符串。
      const retired = pkg ? normalizeRetiredLinks(entry.retired) : []
      if (retired.length) base.retired = retired
      // 收包人自己点过「收到了」（v0.9.151）：收据要等验完才贴得上来，中间这一段
      // 发件人一直只能靠「打开过几次」猜。这是对方亲口说的那一刻，记时间、记这一件事，
      // 不记是谁点的（那一侧没有账号），也不当收据用——验没验仍以收据为准。
      const ackAt = pkg && Number.isFinite(Date.parse(String(entry.ack?.at || ''))) ? String(entry.ack.at) : ''
      if (ackAt) base.ack = { at: ackAt }
      // 这一条是给谁的（v0.9.152）：发件人自己写的称呼。只留在自己这一侧——
      // 不进包、不进回执页（拿着链接的人不需要知道发件人怎么称呼别人）。
      const recipient = pkg ? normalizeDeliveryRecipient(entry.recipient) : ''
      if (recipient) base.recipient = recipient
      // 他回了什么（v0.9.153）：收包人说的原话，发件人自己记在这一条上。
      // 同样只在发件人这一侧：不进包、不进回执页。时间读不出来就只留话，不硬编一个时间出来。
      const replyText = pkg ? normalizeDeliveryReply(entry.reply?.text) : ''
      if (replyText) {
        const replyAt = Number.isFinite(Date.parse(String(entry.reply?.at || '')))
          ? new Date(String(entry.reply.at)).toISOString()
          : ''
        base.reply = { text: replyText, at: replyAt }
      }
      return base
    })
    .filter((entry) => entry.version > 0)
    .slice(-MAX_DELIVERIES)
}

/**
 * 交付那一刻的评审结论（v0.9.85）：交付记录写的是「交的时候评审怎么说」。
 * 口径与作品页的版本对照同源——同一版取最近一次、版本划分前的老评审折进 v1；
 * 这一版一次都没评过就是 null（「当时还没评过」），不是 0 个阻塞。
 *
 * 为什么不在读的时候现算：交付之后再评一次，这一版的结论就变了；
 * 拿「这一版最新的评审」当「交出去的结论」，等于每重评一次就改写一次历史。
 */
async function deliveryReviewSnapshot(project, user) {
  if (!project?.id) return null
  const counts = await reviewSummaryByVersion(project.id, user)
  const summary = reviewsForVersion(counts, Math.max(1, Number(project.version) || 0))
  if (!summary.count) return null
  return { verdict: summary.lastVerdict || '', at: summary.lastAt || '', issues: summary.issues || null }
}

/** 把当前这一轮分享归档进历史（停用、或换新 token 时调用），返回是否真的归档了。 */
function archiveShare(found, closedAt) {
  const key = visitKey(found.shareToken)
  if (!key) return false
  const history = normalizeShareHistory(found.shareHistory).filter((entry) => entry.key !== key)
  found.shareHistory = [{ key, createdAt: String(found.shareCreatedAt || ''), closedAt }, ...history].slice(0, MAX_SHARE_HISTORY)
  return true
}

function normalize(item) {
  const versions = (Array.isArray(item.versions) ? item.versions : [])
    .filter((entry) => entry && entry.flowId)
    .map((entry, index) => normalizeVersion(entry, index + 1))
    .slice(-MAX_VERSIONS)
  // 版本号是作品自己的计数：没存过就按「归档几版 + 当前一版」推出来，老数据不会显示成 v0
  const derived = versions.length + (String(item.flowId || '') ? 1 : 0)
  const stored = Math.round(Number(item.version))
  const version = Number.isFinite(stored) ? Math.max(derived, Math.max(0, stored)) : derived
  return {
    id: String(item.id),
    ownerId: String(item.ownerId || ''),
    title: clip(item.title || '未命名作品', 80),
    templateId: String(item.templateId || ''),
    flowId: String(item.flowId || ''),
    // 第几版：0 表示还没开过画布，开出来就是 v1
    version,
    // 这一版是从哪一版复制来的（v0.9.116）：0 表示接着上一版改，不是回退来的
    basedOn: normalizeBasedOn(item.basedOn, version),
    // 归档的旧版本只存指针：画布还在流程服务里，这里不复制节点
    versions,
    // 作品自己的脚本：只有用户动过才存在；没有就跟随模板（项目页读 scriptView）
    script: normalizeStoredScript(item.script),
    // 只读分享：token 本身就是凭证；没开就是 null。列表接口不返回它（projectBrief 会剥掉）。
    // compare 是分享者自己的选择：默认关，打开后拿到链接的人才能打印「当前版 vs 上一版」。
    share: item.shareToken
      ? {
          token: String(item.shareToken),
          createdAt: String(item.shareCreatedAt || ''),
          compare: item.shareCompare === true,
        }
      : null,
    // 以前开过的链接：token 已清、地址打不开，只留哈希键与起止时间（打开记录按哈希键还对得上）
    shareHistory: normalizeShareHistory(item.shareHistory),
    status: STATUSES.includes(item.status) ? item.status : 'active',
    // 交付记录：标记交付时落一条；开新版不会把它清掉，旧版交过这件事仍然查得到
    deliveries: normalizeDeliveries(item.deliveries),
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
  }
}

/** 列表：按最近改动排序。归属规则与模板/评审一致（管理员可见全部，未登录不过滤）。 */
export async function listProjects(user = null) {
  const list = await loadAll()
  return list
    .filter((item) => canAccess(item, user))
    .map(normalize)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export async function getProject(id, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  return found ? normalize(found) : null
}

/**
 * 全量交付封存包（v0.9.128）：健康检查要按整库看「档案里记的包，盘上还在不在」，
 * 不受登录态过滤——这里只回编号与包元数据，不给作品标题、脚本或任何内容。
 * 上限 200 条：健康检查每 10 秒跑一次，不能跟着作品数量无限长。
 */
export async function allDeliveryPackages() {
  const list = await loadAll()
  const rows = []
  for (const item of list) {
    for (const entry of normalizeDeliveries(item.deliveries)) {
      if (!entry?.id || !entry.package) continue
      rows.push({ projectId: item.id, deliveryId: entry.id, package: entry.package })
      if (rows.length >= 200) return rows
    }
  }
  return rows
}

export async function createProject({ title = '', templateId = '', flowId = '' } = {}, user = null) {
  const list = await loadAll()
  const now = new Date().toISOString()
  const project = {
    id: 'prj_' + randomUUID().slice(0, 8),
    // 作品必须归人：没有登录态就不建（不像模板那样允许公共条目，公共作品没有意义）
    ownerId: String(user?.id || ''),
    title: clip(title || '未命名作品', 80),
    templateId: String(templateId || ''),
    flowId: String(flowId || ''),
    // 从模板建的作品还没有画布，等「开画布」才变成 v1；
    // 从画布建的（v0.9.29）画布已经在了，一出生就是 v1——否则版本对照里会显示成 v0。
    version: flowId ? 1 : 0,
    // 出生就是 v1，没有「以哪一版为底」；之后回退开版才写这个数
    basedOn: 0,
    versions: [],
    // 先不复制模板脚本：复制发生在第一次保存脚本时（copy-on-write）
    script: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  await persist([project, ...list].slice(0, MAX_PROJECTS))
  return normalize(project)
}

const PATCHABLE = ['title', 'flowId', 'status']

/**
 * 只允许改标题、绑定的画布、状态；模板绑定建好就不改（换模板等于换一条内容）。
 * deliveryPackage 是路由封存好的包元数据（v0.9.125）：只有「标记交付」这一条路会带，
 * 存储层不负责打包，只负责把「这一版交出去时是什么样」与包编号一起落盘。
 */
export async function updateProject(
  id,
  patch = {},
  user = null,
  { deliveryId = '', deliveryPackage = null, receiptToken = '' } = {},
) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const beforeStatus = found.status
  let changed = false
  for (const key of PATCHABLE) {
    if (!(key in patch)) continue
    const value = key === 'status'
      ? (STATUSES.includes(patch.status) ? patch.status : found.status)
      : key === 'title'
        ? clip(patch.title, 80)
        : String(patch[key] || '')
    if (value === found[key]) continue
    found[key] = value
    changed = true
  }
  // 标记交付 = 记下「这一版交出去了」：版次与时间都落一条，之后开新版也不会覆盖；
  // 同一版重复标记只更新时间，不堆重复记录。
  if (patch.status === 'done') {
    const at = new Date().toISOString()
    const version = Math.max(1, Number(found.version) || 1)
    const deliveries = normalizeDeliveries(found.deliveries)
    const previous = deliveries.find((entry) => entry.version === version) || null
    const rest = deliveries.filter((entry) => entry.version !== version)
    // 交的时候评审怎么说，跟着这一版一起记下来：事后重评不改这条记录
    const review = await deliveryReviewSnapshot({ id: found.id, version }, user)
    const record = { version, at, review }
    // 新封存的包优先；打包失败时保留同一版上一次封存的那份，不把它降级成「没有包」
    if (deliveryPackage && deliveryId) {
      record.id = deliveryId
      record.package = deliveryPackage
      // 换了一份新包，回执链接也跟着换：旧链接指的是上一份，不能继续往新记录里写
      if (/^[0-9a-f]{16}$/.test(String(receiptToken || ''))) {
        record.receiptToken = receiptToken
        // 新链接就是这一刻发出去的：从这儿开始记「被打开过几次」（v0.9.145）
        record.receiptLinkAt = at
      }
    } else if (previous?.id && previous.package) {
      record.id = previous.id
      record.package = previous.package
      // 打包失败、沿用上一份包时，链接也沿用：它指的还是同一份盘上的文件
      if (previous.receiptToken) record.receiptToken = previous.receiptToken
      if (previous.receiptLinkAt) record.receiptLinkAt = previous.receiptLinkAt
    }
    found.deliveries = [...rest, record].slice(-MAX_DELIVERIES)
    changed = true
    // 同一版重新交付会换一个包编号；被挤掉的旧记录也可能留下文件。只保留还挂着的那些。
    await pruneDeliveryPackages(found.id, found.deliveries.map((entry) => entry.id).filter(Boolean))
  }
  // 重新打开 = 收回「这一版已交付」：撤掉当前这一版的交付记录，别的版本留着。
  // 交付是对某一版的宣布，撤销之后稿子与胶囊都回到「这一版还没交」，不留一条假记录。
  if (patch.status === 'active' && beforeStatus === 'done') {
    const version = Math.max(1, Number(found.version) || 1)
    const before = normalizeDeliveries(found.deliveries)
    const rest = before.filter((entry) => entry.version !== version)
    if (rest.length !== before.length) {
      found.deliveries = rest
      changed = true
      // 记录收回了，那一次封存的包也一起收回：不能留一个点开还能下载的地址
      for (const entry of before) {
        if (entry.version === version && entry.id) await dropDeliveryPackage(found.id, entry.id)
      }
    }
  }
  // 第一次绑上画布就是 v1：版本计数从这里开始，之后只有「开一版新的」才会加
  if (found.flowId && !Number(found.version)) {
    found.version = 1
    changed = true
  }
  if (changed) {
    found.updatedAt = new Date().toISOString()
    await persist(list)
  }
  return normalize(found)
}

/**
 * 记下收包人贴回来的收据对账结果（v0.9.136）。
 * 只改这一条交付记录的 receipt：包的字节与哈希、交付时间、那一版的评审快照都不动——
 * 核对是「事后发生的一件事」，不能反过来改写当初封存时记下的事实。
 * 返回 null = 作品/交付记录不存在，或者这一条没有封存包（没有可比的哈希）。
 */
export async function saveDeliveryReceipt(id, deliveryId, receipt, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const normalized = normalizeDeliveryReceipt(receipt)
  if (!normalized) return null
  const deliveries = normalizeDeliveries(found.deliveries)
  const index = deliveries.findIndex((entry) => entry.id === deliveryId && entry.package)
  if (index < 0) return null
  deliveries[index] = withReceipt(deliveries[index], normalized)
  found.deliveries = deliveries
  found.updatedAt = new Date().toISOString()
  await persist(list)
  return { project: normalize(found), delivery: deliveries[index] }
}

/**
 * 催一句（v0.9.144）：收包人一直没贴收据时，记下「今天催过一次」，并把回执链接的 token 还回去。
 *
 * 为什么这一步要写盘：光把话复制走，过两天就没人记得催过没有，容易一天催三遍或者干脆忘了。
 * 只记这件事发生过的次数与最近一次时间，不存那段话，也不改包、不改交付时间、不碰回执。
 *
 * 三种情况如实退回，不硬造一条记录：
 *  - 作品 / 交付记录不存在，或者这一条没有封存包 → null；
 *  - 已经贴过回执（已回执 = 该问的都问到了）→ { already: true }，让人别去催一个已经验完的人；
 *  - 档案里没有回执链接（v0.9.137 之前封的包）→ { missingLink: true }，先去作品页生成一条。
 */
export async function saveDeliveryReminder(id, deliveryId, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const deliveries = normalizeDeliveries(found.deliveries)
  const index = deliveries.findIndex((entry) => entry.id === deliveryId && entry.package)
  if (index < 0) return null
  const entry = deliveries[index]
  if (entry.receipt) return { already: true, delivery: entry }
  const token = /^[0-9a-f]{16}$/.test(String(entry.receiptToken || '')) ? String(entry.receiptToken) : ''
  if (!token) return { missingLink: true, delivery: entry }
  const at = new Date().toISOString()
  const reminders = [...normalizeReminders(entry.reminders), { at }].slice(-MAX_REMINDERS)
  deliveries[index] = { ...entry, reminders }
  found.deliveries = deliveries
  found.updatedAt = at
  await persist(list)
  return { already: false, token, at, count: reminders.length, delivery: deliveries[index] }
}

/**
 * 再发一次链接（v0.9.146）：这条回执链接一次都没被打开过时，发件人把它重新发出去的那一次。
 *
 * 为什么要与「催一句」分开记：催是「我猜你收到了，只是还没验」；重发是「我担心你根本没收到」。
 * 两件事的下一步也不同——催完还是没动静该换人盯，重发两次还是没打开就该换渠道（邮件 / 换个人 / 换一条链接）。
 * 混成一个「联系过 3 次」的数字，两个判断都会说不清。
 *
 * 与催一样只记时间，不存那段话；也照实退回三种「记不了」：没这条记录 / 已经贴过回执 / 还没有链接。
 */
export async function saveDeliveryResend(id, deliveryId, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const deliveries = normalizeDeliveries(found.deliveries)
  const index = deliveries.findIndex((entry) => entry.id === deliveryId && entry.package)
  if (index < 0) return null
  const entry = deliveries[index]
  if (entry.receipt) return { already: true, delivery: entry }
  const token = /^[0-9a-f]{16}$/.test(String(entry.receiptToken || '')) ? String(entry.receiptToken) : ''
  if (!token) return { missingLink: true, delivery: entry }
  const at = new Date().toISOString()
  const resends = [...normalizeResends(entry.resends), { at }].slice(-MAX_RESENDS)
  deliveries[index] = { ...entry, resends }
  found.deliveries = deliveries
  found.updatedAt = at
  await persist(list)
  return { already: false, token, at, count: resends.length, delivery: deliveries[index] }
}

/**
 * 这一条交付现在的回执链接是哪一枚（v0.9.147）：换地址之前先看一眼——
 * 已经贴过回执的不该再换，被打开过的也不该换（对方可能正看着那条），这些判断都在路由那一层做。
 * 返回 null = 作品 / 交付记录不存在，或者这一条没有封存包。
 */
export async function deliveryReceiptLink(id, deliveryId, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const deliveries = normalizeDeliveries(found.deliveries)
  const entry = deliveries.find((item) => item.id === deliveryId && item.package)
  if (!entry) return null
  return { token: /^[0-9a-f]{16}$/.test(String(entry.receiptToken || '')) ? String(entry.receiptToken) : '', receipt: Boolean(entry.receipt) }
}

/**
 * 换一条新链接（v0.9.147）：同一条地址发到两次还没被打开之后，把这一条交付的 token 换成新的一枚，
 * 旧地址立刻打不开；打开次数从头算（新地址的键不一样），「又发过几次」清零，
 * 换这件事本身折进 relinks，里面记着「换掉之前那条发过几次」。
 *
 * 为什么清零重发次数：那两个数回答的是「这一条地址发了几次没人打开」。换了地址还是那两个数，
 * 下一次该不该再发就永远判断不了——所以新地址从零开始，旧地址的账留在 relinks 里。
 *
 * 三种退回与催 / 重发一致：没这条记录（或没有封存包）→ null；已经贴过回执 → { already: true }；
 * 根本没有链接（v0.9.137 之前封的包）→ { missingLink: true }，先去作品页生成一条。
 */
export async function saveDeliveryRelink(id, deliveryId, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const deliveries = normalizeDeliveries(found.deliveries)
  const index = deliveries.findIndex((entry) => entry.id === deliveryId && entry.package)
  if (index < 0) return null
  const entry = deliveries[index]
  if (entry.receipt) return { already: true, delivery: entry }
  const token = /^[0-9a-f]{16}$/.test(String(entry.receiptToken || '')) ? String(entry.receiptToken) : ''
  if (!token) return { missingLink: true, delivery: entry }
  // 换到头了（v0.9.150）：换地址换的是地址，不是渠道。第三条还是从同一条消息里点开，
  // 前两条没送到，第三条也一样——到这一步该问人，不该再换。什么都不改，原样退回。
  const relinksBefore = normalizeRelinks(entry.relinks)
  if (relinksBefore.length >= RELINK_LIMIT) return { capped: true, count: relinksBefore.length, delivery: entry }
  const at = new Date().toISOString()
  const nextToken = newReceiptToken()
  const resendsBefore = normalizeResends(entry.resends).length
  const relinks = [...relinksBefore, { at, resends: resendsBefore }].slice(-MAX_RELINKS)
  // resends 是「这一条地址又发过几次」：换了地址就清零，账折进 relinks 里。
  // 旧 token 只留记录键（v0.9.148）：他还会点回聊天记录里那条，那时页面要说「换成了新的」。
  const next = withRetiredLink({ ...entry, receiptToken: nextToken, receiptLinkAt: at, relinks }, token, at)
  delete next.resends
  deliveries[index] = next
  found.deliveries = deliveries
  found.updatedAt = at
  await persist(list)
  return { token: nextToken, at, count: relinks.length, resendsBefore, delivery: deliveries[index] }
}

/**
 * 回执链接（v0.9.137）：把这一条交付记录的 token 换成新的一枚，旧链接立刻不认。
 * rotate=false 时只补一枚缺的，不换掉已经在用的那一条——发给对方的链接不能凭空失效。
 * 返回 null = 作品/交付记录不存在，或者这一条没有封存包。
 */
export async function issueDeliveryReceiptToken(id, deliveryId, user = null, { rotate = false } = {}) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const deliveries = normalizeDeliveries(found.deliveries)
  const index = deliveries.findIndex((entry) => entry.id === deliveryId && entry.package)
  if (index < 0) return null
  const current = deliveries[index].receiptToken || ''
  const at = new Date().toISOString()
  if (current && !rotate) {
    // 已经在用的那一枚还回去。升级前发的链接没有发出时间：现在补上，
    // 从此开始记打开次数——不补的话，界面永远不知道能不能说「还没被打开」（v0.9.145）
    if (!deliveries[index].receiptLinkAt) {
      deliveries[index] = { ...deliveries[index], receiptLinkAt: at }
      found.deliveries = deliveries
      found.updatedAt = at
      await persist(list)
    }
    return { token: current, rotated: false, delivery: deliveries[index] }
  }
  // 作品页这个「换一条」也守同一个上限（v0.9.150）：两条路换的是同一条地址，
  // 一条路拦住另一条还能换，等于没拦住。
  const relinksBefore = normalizeRelinks(deliveries[index].relinks)
  if (rotate && relinksBefore.length >= RELINK_LIMIT) {
    return { capped: true, count: relinksBefore.length, token: current, delivery: deliveries[index] }
  }
  const token = newReceiptToken()
  // 换一条等于从头开始记：新 token 的记录键不一样，打开次数自然从零算起。
  // 作品页这个「换一条」与工作台那个换链接是同一件事，所以旧地址同样要留记号（v0.9.148）：
  // 否则从这里换掉的地址会得到一句「这条链接不在了」，和「根本没发过」分不开。
  deliveries[index] = withRetiredLink({ ...deliveries[index], receiptToken: token, receiptLinkAt: at }, current, at)
  found.deliveries = deliveries
  found.updatedAt = at
  await persist(list)
  return { token, rotated: Boolean(current), delivery: deliveries[index] }
}

/**
 * 按回执链接的 token 找那一条交付（v0.9.137）：收包人打开的页面只认这一枚 token，
 * 不认人也不认作品——所以只回这一条交付和它所属作品的标题，别的一概不给。
 */
export async function findReceiptLink(token) {
  const value = String(token || '')
  if (!/^[0-9a-f]{16}$/.test(value)) return null
  const list = await loadAll()
  for (const project of list) {
    const deliveries = normalizeDeliveries(project.deliveries)
    const delivery = deliveries.find((entry) => entry.receiptToken === value && entry.package)
    if (delivery) return { project: normalize(project), delivery }
  }
  return null
}

/**
 * 按一条旧地址找它被换掉的那一次（v0.9.148）。
 * 收包人从聊天记录点回旧的，得到的不能是「链接不在了」：那是「发件人收回了一交出去的包」的意思。
 * 只认换掉的记号，不认 token、也不给作品与包——旧地址能知道的只有「它被换成了新的」和换的时间。
 */
export async function findRetiredReceiptLink(token) {
  const key = visitKey(String(token || ''))
  if (!key) return null
  const list = await loadAll()
  for (const project of list) {
    for (const delivery of normalizeDeliveries(project.deliveries)) {
      const hit = (delivery.retired || []).find((entry) => entry.key === key)
      if (hit) return { at: hit.at, hits: Math.max(0, Math.round(Number(hit.hits) || 0)), lastAt: String(hit.lastAt || '') }
    }
  }
  return null
}

/**
 * 有人点回一条换掉的旧地址（v0.9.149）：记一次，给发件人一个「他手上还是旧的那条」的信号。
 *
 * 只加次数与最近一次，不加人、不加 IP、不加从哪来——这一侧没有账号，能知道的只有这条地址被点过。
 * 五秒内连着来的算一次：页面刷新、浏览器预取都会让同一次点击变成两三个请求，
 * 记成三次会让发件人以为对方在反复试；顺带也让一个旧地址没法把整份记录写成千百遍。
 *
 * 不改作品的 updatedAt：点一下旧地址不是你改了作品，不该把它顶到列表最前面。
 * 返回 null = 这不是一条记过的旧地址（照旧 404，不凭空造一条）。
 */
export async function noteRetiredReceiptLinkHit(token, nowMs = Date.now()) {
  const key = visitKey(String(token || ''))
  if (!key) return null
  const list = await loadAll()
  for (const project of list) {
    const deliveries = normalizeDeliveries(project.deliveries)
    const index = deliveries.findIndex((entry) => (entry.retired || []).some((item) => item.key === key))
    if (index < 0) continue
    const entry = deliveries[index]
    const current = entry.retired.find((item) => item.key === key)
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
    const seenMs = Date.parse(String(current.lastAt || ''))
    if (Number.isFinite(seenMs) && now - seenMs < RETIRED_HIT_DEDUPE_MS) {
      return { at: current.at, hits: Math.max(0, Math.round(Number(current.hits) || 0)), lastAt: String(current.lastAt || ''), recorded: false }
    }
    const at = new Date(now).toISOString()
    const hits = Math.min(MAX_RETIRED_HITS, Math.max(0, Math.round(Number(current.hits) || 0)) + 1)
    deliveries[index] = {
      ...entry,
      retired: entry.retired.map((item) => (item.key === key ? { ...item, hits, lastAt: at } : item)),
    }
    project.deliveries = deliveries
    await persist(list)
    return { at: current.at, hits, lastAt: at, recorded: true }
  }
  return null
}

/**
 * 收包人自己在回执链接上贴回来的收据（v0.9.137）。
 * 与 saveDeliveryReceipt 同一件事，只是「哪一条」由 token 决定，不由登录态决定；
 * 同样只改这一条交付记录的 receipt，包的字节与哈希、交付时间、评审快照都不动。
 */
export async function saveReceiptByToken(token, receipt) {
  const value = String(token || '')
  if (!/^[0-9a-f]{16}$/.test(value)) return null
  const normalized = normalizeDeliveryReceipt(receipt)
  if (!normalized) return null
  const list = await loadAll()
  for (const project of list) {
    const deliveries = normalizeDeliveries(project.deliveries)
    const index = deliveries.findIndex((entry) => entry.receiptToken === value && entry.package)
    if (index < 0) continue
    deliveries[index] = withReceipt(deliveries[index], normalized)
    project.deliveries = deliveries
    project.updatedAt = new Date().toISOString()
    await persist(list)
    return { project: normalize(project), delivery: deliveries[index] }
  }
  return null
}

/**
 * 收包人在回执链接上点了「收到了」（v0.9.151）。
 *
 * 为什么这一步值得写盘：从发出链接到收回据之间，发件人手里只有「打开过几次」这一个数，
 * 分不出「他根本没看到」和「他看到了、包也拿到了，只是还没验」。r146–r160 一路在这两件事之间猜，
 * 最后只能让发件人去问。可答案在收包人手上——他在那一页点一下就够了。
 *
 * 只记这一件事发生的时间：不记是谁点的（那一侧没有账号，转发给别人也算一次点击），
 * 不碰包、不碰收据、不碰打开次数；也不改作品的 updatedAt——点一下的不是发件人，不该把作品顶到列表最前。
 * 重复点不写第二遍（那一刻只有一次），已经贴过收据的不再收：验都验完了，「收到了」没有新信息。
 */
export async function saveDeliveryAck(token, at = new Date().toISOString()) {
  const value = String(token || '')
  if (!/^[0-9a-f]{16}$/.test(value)) return null
  const when = Number.isFinite(Date.parse(String(at || ''))) ? String(at) : new Date().toISOString()
  const list = await loadAll()
  for (const project of list) {
    const deliveries = normalizeDeliveries(project.deliveries)
    const index = deliveries.findIndex((entry) => entry.receiptToken === value && entry.package)
    if (index < 0) continue
    const entry = deliveries[index]
    if (entry.receipt) return { already: true, delivery: entry }
    if (entry.ack?.at) return { repeated: true, at: entry.ack.at, delivery: entry }
    deliveries[index] = { ...entry, ack: { at: when } }
    project.deliveries = deliveries
    await persist(list)
    return { repeated: false, at: when, delivery: deliveries[index] }
  }
  return null
}

/**
 * 记下「这一条是给谁的」（v0.9.152）。
 *
 * 为什么现在才记：r145–r151 一路在判断「他收到没有」——打开过几次、催过几次、换过几条地址，
 * 可这些判断都默认「我心里有数是发给谁的」。真的同时交出去两三份时，工作台那几行只剩版次与天数，
 * 分不出哪一条给王老师、哪一条给甲方；r150 让人「换个收件人」，也没有地方写换成谁。
 *
 * 只记这一条上的称呼：不碰包、不碰收据、不碰链接、不动作品的其他字段。
 * 写的人就是发件人自己，所以照常推进 updatedAt（与 ack 相反——点「收到了」的不是他）。
 * 同一个称呼再存一次不写盘（changed=false）：列表顺序不该因为点了一下「保存」而变。
 * 空串 = 清掉，这一条回到「没写收件人」。
 */
export async function saveDeliveryRecipient(id, deliveryId, recipient, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const deliveries = normalizeDeliveries(found.deliveries)
  const index = deliveries.findIndex((entry) => entry.id === deliveryId && entry.package)
  if (index < 0) return null
  const entry = deliveries[index]
  const next = normalizeDeliveryRecipient(recipient)
  if (String(entry.recipient || '') === next) return { changed: false, recipient: next, delivery: entry }
  if (next) {
    deliveries[index] = { ...entry, recipient: next }
  } else {
    const cleared = { ...entry }
    delete cleared.recipient
    deliveries[index] = cleared
  }
  found.deliveries = deliveries
  found.updatedAt = new Date().toISOString()
  await persist(list)
  return { changed: true, recipient: next, delivery: deliveries[index] }
}

/**
 * 他回了什么（v0.9.153）：把收包人回的那段话记在这一条交付上，或者传空串清掉。
 *
 * 只动这一项：包、收据、链接、催过几次那些数都不动；写的人还是发件人，所以照常推进 updatedAt。
 * 同一段话再存一次不写盘（changed=false），也不刷新时间——不然点一下保存就改写了「他哪天回的」。
 * 空串 = 清掉，这一条回到「没有回复」。
 */
export async function saveDeliveryReply(id, deliveryId, reply, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const deliveries = normalizeDeliveries(found.deliveries)
  const index = deliveries.findIndex((entry) => entry.id === deliveryId && entry.package)
  if (index < 0) return null
  const entry = deliveries[index]
  const next = normalizeDeliveryReply(reply)
  if (String(entry.reply?.text || '') === next) {
    return { changed: false, reply: entry.reply || null, delivery: entry }
  }
  if (next) {
    deliveries[index] = { ...entry, reply: { text: next, at: new Date().toISOString() } }
  } else {
    const cleared = { ...entry }
    delete cleared.reply
    deliveries[index] = cleared
  }
  found.deliveries = deliveries
  found.updatedAt = new Date().toISOString()
  await persist(list)
  return { changed: true, reply: deliveries[index].reply || null, delivery: deliveries[index] }
}

/**
 * 保存作品自己的脚本（第一次保存就是把模板脚本复制过来）。
 * 只收已经归一化过的脚本；形状不对返回 null，调用方当作「没保存成功」。
 */
export async function saveProjectScript(id, script, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  const normalized = normalizeStoredScript(script)
  if (!found || !normalized) return null
  found.script = normalized
  found.updatedAt = new Date().toISOString()
  await persist(list)
  return normalize(found)
}

/** 恢复成「跟随模板」：删掉作品自己的脚本副本，模板改回来作品就跟着变。 */
export async function clearProjectScript(id, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  if (!found.script) return normalize(found)
  found.script = null
  found.updatedAt = new Date().toISOString()
  await persist(list)
  return normalize(found)
}

/** 只给「绑定画布」用：绑定后刷新时间，但不改标题/状态。 */
export async function bindProjectFlow(id, flowId, user = null) {
  return updateProject(id, { flowId: String(flowId || '') }, user)
}

/**
 * 开新版本：当前画布存成归档（只存 flowId 与名字，不复制节点），作品改指向新画布。
 * 复制画布本身由路由做——存储层只认指针，不碰流程服务。
 */
export async function archiveProjectVersion(id, { flowId = '', prevName = '', script = null, nextScript = undefined, basedOn = 0 } = {}, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  const current = normalize(found)
  if (!current.flowId) return null
  const now = new Date().toISOString()
  found.versions = [
    ...current.versions,
    {
      n: current.version,
      flowId: current.flowId,
      name: clip(prevName || '上一版画布', 60),
      archivedAt: now,
      // 归档时把这一版的脚本一起存下来：之后改脚本也只影响新版本
      script: normalizeVersionScript(script) || undefined,
      // 来源跟着这一版一起归档：v4 是从 v1 回来的，归档之后仍然查得到
      basedOn: current.basedOn,
    },
  ].slice(-MAX_VERSIONS)
  // 开新版等于上一版收尾：标着交付的那一版先补一条交付记录（老记录没有时间就写空串），
  // 作品再放回「在做」——新版还没交，胶囊不能继续写着已交付。
  if (found.status === 'done') {
    const deliveries = normalizeDeliveries(found.deliveries)
    if (!deliveries.some((entry) => entry.version === current.version)) {
      // 开新版等于给上一版收尾：这一刻它评成什么样，也就是「交出去时」的样子
      const review = await deliveryReviewSnapshot({ id: found.id, version: current.version }, user)
      deliveries.push({ version: current.version, at: '', review })
    }
    found.deliveries = deliveries.slice(-MAX_DELIVERIES)
    found.status = 'active'
  }
  found.flowId = String(flowId || '')
  found.version = current.version + 1
  // 新一版的来源：不传 basedOn 就是接上一版改（0）；以旧版为底时写那一版的版次。
  // 只认更早且存在的版次——越界不写，避免页面显示一个查不到的底座。
  found.basedOn = normalizeBasedOn(basedOn, found.version)
  if (found.basedOn && !current.versions.some((entry) => entry.n === found.basedOn)) {
    found.basedOn = 0
  }
  // 以旧版为底（v0.9.115）：新一版的脚本不再是「现在的脚本」，而是旧版归档时存下的那一份。
  // 这里只认已经归一化过的快照；传 null 表示不换脚本，避免空值把作品自己的脚本清掉。
  if (nextScript !== undefined) {
    const restored = normalizeStoredScript(nextScript)
    if (restored) found.script = restored
  }
  found.updatedAt = now
  await persist(list)
  // 开新版只保留还挂着的交付包；被版本上限挤掉的旧记录不留下载入口，也不留文件
  await pruneDeliveryPackages(id, normalizeDeliveries(found.deliveries).map((entry) => entry.id).filter(Boolean))
  return normalize(found)
}

export async function deleteProject(id, user = null) {
  const list = await loadAll()
  const index = list.findIndex((item) => item.id === id && canAccess(item, user))
  if (index < 0) return null
  const [removed] = list.splice(index, 1)
  await persist(list)
  // 作品没了，它封存的交付包也不该留在盘上
  await dropProjectDeliveryPackages(id)
  return normalize(removed)
}

// ---------- 只读分享链接 ----------
// 分享给没有账号的人看（甲方、剪辑），所以链接本身就是凭证：24 字节随机 token。
// 与模板分享同一套规则：停止分享就把 token 清掉，旧链接当场失效；重新开启换一个新 token。
// 公开视图走 project-share.mjs 的白名单，不带归属、内部 id 与画布信息。
const SHARE_TOKEN_MIN = 16

function newShareToken() {
  return randomBytes(18).toString('base64url')
}

export async function enableProjectShare(id, user = null, { compare = false } = {}) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  // 已经开着分享时又点了一次：先把上一轮归档，旧链接的打开记录不会跟着消失
  archiveShare(found, new Date().toISOString())
  const token = newShareToken()
  const createdAt = new Date().toISOString()
  found.shareToken = token
  found.shareCreatedAt = createdAt
  found.shareBy = user?.id || ''
  // 对照纸是分享者主动打开的，不是默认权限：关掉时连字段一起删，旧链接不会残留
  if (compare === true) found.shareCompare = true
  else delete found.shareCompare
  await persist(list)
  return { token, createdAt, compare: compare === true }
}

/**
 * 已开的链接上切换「带不带两版对照」：不换 token，已经发出去的地址继续有效。
 * 只改一个布尔字段，不碰作品、评审、交付；没在分享时返回 null。
 */
export async function setProjectShareCompare(id, user = null, compare = false) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found || !found.shareToken) return null
  const next = compare === true
  const current = found.shareCompare === true
  if (next !== current) {
    if (next) found.shareCompare = true
    else delete found.shareCompare
    await persist(list)
  }
  return {
    token: String(found.shareToken),
    createdAt: String(found.shareCreatedAt || ''),
    compare: next,
  }
}

export async function disableProjectShare(id, user = null) {
  const list = await loadAll()
  const found = list.find((item) => item.id === id && canAccess(item, user))
  if (!found) return null
  if (!found.shareToken) return true
  archiveShare(found, new Date().toISOString())
  delete found.shareToken
  delete found.shareCreatedAt
  delete found.shareBy
  delete found.shareCompare
  await persist(list)
  return true
}

/** 按分享 token 找作品：只认仍然开着分享的条目；长度不够的 token 不查盘。 */
export async function getProjectByShareToken(token) {
  if (!token || typeof token !== 'string' || token.length < SHARE_TOKEN_MIN) return null
  const list = await loadAll()
  const found = list.find((item) => item.shareToken === token)
  return found ? normalize(found) : null
}

/** 注销账号时用。 */
export async function deleteProjectsByOwner(ownerId) {
  if (!ownerId) return 0
  const list = await loadAll()
  const mine = list.filter((item) => item.ownerId === ownerId)
  if (!mine.length) return 0
  await persist(list.filter((item) => item.ownerId !== ownerId))
  return mine.length
}
