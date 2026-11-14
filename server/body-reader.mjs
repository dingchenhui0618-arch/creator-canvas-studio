// 请求体读取：以前是无上限地把整个 body 读进内存再 JSON.parse。
//
// 一个 100 MB 的请求体在这种进程里就是一次 OOM：384 MB 的 V8 堆，Buffer、UTF-16 字符串、
// 解析出来的对象各占一份。这条路不是假想：压测里 10 个并发评审就把堆顶到 384 MB，
// 进程 FATAL OOM 直接退出，所有人的会话一起断（见 docs/load-test-2026-11-14.md）。
//
// 所以整个服务只有一条规矩：JSON 请求体 ≤ 8 MB，超了在读满之前就拒。
// 要传更大的内容请走文件上传（/api/media/upload，v0.9.87 起真有这条），不要塞进 JSON。
// 需要更大的入口显式传 maxBytes —— 显式写在调用处，比一个全局大数字更难被忘掉。

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024

const MB = 1024 * 1024
const human = (bytes) => (bytes >= MB ? Math.round((bytes / MB) * 10) / 10 + ' MB' : Math.round(bytes / 1024) + ' KB')

function tooLarge(size, maxBytes) {
  const error = new Error('请求体 ' + human(size) + ' 超过了 ' + human(maxBytes) + ' 的上限：大文件请走文件上传，不要塞进 JSON')
  error.status = 413
  error.code = 'BODY_TOO_LARGE'
  return error
}

/**
 * 读一个 JSON 请求体。三道闸，从便宜到贵：
 *   1) content-length 声明就超了：一个字节都不读，直接拒；
 *   2) 读到一半超了：不再往数组里拼（内存不再涨），把剩下的流读完再拒，客户端才能收到 413；
 *   3) 已经超过 4 倍：断连接。到这一步这客户端不是在传 JSON，是在灌数据。
 */
export async function readJsonBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const declared = Number(req?.headers?.['content-length'] || 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(declared, maxBytes)
  const chunks = []
  let total = 0
  let overflow = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) {
      overflow = total
      if (total > maxBytes * 4) {
        req.destroy?.()
        throw tooLarge(total, maxBytes)
      }
      continue
    }
    chunks.push(chunk)
  }
  if (overflow) throw tooLarge(overflow, maxBytes)
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * 读一个二进制请求体（图片上传走这条）。闸门与 JSON 那条完全一样，只是不解析：
 * 上传的是文件，解析成字符串只会多一份内存；调用方拿 Buffer 直接落盘。
 * 上限由调用处显式给：上传的入口上限不等于「这段代码允许的最大值」。
 */
export async function readBinaryBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const declared = Number(req?.headers?.['content-length'] || 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(declared, maxBytes)
  const chunks = []
  let total = 0
  let overflow = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) {
      overflow = total
      if (total > maxBytes * 4) {
        req.destroy?.()
        throw tooLarge(total, maxBytes)
      }
      continue
    }
    chunks.push(chunk)
  }
  if (overflow) throw tooLarge(overflow, maxBytes)
  return Buffer.concat(chunks)
}
