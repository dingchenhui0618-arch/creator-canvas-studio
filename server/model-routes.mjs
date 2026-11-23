// 统一路由：一条能力只留一条主路由，其余模型一律降为「仅参考」（不进选择器、不做默认）。
//
// 为什么要这件事：上游两个平台的模型加起来 60 多个，名字相近、价格差好几倍，
// 让用户在下拉框里挑等于让他选错、选贵。所以这里定死「谁是用在线上那一条」，
// 后台「模型与上游」照这张表给模型打「主路由 / 仅参考」，出图出视频的代码也只认主路由。
//
// 三条硬口径：
//   1. 文本与视觉走官方 DeepSeek（配置里的 model），GeteAPI 的文本只做兜底；
//   2. 出图只走 GeteAPI 的 gpt-image-2（画布与快捷创作都一样）；
//   3. 出视频只走 SeeAPI 的 seedance-2.0。
// 改路由就改这张表，别在别处再写一份默认模型。
import { config } from './config.mjs'

/** 平台展示名：与 model-catalog.mjs 的 PLATFORM_META 保持一致。 */
const PLATFORM_LABELS = {
  deepseek: '平台对话模型',
  geteapi: 'GeteAPI',
  seeapi: 'SeeAPI / CGCM',
  ark: '火山方舟',
}

/**
 * 线上唯一在用的路由。
 * source=config 表示模型名来自环境变量（换模型只要改环境变量，不用改代码）。
 */
export function primaryRoutes() {
  const textModel = String(config.llm?.model || 'deepseek-flash')
  const visionModel = String(config.vision?.model || textModel)
  return [
    {
      capability: 'text',
      label: '文本',
      platform: 'deepseek',
      platformLabel: PLATFORM_LABELS.deepseek,
      model: textModel,
      source: 'config',
      usedBy: ['对话', '评审', '改写', '自建对话预设'],
      note: '评审与对话都在它上面。GeteAPI 的 gpt-5.6-luna 只做备用，不在选择器里出现。',
    },
    {
      capability: 'vision',
      label: '视觉',
      platform: 'deepseek',
      platformLabel: PLATFORM_LABELS.deepseek,
      model: visionModel,
      source: 'config',
      usedBy: ['抽帧评审', '看图对话'],
      note: '必须能读图；文本专用模型不能顶替这一条。',
    },
    {
      capability: 'image',
      label: '出图',
      platform: 'geteapi',
      platformLabel: PLATFORM_LABELS.geteapi,
      model: 'gpt-image-2.6',
      source: 'fixed',
      usedBy: ['快捷创作 · 图片', '无限画布出图', '对话预设生图'],
      note: 'GeteAPI 最便宜的 GPT Image（2.6）。2.5 / 2 是同一个显示模型的备用通道，上游拒单时才自动换；界面上只有一个名字。',
    },
    {
      capability: 'video',
      label: '出视频',
      platform: 'seeapi',
      platformLabel: PLATFORM_LABELS.seeapi,
      model: 'seedance-2.0-fast',
      source: 'fixed',
      usedBy: ['快捷创作 · 视频', '无限画布出视频', '对话预设生视频'],
      note: 'SeeAPI 最便宜的 Seedance 2.0 Fast。seedance-2.0 是备用通道；界面上只有一个名字。',
    },
  ]
}

/** 某条能力的主路由；没有就返回 null（比如还没定的能力）。 */
export function primaryRouteFor(capability) {
  return primaryRoutes().find((route) => route.capability === capability) || null
}

/**
 * 判断一个模型在某条能力下是什么身份：
 *   primary   —— 就是线上在用的那一条；
 *   reference —— 同一个能力下的其它模型，仅参考；
 *   other     —— 能力对不上（比如文本模型挂在图片能力下去问）。
 */
export function routeRoleFor(capability, model) {
  const role = primaryRouteFor(capability)
  if (!role) return 'other'
  return String(model || '').toLowerCase() === role.model.toLowerCase() ? 'primary' : 'reference'
}

/** 模型目录每行要带的身份：能力对上主路由就是 primary，否则 reference。 */
export function rowRoute(capability, model) {
  return routeRoleFor(capability, model)
}

/**
 * 汇总给后台看：主路由几条、仅参考多少、每条主路由对应目录里的哪一行（用来贴价格）。
 * rows 来自 model-catalog 的 rows（含 model / capability / offers）。
 */
export function routeSummary(rows = []) {
  const routes = primaryRoutes()
  const byCapability = routes.map((route) => {
    const match = rows.find(
      (row) => row.capability === route.capability && String(row.model).toLowerCase() === route.model.toLowerCase(),
    )
    return {
      ...route,
      inCatalog: Boolean(match),
      price: match?.offers?.[0]?.price || null,
      referenceCount: rows.filter((row) => row.capability === route.capability && row.model !== route.model).length,
    }
  })
  const primaryModels = new Set(routes.map((route) => route.capability + '::' + route.model.toLowerCase()))
  const referenceCount = rows.filter((row) => !primaryModels.has(row.capability + '::' + String(row.model).toLowerCase()))
    .length
  return { routes: byCapability, referenceCount, primaryCount: byCapability.filter((item) => item.inCatalog).length }
}
