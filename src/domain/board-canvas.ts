// 无限画布状态条其实只回答一件事：你现在在哪块画布上。
// r273：以前画布列表读不到时，这里会说「暂无已保存的画布」，并且把上次打开的那块从本地记忆里抹掉——
// 一次接口抖动被说成「你还没有画布」，画布 iframe 还会退回它自己的默认内容，用户看到的是别人的画布。
// 这一份纯函数把三种情况分开，界面照结果说话：
//   ① 读到了         → 按链接点名 / 上次打开 / 列表第一块依次落
//   ② 读不到         → 保留上次那块，给「重试」，不猜「你没有」
//   ③ 读到了但不在了 → 链接点名的整页说明（missing）；上次打开的就明说一句再落到别的画布（stale）
// 判据只吃纯数据，单测守在这里：test/board-canvas.test.mjs

/** 无限画布服务 /api/canvas/list 里的一行（只用到展示需要的几项）。 */
export type BoardCanvasRow = {
  id: string
  name: string
  nodeCount: number
  revision: number
  updatedAt: number
}

export type CanvasListRead =
  | { state: 'ok' }
  | { state: 'failed'; message: string }

/** 服务端连一句中文都没给时的兜底：说清「读不到」，并指出下一步是重试，不是「你还没有画布」。 */
export const CANVAS_LIST_FALLBACK = '无限画布列表没读到；作品、模板、评审、交付都不受影响，点「重试」再读一次。'

/** 抛出物可能是 Error、字符串、或是别的对象：只认「一句人话」，认不出就空串交给兜底，不写 [object Object]。 */
function textOf(value: unknown): string {
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return String((value as { message: string }).message).trim()
  }
  if (typeof value === 'string') return value.trim()
  return ''
}

/**
 * 把一次读取结果折成两种状态。
 * 两种失败都要认：HTTP 层抛错（reason），以及 200 但 ok:false（服务端已经把英文翻成中文，别再套一层）。
 */
export function canvasListRead(
  result: { ok?: boolean; error?: string } | null | undefined,
  reason?: unknown,
): CanvasListRead {
  if (reason !== undefined && reason !== null) {
    const text = textOf(reason)
    return { state: 'failed', message: text || CANVAS_LIST_FALLBACK }
  }
  if (result && result.ok === false) {
    const text = String(result.error || '').trim()
    return { state: 'failed', message: text || CANVAS_LIST_FALLBACK }
  }
  // 连一次回答都没有（没结果也没错误）：也不能算读到了
  if (!result) return { state: 'failed', message: CANVAS_LIST_FALLBACK }
  return { state: 'ok' }
}

export type CanvasChoice = {
  /** 现在该打开哪块画布；空串表示还没得选（还没画布，或列表读不到且没有记忆） */
  canvasId: string
  /** 地址里点名的那块画布不在了：整页说明，不往下翻 */
  missing: boolean
  /** 上次打开的那块不在了（不是链接点名的）：落到别的画布上，但不许悄悄换 */
  stale: boolean
}

/**
 * 该打开哪块画布。
 * 读不到列表时唯一不能做的事就是「猜」：既不能猜成没有画布（清掉记忆），
 * 也不能猜成列表第一块（那是别人的画布）。有记忆就照记忆打开。
 */
export function resolveBoardCanvas(input: {
  boardId?: string
  remembered: string
  listed: readonly BoardCanvasRow[]
  read: CanvasListRead
}): CanvasChoice {
  const { boardId, remembered, listed, read } = input
  const first = listed[0]?.id || ''
  if (read.state === 'failed') {
    return { canvasId: boardId || remembered, missing: false, stale: false }
  }
  const wanted = boardId || remembered
  const has = (id: string) => listed.some((item) => item.id === id)
  if (wanted && has(wanted)) return { canvasId: wanted, missing: false, stale: false }
  if (!wanted) return { canvasId: first, missing: false, stale: false }
  // 链接点名的那块没了：画布页的整页说明（「这块无限画布不在了」），不悄悄换成别的
  if (boardId) return { canvasId: first, missing: true, stale: false }
  // 上次打开的那块没了：换成列表第一块是唯一能走的路，但要说出来
  return { canvasId: first, missing: false, stale: true }
}

/**
 * 状态条上那一条提醒；一次只说一句。
 * stale 的「换成了哪块」要说出名字——说不出名字就说明白「现在没有别的画布」，
 * 而不是写一个「已打开」的假话。
 */
export function canvasNotice(input: {
  read: CanvasListRead
  choice: { stale: boolean; canvasId: string }
  listed: readonly BoardCanvasRow[]
}): string {
  if (input.read.state === 'failed') return input.read.message
  if (!input.choice.stale) return ''
  const next = input.listed.find((item) => item.id === input.choice.canvasId)
  if (next) return '上次那块画布不在了，已先打开「' + next.name + '」'
  return '上次那块画布不在了，这个账号下现在没有别的画布'
}

/** 画布选择器上的名字：列表读不到时不编一个名字，说清「名字没读到」。 */
export function boardCanvasLabel(input: {
  read: CanvasListRead
  canvases: readonly BoardCanvasRow[]
  canvasId: string
}): string {
  if (input.read.state === 'failed') {
    return input.canvasId ? '上次那块画布（名字没读到）' : '画布列表没读到'
  }
  const current = input.canvases.find((item) => item.id === input.canvasId)
  if (current) return current.name + ' · ' + current.nodeCount + ' 节点'
  return input.canvases.length ? '未指定（默认画布）' : '暂无已保存的画布'
}
