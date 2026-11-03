// 各功能路由共用的最小工具，避免每个模块重复实现
export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export function notFound(res, message = 'not found') {
  sendJson(res, 404, { error: message })
}
