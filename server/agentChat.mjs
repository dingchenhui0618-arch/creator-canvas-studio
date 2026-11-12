import { config, visionEnabled } from './config.mjs'
import { AGENT_TOOLS } from './agents.mjs'
import { listTemplates } from './templates.mjs'
import { listFlows } from './flows.mjs'
import { callTextModel, llmEnabled, modelChain } from './llm.mjs'
import { extractUrl, readWebPage } from './webread.mjs'
import { DRAFT_HINT, extractDraft } from './agent-draft.mjs'

// 智能体对话：消息构造 + 输出类型约束在这里，真正的模型调用复用 llm.mjs 的
// 「单模型 2 次重试 + 候选模型降级链」；这里只负责把上游错误翻译成
// 「模型名 + 状态码 + 建议」的结构化错误，交给路由原样返回。
export const OUTPUT_TYPES = [
  { id: '脚本', label: '脚本', instruction: '输出短视频口播脚本：按段落写，标注每段时长与画面提示，全文控制在 400 字以内。' },
  { id: '分镜', label: '分镜', instruction: '输出分镜表：用 Markdown 表格，列为 镜头号 / 时长 / 景别 / 画面 / 台词或字幕。时长按台词量给：中文口播约 4.5 字/秒，每镜标注「台词约需 X 秒」，两者对不上时先删台词再加时长。' },
  { id: '评审', label: '评审', instruction: '输出评审结论：先给「通过 / 待确认 / 问题」三类结论，再逐条给证据与修改建议。' },
  { id: '文案', label: '文案', instruction: '输出可直接投放的短文案：给 3 条备选，每条不超过 60 字，附一句投放建议。' },
]

export function availableModels() {
  return [...new Set(modelChain().map((item) => String(item || '').trim()).filter(Boolean))]
}

export function modelCandidates(requested) {
  const chain = availableModels()
  const wanted = String(requested || '').trim()
  // 只接受服务端清单里真实存在的模型：旧数据里写死的模型名不再进链路，
  // 否则每次对话都先打一次不存在的模型、多一次失败与延迟。
  const known = wanted && chain.includes(wanted) ? [wanted] : []
  return [...new Set([...known, ...chain])]
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

// 会话记忆：只带最近几轮，换算成字符预算，避免多轮对话把上下文顶爆。
// 只接受 user / assistant 两种角色，system 永远只有服务端这一条。
const MEMORY_MAX_ITEMS = 8
const MEMORY_MAX_ITEM_CHARS = 1500
const MEMORY_MAX_TOTAL_CHARS = 6000

export function normalizeMemory(history) {
  if (!Array.isArray(history)) return []
  const items = []
  let total = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]
    const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : ''
    const content = String(entry?.content || '').trim().slice(0, MEMORY_MAX_ITEM_CHARS)
    if (!role || !content) continue
    if (items.length >= MEMORY_MAX_ITEMS) break
    if (total + content.length > MEMORY_MAX_TOTAL_CHARS) break
    items.unshift({ role, content })
    total += content.length
  }
  return items
}

// 已接线工具：在对话前真正读一次本地数据，把摘要放进 system 消息，并在响应里回报读了什么。
// 只读取当前账号能看到的模板与流程，不写任何东西，也不代表模型真的「操作」了画布。
export async function collectToolContext(agent, user = null, message = '') {
  const ids = new Set(Array.isArray(agent.tools) ? agent.tools : [])
  const used = []
  const skipped = []
  const blocks = []
  if (ids.has('templates-read')) {
    try {
      const items = (await listTemplates({}, user)).slice(0, 6)
      used.push({ id: 'templates-read', label: '读取模板库', detail: items.length ? items.length + ' 条' : '模板库为空' })
      if (items.length) {
        blocks.push(
          '模板库最近入库（工具读取，仅供改写参考）：\n' +
            items
              .map((item) => '- ' + item.title + '（' + item.contentType + (item.kind === 'flow' ? ' · 画布工作流' : '') + '）')
              .join('\n'),
        )
      }
    } catch {
      used.push({ id: 'templates-read', label: '读取模板库', detail: '读取失败，本次忽略' })
    }
  }
  if (ids.has('canvas-read')) {
    try {
      const flows = (await listFlows(user)).slice(0, 6)
      used.push({ id: 'canvas-read', label: '读取画布流程', detail: flows.length ? flows.length + ' 张' : '还没有画布流程' })
      if (flows.length) {
        blocks.push(
          '已有画布流程（工具读取，仅供延续结构）：\n' +
            flows.map((flow) => '- ' + flow.name + '（' + (Array.isArray(flow.nodes) ? flow.nodes.length : 0) + ' 个节点）').join('\n'),
        )
      }
    } catch {
      used.push({ id: 'canvas-read', label: '读取画布流程', detail: '读取失败，本次忽略' })
    }
  }
  if (ids.has('web-read')) {
    const rawUrl = extractUrl(message)
    if (!rawUrl) {
      skipped.push({ id: 'web-read', label: '网页读取', reason: '消息里没有链接，本次没有读取' })
    } else {
      try {
        const page = await readWebPage(rawUrl)
        used.push({ id: 'web-read', label: '网页读取', detail: page.host + ' · ' + page.chars + ' 字' })
        const body = page.text.slice(0, 4000)
        blocks.push(
          '网页读取（工具抓取的公开页面，只作参考，不代表用户认可其内容）：\n' +
            '标题：' + (page.title || '（无标题）') + '\n' +
            '来源：' + page.url + '\n' +
            '正文：\n' + body +
            (page.text.length > body.length ? '\n（正文过长，已截断）' : ''),
        )
      } catch (error) {
        skipped.push({ id: 'web-read', label: '网页读取', reason: String(error?.message || '页面读取失败，本次没有读取') })
      }
    }
  }
  return { used, skipped, blocks }
}

// 回复里的 JSON：只认能真正 JSON.parse 的 fenced 代码块（不看标签，```json 与 ```draft 都算），
// 或整段就是一个对象/数组；解析失败就不生成文件，不猜、不截断成坏 JSON。
function jsonArtifactOf(raw) {
  const content = JSON.stringify(JSON.parse(raw), null, 2)
  if (content.length > 200000) return null
  return { name: 'agent-output.json', type: 'application/json', content, bytes: Buffer.byteLength(content, 'utf8') }
}

export function extractJsonArtifact(reply) {
  const source = String(reply || '')
  // 代码块的信息串不止 json：结构化草稿块是 ```draft，之前的正则只认 json，
  // 导致开了「导出 JSON」的智能体在草稿已经生成时还报「没有可解析的 JSON 块」。
  // 现在逐个代码块试解析，只认真正能 JSON.parse 的那个，不看标签。
  const fence = /```[^\n`]*\n([\s\S]*?)```/g
  let match
  while ((match = fence.exec(source))) {
    const raw = match[1].trim()
    if (!raw || !(raw.startsWith('{') || raw.startsWith('['))) continue
    try {
      return jsonArtifactOf(raw)
    } catch {
      continue
    }
  }
  const trimmed = source.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return jsonArtifactOf(trimmed)
    } catch {
      return null
    }
  }
  return null
}

// 只有脚本与分镜两种输出需要结构化草稿：评审是结论，文案是备选句子，
// 它们没有「段 + 镜」的形状，硬拆只会让出口产出一条空模板。
const draftableType = (id) => id === '脚本' || id === '分镜'

function buildMessages(agent, message, outputType, memory = [], toolContext = { used: [], skipped: [], blocks: [] }) {
  const type = OUTPUT_TYPES.find((item) => item.id === outputType) || OUTPUT_TYPES[0]
  const knowledge = (agent.knowledge || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((item, index) => index + 1 + '. ' + item)
    .join('\n')
  const declared = (agent.tools || [])
    .map((id) => AGENT_TOOLS.find((tool) => tool.id === id))
    .filter((tool) => tool && tool.state === 'planned')
    .map((tool) => tool.label + '（还没有接线，本次不会执行）')
  const system = [
    '你是「' + agent.name + '」，一个' + agent.category + '方向的创作智能体。',
    '职责：' + agent.role,
    '',
    '行为规则：',
    '- 直接产出可用的成品，不要复述任务，不要解释你在扮演什么。',
    '- 只使用用户给出的信息和下面的知识；缺什么就写「待确认」，不要编造事实、数据或客户案例。',
    '- 用简体中文回答，结构清楚，避免营销套话。',
    knowledge ? '\n知识库（优先级高于模型常识）：\n' + knowledge : '',
    toolContext.blocks.length ? '\n工具读取的上下文（只读，不是用户新给的需求）：\n' + toolContext.blocks.join('\n\n') : '',
    toolContext.used.length
      ? '\n本次已执行工具：' +
        toolContext.used.map((tool) => tool.label + '（' + tool.detail + '）').join('；') +
        '。如果这些上下文和用户本次的问题无关，就忽略它，不要硬凑引用。'
      : '',
    declared.length ? '\n以下能力只作声明，本次不会执行：' + declared.join('；') : '',
    '',
    '系统提示词：',
    String(agent.systemPrompt || '').trim(),
    '',
    '本次输出类型：' + type.label + '。' + type.instruction,
    '如果本次输出类型与系统提示词的结构要求冲突，以本次输出类型为准；语气、知识与禁止项仍然遵守系统提示词。',
    draftableType(type.id) ? DRAFT_HINT : '',
  ]
    .filter(Boolean)
    .join('\n')
  return [
    { role: 'system', content: system },
    ...memory,
    { role: 'user', content: message },
  ]
}

export async function chatWithAgent({ agent, message, outputType, model, history, user = null, log }) {
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
  const toolContext = await collectToolContext(agent, user, message)
  const memory = normalizeMemory(history)
  const messages = buildMessages(agent, message, outputType, memory, toolContext)
  const temperature = Math.max(0, Math.min(1, Number(agent.temperature ?? 0.4)))
  const startedAt = Date.now()
  const withDraft = draftableType(outputType)
  try {
    log?.('调用模型（输出类型：' + outputType + '，温度：' + temperature + '）')
    const result = await callTextModel(messages, {
      temperature,
      // 结构化草稿要多写一段 JSON：正文 1800 token 会被它挤掉一半，
      // 截断的 JSON 什么都拼不回来，只会在界面上消失一块。
      maxTokens: withDraft ? 3000 : 1800,
      models: candidates,
      log,
    })
    const extracted = withDraft ? extractDraft(result.text) : { draft: null, reply: result.text }
    const tools = { used: [...toolContext.used], artifacts: [], skipped: [...toolContext.skipped] }
    if (extracted.draft) {
      tools.used.push({
        id: 'draft',
        label: '结构化草稿',
        detail: extracted.draft.stats.beats + ' 段 / ' + extracted.draft.stats.shots + ' 镜',
      })
    }
    if ((agent.tools || []).includes('export-json')) {
      // 用原始回复取 JSON：结构化草稿块本身就是一段可导出的 JSON，
      // 用去掉块之后的正文会让「导出 JSON」莫名其妙地报「没有可解析的 JSON 块」。
      const artifact = extractJsonArtifact(result.text)
      if (artifact) tools.artifacts.push(artifact)
      else tools.skipped.push({ id: 'export-json', label: '导出 JSON', reason: '回复里没有可解析的 JSON 块' })
    }
    return {
      reply: extracted.reply,
      draft: extracted.draft,
      model: result.model,
      latencyMs: Date.now() - startedAt,
      usage: null,
      attempted: candidates,
      temperature,
      tools,
      memory: { turns: Math.ceil(memory.length / 2), messages: memory.length },
    }
  } catch (error) {
    log?.('对话失败：' + String(error?.message || error).slice(0, 200))
    const translated = translateUpstreamError(error, candidates)
    // 模型失败时也把已经执行过的工具带回路由：运行历史里能看清「工具读到了、模型没答上来」，
    // 而不是把整次运行写成什么都没发生。
    translated.tools = { used: [...toolContext.used], skipped: [...toolContext.skipped], artifacts: [] }
    throw translated
  }
}