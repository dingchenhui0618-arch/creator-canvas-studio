// 分享链接的打开记录：只回答「这条链接被打开过几次、最近一次什么时候、从哪类客户端」。
//
// 记的是「打开分享页」这件事，不是「谁看的」：没有账号就没有身份，界面文案不许说成人数。
// 规则（哈希前缀、四类客户端、一分钟窗口）在 visit-log.mjs 里，与回执链接共用一套。
import { createVisitLog } from './visit-log.mjs'

// 这条记录是给人看的，不是审计日志：只留最近打开过的 200 条链接
const MAX_ENTRIES = 200

export { EMPTY_VISITS, OPEN_DEDUPE_MS, clientKind, visitKey } from './visit-log.mjs'

/** 停掉分享时不清记录：链接虽然失效了，但「它被打开过几次」是发生过的事。 */
export const SHARE_VISIT_LIMIT = MAX_ENTRIES

const log = createVisitLog({ file: 'share-visits.json', maxEntries: MAX_ENTRIES })

/** 记一次分享页打开。返回这条链接的最新统计。 */
export async function recordShareOpen(token, userAgent, nowMs = Date.now()) {
  return log.record(token, userAgent, nowMs)
}

/**
 * 按记录键读。停用分享时 token 就被清掉了，历史链接只剩这个哈希前缀：
 * 作品页回看「那一轮被打开过几次」只能走这里。
 */
export async function getShareVisitsByKey(key) {
  return log.readByKey(key)
}

/** 作品页的分享面板读这条：没开过分享、或者没人打开过，都返回全零。 */
export async function getShareVisits(token) {
  return log.read(token)
}
