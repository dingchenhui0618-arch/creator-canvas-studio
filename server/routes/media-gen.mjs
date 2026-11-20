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
import { createVideoTask, generateImage, generateImageEdit, pollVideoTask } from '../gateway.mjs'
import { logEvent } from '../log.mjs'
import { ASSET_LIMITS, assetUsage, listMediaAssets, locateMediaAsset, readMediaAsset, removeMediaAsset, saveMediaAsset } from '../media-assets.mjs'
import { listMediaModels, resolveSelection } from '../media-models.mjs'
import { DOWNLOAD_TIMEOUT_MS, downloadAsset, extensionFor, extractVideoUrl, progressOf } from '../media-fetch.mjs'
import { readBinaryBody } from '../body-reader.mjs'
import { readBody, sendJson } from './_shared.mjs'

// 出图 / 出视频能选哪些模型、每个模型什么规格，全在 server/media-models.mjs：
// 那里是唯一真源，这里不再写死后备模型名（以前 IMAGE_MODEL / VIDEO_MODEL 是两份常量）。
const MAX_PROMPT_CHARS = 1200
const ACCOUNT_LIMIT = 10
const ACCOUNT_WINDOW_MS = 60 * 1000
const TASK_PATH = /^\/api\/media\/tasks\/([A-Za-z0-9_-]{6,80})(\/file)?$/
const ASSET_PATH = /^\/api\/media\/assets\/([A-Za-z0-9_-]{6,80})(\/file)?$/

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
    mode: task.mode || '',
    ratio: task.ratio || '',
    size: task.size || '',
    duration: task.duration || null,
    resolution: task.resolution || '',
    // 参考素材只回形状与大小，不回文件内容，也不暴露磁盘路径
    assets: (Array.isArray(task.assets) ? task.assets : []).map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.name || '',
      bytes: Number(asset.bytes) || 0,
      width: asset.width || null,
      height: asset.height || null,
      duration: asset.duration || null,
    })),
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
    model: input.model,
    mode: input.mode || '',
    ratio: input.ratio || '',
    size: input.size || '',
    duration: input.duration || null,
    resolution: input.resolution || '',
    assets: (input.assets || []).map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.name || '',
      mime: asset.mime || '',
      bytes: Number(asset.bytes) || 0,
      width: asset.width || null,
      height: asset.height || null,
      duration: asset.duration || null,
    })),
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

// 参考素材给上游时要用扩展名：按服务端认出来的 mime 定，不用客户端给的文件名。
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

/**
 * 一次生成请求要做的事：把界面选的模型 / 生成方式 / 参数收敛（server/media-models.mjs），
 * 再把参考素材按账号读出来（只认自己的），最后按生成方式校验「图几张、视频几段」。
 *
 * 为什么要在这里读素材而不是让前端把文件塞进 JSON：8 MB 的图 base64 之后就是 11 MB，
 * JSON 请求体上限只有 8 MB（server/body-reader.mjs），而且把文件当字符串过一遍内存纯属浪费。
 */
async function prepareInput(user, body) {
  if (typeof body?.prompt !== 'string') throw validationError('请填写提示词', 'MEDIA_PROMPT')
  const prompt = body.prompt.trim()
  if (!prompt) throw validationError('请填写提示词', 'MEDIA_PROMPT')
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw validationError('提示词最多 ' + MAX_PROMPT_CHARS + ' 个字符', 'MEDIA_PROMPT_LONG')
  }
  const selection = resolveSelection({ ...body, prompt })
  const assets = []
  for (const id of selection.assetIds) {
    const found = await readMediaAsset(user.id, id)
    if (!found) {
      throw validationError('这个参考素材不在了（或不属于当前账号），请重新上传一次', 'MEDIA_ASSET_MISSING')
    }
    const meta = found.meta
    assets.push({
      id: meta.id,
      kind: meta.kind,
      name: meta.name,
      mime: meta.mime,
      ext: MIME_EXT[meta.mime] || (meta.kind === 'video' ? 'mp4' : 'png'),
      bytes: Number(meta.bytes) || found.buffer.length,
      width: meta.width || null,
      height: meta.height || null,
      duration: meta.duration || null,
      buffer: found.buffer,
    })
  }
  const images = assets.filter((asset) => asset.kind === 'image')
  const videos = assets.filter((asset) => asset.kind === 'video')
  const mode = selection.modeSpec
  if (images.length > (mode.imageRefs || 0)) {
    throw validationError('「' + mode.label + '」最多 ' + mode.imageRefs + ' 张参考图', 'MEDIA_ASSETS_TOO_MANY')
  }
  if (videos.length > (mode.videoRefs || 0)) {
    throw validationError('「' + mode.label + '」最多 ' + mode.videoRefs + ' 段参考视频', 'MEDIA_ASSETS_TOO_MANY')
  }
  if (mode.maxRefs === 0 && assets.length) {
    throw validationError('「' + mode.label + '」不接受参考素材', 'MEDIA_ASSETS_UNEXPECTED')
  }
  return { ...selection, prompt, assets }
}

/**
 * 界面上的三种方式 → SeeAPI 建任务正文里的 mode。
 * 映射来自无限画布 generation_seedance.py：seedance-2.0 只带图 → image2video，图和视频混着 → mixed2video。
 * 纯文本不传 mode（这条路径是 2026-11-17 起真调通过的，不在这轮改动它）。
 */
function upstreamVideoMode(input) {
  const images = input.assets.filter((asset) => asset.kind === 'image').length
  const videos = input.assets.filter((asset) => asset.kind === 'video').length
  if (!images && !videos) return ''
  if (String(input.model).startsWith('seedance-2.0') && images && !videos) return 'image2video'
  return 'mixed2video'
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

// 参考图的字节只在这一次任务里用一次：不写进任务元数据（那是磁盘上的明文清单），跑完就丢。
// 进程重启后这条任务会被过期兜底判失败并退款，不会出现「素材没了还在跑」的中间态。
const imageRefs = new Map()

// 过期兜底：进程重启会把后台出图带走，但元数据还留着 processing。
// 阈值必须比「上游超时 + 下载超时」更大，否则跑得好好的任务会被判死。
function imageStaleMs() {
  return Math.max(5 * 60 * 1000, Number(config.gateway.imageTimeoutMs) + DOWNLOAD_TIMEOUT_MS + 60 * 1000)
}

async function finishImageTask(user, task) {
  try {
    // 有参考图就走 /images/edits（multipart），没有就走原来的 /images/generations
    const reference = imageRefs.get(task.id)
    const result = reference
      ? await generateImageEdit({
          model: task.model,
          prompt: task.prompt,
          size: task.size,
          image: reference.buffer,
          mime: reference.mime,
          filename: reference.filename,
        })
      : await generateImage({
          model: task.model,
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
    imageRefs.delete(task.id)
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
  // 价格按「这次选的模型」算（media-models 里给的 credits），不再写死 image_gen 的全局价
  const paid = charge(user.id, 'image_gen', {
    ref: task.id,
    amount: input.credits,
    meta: { label: '生图 · ' + input.model + ' · ' + input.prompt.slice(0, 36) },
  })
  if (!paid.ok) return { paymentFailed: paid }
  task.credits = { cost: paid.cost, balance: paid.balance, refunded: false, refundedAt: null }
  const reference = input.assets.find((asset) => asset.kind === 'image')
  if (reference) {
    imageRefs.set(task.id, { buffer: reference.buffer, mime: reference.mime, filename: 'reference.' + reference.ext })
  }
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
    amount: input.credits,
    meta: { label: '生视频 · ' + input.model + ' · ' + input.prompt.slice(0, 36) },
  })
  if (!paid.ok) return { paymentFailed: paid }
  task.credits = { cost: paid.cost, balance: paid.balance, refunded: false, refundedAt: null }
  const mode = upstreamVideoMode(input)
  try {
    await writeTask(task)
    const created = await createVideoTask({
      model: input.model,
      prompt: input.prompt,
      duration: input.duration,
      resolution: input.resolution,
      // 上游强制要这个字段（缺了就是 400 validation_error），不传就等于每次都失败
      aspect_ratio: input.ratio,
      // 参考素材先传到上游换 asset://，再由 gateway 拼 reference_image_urls / reference_video_urls
      referenceAssets: input.assets.map((asset) => ({
        kind: asset.kind,
        mime: asset.mime,
        ext: asset.ext,
        bytes: asset.buffer,
      })),
      ...(mode ? { mode } : {}),
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
      // 取回文件失败要说得清楚（r264）：上游已经出片（钱花掉了），我们这边拿回来时网络抖了。
      // 已重试过就是「重试也没拿回来」，这时候全额退回积分并让用户再点一次，而不是留一句英文原始错误。
      const tries = Number(error?.attempts || 1)
      const detail = failureText(error)
      const head = error?.cert
        ? '上游已出片，但它给的下载地址证书对不上（上游 CDN 配置问题，不是你的操作）'
        : '上游已出片，但取回文件失败（试了 ' + tries + ' 次）'
      await settleFailure(
        task,
        error?.cert
          ? head + '：这次已全额退回积分，请稍后再生成一次'
          : head + '：这次已全额退回积分，稍后重新生成一次；' + detail,
      )
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

/**
 * 删掉一条生成记录：元数据与结果文件一起删，删完这条就不在「最近生成」和作品流里了。
 *
 * 三条规矩（都是「宁可拒」）：
 *  1) 还在跑的不删：上游可能已经接单，删了元数据就再也没人对得上这笔账（等它收敛再删）；
 *  2) 只删自己那条：归属判断与读任务走同一套（userId 不一致直接 403，不猜）；
 *  3) 不退款、也不算回额度：删除不是「这单不算」，它只是把记录与文件清掉，积分已经花掉了。
 *
 * 返回值里的 freedBytes 是真实释放的字节数（文件本来就不在就是 0，不编数字）。
 */
async function removeTask(task) {
  let freed = 0
  if (task.file && task.file.ext) {
    const target = path.join(userMediaDir(task.userId), task.id + '.' + task.file.ext)
    try {
      freed = (await fsp.stat(target)).size
    } catch {
      freed = 0
    }
    await fsp.rm(target, { force: true })
  }
  await fsp.rm(taskMetaFile(task.id), { force: true })
  return { freed }
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
  const input = await prepareInput(user, body)
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

/**
 * 预览参考素材：图片几百 KB、视频几十 MB，按 Range 发，别一次读进内存。
 * 只给归属账号本人（locateMediaAsset 已经按账号找过），不公开、不进分享页。
 */
async function sendAssetFile(req, res, found) {
  const total = found.size
  const range = String(req.headers?.range || '')
  const headers = {
    'Content-Type': found.meta.mime || 'application/octet-stream',
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
  const stream = fs.createReadStream(found.file, { start, end })
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

      // 生成模型清单：界面下拉照这张表画，前端不再自己写一份模型名与规格
      if (pathname === '/api/media/models') {
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
        sendJson(res, 200, { ok: true, ...listMediaModels() })
        return true
      }

      // 参考素材：POST 原始字节上传（不是 JSON：8 MB 的图 base64 之后就是 11 MB，超过 JSON 上限）
      if (pathname === '/api/media/assets') {
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        if (req.method === 'GET') {
          const limit = Number(url.searchParams.get('limit') || 30)
          sendJson(res, 200, {
            ok: true,
            assets: await listMediaAssets(user.id, limit),
            usage: await assetUsage(user.id),
            limits: { imageBytes: ASSET_LIMITS.imageBytes, videoBytes: ASSET_LIMITS.videoBytes },
          })
          return true
        }
        if (req.method === 'POST') {
          try {
            const buffer = await readBinaryBody(req, { maxBytes: ASSET_LIMITS.videoBytes })
            const saved = await saveMediaAsset({
              userId: user.id,
              buffer,
              name: url.searchParams.get('name') || '',
              width: url.searchParams.get('width'),
              height: url.searchParams.get('height'),
              duration: url.searchParams.get('duration'),
            })
            logEvent('media.asset', { by: user.email, id: saved.id, kind: saved.kind, bytes: saved.bytes })
            sendJson(res, 200, { ok: true, asset: saved })
            return true
          } catch (error) {
            if (error?.status === 413) {
              sendJson(res, 413, { error: error.message, code: error.code || 'ASSET_TOO_LARGE' })
              return true
            }
            if (error?.status === 415 || error?.status === 400) {
              sendJson(res, error.status, { error: error.message, code: error.code || 'ASSET_PARAMS' })
              return true
            }
            throw error
          }
        }
        res.setHeader('Allow', 'GET, POST')
        sendJson(res, 405, { error: '只支持 GET / POST' })
        return true
      }

      const assetMatch = pathname.match(ASSET_PATH)
      if (assetMatch) {
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        if (req.method === 'DELETE' && !assetMatch[2]) {
          const removed = await removeMediaAsset(user.id, assetMatch[1])
          if (!removed) {
            sendJson(res, 404, { error: '找不到这个素材', code: 'ASSET_NOT_FOUND' })
            return true
          }
          sendJson(res, 200, { ok: true })
          return true
        }
        if ((req.method === 'GET' || req.method === 'HEAD') && assetMatch[2]) {
          const found = await locateMediaAsset(user.id, assetMatch[1])
          if (!found) {
            sendJson(res, 404, { error: '找不到这个素材', code: 'ASSET_NOT_FOUND' })
            return true
          }
          await sendAssetFile(req, res, found)
          return true
        }
        res.setHeader('Allow', assetMatch[2] ? 'GET, HEAD' : 'DELETE')
        sendJson(res, 405, { error: '不支持这个方法' })
        return true
      }

      const match = pathname.match(TASK_PATH)
      if (match) {
        const method = String(req.method || '').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
          res.setHeader('Allow', 'GET, HEAD, DELETE')
          sendJson(res, 405, { error: '只支持 GET / DELETE' })
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
        if (method === 'DELETE') {
          // 只删整条记录：/file 是下载地址，DELETE 它没有意义，也不该被当成「删文件」
          if (match[2]) {
            res.setHeader('Allow', 'GET, HEAD')
            sendJson(res, 405, { error: '下载地址不能删：要删就删这条任务' })
            return true
          }
          if (task.status === 'processing') {
            sendJson(res, 409, {
              error: '这条还在生成：等它跑完（或失败退款）再删，删了就对不上这笔账了',
              code: 'MEDIA_TASK_RUNNING',
            })
            return true
          }
          const { freed } = await removeTask(task)
          logEvent('media.task.delete', { by: user.email, id: task.id, kind: task.kind, freedBytes: freed })
          sendJson(res, 200, { ok: true, id: task.id, freedBytes: freed })
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