// 账号自助：导出自己的全部数据、注销账号。两个动作都只作用于当前登录账号。
import { request } from './client'

export type AccountExport = {
  format: string
  formatVersion: number
  exportedAt: string
  account: { id: string; email: string; name: string; kind: string; credits: number }
  credits: { balance: number; ledger: unknown[] }
  templates: unknown[]
  flows: unknown[]
  agents: unknown[]
  reviews: unknown[]
}

/**
 * 导出：直接落盘一个 JSON 文件。
 * 走 fetch 而不是 <a href>，因为要带会话 cookie 并读出文件名；服务端返回的是附件。
 */
export async function downloadAccountExport(): Promise<{ name: string; bytes: number }> {
  const response = await fetch('/api/account/export', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
  if (!response.ok) {
    const text = await response.text()
    let message = '导出失败（HTTP ' + response.status + '）'
    try {
      const body = JSON.parse(text) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // 非 JSON 错误体就用默认文案
    }
    throw new Error(message)
  }
  const disposition = response.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="([^"]+)"/)
  const blob = await response.blob()
  const name = match?.[1] || 'visionqa-account-export.json'
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { name, bytes: blob.size }
}

export type DeleteAccountResult = {
  ok: boolean
  removed: { templates: number; flows: number; agents: number; reviews: number }
  deleteContent: boolean
}

export function deleteAccount(input: { password: string; confirm: string; deleteContent: boolean }): Promise<DeleteAccountResult> {
  return request<DeleteAccountResult>('/api/account/delete', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
