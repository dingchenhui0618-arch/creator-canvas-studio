// 原片音轨：复刻链路过去只听不看画面（vision.mjs 编口播），音轨一次都没读过。
// 这里用 ffmpeg 就地读一次音频流，拿到「有没有声音、停顿在哪、响度多高」这类**可测量的事实**，
// 不猜人声也不猜 BGM 曲名——测不出来的东西就标 unknown，别把推测写成结论。
//
// 为什么不先把音轨抽成文件：silencedetect / volumedetect 都能直接读视频里的音频流，
// 多落一个 wav 只是白占磁盘（复刻任务目录跑完就删）。等真接上 ASR 再抽，那时才有第二个消费者。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

const run = promisify(execFile)
const FFMPEG = ffmpegPath
const FFPROBE = ffprobeStatic.path

// 静音判定：-35dB 以下、持续 0.35 秒以上才算一个停顿。
// 口径取自实际素材：口播里的换气停顿多在 0.4~1.2 秒，短于 0.35 秒的多半是字间间隙，
// 全算进去会把「一句完整的话」切成十几段，反而不像停顿。
export const SILENCE_DB = -35
export const MIN_SILENCE_SEC = 0.35
// 响度起伏小于这个值 + 全程有声，才敢说「疑似一路铺底」：口播的自然起伏普遍在 10dB 以上
export const FLAT_RANGE_DB = 8
// 底噪占比低于 2% 视为全程有声
export const CONTINUOUS_GAP_RATIO = 0.02

const round1 = (value) => Math.round(value * 10) / 10
const round2 = (value) => Math.round(value * 100) / 100

/**
 * 从 ffmpeg + silencedetect 的 stderr 里解出静音段。
 * 最后一段静音常常没有 silence_end（片子以静音收尾），用总时长补齐，否则会丢掉结尾那段。
 */
export function parseSilence(stderr, durationSec = 0) {
  const text = String(stderr || '')
  const segments = []
  let open = null
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/)
    if (start) {
      open = { start: Math.max(0, Number(start[1]) || 0) }
      continue
    }
    const end = line.match(/silence_end:\s*(-?[\d.]+)/)
    if (end && open) {
      const endSec = Math.max(0, Number(end[1]) || 0)
      if (endSec > open.start) segments.push({ start: round2(open.start), end: round2(endSec) })
      open = null
    }
  }
  const total = Number(durationSec) || 0
  if (open && total > open.start) segments.push({ start: round2(open.start), end: round2(total) })
  segments.sort((a, b) => a.start - b.start)
  return segments.slice(0, 40)
}

/** volumedetect 的两行统计：平均响度与峰值。 */
export function parseVolume(stderr) {
  const text = String(stderr || '')
  const mean = text.match(/mean_volume:\s*(-?[\d.]+)\s*dB/i)
  const peak = text.match(/max_volume:\s*(-?[\d.]+)\s*dB/i)
  return {
    meanDb: mean ? Number(mean[1]) : null,
    peakDb: peak ? Number(peak[1]) : null,
  }
}

/** 把测出来的数字收成「能给人看、也能给模型当依据」的一组事实。纯函数，单测只测这一层。 */
export function classifyAudio({ durationSec = 0, segments = [], meanDb = null, peakDb = null } = {}) {
  const total = Number(durationSec) > 0 ? Number(durationSec) : 0
  const pauses = Array.isArray(segments) ? segments : []
  const silenceSec = round1(pauses.reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0))
  // 有声时长 = 总时长 − 停顿。**不是人声时长**：ffmpeg 测不出说话人，字段名别把人带沟里。
  const soundSec = round1(Math.max(0, total - silenceSec))
  const gapRatio = total > 0 ? silenceSec / total : 0
  const rangeDb = meanDb !== null && peakDb !== null ? round1(peakDb - meanDb) : null
  // 只说测得出来的事：这是一条**声音的连续性**判定，不是「有没有人声」。
  // 人声只能靠停顿去猜（口播有换气停顿、纯音乐没有），所以字段名不叫人声，界面文案也不许写「检测到人声」。
  const bed = gapRatio > 0.98
    ? 'silent'
    : (gapRatio < CONTINUOUS_GAP_RATIO
      ? (rangeDb !== null && rangeDb < FLAT_RANGE_DB ? 'continuous' : 'paused')
      : 'paused')
  const quiet = peakDb !== null && peakDb < -30
  const note = total > 0
    ? [
      '音轨 ' + round1(total) + ' 秒',
      bed === 'silent' ? '整条几乎没有声音' : (pauses.length ? (pauses.length + ' 处停顿共 ' + silenceSec + ' 秒') : '全程有声'),
      bed === 'continuous' ? '响度平缓（像一路铺底）' : '',
      quiet ? '音量很低（峰值 ' + peakDb + 'dB）' : '',
    ].filter(Boolean).join(' · ')
    : '音轨时长未知'
  return {
    hasTrack: true,
    durationSec: round1(total),
    soundSec,
    silenceSec,
    pauses: pauses.length,
    segments: pauses,
    meanDb,
    peakDb,
    rangeDb,
    bed,
    note,
  }
}

/** 没有音轨时的统一形状：字段全在，值为空，界面和模型都不用判空。 */
export function emptyAudio(reason = '原片没有音轨') {
  return {
    hasTrack: false,
    durationSec: 0,
    soundSec: 0,
    silenceSec: 0,
    pauses: 0,
    segments: [],
    meanDb: null,
    peakDb: null,
    rangeDb: null,
    bed: 'unknown',
    note: reason,
  }
}

/**
 * 就地读原片的音频流。没有音轨、解码失败都返回 emptyAudio，不抛：
 * 音轨只是复刻的佐证之一，缺了它不该让整条任务失败。
 */
export async function analyzeAudio(file, { durationSec = 0 } = {}) {
  const args = [
    '-hide_banner', '-nostdin', '-i', file,
    '-map', '0:a:0?', '-vn',
    '-af', 'silencedetect=noise=' + SILENCE_DB + 'dB:d=' + MIN_SILENCE_SEC + ',volumedetect',
    '-f', 'null', '-',
  ]
  let stderr = ''
  try {
    const result = await run(FFMPEG, args, { maxBuffer: 8 * 1024 * 1024 })
    stderr = String(result.stderr || '')
  } catch (error) {
    stderr = String(error?.stderr || '')
  }
  if (!/silence_start|mean_volume/i.test(stderr)) {
    // 没有音频流时 ffmpeg 会因为滤镜图拿不到输入而报错，所以这里再问一次 ffprobe，
    // 把「这片子本来就没音轨」和「有音轨但解不开」分开——复刻时要能说清是哪种。
    return emptyAudio(await hasAudioStream(file) ? '音轨读不出来（可能编码不受支持）' : '原片没有音轨')
  }
  const segments = parseSilence(stderr, durationSec)
  const { meanDb, peakDb } = parseVolume(stderr)
  const facts = classifyAudio({ durationSec, segments, meanDb, peakDb })
  // 全程有声但一句停顿都没有、时长还读到 0：说明探针没给时长，别硬算比例
  return facts
}

/** 原片到底有没有音频流：只在不走通滤镜图时问一次，不占正常路径。 */
export async function hasAudioStream(file) {
  try {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'json', file], { maxBuffer: 1024 * 1024 })
    return (JSON.parse(stdout).streams || []).length > 0
  } catch {
    return false
  }
}

/** 该段（按起止秒）落在原片静音里吗：分镜表靠它标「这段原片没人声」。 */
export function overlapsSilence(audio, startSec, endSec) {
  if (!audio?.hasTrack) return false
  const start = Number(startSec) || 0
  const end = Number(endSec) || 0
  if (!(end > start)) return false
  const gap = (audio.segments || []).reduce((sum, seg) => {
    const overlap = Math.min(end, seg.end) - Math.max(start, seg.start)
    return sum + (overlap > 0 ? overlap : 0)
  }, 0)
  // 这一段的多数时间都没声音，才算「这一段是留白」；擦边一帧不算
  return gap / (end - start) >= 0.5
}
