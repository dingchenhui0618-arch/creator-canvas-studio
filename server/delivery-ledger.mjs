// 交付流水：已经交出去的每一版，按交付时间倒序摊成一条线。
//
// 交付记录是事实：v0.9.22 起每次「标记交付」落一条 { version, at }，同一版重复标记只更新时间；
// 开新版时上一版会补一条记录（老数据没有时间，at 是空串），作品回到在做。
// 所以「交出去过」不等于「现在还在交付状态」——这一行写的是前者，
// 「现在还作不作数」由 current（这一版还是不是当前版）与 deliveredNow 各自说，不混成一句假话。
//
// 工作台只回答「我交出去过什么」：一屏先排 3 条，点开一页 8 条，再往下按 offset 接着取。
import { deliveredCurrent } from './project-status.mjs'

/** 一页取几条：工作台点开一次排 8 条，再往下是「再看 N 条」。 */
export const LEDGER_PAGE = 8
/** 一页最多取几条：与评审队列同一个上限，防止一次把几百条记录全塞给前端。 */
export const LEDGER_MAX_PAGE = 20

const versionOf = (value) => Math.max(1, Math.round(Number(value) || 0))

/**
 * 摊平成行：一条作品可能交过好几版，每一版一行。
 * 列表与计数读同一份行，界面上的数字才不会和真正排出来的行对不上。
 */
export function ledgerRows({ projects = [], counts = {} } = {}) {
  const rows = []
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || !project.id) continue
    const currentVersion = versionOf(project.version)
    const deliveries = Array.isArray(project.deliveries) ? project.deliveries : []
    for (const entry of deliveries) {
      // 交付记录里的版次有坏值时跳过这一条：宁可少一行，也不编一版出来
      const version = Math.max(0, Math.round(Number(entry?.version) || 0))
      if (!version) continue
      // 那一版的结论跟着版本走：这一行写「交出去时评审给的结论」，不是作品现在的结论
      const bucket = counts?.[project.id]?.versions?.[String(version)] || null
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
        reviews: Number(bucket?.count) || 0,
        verdict: String(bucket?.lastVerdict || ''),
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
 * 交付流水：items 是一页的行，其余都是按整份行算的数字——
 * 「共 N 条」「M 条作品」不会因为只取了前 8 条就变小。
 */
export function deliveryLedger({ projects = [], counts = {} } = {}, { offset = 0, limit = LEDGER_PAGE } = {}) {
  const rows = ledgerRows({ projects, counts })
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
    // 最近一次交付的时间；一条带时间的都没有就是空串
    lastAt: rows.find((row) => row.atKnown)?.at || '',
    offset: from,
    hasMore: from + items.length < rows.length,
  }
}
