// r288：把「对话框里的一句话」接到现成的生成管线上（server/routes/media-gen.mjs 的 runImage / runVideo）。
//
// 这一层只做三件事，别的都交给现成管线（扣费、退款、落盘、最近生成都是同一套）：
//  1) 与「图片 / 视频」页签共用同一个账号级限流桶，别让对话框绕过它；
//  2) 把解析结果收敛成 resolveSelection 认识的形状（比例 / 时长 / 清晰度按模型校验）；
//  3) 积分不够、限流、参数不合法都翻成带 status / code 的错误，路由照原口径回给界面。
//
// 说明：这里从 routes/media-gen.mjs 取的是领域函数，不是 HTTP 处理器。
// 把领域部分拆成 server/media-tasks.mjs 是后面该做的事，本轮先不搬——一搬就是 400 行位移，
// 与「接对话框」这件事混在一起出问题不好定位。
import { resolveSelection } from './media-models.mjs'
import { mediaRateLimit, publicTask, runImage, runVideo } from './routes/media-gen.mjs'

function failure(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

export async function startChatMedia(user, plan) {
  const limit = mediaRateLimit(user.id)
  if (limit) {
    const error = failure(429, 'MEDIA_RATE_LIMITED', '生成太频繁了，请 ' + limit.retryAfterSec + ' 秒后再试')
    error.retryAfterSec = limit.retryAfterSec
    throw error
  }

  const selection = resolveSelection({
    kind: plan.kind,
    model: plan.model,
    ratio: plan.ratio,
    duration: plan.duration,
    resolution: plan.resolution,
    mode: 'text',
  })
  const input = { ...selection, prompt: plan.prompt, assets: [] }
  const result = plan.kind === 'image' ? await runImage(user, input) : await runVideo(user, input)
  if (result.paymentFailed) {
    const paid = result.paymentFailed
    const error = failure(
      402,
      paid.code || 'CREDIT_INSUFFICIENT',
      paid.message || '积分不足：本次需要 ' + paid.cost + ' 积分，当前余额 ' + paid.balance + ' 积分',
    )
    error.balance = paid.balance
    error.needed = paid.needed
    throw error
  }
  return publicTask(result.task)
}
