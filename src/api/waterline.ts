// 运行水位（v0.9.69）：只读。后台「系统 → 运行水位」用它，数字全部来自服务端真实读数。
import { request } from './client'

export type WaterlineLevel = 'ok' | 'tight' | 'critical'

export interface WaterlineReport {
  ok: boolean
  checkedAt: string
  level: WaterlineLevel
  reasons: string[]
  guard: boolean
  memory: {
    totalMb: number
    availableMb: number
    source: string
    swapTotalMb: number
    swapFreeMb: number
    swapUsedMb: number
  }
  heap: { rssMb: number; heapUsedMb: number; heapTotalMb: number; heapLimitMb: number; heapPercent: number }
  cpu: { cores: number; load1: number; load5: number; load15: number }
  thresholds: {
    guard: boolean
    tightAvailableMb: number
    criticalAvailableMb: number
    tightHeapPercent: number
    criticalHeapPercent: number
  }
  capacity: Record<string, number>
  baseCapacity: Record<string, number>
  retryAfterSec: number
  heavyKinds: string[]
}

export const getWaterline = () => request<WaterlineReport>('/api/admin/waterline')
