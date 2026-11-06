import { request } from './client'

export type BdcStatus = {
  web: { url: string; embedUrl?: string; up: boolean; status: number }
  admin: { url: string; up: boolean; status: number }
  api: { url: string; up: boolean; status: number }
  deployed: boolean
}

export type BdcCanvas = {
  id: string
  name: string
  nodeCount: number
  revision: number
  updatedAt: number
}

export const getBdcStatus = () => request<BdcStatus>('/api/bdc/status')

// 画布数据打通：画布自己的 JSON 存在它那边，这里只经服务端代理读写
export const listBdcCanvases = () =>
  request<{ ok: boolean; canvases: BdcCanvas[]; error?: string }>('/api/bdc/canvases')

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
