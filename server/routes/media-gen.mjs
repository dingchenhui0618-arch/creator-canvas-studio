// 智能体页的两个窗口工具：生图 / 生视频。
//
// 与对话的区别：这里不是「把提示词交给模型聊两句」，而是一次真实生成任务：
//   1. 登录账号先按次扣积分（image_gen / video_gen，价格在 config.credits.prices）；
//   2. 服务端用平台 Key 池调 gateway（令牌不下发前端）；
//   3. 结果文件落到 DATA_DIR/media/<账号>/，下载只走带登录鉴权的接口；
//   4. 失败全额退款，退款按账本 outstandingCharge 判断，重复轮询不会多退。
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.mjs'
import { currentUser } from '../auth.mjs'
import { charge, outstandingCharge, refund } from '../credits.mjs'
import { createVideoTask, generateImage, pollVideoTask } from '../gateway.mjs'
import { logEvent } from '../log.mjs'
import { readBody, sendJson } from './_shared.mjs'

const IMAGE_MODEL = 'gpt-image-2'
// 用实测通过的那个型号：2026-11-17 生产只真调过 seedance-2.0（480p / 4 秒 / 16:9，177 秒出片）
const VIDEO_MODEL = 'seedance-2.0'
const IMAGE_RATIOS = {
  '1:1': { size: '1024x1024', label: '1:1 · 1024×1024' },
  '9:16': { size: '1024x1536', label: '9:16 · 1024×1536' },
  '16:9': { size: '1536x1024', label: '16:9 · 1536×1024' },
}
const VIDEO_DURATIONS = new Set([4, 8])
// SeeAPI/CGCM 的出视频接口强制要 aspect_ratio（缺了直接 400 validation_error），界面没给比例控件，默认竖屏
const VIDEO_RATIOS = new Set(['9:16', '16:9', '1:1'])
const VIDEO_RATIO_DEFAULT = '9:16'
const VIDEO_RESOLUTIONS = new Set(['480p', '720p'])
const MAX_PROMPT_CHARS = 1200
const MAX_IMAGE_BYTES = 24 * 1024 * 1024
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 90 * 1000
const ACCOUNT_LIMIT = 10
const ACCOUNT_WINDOW_MS = 60 * 1000
const TASK_PATH = /^\/api\/media\/tasks\/([A-Za-z0-9_-]{6,80})(\/file)?$/

const accountHits = new Map()

function rateLimited(userId) {
  const now = Date.now()
  const hits = (accountHits.get(userId) || []).filter((at) => now - at < ACCOUNT_WINDOW_MS)
  if (hits.length >= ACCOUNT_LIMIT) {
    return { retryAfterSec: Math.max(1, Math.ceil((hits[0] + ACCOUNT_WINDOW_MS - now) / 1000)) }
  }
  hits.push(now)
  accountHits.set(userId, hits)
  return null
}

/** 测试与本地重置用：清掉进程内的账号限流桶。 */
export function resetMediaGenRateLimit() {
  accountHits.clear()
}

function mediaRoot() {
  return path.join(config.dataDir, 'media')
}

function safeUserId(userId) {
  const raw = String(userId || '')
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  return safe || 'anonymous'
}

function taskMetaDir() {
  return path.join(mediaRoot(), 'tasks')
}

function taskMetaFile(id) {
  return path.join(taskMetaDir(), String(id) + '.json')
}

function userMediaDir(userId) {
  return path.join(mediaRoot(), safeUserId(userId))
}

function taskId() {
  return 'mgen_' + crypto.randomBytes(9).toString('base64url')
}

function nowIso() {
  return new Date().toISOString()
}

function clip(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function publicTask(task) {
  const credits = task.credits || {}
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    prompt: task.prompt,
    model: task.model,
    ratio: task.ratio || '',
    size: task.size || '',
    duration: task.duration || null,
    resolution: task.resolution || '',
    progress: Number.isFinite(Number(task.progress)) ? Math.max(0, Math.min(100, Number(task.progress))) : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt || null,
    error: task.error || '',
    file: task.file ? { mime: task.file.mime, bytes: task.file.bytes } : null,
    downloadUrl: task.file ? '/api/media/tasks/' + task.id + '/file' : '',
    credits: {
      cost: Number(credits.cost || 0),
      balance: typeof credits.balance === 'number' ? credits.balance : null,
      refunded: Boolean(credits.refunded),
      refundedAt: credits.refundedAt || null,
    },
  }
}

async function writeTask(task) {
  await fsp.mkdir(taskMetaDir(), { recursive: true, mode: 0o700 })
  const target = taskMetaFile(task.id)
  const tmp = target + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(task, null, 2), { mode: 0o600 })
  await fsp.rename(tmp, target)
}

async function readTask(id) {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(String(id || ''))) return null
  try {
    const parsed = JSON.parse(await fsp.readFile(taskMetaFile(id), 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.id ? parsed : null
  } catch {
    return null
  }
}

function newTask(userId, kind, input) {
  const at = nowIso()
  return {
    version: 1,
    id: taskId(),
    userId: String(userId),
    kind,
    status: 'processing',
    prompt: input.prompt,
    model: kind === 'image' ? IMAGE_MODEL : VIDEO_MODEL,
    ratio: input.ratio || '',
    size: input.size || '',
    duration: input.duration || null,
    resolution: input.resolution || '',
    progress: null,
    upstreamTaskId: '',
    file: null,
    error: '',
    warning: '',
    credits: null,
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
  }
}

function validationError(message, code = 'MEDIA_PARAMS') {
  return Object.assign(new Error(message), { status: 400, code })
}

function validateBody(body) {
  const kind = body?.kind
  if (kind !== 'image' && kind !== 'video') {
    throw validationError('kind 只能是 image 或 video', 'MEDIA_KIND')
  }
  if (typeof body.prompt !== 'string') {
    throw validationError('请填写提示词', 'MEDIA_PROMPT')
  }
  const prompt = body.prompt.trim()
  if (!prompt) throw validationError('请填写提示词', 'MEDIA_PROMPT')
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw validationError('提示词最多 ' + MAX_PROMPT_CHARS + ' 个字符', 'MEDIA_PROMPT_LONG')
  }
  if (kind === 'image') {
    const ratio = body.ratio === undefined ? '1:1' : String(body.ratio)
    const preset = IMAGE_RATIOS[ratio]
    if (!preset) throw validationError('比例只能是 1:1、9:16 或 16:9', 'MEDIA_RATIO')
    return { kind, prompt, ratio, size: preset.size }
  }
  const duration = body.duration === undefined ? 4 : Number(body.duration)
  if (!VIDEO_DURATIONS.has(duration)) {
    throw validationError('视频时长只能是 4 秒或 8 秒', 'MEDIA_DURATION')
  }
  const resolution = body.resolution === undefined ? '720p' : String(body.resolution)
  if (!VIDEO_RESOLUTIONS.has(resolution)) {
    throw validationError('分辨率只能是 480p 或 720p', 'MEDIA_RESOLUTION')
  }
  const ratio = body.ratio === undefined ? VIDEO_RATIO_DEFAULT : String(body.ratio)
  if (!VIDEO_RATIOS.has(ratio)) {
    throw validationError('视频比例只能是 9:16、16:9 或 1:1', 'MEDIA_RATIO')
  }
  return { kind, prompt, duration, resolution, ratio }
}

function mimeFromExtension(url, kind) {
  const match = String(url || '').match(/\.([A-Za-z0-9]{2,5})(?:[?#]|$)/)
  const ext = String(match?.[1] || '').toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mov') return 'video/quicktime'
  return kind === 'image' ? 'image/png' : 'video/mp4'
}

function extensionFor(mime, kind, url) {
  const type = String(mime || '').toLowerCase().split(';')[0]
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
  }
  return map[type] || mimeFromExtension(url, kind).split('/')[1] || (kind === 'image' ? 'png' : 'mp4')
}

function normalizeMime(mime, kind, url) {
  const type = String(mime || '').toLowerCase().split(';')[0]
  if (type.startsWith('image/') || type.startsWith('video/')) return type
  if (type === 'application/octet-stream') return mimeFromExtension(url, kind)
  return mimeFromExtension(url, kind)
}

function decodeDataUrl(url) {
  const match = String(url).match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i)
  if (!match) throw new Error('图片 data URL 格式不对')
  const mime = match[1] || 'image/png'
  const payload = match[3] || ''
  if (!match[2]) {
    const text = decodeURIComponent(payload)
    return { buffer: Buffer.from(text, 'utf8'), mime }
  }
  const buffer = Buffer.from(payload.replace(/\s+/g, ''), 'base64')
  return { buffer, mime }
}

async function downloadAsset(url, kind) {
  const source = String(url || '')
  if (!source) throw new Error('上游没有返回' + (kind === 'image' ? '图片' : '视频') + '地址')
  const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
  if (source.startsWith('data:')) {
    const decoded = decodeDataUrl(source)
    if (decoded.buffer.length > maxBytes) throw new Error('上游返回的文件超过大小上限')
    return { buffer: decoded.buffer, mime: normalizeMime(decoded.mime, kind, '') }
  }
  if (!/^https?:\/\//i.test(source)) throw new Error('上游返回的文件地址不是 http(s)')
  const response = await fetch(source, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error('下载上游文件失败：HTTP ' + response.status)
  const declared = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('上游文件超过大小上限')
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > maxBytes) {
      throw new Error('上游文件超过大小上限')
    }
    chunks.push(Buffer.from(chunk))
  }
  return {
    buffer: Buffer.concat(chunks),
    mime: normalizeMime(response.headers.get('content-type'), kind, source),
  }
}

async function saveResult(task, asset) {
  const ext = extensionFor(asset.mime, task.kind, '')
  const dir = userMediaDir(task.userId)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, task.id + '.' + ext)
  await fsp.writeFile(target, asset.buffer, { mode: 0o600 })
  return { mime: asset.mime, bytes: asset.buffer.length, ext }
}

function failureText(error) {
  const raw = clip(error?.message || error || '生成失败', 500)
  return raw || '生成失败'
}

async function settleFailure(task, message) {
  task.status = 'failed'
  task.error = clip(message || '生成失败', 500)
  task.finishedAt = nowIso()
  task.updatedAt = task.finishedAt
  const kind = task.kind === 'image' ? 'image_gen' : 'video_gen'
  try {
    const owed = outstandingCharge(task.userId, kind, task.id)
    if (owed > 0) {
      const result = refund(task.userId, kind, {
        ref: task.id,
        amount: owed,
        meta: { label: '失败退款 · ' + task.prompt.slice(0, 36) },
      })
      task.credits.refunded = result.cost > 0
      task.credits.refundedAt = task.credits.refunded ? nowIso() : null
    } else {
      // 账本里已经没有待退金额：要么已经退过，要么本来就没扣。
      task.credits.refunded = true
      task.credits.refundedAt = nowIso()
    }
  } catch (error) {
    task.credits.refunded = false
    task.credits.refundError = failureText(error)
    task.error = clip(task.error + '；退款未完成：' + failureText(error), 500)
  }
}

// 正在后台跑的出图任务：用来把「进程还活着、只是慢」和「进程没了、任务卡住」分开，
// 不然慢任务会被下面那条过期兜底误判成失败并退款，等一下又写回成功——等于白送一张图。
const runningImages = new Set()

// 过期兜底：进程重启会把后台出图带走，但元数据还留着 processing。
// 阈值必须比「上游超时 + 下载超时」更大，否则跑得好好的任务会被判死。
function imageStaleMs() {
  return Math.max(5 * 60 * 1000, Number(config.gateway.imageTimeoutMs) + DOWNLOAD_TIMEOUT_MS + 60 * 1000)
}

async function finishImageTask(user, task) {
  try {
    const result = await generateImage({
      model: IMAGE_MODEL,
      prompt: task.prompt,
      size: task.size,
      n: 1,
    })
    const url = Array.isArray(result?.urls) ? result.urls[0] : ''
    const asset = await downloadAsset(url, 'image')
    task.file = await saveResult(task, asset)
    task.status = 'succeeded'
    task.error = ''
    task.finishedAt = nowIso()
    task.updatedAt = task.finishedAt
  } catch (error) {
    await settleFailure(task, failureText(error))
  } finally {
    runningImages.delete(task.id)
  }
  await writeTask(task)
  logEvent('media.generate', {
    by: user.email,
    kind: 'image',
    id: task.id,
    status: task.status,
    cost: task.credits.cost,
    refunded: task.credits.refunded,
  })
}

/**
 * 出图：扣费 → 落一条 processing 的任务 → 立刻返回，真正的上游调用在后台跑完再写回结果。
 *
 * 为什么不挂在这次 HTTP 请求上（2026-11-18 生产事故）：gpt-image-2 慢的时候要两三分钟，
 * 那次正好卡在 120 秒上限被我们自己掐断，用户等了 2 分钟只拿到「连不上出图上游」。
 * 请求挂太久还有两个连带问题：关掉标签页/切后台就可能掐断，nginx 也随时会先断。
 * 改成后台跑之后，界面按任务号轮询（本来生视频就是这么做的），关掉窗口结果也还在。
 */
async function runImage(user, input) {
  const task = newTask(user.id, 'image', input)
  const paid = charge(user.id, 'image_gen', {
    ref: task.id,
    meta: { label: '生图 · ' + input.prompt.slice(0, 40) },
  })
  if (!paid.ok) return { paymentFailed: paid }
  task.credits = { cost: paid.cost, balance: paid.balance, refunded: false, refundedAt: null }
  await writeTask(task)
  runningImages.add(task.id)
  void finishImageTask(user, task).catch((error) => {
    runningImages.delete(task.id)
    logEvent('media.generate.error', { by: user.email, kind: 'image', id: task.id, error: failureText(error) })
  })
  return { task }
}

async function runVideo(user, input) {
  const task = newTask(user.id, 'video', input)
  const paid = charge(user.id, 'video_gen', {
    ref: task.id,
    meta: { label: '生视频 · ' + input.prompt.slice(0, 40) },
  })
  if (!paid.ok) return { paymentFailed: paid }
  task.credits = { cost: paid.cost, balance: paid.balance, refunded: false, refundedAt: null }
  try {
    await writeTask(task)
    const created = await createVideoTask({
      model: VIDEO_MODEL,
      prompt: input.prompt,
      duration: input.duration,
      resolution: input.resolution,
      // 上游强制要这个字段（缺了就是 400 validation_error），不传就等于每次都失败
      aspect_ratio: input.ratio,
    })
    task.upstreamTaskId = String(created?.id || '')
    if (!task.upstreamTaskId) throw new Error('上游没有返回视频任务 id')
    task.updatedAt = nowIso()
  } catch (error) {
    await settleFailure(task, failureText(error))
  }
  await writeTask(task)
  logEvent('media.generate', {
    by: user.email,
    kind: 'video',
    id: task.id,
    status: task.status,
    cost: task.credits.cost,
    refunded: task.credits.refunded,
  })
  return { task }
}

function extractVideoUrl(data) {
  const candidates = [
    data?.video_url,
    data?.videoUrl,
    data?.url,
    data?.output?.video_url,
    data?.output?.videoUrl,
    data?.output?.url,
    data?.content?.video_url,
    data?.content?.videoUrl,
    data?.data?.[0]?.url,
    data?.result?.video_url,
    data?.result?.videoUrl,
    data?.result?.url,
  ]
  return candidates.find((value) => typeof value === 'string' && /^(https?:\/\/|data:)/i.test(value)) || ''
}

function progressOf(data) {
  const raw = Number(data?.progress ?? data?.percent ?? data?.percentage)
  if (!Number.isFinite(raw)) return null
  const value = raw <= 1 ? raw * 100 : raw
  return Math.max(0, Math.min(100, Math.round(value)))
}

async function refreshVideo(task) {
  if (!task.upstreamTaskId) {
    await settleFailure(task, '视频任务没有上游 id，无法继续查询')
    return
  }
  let data
  try {
    data = await pollVideoTask(task.upstreamTaskId)
  } catch (error) {
    const code = String(error?.code || '')
    if (code === 'TASK_NOT_FOUND' || code === 'TASK_KEY_GONE') {
      await settleFailure(task, failureText(error))
      return
    }
    task.warning = '查询上游任务失败，稍后自动重试：' + failureText(error)
    return
  }
  const status = String(data?.status || '').toLowerCase()
  if (status === 'succeeded') {
    const url = extractVideoUrl(data)
    if (!url) {
      await settleFailure(task, '上游说任务成功，但没有返回视频地址')
      return
    }
    try {
      const asset = await downloadAsset(url, 'video')
      task.file = await saveResult(task, asset)
      task.status = 'succeeded'
      task.progress = 100
      task.finishedAt = nowIso()
      task.updatedAt = task.finishedAt
      task.warning = ''
    } catch (error) {
      await settleFailure(task, '上游已出片，但保存文件失败：' + failureText(error))
    }
    return
  }
  if (['failed', 'refunded', 'canceled'].includes(status)) {
    await settleFailure(task, String(data?.error?.message || '上游报告任务失败（' + status + '）'))
    return
  }
  const progress = progressOf(data)
  if (progress !== null) task.progress = progress
  task.warning = ''
  task.updatedAt = nowIso()
}

// 「最近生成」：把某个账号自己的任务按时间倒序列出来。
// 关掉窗口之后，结果文件还在 data/media/<账号>/，但任务号没人记得——所以必须有一份清单，
// 否则「生成了但没下载」就等于白花钱。这里只读任务元数据，不打上游、不扣积分。
const LIST_MAX = 24
const LIST_DEFAULT = 8
const LIST_SCAN = 240

// 往回翻：cursor 是上一页最后一条的 id，按它在排序后的位置往后取。
// 不拿 createdAt 比较：同毫秒创建的两条会被 `<` 漏掉，而 id 位置游标永远不重不漏。
// 清单先按 mtime 取最近 LIST_SCAN 份元数据再按 createdAt 排序——超出这个窗口的更早任务不算「没有更多」，
// 而是 capped=true，界面要照着这个说清楚，不能假装已经翻到底。
async function listTasks(userId, { kind = '', limit = LIST_DEFAULT, before = '' } = {}) {
  let names = []
  try {
    names = await fsp.readdir(taskMetaDir())
  } catch {
    return { tasks: [], hasMore: false, capped: false }
  }
  const candidates = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(taskMetaDir(), name)
    try {
      const stat = await fsp.stat(file)
      candidates.push({ name, at: stat.mtimeMs })
    } catch {
      // 文件刚被清理掉，跳过
    }
  }
  // 任务状态每次变化都会重写元数据，mtime 只能用来找「最近动过的」，排序仍按 createdAt
  candidates.sort((a, b) => b.at - a.at)
  const capped = candidates.length > LIST_SCAN
  const found = []
  for (const item of candidates.slice(0, LIST_SCAN)) {
    const task = await readTask(item.name.slice(0, -5))
    if (!task) continue
    if (String(task.userId) !== String(userId)) continue
    if (kind && task.kind !== kind) continue
    found.push(task)
  }
  found.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  let start = 0
  if (before) {
    const index = found.findIndex((task) => task.id === before)
    // 游标那一条已经不在窗口里（被删、或被挤出扫描范围）：这一页就是空的，不猜位置
    if (index < 0) return { tasks: [], hasMore: false, capped }
    start = index + 1
  }
  return { tasks: found.slice(start, start + limit).map(publicTask), hasMore: found.length > start + limit, capped }
}

async function handleGenerate(req, res, user) {
  const limit = rateLimited(user.id)
  if (limit) {
    res.setHeader('Retry-After', String(limit.retryAfterSec))
    sendJson(res, 429, {
      ok: false,
      error: '生成太频繁了，请 ' + limit.retryAfterSec + ' 秒后再试',
      code: 'MEDIA_RATE_LIMITED',
      retryAfterSec: limit.retryAfterSec,
    })
    return
  }
  const body = await readBody(req)
  const input = validateBody(body)
  const result = input.kind === 'image' ? await runImage(user, input) : await runVideo(user, input)
  if (result.paymentFailed) {
    const paid = result.paymentFailed
    sendJson(res, 402, {
      ok: false,
      error: paid.message || '积分不足：本次需要 ' + paid.cost + ' 积分，当前余额 ' + paid.balance + ' 积分',
      code: paid.code || 'CREDIT_INSUFFICIENT',
      balance: paid.balance,
      cost: paid.cost,
      needed: paid.needed,
    })
    return
  }
  sendJson(res, 200, { ok: true, task: publicTask(result.task) })
}

async function sendTaskFile(req, res, user, task) {
  if (!task.file || !task.file.ext) {
    sendJson(res, 404, { error: '这个任务还没有结果文件', code: 'MEDIA_FILE_MISSING' })
    return
  }
  const target = path.join(userMediaDir(task.userId), task.id + '.' + task.file.ext)
  let stat
  try {
    stat = await fsp.stat(target)
  } catch {
    sendJson(res, 404, { error: '结果文件不在了', code: 'MEDIA_FILE_MISSING' })
    return
  }
  const total = stat.size
  const range = String(req.headers?.range || '')
  const headers = {
    'Content-Type': task.file.mime || 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="visionqa-' + task.id + '.' + task.file.ext + '"',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  }
  let start = 0
  let end = total - 1
  let status = 200
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/)
    if (!match) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total })
      res.end()
      return
    }
    start = match[1] ? Number(match[1]) : 0
    end = match[2] ? Number(match[2]) : total - 1
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total })
      res.end()
      return
    }
    end = Math.min(end, total - 1)
    status = 206
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total
  }
  headers['Content-Length'] = String(Math.max(0, end - start + 1))
  res.writeHead(status, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(target, { start, end })
  try {
    for await (const chunk of stream) {
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once('drain', resolve))
      }
    }
    res.end()
  } catch {
    res.destroy?.()
  }
}

export function createMediaGenRouter() {
  return {
    prefix: '/api/media',
    async handle(req, res, url, pathname) {
      if (pathname === '/api/media/generate') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          sendJson(res, 405, { error: '只支持 POST' })
          return true
        }
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        try {
          await handleGenerate(req, res, user)
        } catch (error) {
          if (error?.status === 413) {
            sendJson(res, 413, { error: error.message, code: error.code || 'BODY_TOO_LARGE' })
            return true
          }
          if (error?.status === 400) {
            sendJson(res, 400, { error: error.message, code: error.code || 'MEDIA_PARAMS' })
            return true
          }
          logEvent('media.generate.error', { by: user.email, error: failureText(error) })
          sendJson(res, 500, { error: '生成任务没有建立，请稍后再试', code: 'MEDIA_INTERNAL' })
        }
        return true
      }

      if (pathname === '/api/media/tasks') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          sendJson(res, 405, { error: '只支持 GET' })
          return true
        }
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        const kind = String(url.searchParams.get('kind') || '').trim()
        if (kind && kind !== 'image' && kind !== 'video') {
          sendJson(res, 400, { error: 'kind 只能是 image 或 video', code: 'MEDIA_KIND' })
          return true
        }
        const raw = Number(url.searchParams.get('limit') || LIST_DEFAULT)
        const limit = Number.isFinite(raw) ? Math.max(1, Math.min(LIST_MAX, Math.trunc(raw))) : LIST_DEFAULT
        const beforeRaw = String(url.searchParams.get('before') || '').trim()
        if (beforeRaw && !/^[A-Za-z0-9_-]{6,80}$/.test(beforeRaw)) {
          sendJson(res, 400, { error: 'before 要是上一页最后一条的任务号', code: 'MEDIA_CURSOR' })
          return true
        }
        const before = beforeRaw
        const page = await listTasks(user.id, { kind, limit, before })
        sendJson(res, 200, { ok: true, kind, tasks: page.tasks, hasMore: page.hasMore, capped: page.capped })
        return true
      }

      const match = pathname.match(TASK_PATH)
      if (match) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('Allow', 'GET, HEAD')
          sendJson(res, 405, { error: '只支持 GET' })
          return true
        }
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        const task = await readTask(match[1])
        if (!task) {
          sendJson(res, 404, { error: '找不到这个生成任务', code: 'MEDIA_TASK_NOT_FOUND' })
          return true
        }
        if (task.userId !== user.id) {
          sendJson(res, 403, { error: '这个任务不属于当前账号', code: 'MEDIA_TASK_FORBIDDEN' })
          return true
        }
        if (match[2]) {
          await sendTaskFile(req, res, user, task)
          return true
        }
        let warning = ''
        if (task.status === 'processing' && task.kind === 'video') {
          await refreshVideo(task)
          warning = task.warning || ''
          task.warning = ''
          await writeTask(task)
        } else if (task.status === 'processing' && task.kind === 'image' && !runningImages.has(task.id)) {
          // 后台没人在跑这条任务，又久到超过「上游超时 + 下载超时」，只能是进程没了（重启/崩溃）
          const age = Date.now() - new Date(task.createdAt).getTime()
          if (age > imageStaleMs()) {
            await settleFailure(task, '生成进程中断，任务没有完成，积分已全额退回')
            await writeTask(task)
          }
        }
        sendJson(res, 200, { ok: true, task: publicTask(task), warning })
        return true
      }
      return false
    },
  }
}