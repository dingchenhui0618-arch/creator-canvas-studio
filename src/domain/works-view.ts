// 作品流的两个小口径（r266）：筛选项记在会话里、运行状态说人话。
//
// 为什么单独成文件：作品流会在「点开一条运行 / 一块画布」之后被重挂——
// 以前每次回到作品页筛选都退回「全部」，用户刚筛到「工作流」就又得再点一次。
// 同一个原因也解释了状态文案：这里只认服务端真有的四种终态，别的状态不乱猜。

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
