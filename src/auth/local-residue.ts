// 退出登录 / 换账号时，这台电脑上不该留下上一个账号的东西（v0.9.89）
//
// 起因：会话清干净了，但页面自己的缓存没清——智能体对话历史存在 localStorage
// （12 条，是真正的内容），上次打开的画布 id、雷达的检索词、三个列表的筛选词也各存一份。
// 共用一台电脑时，下一个账号打开智能体面板就能看到上一个人的对话。
//
// 清什么：
//   - 内容：对话历史、画布 id（别人的画布不该跟着下一个账号被打开）、检索词、筛选词
// 不清什么（这台机器的设置，不是谁的资料）：
//   - vq.model（模型偏好）、vq.edition（形态开关）、vq_welcome_seen:<账号>（引导看过没）
//
// 这里是纯函数（只吃两个 Storage 形状的对象），Node 里可以直接测，见 test/local-residue.test.mjs。
export interface ResidueStorage {
  getItem(key: string): string | null
  removeItem(key: string): void
  /** 遍历用；有些存储实现不提供，那就只清点名的键 */
  length?: number
  key?(index: number): string | null
}

/** 内容痕迹：点名的键 */
export const RESIDUE_LOCAL_KEYS: readonly string[] = ['vq:agents:history:v1', 'vq:bdcCanvas']
export const RESIDUE_SESSION_KEYS: readonly string[] = [
  'vq.radar.lastSearch.v1',
  'vq_projects_view:v1',
  'vq_templates_view:v1',
  'vq_runs_view:v1',
]
/** 前缀：历史键将来带版本号也能扫到 */
export const RESIDUE_PREFIXES: readonly string[] = ['vq:agents:history:']

function dropKeys(storage: ResidueStorage | null, keys: readonly string[], removed: string[]): void {
  if (!storage) return
  for (const key of keys) {
    try {
      if (storage.getItem(key) === null) continue
      storage.removeItem(key)
      removed.push(key)
    } catch {
      // 单个键删不掉不该拦住其它键
    }
  }
}

function dropPrefixes(storage: ResidueStorage | null, prefixes: readonly string[], removed: string[]): void {
  if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function') return
  const doomed: string[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (typeof key === 'string' && prefixes.some((prefix) => key.startsWith(prefix)) && !removed.includes(key)) doomed.push(key)
    }
  } catch {
    return
  }
  for (const key of doomed) {
    try {
      storage.removeItem(key)
      removed.push(key)
    } catch {
      // 同上
    }
  }
}

/**
 * 清掉这台电脑上属于上一个账号的痕迹，返回实际删掉的键（测试与日志都用得着）。
 * 传 null 表示那种存储用不了（隐私模式），跳过即可。
 */
export function clearLocalResidue(local: ResidueStorage | null, session: ResidueStorage | null): string[] {
  const removed: string[] = []
  dropKeys(local, RESIDUE_LOCAL_KEYS, removed)
  dropPrefixes(local, RESIDUE_PREFIXES, removed)
  dropKeys(session, RESIDUE_SESSION_KEYS, removed)
  return removed
}
