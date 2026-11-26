// 运营位（用户说的「广告模块」）在前端这边的真源：类型 + 筛选规则 + 本地那份记录。
//
// r319 内容也写在这个文件里；r320 搬到服务端（server/promos.mjs + 后台「运营位」卡）：
// 运营位天生要随时改（新功能说一句、活动推一下、过期就撤），写在前端文件里改一句话就得发一版。
// 现在这里只剩三件事：结构长什么样、这一条现在该不该显示、关掉过哪几条。
import type { Page } from './types'

/** 运营位挂在哪一屏。加位置要同时在页面里放一个 <PromoSlot placement="…">。
 *  这份名单必须与 server/promos.mjs 的 PROMO_PLACEMENTS 一致（test/promos.test.mjs 会对着比）。 */
export const PROMO_PLACEMENTS = ['overview', 'templates', 'recharge'] as const

export type PromoPlacement = (typeof PROMO_PLACEMENTS)[number]

/**
 * 运营位按钮能跳到哪些页面。这份名单与 src/domain/types.ts 的 Page、server/promos.mjs 的 PROMO_PAGES
 * 是同一个东西的三份副本——这里不直接 import types.ts，是因为 test/promos.test.mjs 要用 node 直接跑
 * 这个模块（node 的 ESM 认不出没有扩展名的 './types' 运行时导入）；test/promos.test.mjs
 * 会把这三份逐个比对，少一个就红。
 */
export const PROMO_PAGES: readonly Page[] = [
  'login', 'overview', 'projects', 'agents', 'agent-editor', 'canvas', 'board', 'runs',
  'settings', 'radar', 'templates', 'assets', 'review', 'rooms', 'recharge', 'local',
]

export type Promo = {
  id: string
  placement: PromoPlacement
  /** 左上角那行小字：新功能 / Beta / 内部口径。 */
  kicker: string
  title: string
  body: string
  /** 按钮上的字，点它去 page。 */
  cta: string
  page: Page
  /** 同位置排序用，大的在前；不写按 0。 */
  weight?: number
  /** 起始日（含），YYYY-MM-DD；不写就是一直有效。 */
  from?: string
  /** 截止日（含）。 */
  until?: string
  /** true = 只在内部口径（管理员）下露出。 */
  internal?: boolean
}

/** 关掉了哪几条：记在这台机器的浏览器里，换个设备会重新出现。 */
export const PROMO_DISMISS_KEY = 'vq_promos_dismissed'

/** 上一次从服务端拿到的内容：为了让第二次打开时运营位立刻在位，不用等请求回来才插入。 */
export const PROMO_CACHE_KEY = 'vq_promos_cache'

/** 同一个位置最多显示几条（组件默认值；页面可以用 max 覆盖）。 */
export const PROMO_MAX_PER_PLACEMENT = 2

/** 今天的日历日（YYYY-MM-DD，本地时区）——运营位的起止日期按本地日算。 */
export function todayKey(date: Date = new Date()): string {
  const pad = (n: number) => (n < 10 ? '0' + n : String(n))
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/**
 * 这条运营位现在该不该显示。日期比较用 YYYY-MM-DD 字符串，天然按日历序。
 */
export function promoVisible(
  promo: Promo,
  opts: { on: string; internal: boolean; dismissed: readonly string[] },
): boolean {
  if (promo.internal && !opts.internal) return false
  if (promo.from && opts.on < promo.from) return false
  if (promo.until && opts.on > promo.until) return false
  if (opts.dismissed.includes(promo.id)) return false
  return true
}

/**
 * 某个位置上现在要显示的运营位：先按 weight 从大到小（同 weight 保持声明顺序——
 * 比较函数返回 0 时 Array.prototype.sort 是稳定的），再截到 max 条。
 */
export function activePromos(
  promos: readonly Promo[],
  opts: { on: string; internal: boolean; dismissed: readonly string[]; placement?: PromoPlacement; max?: number },
): Promo[] {
  const max = opts.max ?? PROMO_MAX_PER_PLACEMENT
  const picked = promos
    .filter((promo) => (opts.placement ? promo.placement === opts.placement : true))
    .filter((promo) => promoVisible(promo, opts))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
  return max >= 0 ? picked.slice(0, max) : picked
}

/**
 * 后台草稿与已保存的内容是不是不一样（r323）：编辑卡用它标「有未保存的改动」。
 *
 * 比的是「整列 + 顺序」而不是逐条找：列表顺序就是权重（保存时按行序重排 weight），
 * 把第 3 条挪到第 1 条是实打实的改动，不能被当成「内容没变」。
 * 文本按 trim 后比（保存时也会 trim），weight 归一成数字、internal 归一成布尔、
 * 没填的日期与空串等价——否则后台一打开就会显示「有未保存的改动」。
 */
/** 比对只看这些字段，不关心 placement / page 是不是白名单里的：
 *  后台草稿行里可能正打着一个还没选完的位置，那种行同样要能比「和已保存的一样不一样」。 */
type PromoComparable = {
  id: string
  placement: string
  page: string
  kicker: string
  title: string
  body: string
  cta: string
  from?: string
  until?: string
  weight?: number
  internal?: boolean
}

export function promosDirty(next: readonly PromoComparable[], saved: readonly PromoComparable[]): boolean {
  if (next.length !== saved.length) return true
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  return next.some((row, index) => {
    const before = saved[index]
    return (
      text(row.id) !== text(before.id) ||
      text(row.placement) !== text(before.placement) ||
      text(row.page) !== text(before.page) ||
      text(row.kicker) !== text(before.kicker) ||
      text(row.title) !== text(before.title) ||
      text(row.body) !== text(before.body) ||
      text(row.cta) !== text(before.cta) ||
      text(row.from) !== text(before.from) ||
      text(row.until) !== text(before.until) ||
      Boolean(row.internal) !== Boolean(before.internal) ||
      (Number(row.weight) || 0) !== (Number(before.weight) || 0)
    )
  })
}

/**
 * 读本地那份「关掉了哪些」。坏 JSON、不是数组、混进非字符串一律当没关过，
 * 不抛错：运营位读不出来不该把整屏带崩。
 */
export function readDismissedPromos(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

/** 一条运营位至少要有这些字段才敢拿去渲染；page / placement 还必须在白名单里。 */
function isPromo(value: unknown): value is Promo {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  const text = (key: string) => typeof item[key] === 'string' && (item[key] as string).length > 0
  if (!text('id') || !text('kicker') || !text('title') || !text('body') || !text('cta') || !text('page')) return false
  if (!PROMO_PLACEMENTS.includes(item.placement as PromoPlacement)) return false
  // 页面也要在白名单里：后台把按钮指到一个不存在的页面时，这条就当不存在（不给一个点了没反应的按钮）
  return PROMO_PAGES.includes(item.page as Page)
}

/**
 * 读本地缓存的那份内容。本地存储是用户能改的（也是旧版本写的），
 * 不校验就等于把渲染交给外部输入：形状不对的整条丢掉，不是整份丢掉。
 */
export function parsePromoCache(raw: string | null | undefined): Promo[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isPromo)
  } catch {
    return []
  }
}
