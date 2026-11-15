// 回执链接的打开记录（v0.9.145）：那条发给收包人的地址，被打开过没有。
//
// 为什么值得单独记：一份包发出去三四天没回音，真正要分的两件事是
// 「他根本没点开这条链接」（多半没送到，先把链接再发一次）和
// 「他点开看了，收据还没贴回来」（再催他一句）。只凭天数分不出来。
//
// 规则与分享链接同一套（visit-log.mjs）：只存哈希前缀、只分四类客户端、一分钟内的刷新算一次。
// 记的是「这条地址被打开过」，不是「谁打开了」——所以界面只说打开过几次，不说他看没看。
import { createVisitLog } from './visit-log.mjs'

// 只留最近打开过的 1000 条回执链接：这条记录被挤掉之后，界面会重新说「还没被打开」——
// 那对一份其实有人验过的包是一句假话。分享链接 200 条够用，回执这一份留得宽一些。
export const RECEIPT_VISIT_LIMIT = 1000

export { EMPTY_VISITS, OPEN_DEDUPE_MS, clientKind, visitKey } from './visit-log.mjs'

const log = createVisitLog({ file: 'receipt-visits.json', maxEntries: RECEIPT_VISIT_LIMIT })

/** 收包人打开回执链接时记一次：只记这条地址被打开过，不记是谁打开的。 */
export async function recordReceiptOpen(token, userAgent, nowMs = Date.now()) {
  return log.record(token, userAgent, nowMs)
}

/** 按 token 读：没打开过是全零，不是 null——界面据此说「还没被打开」。 */
export async function getReceiptVisits(token) {
  return log.read(token)
}

/** 换一条链接之后，旧 token 的记录还在（它确实被打开过），作品页按记录键也能回看。 */
export async function getReceiptVisitsByKey(key) {
  return log.readByKey(key)
}
