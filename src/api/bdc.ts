import { request } from './client'

export type BdcStatus = {
  web: { url: string; embedUrl?: string; up: boolean; status: number }
  admin: { url: string; up: boolean; status: number }
  api: { url: string; up: boolean; status: number }
  deployed: boolean
  /** 积分口径（v0.9.162）：无限画布嵌进来时按它标价，主体是服务端配置 VQ_POINTS_PER_CNY */
  credit?: { unit: string; pointsPerCny: number }
}

export type BdcCanvas = {
  id: string
  name: string
  nodeCount: number
  revision: number
  updatedAt: number
}

export const getBdcStatus = () => request<BdcStatus>('/api/bdc/status')

// 无限画布数据打通：它自己的 JSON 存在它那边，这里只经服务端代理读写
export const listBdcCanvases = () =>
  request<{ ok: boolean; canvases: BdcCanvas[]; error?: string }>('/api/bdc/canvases')

// 认领画布（r214）：无限画布的 workspace 是全局的，第一次从 #/board/<id> 打开时把它记到这个账号名下，
// 作品流只列自己认领的画布。已有主人时服务端返回 mine:false，不抢也不报错。
export const claimBdcCanvas = (canvasId: string) =>
  request<{ ok: boolean; mine: boolean; ownerId: string; claimed: boolean }>('/api/bdc/canvases/claim', {
    method: 'POST',
    body: JSON.stringify({ canvasId }),
  })

export const createBdcCanvas = (name: string) =>
  request<{ ok: boolean; canvas: BdcCanvas }>('/api/bdc/canvases', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })

export const writeBdcNote = (canvasId: string, text: string, title?: string) =>
  request<{ ok: boolean; canvasId: string; nodeId: string; revision: number }>('/api/bdc/canvases/note', {
    method: 'POST',
    body: JSON.stringify({ canvasId, text, title }),
  })
