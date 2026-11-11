import { request } from './client'

export type CanvasSessionTicket = {
  ok: boolean
  token: string
  expiresAt: number
  issuer: string
  audience: string
}

/** 画布 iframe 要票据时才取：短时效、一次一换，不缓存到本地存储。 */
export const getCanvasSessionTicket = () => request<CanvasSessionTicket>('/api/canvas/session-token')
