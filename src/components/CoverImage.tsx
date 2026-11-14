import { useState, type ReactNode } from 'react'

/**
 * 卡片封面（v0.9.90）：抓不到就把位置交给卡片自己的占位文案，而不是在网格里留一个破图。
 *
 * 为什么现在需要它：/api/cover 以前是纯透传，任何响应都是一张图或一个空白；
 * 现在它会说「抓太多」（429）与「整机正在抓的太多」（503），浏览器碰到这两种响应
 * 只会画一个空框——所以失败必须自己接住，卡片上留一句说得出话的说明。
 *
 * 记的是「哪一张失败了」而不是一个布尔：同一张卡换了一条内容（筛选后重排）时，
 * src 变了就自然不再算失败，不用再写一个 effect 去复位。
 */
export function CoverImage({
  src,
  alt = '',
  fallback,
}: {
  src: string
  alt?: string
  fallback: (failed: boolean) => ReactNode
}) {
  const [failedSrc, setFailedSrc] = useState('')
  const failed = Boolean(src) && failedSrc === src
  if (!src || failed) return <>{fallback(failed)}</>
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailedSrc(src)} />
}
