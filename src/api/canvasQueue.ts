import { request } from './client'

// 画布出图的排队位（v0.9.83）：只读。画布页的状态条每几秒问一次——
// 「现在几条在跑、几条在排队、最久的等了多久」以前只有后台看得到，画布上什么也没有。
export type CanvasQueueView = {
  ok: boolean
  at: string
  kind: string
  level: 'ok' | 'tight' | 'critical'
  /** 整机正在出图的张数（共享租约口径，两个实例同一个数） */
  active: number
  /** 这一类的整机上限；0 表示没配这一层 */
  limit: number
  /** 还能再放几张 */
  slots: number
  /** 现在几条在排队 */
  waiting: number
  /** 最久的那条等了多久（毫秒） */
  oldestWaitMs: number
  /** 每条最多等多久；0 表示没开排队（名额满时立刻拒） */
  waitMs: number
  /** 最多几条同时排着 */
  maxWaiting: number
  /** 排队位满了：这时候新来的请求会被立刻拒 */
  full: boolean
  /** 排队明细：第几位、等了多久（不含票号） */
  queue: { position: number; waitedMs: number }[]
  /** 在跑几条是整机口径（lease）还是退回进程内计数（process） */
  scope: string
  /** 排队位是本进程的还是整机的（现在恒为 process：两个实例各排各的） */
  queueScope: string
  counts: {
    entered: number
    served: number
    timedOut: number
    full: number
    abandoned: number
    maxWaitMs: number
  }
}

export const getCanvasQueue = () => request<CanvasQueueView>('/api/canvas/queue')
