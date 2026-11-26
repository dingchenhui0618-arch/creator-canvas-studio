// 平台智能体的工具（r317，一期 1c）。
//
// 一件事只有一件真源：这里声明「有哪些工具、开没开、能不能给模型用」，
// 房间回合（server/room-agent.mjs）按这份清单拼提示词、按同一份清单执行。
//
// 1c 只开 templates.list 一个：它只读、不花积分、拿不到别人的数据。
// 其余六个先登记、enabled:false，执行时一律回「这个工具还没开」——
// 登记是为了让模型和界面都看得见边界，不是为了假装能用。
//
// 关闭一个已经开的工具：VQ_AGENT_TOOLS_DISABLE=templates.list（逗号分隔）。
// 只能往下关，不能靠环境变量打开一个还没接好的工具——没接就是没接。
import { listTemplates } from './templates.mjs'

const READ = 'read'
const WRITE = 'write'

export const AGENT_TOOL_REGISTRY = [
  {
    id: 'templates.list',
    label: '读模板库',
    mode: READ,
    enabled: true,
    params: '{"limit": 1-10}',
    hint: '列出这个账号最近的模板：标题、类型、来源、钩子。用来对齐风格与结构，不改任何东西。',
    run: async ({ args, user }) => {
      const limit = Math.min(10, Math.max(1, Number(args?.limit) || 5))
      const rows = (await listTemplates({}, user)).slice(0, limit)
      if (!rows.length) return { text: '模板库现在是空的：这个账号还没有保存过任何模板。', detail: '0 条' }
      const lines = rows.map((item, index) => {
        const type = String(item.contentType || '').trim() || '未分类'
        const from = String(item.platformLabel || item.platform || '').trim() || '来源未记'
        const hook = String(item.hook || '').trim().slice(0, 40)
        return (index + 1) + '. ' + String(item.title || '（无标题）').trim() + '（' + type + ' · ' + from + '）' + (hook ? ' 钩子：' + hook : '')
      })
      return { text: '这个账号最近 ' + rows.length + ' 条模板：\n' + lines.join('\n'), detail: rows.length + ' 条' }
    },
  },
  {
    id: 'projects.read',
    label: '读作品',
    mode: READ,
    enabled: false,
    params: '{"id": "可选"}',
    hint: '读作品列表，或按 id 读一条作品的标题、状态、最近评审。',
  },
  {
    id: 'assets.list',
    label: '读资产',
    mode: READ,
    enabled: false,
    params: '{"limit": 1-20}',
    hint: '列出产品资产与数字人资产，用来保持画面与人物一致。',
  },
  {
    id: 'web.read',
    label: '读网页',
    mode: READ,
    enabled: false,
    params: '{"url": "https://…"}',
    hint: '读一个公开网页的正文，作为这次创作的参考。不碰内网地址。',
  },
  {
    id: 'media.image',
    label: '生成图片',
    mode: WRITE,
    enabled: false,
    params: '{"prompt": "…", "ratio": "1:1|9:16|16:9"}',
    hint: '生成一张图片（每张 5 积分，失败退回）。写操作，需要主人逐次批准。',
  },
  {
    id: 'media.video',
    label: '生成视频',
    mode: WRITE,
    enabled: false,
    params: '{"prompt": "…", "seconds": 4|8, "ratio": "9:16|16:9|1:1"}',
    hint: '生成一条视频（每条 15 积分，失败退回）。写操作，需要主人逐次批准。',
  },
  {
    id: 'review.run',
    label: '跑视觉评审',
    mode: WRITE,
    enabled: false,
    params: '{"projectId": "…", "shotIds": ["…"]}',
    hint: '对作品里的画面跑一次视觉评审（每轮 5 积分，失败退回）。写操作，需要主人逐次批准。',
  },
]

function disabledFromEnv() {
  return new Set(
    String(process.env.VQ_AGENT_TOOLS_DISABLE || '')
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

/** 真正能用的工具：代码里接好了（有 run），而且没被环境变量关掉。 */
export function enabledTools() {
  const off = disabledFromEnv()
  return AGENT_TOOL_REGISTRY.filter((tool) => tool.enabled === true && typeof tool.run === 'function' && !off.has(tool.id))
}

/** 给界面看的清单：连没开的也在里面，标清楚为什么不能用。 */
export function toolCatalog() {
  const on = new Set(enabledTools().map((tool) => tool.id))
  return AGENT_TOOL_REGISTRY.map((tool) => ({
    id: tool.id,
    label: tool.label,
    mode: tool.mode,
    params: tool.params,
    hint: tool.hint,
    enabled: on.has(tool.id),
    reason: on.has(tool.id) ? '' : tool.enabled ? '被环境变量关掉了' : '还没接（1d 再接）',
  }))
}

/**
 * 写进系统提示词的那一段。没有可用工具就回空串——
 * 让模型看见「你可以用工具」却一个都调不了，比不给更糟。
 */
export function toolPrompt() {
  const tools = enabledTools()
  if (!tools.length) return ''
  const lines = tools.map((tool) => '- ' + tool.id + '（' + tool.label + (tool.mode === WRITE ? '，写操作' : '，只读') + '）：' + tool.hint + ' 参数：' + tool.params)
  return [
    '你可以用下面这些工具查资料（一次只调一个）：',
    ...lines,
    '',
    '要调用工具时，只输出一行 JSON，不要解释、不要代码块围栏：',
    '{"tool":"templates.list","args":{"limit":5}}',
    '拿到工具结果之后再直接给出要发到房间里的那段话。不需要工具就别输出 JSON。',
  ].join('\n')
}

/** 模型这一句是不是「我要调工具」。认不出来就当普通回复。 */
export function parseToolCall(text) {
  let raw = String(text || '').trim()
  if (!raw) return null
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  if (fenced) raw = fenced[1].trim()
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const tool = typeof parsed.tool === 'string' ? parsed.tool.trim() : ''
  if (!tool) return null
  const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) ? parsed.args : {}
  return { tool, args }
}

/**
 * 执行一个工具。永远不抛：模型要的工具有没有、开没开、参数对不对，
 * 都变成一段人话交回给模型，让它在下一轮里自己解释给主人听。
 */
export async function runAgentTool({ id, args = {}, user = null }) {
  const tool = AGENT_TOOL_REGISTRY.find((item) => item.id === String(id || '').trim())
  if (!tool) return { ok: false, code: 'TOOL_UNKNOWN', text: '没有这个工具：' + String(id || '').slice(0, 40) }
  const on = enabledTools().some((item) => item.id === tool.id)
  if (!on) return { ok: false, code: 'TOOL_DISABLED', text: '这个工具还没开：' + tool.label + '（' + tool.id + '）。先按你手上的信息回答，并告诉主人需要它做什么。' }
  try {
    const result = await tool.run({ args, user })
    return { ok: true, id: tool.id, label: tool.label, text: String(result?.text || ''), detail: String(result?.detail || '') }
  } catch (error) {
    return { ok: false, code: 'TOOL_FAILED', text: '这个工具执行失败了：' + String(error?.message || error).slice(0, 200) }
  }
}
