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
import { admitWaiting, canvasQueueView } from '../waterline.mjs'

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

/**
 * 出图 / 出视频也是重活（v0.9.79）：以前这条通道既不限流、也不过水位与名额——
 * 画布一次点「批量出图」就能连着发 8 张，每张都在等上游、每张都在花钱。
 * 现在先占整机名额（canvas_gen）再调上游：占不到就 503，**根本不会碰上游**，
 * 这一单没花钱。占到的名额在 finally 里还，超时、上游报错也一样还。
 *
 * v0.9.80 起名额满时先排队（admitWaiting）：画布等得起（同步出图超时 1800 秒），
 * 8 张一起进来时前 2 张先跑、其余排着，排到了照常出图，排不到才拒。
 * 有一条必须自己盯：客户端断开（画布节点被删 / 页面关了）就立刻退出排队，
 * 既不写响应也不调上游——否则排到最后再发现没人要，钱已经花了。
 */
async function withHeavy(req, res, run) {
  let gone = false
  try {
    if (typeof res.on === 'function') res.on('close', () => { if (!res.writableEnded) gone = true })
  } catch {
    // 测试里的假 res 没有 on：靠 writableEnded / destroyed 判断
  }
  const water = await admitWaiting('canvas_gen', {
    isAborted: () => gone || res.writableEnded === true || res.destroyed === true || req.destroyed === true,
    // 画布可以把节点 id / 幂等键当排队票带进来：等待期间它能问「我排第几」（v0.9.83）
    ticket: String(req.headers['x-vq-queue-ticket'] || ''),
  })
  // 画布已经断开：不写响应、不调上游，这一张不花钱
  if (water.aborted) return
  if (!water.ok) {
    const body = water.body || {}
    sendJson(res, water.status || 503, {
      ok: false,
      error: body.error || '服务器正忙，这次生成没有开始（没有产生费用）；等一分钟再试',
      code: body.code || 'SERVER_BUSY',
      // 画布要能分开「同类排队」和「整机忙」：前者少发几张就好，后者得等
      ...(body.kind ? { kind: body.kind } : {}),
      ...(body.retryAfterSec ? { retryAfterSec: body.retryAfterSec } : {}),
      // 画布的出图节点会把这些原样显示在节点上：把「机器在跑几条」和「多久后再试」一起给它
      ...(body.active != null ? { active: body.active, limit: body.limit } : {}),
      // 排队（v0.9.80）：等了多久、是不是排满 / 排超时——画布可以据此少发几张
      ...(water.queued ? { queued: true } : {}),
      ...(water.waitedMs ? { waitedMs: water.waitedMs } : {}),
      ...(water.queueFull ? { queueFull: true } : {}),
      ...(water.timedOut ? { timedOut: true } : {}),
      ...(body.queueWaiting != null ? { queueWaiting: body.queueWaiting, queueMax: body.queueMax } : {}),
    })
    return
  }
  // 排过队的请求：把等待时间与名次带回给画布（节点上能显示「排了 3 秒、当时第 3 位」）
  if (water.waitedMs) {
    try {
      res.setHeader('X-VQ-Queue-Ms', String(water.waitedMs))
      // v0.9.83：票号还回去——画布拿着它就能在等待期间问「我排第几」，不用等到响应回来才知道
      if (water.ticket) res.setHeader('X-VQ-Queue-Ticket', String(water.ticket))
      if (water.position) res.setHeader('X-VQ-Queue-Position', String(water.position))
    } catch { /* 响应头已发出 */ }
  }
  const releaseAdmission = () => { try { water.lease.release() } catch { /* 还名额不该影响响应 */ } }
  try {
    await run()
  } finally {
    releaseAdmission()
  }
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

      // 排队位（v0.9.83）：画布在等的时候问「我排第几」。只读——不占名额、不调上游、不花钱。
      // 票号从 ?ticket= 或请求头取，没带就只回聚合数（几条在跑、几条在等、最久的等了多久）。
      if (pathname === '/api/gateway/v1/queue' && req.method === 'GET') {
        const ticket = url.searchParams.get('ticket') || String(req.headers['x-vq-queue-ticket'] || '') || callerIdempotency
        sendJson(res, 200, canvasQueueView({ ticket }))
        return true
      }

      if (IMAGE_CREATE.has(pathname) && req.method === 'POST') {
        await withHeavy(req, res, async () => {
          try {
            sendJson(res, 200, await generateImage(await readBody(req), { idempotencyKey: callerIdempotency }))
          } catch (error) {
            fail(res, error)
          }
        })
        return true
      }

      if (IMAGE_CREATE_ASYNC.has(pathname) && req.method === 'POST') {
        await withHeavy(req, res, async () => {
          try {
            sendJson(res, 200, await createImageTask(await readBody(req), { idempotencyKey: callerIdempotency }))
          } catch (error) {
            fail(res, error)
          }
        })
        return true
      }

      if (VIDEO_CREATE.has(pathname) && req.method === 'POST') {
        await withHeavy(req, res, async () => {
          try {
            sendJson(res, 200, await createVideoTask(await readBody(req)))
          } catch (error) {
            fail(res, error)
          }
        })
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