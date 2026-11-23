// 快捷创作 / 工作流能用哪些生成模型、每个模型支持什么：这张表是界面下拉与接口校验的唯一真源。
//
// 为什么要有这张表（而不是前端写死几个选项）：
//  1) 界面能选什么，必须等于「服务端真的能发出去什么」——前端多摆一个选项，用户就白花一次积分；
//  2) 出图 / 出视频的规格（比例、时长、清晰度、最多几个参考）每个模型都不一样，
//     校验只能放在服务端，界面照这张表画控件才不会自相矛盾；
//  3) 后台换了 Key、换了大模型，改这里一处就够，不用两头对。
//
// r298（2026-11-23 用户定）：界面只露「一个显示模型」，底下几条上游通道自动兜底。
//  - 快捷创作图片只有 VisionQA通用图片模型 → 默认最便宜的 GeteAPI gpt-image-2.6，
//    失败换 2.5、再换 2（同一个显示模型，不给用户第二种名字）；
//  - 快捷创作视频只有 VisionQA通用视频模型 → 默认 SeeAPI seedance-2.0-fast，失败换 seedance-2.0；
//  - 价钱不写死：按上游成本 × 1.1 算（server/media-pricing.mjs）。
//
// 诚实口径：
//  - verified=false 表示这条通道**没有真调过**（生产真调过 gpt-image-2 文生图、
//    seedance-2.0 的 4s/8s、480p/720p），界面上要照实标，不能装作验过；
//  - 老记录里存的是上游 id（gpt-image-2 / seedance-2.0），findModel 照样认，不用迁数据。
import { primaryRouteFor } from './model-routes.mjs'
import { imageCredits, videoCredits, videoPriceTable } from './media-pricing.mjs'

// 图片比例对应到上游的 size：与 v0.9.165 起真调过的三个尺寸一致，不凭空加尺寸。
export const IMAGE_SIZES = {
  '1:1': '1024x1024',
  '9:16': '1024x1536',
  '16:9': '1536x1024',
}

/**
 * 用户自己写死的比例 → 上游的 size（r293）。
 *
 * 为什么要有这条：表里那三档是「真调过」的，但用户会在提示词里直接写死尺寸
 * （「4:5」「2048x2048」）。既然他明确写了，就不该被悄悄改成 1:1 —— 按他写的提交，
 * 上游不认就失败全额退回，并在卡片上说清上游到底收哪几档。
 */
export function sizeFromRatio(ratio, longSide = 1536) {
  const matched = /^(\d{1,2}):(\d{1,2})$/.exec(String(ratio || '').trim())
  if (!matched) return ''
  const a = Number(matched[1])
  const b = Number(matched[2])
  if (!a || !b || a > 64 || b > 64) return ''
  const long = Math.max(a, b)
  const round8 = (value) => Math.min(4096, Math.max(64, Math.round(value / 8) * 8))
  return round8((a / long) * longSide) + 'x' + round8((b / long) * longSide)
}

/** 「2048x2048」「2048×2048」「2048 * 2048」都认；不是这种形状就回空，交给比例那条路。 */
export function normalizeSize(value) {
  const matched = /^(\d{2,4})\s*[x×*]\s*(\d{2,4})$/i.exec(String(value || '').trim())
  if (!matched) return ''
  const w = Number(matched[1])
  const h = Number(matched[2])
  if (!w || !h || w < 64 || h < 64 || w > 4096 || h > 4096) return ''
  return w + 'x' + h
}

export function normalizeRatio(value) {
  const matched = /^(\d{1,2})\s*:\s*(\d{1,2})$/.exec(String(value || '').trim())
  if (!matched) return ''
  const a = Number(matched[1])
  const b = Number(matched[2])
  if (!a || !b || a > 64 || b > 64) return ''
  return a + ':' + b
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

// ── 显示模型 ↔ 通道 ───────────────────────────────────────────────────────
// 用户在界面上看到的是「一个模型」，底下可能有好几条上游通道（不同平台 / 不同 Key /
// 不同上游模型名，价钱也不一样）。这里只写「哪个显示模型由哪几条通道兜底」，不写 Key：
// Key 与 baseUrl 都在后台的 Key 池里，换通道不用改代码。
export const IMAGE_CHAIN = ['gpt-image-2.6', 'gpt-image-2.5', 'gpt-image-2']
export const VIDEO_CHAIN = ['seedance-2.0-fast', 'seedance-2.0']
export const DISPLAY_LABELS = {
  'visionqa-image': 'VisionQA通用图片模型',
  'visionqa-video': 'VisionQA通用视频模型',
}
export const DISPLAY_IDS = { image: 'visionqa-image', video: 'visionqa-video' }

const CHANNEL_LABELS = {
  'gpt-image-2.6': 'GeteAPI · gpt-image-2.6',
  'gpt-image-2.5': 'GeteAPI · gpt-image-2.5（备用）',
  'gpt-image-2': 'GeteAPI · gpt-image-2（备用）',
  'seedance-2.0-fast': 'SeeAPI · seedance-2.0-fast',
  'seedance-2.0': 'SeeAPI · seedance-2.0（备用）',
}

function makeSpec({ id, kind, display, verified, referenceVerified }) {
  const durations = kind === 'video' ? VIDEO_DURATIONS.slice() : []
  const resolutions = kind === 'video' ? VIDEO_RESOLUTIONS.slice() : []
  return {
    id,
    kind,
    display,
    label: DISPLAY_LABELS[display],
    platform: kind === 'image' ? '平台图像通道' : '平台视频通道',
    upstreamLabel: CHANNEL_LABELS[id] || id,
    verified: Boolean(verified),
    referenceVerified: Boolean(referenceVerified),
    modes: kind === 'image' ? IMAGE_MODES : VIDEO_MODES,
    ratios: kind === 'image' ? Object.keys(IMAGE_SIZES) : VIDEO_RATIOS.slice(),
    durations,
    resolutions,
    // 价钱一律按这条通道的上游成本算：图片按张，视频按「秒 × 清晰度」
    credits: (selection = {}) =>
      kind === 'image'
        ? imageCredits(id)
        : videoCredits(id, Number(selection.duration) || durations[0], selection.resolution || resolutions[0]),
  }
}

export const MEDIA_MODEL_SPECS = [
  // 图片：2.6 最便宜（$0.028），2.5 / 2 同价（$0.048）作备用
  makeSpec({ id: 'gpt-image-2.6', kind: 'image', display: 'visionqa-image', verified: false, referenceVerified: false }),
  makeSpec({ id: 'gpt-image-2.5', kind: 'image', display: 'visionqa-image', verified: false, referenceVerified: false }),
  makeSpec({ id: 'gpt-image-2', kind: 'image', display: 'visionqa-image', verified: true, referenceVerified: false }),
  // 视频：fast 最便宜，seedance-2.0 作备用（2026-11-18 真调过 4s/8s、480p/720p）
  makeSpec({ id: 'seedance-2.0-fast', kind: 'video', display: 'visionqa-video', verified: false, referenceVerified: false }),
  makeSpec({ id: 'seedance-2.0', kind: 'video', display: 'visionqa-video', verified: true, referenceVerified: false }),
]

/**
 * 一个显示模型底下按价钱从便宜到贵排好的通道。
 * 传上游 id（老记录里的 gpt-image-2）也能找回同一个显示模型，不迁数据。
 */
export function chainFor(kind) {
  const specs = MEDIA_MODEL_SPECS.filter((item) => item.kind === kind)
  const order = kind === 'image' ? IMAGE_CHAIN : VIDEO_CHAIN
  const byId = new Map(specs.map((item) => [item.id.toLowerCase(), item]))
  return order.map((id) => byId.get(id.toLowerCase())).filter(Boolean)
}

/** 某项能力的显示模型 id：快捷创作的下拉里只有这一个。 */
export function defaultModelFor(kind) {
  const display = DISPLAY_IDS[kind === 'image' ? 'image' : 'video']
  const primary = primaryRouteFor(kind === 'image' ? 'image' : 'video')
  // 统一路由还指着某条老上游 id 时也认：这类记录一旦出现，仍归到同一个显示模型
  return primary && primary.model && String(primary.model).startsWith('visionqa-') ? String(primary.model) : display
}

/** 显示模型 id 或任一上游 id → 主通道（最便宜那条）。 */
export function findModel(kind, modelId) {
  const id = String(modelId || '').trim().toLowerCase()
  if (!id) return null
  const specs = MEDIA_MODEL_SPECS.filter((item) => item.kind === kind)
  const matched = specs.find((item) => item.display === id) || specs.find((item) => item.id.toLowerCase() === id)
  if (matched) return chainFor(kind)[0] || matched
  return null
}

/** 给界面的形状：不带函数，也不带任何上游地址与 Key 信息。 */
export function publicModel(spec) {
  const chain = chainFor(spec.kind, spec.display)
  const priceTable = spec.kind === 'video' ? videoPriceTable(spec.id, spec.durations, spec.resolutions) : {}
  const base = spec.kind === 'image'
    ? imageCredits(spec.id)
    : videoCredits(spec.id, spec.durations[0], spec.resolutions[0])
  return {
    id: spec.display,
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
    credits: base,
    // 视频按秒算钱：每个「时长 × 清晰度」的价一次给全（key 形如 "8|720p"），界面不用自己乘
    priceTable,
    // 后台用：这个显示模型底下有几条通道兜底（不暴露通道名与 Key）
    channelCount: chain.length,
  }
}

/** 界面要画的下拉内容：按能力分组，图片一组、视频一组，各只有一个显示模型。 */
export function listMediaModels() {
  const image = chainFor('image').slice(0, 1).map(publicModel)
  const video = chainFor('video').slice(0, 1).map(publicModel)
  return {
    image,
    video,
    defaults: { image: DISPLAY_IDS.image, video: DISPLAY_IDS.video },
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

  // r293：locked = 用户在提示词里明确写死的参数（比例 / 尺寸 / 秒数 / 清晰度）。
  // 写死的一律按原样提交，不再被默认档位顶掉——上游不认就失败全额退回，由界面说清上游收哪几档。
  const locked = input.locked && typeof input.locked === 'object' ? input.locked : {}
  const lockedOut = {}

  if (kind === 'image') {
    // 只有 locked 的值才越过白名单：界面下拉传的就是表里的档位，走到白名单外说明是拼错了。
    const wantSize = locked.size ? normalizeSize(input.size) || normalizeSize(locked.size) : ''
    const wantRatio = normalizeRatio(input.ratio) || normalizeRatio(locked.ratio)
    const ratio = wantRatio || '1:1'
    let size = ''
    if (wantSize) {
      size = wantSize
      lockedOut.size = true
    } else if (spec.ratios.includes(ratio)) {
      size = IMAGE_SIZES[ratio]
    } else if (locked.ratio && wantRatio) {
      // 表里没有这档比例，但用户写死了：按比例算一个尺寸交上去（长边与 1024x1536 同档）
      size = sizeFromRatio(ratio)
      lockedOut.ratio = true
    }
    if (!size) throw invalid('比例只能是 ' + spec.ratios.join('、'), 'MEDIA_RATIO')
    return {
      kind,
      spec,
      model: spec.display,
      modelLabel: spec.label,
      upstream: spec.id,
      chain: chainFor(kind).map((item) => item.id),
      mode: mode.id,
      modeSpec: mode,
      ratio,
      size,
      duration: null,
      resolution: '',
      credits: spec.credits(),
      assetIds,
      locked: lockedOut,
    }
  }

  const wantDuration = input.duration === undefined || input.duration === null || input.duration === '' ? null : Number(input.duration)
  let duration = wantDuration === null ? spec.durations[0] : wantDuration
  if (!Number.isInteger(duration) || duration < 1 || duration > 60) {
    throw invalid('视频时长只能是 ' + spec.durations.map((item) => item + ' 秒').join('、') + '（写死的秒数要在 1–60 之间）', 'MEDIA_DURATION')
  }
  if (!spec.durations.includes(duration)) {
    if (!locked.duration) throw invalid('视频时长只能是 ' + spec.durations.map((item) => item + ' 秒').join('、'), 'MEDIA_DURATION')
    lockedOut.duration = true
  }
  const wantResolution = String(input.resolution || '').trim().toLowerCase()
  const resolution = wantResolution || spec.resolutions[0]
  if (!/^\d{3,4}p$/.test(resolution)) throw invalid('分辨率只能是 ' + spec.resolutions.join('、'), 'MEDIA_RESOLUTION')
  if (!spec.resolutions.includes(resolution)) {
    // 界面下拉传的就是表里的值，走到这里说明是用户写死的：认下来，原样提交
    if (!locked.resolution) throw invalid('分辨率只能是 ' + spec.resolutions.join('、'), 'MEDIA_RESOLUTION')
    lockedOut.resolution = true
  }
  const wantRatio = normalizeRatio(input.ratio) || normalizeRatio(locked.ratio)
  const ratio = wantRatio || spec.ratios[0]
  if (!spec.ratios.includes(ratio)) {
    if (!locked.ratio) throw invalid('视频比例只能是 ' + spec.ratios.join('、'), 'MEDIA_RATIO')
    lockedOut.ratio = true
  }
  return {
    kind,
    spec,
    model: spec.display,
    upstream: spec.id,
    chain: chainFor(kind).map((item) => item.id),
    mode: mode.id,
    modeSpec: mode,
    ratio,
    size: '',
    duration,
    resolution,
    credits: spec.credits({ duration, resolution }),
    assetIds,
    locked: lockedOut,
  }
}
