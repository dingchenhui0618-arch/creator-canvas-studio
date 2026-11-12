// 上下文压缩（DSH 式）：先估 token，超过预算的 75% 就把早期对话压成摘要，
// 摘要接在系统提示里继续用，最近几条原样保留。
// 这里的四个数是本地工作区真正在用的默认值，界面上显示的也是它们，不另写一份文案。
export const COMPACTION = {
  contextTokens: 64000,
  thresholdPercent: 75,
  retainTokens: 2500,
  summaryMaxChars: 1200,
  summaryMaxTokens: 600,
  // 一次压缩至少覆盖 2 条、最多保留 6 条，避免「压缩完什么都没动」或「压缩完啥也不剩」
  minSummarized: 2,
  maxKept: 6,
}

// 粗估 token：中日韩字符按 1 token 算，其余按 3.5 字符 1 token。
// 只用于「该不该压缩」的判断，不追求与供应商计数一致；宁可早压一点。
export function estimateTokens(text) {
  const value = String(text || '')
  let cjk = 0
  for (const char of value) {
    const code = char.codePointAt(0)
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1
  }
  const other = Math.max(0, value.length - cjk)
  return cjk + Math.ceil(other / 3.5)
}

export function totalTokens(messages) {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
}

/**
 * 判断这一轮要不要压缩，并给出保留哪几条。纯函数：不读盘、不调模型，测试直接喂消息。
 * 返回 { needs, cutIndex, summarized, keep, tokens, budget }
 */
export function planCompaction(messages, options = {}) {
  const opts = { ...COMPACTION, ...options }
  const tokens = totalTokens(messages)
  const budget = Math.floor((opts.contextTokens * opts.thresholdPercent) / 100)
  if (tokens <= budget) return { needs: false, tokens, budget, cutIndex: messages.length }

  let keep = 1
  let keptTokens = estimateTokens(messages[messages.length - 1]?.content)
  while (keep < messages.length && keep < opts.maxKept && keptTokens < opts.retainTokens) {
    keptTokens += estimateTokens(messages[messages.length - keep - 1]?.content)
    keep += 1
  }
  const cutIndex = messages.length - keep
  // 少于 minSummarized 条可压时不动：压完只剩一句「见上」，反而丢了细节
  if (cutIndex < opts.minSummarized) {
    return { needs: false, tokens, budget, cutIndex: messages.length, reason: 'too-few' }
  }
  const summarized = messages.slice(0, cutIndex)
  const keepMessages = messages.slice(cutIndex)
  return {
    needs: true,
    tokens,
    budget,
    cutIndex,
    summarized,
    keep: keepMessages,
    estimatedAfter: totalTokens(keepMessages),
  }
}

/** 把「早期对话 + 上一版摘要」交给模型压成一版新摘要的提示词。 */
export function buildSummaryPrompt({ summarized, previousSummary = '', summaryMaxChars = COMPACTION.summaryMaxChars }) {
  const lines = []
  lines.push('你在压缩一段「本地工作区」智能体的早期对话。压缩后的摘要会被放回上下文继续用，所以只保留以后真的用得上的东西。')
  lines.push('')
  lines.push('保留：用户真正要达成的目标、已经确认的事实与决定、读过或写过的文件路径、命令与关键输出（报错原文、数字）、还没做完的下一步。')
  lines.push('丢掉：寒暄、重复、中间试错、被推翻的方案。')
  lines.push('不许新增推断。对话里没说的不要补；不确定的写「未确认」。')
  lines.push('只输出摘要正文，不要标题、不要前言，不超过 ' + summaryMaxChars + ' 字。')
  if (previousSummary) {
    lines.push('')
    lines.push('上一版摘要（合并进新摘要，不要直接抄）：')
    lines.push(previousSummary)
  }
  lines.push('')
  lines.push('早期对话：')
  for (const message of summarized) {
    const who = message.role === 'user' ? '用户' : message.role === 'assistant' ? '智能体' : message.role
    const text = String(message.content || '').slice(0, 4000)
    lines.push('[' + who + '] ' + text)
  }
  return lines.join('\n')
}