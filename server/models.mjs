import { config, visionEnabled } from './config.mjs'

function splitList(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * 模型清单。唯一真源是服务端环境变量，前端只负责展示和选择：
 *   VISION_MODELS=a,b,c        首选排在最前；不填就用 VISION_MODEL + VISION_FALLBACKS
 * 想加模型：改 .env → 重启 visionqa → 界面上的下拉框自动出现，不用改前端代码。
 */
export function modelCatalog() {
  const explicit = splitList(process.env.VISION_MODELS)
  const fallbacks = splitList(process.env.VISION_FALLBACKS)
  const ids = explicit.length ? explicit : [config.vision.model, ...fallbacks].filter(Boolean)
  const seen = new Set()
  const models = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      label: id,
      provider: id.includes('/') ? id.split('/')[0] : 'vision',
      ready: visionEnabled(),
    })
  }
  return {
    current: config.vision.model || models[0]?.id || '',
    models,
    configured: visionEnabled(),
    source: explicit.length ? 'VISION_MODELS' : config.vision.model ? 'VISION_MODEL' : 'none',
    hint: models.length
      ? '在服务器 .env 里改 VISION_MODELS 可以增删模型，重启服务后这里自动更新。'
      : '还没有配置模型：在服务器 .env 里加 VISION_MODELS=模型A,模型B（配合 VISION_BASE_URL / VISION_API_KEY），重启服务后模型会出现在这个下拉框里。',
  }
}
