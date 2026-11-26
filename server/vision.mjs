import fsp from 'node:fs/promises'
import { config, visionEnabled } from './config.mjs'
import { chatCompletion } from './chatcall.mjs'
import { vaultModels } from './keyvault.mjs'
import { reconcileTimeline } from './speech.mjs'
import { overlapsSilence } from './audio.mjs'

// 导出给单测：这段提示词里只要重新出现「即使原片没有人声也要编口播」这类要求，
// 整条复刻链路就又开始把编的东西当原片事实，必须有断言盯着。
export const SYSTEM_PROMPT = [
  '你是短视频拆解专家。用户会给你一条短视频的抽帧画面（按时间顺序，每帧带时间戳）和检测到的镜头切换点。',
  '请逐帧分析，输出严格的 JSON（不要 markdown 代码块，不要多余解释），结构如下：',
  '{',
  '  "title": "根据内容起一个 12 字以内的标题",',
  '  "contentType": "剧情演绎|口播干货|教程拆解|产品测评|种草分享|开箱体验|探店vlog|混剪卡点",',
  '  "tags": ["3-6 个内容标签"],',
  '  "hook": "前三秒的具体钩子文案",',
  '  "hookType": "痛点提问|结果前置|反常识|身份代入|悬念|优惠刺激",',
  '  "structure": [{"beat": "段落名", "startSec": 0, "endSec": 4, "voiceover": "这一段的口播：画面有字幕就照抄，没有就写复刻建议", "voiceoverSource": "on-screen|inferred", "onScreen": "屏幕出现的大字或字幕（没有就空字符串）", "purpose": "这一段在做什么"}],',
  '  "storyboard": [{"shotNo": 1, "startSec": 0, "endSec": 4, "frameIndex": 1, "visual": "画面主体与场景", "camera": "景别与运镜", "caption": "该镜头字幕", "audio": "人声/音效/BGM 变化", "purpose": "叙事作用"}],',
  '  "analysis": { "pacing": "快|中|慢", "viralPoints": ["爆款点，2-4 条，具体到做法"], "reusableRules": ["可复用的规则，2-4 条"], "targetAudience": "目标人群" }',
  '}',
  '要求：structure 的段落数与 storyboard 的镜头数尽量与帧数对齐；时间用秒（可带小数）；只描述画面里能看到或能合理推断的信息。',
  '口播只允许两种来源：画面上能读到的字幕/贴纸就照抄，voiceoverSource 写 "on-screen"；读不到就写一句你建议复刻时用的口播，voiceoverSource 写 "inferred"。',
  '我们听不到这条片子的声音（音轨实测数据见用户消息），所以一律不要把「建议口播」写成原片说过的原话，也不要声称听到了人声或音乐。',
  '屏幕字（onScreen）只写画面上真实出现的大字，没有就给空字符串，不要编。',
  '模板要能被别人拿去复用：画面看不到口播时，仍然要给出可执行的建议口播（标 inferred），不要整段写“不确定”。',
  '只有确实无法从画面判断的技术信息（例如具体音效、BGM 曲名）才写“不确定”。',
].join('\n')

function extractJson(text) {
  const cleaned = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/,'').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function callModel(messages, model, meter = null) {
  // 18 帧的逐帧 JSON 实测 4800 token 上下（含推理 token），给 4000 会被截断成半截 JSON；
  // 走 response_format=json_object 让推理型模型直接吐纯 JSON，省掉一次修复重试。
  const { message } = await chatCompletion({
    model,
    messages,
    temperature: 0.3,
    maxTokens: 8000,
    json: true,
    capability: 'vision',
    meter,
  })
  // 推理型多模态模型可能把 JSON 写进 reasoning_content（content 为空），这里兜住
  const content = String(message.content || '').trim() || String(message.reasoning_content || '').trim()
  if (!content) throw Object.assign(new Error('视觉模型 ' + model + ' 没有返回内容'), { retryable: true })
  return content
}

// 同一个模型最多试 2 次（上游 overloaded 属于瞬时故障），再换下一个候选模型
async function callWithRetry(messages, model, log, meter = null) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await callModel(messages, model, meter)
    } catch (error) {
      lastError = error
      const retryable = error?.retryable || error?.name === 'AbortError' || /fetch failed/i.test(String(error?.message))
      if (!retryable || attempt === 1) break
      log?.(model + ' 暂时不可用，' + (attempt + 1) * 3 + ' 秒后重试')
      await sleep((attempt + 1) * 3000)
    }
  }
  throw lastError
}

async function callWithFallback(messages, log, meter = null) {
  // 后台 Key 池声明的视觉模型也进候选链，加一把多模态 Key 即可换模型
  const candidates = [...new Set([config.vision.model, ...config.vision.fallbacks, ...vaultModels('vision')].filter(Boolean))]
  let lastError
  for (const model of candidates) {
    try {
      log?.('视觉模型：' + model)
      return { text: await callWithRetry(messages, model, log, meter), model }
    } catch (error) {
      lastError = error
      log?.(model + ' 失败：' + String(error?.message || error).slice(0, 120))
    }
  }
  throw lastError || new Error('所有视觉模型都不可用')
}

// 导出给单测：时长对账是这条链路里唯一能用数字验证的部分，别只靠线上肉眼看。
export function normalizeResult(raw, frames, videoDuration = 0, audio = null) {
  const last = frames[frames.length - 1]?.t ?? 0
  // 片长以真实视频时长为准，抽帧最后一帧往往比片长短一截（帧没落到结尾），
  // 拿它当总时长会和界面上写的 0:18 对不上。
  const total = Number(videoDuration) > 0 ? Math.round(Number(videoDuration) * 10) / 10 : last
  const clampSec = (value, fallback) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return fallback
    return Math.max(0, Math.min(total, Math.round(num * 10) / 10))
  }
  // 模型习惯在内容里自带标签（"屏幕字：xxx"），界面上已经有标签，再留一遍就是重影
  const stripLabel = (text, labels) => {
    let out = String(text || '').trim()
    for (const label of labels) out = out.replace(new RegExp('^' + label + '\\s*[：:]\\s*'), '')
    return out
  }
  // 口播来源：模型只有一项「真证据」——照着画面上的字幕抄。它不能自称做过语音识别
  // （我们并没有 ASR 通道），所以 'asr' 一律降级成 'inferred'；'asr' 这个值留给将来真接上识别。
  const voiceoverSourceOf = (source, text) => {
    if (!text) return ''
    return source === 'on-screen' ? 'on-screen' : 'inferred'
  }
  const rawBeats = (Array.isArray(raw.structure) ? raw.structure : []).slice(0, 12).map((beat, index) => {
    const startSec = clampSec(beat.startSec, index === 0 ? 0 : last * (index / 12))
    const endSec = clampSec(beat.endSec, last)
    const voiceover = stripLabel(beat.voiceover, ['建议旁白', '建议口播', '旁白', '口播']).slice(0, 600)
    return {
      beat: String(beat.beat || ('段落 ' + (index + 1))).slice(0, 40),
      startSec,
      endSec,
      voiceover,
      voiceoverSource: voiceoverSourceOf(beat.voiceoverSource, voiceover),
      onScreen: stripLabel(beat.onScreen, ['建议屏幕字', '屏幕字', '建议字幕', '字幕']).slice(0, 120),
      purpose: String(beat.purpose || '').slice(0, 200),
      // 原片这一段是不是基本没声音：真测出来的停顿区间，不是模型的口述
      audioGap: overlapsSilence(audio, startSec, endSec),
    }
  })
  const rawShots = (Array.isArray(raw.storyboard) ? raw.storyboard : []).slice(0, 24).map((shot, index) => {
    const startSec = clampSec(shot.startSec, frames[index]?.t ?? 0)
    const endSec = clampSec(shot.endSec, frames[index + 1]?.t ?? last)
    return {
      shotNo: index + 1,
      startSec,
      endSec,
      frameIndex: Number(shot.frameIndex) || index + 1,
      visual: String(shot.visual || '').slice(0, 300),
      camera: String(shot.camera || '').slice(0, 80),
      caption: String(shot.caption || '').slice(0, 120),
      audio: String(shot.audio || '').slice(0, 120),
      purpose: String(shot.purpose || '').slice(0, 200),
      audioGap: overlapsSilence(audio, startSec, endSec),
    }
  })

  // 时长与台词对账：模型给的秒数常常和台词量对不上（2 秒要塞 90 个字，或者 12 秒只说一句话），
  // 照着这种分镜表拍不出片。这里按语速把每段念完需要的时间算出来，逐段标出 mismatch。
  // 语速档位跟着模型对节奏的判断走：快/中/慢对应 hypit 的 fast/normal/slow 密度
  const pace = String(raw.analysis?.pacing || '中')
  const beatsTimed = reconcileTimeline(rawBeats, { totalSec: total, pace, textOf: (beat) => beat.voiceover || beat.onScreen })
  const shotsTimed = reconcileTimeline(rawShots, { totalSec: total, pace, textOf: (shot) => shot.caption })
  const structure = beatsTimed.rows
  const storyboard = shotsTimed.rows
  // 整条以「段落口播」为准：那才是真的被念出来的内容；镜头字幕往往只是屏幕上的一行短字，
  // 拿它估整条时长会系统性偏短。段落没口播时才退回镜头层。
  const timing = beatsTimed.summary.estimatedSec > 0 ? beatsTimed.summary : shotsTimed.summary
  return {
    title: String(raw.title || '').slice(0, 40),
    contentType: String(raw.contentType || '口播干货').slice(0, 20),
    tags: (Array.isArray(raw.tags) ? raw.tags : []).map((tag) => String(tag).slice(0, 16)).slice(0, 8),
    hook: String(raw.hook || '').slice(0, 300),
    hookType: String(raw.hookType || '痛点提问').slice(0, 20),
    structure,
    storyboard,
    timing,
    // 原片音轨的实测事实（有没有声音、停顿在哪、响度）。没有音轨也照样带这个对象，
    // 界面靠 note 一句话说清，不用自己判空拼文案。
    audio: audio || null,
    analysis: {
      pacing: String(raw.analysis?.pacing || '中').slice(0, 8),
      viralPoints: (raw.analysis?.viralPoints || []).map((v) => String(v).slice(0, 200)).slice(0, 6),
      reusableRules: (raw.analysis?.reusableRules || []).map((v) => String(v).slice(0, 200)).slice(0, 6),
      targetAudience: String(raw.analysis?.targetAudience || '').slice(0, 120),
    },
  }
}

export async function analyzeFrames({ frames, meta, sceneCuts, audio = null, log, meter = null }) {
  if (!visionEnabled()) throw Object.assign(new Error('未配置视觉模型凭证'), { code: 'NO_VISION' })
  const payload = []
  for (const frame of frames) {
    const base64 = (await fsp.readFile(frame.file)).toString('base64')
    payload.push({ type: 'text', text: '第 ' + frame.index + ' 帧，时间 ' + frame.t.toFixed(1) + ' 秒' })
    payload.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64, detail: 'low' } })
  }
  const summary = [
    '视频信息：时长 ' + meta.duration.toFixed(1) + ' 秒，分辨率 ' + meta.width + 'x' + meta.height + '，帧率 ' + meta.fps,
    sceneCuts.length ? ('镜头切换点（秒）：' + sceneCuts.slice(0, 20).join(', ')) : '未检测到明显硬切，可能是单镜头或长镜头。',
    '音轨（ffmpeg 实测，你听不到声音，只能参考这些数字）：' + (audio?.note || '未读取'),
    audio?.pauses ? ('停顿区间（秒）：' + (audio.segments || []).slice(0, 12).map((seg) => seg.start + '-' + seg.end).join(', ')) : '',
    '下面是 ' + frames.length + ' 张按时间顺序的抽帧，请逐帧分析并输出 JSON。',
  ].filter(Boolean).join('\n')
  log?.('调用视觉模型逐帧分析（' + frames.length + ' 帧）')
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: [{ type: 'text', text: summary }, ...payload] },
  ]
  const first = await callWithFallback(messages, log, meter)
  let parsed
  try {
    parsed = extractJson(first.text)
  } catch {
    log?.('模型返回非 JSON，追加修复指令重试一次')
    const repaired = await callWithFallback([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [{ type: 'text', text: summary + '\n上一次输出无法解析，请只输出 JSON。' }, ...payload] },
    ], log, meter)
    parsed = extractJson(repaired.text)
  }
  return normalizeResult(parsed, frames, meta.duration, audio)
}
