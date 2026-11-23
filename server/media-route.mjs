// 一个显示模型底下几条通道按「便宜 → 贵」兜底（r298）。
//
// 为什么要有这一层：界面上用户只认一个名字（VisionQA通用图片模型 / 通用视频模型），
// 但底下可能有好几条上游通道。最便宜的那条被上游拒了，不该让用户白等一次失败，
// 应该自动换下一条；换通道是产品行为，不该让用户在界面上做选择。
//
// 一条硬边界：**超时与「结果不明」绝不换通道**。那两种情况下上游很可能已经接单并计费，
// 换一条重新提交就是让用户为同一次生成付两次钱——宁可报错退款，也不能偷偷重提。
import { createVideoTask, generateImage, generateImageEdit } from './gateway.mjs'

/**
 * 只有「这条通道不认这个模型」才换下一条：上游 400/404 明确拒单。
 *
 * 别的失败一律不换：
 *  - 超时 / 结果不明——上游可能已接单计费，换一条就是重复付费；
 *  - 401/402/429/5xx / 连不上——那是 Key 或上游整体的问题，换模型也一样失败，
 *    而且每失败一次都会给这把 Key 记一次账，试三条就把整池 Key 打进 60 秒冷却，
 *    后面本来能成的请求反而全被拦下（Key 坏了该换 Key，那是 gateway 自己的事）。
 */
const FALLBACK_STATUSES = new Set([400, 404])

export function canFallback(error) {
  const code = String(error?.code || '')
  // 池里还没有声明这条上游模型的 Key：换下一条通道（新模型接进来之前，不能让用户直接失败）
  if (code === 'NO_IMAGE_KEY' || code === 'NO_VIDEO_KEY') return true
  if (code === 'MODEL_NOT_AVAILABLE' || code === 'UPSTREAM_MODEL_REJECTED') return true
  if (code !== 'UPSTREAM_REJECTED') return false
  return FALLBACK_STATUSES.has(Number(error?.upstreamStatus))
}

/**
 * 出图：按 chain 顺序试，第一个成功就返回。
 * edit 有值走 /images/edits（参考图），没值走 /images/generations。
 */
export async function runImageChain({ chain = [], payload = {}, edit = null } = {}) {
  let lastError = null
  for (let index = 0; index < chain.length; index += 1) {
    const model = chain[index]
    try {
      const result = edit
        ? await generateImageEdit({ ...payload, ...edit, model })
        : await generateImage({ ...payload, model })
      return { result, model, attempts: index + 1 }
    } catch (error) {
      lastError = error
      if (!canFallback(error) || index === chain.length - 1) throw error
    }
  }
  throw lastError || Object.assign(new Error('没有可用的出图通道'), { status: 503, code: 'NO_IMAGE_CHANNEL' })
}

/** 出视频：建任务这一步才换通道；任务一旦建起来（上游接了单）就绝不重提。 */
export async function createVideoChain({ chain = [], payload = {} } = {}) {
  let lastError = null
  for (let index = 0; index < chain.length; index += 1) {
    const model = chain[index]
    try {
      const created = await createVideoTask({ ...payload, model })
      return { created, model, attempts: index + 1 }
    } catch (error) {
      lastError = error
      if (!canFallback(error) || index === chain.length - 1) throw error
    }
  }
  throw lastError || Object.assign(new Error('没有可用的出视频通道'), { status: 503, code: 'NO_VIDEO_CHANNEL' })
}
