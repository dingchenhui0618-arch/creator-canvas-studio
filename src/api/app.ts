// 当前部署的界面口径：生产只讲产品语言；内部测试环境（VQ_UI_MODE=internal）保留排障详情。
// 只影响展示，不参与权限判断；一次会话只请求一次，失败按生产口径兜底。
import { useEffect, useState } from 'react'
import { request } from './client'

export type UiMode = 'prod' | 'internal'

/** 公示信息（v0.9.67）：后台「系统 → 站点公示」填，环境变量兜底；没填就是空串。 */
export type SiteInfo = {
  icp: string
  operator: string
  address: string
  creditCode: string
  supportEmail: string
  complaint: string
  complete: boolean
}

export type AppInfo = {
  ok: boolean
  mode: UiMode
  internal: boolean
  version?: string
  icp?: string
  supportEmail?: string
  site?: SiteInfo
  /** 服务条款版本：注册时要把「同意的是哪一版」回传给服务端 */
  terms?: { version: string; updatedAt: string }
}

let cached: AppInfo | null = null
let pending: Promise<AppInfo> | null = null

function loadAppInfo(): Promise<AppInfo> {
  if (cached) return Promise.resolve(cached)
  if (!pending) {
    pending = request<AppInfo>('/api/app')
      .then((info) => {
        cached = info
        return info
      })
      .catch((error) => {
        pending = null
        throw error
      })
  }
  return pending
}

// 站点信息（备案号 / 客服邮箱）：登录页与页脚都要用，公开可读，失败按空处理。
export function useSiteInfo(): {
  icp: string
  supportEmail: string
  operator: string
  address: string
  creditCode: string
  complaint: string
  version: string
  termsVersion: string
  termsUpdatedAt: string
} {
  const [info, setInfo] = useState<AppInfo | null>(cached)
  useEffect(() => {
    if (info) return
    let alive = true
    void loadAppInfo()
      .then((next) => {
        if (alive) setInfo(next)
      })
      .catch(() => {
        if (alive) setInfo({ ok: false, mode: 'prod', internal: false })
      })
    return () => {
      alive = false
    }
  }, [info])
  const site = info?.site
  return {
    // 顶层字段仍以 icp / supportEmail 为准：老接口没有 site 对象时界面照样能显示
    icp: site?.icp || info?.icp || '',
    supportEmail: site?.supportEmail || info?.supportEmail || '',
    operator: site?.operator || '',
    address: site?.address || '',
    creditCode: site?.creditCode || '',
    complaint: site?.complaint || '',
    version: info?.version || '',
    termsVersion: info?.terms?.version || '',
    termsUpdatedAt: info?.terms?.updatedAt || '',
  }
}

export function useUiMode(): { mode: UiMode; internal: boolean; loading: boolean } {
  const [info, setInfo] = useState<AppInfo | null>(cached)

  useEffect(() => {
    if (info) return
    let alive = true
    void loadAppInfo()
      .then((next) => {
        if (alive) setInfo(next)
      })
      .catch(() => {
        if (alive) setInfo({ ok: false, mode: 'prod', internal: false })
      })
    return () => {
      alive = false
    }
  }, [info])

  return { mode: info?.mode ?? 'prod', internal: Boolean(info?.internal), loading: !info }
}
