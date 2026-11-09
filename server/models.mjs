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
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      label: id,
      provider: id.includes('/') ? id.split('/')[0] : 'vision',
      // kind 给界面区分「能读图的」和「只能聊天的」，避免拿纯文本模型去跑抽帧评审
      kind: textSet.has(id) && !visionSet.has(id) ? 'text' : 'multimodal',
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
      ? '在服务器 .env 里改 VISION_MODELS / LLM_MODEL 可以增删模型，重启服务后这里自动更新。'
      : '还没有配置模型：在服务器 .env 里加 VISION_MODELS=模型A,模型B（配合 VISION_BASE_URL / VISION_API_KEY），重启服务后模型会出现在这个下拉框里。',
  }
}
