import { config, visionEnabled } from './config.mjs'
import { vaultModels } from './keyvault.mjs'

function splitList(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * 对外口径的产品 id 前缀（r343）：普通用户能看到的接口里只有这几个名字。
 * 上游厂牌名与内部型号（deepseek-flash 这类）只留在服务端配置、Key 池与请求里，
 * 一律不出接口——界面、DevTools、.env 之外都看不到。与 media-models 的 visionqa-* 同一个习惯。
 */
const PUBLIC_BASE = { text: 'visionqa-chat', vision: 'visionqa-vision', both: 'visionqa-general' }

/**
 * 模型清单的唯一推导（配置 + Key 池声明）。这里同时给出「内部模型名」与「对外产品 id」，
 * 别处不要再写第二份：换模型只改 .env / Key 池，编号与标签自动跟着变。
 * 同类（对话 / 视觉 / 通用）多于一个时按出现顺序加序号，第二个就是 -2。
 */
function modelRows() {
  const explicit = splitList(process.env.VISION_MODELS)
  // 后台 Key 池里声明的模型也要出现在下拉框里，管理员加 Key 后前端自动看到新模型
  const textIds = [...new Set([...splitList([config.llm.model, ...config.llm.fallbacks].join(',')), ...vaultModels('text')])]
  const visionIds = [...new Set([...splitList([config.vision.model, ...config.vision.fallbacks].join(',')), ...vaultModels('vision')])]
  const textSet = new Set(textIds)
  const visionSet = new Set(visionIds)
  const ids = explicit.length ? explicit : [...textIds, ...visionIds]

  const seen = new Set()
  const rows = []
  const counters = {}
  for (const internal of ids) {
    if (seen.has(internal)) continue
    seen.add(internal)
    // kind 给界面区分「能读图的」和「只能聊天的」，避免拿纯文本模型去跑抽帧评审
    const isText = textSet.has(internal)
    const isVision = visionSet.has(internal)
    const kind = isText && !isVision ? 'text' : 'multimodal'
    // both = 既能读图也能聊；text / vision 各自单独成口径
    const labelKey = isText ? (isVision ? 'both' : 'text') : 'vision'
    counters[labelKey] = (counters[labelKey] || 0) + 1
    const index = counters[labelKey]
    const labelBase = labelKey === 'text' ? 'VisionQA 对话模型' : labelKey === 'vision' ? 'VisionQA 视觉模型' : 'VisionQA 通用模型'
    rows.push({
      id: index === 1 ? PUBLIC_BASE[labelKey] : PUBLIC_BASE[labelKey] + '-' + index,
      internal,
      label: index === 1 ? labelBase : labelBase + ' ' + index,
      labelKey,
      kind,
    })
  }
  return rows
}

/**
 * 模型清单（只读）。唯一真源是服务端环境变量：
 *   LLM_MODEL / LLM_FALLBACKS        纯文本：智能体对话、模板标题
 *   VISION_MODEL / VISION_FALLBACKS  多模态：抽帧评审（必须能读图）
 *   VISION_MODELS                    界面上要展示的候选清单；不填就由上面两组推导
 * 加模型 = 改 .env + 重启 visionqa，前端下拉框自动出现，代码里没有第二处要改。
 */
export function modelCatalog() {
  const rows = modelRows()
  return {
    current: publicModelName(config.llm.model),
    textModel: publicModelName(config.llm.model),
    visionModel: publicModelName(config.vision.model || config.llm.model),
    models: rows.map((row) => ({
      id: row.id,
      label: row.label,
      provider: row.labelKey,
      kind: row.kind,
      ready: visionEnabled(),
    })),
    configured: visionEnabled(),
    source: process.env.VISION_MODELS && splitList(process.env.VISION_MODELS).length ? 'VISION_MODELS' : config.vision.model ? 'VISION_MODEL' : 'none',
    hint: rows.length
      ? '模型清单由服务端维护，服务端更新后这里自动同步，前端不写死任何模型名。'
      : '模型服务还没有接入：管理员在服务端配置后，可选模型会出现在这个下拉框里。',
  }
}

/**
 * 内部模型名 → 对外的产品 id。不在清单里的（画布的图片 / 视频模型等）原样返回：
 * 那些 id 本来就已经是产品名，没必要、也不该在这里兜一层。
 */
export function publicModelName(internal) {
  const name = String(internal || '').trim()
  if (!name) return ''
  const row = modelRows().find((item) => item.internal === name)
  return row ? row.id : name
}

// 认不出来的名字也要挡一道：上游型号形态（xxx-flash / xxx-pro）与厂牌词一律不许出现在界面上。
const VENDORISH = /deepseek|qwen|doubao|gpt-|claude|gemini|glm|kimi|moonshot|zhipu|minimax|grok|xai|seedream|kling|codex|workbuddy|[a-z0-9]-(flash|pro|turbo|luna|mini)\b/i

/**
 * 给界面显示用的模型名（r343）：清单里的换成产品 id，认不出的**也不能把厂牌漏出去**——
 * 这种情况回一句「VisionQA 通用模型」，宁可少一个信息点，也不把上游型号写在消息卡片上。
 */
export function publicDisplayName(value) {
  const name = publicModelName(value)
  if (!name) return ''
  if (/^visionqa-/.test(name)) return name
  return VENDORISH.test(name) ? 'VisionQA 通用模型' : name
}

/**
 * 对外 id（或老数据里存的内部名）→ 内部模型名。
 * 认不出来就原样返回：旧偏好、旧智能体记录里可能存着内部名，不能因为改名就让它们失效。
 */
export function internalModelName(value) {
  const name = String(value || '').trim()
  if (!name) return ''
  const rows = modelRows()
  const hit = rows.find((item) => item.id === name) || rows.find((item) => item.internal === name)
  return hit ? hit.internal : name
}
