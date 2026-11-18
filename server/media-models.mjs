// 快捷创作能用哪些生成模型、每个模型支持什么：这张表是界面下拉与接口校验的唯一真源。
//
// 为什么要有这张表（而不是前端写死几个选项）：
//  1) 界面能选什么，必须等于「服务端真的能发出去什么」——前端多摆一个选项，用户就白花一次积分；
//  2) 出图 / 出视频的规格（比例、时长、清晰度、最多几个参考）每个模型都不一样，
//     校验只能放在服务端，界面照这张表画控件才不会自相矛盾；
//  3) 后台换了 Key、换了大模型，改这里一处就够，不用两头对。
//
// 诚实口径：
//  - 只列「池里真有 Key 声明」的模型（2026-11-18 生产 model-keys.json：图片 gpt-image-2 系、
//    视频 seedance-2.0 / -fast / -mini / 2.5 / minimax / wan / hurry-horse），别的模型不摆进来凑数；
//  - verified=false 表示这条链路**没有真调过**（生产只真调过 gpt-image-2 文生图与
//    seedance-2.0 的 4s/8s、480p/720p），界面上要照实标「未真调」，不能装作验过；
//  - 价格沿用现在的积分价（图片 5 / 视频 15，config.credits.prices），这轮不悄悄改价。
import { config } from './config.mjs'
import { primaryRouteFor } from './model-routes.mjs'

// 图片比例对应到上游的 size：与 v0.9.165 起真调过的三个尺寸一致，不凭空加尺寸。
export const IMAGE_SIZES = {
  '1:1': '1024x1024',
  '9:16': '1024x1536',
  '16:9': '1536x1024',
}

export const VIDEO_RATIOS = ['9:16', '16:9', '1:1']
export const VIDEO_DURATIONS = [4, 8]
// 顺序就是界面上的默认值：720p 在前（与这轮之前的默认一致），480p 留给想省额度的场景
export const VIDEO_RESOLUTIONS = ['720p', '480p']

// 一个请求里参考素材的总个数上限：比单个模型的上限宽一点，兜住离谱输入。
export const ASSET_REF_CAP = 12

// 多模态参考的上限来自 SeeAPI 自己的模型规格（无限画布 generation_seedance.py 的
// CGCM_NEW_VIDEO_MODEL_SPECS：seedance-2.0 系 image_limit=9 / video_limit=3），不是我们拍的。
const SEEDANCE_IMAGE_REFS = 9
const SEEDANCE_VIDEO_REFS = 3

const VIDEO_MODES = [
  { id: 'text', label: '文生视频', minRefs: 0, maxRefs: 0, imageRefs: 0, videoRefs: 0, hint: '只按提示词生成' },
  { id: 'first', label: '首帧', minRefs: 1, maxRefs: 1, imageRefs: 1, videoRefs: 0, hint: '给一张首帧图，按它往下生成' },
  {
    id: 'mixed',
    label: '多模态参考',
    minRefs: 1,
    maxRefs: SEEDANCE_IMAGE_REFS + SEEDANCE_VIDEO_REFS,
    imageRefs: SEEDANCE_IMAGE_REFS,
    videoRefs: SEEDANCE_VIDEO_REFS,
    hint: '可组合 ' + SEEDANCE_IMAGE_REFS + ' 张图与 ' + SEEDANCE_VIDEO_REFS + ' 段视频作参考',
  },
]

const IMAGE_MODES = [
  { id: 'text', label: '文生图', minRefs: 0, maxRefs: 0, imageRefs: 0, videoRefs: 0, hint: '只按提示词画' },
  { id: 'reference', label: '参考图', minRefs: 1, maxRefs: 1, imageRefs: 1, videoRefs: 0, hint: '带一张参考图，按它的主体与风格重画' },
]

export const MEDIA_MODEL_SPECS = [
  {
    id: 'gpt-image-2',
    kind: 'image',
    label: '图像模型 2',
    platform: '平台图像通道',
    // 文生图 2026-11-17 / 11-18 真调过（含 9:16、16:9）；参考图走 /images/edits，这轮没真调过
    verified: true,
    referenceVerified: false,
    modes: IMAGE_MODES,
    ratios: Object.keys(IMAGE_SIZES),
    durations: [],
    resolutions: [],
    credits: () => Number(config.credits.prices.image_gen) || 5,
  },
  {
    id: 'seedance-2.0',
    kind: 'video',
    label: '视频模型 2',
    platform: '平台视频通道',
    verified: true,
    referenceVerified: false,
    modes: VIDEO_MODES,
    ratios: VIDEO_RATIOS,
    durations: VIDEO_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    credits: () => Number(config.credits.prices.video_gen) || 15,
  },
  {
    id: 'seedance-2.0-fast',
    kind: 'video',
    label: '视频模型 2 · 极速',
    platform: '平台视频通道',
    verified: false,
    referenceVerified: false,
    modes: VIDEO_MODES,
    ratios: VIDEO_RATIOS,
    durations: VIDEO_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    credits: () => Number(config.credits.prices.video_gen) || 15,
  },
]

/** 某个能力下的默认模型：优先取统一路由定下的主模型，没定就用表里第一个。 */
export function defaultModelFor(kind) {
  const primary = primaryRouteFor(kind === 'image' ? 'image' : 'video')
  const specs = MEDIA_MODEL_SPECS.filter((item) => item.kind === kind)
  const matched = primary && specs.find((item) => item.id.toLowerCase() === String(primary.model).toLowerCase())
  return (matched || specs[0] || {}).id || ''
}

export function findModel(kind, modelId) {
  const id = String(modelId || '').trim()
  if (!id) return null
  return MEDIA_MODEL_SPECS.find((item) => item.kind === kind && item.id.toLowerCase() === id.toLowerCase()) || null
}

/** 给界面的形状：不带函数，也不带任何上游地址与 Key 信息。 */
export function publicModel(spec) {
  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    platform: spec.platform,
    verified: Boolean(spec.verified),
    referenceVerified: Boolean(spec.referenceVerified),
    modes: spec.modes.map((mode) => ({
      id: mode.id,
      label: mode.label,
      hint: mode.hint,
      minRefs: mode.minRefs,
      maxRefs: mode.maxRefs,
      imageRefs: mode.imageRefs,
      videoRefs: mode.videoRefs,
    })),
    ratios: spec.ratios.slice(),
    durations: spec.durations.slice(),
    resolutions: spec.resolutions.slice(),
    credits: spec.credits(),
  }
}

/** 界面要画的下拉内容：按能力分组，图片一组、视频一组。 */
export function listMediaModels() {
  const image = MEDIA_MODEL_SPECS.filter((item) => item.kind === 'image').map(publicModel)
  const video = MEDIA_MODEL_SPECS.filter((item) => item.kind === 'video').map(publicModel)
  return {
    image,
    video,
    defaults: { image: defaultModelFor('image'), video: defaultModelFor('video') },
    limits: { imageRefs: SEEDANCE_IMAGE_REFS, videoRefs: SEEDANCE_VIDEO_REFS },
  }
}

function invalid(message, code = 'MEDIA_PARAMS') {
  return Object.assign(new Error(message), { status: 400, code })
}

/**
 * 把一次生成请求收敛成「模型 + 生成方式 + 参数 + 参考素材 id」。
 * 界面上的每个控件都对应这里的一条校验；校验不过就 400，别把不合规的请求发给上游去撞。
 * 参考素材是图片还是视频、个数对不对，等路由把素材读出来再按 mode 的 imageRefs/videoRefs 判。
 */
export function resolveSelection(input = {}) {
  const kind = input.kind
  if (kind !== 'image' && kind !== 'video') throw invalid('kind 只能是 image 或 video', 'MEDIA_KIND')

  const modelId = String(input.model || '').trim() || defaultModelFor(kind)
  const spec = findModel(kind, modelId)
  if (!spec) {
    throw invalid(
      '这个模型不在可用的' + (kind === 'image' ? '图片' : '视频') + '模型里：' + (modelId || '（空）'),
      'MEDIA_MODEL',
    )
  }

  const modeId = String(input.mode || '').trim() || spec.modes[0].id
  const mode = spec.modes.find((item) => item.id === modeId)
  if (!mode) throw invalid('这个模型没有这种生成方式：' + modeId, 'MEDIA_MODE')

  const assetIds = (Array.isArray(input.assets) ? input.assets : [])
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  if (assetIds.length > ASSET_REF_CAP) throw invalid('参考素材最多 ' + ASSET_REF_CAP + ' 个', 'MEDIA_ASSETS')
  if (new Set(assetIds).size !== assetIds.length) throw invalid('同一个参考素材不要重复添加', 'MEDIA_ASSETS')
  if (assetIds.length < mode.minRefs) throw invalid('「' + mode.label + '」需要先加参考素材', 'MEDIA_ASSETS_REQUIRED')
  if (assetIds.length > mode.maxRefs && mode.maxRefs > 0) {
    throw invalid('「' + mode.label + '」最多 ' + mode.maxRefs + ' 个参考素材', 'MEDIA_ASSETS_TOO_MANY')
  }
  if (mode.maxRefs === 0 && assetIds.length) throw invalid('「' + mode.label + '」不接受参考素材', 'MEDIA_ASSETS_UNEXPECTED')

  if (kind === 'image') {
    const ratio = String(input.ratio || '1:1')
    if (!spec.ratios.includes(ratio)) throw invalid('比例只能是 ' + spec.ratios.join('、'), 'MEDIA_RATIO')
    return {
      kind,
      spec,
      model: spec.id,
      mode: mode.id,
      modeSpec: mode,
      ratio,
      size: IMAGE_SIZES[ratio],
      duration: null,
      resolution: '',
      credits: spec.credits(),
      assetIds,
    }
  }

  const duration = Number(input.duration === undefined ? 4 : input.duration)
  if (!spec.durations.includes(duration)) {
    throw invalid('视频时长只能是 ' + spec.durations.map((item) => item + ' 秒').join('、'), 'MEDIA_DURATION')
  }
  const resolution = String(input.resolution || '720p')
  if (!spec.resolutions.includes(resolution)) throw invalid('分辨率只能是 ' + spec.resolutions.join('、'), 'MEDIA_RESOLUTION')
  const ratio = String(input.ratio || '9:16')
  if (!spec.ratios.includes(ratio)) throw invalid('视频比例只能是 ' + spec.ratios.join('、'), 'MEDIA_RATIO')
  return {
    kind,
    spec,
    model: spec.id,
    mode: mode.id,
    modeSpec: mode,
    ratio,
    size: '',
    duration,
    resolution,
    credits: spec.credits(),
    assetIds,
  }
}
