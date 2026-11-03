import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

const run = promisify(execFile)
const FFMPEG = ffmpegPath
const FFPROBE = ffprobeStatic.path

export async function probeVideo(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 8 * 1024 * 1024 })
  const info = JSON.parse(stdout)
  const video = (info.streams || []).find((s) => s.codec_type === 'video') || {}
  const duration = Number(info.format?.duration || video.duration || 0)
  const [num, den] = String(video.avg_frame_rate || '0/1').split('/').map(Number)
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    fps: den ? Math.round((num / den) * 100) / 100 : 0,
    codec: video.codec_name || '',
  }
}

export async function detectSceneCuts(file) {
  try {
    const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', file, '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 })
    const cuts = [...String(stderr).matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 100) / 100)
    return [...new Set(cuts)].sort((a, b) => a - b)
  } catch {
    return []
  }
}

export function planTimestamps(duration, cuts, maxFrames) {
  const safeDuration = Math.max(duration, 1)
  const count = Math.max(4, Math.min(maxFrames, Math.round(safeDuration / 2.2) || 4))
  const step = safeDuration / count
  const uniform = Array.from({ length: count }, (_, i) => Math.round((step * i + step / 2) * 100) / 100)
  const usefulCuts = cuts.filter((t) => t > 0.2 && t < safeDuration - 0.2)
  if (usefulCuts.length >= 3) {
    const merged = [...new Set([...usefulCuts.map((t) => Math.round((t + 0.15) * 100) / 100), ...uniform])].sort((a, b) => a - b)
    return merged.slice(0, maxFrames)
  }
  return uniform
}

export async function extractFrames(file, outDir, timestamps, onProgress) {
  await fsp.mkdir(outDir, { recursive: true })
  const frames = []
  for (let i = 0; i < timestamps.length; i += 1) {
    const t = timestamps[i]
    const name = 'frame-' + String(i + 1).padStart(2, '0') + '.jpg'
    const out = path.join(outDir, name)
    try {
      await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', out], { maxBuffer: 4 * 1024 * 1024 })
      const stat = await fsp.stat(out)
      if (stat.size > 500) frames.push({ index: i + 1, t, file: out, name })
    } catch {
      // 单帧失败不影响整体流程
    }
    onProgress?.((i + 1) / timestamps.length)
  }
  if (!frames.length) throw new Error('未能从视频中抽取到任何画面，请检查视频是否可解码')
  return frames
}
