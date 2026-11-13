// 评审发模型前先缩图（v0.9.74）。
//
// 为什么：评审把图片转成 base64 data URL 交给模型，一张图在 V8 堆里至少占三份
// （8 MB Buffer → 约 10.7 MB base64 字符串 → JSON 请求体里又一份）。第 84 轮压测量到：
// 8 MB × 3 并发 = 110 MB 堆（27%）、8 MB × 10 并发 = 332 MB（81%）、17.9 MB × 10 = FATAL OOM。
// 堆占用跟「送出去多少字节」成正比，跟像素多少无关——所以最省力的止血点在发模型之前。
//
// 做法：超过阈值的图先缩到长边 1600px 的 JPEG 再送。缩完一般只有原图的两三个百分点，
// 模型的 bbox 证据用的是 0..1 相对坐标，尺寸变了不用换算。
//
// 三条边界：
//   1) 只做「能缩就缩」：ffprobe / ffmpeg 缺一块、超时、输出没变小，都原样返回原图，
//      评审不会因为缩图失败而失败（这一层不该变成新的单点）；
//   2) 只缩图片：类型不在 jpg/png/webp 里就跳过；像素超过 40 MP 也跳过——
//      8 MB 的 JPEG 可以是 1 亿像素，让 ffmpeg 去解它等于换一种方式打内存；
//   3) 结果按内容哈希缓存：同一张模板首帧反复评审只跑一次 ffmpeg。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { config } from './config.mjs'

const run = promisify(execFile)
const FFMPEG = ffmpegPath
const FFPROBE = ffprobeStatic.path
const MB = 1024 * 1024

// 默认值：1600px 长边 / 超过 1.5 MB 才动 / 4000 万像素封顶。
// 1600px 是「模型看得清 + base64 只有几百 KB」的折中；需要更清晰时可以调大，代价是堆。
export const REVIEW_SCALE_DEFAULTS = {
  maxEdge: 1600,
  minBytes: 1536 * 1024,
  maxPixels: 40 * 1000 * 1000,
  quality: 4,
  timeoutMs: 20000,
  maxCacheFiles: 200,
  cacheMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
}

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/** 等比例缩到长边不超过 maxEdge；不放大。纯函数，测试不依赖 ffmpeg。 */
export function fitInside(width, height, maxEdge) {
  const w = Math.max(0, Math.round(Number(width) || 0))
  const h = Math.max(0, Math.round(Number(height) || 0))
  const edge = Number(maxEdge) || 0
  if (!w || !h) return null
  if (edge <= 0) return { width: w, height: h }
  const factor = Math.min(1, edge / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * factor)), height: Math.max(1, Math.round(h * factor)) }
}

/**
 * 该不该缩、缩成多大。纯函数（不碰文件），判定顺序即优先级：
 * 空字节 → 像素过多 → 超过长边（缩）→ 没超长边但字节大（重压）→ 不动。
 */
export function planReviewImage({ bytes, width, height, maxEdge = REVIEW_SCALE_DEFAULTS.maxEdge, minBytes = REVIEW_SCALE_DEFAULTS.minBytes, maxPixels = REVIEW_SCALE_DEFAULTS.maxPixels } = {}) {
  const size = Math.max(0, Number(bytes) || 0)
  if (!size) return { scale: false, reason: 'EMPTY', target: null }
  const w = Math.max(0, Number(width) || 0)
  const h = Math.max(0, Number(height) || 0)
  const pixels = w && h ? w * h : 0
  if (pixels && pixels > maxPixels) return { scale: false, reason: 'TOO_MANY_PIXELS', target: null, pixels }
  const target = fitInside(w, h, maxEdge)
  if (target && (target.width < w || target.height < h)) {
    return { scale: true, reason: 'DOWNSCALE', target, pixels }
  }
  // 已经在框内却还很大：多半是 PNG 截图，重压成 JPEG 能把字节砍掉一个量级
  if (size > minBytes) return { scale: true, reason: 'RECOMPRESS', target, pixels }
  return { scale: false, reason: 'SMALL_ENOUGH', target, pixels }
}

function resolveOptions(overrides = {}) {
  const raw = config.reviewImage || {}
  const num = (value, fallback) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return {
    maxEdge: num(overrides.maxEdge ?? raw.maxEdge, REVIEW_SCALE_DEFAULTS.maxEdge),
    minBytes: num(overrides.minBytes ?? raw.minBytes, REVIEW_SCALE_DEFAULTS.minBytes),
    maxPixels: num(overrides.maxPixels ?? raw.maxPixels, REVIEW_SCALE_DEFAULTS.maxPixels),
    quality: num(overrides.quality ?? raw.quality, REVIEW_SCALE_DEFAULTS.quality),
    timeoutMs: num(overrides.timeoutMs ?? raw.timeoutMs, REVIEW_SCALE_DEFAULTS.timeoutMs),
    maxCacheFiles: num(overrides.maxCacheFiles, REVIEW_SCALE_DEFAULTS.maxCacheFiles),
    cacheMaxAgeMs: num(overrides.cacheMaxAgeMs, REVIEW_SCALE_DEFAULTS.cacheMaxAgeMs),
    dir: overrides.dir || raw.dir || path.join(config.dataDir, 'cache', 'review-images'),
    log: overrides.log || null,
  }
}

async function probeDims(file) {
  try {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { timeout: 10000, maxBuffer: 1024 * 1024 })
    const stream = (JSON.parse(stdout).streams || [])[0] || {}
    const width = Number(stream.width) || 0
    const height = Number(stream.height) || 0
    return width && height ? { width, height } : null
  } catch {
    return null
  }
}

function scaleFilter(maxEdge) {
  // force_original_aspect_ratio=decrease + min() 两个方向各封一次：不放大、不裁切
  return "scale=w='min(iw," + maxEdge + ")':h='min(ih," + maxEdge + ")':force_original_aspect_ratio=decrease:flags=lanczos"
}

async function readMeta(file) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    const meta = JSON.parse(text)
    return meta && typeof meta === 'object' ? meta : null
  } catch {
    return null
  }
}

/** 缓存目录别无限长：过期文件先删，再按数量封顶（删最旧的）。纯磁盘操作，失败不影响评审。 */
export async function sweepReviewCache(dir, { maxCacheFiles = REVIEW_SCALE_DEFAULTS.maxCacheFiles, cacheMaxAgeMs = REVIEW_SCALE_DEFAULTS.cacheMaxAgeMs, now = Date.now() } = {}) {
  try {
    const names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.jpg') || name.endsWith('.json'))
    if (!names.length) return { removed: 0 }
    const rows = []
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        const stat = await fsp.stat(file)
        rows.push({ file, at: stat.mtimeMs, name })
      } catch {
        // 刚被别的请求删掉
      }
    }
    let removed = 0
    for (const row of rows) {
      if (now - row.at > cacheMaxAgeMs) {
        await fsp.rm(row.file, { force: true })
        removed += 1
      }
    }
    const left = rows.filter((row) => now - row.at <= cacheMaxAgeMs)
    if (left.length > maxCacheFiles) {
      left.sort((a, b) => a.at - b.at)
      for (const row of left.slice(0, left.length - maxCacheFiles)) {
        await fsp.rm(row.file, { force: true })
        removed += 1
      }
    }
    return { removed }
  } catch {
    return { removed: 0 }
  }
}

/**
 * 把要送模型的图片压到长边 maxEdge 的 JPEG。
 *
 * 永远返回可用字节：失败就原样返回（report.applied=false + reason），调用方不需要写 try/catch。
 * report 里带 originalBytes / sentBytes，后台与日志可以直接看到「这次省了多少」。
 */
export async function compressForReview(bytes, mime = 'image/jpeg', overrides = {}) {
  const opt = resolveOptions(overrides)
  const input = bytes && bytes.length ? bytes : null
  const originalBytes = input ? input.length : 0
  const base = {
    applied: false,
    cached: false,
    originalBytes,
    sentBytes: originalBytes,
    maxEdge: opt.maxEdge,
    quality: opt.quality,
    reason: '',
  }
  if (!input) return { bytes: bytes || Buffer.alloc(0), mime, report: { ...base, reason: 'EMPTY' } }
  if (!(opt.maxEdge > 0) || opt.minBytes < 0) return { bytes: input, mime, report: { ...base, reason: 'DISABLED' } }
  const ext = MIME_EXT[String(mime || '').toLowerCase().split(';')[0].trim()]
  if (!ext) return { bytes: input, mime, report: { ...base, reason: 'NOT_IMAGE' } }
  // 小图连 ffprobe 都不用起：base64 最多两 MB，10 条并发也只有二十来 MB。
  // 这一条让复刻（480px 帧图，几十 KB）完全不受缩图层影响——不 spawn、不落盘、不读哈希。
  if (input.length <= opt.minBytes) return { bytes: input, mime, report: { ...base, reason: 'SMALL_ENOUGH' } }

  const key = crypto.createHash('sha256').update(input).digest('hex').slice(0, 32) + '-' + opt.maxEdge + '-q' + opt.quality
  const outFile = path.join(opt.dir, key + '.jpg')
  const metaFile = path.join(opt.dir, key + '.json')
  // 源文件必须换个后缀：输入是 jpg 时 key + '.jpg' 会和输出同一个路径，
  // 缩完写进去、finally 再删掉，缓存永远打不中（跑测试时踩到过）
  const srcFile = path.join(opt.dir, key + '.src.' + ext)
  try {
    const cached = await readMeta(metaFile)
    if (cached && cached.originalBytes === originalBytes) {
      const data = await fsp.readFile(outFile)
      if (data.length) {
        return { bytes: data, mime: 'image/jpeg', report: { ...base, ...cached, applied: true, cached: true, sentBytes: data.length, reason: 'CACHED' } }
      }
    }
  } catch {
    // 没缓存或缓存坏了：重新缩
  }

  try {
    await fsp.mkdir(opt.dir, { recursive: true })
    await fsp.writeFile(srcFile, input)
    const dims = await probeDims(srcFile)
    const plan = planReviewImage({ bytes: originalBytes, width: dims?.width, height: dims?.height, maxEdge: opt.maxEdge, minBytes: opt.minBytes, maxPixels: opt.maxPixels })
    if (!plan.scale) {
      return { bytes: input, mime, report: { ...base, reason: dims ? plan.reason : 'PROBE_FAILED', originalWidth: dims?.width || 0, originalHeight: dims?.height || 0 } }
    }
    await run(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-threads', '1',
      '-i', srcFile,
      '-map_metadata', '-1', '-an', '-sn', '-dn',
      '-vf', scaleFilter(opt.maxEdge),
      '-frames:v', '1', '-q:v', String(opt.quality),
      outFile,
    ], { timeout: opt.timeoutMs, maxBuffer: 4 * MB })
    const out = await fsp.readFile(outFile)
    if (!out.length) throw new Error('缩图输出为空')
    if (out.length >= originalBytes) {
      await fsp.rm(outFile, { force: true })
      return { bytes: input, mime, report: { ...base, reason: 'NOT_SMALLER', originalWidth: dims?.width || 0, originalHeight: dims?.height || 0 } }
    }
    const report = {
      ...base,
      applied: true,
      sentBytes: out.length,
      originalWidth: dims?.width || 0,
      originalHeight: dims?.height || 0,
      width: plan.target?.width || 0,
      height: plan.target?.height || 0,
      reason: plan.reason,
    }
    await fsp.writeFile(metaFile, JSON.stringify(report))
    // 缓存清扫不阻塞这一单：写失败也只是下次再缩一遍
    void sweepReviewCache(opt.dir, { maxCacheFiles: opt.maxCacheFiles, cacheMaxAgeMs: opt.cacheMaxAgeMs }).catch(() => {})
    opt.log?.('评审图已压缩：' + originalBytes + ' 字节 → ' + out.length + ' 字节（' + report.originalWidth + 'x' + report.originalHeight + ' → ' + report.width + 'x' + report.height + '）')
    return { bytes: out, mime: 'image/jpeg', report }
  } catch (error) {
    await fsp.rm(srcFile, { force: true }).catch(() => {})
    opt.log?.('缩图失败，按原图送审：' + String(error?.message || error).slice(0, 120))
    return { bytes: input, mime, report: { ...base, reason: 'SCALE_FAILED', detail: String(error?.message || error).slice(0, 120) } }
  } finally {
    await fsp.rm(srcFile, { force: true }).catch(() => {})
  }
}
