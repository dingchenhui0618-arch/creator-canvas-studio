// 本地功能开关：只写 localStorage，key 统一前缀 vq.flag.
// 当前没有任何现有模块读取这些 key（见 FlagsSection 的「仅记录，尚未接线」），
// 这里先把读写函数固定下来，后续接线时只认这一份约定。
export const FLAG_PREFIX = 'vq.flag.'

export type LabFlagId = 'review-service-first' | 'canvas-auto-save' | 'mock-search-fallback'

export const LAB_FLAG_IDS: LabFlagId[] = ['review-service-first', 'canvas-auto-save', 'mock-search-fallback']

export function flagKey(id: LabFlagId): string {
  return FLAG_PREFIX + id
}

export function readLabFlag(id: LabFlagId): boolean {
  try {
    return window.localStorage.getItem(flagKey(id)) === '1'
  } catch {
    return false
  }
}

export function writeLabFlag(id: LabFlagId, enabled: boolean): void {
  try {
    window.localStorage.setItem(flagKey(id), enabled ? '1' : '0')
  } catch {
    // 隐私模式或配额满时开关无法持久化，UI 会如实提示。
  }
}

export function readAllLabFlags(): Record<LabFlagId, boolean> {
  return {
    'review-service-first': readLabFlag('review-service-first'),
    'canvas-auto-save': readLabFlag('canvas-auto-save'),
    'mock-search-fallback': readLabFlag('mock-search-fallback'),
  }
}
