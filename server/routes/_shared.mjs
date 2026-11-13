// 各功能路由共用的最小工具，避免每个模块重复实现
export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

// 请求体的读取口径写在 server/body-reader.mjs：这里只转发，
// 各路由原来的 import { readBody } 不用改（67 处调用点一个都没动）。
export { readJsonBody as readBody } from '../body-reader.mjs'

export function notFound(res, message = 'not found') {
  sendJson(res, 404, { error: message })
}
