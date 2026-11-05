import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'

// 远端算力：把「解析 → 下载 → 探测 → 抽帧」交给另一个进程/服务，本地不碰 ffmpeg。
// 契约见 docs/remote-compute.md；默认实现是 worker/video-worker.mjs，也可以换成云厂商的媒体处理 API。
export async function replicateRemote({ url, maxFrames, jobDir, log }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.remote.timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(config.remote.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.remote.token ? { Authorization: 'Bearer ' + config.remote.token } : {}),
      },
      body: JSON.stringify({ url, maxFrames }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error('远端算力 HTTP ' + response.status + '：' + text.slice(0, 160))
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error('远端算力返回的不是 JSON')
    }
    if (!payload?.ok || !Array.isArray(payload.frames) || !payload.frames.length) {
      throw new Error('远端算力没有返回帧：' + String(payload?.error || 'empty'))
    }
    const frameDir = path.join(jobDir, 'frames')
    await fsp.mkdir(frameDir, { recursive: true })
    const frames = []
    for (let i = 0; i < payload.frames.length; i += 1) {
      const item = payload.frames[i]
      const name = 'frame-' + String(i + 1).padStart(2, '0') + '.jpg'
      const file = path.join(frameDir, name)
      await fsp.writeFile(file, Buffer.from(String(item.base64 || ''), 'base64'))
      frames.push({ index: i + 1, t: Number(item.t) || 0, file, name })
    }
    log?.('远端算力 ' + (config.remote.label || 'worker') + ' 返回 ' + frames.length + ' 帧（' + ((Date.now() - started) / 1000).toFixed(1) + 's）')
    return {
      meta: payload.meta || {},
      sceneCuts: Array.isArray(payload.cuts) ? payload.cuts : [],
      frames,
      provider: payload.provider || config.remote.label || 'remote',
    }
  } finally {
    clearTimeout(timer)
  }
}
