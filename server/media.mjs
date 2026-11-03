import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { resolveVideoUrl } from './redfox.mjs'

const DIRECT_MEDIA = /\.(mp4|m4v|mov|webm)(\?|#|$)/i

async function downloadToFile(url, target, onProgress) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
      Referer: 'https://www.douyin.com/',
    },
    redirect: 'follow',
  })
  if (!response.ok) throw new Error('视频下载失败：HTTP ' + response.status)
  const total = Number(response.headers.get('content-length') || 0)
  const limit = config.limits.maxVideoMb * 1024 * 1024
  if (total && total > limit) throw new Error('视频超过 ' + config.limits.maxVideoMb + 'MB 限制')
  const chunks = []
  let received = 0
  for await (const chunk of response.body) {
    received += chunk.length
    if (received > limit) throw new Error('视频超过 ' + config.limits.maxVideoMb + 'MB 限制')
    chunks.push(chunk)
    if (onProgress && total) onProgress(Math.min(0.99, received / total))
  }
  await fsp.writeFile(target, Buffer.concat(chunks))
  return received
}

export async function acquireVideo({ url, platform }, jobDir, onProgress) {
  await fsp.mkdir(jobDir, { recursive: true })
  const target = path.join(jobDir, 'source.mp4')
  let resolvedFrom = 'direct'

  if (DIRECT_MEDIA.test(url)) {
    await downloadToFile(url, target, onProgress)
    return { file: target, resolvedFrom, resolvedUrl: url }
  }

  const resolved = await resolveVideoUrl(platform, url)
  resolvedFrom = 'redfox-parse'
  await downloadToFile(resolved.downloadUrl, target, onProgress)
  return { file: target, resolvedFrom, resolvedUrl: resolved.downloadUrl, remoteTitle: resolved.title, remoteCover: resolved.cover }
}

export function openVideoStream(file) {
  return fs.createReadStream(file)
}
