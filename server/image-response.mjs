// 认证范围内的图片响应（v0.9.89）
//
// 帧图与上传图都是「跟着登录态走」的东西，但它们以前给的是 max-age：帧图一小时、
// 上传图五分钟。浏览器在这段时间里不会回源，于是退出登录（或者换账号）之后，
// 同一台电脑还能从自己的 HTTP 缓存里把看过的画面画出来——服务端那道 401 根本没有机会跑。
//
// 现在统一成：private + no-cache + 强 ETag。
//   - private：中间层不许存（nginx 那边也已经把头交回应用）
//   - no-cache：浏览器可以留副本，但每次用之前必须回源问一句「还是那张吗」
//   - ETag：没变就回 304（几十字节），所以重验几乎不花钱；变了、或者现在没权限了，
//     服务端就老老实实回 401 / 404，浏览器也就画不出旧画面
//
// 注意：304 只有在「这次请求本身也通过了登录与归属判断」之后才可能发生——
// 判断在前、比对在后，缓存因此不能当登录的旁路。
import fsp from 'node:fs/promises'

/** 缓存头的唯一出处：两条路由与文档都引这一个常量。 */
export const AUTH_IMAGE_CACHE = 'private, no-cache'

/** 大小 + 修改时间就够区分同一路径上的不同内容，不用读文件。 */
export function imageEtag(stat) {
  const size = Number(stat?.size || 0).toString(16)
  const mtime = Math.floor(Number(stat?.mtimeMs || 0)).toString(16)
  return '"' + size + '-' + mtime + '"'
}

/** If-None-Match 可能是列表、可能带 W/ 前缀、也可能是 *。 */
export function etagMatches(header, etag) {
  if (!header) return false
  const raw = String(header).trim()
  if (!raw) return false
  if (raw === '*') return true
  return raw.split(',').some((part) => part.trim().replace(/^W\//, '') === etag)
}

/**
 * 发一张受登录态保护的图片：没变化回 304，否则回 200。
 * 返回 false 表示这台机器上没有这个文件（调用方照旧回 404）。
 */
export async function sendAuthImage(req, res, file, mime) {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  const etag = imageEtag(stat)
  const headers = {
    'Content-Type': mime || 'application/octet-stream',
    'Cache-Control': AUTH_IMAGE_CACHE,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  }
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers)
    res.end()
    return true
  }
  let bytes
  try {
    bytes = await fsp.readFile(file)
  } catch {
    return false
  }
  res.writeHead(200, { ...headers, 'Content-Length': bytes.length })
  res.end(bytes)
  return true
}
