import { config, visionEnabled } from './config.mjs'
import { AGENT_TOOLS } from './agents.mjs'
import { callTextModel, llmEnabled, modelChain } from './llm.mjs'

// 智能体对话：消息构造 + 输出类型约束在这里，真正的模型调用复用 llm.mjs 的
// 「单模型 2 次重试 + 候选模型降级链」；这里只负责把上游错误翻译成
// 「模型名 + 状态码 + 建议」的结构化错误，交给路由原样返回。
export const OUTPUT_TYPES = [
  { id: '脚本', label: '脚本', instruction: '输出短视频口播脚本：按段落写，标注每段时长与画面提示，全文控制在 400 字以内。' },
  { id: '分镜', label: '分镜', instruction: '输出分镜表：用 Markdown 表格，列为 镜头号 / 时长 / 景别 / 画面 / 台词或字幕。' },
  { id: '评审', label: '评审', instruction: '输出评审结论：先给「通过 / 待确认 / 问题」三类结论，再逐条给证据与修改建议。' },
  { id: '文案', label: '文案', instruction: '输出可直接投放的短文案：给 3 条备选，每条不超过 60 字，附一句投放建议。' },
]

export function availableModels() {
  return [...new Set(modelChain().map((item) => String(item || '').trim()).filter(Boolean))]
}

export function modelCandidates(requested) {
  const chain = availableModels()
  const wanted = String(requested || '').trim()
  return [...new Set((wanted ? [wanted, ...chain] : chain).filter(Boolean))]
}

function chatError(code, httpStatus, message, extra = {}) {
  return Object.assign(new Error(message), { code, httpStatus, ...extra })
}

function upstreamStatusSuggestion(status) {
  if (status === 401 || status === 403) return '凭证无效或无权限：检查 .env 的 VISION_API_KEY，或本机 ~/.codex/auth.json 是否过期。'
  if (status === 404) return '模型名不存在：访问 ' + config.vision.baseUrl + '/models 查看可用模型，再在智能体里改模型。'
  if (status === 429) return '上游限流：等待一会儿再重试，或在参数行换一个模型。'
  if (status >= 500) return '上游模型服务异常：稍后重试，或换一个候选模型。'
  return '检查请求参数（模型名、温度、max_tokens）后重试。'
}

function upstreamCode(status) {
  if (status === 401 || status === 403) return 'MODEL_AUTH'
  if (status === 404) return 'MODEL_NOT_FOUND'
  if (status === 429) return 'RATE_LIMIT'
  return 'UPSTREAM'
}

// llm.mjs 的错误只有 message（含模型名与 HTTP 状态码），这里按内容分类补上 status 与建议。
function translateUpstreamError(error, attempted) {
  const message = String(error?.message || error)
  if (error?.code === 'NO_MODEL') {
    return chatError('NO_MODEL', 503, message, {
      suggestion: '在项目 .env 里配置 VISION_API_KEY，或确认本机 ~/.codex/auth.json 存在；配置后需要重启 API。',
      attempted,
    })
  }
  if (error?.name === 'AbortError' || /abort|timed? ?out|超时/i.test(message)) {
    return chatError('TIMEOUT', 504, '模型调用超时：' + message, {
      suggestion: '缩短输入或换更快的模型；也可以调大 VISION_TIMEOUT_MS 后重试。',
      attempted,
    })
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ENETUNREACH|network/i.test(message)) {
    return chatError('NETWORK', 502, '无法连接本地模型端点 ' + config.vision.baseUrl + '：' + message, {
      suggestion: '确认 OpenCodex 在 127.0.0.1:10100 运行，或检查 .env 里的 VISION_BASE_URL。',
      attempted,
    })
  }
  const statusMatch = message.match(/HTTP (\d{3})/)
  if (statusMatch) {
    const status = Number(statusMatch[1])
    return chatError(upstreamCode(status), status === 429 ? 429 : 502, message, {
      suggestion: upstreamStatusSuggestion(status),
      retryable: status === 429 || status >= 500,
      upstreamStatus: status,
      attempted,
    })
  }
  if (/没有返回内容/.test(message)) {
    return chatError('EMPTY', 502, message, {
      suggestion: '换一个模型重试；如果多次为空，检查 OpenCodex 里该模型的可用状态。',
      attempted,
    })
  }
  return chatError('UPSTREAM', 502, message, {
    suggestion: '检查模型名与本地模型端点后重试。',
    attempted,
  })
}

function buildMessages(agent, message, outputType) {
  const type = OUTPUT_TYPES.find((item) => item.id === outputType) || OUTPUT_TYPES[0]
  const knowledge = (agent.knowledge || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((item, index) => index + 1 + '. ' + item)
    .join('\n')
  const tools = (agent.tools || [])
    .map((id) => AGENT_TOOLS.find((tool) => tool.id === id))
    .filter(Boolean)
    .map((tool) => tool.label + '（' + tool.description + '）')
  const system = [
    '你是「' + agent.name + '」，一个' + agent.category + '方向的创作智能体。',
    '职责：' + agent.role,
    '',
    '行为规则：',
    '- 直接产出可用的成品，不要复述任务，不要解释你在扮演什么。',
    '- 只使用用户给出的信息和下面的知识；缺什么就写「待确认」，不要编造事实、数据或客户案例。',
    '- 用简体中文回答，结构清楚，避免营销套话。',
    knowledge ? '\n知识库（优先级高于模型常识）：\n' + knowledge : '',
    tools.length ? '\n可以覆盖的能力（本次对话不自动执行工具）：' + tools.join('；') : '',
    '',
    '系统提示词：',
    String(agent.systemPrompt || '').trim(),
    '',
    '本次输出类型：' + type.label + '。' + type.instruction,
    '如果本次输出类型与系统提示词的结构要求冲突，以本次输出类型为准；语气、知识与禁止项仍然遵守系统提示词。',
  ]
    .filter(Boolean)
    .join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: message },
  ]
}

export async function chatWithAgent({ agent, message, outputType, model, log }) {
  if (!llmEnabled() || !visionEnabled()) {
    throw chatError('NO_MODEL', 503, '服务端没有可用的模型凭证，无法调用本地模型', {
      suggestion: '在项目 .env 里配置 VISION_API_KEY，或确认本机 ~/.codex/auth.json 存在；配置后需要重启 API。',
    })
  }
  const candidates = modelCandidates(model)
  if (!candidates.length) {
    throw chatError('NO_MODEL', 503, '没有配置任何候选模型', {
      suggestion: '在 .env 里设置 VISION_MODEL 与 VISION_FALLBACKS 后重启 API。',
    })
  }
  const messages = buildMessages(agent, message, outputType)
  const temperature = Math.max(0, Math.min(1, Number(agent.temperature ?? 0.4)))
  const startedAt = Date.now()
  try {
    log?.('调用模型（输出类型：' + outputType + '，温度：' + temperature + '）')
    const result = await callTextModel(messages, {
      temperature,
      maxTokens: 1800,
      models: candidates,
      log,
    })
    return {
      reply: result.text,
      model: result.model,
      latencyMs: Date.now() - startedAt,
      usage: null,
      attempted: candidates,
      temperature,
    }
  } catch (error) {
    log?.('对话失败：' + String(error?.message || error).slice(0, 200))
    throw translateUpstreamError(error, candidates)
  }
}