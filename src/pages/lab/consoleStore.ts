import { useEffect, useSyncExternalStore } from 'react'

// 诊断日志：只收集页面挂载之后本浏览器里的 console.error / console.warn。
// 用模块级 store + useSyncExternalStore，避免在 effect 里同步 setState。
export type ConsoleEntry = {
  id: number
  level: 'error' | 'warn'
  at: string
  text: string
}

const MAX_ENTRIES = 20
let entries: ConsoleEntry[] = []
let sequence = 1
let installCount = 0
const listeners = new Set<() => void>()
const originals = { error: console.error, warn: console.warn }

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    return value.stack ? value.stack.split('\n').slice(0, 3).join(' ') : value.message
  }
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function record(level: ConsoleEntry['level'], args: unknown[]) {
  const text = args.map(formatArg).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600)
  if (!text) return
  entries = [...entries, { id: sequence++, level, at: new Date().toISOString(), text }].slice(-MAX_ENTRIES)
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return entries
}

export function clearConsoleEntries() {
  entries = []
  listeners.forEach((listener) => listener())
}

function install() {
  if (installCount === 0) {
    console.error = (...args: unknown[]) => {
      record('error', args)
      originals.error(...args)
    }
    console.warn = (...args: unknown[]) => {
      record('warn', args)
      originals.warn(...args)
    }
  }
  installCount += 1
  return () => {
    installCount -= 1
    if (installCount === 0) {
      console.error = originals.error
      console.warn = originals.warn
    }
  }
}

/** 在 Lab 页挂载时开始收集，卸载时恢复原始 console。 */
export function useConsoleCapture(): ConsoleEntry[] {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => install(), [])
  return snapshot
}
