// 当前部署的界面口径：生产只讲产品语言；内部测试环境（VQ_UI_MODE=internal）保留排障详情。
// 只影响展示，不参与权限判断；一次会话只请求一次，失败按生产口径兜底。
import { useEffect, useState } from 'react'
import { request } from './client'

export type UiMode = 'prod' | 'internal'

export type AppInfo = {
  ok: boolean
  mode: UiMode
  internal: boolean
  version?: string
  icp?: string
  supportEmail?: string
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
  return {
    icp: info?.icp || '',
    supportEmail: info?.supportEmail || '',
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
