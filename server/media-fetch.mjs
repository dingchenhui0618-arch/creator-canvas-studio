// 上游返回文件的下载与类型归一：快捷创作（server/routes/media-gen.mjs）与
// 工作流出图节点（server/flow-image.mjs）共用一套，避免两处各写一份大小上限与 MIME 规则。
//
// 口径：
//  - 只接受 http(s) 地址或 data: URL，别的（file://、内网相对路径）一律拒绝；
//  - 边下边累计，超过上限立刻中止，不把几个 G 的响应读进内存；
//  - MIME 认不出时按扩展名猜，猜不出按 kind 的默认值（图片 png / 视频 mp4）。

const MAX_IMAGE_BYTES = 24 * 1024 * 1024
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 90 * 1000

export { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, DOWNLOAD_TIMEOUT_MS }

export function mimeFromExtension(url, kind) {
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

export function extensionFor(mime, kind, url) {
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

export function normalizeMime(mime, kind, url) {
  const type = String(mime || '').toLowerCase().split(';')[0]
  if (type.startsWith('image/') || type.startsWith('video/')) return type
  return mimeFromExtension(url, kind)
}

export function decodeDataUrl(url) {
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

/** 从上游任务回执里找视频地址：SeeAPI / 方舟 / 中转几种形状都认，找不到回空串。 */
export function extractVideoUrl(data) {
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

/** 上游进度：可能是 0~1 的小数，也可能是 0~100 的百分数；认不出回 null（不编一个假的）。 */
export function progressOf(data) {
  const raw = Number(data?.progress ?? data?.percent ?? data?.percentage)
  if (!Number.isFinite(raw)) return null
  const value = raw <= 1 ? raw * 100 : raw
  return Math.max(0, Math.min(100, Math.round(value)))
}

// 取回上游文件时的重试（r264）：2026-11-19 生产真调 seedance-2.0 4s/480p，
// 上游 275 秒出片成功，我们第一次下载直接 fetch failed（那台机器到 CDN 抖了一下），
// 结果把已经付过钱的视频判成失败并退款——用户白等五分钟。网络抖动该重试，不该一次就放弃。
const DOWNLOAD_RETRIES = 2
const DOWNLOAD_RETRY_GAP_MS = 1200

function errorCodeOf(error) {
  return String(error?.cause?.code || error?.code || '')
}

// 证书域名不符、证书过期这类是「上游 CDN 配错了」，重试多少次都一样，别把重试当遮羞布。
export function certProblem(error) {
  const code = errorCodeOf(error)
  if (/^ERR_TLS_CERT|CERT_|^DEPTH_ZERO|^UNABLE_TO_VERIFY|^SELF_SIGNED/i.test(code)) return true
  return /certificate|CERT_ALTNAME/i.test(String(error?.message || error || ''))
}

function transientDownloadError(error) {
  if (certProblem(error)) return false
  const raw = String(error?.message || error || '')
  const code = errorCodeOf(error)
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated|other side closed/i.test(raw)) return true
  if (/^ECONN|^ETIMEDOUT|^EAI_AGAIN|^UND_ERR_SOCKET|^UND_ERR_CONNECT/i.test(code)) return true
  const status = Number(error?.status || 0)
  return status === 408 || status === 429 || status >= 500
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function downloadAssetOnce(source, kind, maxBytes) {
  const response = await fetch(source, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!response.ok) {
    const error = new Error('下载上游文件失败：HTTP ' + response.status)
    error.status = response.status
    throw error
  }
  const declared = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('上游文件超过大小上限')
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > maxBytes) throw new Error('上游文件超过大小上限')
    chunks.push(Buffer.from(chunk))
  }
  return {
    buffer: Buffer.concat(chunks),
    mime: normalizeMime(response.headers.get('content-type'), kind, source),
  }
}

/**
 * 把上游给的地址变成字节 + 真实 MIME；data: 直接解，http(s) 边下边限流。
 * 网络类失败（连不上、连接被掐、超时、5xx/429）重试两次；「地址不对」「超大小」「404」
 * 这类确定性失败立刻抛，不浪费时间也不掩盖真因。
 */
export async function downloadAsset(url, kind) {
  const source = String(url || '')
  if (!source) throw new Error('上游没有返回' + (kind === 'image' ? '图片' : '视频') + '地址')
  const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
  if (source.startsWith('data:')) {
    const decoded = decodeDataUrl(source)
    if (decoded.buffer.length > maxBytes) throw new Error('上游返回的文件超过大小上限')
    return { buffer: decoded.buffer, mime: normalizeMime(decoded.mime, kind, '') }
  }
  if (!/^https?:\/\//i.test(source)) throw new Error('上游返回的文件地址不是 http(s)')
  let lastError = null
  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      const got = await downloadAssetOnce(source, kind, maxBytes)
      if (attempt > 0) got.attempts = attempt + 1
      return got
    } catch (error) {
      lastError = error
      if (!transientDownloadError(error) || attempt === DOWNLOAD_RETRIES) break
      await sleep(DOWNLOAD_RETRY_GAP_MS * (attempt + 1))
    }
  }
  // 2026-11-19 生产实测：SeeAPI 给的结果地址是 cdn.orangelight.com.cn，边缘证书却是
  // *.cdn.myqcloud.com —— fetch 直接 ERR_TLS_CERT_ALTNAME_INVALID，一句「fetch failed」看不出是上游的问题。
  const message = certProblem(lastError)
    ? '上游文件的下载地址证书对不上（上游 CDN 配置问题，不是你的操作）'
    : String(lastError?.message || lastError || '下载上游文件失败')
  const error = new Error(message)
  const cert = certProblem(lastError)
  // 试了几次：证书问题一次就停，网络问题把重试也算进去（用户与后台都要看到真实次数）
  error.attempts = cert ? 1 : DOWNLOAD_RETRIES + 1
  error.transient = transientDownloadError(lastError)
  error.cert = cert
  throw error
}
