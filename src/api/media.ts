import { request } from './client'

/**
 * 自己传一张图（v0.9.87）：评审页「挑一张画面」那一栏的第一入口。
 * 传上来的图落在自己的账号目录下，评审时用 media 路径（与模板帧同一套写法），
 * 所以服务端评审那条链路一个字都不用改。
 */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024
export const UPLOAD_MAX_FILES = 20
// 只收这三种：与 server/uploads.mjs 的 SIGNATURES 一一对应
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export type MediaUsage = { files: number; bytes: number; maxFiles: number; maxBytes: number; maxTotalBytes: number }

export type UploadedMedia = {
  ok: true
  /** 相对数据目录的路径：uploads/<账号>/<文件名>，直接当评审的 media 用 */
  media: string
  /** 浏览器里能直接显示的地址：/media/uploads/<账号>/<文件名>（要登录，只能读自己的） */
  imageUrl: string
  bytes: number
  mime: string
  /** 顶掉了几张旧图（到 20 张上限时才会大于 0） */
  replaced: number
  usage: MediaUsage
}

/** 传之前先在本机拦一次：8 MB 的请求体不必先发出去再被拒。返回空串表示可以传。 */
export function uploadRejection(file: File): string {
  const size = Number(file?.size) || 0
  if (!size) return '这个文件是空的：换一张图再试'
  if (size > UPLOAD_MAX_BYTES) {
    const mb = Math.round((size / 1024 / 1024) * 10) / 10
    return '这张图 ' + mb + ' MB，超过 8 MB 上限：先压一下再传'
  }
  // 浏览器不给类型（有些拖拽来源会这样）时交给服务端按文件头判断，不在这里猜
  const type = String(file?.type || '').toLowerCase()
  if (type && !UPLOAD_TYPES.includes(type)) {
    return '只接受 jpg / png / webp：这个文件是 ' + type + '，先另存成这三种之一'
  }
  return ''
}

export function uploadReviewImage(file: File): Promise<UploadedMedia> {
  return request<UploadedMedia>('/api/media/upload', {
    method: 'POST',
    // 不写 JSON：请求体就是文件本身（服务端按文件头认类型，不信这个头）
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
}

export type UploadedItem = { name: string; media: string; imageUrl: string; bytes: number; at: string }

/** 最近传的几张：刷新页面后还能拿回刚传那张，不用重传。 */
export function listUploads(limit = 8): Promise<{ ok: true; items: UploadedItem[]; usage: MediaUsage }> {
  return request('/api/media/uploads?limit=' + Math.max(1, Math.round(limit)))
}
