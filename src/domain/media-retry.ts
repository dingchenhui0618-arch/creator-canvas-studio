// 「再来一次」的唯一真源（r283）：失败的那条、或者还想再抽一张的那条，按它自己记下的参数
// 原样再交一次——不用人回去重填提示词、比例、参考素材。
//
// 为什么不直接写在页面里：参数怎么从任务搬回输入框、模型下架了怎么办、比例 / 时长 / 清晰度
// 在当前模型上已经不合法的落到哪个值，这些是规则，得能单测；页面只负责调用与画按钮。
import type { MediaAsset, MediaModel, MediaTask, MediaTaskAsset } from '../api/media-gen'

// 与 server/routes/media-gen.mjs 的 prepareInput 收的那几个字段一一对应。
// 这里给死、不读页面 state：不然「填好参数再立刻提交」会拿到上一帧的旧值。
export type MediaRetryInput = {
  prompt: string
  modelId: string
  modeId: string
  ratio: string
  duration: number
  resolution: string
  assetIds: string[]
}

export type MediaRetryPlan =
  | { ok: true; input: MediaRetryInput; assets: MediaAsset[] }
  | { ok: false; reason: string }

// 任务里记的参考素材只有形状与大小，没有 mime / previewUrl（那是素材库那一份的字段）。
// 回填托架时要能画出缩略图，所以预览地址按素材库同一条路由拼回去；mime 留空——
// 托架按 kind 决定画 img 还是 video，不看 mime。
function assetOfTask(asset: MediaTaskAsset, createdAt: string): MediaAsset {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    mime: '',
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    duration: asset.duration,
    createdAt,
    previewUrl: '/api/media/assets/' + encodeURIComponent(asset.id) + '/file',
  }
}

// 按这条任务记下的参数，算出「再来一次」要交的东西。
// 三件事都要按当前模型表兜底，而不是信任务里的旧值：
// ① 模型可能已经下线（返回 ok:false，让界面说清是哪条，别静默换成别的模型乱扣积分）；
// ② 生成方式可能改名 / 下线（落回这个模型的第一个方式）；
// ③ 比例 / 时长 / 清晰度可能已经不在当前规格里（落回当前规格的第一个）。
export function planTaskRetry(task: MediaTask, catalog: MediaModel[]): MediaRetryPlan {
  const model = catalog.find((item) => item.id === task.model)
  if (!model) {
    return { ok: false, reason: '这条用的模型（' + task.model + '）不在可选清单里了，没法照原样再来一次' }
  }
  const mode = model.modes.find((item) => item.id === task.mode) ?? model.modes[0]
  if (!mode) return { ok: false, reason: '「' + model.label + '」现在没有可用的生成方式' }
  const ratio = model.ratios.includes(task.ratio) ? task.ratio : (model.ratios[0] ?? '')
  const duration =
    task.duration !== null && model.durations.includes(task.duration) ? task.duration : (model.durations[0] ?? 4)
  const resolution = model.resolutions.includes(task.resolution)
    ? task.resolution
    : (model.resolutions[0] ?? '720p')
  // 文生方式不收素材：原任务带了也不发（服务端也会拒）；收素材的方式按上限截，别把这一请求撑爆
  const refs = mode.maxRefs > 0 ? task.assets.slice(0, mode.maxRefs).map((asset) => assetOfTask(asset, task.createdAt)) : []
  return {
    ok: true,
    assets: refs,
    input: {
      prompt: task.prompt,
      modelId: model.id,
      modeId: mode.id,
      ratio,
      duration,
      resolution,
      assetIds: refs.map((asset) => asset.id),
    },
  }
}

// 按钮上要先写清会再扣多少积分（点了就扣，不能等扣完才知道）。
// 按当前模型表的价格算，不按这条任务当初的花费：现在再跑一次，扣的就是现在的价。
export function retryCredits(task: MediaTask, catalog: MediaModel[], fallback: number): number {
  const model = catalog.find((item) => item.id === task.model)
  if (model) return model.priceTable?.[Number(task.duration) + '|' + task.resolution] ?? model.credits
  const paid = Number(task.credits?.cost)
  return Number.isFinite(paid) && paid > 0 ? paid : fallback
}
