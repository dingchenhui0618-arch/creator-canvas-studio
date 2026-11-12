// 本地 agent loop：一轮对话 = 若干步「模型决定 → 本地执行 → 结果回到上下文」。
// 这里不碰 Electron、不碰网络：complete / emit / approve 都由外面注入，
// 所以测试可以完整跑一轮（含工具、拒绝、压缩）而不需要真的开窗口。
import { buildSystemPrompt, parseStep, formatToolResult } from './protocol.mjs'
import { COMPACTION, planCompaction, buildSummaryPrompt, totalTokens } from './compaction.mjs'

export const DEFAULT_LIMITS = { maxSteps: 8, maxToolOutput: 8000 }

async function compactIfNeeded({ thread, complete, emit, signal }) {
  const plan = planCompaction(thread.messages)
  if (!plan.needs) return false
  emit({ type: 'compact', phase: 'start', tokens: plan.tokens, budget: plan.budget, summarized: plan.summarized.length })
  const summaryText = await complete(
    [{ role: 'user', content: buildSummaryPrompt({ summarized: plan.summarized, previousSummary: thread.summary }) }],
    { maxTokens: COMPACTION.summaryMaxTokens, signal },
  )
  const summary = String(summaryText || '').trim().slice(0, COMPACTION.summaryMaxChars * 4)
  if (!summary) {
    // 摘要没拿到就别动历史：宁可下一轮再试，也不要让上下文悄悄少了东西
    emit({ type: 'compact', phase: 'failed', tokens: plan.tokens })
    return false
  }
  thread.messages = plan.keep
  thread.summary = summary
  thread.compactions = (thread.compactions || 0) + 1
  emit({
    type: 'compact',
    phase: 'done',
    summary,
    removed: plan.summarized.length,
    kept: plan.keep.length,
    tokensBefore: plan.tokens,
    tokensAfter: totalTokens(plan.keep),
  })
  return true
}

// 这一轮开始前，按用户刚说的这句话去长期记忆里召回几条：只放进系统提示，不改动会话历史。
// 记忆读写失败不算这一轮失败——没有记忆也要能干活。
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user' && !message.note && !message.tool) return String(message.content || '')
  }
  return ''
}

async function recallMemory({ memory, workspace, thread, emit }) {
  if (!memory) return []
  try {
    const entries = await memory.recall(workspace, { query: lastUserText(thread.messages) })
    if (entries.length > 0) {
      emit({ type: 'memory', phase: 'recall', entries: entries.map((entry) => ({ id: entry.id, text: entry.text })) })
    }
    return entries
  } catch {
    return []
  }
}

export async function runTurn({ thread, workspace, tools, complete, emit = () => {}, approve = async () => false, limits = {}, memory = null, signal }) {
  const limit = { ...DEFAULT_LIMITS, ...limits }
  const toolMap = new Map((tools || []).map((tool) => [tool.name, tool]))
  const recalled = await recallMemory({ memory, workspace, thread, emit })
  let steps = 0
  let repairs = 0
  const startedAt = Date.now()

  const assertLive = () => {
    if (signal?.aborted) {
      const error = new Error('已停止')
      error.name = 'AbortError'
      throw error
    }
  }

  try {
    while (steps < limit.maxSteps) {
      assertLive()
      steps += 1
      await compactIfNeeded({ thread, complete, emit, signal })
      const messages = [
        { role: 'system', content: buildSystemPrompt({ workspace, tools, summary: thread.summary, maxSteps: limit.maxSteps, memory: recalled }) },
        ...thread.messages,
      ]
      const reply = await complete(messages, { maxTokens: 2400, signal, step: steps })
      const step = parseStep(reply)

      if (step.type === 'final') {
        thread.messages.push({ role: 'assistant', content: step.text })
        emit({ type: 'assistant', text: step.text, steps, elapsedMs: Date.now() - startedAt })
        return { ok: true, steps }
      }
      if (step.type === 'invalid') {
        // 给一次改正机会：模型偶尔会先写一段解释再给 JSON，或把两步写在一起。
        // 只纠正一次，第二次还不对就停——不能让用户看着它空转。
        if (repairs === 0) {
          repairs += 1
          thread.messages.push({ role: 'assistant', content: String(reply).slice(0, 800), protocol: true })
          thread.messages.push({
            role: 'user',
            note: true,
            content:
              '上一条不是合法 JSON（可能引号没转义、或内容太长被截断）。请重新只回一个 JSON —— ' +
              '{"type":"tool","tool":"工具名","args":{...}} 或 {"type":"final","text":"回答"}。' +
              '要写文件时先写短版（几百字以内），字符串里的双引号写成 \\"。也不要把工具结果编进回答里。',
          })
          emit({ type: 'note', text: '模型这一步格式不对，已要求它重发一次。' })
          continue
        }
        emit({ type: 'error', message: '模型连续两步没有按约定格式回复，先停下', detail: step.raw || step.reason })
        return { ok: false, steps, error: step.reason }
      }

      // 只把这一步的协议对象写回历史：模型有时会在 JSON 后面自己编一段「工具结果」，
      // 原样留下会被下一轮当成真的证据（实测踩过），所以这里用规范化后的调用代替原文。
      thread.messages.push({
        role: 'assistant',
        content: JSON.stringify({ type: 'tool', tool: step.tool, args: step.args, why: step.why }),
        protocol: true,
      })
      const tool = toolMap.get(step.tool)
      if (!tool) {
        const output = '没有这个工具：' + step.tool + '。可用工具：' + [...toolMap.keys()].join(' / ')
        emit({ type: 'tool', phase: 'done', tool: step.tool, ok: false, output })
        thread.messages.push({
          role: 'user',
          content: formatToolResult({ tool: step.tool, args: step.args, ok: false, output }),
          tool: { name: step.tool, args: step.args, ok: false, output },
        })
        continue
      }

      emit({ type: 'tool', phase: 'call', tool: step.tool, args: step.args, why: step.why, needsApproval: Boolean(tool.needsApproval) })
      if (tool.needsApproval) {
        const allowed = await approve({ tool: step.tool, args: step.args, why: step.why, step: steps })
        if (!allowed) {
          emit({ type: 'tool', phase: 'denied', tool: step.tool, args: step.args })
          thread.messages.push({
            role: 'user',
            note: true,
            content: '用户拒绝了 ' + step.tool + ' 这一步，没有执行。不要原样重试；先说明你打算做什么、为什么需要它，等用户确认。',
          })
          continue
        }
      }

      let result
      try {
        result = await tool.run(step.args, { signal })
      } catch (error) {
        result = { ok: false, output: String(error?.message || error) }
      }
      const output = String(result?.output ?? '').slice(0, limit.maxToolOutput)
      emit({ type: 'tool', phase: 'done', tool: step.tool, args: step.args, ok: Boolean(result?.ok), output })
      thread.messages.push({
        role: 'user',
        content: formatToolResult({ tool: step.tool, args: step.args, ok: Boolean(result?.ok), output }),
        tool: { name: step.tool, args: step.args, ok: Boolean(result?.ok), output },
      })
    }

    const text = '这一轮工具调用到了上限（' + limit.maxSteps + ' 步），先停在这里：上面列出来的都是真的执行过的，没做的部分还没做。'
    thread.messages.push({ role: 'assistant', content: text })
    emit({ type: 'assistant', text, steps, stoppedByLimit: true, elapsedMs: Date.now() - startedAt })
    return { ok: true, steps, stoppedByLimit: true }
  } catch (error) {
    if (error?.name === 'AbortError') {
      emit({ type: 'aborted', steps })
      return { ok: false, steps, aborted: true }
    }
    emit({ type: 'error', message: String(error?.message || error), steps })
    return { ok: false, steps, error: String(error?.message || error) }
  }
}