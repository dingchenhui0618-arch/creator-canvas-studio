// 交付流水：已经交出去的每一版，按交付时间倒序摊成一条线。
//
// 交付记录是事实：v0.9.22 起每次「标记交付」落一条 { version, at }，同一版重复标记只更新时间；
// 开新版时上一版会补一条记录（老数据没有时间，at 是空串），作品回到在做。
// 所以「交出去过」不等于「现在还在交付状态」——这一行写的是前者，
// 「现在还作不作数」由 current（这一版还是不是当前版）与 deliveredNow 各自说，不混成一句假话。
//
// 工作台只回答「我交出去过什么」：一屏先排 3 条，点开一页 8 条，再往下按 offset 接着取。
//
// 回执（v0.9.139）：交出去之后收包人会把回执贴回来，结论留在作品页的交付档案里。
// 但工作台才是每天看的地方——一份「他验的不是我封的那份」如果只写在那个面板里，
// 没人打开就永远不知道。所以每一行带上回执的结论，清单顶上再按整份记录数一遍。
import { deliveredCurrent, deliveryDrift } from './project-status.mjs'
// 一条交付最多换几次地址（v0.9.150）：与 server/projects.mjs 的 RELINK_LIMIT 同一个数
import { RELINK_LIMIT } from './projects.mjs'

/** 一页取几条：工作台点开一次排 8 条，再往下是「再看 N 条」。 */
export const LEDGER_PAGE = 8
/** 一页最多取几条：与评审队列同一个上限，防止一次把几百条记录全塞给前端。 */
export const LEDGER_MAX_PAGE = 20

const versionOf = (value) => Math.max(1, Math.round(Number(value) || 0))

// 与 projects.mjs 同一套四种状态：多一种就按「没核对过」处理，不猜
const RECEIPT_STATES = ['match', 'mismatch', 'broken', 'conflict']
// 五项的顺序与作品页的逐项比对一致：差在哪一项按这个顺序列，读起来不会每次换序
const RECEIPT_CHECK_KEYS = ['version', 'package', 'bytes', 'sha256', 'verdict']
// 发出几天算「该提一句了」（v0.9.144）：与 src/domain/delivery-wait.ts 同一个数
const REMIND_LATE_DAYS = 3
const DAY_MS = 86400000
// 链接重新发过几次还没被打开，就该换个方式发了（v0.9.146）：与 src/domain/delivery-resend.ts 同一个数。
// 一次没打开可能是没看到；第二次还没打开，多半是地址 / 渠道不对，再发同一条只是重复劳动。
const RESEND_STUCK = 2

/**
 * 工作台那一行上的回执（v0.9.139）：只要结论、时间、谁贴的、贴过几次。
 * 逐项比对与摘要留在作品页的交付档案里——一页几十条，不把每条的 checks 都搬过来。
 * 老记录只有 receipt 没有 receipts，按一次算，不把一次说成零次。
 */
function receiptBrief(entry) {
  const receipt = entry?.receipt
  if (!receipt || !RECEIPT_STATES.includes(receipt.state)) return null
  const history = Array.isArray(entry?.receipts) ? entry.receipts.length : 0
  const brief = {
    state: receipt.state,
    at: String(receipt.at || ''),
    // 没有 via 的老记录按「你替他贴的」讲，与作品页同一口径
    via: receipt.via === 'link' ? 'link' : 'you',
    count: Math.max(1, history),
  }
  // 对不上的那几项（v0.9.144）：只给项名，不给两边写过的值。
  // 读不出来（broken）时逐项没有意义——整张收据都没解析成，列出来只会误导。
  if (receipt.state === 'mismatch' || receipt.state === 'conflict') {
    const checks = Array.isArray(receipt.checks) ? receipt.checks : []
    const bad = RECEIPT_CHECK_KEYS.filter((key) => checks.some((check) => check?.k === key && check.ok === false))
    if (bad.length) brief.bad = bad
  }
  return brief
}

/**
 * 催过的记录（v0.9.144）：催过几次、最近一次哪天。没催过就是 null。
 * 贴过回执之后也照实返回——「催过两次他才验」是发生过的事；界面上要不要提由那一行自己决定。
 */
function reminderBrief(entry) {
  const list = (Array.isArray(entry?.reminders) ? entry.reminders : [])
    .filter((item) => item && typeof item.at === 'string' && item.at)
  if (!list.length) return null
  return { count: list.length, at: list[list.length - 1].at }
}

/**
 * 又发过几次链接（v0.9.146）：链接一次都没被打开过时，把同一条地址重新发出去的次数。
 * 与「催过几次」分开——催是在问验没验，重发是在问收没收到。没重发过就是 null。
 */
function resendBrief(entry) {
  const list = (Array.isArray(entry?.resends) ? entry.resends : [])
    .filter((item) => item && typeof item.at === 'string' && item.at)
  if (!list.length) return null
  return { count: list.length, at: list[list.length - 1].at }
}

/**
 * 换过几条新链接（v0.9.147）：同一条地址发到两次还没被打开之后换掉的那几次。
 * 只给「换过几次、最近一次哪换的、换之前那条发过几次」——旧地址本身不存，也不往下传。
 * 没换过就是 null。
 */
function relinkBrief(entry) {
  const list = (Array.isArray(entry?.relinks) ? entry.relinks : [])
    .filter((item) => item && typeof item.at === 'string' && item.at)
  if (!list.length) return null
  const last = list[list.length - 1]
  return {
    count: list.length,
    at: String(last.at || ''),
    resends: Math.max(0, Math.round(Number(last.resends) || 0)),
  }
}

/**
 * 换掉的那条旧地址还被点过几次（v0.9.149）：换地址之后，新地址的打开次数从零算起——
 * 但「没人打开新地址」有两种完全不同的原因：新地址没送到（他还在点旧的），或者送到了他没理。
 * 旧的这条还被点着，就是前一种：他手上留着的还是旧的那条。只给次数与最近一次，不给旧地址本身。
 * 一次都没被点过就是 null——没发生的事不写成一行字。
 */
function retiredHitBrief(entry) {
  const list = (Array.isArray(entry?.retired) ? entry.retired : []).filter((item) => item && typeof item.key === 'string')
  let count = 0
  let at = ''
  for (const item of list) {
    const hits = Math.max(0, Math.round(Number(item.hits) || 0))
    if (!hits) continue
    count += hits
    const lastAt = String(item.lastAt || item.at || '')
    if (lastAt > at) at = lastAt
  }
  return count ? { count, at } : null
}

/**
 * 回执链接被打开过几次（v0.9.145）：只回答「这条地址被点开过没有、最近一次什么时候」。
 * 链接发出时还没开始记的那些（升级前发的）一律 null——不知道就说不知道，不写「还没被打开」。
 * 记录按 token 的哈希前缀存在另一个文件里（receipt-visits.json），projects.json 不带它。
 */
function visitsBrief(entry, seen) {
  if (!entry?.package || !entry?.receiptLinkAt) return null
  const value = seen && typeof seen === 'object' ? seen : {}
  return {
    opens: Math.max(0, Math.round(Number(value.opens) || 0)),
    firstAt: String(value.firstAt || ''),
    lastAt: String(value.lastAt || ''),
  }
}

/**
 * 摊平成行：一条作品可能交过好几版，每一版一行。
 * 列表与计数读同一份行，界面上的数字才不会和真正排出来的行对不上。
 * visits 是「交付记录编号 → 这条链接的打开次数」，由路由一次读好再传进来（这一层不碰文件）。
 */
export function ledgerRows({ projects = [], counts = {}, visits = {} } = {}) {
  const rows = []
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || !project.id) continue
    const currentVersion = versionOf(project.version)
    const deliveries = Array.isArray(project.deliveries) ? project.deliveries : []
    for (const entry of deliveries) {
      // 交付记录里的版次有坏值时跳过这一条：宁可少一行，也不编一版出来
      const version = Math.max(0, Math.round(Number(entry?.version) || 0))
      if (!version) continue
      // 那一版的结论跟着版本走：这一行写「交出去时评审给的结论」，不是作品现在的结论。
      // 交时结论是交付那一刻存下来的快照（v0.9.85）；这一版后来重评，历史不能被改写。
      // 老记录没有快照（undefined）：界面只能写「当时没记」，不能拿最近一评冒充。
      const bucket = counts?.[project.id]?.versions?.[String(version)] || null
      // 打开情况只算一次：同一份事实既要说「打开过几次」，也要决定「能不能再发一次」
      const seen = visitsBrief(entry, visits?.[project.id + ':' + String(entry?.id || '')])
      const resend = entry?.package ? resendBrief(entry) : null
      const relink = entry?.package ? relinkBrief(entry) : null
      rows.push({
        projectId: project.id,
        title: project.title || '',
        version,
        // 时间没记下的（开新版补的记录、升级前的老数据）如实标 atKnown=false，不拿作品更新时间冒充
        at: String(entry?.at || ''),
        atKnown: Boolean(entry?.at),
        currentVersion,
        current: version === currentVersion,
        deliveredNow: deliveredCurrent(project),
        // 这一版评过几次（含交付之后的重评）：是版本级的事实，不是「交时」的结论
        reviews: Number(bucket?.count) || 0,
        verdict: String(bucket?.lastVerdict || ''),
        review: entry?.review,
        // 这一版最近一评的问题数：界面拿它和交时快照比，才说得出「之后又评成了别的结论」
        issues: bucket?.issues || null,
        // 封存包（v0.9.125）：有编号与元数据才给下载入口；老记录这两项都是空
        deliveryId: String(entry?.id || ''),
        package: entry?.package || null,
        // 回执（v0.9.139）：有封存包才谈得上回执；没贴过就是 null（界面写「还没回执」）
        receipt: receiptBrief(entry),
        // 催过几次、最近一次（v0.9.144）：与回执一样只挂在有封存包的记录上
        reminder: entry?.package ? reminderBrief(entry) : null,
        // 回执链接被打开过几次（v0.9.145）：不知道的那些是 null，界面什么都不说
        visits: seen,
        // 又发过几次链接（v0.9.146）：与催过分开记，两个数回答的是两个问题
        resend,
        // 换过几条新链接（v0.9.147）：换过之后 resends 清零，所以两个数要一起看
        relink,
        // 换掉的那条旧地址还被点过几次（v0.9.149）：点着旧的，说明新的那条没送到他手上
        retiredHits: entry?.package ? retiredHitBrief(entry) : null,
        // 他点过「收到了」（v0.9.151）：收据还没回来，但「没送到」这一层已经排除了。
        // 只有真的点过才给时间，界面据此把「还没收到回执」那句换成「东西到手了，还没验」。
        ack: entry?.package && entry?.ack?.at ? { at: String(entry.ack.at) } : null,
        // 这一条是给谁的（v0.9.152）：发件人自己写的称呼。空串 = 没写（老记录都是这样），
        // 界面就不写这一段——「不知道」与「没写」在这里是同一件事，不猜一个人名出来。
        recipient: entry?.package ? String(entry?.recipient || '') : '',
        // 他回了什么（v0.9.153）：收包人说的原话。null = 还没记（不是「他说没问题」）——
        // 界面据此什么都不说，不替他下结论。
        reply:
          entry?.package && entry?.reply?.text
            ? { text: String(entry.reply.text), at: String(entry.reply.at || '') }
            : null,
        // 现在能不能「再发一次链接」：有包、还没回执、链接还在，而且确知这条地址一次都没被打开过。
        // 不知道被打开过没有（升级前发的链接）就不给这个按钮——那种情况下「再发一次」是盲发。
        // v0.9.150 起到了换地址的上限就不再给「再发一次」：那条路是「同一条消息再发一遍」，
        // 到这一步已经证明没用；行上给的是「问他一句」，那段话里带着现在这条地址。
        resendable: Boolean(
          entry?.package &&
            !RECEIPT_STATES.includes(entry?.receipt?.state) &&
            /^[0-9a-f]{16}$/.test(String(entry?.receiptToken || '')) &&
            // 他点过「收到了」（v0.9.151）：东西已经到手，缺的不是「再发一遍」
            !entry?.ack?.at &&
            seen &&
            seen.opens === 0 &&
            Number(relink?.count || 0) < RELINK_LIMIT,
        ),
        // 现在能不能「换一条新链接」（v0.9.147）：同一条地址又发过两次还是没人打开，
        // 说明问题不在「他忘了」——再发第三遍也不会不一样。打开过的、不知道打开没有的都不换：
        // 前者可能正被看着，后者换掉等于把一条也许已经送到的地址作废。
        // v0.9.150 起还有一条上限：换过两次就不再给换——换的是地址，不是渠道。
        relinkable: Boolean(
          entry?.package &&
            !RECEIPT_STATES.includes(entry?.receipt?.state) &&
            /^[0-9a-f]{16}$/.test(String(entry?.receiptToken || '')) &&
            // 他都点过「收到了」了，换地址解决的不是他的问题（v0.9.151）
            !entry?.ack?.at &&
            seen &&
            seen.opens === 0 &&
            Number(relink?.count || 0) < RELINK_LIMIT &&
            Number(resend?.count) >= RESEND_STUCK,
        ),
        // 换到头了（v0.9.150）：已经换过两次地址，这一条还是一次都没被打开。
        // 界面据此把「换一条新链接」换成「问他一句」——到这一步再换地址只是换个 token 重发同一条消息。
        relinkCapped: Boolean(
          entry?.package &&
            !RECEIPT_STATES.includes(entry?.receipt?.state) &&
            /^[0-9a-f]{16}$/.test(String(entry?.receiptToken || '')) &&
            // 点过「收到了」就不再是「没送到」：不算换到头，也不劝人再换地址（v0.9.151）
            !entry?.ack?.at &&
            seen &&
            seen.opens === 0 &&
            Number(relink?.count || 0) >= RELINK_LIMIT,
        ),
        // 现在能不能催：有包、还没回执、回执链接还留着（换过一条或从来没生过就没有）
        remindable: Boolean(
          entry?.package &&
            !RECEIPT_STATES.includes(entry?.receipt?.state) &&
            /^[0-9a-f]{16}$/.test(String(entry?.receiptToken || '')),
        ),
      })
    }
  }
  // 新的在前；时间没记下的排最后，同一天的两条按作品名与版次排，顺序不随盘上数组怎么排而变
  rows.sort((a, b) => {
    if (a.atKnown !== b.atKnown) return a.atKnown ? -1 : 1
    const byTime = b.at.localeCompare(a.at)
    if (byTime) return byTime
    const byTitle = a.title.localeCompare(b.title)
    if (byTitle) return byTitle
    if (a.version !== b.version) return b.version - a.version
    return a.projectId.localeCompare(b.projectId)
  })
  return rows
}

/**
 * 按人看（v0.9.154）：同一批交付按收件人归堆，回答「谁还欠着回执」。
 *
 * 一条交付上写着「给谁」（v0.9.152），可工作台那一行一行排下来，问的是「哪一条还没回来」；
 * 交给同一个人三四条时，真正想问的是「王老师那边还欠几份」——这一堆数就回答这一句。
 *
 * 边界：
 *  - 只数写了收件人的记录；没写的另算一个数（unlabeled），不混进任何一个人名下，也不猜是谁；
 *  - 只有封过包、而且还没收到收据的才算「欠着」——没包的老交付谈不上回执，对上的也不再催；
 *  - 点一个人该落在哪一条：优先「他还欠着的那条里最近交付的一条」；都回来了就落在最近交付的那条；
 *  - 按「欠着几条」排前面，同样多的按总条数、再按名字排——先看最该催的那一个。
 */
export function ledgerPeople(rows) {
  const map = new Map()
  for (const row of rows) {
    const name = String(row?.recipient || '')
    if (!name) continue
    const atMs = Date.parse(String(row?.at || '')) || 0
    const entry = map.get(name) || {
      name,
      count: 0,
      sealed: 0,
      pending: 0,
      pendingAcked: 0,
      target: null,
      pendingTarget: null,
      pendingAt: -1,
      latestAt: -1,
    }
    const candidate = {
      projectId: String(row.projectId || ''),
      deliveryId: String(row.deliveryId || ''),
      version: Math.max(0, Math.round(Number(row.version) || 0)),
    }
    entry.count += 1
    if (row.package) entry.sealed += 1
    // 欠着回执 = 有包、还没收据；他自己点了「收到了」的那几条也算欠着（只差验）
    if (row.package && !row.receipt) {
      entry.pending += 1
      if (row.ack) entry.pendingAcked += 1
      if (atMs >= entry.pendingAt) {
        entry.pendingAt = atMs
        entry.pendingTarget = candidate
      }
    }
    if (atMs >= entry.latestAt) {
      entry.latestAt = atMs
      entry.target = candidate
    }
    map.set(name, entry)
  }
  return [...map.values()]
    .map((entry) => ({
      name: entry.name,
      count: entry.count,
      sealed: entry.sealed,
      pending: entry.pending,
      pendingAcked: entry.pendingAcked,
      // 点进去落在哪一条：先找他还欠着的那条，都回来了落在最近交付的那条
      target: entry.pendingTarget || entry.target,
    }))
    .sort((a, b) => {
      if (a.pending !== b.pending) return b.pending - a.pending
      if (a.count !== b.count) return b.count - a.count
      return a.name.localeCompare(b.name)
    })
}

/**
 * 交付流水：items 是一页的行，其余都是按整份行算的数字——
 * 「共 N 条」「M 条作品」不会因为只取了前 8 条就变小。
 */
export function deliveryLedger(
  { projects = [], counts = {}, visits = {} } = {},
  // now 只为「发了几天」这一件事：测试传一个固定时刻，结果就不会随当天日期漂
  { offset = 0, limit = LEDGER_PAGE, now = Date.now() } = {},
) {
  const rows = ledgerRows({ projects, counts, visits })
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  // 回执的四个数按整份记录算（不是这一页）：封过包的几条、对上的几条、对不上的几条、还没回来的几条。
  // 只有封了包的交付才谈得上回执——升级前那几条没有包，不把它们算成「还没回来」，那样会凭空多出待办。
  // pendingLate（v0.9.144）不是第五种：它是 pending 里发出超过三天的那些，用来提示「可以提一句」。
  // pendingStuck（v0.9.146）同样不是第六种结论：它是 pendingUnopened 里「又发过 2 次以上还是没打开」的那些，
  // 也就是「再把同一条地址发一遍也没用了」的那几条，该换个渠道或换个人。
  // pendingRelinked（v0.9.147）是它的下一步：这几条已经换过一条新地址，新地址还是没人打开——
  // 到这一步别再换地址了，问题多半不在链接上（收件人写错了、人家不用这个渠道），该换个人。
  // pendingAcked（v0.9.151）同样是 pending 的子集，但和 pendingUnopened 互斥：点了「收到了」，
  // 说明他打开过、也拿到了东西；这几条不该再被算进「可能没送到」的那一堆里。
  const receipts = { sealed: 0, matched: 0, mismatched: 0, unclear: 0, pending: 0, pendingLate: 0, pendingUnopened: 0, pendingStuck: 0, pendingRelinked: 0, pendingAcked: 0 }
  for (const row of rows) {
    if (!row.package) continue
    receipts.sealed += 1
    if (!row.receipt) {
      receipts.pending += 1
      if (row.ack) receipts.pendingAcked += 1
      const at = Date.parse(row.at)
      if (Number.isFinite(at) && nowMs - at >= REMIND_LATE_DAYS * DAY_MS) receipts.pendingLate += 1
      // pendingUnopened（v0.9.145）也是 pending 的子集：还没回来、而且这条链接一次都没被打开过。
      // 不知道打开过没有的那几条不算进来——猜出来的待办比没有更糟。
      // 点过「收到了」的那几条不进「可能没送到」这一堆（v0.9.151）：他自己说了东西到手。
      if (row.visits && row.visits.opens === 0 && !row.ack) {
        receipts.pendingUnopened += 1
        if (Number(row.resend?.count) >= RESEND_STUCK) receipts.pendingStuck += 1
        if (Number(row.relink?.count) >= 1) receipts.pendingRelinked += 1
      }
    } else if (row.receipt.state === 'match') receipts.matched += 1
    else if (row.receipt.state === 'mismatch') receipts.mismatched += 1
    else receipts.unclear += 1
  }
  const max = Math.min(LEDGER_MAX_PAGE, Math.max(1, Math.round(Number(limit) || LEDGER_PAGE)))
  // 从第几条开始取：负数不往回排，越过总数就是空的一页，界面据此收起「再看」
  const from = Math.min(rows.length, Math.max(0, Math.round(Number(offset) || 0)))
  const items = rows.slice(from, from + max)
  return {
    items,
    total: rows.length,
    // 交付过几条作品（不是几条记录）
    projects: new Set(rows.map((row) => row.projectId)).size,
    // 其中几条交的还是当前这一版：开过新版的那些作品，旧的交付记录仍然在
    currentTotal: rows.filter((row) => row.current).length,
    // 其中几条交出去之后这一版又被评成了别的结论（v0.9.86）：按交付记录数，不按作品数
    drifted: rows.filter((row) => deliveryDrift(row.review, { verdict: row.verdict, issues: row.issues })).length,
    // 最近一次交付的时间；一条带时间的都没有就是空串
    lastAt: rows.find((row) => row.atKnown)?.at || '',
    // 回执的四个数（v0.9.139）：sealed = matched + mismatched + unclear + pending
    receipts,
    // 按人看（v0.9.154）：写了收件人的那几条按人归堆，回答「谁还欠着回执」。
    // 这是整份记录的账，不随分页变；没写收件人的另算一个数，不混进任何人名下。
    people: ledgerPeople(rows),
    unlabeled: rows.filter((row) => !row.recipient).length,
    offset: from,
    hasMore: from + items.length < rows.length,
  }
}
