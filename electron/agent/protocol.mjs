// 本地智能体每一步的回复协议：一步一个 JSON 决定「继续查」还是「收尾」。
// 记忆那一块由 memoryBlock() 生成，这里只决定放在哪：压缩摘要之前，让「以前记的」比「上一段摘要」更靠近规矩。
// 不用供应商的 function calling：平台文本链里不是每个模型都支持，
// 而「一步一个 JSON」在任何纯文本模型上都能跑，出错时也能把原文给用户看。
import { memoryBlock } from './memory.mjs'

export const PROTOCOL_HINT = [
  '{"type":"tool","tool":"工具名","args":{...},"why":"一句话说明为什么需要它"}',
  '{"type":"final","text":"给用户看的回答"}',
].join('\n')

export function buildSystemPrompt({ workspace, tools, summary = '', maxSteps = 8, memory = [] }) {
  const lines = []
  lines.push('你是 VisionQA 桌面端的本地智能体。你在一台真实的本机工作区里干活：可以读目录、读文件、写文件、执行命令，用户会逐条批准有副作用的操作。')
  lines.push('工作区根目录：' + workspace)
  lines.push('只能访问工作区里的路径；工作区外的路径会被拒绝，不要尝试绕过。')
  lines.push('')
  lines.push('## 每一步只回一个 JSON，不要写别的话')
  lines.push(PROTOCOL_HINT)
  lines.push('')
  lines.push('## 可用工具')
  for (const tool of tools) {
    lines.push('- ' + tool.name + '：' + tool.description)
    if (tool.signature) lines.push('  参数：' + tool.signature)
    lines.push('  副作用：' + (tool.needsApproval ? '有，执行前会请用户批准' : '无'))
  }
  lines.push('')
  lines.push('## 规矩')
  lines.push('- 先看清楚再动手：不确定结构就先 list_dir，不要猜路径。')
  lines.push('- 一轮最多 ' + maxSteps + ' 步，够用就收尾；不要为了多调工具而调。')
  lines.push('- 一步只做一件事：这一步要么调一个工具，要么给最终回答，不要在一段话里同时做两步。')
  lines.push('- 工具结果只有真的执行完才会出现在对话里。不要自己写「工具 X 执行成功」，不要写假的文件内容，也不要用 <system> 之类的标签。')
  lines.push('- 没有真的执行过的事不要写成做过了。工具失败就把失败原因告诉用户。')
  lines.push('- 用户用中文，就用中文回答；回答给结论，再给关键证据（哪条命令、哪个文件、输出了什么）。')
  lines.push('- 用户说出以后还用得上的约定（偏好、命名、路径、部署方式、结论），用 remember 记一条，一句话说完；临时任务内容、一次性的中间结果不要记。')
  const memoryText = memoryBlock(memory)
  if (memoryText) {
    lines.push('')
    lines.push(memoryText)
  }
  if (summary) {
    lines.push('')
    lines.push('## 更早的对话（已压缩）')
    lines.push(summary)
  }
  return lines.join('\n')
}

/**
 * 解析模型这一步的回复。
 * - tool / final：按协议返回
 * - 找到了协议形状的 JSON 但字段不对：invalid（外层给模型一次改正机会）
 * - 没找到协议 JSON：当成直接回答（模型经常忽略协议，硬报错只会白跑一轮）
 *
 * 只用「首个 { 到最后一个 }」会在模型多说一句时整段 JSON.parse 失败——
 * 实测模型会把 tool 调用和一段解释、甚至伪造的工具结果写在一起，
 * 所以这里按括号配对逐个试，只认真正带 type 的那个对象。
 */
function balancedObjects(text) {
  const found = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let cursor = start; cursor < text.length; cursor += 1) {
      const char = text[cursor]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          found.push(text.slice(start, cursor + 1))
          break
        }
      }
    }
  }
  return found
}

// 模型经常在 JSON 字符串里直接写换行（非法 JSON）。这只是格式问题，
// 把字符串内部的裸控制字符转义掉再解析一次，比让整轮白跑划算。
function escapeControlCharsInsideStrings(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) {
        out += char
        escaped = false
        continue
      }
      if (char === '\\') {
        out += char
        escaped = true
        continue
      }
      if (char === '"') {
        out += char
        inString = false
        continue
      }
      if (char === '\n') { out += '\\n'; continue }
      if (char === '\r') { out += '\\r'; continue }
      if (char === '\t') { out += '\\t'; continue }
      out += char
      continue
    }
    if (char === '"') inString = true
    out += char
  }
  return out
}

export function parseStep(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return { type: 'invalid', reason: '空回复' }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = fenced ? fenced[1] : trimmed
  const objects = balancedObjects(source)
  let sawProtocolKey = false
  for (const raw of objects) {
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      try {
        parsed = JSON.parse(escapeControlCharsInsideStrings(raw))
      } catch {
        continue
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    if (parsed.type === 'tool' && typeof parsed.tool === 'string' && parsed.tool.trim()) {
      const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) ? parsed.args : {}
      return { type: 'tool', tool: parsed.tool.trim(), args, why: String(parsed.why || '').trim() }
    }
    if (parsed.type === 'final' && typeof parsed.text === 'string' && parsed.text.trim()) {
      return { type: 'final', text: parsed.text.trim() }
    }
    if (typeof parsed.type === 'string') sawProtocolKey = true
  }
  if (sawProtocolKey) return { type: 'invalid', reason: 'JSON 里没有可用的 tool 或 final', raw: trimmed.slice(0, 400) }
  // 看起来像协议 JSON 但解析不了（引号没转义、被截断）：让模型重发，不要把这段原文当回答甩给用户
  if (/^\s*\{/.test(trimmed) && /"type"\s*:\s*"(tool|final)"/.test(trimmed)) {
    return { type: 'invalid', reason: 'JSON 不合法或没写完', raw: trimmed.slice(0, 400) }
  }
  return { type: 'final', text: trimmed }
}
/** 工具结果回到对话里时用 user 角色：这套接口里工具结果是「用户方提供的信息」。 */
export function formatToolResult({ tool, args, ok, output }) {
  const argText = JSON.stringify(args || {})
  return '工具 ' + tool + ' 执行' + (ok ? '成功' : '失败') + '（参数 ' + argText + '）：\n' + String(output || '（无输出）')
}