// 桌面端桥接：Electron 通过 preload 暴露的唯一入口。
// 网页版没有这个对象，所以界面必须能优雅地说明「这里只在桌面端可用」，
// 不能假装有本地能力。
export type DesktopInfo = {
  version: string
  platform: string
  mode: 'local' | 'remote'
  url: string
  workspace: string
  loop: { maxSteps: number; maxToolOutput: number }
  compaction: {
    contextTokens: number
    thresholdPercent: number
    retainTokens: number
    summaryMaxChars: number
    summaryMaxTokens: number
    minSummarized: number
    maxKept: number
  }
}

export type ThreadMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** 模型自己的协议 JSON：留在上下文里给模型看，界面上不重复显示 */
  protocol?: boolean
  /** 拒绝执行之类的系统提示，不是用户说的话 */
  note?: boolean
  tool?: { name: string; args?: Record<string, unknown>; ok?: boolean; output?: string }
}

export type LocalThread = {
  id: string
  title: string
  summary: string
  messages: ThreadMessage[]
  turns: number
  compactions: number
  createdAt: string
  updatedAt: string
}

export type LocalThreadSummary = {
  id: string
  title: string
  updatedAt: string
  turns: number
  messages: number
  compactions: number
}

export type DesktopEvent =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; steps?: number; stoppedByLimit?: boolean; elapsedMs?: number }
  | {
      type: 'tool'
      phase: 'call' | 'done' | 'denied'
      tool: string
      args?: Record<string, unknown>
      why?: string
      ok?: boolean
      output?: string
      needsApproval?: boolean
    }
  | { type: 'approval'; id: string; tool: string; args?: Record<string, unknown>; why?: string; step?: number }
  | {
      type: 'compact'
      phase: 'start' | 'done' | 'failed'
      tokens?: number
      budget?: number
      summarized?: number
      removed?: number
      kept?: number
      summary?: string
      tokensBefore?: number
      tokensAfter?: number
    }
  | { type: 'note'; text: string }
  /** 一轮结束且已存盘：界面据此刷新会话列表 */
  | { type: 'turn-end' }
  | { type: 'error'; message: string; detail?: string; steps?: number }
  | { type: 'aborted'; steps?: number }

export type DesktopBridge = {
  info: () => Promise<DesktopInfo>
  workspace: {
    get: () => Promise<string>
    choose: () => Promise<string>
  }
  agent: {
    listThreads: () => Promise<LocalThreadSummary[]>
    createThread: () => Promise<LocalThread>
    getThread: (id: string) => Promise<LocalThread>
    deleteThread: (id: string) => Promise<boolean>
    send: (threadId: string, text: string) => Promise<{ ok: boolean; error?: string; steps?: number }>
    abort: () => Promise<{ ok: boolean }>
    approve: (id: string, allow: boolean) => Promise<{ ok: boolean; error?: string }>
    onEvent: (handler: (payload: { threadId: string; event: DesktopEvent }) => void) => () => void
  }
}

declare global {
  interface Window {
    visionqaDesktop?: DesktopBridge
  }
}

export function getDesktop(): DesktopBridge | null {
  if (typeof window === 'undefined') return null
  return window.visionqaDesktop ?? null
}