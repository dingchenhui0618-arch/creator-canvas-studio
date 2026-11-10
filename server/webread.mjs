import dns from 'node:dns/promises'
import net from 'node:net'
import { config } from './config.mjs'

// 智能体「网页读取」工具：把对话里贴的公开网页抓成纯文本，作为本次创作的参考。
// 这是唯一一个由用户输入决定目标地址的服务端请求，所以安全边界写在这里：
// 只允许公网 http/https、禁止账号口令、限制端口与重定向，并在 DNS 解析后
// 再判一次私网地址，避免用域名指向内网绕过字面量检查。
export class WebReadError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'WebReadError'
    this.code = code
    this.status = status
  }
}

const MAX_REDIRECTS = 3
const MAX_URL_CHARS = 2048
const USER_AGENT = 'VisionQA-WebRead/0.1 (+https://visionqa.wavisionai.cn)'

function ipv4Private(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function ipv6Private(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (/^fe[89ab]/.test(lower)) return true
  if (/^f[cd]/.test(lower)) return true
  if (/^ff/.test(lower)) return true
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return ipv4Private(mapped[1])
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped) {
    const high = parseInt(hexMapped[1], 16)
    const low = parseInt(hexMapped[2], 16)
    return ipv4Private([high >> 8, high & 255, low >> 8, low & 255].join('.'))
  }
  return false
}

function isPrivateAddress(address) {
  const ip = String(address || '').replace(/^\[|\]$/g, '')
  if (!ip) return true
  const version = net.isIP(ip)
  if (version === 4) return ipv4Private(ip)
  if (version === 6) return ipv6Private(ip)
  return true
}

function blocked(message = '这个链接不是公开网页地址') {
  return new WebReadError('WEB_READ_BLOCKED', message, 400)
}

async function validateUrl(rawUrl) {
  const text = String(rawUrl || '').trim()
  if (!text) throw new WebReadError('WEB_READ_EMPTY', '没有提供要读取的链接', 400)
  if (text.length > MAX_URL_CHARS) throw blocked()
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw blocked()
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw blocked()
  if (parsed.username || parsed.password) throw blocked()
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') throw blocked()
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!host) throw blocked()
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) throw blocked()
  if (net.isIP(host) === 0) {
    if (!host.includes('.')) throw blocked()
    let resolved = []
    try {
      resolved = await dns.lookup(host, { all: true, verbatim: true })
    } catch {
      throw new WebReadError('WEB_READ_UNRESOLVED', '这个域名解析不到，换一个链接再试', 400)
    }
    if (!resolved.length || resolved.some((item) => isPrivateAddress(item.address))) throw blocked()
  } else if (isPrivateAddress(host)) {
    throw blocked()
  }
  return parsed
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => {
      const point = Number(code)
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' '
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const point = parseInt(code, 16)
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' '
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function htmlToText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : ''
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return { title, text: decodeEntities(body) }
}

function normalizeText(value) {
  const lines = String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
  const out = []
  let blank = false
  for (const line of lines) {
    if (!line) {
      if (!blank && out.length) out.push('')
      blank = true
      continue
    }
    out.push(line)
    blank = false
  }
  return out.join('\n').trim()
}

function charsetOf(contentType) {
  const match = /charset=([\w-]+)/i.exec(String(contentType || ''))
  return match ? match[1].toLowerCase() : 'utf-8'
}

function decodeBody(buffer, contentType) {
  const charset = charsetOf(contentType)
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  }
}

async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.()
  if (!reader) return { buffer: Buffer.alloc(0), truncated: false }
  const chunks = []
  let total = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || !value.byteLength) continue
    const remain = maxBytes - total
    if (value.byteLength >= remain) {
      chunks.push(Buffer.from(value.slice(0, remain)))
      total += remain
      truncated = true
      try {
        await reader.cancel()
      } catch {
        // 读够了就不再等正文，取消失败也不影响已读到的内容
      }
      break
    }
    chunks.push(Buffer.from(value))
    total += value.byteLength
  }
  return { buffer: Buffer.concat(chunks), truncated }
}

const READABLE_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json']

let lastProbe = null

function remember(entry) {
  lastProbe = entry
}

// 最近一次「网页读取」的结果摘要：内部环境排障用，只记来源主机与结果，不记完整地址（可能带查询令牌）。
export function lastWebRead() {
  return lastProbe
}

export async function readWebPage(rawUrl, { maxChars } = {}) {
  const startedAt = Date.now()
  const charLimit = Math.max(500, Number(maxChars) || config.webread.maxChars)
  let current = await validateUrl(rawUrl)
  let response = null
  let finalUrl = current
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let next
      try {
        next = await fetch(current.href, {
          redirect: 'manual',
          signal: AbortSignal.timeout(config.webread.timeoutMs),
          headers: {
            Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
            'User-Agent': USER_AGENT,
          },
        })
      } catch (error) {
        const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
        throw aborted
          ? new WebReadError('WEB_READ_TIMEOUT', '页面打开超时，稍后再试或换一个链接', 504)
          : new WebReadError('WEB_READ_UNAVAILABLE', '页面打不开，本次没有读取', 502)
      }
      if (next.status >= 300 && next.status < 400) {
        const location = next.headers.get('location')
        if (!location) throw new WebReadError('WEB_READ_UNAVAILABLE', '页面跳转失败，本次没有读取', 502)
        current = await validateUrl(new URL(location, current).href)
        continue
      }
      response = next
      finalUrl = current
      break
    }
    if (!response) throw new WebReadError('WEB_READ_REDIRECT', '页面跳转次数太多，本次没有读取', 502)
    if (!response.ok) {
      throw new WebReadError('WEB_READ_HTTP', '页面返回 ' + response.status + '，本次没有读取', 502)
    }
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (contentType && !READABLE_TYPES.includes(contentType)) {
      throw new WebReadError('WEB_READ_TYPE', '这个链接不是文字网页，本次没有读取', 415)
    }
    const { buffer, truncated } = await readCapped(response, config.webread.maxBytes)
    const decoded = decodeBody(buffer, contentType)
    let title = ''
    let text = ''
    if (contentType === 'application/json') {
      try {
        text = JSON.stringify(JSON.parse(decoded), null, 2)
      } catch {
        text = decoded
      }
    } else if (contentType === 'text/plain' || contentType === 'text/markdown') {
      text = decoded
    } else {
      const extracted = htmlToText(decoded)
      title = extracted.title
      text = extracted.text
    }
    text = normalizeText(text)
    const clipped = text.length > charLimit
    if (clipped) text = text.slice(0, charLimit)
    const result = {
      ok: true,
      url: finalUrl.origin + finalUrl.pathname,
      host: finalUrl.hostname.replace(/^\[|\]$/g, ''),
      title: title.slice(0, 200),
      text,
      chars: text.length,
      bytes: buffer.byteLength,
      truncated: truncated || clipped,
      contentType,
      elapsedMs: Date.now() - startedAt,
    }
    remember({ at: new Date().toISOString(), ok: true, host: result.host, chars: result.chars, ms: result.elapsedMs, title: result.title, code: '' })
    return result
  } catch (error) {
    const failure = error instanceof WebReadError ? error : new WebReadError('WEB_READ_FAILED', '页面读取失败，本次没有读取', 502)
    let host = ''
    try {
      host = new URL(String(rawUrl)).hostname
    } catch {
      host = ''
    }
    remember({ at: new Date().toISOString(), ok: false, host, chars: 0, ms: Date.now() - startedAt, title: '', code: failure.code })
    throw failure
  }
}

// 只取消息里的第一个链接：一次对话读一个页面，成本与延迟都可预期。
export function extractUrl(message) {
  const matches = String(message || '').match(/https?:\/\/[^\s<>"'\u0060\uff0c\u3002\uff1b\uff1a\uff01\uff1f\uff09\u3011\u300b]+/gi) || []
  if (!matches.length) return ''
  return matches[0].replace(/[.,;:!?)\]}'"]+$/g, '').slice(0, MAX_URL_CHARS)
}
