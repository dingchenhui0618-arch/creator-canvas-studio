// 读文件的真实元信息（r229）：浏览器最清楚宽高与时长，服务端不解析媒体容器。
//
// 这段原来只在快捷创作页里，作品流的「用作参考」也要它——两处复制一份，
// 迟早一边改了另一边忘掉，所以抽到 domain。
export type MediaProbe = { width: number | null; height: number | null; duration: number | null }

const EMPTY: MediaProbe = { width: null, height: null, duration: null }

export async function probeMediaFile(file: File): Promise<MediaProbe> {
  if (typeof document === 'undefined') return EMPTY
  const url = URL.createObjectURL(file)
  try {
    if (file.type.startsWith('video/')) {
      return await new Promise<MediaProbe>((resolve) => {
        const video = document.createElement('video')
        video.preload = 'metadata'
        video.onloadedmetadata = () =>
          resolve({
            width: video.videoWidth || null,
            height: video.videoHeight || null,
            duration: Number.isFinite(video.duration) ? video.duration : null,
          })
        video.onerror = () => resolve(EMPTY)
        video.src = url
      })
    }
    if (file.type.startsWith('image/')) {
      return await new Promise<MediaProbe>((resolve) => {
        const image = new Image()
        image.onload = () =>
          resolve({ width: image.naturalWidth || null, height: image.naturalHeight || null, duration: null })
        image.onerror = () => resolve(EMPTY)
        image.src = url
      })
    }
    return EMPTY
  } finally {
    URL.revokeObjectURL(url)
  }
}
