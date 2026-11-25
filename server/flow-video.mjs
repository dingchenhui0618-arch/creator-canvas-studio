// 工作流「出视频」节点（v0.9.200）：一次运行里真的出一段视频，产物落进这次运行自己的目录。
//
// 与出图节点的区别：视频在上游是**异步任务**——建任务拿任务号，再轮询到出片。
// 这里把轮询收在节点内部（而不是像快捷创作那样「先回任务号、页面轮询」），因为下游的
// 评审 / 输出节点要立刻拿到这段视频；同时每轮都推一条 node-progress 给运行流，
// 页面能看见「已等 45 秒 · 40%」，连接也不会因为长时间没有字节而被 nginx 掐断。
//
// 钱的口径与快捷创作一致：先扣后做、失败 / 超时全额退回、账本 ref 用「运行 + 节点」。
// 不换任务重跑：换一次就是再花一次钱，宁可这一条失败让用户重跑。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { charge, outstandingCharge, refund } from './credits.mjs'
import { pollVideoTask } from './gateway.mjs'
import { createVideoChain } from './media-route.mjs'
import {
  chainFor,
  VIDEO_DURATIONS,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  defaultModelFor,
  findModel,
  listMediaModels,
} from './media-models.mjs'
import { downloadAsset, extensionFor, extractVideoUrl, progressOf } from './media-fetch.mjs'
import { runDirOf, safeNodeId } from './flow-image.mjs'

export const FLOW_VIDEO_DEFAULT_RATIO = '9:16'
export const FLOW_VIDEO_DEFAULT_DURATION = 4
export const FLOW_VIDEO_DEFAULT_RESOLUTION = '720p'
const MAX_PROMPT = 1500
const MIN_CAP_MS = 15 * 1000

const RATIO_LABEL = { '1:1': '1:1 方形', '9:16': '9:16 竖版', '16:9': '16:9 横版' }

/** 检查器与运行前估价要用的选项：模型、比例、时长、清晰度、单价，全部来自 media-models 这张唯一真源。 */
export function videoNodeOptions() {
  const video = listMediaModels().video
  return {
    defaultModel: defaultModelFor('video'),
    defaultRatio: FLOW_VIDEO_DEFAULT_RATIO,
    defaultDuration: FLOW_VIDEO_DEFAULT_DURATION,
    defaultResolution: FLOW_VIDEO_DEFAULT_RESOLUTION,
    models: video.map((item) => ({
      id: item.id,
      label: item.label,
      credits: Number(item.credits) || 0,
      verified: Boolean(item.verified),
    })),
    ratios: VIDEO_RATIOS.map((ratio) => ({ ratio, label: RATIO_LABEL[ratio] || ratio })),
    durations: VIDEO_DURATIONS.map((seconds) => ({ seconds, label: seconds + ' 秒' })),
    resolutions: VIDEO_RESOLUTIONS.map((value) => ({ value, label: value === '720p' ? '720p 高清' : '480p 省额度' })),
  }
}

/** 节点单价：按所选模型的积分价；模型不认识时回落到默认模型的价。 */
export function videoNodeCredits(model) {
  const spec = findModel('video', model) || findModel('video', defaultModelFor('video'))
  return spec ? Number(spec.credits()) || 0 : 0
}

/** 这次运行里 K 个出视频节点一共要花多少积分（运行前提示用，服务端按节点真扣）。 */
export function videoNodesCost(nodes, model) {
  const count = (Array.isArray(nodes) ? nodes : []).filter((node) => (node?.type || node?.data?.kind) === 'video').length
  return count * videoNodeCredits(model)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stoppedError() {
  return Object.assign(new Error('运行已停止'), { name: 'AbortError' })
}

/**
 * 真跑一次出视频：扣费 → 建任务 → 轮询到出片 → 下载落盘 → 返回可访问地址。
 * 任何一步失败（含超时）都把这笔扣费退回去（按账本净额，重复调用不会多退），再抛错。
 * onProgress 每轮给一次 { waitedMs, progress, status, note }：页面据此显示「已等 N 秒」。
 */
export async function runVideoGeneration({
  ownerId,
  runId,
  nodeId,
  prompt,
  ratio = FLOW_VIDEO_DEFAULT_RATIO,
  duration = FLOW_VIDEO_DEFAULT_DURATION,
  resolution = FLOW_VIDEO_DEFAULT_RESOLUTION,
  model = '',
  reference = null,
  signal = null,
  onProgress = null,
  timeoutMs = 0,
  pollMs = 0,
} = {}) {
  const text = String(prompt ?? '').trim().slice(0, MAX_PROMPT)
  if (!text) throw new Error('出视频节点没有提示词：在检查器里填写，或把上游文本接到它上面')
  const spec = findModel('video', model) || findModel('video', defaultModelFor('video'))
  if (!spec) throw new Error('没有可用的出视频模型：检查后台的模型与密钥')
  const seconds = VIDEO_DURATIONS.includes(Number(duration)) ? Number(duration) : FLOW_VIDEO_DEFAULT_DURATION
  const quality = VIDEO_RESOLUTIONS.includes(String(resolution)) ? String(resolution) : FLOW_VIDEO_DEFAULT_RESOLUTION
  const aspect = VIDEO_RATIOS.includes(String(ratio)) ? String(ratio) : FLOW_VIDEO_DEFAULT_RATIO
  // 视频按「秒 × 清晰度」算钱：8 秒 720p 比 4 秒 480p 贵，不能一口价
  const credits = Number(spec.credits({ duration: seconds, resolution: quality })) || 0
  const ref = ('run:' + runId + ':' + nodeId).slice(0, 190)
  // 目录先算出来：runId 不合法要在扣费之前失败，不然钱扣了却存不下结果
  const dir = runDirOf(runId)
  const paid = charge(ownerId, 'video_gen', {
    ref,
    amount: credits,
    meta: { label: '工作流出视频 · ' + text.slice(0, 36) },
  })
  if (!paid.ok) {
    throw new Error('积分不足：这次出视频需要 ' + credits + ' 积分，当前余额 ' + (paid.balance ?? 0) + ' 积分')
  }
  const startedAt = Date.now()
  // 显式传进来的上限优先（测试与将来的按节点配置用），否则用平台默认；只有默认值才有 15 秒地板
  const capMs = Number(timeoutMs) > 0
    ? Math.max(100, Number(timeoutMs))
    : Math.max(MIN_CAP_MS, Number(config.flow.videoTimeoutMs) || 12 * 60 * 1000)
  const stepMs = Math.max(20, Number(pollMs) || Number(config.flow.videoPollMs) || 4000)
  let taskId = ''
  try {
    // 最便宜的通道先试，被上游拒了才换下一条（任务一旦建起来就不再重提，见 media-route.mjs）
    const { created, model: usedModel } = await createVideoChain({
      chain: chainFor('video').map((item) => item.id),
      payload: {
        prompt: text,
        duration: seconds,
        resolution: quality,
        // 上游强制要这个字段（缺了就是 400 validation_error），不传等于每次都失败
        aspect_ratio: aspect,
        // 带参考资产 = 图生视频：首帧就是「我的商品图 / 我的脸」。
        // 不传这个数组就是纯文生视频，两条路的价格一样，不因为带了资产另算。
        ...(reference
          ? {
              referenceAssets: [{
                kind: 'image',
                mime: reference.mime,
                ext: reference.filename.split('.').pop() || 'jpg',
                bytes: reference.buffer,
              }],
              mode: 'image2video',
            }
          : {}),
      },
    })
    taskId = String(created?.id || created?.taskId || '')
    if (!taskId) throw new Error('上游没有返回视频任务编号')
    for (;;) {
      if (signal?.aborted) throw stoppedError()
      const waited = Date.now() - startedAt
      if (waited > capMs) {
        throw new Error('视频生成超时：等了 ' + Math.round(waited / 1000) + ' 秒还没出片（上限 ' + Math.round(capMs / 1000) + ' 秒），积分已退回')
      }
      await sleep(stepMs)
      if (signal?.aborted) throw stoppedError()
      let data
      try {
        data = await pollVideoTask(taskId)
      } catch (error) {
        const code = String(error?.code || '')
        if (code === 'TASK_NOT_FOUND' || code === 'TASK_KEY_GONE') throw error
        // 单次查询抖动不算失败：上游任务还在跑，这里重发建任务才是重复付费
        if (onProgress) onProgress({ waitedMs: Date.now() - startedAt, progress: null, status: 'processing', note: String(error?.message || '查询上游任务失败') })
        continue
      }
      const status = String(data?.status || '').toLowerCase()
      if (onProgress) onProgress({ waitedMs: Date.now() - startedAt, progress: progressOf(data), status: status || 'processing' })
      if (status === 'succeeded') {
        const url = extractVideoUrl(data)
        if (!url) throw new Error('上游说任务成功，但没有返回视频地址')
        const asset = await downloadAsset(url, 'video')
        const ext = extensionFor(asset.mime, 'video', '')
        const fileName = safeNodeId(nodeId) + '.' + ext
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
        await fsp.writeFile(path.join(dir, fileName), asset.buffer, { mode: 0o600 })
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        return {
          text:
            '出视频完成：' + spec.label + ' · ' + (RATIO_LABEL[aspect] || aspect) + ' · ' + seconds + ' 秒 · ' + quality +
            ' · 用时 ' + elapsed + ' 秒 · 本次 ' + credits + ' 积分' +
            (reference ? '\n参考资产：' + reference.label : '') +
            '\n提示词：' + text,
          ...(reference ? { reference: { token: reference.token, label: reference.label } } : {}),
          videoPath: 'runs/' + runId + '/' + fileName,
          videoUrl: '/api/runs/' + runId + '/assets/' + fileName,
          model: spec.display,
          modelLabel: spec.label,
          upstream: usedModel,
          ratio: aspect,
          duration: seconds,
          resolution: quality,
          bytes: asset.buffer.length,
          mime: asset.mime,
          elapsedMs: Date.now() - startedAt,
          taskId,
          credits,
        }
      }
      if (status === 'failed' || status === 'refunded' || status === 'canceled') {
        const reason = String(data?.error?.message || ('上游报告任务没出片（' + status + '）'))
        throw new Error('出视频失败：' + reason)
      }
    }
  } catch (error) {
    try {
      const owed = outstandingCharge(ownerId, 'video_gen', ref)
      if (owed > 0) refund(ownerId, 'video_gen', { ref, amount: owed, meta: { label: '工作流出视频失败退款' } })
    } catch {
      // 退款失败不该掩盖真正的失败原因；账本里还留着这笔待退，后台能看到
    }
    throw error
  }
}
