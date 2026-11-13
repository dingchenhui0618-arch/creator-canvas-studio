/**
 * 「这个账号还什么都没有」——工作台新账号第一屏的唯一判据（v0.9.42）。
 *
 * 六个计数全都读到、并且都是 0 才算空。任何一路读失败都不许当 0：
 * 读失败时说「空」，等于把一次服务故障说成「你还没做过」，人会照着错的那一步走。
 * 引导那边是同一条规矩（不用 0 冒充未知），两处判断保持一致。
 */
export type FirstRunCounts = {
  projects: number
  canvases: number
  templates: number
  runs: number
  deliveries: number
  shares: number
}

/** 空的判定要逐路数：少一路（undefined）就不算空，别让漏读悄悄变成 0。 */
export const FIRST_RUN_KEYS = ['projects', 'canvases', 'templates', 'runs', 'deliveries', 'shares'] as const

export type FirstRunInput = {
  /** 六路计数；整体没读到、或少了一路，都给 null */
  counts: Partial<FirstRunCounts> | null
  /** 这一屏读失败的接口数：只要有一路失败就不算空 */
  failed?: number
}

export function isFirstRun(input: FirstRunInput | null | undefined): boolean {
  if (!input || !input.counts) return false
  if (Number(input.failed) > 0) return false
  return FIRST_RUN_KEYS.every((key) => Number(input.counts?.[key]) === 0)
}
