// 读链接（r219）：消息里带网址时，先在服务端把页面读成文字，再连同问题一起问模型。
//
// 为什么自己做，而不是全靠上游的 deepseek_read_url：
//  - 上游工具不是每把 Key 都认（不认就是整条请求 400，用户点一下按钮就报错）；
//  - 本地读还能把「读到了什么」原样留在会话里（message.links），用户能自己核对，
//    与 r218 的附件是同一套口径：先读成文字、读不到就说清原因、绝不假装看过。
//
// 边界（写清楚，别让人以为这是个浏览器）：
//  - 只读 http/https；最多跟 3 次跳转，**每次跳转都重新校验目标**，防止一跳跳进内网；
//  - 不带 cookie、不带登录态，所以要登录才看得到的页面读不到；
//  - 不执行 JS：靠脚本渲染出来的正文可能读不到，这时会明说「正文很少，可能是脚本渲染」；
//  - 单页最多 12000 字、一次最多 2 个链接，超了标「已截断」/「没读」。
//
// 内网防护：域名先解析，只要有一个地址落在本机/局域网/链路本地/CGNAT 就拒绝；
// 字面 IP 直接判。测试要读本机假页面时用 VQ_LINK_ALLOW_PRIVATE=1（生产不要设）。
import dns from 'node:dns'
import { extractDocument } from './chat-files.mjs'

export const LINK_LIMITS = {
  links: 2,
  chars: 12000,
  budget: 12000,
  bytes: 3 * 1024 * 1024,
  redirects: 3,
  timeoutMs: 8000,
}

const UA = 'VisionQA-LinkReader/1.0'
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function allowPrivate() {
  return String(process.env.VQ_LINK_ALLOW_PRIVATE || '') === '1'
}

/** 这个 IP 是不是「不该由用户帮我们访问」的地址（本机、局域网、链路本地、组播…）。 */
export function isPrivateAddress(address) {
  const raw = String(address || '').trim().toLowerCase()
  if (!raw) return true
  if (raw.includes(':')) {
    if (raw === '::' || raw === '::1') return true
    const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1])
    if (/^f[cd][0-9a-f]{2}:/.test(raw)) return true
    if (/^fe[89ab][0-9a-f]:/.test(raw)) return true
    if (/^ff[0-9a-f]{2}:/.test(raw)) return true
    return false
  }
  const parts = raw.split('.').map((value) => Number(value))
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true
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

/** 校验并归一化一条网址：协议、账号口令、内网地址都在这里挡住。 */
export async function assertPublicUrl(raw, { lookup = dns.promises.lookup } = {}) {
  let url = null
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw fail(400, 'LINK_URL', '这不是一个能打开的网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw fail(400, 'LINK_SCHEME', '只读 http/https 的网页，别的地址不替你打开')
  }
  if (url.username || url.password) {
    throw fail(400, 'LINK_URL', '这个地址里带账号口令，不替你打开')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw fail(400, 'LINK_URL', '这个地址没有域名')
  if (allowPrivate()) return url.toString()
  // 字面 IP 直接判，域名要先解析再判（后面的 DNS 结果一定是 IP）
  const literal = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
  if (literal && isPrivateAddress(host)) {
    throw fail(400, 'LINK_PRIVATE', '这个地址指向内网（本机或局域网），不读')
  }
  let list = []
  try {
    list = await lookup(host, { all: true })
  } catch {
    throw fail(502, 'LINK_DNS', '这个域名解析不到，打不开')
  }
  const rows = Array.isArray(list) ? list : [list]
  if (!rows.length) throw fail(502, 'LINK_DNS', '这个域名解析不到，打不开')
  for (const row of rows) {
    if (isPrivateAddress(row?.address)) {
      throw fail(400, 'LINK_PRIVATE', '这个地址指向内网（本机或局域网），不读')
    }
  }
  return url.toString()
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0\u3000]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ ]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** HTML → 文字：去掉脚本/样式/注释，把段落与换行标记还原成换行，再清空白。 */
export function htmlToText(html) {
  let text = String(html || '')
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, '\n')
  text = text.replace(/<\/(?:p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dd|dt|figcaption)>/gi, '\n')
  text = text.replace(/<[^>]+>/g, ' ')
  return tidy(decodeEntities(text))
}

export function pageTitle(html) {
  const matched = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!matched) return ''
  return tidy(decodeEntities(matched[1].replace(/<[^>]+>/g, ' '))).slice(0, 80)
}

/** 只认出我们真能读的几种：网页、纯文本/JSON、PDF。别的（压缩包、图片、视频）明说不读。 */
export function contentTypeKind(value) {
  const type = String(value || '').toLowerCase()
  if (type.includes('pdf')) return 'pdf'
  if (type.includes('html') || type.includes('xhtml')) return 'html'
  if (type.startsWith('text/') || type.includes('json') || type.includes('xml') || type.includes('markdown')) return 'text'
  if (!type) return 'text'
  return ''
}

async function readBody(response, maxBytes) {
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false }
  const chunks = []
  let size = 0
  let truncated = false
  const reader = response.body.getReader()
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    const value = Buffer.from(chunk.value)
    size += value.length
    if (size > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, value.length - (size - maxBytes))))
      truncated = true
      try { await reader.cancel() } catch { /* 已经关了 */ }
      break
    }
    chunks.push(value)
  }
  return { buffer: Buffer.concat(chunks), truncated }
}

/**
 * 读一个页面，返回文字。所有失败都抛人话错误（上层会把它写进「这个链接没读到：…」），
 * 不让一个打不开的链接把整次对话搞挂。
 */
export async function readLink(raw, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = Number(options.timeoutMs) || LINK_LIMITS.timeoutMs
  const maxChars = Number(options.maxChars) || LINK_LIMITS.chars
  const lookup = options.lookup
  let current = await assertPublicUrl(raw, { lookup })
  for (let hop = 0; hop <= LINK_LIMITS.redirects; hop += 1) {
    let response = null
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,text/plain,application/json,application/pdf;q=0.9,*/*;q=0.5',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const message = String(error?.name || '') === 'TimeoutError' || /abort/i.test(String(error?.message || ''))
        ? '打不开：这个页面 ' + Math.round(timeoutMs / 1000) + ' 秒内没有响应'
        : '打不开：' + String(error?.message || error)
      throw fail(502, 'LINK_FETCH', message)
    }
    const status = Number(response?.status) || 0
    if (REDIRECT_STATUS.has(status)) {
      const location = response.headers?.get?.('location') || ''
      if (!location) throw fail(502, 'LINK_REDIRECT', '这个地址跳转到了空地址，打不开')
      let next = ''
      try {
        next = new URL(location, current).toString()
      } catch {
        throw fail(502, 'LINK_REDIRECT', '这个地址的跳转目标看不懂，打不开')
      }
      // 关键：跳转目标也要重新过一遍内网校验，否则可以从公网一跳跳进 127.0.0.1
      current = await assertPublicUrl(next, { lookup })
      continue
    }
    if (status >= 400 || status < 200) {
      throw fail(502, 'LINK_STATUS', '打不开：这个页面回了 HTTP ' + (status || '未知'))
    }
    const type = response.headers?.get?.('content-type') || ''
    const kind = contentTypeKind(type)
    if (!kind) {
      throw fail(415, 'LINK_TYPE', '这个链接不是网页（' + String(type).split(';')[0] + '），读不了')
    }
    const body = await readBody(response, LINK_LIMITS.bytes)
    let text = ''
    let note = ''
    let title = ''
    if (kind === 'pdf') {
      try {
        const parsed = extractDocument(body.buffer, { name: 'page.pdf', maxChars })
        text = parsed.text
        note = parsed.note
      } catch {
        throw fail(422, 'LINK_PDF', '这个 PDF 里没有可读的文字（多半是扫描件），读不出来')
      }
    } else {
      const source = body.buffer.toString('utf8').replace(/^\uFEFF/, '')
      if (kind === 'html') {
        title = pageTitle(source)
        text = htmlToText(source)
      } else {
        text = tidy(source)
      }
    }
    if (text.replace(/\s/g, '').length < 40) {
      throw fail(422, 'LINK_EMPTY', '这个页面没读到正文（可能要登录，或正文是脚本渲染出来的）')
    }
    const truncated = body.truncated || text.length > maxChars
    return {
      ok: true,
      url: String(raw),
      finalUrl: current,
      title: title || new URL(current).hostname,
      text: truncated ? text.slice(0, maxChars) : text,
      chars: Math.min(text.length, maxChars),
      totalChars: text.length,
      truncated,
      note: note || (truncated ? '页面太长，只读了前面的部分' : ''),
    }
  }
  throw fail(502, 'LINK_REDIRECT', '这个地址跳转太多次，打不开')
}

/** 消息里能被当成链接的片段：只认 http/https，去掉句尾标点。 */
export function findLinks(text) {
  const found = []
  const matched = String(text || '').match(/https?:\/\/[^\s<>"'“”‘’（）()【】\[\]，。；：！？、]+/gi) || []
  for (const item of matched) {
    const url = item.replace(/[.,;:!?，。；：！？、]+$/, '')
    if (!url || found.includes(url)) continue
    found.push(url)
  }
  return found
}

function publicLink(link) {
  return {
    url: link.url,
    finalUrl: link.finalUrl || '',
    title: link.title || '',
    ok: Boolean(link.ok),
    chars: Number(link.chars) || 0,
    truncated: Boolean(link.truncated),
    note: link.note || '',
  }
}

/**
 * 读这一轮消息里的链接（最多 2 个、合计 12000 字）。
 * 返回 { links, text }：links 给界面显示「读了什么」，text 拼进这条消息的上下文。
 * 单个链接失败不影响别的链接，也不影响这次对话——它只变成一句「这个链接没读到：原因」。
 */
export async function readLinks(urls = [], options = {}) {
  const maxLinks = Number(options.maxLinks) || LINK_LIMITS.links
  const budget = Number(options.budget) || LINK_LIMITS.budget
  const maxChars = Number(options.maxChars) || LINK_LIMITS.chars
  const picked = []
  for (const raw of urls) {
    const url = String(raw || '').trim()
    if (!url || picked.includes(url)) continue
    if (picked.length >= maxLinks) break
    picked.push(url)
  }
  const links = []
  let used = 0
  for (const url of picked) {
    const room = Math.max(0, budget - used)
    if (!room) {
      links.push({ url, ok: false, chars: 0, note: '这次读的链接已经写满上限，这条没读', finalUrl: '', title: '', truncated: false, text: '' })
      continue
    }
    try {
      const page = await readLink(url, { ...options, maxChars: Math.min(maxChars, room) })
      used += page.chars
      links.push({ ...page, text: page.text })
    } catch (error) {
      links.push({
        url,
        finalUrl: '',
        title: '',
        ok: false,
        chars: 0,
        truncated: false,
        note: String(error?.message || error),
        text: '',
      })
    }
  }
  const blocks = []
  links.forEach((link, index) => {
    if (!link.ok) {
      blocks.push('【链接 ' + (index + 1) + '：' + link.url + ' 没读到：' + link.note + '】')
      return
    }
    const head = '【链接 ' + (index + 1) + '：' + link.url + (link.title ? '（' + link.title + '）' : '') +
      '，约 ' + link.chars + ' 字' + (link.truncated ? '，已截断' : '') + '】'
    blocks.push(head + '\n' + link.text)
  })
  return {
    links: links.map(publicLink),
    text: blocks.join('\n\n'),
    chars: used,
    requested: picked.length,
  }
}
