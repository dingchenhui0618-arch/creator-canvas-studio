// r293：只说了「帮我出个视频」时的提示词改写。
//
// 为什么不是「让用户再补一句」：用户已经说了要什么（视频/图片），只是没说画面。这一步用
// 平台现成的文本模型把这句意愿写成一条能直接交给生成模型的提示词，省掉一次来回。
//
// 三条自律：
//  1) 改写失败不阻断生成以外的任何事：拿不到提示词就回空，由调用方回一句「补一句画面再发」，
//     绝不拿一段空提示词去扣 15 积分；
//  2) 参数（比例 / 秒数 / 清晰度）由 server/media-intent.mjs 定，这里只写画面，不碰参数；
//  3) 不改用户明确说的东西：提示词里不许出现品牌、真实人物、可识别商标，也不写画面文字。
//
// call 可注入：单测用假的，绝不真调上游。
import { callTextModel } from './llm.mjs'

const SYSTEM = [
  '你是短视频与电商视觉的提示词工程师。用户用一句口语表达了他想生成的画面，你把它写成一条可以直接交给生成模型的提示词。',
  '硬性要求：',
  '- 中文，40–120 字，只写画面本身。不要解释、不要「提示词：」这种前缀、不要分点。',
  '- 写清主体、动作、场景、光线、镜头与画风；视频再补节奏（镜头怎么动）。',
  '- 不要写比例、秒数、清晰度这类参数（系统已经定好了）。',
  '- 不要编造品牌名、真实人名、可识别的商标；画面里不要出现文字、字幕、logo。',
  '- 用户明确说了的元素一个都不能改；没说的细节可以合理补，但别堆砌。',
  '只输出 JSON：{"prompt":"..."}',
].join('\n')

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 从模型输出里抠出提示词：优先 JSON，其次整段文字。 */
export function readPrompt(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1))
      const prompt = String(parsed?.prompt || parsed?.promptText || '').trim()
      if (prompt) return prompt
    } catch {
      // 落到下面按纯文本处理
    }
  }
  // 去掉常见的「提示词：」前缀与包裹的引号
  return raw.replace(/^["'「『]+|["'」』]+$/g, '').replace(/^(提示词|画面)[:：]\s*/, '').trim()
}

/**
 * 把一句意愿写成提示词。
 *
 * @returns {Promise<{prompt: string, note: string}>} prompt 为空表示这次没写成（调用方回一句话让用户补）
 */
export async function enhanceMediaPrompt({ kind = 'video', text = '', locked = {}, context = [], call = callTextModel } = {}) {
  const lines = []
  const recent = (Array.isArray(context) ? context : []).map((item) => clip(item, 200)).filter(Boolean).slice(-3)
  if (recent.length) lines.push('最近聊到的（用来接上下文，没用到就别硬塞）：\n' + recent.map((item) => '- ' + item).join('\n'))
  const said = clip(text, 300)
  lines.push(said ? '用户这句：' + said : '用户只说了「帮我出个' + (kind === 'image' ? '图' : '视频') + '」，没给画面。按最近的语境自己想一个具体、可拍的画面。')
  if (kind === 'image') lines.push('这次要生成的是一张静态图片。')
  else lines.push('这次要生成的是一段短视频，画面要动起来、能在几秒里讲清一件事。')
  // 用户写死的参数不进提示词，但决定节奏：12 秒要能讲清一件事，4 秒就只够一个镜头
  const decided = []
  if (locked.duration) decided.push(locked.duration + ' 秒')
  if (locked.resolution) decided.push(locked.resolution)
  if (locked.ratio) decided.push('比例 ' + locked.ratio)
  if (decided.length) lines.push('这次已经定好：' + decided.join(' · ') + '。按这个节奏写画面，但不要把参数写进提示词。')

  let output = ''
  try {
    const result = await call(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: lines.join('\n') },
      ],
      { json: true, temperature: 0.8, maxTokens: 500, timeoutMs: 20000 },
    )
    output = String(result?.text || '')
  } catch (error) {
    return { prompt: '', note: '这次没能把提示词写出来（' + String(error?.message || error).slice(0, 60) + '），补一句画面再发一次就行' }
  }
  const prompt = readPrompt(output)
  if (prompt.length < 4) return { prompt: '', note: '这次没能把提示词写出来，补一句画面再发一次就行' }
  return { prompt, note: '' }
}
