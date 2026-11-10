import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import dns from 'node:dns/promises'
import net from 'node:net'
import { config } from './config.mjs'
import { resolveVideoUrl } from './redfox.mjs'

const DIRECT_MEDIA = /\.(mp4|m4v|mov|webm)(\?|#|$)/i
const MAX_REDIRECTS = 3
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'

// ---------- SSRF 防护 ----------
// 这个服务的「下载」「封面代理」都接受用户给的 URL。不设防的话，任何人都能拿它当内网探测器：
// http://127.0.0.1:8799/api/... / http://169.254.169.254/（云元数据） / http://10.x 内网服务，
// 响应还会原样回显给请求方。这里在发起连接前做三件事：只允许 http(s)、禁掉带账号口令的 URL、
// 解析域名后逐个拒绝内网/保留地址。（解析与连接之间仍有 DNS rebinding 的理论窗口，
// 要彻底堵住需要在连接层锁定 IP；当前部署是单机自用，先按这一层拦。）
const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function v4ToInt(address) {
  return address.split('.').reduce((sum, part) => (sum << 8) + Number(part), 0) >>> 0
}

export function isPrivateAddress(address) {
  const raw = String(address || '').replace(/^\[|\]$/g, '')
  if (!raw) return true
  const family = net.isIP(raw)
  if (family === 4) {
    const value = v4ToInt(raw)
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      return (value & mask) === (v4ToInt(base) & mask)
    })
  }
  if (family === 6) {
    const lower = raw.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    // IPv4-mapped（::ffff:127.0.0.1）按内嵌的 v4 判断
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1])
    return /^(fc|fd|fe80|ff)/.test(lower)
  }
  // 不是合法 IP：按不安全处理
  return true
}

export async function assertPublicHttpUrl(input) {
  let url
  try {
    url = input instanceof URL ? input : new URL(String(input))
  } catch {
    throw new Error('链接格式不对：' + String(input).slice(0, 120))
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 http / https 链接')
  if (url.username || url.password) throw new Error('链接里不允许带账号口令')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('链接缺少主机名')
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('拒绝访问内网地址：' + host)
    return url
  }
  let records = []
  try {
    records = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error('域名解析失败：' + host)
  }
  if (!records.length) throw new Error('域名解析为空：' + host)
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new Error('拒绝访问内网地址：' + host + ' → ' + record.address)
  }
  return url
}

// 只跟随 3 次重定向，每一跳都重新校验（否则「公网域名 302 到 127.0.0.1」就绕过去了）
export async function fetchPublic(startUrl, { headers = {}, timeoutMs = config.limits.downloadTimeoutMs } = {}) {
  const signal = AbortSignal.timeout(timeoutMs)
  let current = startUrl instanceof URL ? startUrl : new URL(String(startUrl))
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHttpUrl(current)
    const response = await fetch(current, {
      headers: { 'User-Agent': UA, ...headers },
      redirect: 'manual',
      signal,
    })
    const location = response.headers.get('location')
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      try {
        await response.body?.cancel()
      } catch {
        // 丢掉上一跳的 body，不关心失败
      }
      current = new URL(location, current)
      continue
    }
    return { response, url: current }
  }
  throw new Error('重定向次数过多（超过 ' + MAX_REDIRECTS + ' 次），已中止')
}

// 边下边写盘：以前是整段读进内存再写文件，160MB 上限的源视频能直接把进程内存顶穿
async function downloadToFile(url, target, onProgress) {
  const limit = config.limits.maxVideoMb * 1024 * 1024
  const { response } = await fetchPublic(url, { headers: { Referer: 'https://www.douyin.com/' } })
  if (!response.ok) throw new Error('视频下载失败：HTTP ' + response.status)
  const total = Number(response.headers.get('content-length') || 0)
  if (total && total > limit) throw new Error('视频超过 ' + config.limits.maxVideoMb + 'MB 限制')
  const file = fs.createWriteStream(target)
  let received = 0
  try {
    for await (const chunk of response.body) {
      received += chunk.length
      if (received > limit) throw new Error('视频超过 ' + config.limits.maxVideoMb + 'MB 限制')
      if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve))
      if (onProgress && total) onProgress(Math.min(0.99, received / total))
    }
  } catch (error) {
    file.destroy()
    await fsp.rm(target, { force: true }).catch(() => {})
    throw error
  }
  await new Promise((resolve, reject) => {
    file.end((error) => (error ? reject(error) : resolve(undefined)))
  })
  return received
}

export async function acquireVideo({ url, platform }, jobDir, onProgress) {
  await fsp.mkdir(jobDir, { recursive: true })
  const target = path.join(jobDir, 'source.mp4')
  let resolvedFrom = 'direct'

  if (!url) throw new Error('没有可用的视频地址：请粘贴 mp4 直链')

  if (DIRECT_MEDIA.test(url)) {
    await assertPublicHttpUrl(url)
    await downloadToFile(url, target, onProgress)
    return { file: target, resolvedFrom, resolvedUrl: url }
  }

  if (platform !== 'douyin' && platform !== 'xiaohongshu') {
    throw new Error('无法识别的链接：既不是可直接下载的视频（.mp4/.m4v/.mov/.webm），也不是抖音/小红书内容链接')
  }

  const resolved = await resolveVideoUrl(platform, url)
  resolvedFrom = 'redfox-parse'
  await downloadToFile(resolved.downloadUrl, target, onProgress)
  return { file: target, resolvedFrom, resolvedUrl: resolved.downloadUrl, remoteTitle: resolved.title, remoteCover: resolved.cover }
}

export function openVideoStream(file) {
  return fs.createReadStream(file)
}
