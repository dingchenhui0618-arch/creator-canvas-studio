// 作品流的两个小口径（r266）：筛选项记在会话里、运行状态说人话。
//
// 为什么单独成文件：作品流会在「点开一条运行 / 一块画布」之后被重挂——
// 以前每次回到作品页筛选都退回「全部」，用户刚筛到「工作流」就又得再点一次。
// 同一个原因也解释了状态文案：这里只认服务端真有的四种终态，别的状态不乱猜。

import type { WorksCounts, WorksDegraded, WorksSource } from '../api/works'

export const WORKS_FILTERS = ['all', 'image', 'video', 'run', 'canvas'] as const

export type WorksFilter = (typeof WORKS_FILTERS)[number]

const KEY = 'vq.works.filter.v2'

/** 读回来的一定是认识的值：没存过、存坏了、浏览器不给用，都退回「全部」。 */
export function readWorksFilter(storage: Pick<Storage, 'getItem'> | null | undefined): WorksFilter {
  try {
    const raw = String(storage?.getItem(KEY) || '')
    return (WORKS_FILTERS as readonly string[]).includes(raw) ? (raw as WorksFilter) : 'all'
  } catch {
    return 'all'
  }
}

/** 记下来；写不进去（隐私模式 / 配额满）不算错，下次退回「全部」而已。 */
export function writeWorksFilter(storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, filter: WorksFilter): void {
  try {
    if (filter === 'all') storage?.removeItem(KEY)
    else storage?.setItem(KEY, filter)
  } catch {
    // 存不下就算了，界面照常用
  }
}

// 搜作品的关键词也跟着会话走（r281）：点开一条作品再回来，刚才搜的词还在，
// 否则每次回来都要重打一遍。存的是**关键词**，不存结果——结果是服务端随时会变的口径。
const QUERY_KEY = 'vq.works.query.v1'
export const WORKS_QUERY_MAX = 40

/** 读回来的关键词只做最小校验：去掉首尾空白、截断到上限；其余一律当没搜。 */
export function readWorksQuery(storage: Pick<Storage, 'getItem'> | null | undefined): string {
  try {
    const raw = String(storage?.getItem(QUERY_KEY) || '').trim().slice(0, WORKS_QUERY_MAX)
    return raw
  } catch {
    return ''
  }
}

/** 存下来；空词就删键（别在会话里留一个空字符串）。 */
export function writeWorksQuery(storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, query: string): void {
  try {
    const value = String(query || '').trim().slice(0, WORKS_QUERY_MAX)
    if (value) storage?.setItem(QUERY_KEY, value)
    else storage?.removeItem(QUERY_KEY)
  } catch {
    // 存不下就算了，界面照常用
  }
}

/**
 * 一次运行的状态说人话。
 * 服务端只有 running / queued / success / error / interrupted 五种（r265 核过 server/flows.mjs）；
 * 作品流里正常只会见到后三种，前两种留着兜底，不认识的状态返回空串——不猜成「已停止」。
 */
export function runStatusLabel(status: string | undefined | null): string {
  switch (String(status || '')) {
    case 'success': return '跑完了'
    case 'error': return '失败'
    case 'interrupted': return '已停止'
    case 'running': return '还在跑'
    case 'queued': return '排队中'
    default: return ''
  }
}
/**
 * 作品卡上那条「离开作品流」的路叫什么。
 * 有产物时它不是缩略图的默认动作，而是浮层/卡片上一个写明去哪儿的按钮（r266）。
 * 工作流 → 那次运行的只读视图；画布本身与画布里出的图 → 那块画布；快捷创作的成品没有对应页面，返回空串。
 */
export function workDetailLabel(item: { kind?: string; canvasId?: string }): string {
  if (item.kind === 'run') return '打开这次运行'
  if (item.kind === 'canvas' || item.canvasId) return '打开画布'
  return ''
}

// ---------- r284：读不到 ≠ 没有 ----------
//
// 作品流有三个来源：快捷创作的图与视频、工作流的运行记录、无限画布（另一个应用）。
// 以前任何一处读不到都被前端画成「这一类还没有作品」——画布服务挂那一刻，
// 一个在画布里出过 30 张图的人会看到「无限画布这一类还没有作品，在无限画布上出过图或视频就会进这里」，
// 等于告诉他那些作品从来没存在过。服务端现在把「哪一处没读到、那句话怎么说」带上来（degraded），
// 界面照这里的三条规则画：数字写「—」、空状态说没读到、别把总数说满。

export const WORKS_SOURCE_LABEL: Record<WorksSource, string> = {
  media: '快捷创作',
  runs: '工作流',
  canvas: '无限画布',
}

/** 栏目 → 它是从哪个来源读出来的：图片和视频同属快捷创作。 */
export function worksKindSource(kind: WorksFilter): WorksSource | '' {
  if (kind === 'image' || kind === 'video') return 'media'
  if (kind === 'run') return 'runs'
  if (kind === 'canvas') return 'canvas'
  return ''
}

/** 这一栏这次读到了吗：读不到时返回那句说明，读到了返回空串。 */
export function worksKindGap(kind: WorksFilter, degraded: WorksDegraded | undefined | null): string {
  const source = worksKindSource(kind)
  if (!source) return ''
  return String(degraded?.[source] || '').trim()
}

/** 这次哪几个来源没读到：按固定顺序给，界面照着写，不自己排序。 */
export function worksSourceGaps(degraded: WorksDegraded | undefined | null): Array<{ source: WorksSource; label: string; message: string }> {
  const rows: Array<{ source: WorksSource; label: string; message: string }> = []
  for (const source of ['media', 'runs', 'canvas'] as const) {
    const message = String(degraded?.[source] || '').trim()
    if (message) rows.push({ source, label: WORKS_SOURCE_LABEL[source], message })
  }
  return rows
}

/**
 * 栏目胶囊上那个数字。
 * 读不到的那一栏没有数——写 0 会被当成「这一类是空的」，所以写「—」；
 * 「全部」也不写死数：漏了一处来源的总数不是总数。（返回空串表示这次还不显示数字。）
 */
export function worksChipCount(
  kind: WorksFilter,
  count: number,
  degraded: WorksDegraded | undefined | null,
  ready: boolean,
): string {
  if (!ready) return ''
  if (kind === 'all') return worksSourceGaps(degraded).length ? '—' : String(count)
  if (worksKindGap(kind, degraded)) return '—'
  return String(count)
}

/**
 * 这一栏该给哪一种空状态：
 * - 'unreadable'：这一栏的来源这次没读到——不能说「没有」，要给「重新读取」；
 * - 'filtered'：这一类真的没有，但别的栏目有东西；
 * - 'empty'：一条作品都没有。
 */
export function worksEmptyKind(
  kind: WorksFilter,
  counts: WorksCounts,
  degraded: WorksDegraded | undefined | null,
): 'unreadable' | 'filtered' | 'empty' {
  if (kind === 'all') {
    if (counts.all > 0) return 'filtered'
    return worksSourceGaps(degraded).length ? 'unreadable' : 'empty'
  }
  if (Number(counts[kind] || 0) > 0) return 'filtered'
  if (worksKindGap(kind, degraded)) return 'unreadable'
  return counts.all > 0 ? 'filtered' : 'empty'
}

