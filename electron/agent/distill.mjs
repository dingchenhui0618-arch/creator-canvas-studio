// 后台提炼：不调模型、不花积分，只从用户自己说过的话里挑「以后还用得上」的句子。
// 一轮结束后由主进程跑一次，最多记 3 条；每条都标 source=distill，用户能在记忆面板里看见、删掉。
// 这是规则提炼，不是模型总结：宁可少记，也不把一次性任务当成长期约定。

export const DISTILL_LIMITS = {
  maxCandidates: 3,
  minChars: 8,
  maxChars: 200,
  scanMessages: 20,
}

// 出现这些词，才当成「说定了一件事」而不是普通交代。
const CUES = [
  '以后',
  '之后都',
  '下次',
  '每次',
  '一律',
  '统一',
  '默认',
  '约定',
  '口径',
  '规范',
  '不要',
  '别用',
  '必须',
  '永远',
  '总是',
  '固定',
  '记住',
  '按这个',
]

// 以这些词开头的多半是这一轮的具体动作，不是长期约定。
const START_NOISE = /^(帮我|请|麻烦|现在|这次|今天|刚才|先|再)/
// 问句不是约定；疑问词也排除，避免把「以后怎么弄？」记下来。
const QUESTION = /[?？]\s*$|吗\s*$|呢\s*$|什么|怎么|为什么|哪一?个|行不行|可不可以/

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function fingerprint(text) {
  return normalize(text).toLowerCase().replace(/[\s,.;:!?，。；：！？、'"“”‘’()（）\]【】]/g, '')
}

function stripLead(text) {
  return text.replace(/^(另外|还有|然后|对了)[，,、\s]*/, '')
}

/**
 * 从最近的消息里挑候选。只认用户说的句子，工具结果、系统提示、批准备注都不算。
 * 返回 { candidates, scanned }：scanned 是这次真正看过的句子数，界面上要如实显示。
 */
export function distillRun(messages, { limit = DISTILL_LIMITS.maxCandidates } = {}) {
  const users = (Array.isArray(messages) ? messages : []).filter(
    (message) =>
      message &&
      message.role === 'user' &&
      !message.tool &&
      !message.note &&
      !message.protocol &&
      typeof message.content === 'string',
  )
  const recent = users.slice(-DISTILL_LIMITS.scanMessages)
  const candidates = []
  const seen = new Set()
  let scanned = 0

  for (let index = recent.length - 1; index >= 0 && candidates.length < limit; index -= 1) {
    const content = recent[index].content
    // 「记住：…」是显式命令，已经直接写进记忆，不再当候选
    if (/^(?:\/记住|\/remember|记住[：:])/i.test(content.trim())) continue
    const sentences = content.split(/[。！!？?；;]+|\n+/).map(normalize).filter(Boolean)
    for (const raw of sentences) {
      scanned += 1
      if (candidates.length >= limit) break
      const text = stripLead(raw)
      if (text.length < DISTILL_LIMITS.minChars || text.length > DISTILL_LIMITS.maxChars) continue
      if (START_NOISE.test(text) || QUESTION.test(text)) continue
      if (!CUES.some((cue) => text.includes(cue))) continue
      const key = fingerprint(text)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ text })
    }
  }

  return { candidates, scanned }
}