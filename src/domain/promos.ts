// 运营位（用户说的「广告模块」）的真源（r319，2026-11-26）
//
// 竞品（即梦 / LibTV / RunningHub / Picset）的首页与工作台都挂着运营位：
// 新功能说一句、会员/点数推一下。我们以前一处都没有——用户进来只看到能力卡，
// 不知道最近出了什么、也不知道该往哪走。
//
// 这一步先做最小可用：内容写在这一个文件里，位置由 placement 决定，
// 能不能看见由 from / until / internal / 关掉的记录一起决定；关掉记在浏览器本地。
// 下一步（r320）把这份数组变成服务端默认值 + 后台可编辑，位置与组件不用动。
import type { Page } from './types'

/** 运营位挂在哪一屏。加位置要同时在页面里放一个 <PromoSlot placement="…">。 */
export type PromoPlacement = 'overview' | 'templates' | 'recharge'

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

export const PROMO_DISMISS_KEY = 'vq_promos_dismissed'

/** 同一个位置最多显示几条（组件默认值；页面可以用 max 覆盖）。 */
export const PROMO_MAX_PER_PLACEMENT = 2

/**
 * 运营位内容。写文案的三条规矩：
 *   1. 只说我们已经真跑通过的能力，不把「计划做」写成「已经能」；
 *   2. 涉及扣费就写明扣多少、失败怎么办（房间那条写的是每轮 1 积分、失败全额退回）；
 *   3. 一句话说清「点进去能拿到什么」，不写「赋能 / 一站式 / 全新升级」这类空话。
 */
export const PROMOS: readonly Promo[] = [
  {
    id: 'rooms-beta',
    placement: 'overview',
    weight: 20,
    kicker: 'Beta · 聊天室',
    title: '把几个智能体放进同一个房间',
    body: '房间里你说一句，平台智能体接一句：起草、拆结构、找选题。每轮 1 积分，答不上来全额退回。',
    cta: '去聊天室',
    page: 'rooms',
  },
  {
    id: 'radar-to-template',
    placement: 'overview',
    weight: 10,
    kicker: '复刻主线',
    title: '从一条爆款到一份可复用模板',
    body: '爆款雷达搜抖音与小红书，拆出钩子、结构与分镜；落进模板库就能直接拿去改编。',
    cta: '去爆款雷达',
    page: 'radar',
  },
  {
    id: 'review-evidence',
    placement: 'overview',
    weight: 0,
    kicker: '视觉评审',
    title: '按帧给结论，每条带证据',
    body: '抽帧逐条标出问题与像素锚点，评审结论可以回写到作品，作为封版依据。',
    cta: '去视觉评审',
    page: 'review',
  },
  {
    id: 'template-source-footprint',
    placement: 'templates',
    weight: 10,
    kicker: '模板库',
    title: '每条模板都记着它从哪来',
    body: '模板会写下解析来源与用了几次；改编出的作品也回指这条模板，方便回头找同款结构。',
    cta: '去爆款雷达',
    page: 'radar',
  },
]

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
