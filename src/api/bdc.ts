import { request } from './client'

export type BdcStatus = {
  web: { url: string; embedUrl?: string; up: boolean; status: number }
  admin: { url: string; up: boolean; status: number }
  api: { url: string; up: boolean; status: number }
  deployed: boolean
}

export const getBdcStatus = () => request<BdcStatus>('/api/bdc/status')
