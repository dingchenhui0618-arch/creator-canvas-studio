import { config, visionEnabled } from './config.mjs'

function splitList(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * 模型清单（只读）。唯一真源是服务端环境变量：
 *   LLM_MODEL / LLM_FALLBACKS        纯文本：智能体对话、模板标题
 *   VISION_MODEL / VISION_FALLBACKS  多模态：抽帧评审（必须能读图）
 *   VISION_MODELS                    界面上要展示的候选清单；不填就由上面两组推导
 * 加模型 = 改 .env + 重启 visionqa，前端下拉框自动出现，代码里没有第二处要改。
 */
export function modelCatalog() {
  const explicit = splitList(process.env.VISION_MODELS)
  const textIds = splitList([config.llm.model, ...config.llm.fallbacks].join(','))
  const visionIds = splitList([config.vision.model, ...config.vision.fallbacks].join(','))
  const textSet = new Set(textIds)
  const visionSet = new Set(visionIds)
  const ids = explicit.length ? explicit : [...textIds, ...visionIds]

  const seen = new Set()
  const models = []
  // 界面口径不写上游厂商名：模型一律以 VisionQA 的产品名称展示，id 仍留给请求与配置。
  const counters = {}
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    // kind 给界面区分「能读图的」和「只能聊天的」，避免拿纯文本模型去跑抽帧评审
    const isText = textSet.has(id)
    const isVision = visionSet.has(id)
    const kind = isText && !isVision ? 'text' : 'multimodal'
    // both = 既能读图也能聊；text / vision 各自单独成口径
    const labelKey = isText ? (isVision ? 'both' : 'text') : 'vision'
    counters[labelKey] = (counters[labelKey] || 0) + 1
    const base = labelKey === 'text' ? 'VisionQA 对话模型' : labelKey === 'vision' ? 'VisionQA 视觉模型' : 'VisionQA 通用模型'
    models.push({
      id,
      label: counters[labelKey] === 1 ? base : base + ' ' + counters[labelKey],
      provider: labelKey,
      kind,
      ready: visionEnabled(),
    })
  }

  return {
    current: config.llm.model || models[0]?.id || '',
    textModel: config.llm.model,
    visionModel: config.vision.model,
    models,
    configured: visionEnabled(),
    source: explicit.length ? 'VISION_MODELS' : config.vision.model ? 'VISION_MODEL' : 'none',
    hint: models.length
      ? '模型清单由服务端维护，服务端更新后这里自动同步，前端不写死任何模型名。'
      : '模型服务还没有接入：管理员在服务端配置后，可选模型会出现在这个下拉框里。',
  }
}
