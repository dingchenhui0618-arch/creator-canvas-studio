// /api/gateway/v1/*：平台生成通道（给画布的出图 / 出视频节点用）。
// 鉴权是平台服务令牌（Authorization: Bearer <VQ_GATEWAY_TOKEN>），不走用户会话：
// 调用方是画布服务端，不是浏览器。令牌没配时整体 503，不静默放行。
//
// 路径支持三套写法，都指向同一段逻辑：
//   1. 平台自有写法：/v1/images/generations[/async]、/v1/videos/generations[/<id>]、/v1/tasks/<id>
//   2. 火山方舟写法：/v1/images/generations、/v1/contents/generations/tasks[/<id>]
//   3. SeeAPI / CGCM 写法：/v1/images/generations[/async]、/v1/video/generations、/v1/tasks/<id>
// 这样按任一种协议写死的客户端（画布的出图节点按方舟、出视频的 CGCM 渠道按 SeeAPI）
// 只改 base URL 就能接过来，不用改它的业务代码。
import { readBody, sendJson } from './_shared.mjs'
import { authorizeGateway, createImageTask, createVideoTask, generateImage, listPoolModels, pollVideoTask } from '../gateway.mjs'
import { config } from '../config.mjs'

const IMAGE_CREATE = new Set(['/api/gateway/v1/images/generations'])
const IMAGE_CREATE_ASYNC = new Set(['/api/gateway/v1/images/generations/async'])
const VIDEO_CREATE = new Set([
  '/api/gateway/v1/videos/generations',
  '/api/gateway/v1/video/generations',
  '/api/gateway/v1/contents/generations/tasks',
])
const TASK_POLL = /^\/api\/gateway\/v1\/(?:videos\/generations|video\/generations|tasks|contents\/generations\/tasks)\/([\w.-]+)$/

function fail(res, error) {
  sendJson(res, error?.status || 500, {
    ok: false,
    error: error?.message || '生成失败',
    code: error?.code,
    ...(error?.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
    ...(error?.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
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

      // 生成能力开关：渠道额度没开通时明确拒绝，而不是让上游 402 以「生成失败」回到画布上。
      // 模型目录与轮询仍然可用：画布可以探活、可以取已完成的任务结果。
      if (!config.gateway.open && req.method === 'POST') {
        sendJson(res, 503, { ok: false, error: '生成能力暂未开放：平台渠道额度还没开通', code: 'GATEWAY_NOT_OPEN' })
        return true
      }

      // 模型目录：画布侧「测试 Key」先探这里，用来判活而不是真跑一次生成
      if (pathname === '/api/gateway/v1/models' && req.method === 'GET') {
        sendJson(res, 200, listPoolModels(url.searchParams.get('capability') || ''))
        return true
      }

      // 画布直连 SeeAPI 时把幂等键放在请求头里（它自己的 generation_image2.py:158-162 就这么发），
      // 接到平台通道后这个头要接着往下传：否则上游每次都看到一个新键，画布重试就可能重复扣费。
      const callerIdempotency = String(req.headers['idempotency-key'] || '')

      if (IMAGE_CREATE.has(pathname) && req.method === 'POST') {
        try {
          sendJson(res, 200, await generateImage(await readBody(req), { idempotencyKey: callerIdempotency }))
        } catch (error) {
          fail(res, error)
        }
        return true
      }

      if (IMAGE_CREATE_ASYNC.has(pathname) && req.method === 'POST') {
        try {
          sendJson(res, 200, await createImageTask(await readBody(req), { idempotencyKey: callerIdempotency }))
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

      const poll = pathname.match(TASK_POLL)
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