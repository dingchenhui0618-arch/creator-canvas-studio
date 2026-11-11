// /api/gateway/v1/*：平台生成通道（给画布的出图 / 出视频节点用）。
// 鉴权是平台服务令牌（Authorization: Bearer <VQ_GATEWAY_TOKEN>），不走用户会话：
// 调用方是画布服务端，不是浏览器。令牌没配时整体 503，不静默放行。
//
// 路径有两套写法，都指向同一段逻辑：
//   1. 平台自有写法：/v1/images/generations、/v1/videos/generations[/<id>]
//   2. 火山方舟写法：/v1/images/generations、/v1/contents/generations/tasks[/<id>]
// 第二套是为了让按方舟协议写死的客户端（画布的出图 / 出视频节点就是）只改 base URL
// 就能接过来，不用改它的业务代码。
import { readBody, sendJson } from './_shared.mjs'
import { authorizeGateway, createVideoTask, generateImage, pollVideoTask } from '../gateway.mjs'

const IMAGE_CREATE = new Set(['/api/gateway/v1/images/generations'])
const VIDEO_CREATE = new Set([
  '/api/gateway/v1/videos/generations',
  '/api/gateway/v1/contents/generations/tasks',
])
const VIDEO_POLL = /^\/api\/gateway\/v1\/(?:videos\/generations|contents\/generations\/tasks)\/([\w.-]+)$/

function fail(res, error) {
  sendJson(res, error?.status || 500, {
    ok: false,
    error: error?.message || '生成失败',
    code: error?.code,
    ...(error?.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
    ...(error?.detail ? { detail: error.detail } : {}),
  })
}

export function createGatewayRouter() {
  return {
    prefix: '/api/gateway',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/gateway')) return false

      const auth = authorizeGateway(req)
      if (!auth.ok) {
        sendJson(res, auth.status, { ok: false, error: auth.error, code: auth.code })
        return true
      }

      if (IMAGE_CREATE.has(pathname) && req.method === 'POST') {
        try {
          sendJson(res, 200, await generateImage(await readBody(req)))
        } catch (error) {
          fail(res, error)
        }
        return true
      }

      if (VIDEO_CREATE.has(pathname) && req.method === 'POST') {
        try {
          sendJson(res, 200, await createVideoTask(await readBody(req)))
        } catch (error) {
          fail(res, error)
        }
        return true
      }

      const poll = pathname.match(VIDEO_POLL)
      if (poll && req.method === 'GET') {
        try {
          sendJson(res, 200, await pollVideoTask(poll[1]))
        } catch (error) {
          fail(res, error)
        }
        return true
      }

      sendJson(res, 404, { ok: false, error: '未知的生成接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}
