import fsp from 'node:fs/promises'
import { config, visionEnabled } from './config.mjs'
import { chatCompletion } from './chatcall.mjs'

const SYSTEM_PROMPT = [
  '你是短视频拆解专家。用户会给你一条短视频的抽帧画面（按时间顺序，每帧带时间戳）和检测到的镜头切换点。',
  '请逐帧分析，输出严格的 JSON（不要 markdown 代码块，不要多余解释），结构如下：',
  '{',
  '  "title": "根据内容起一个 12 字以内的标题",',
  '  "contentType": "剧情演绎|口播干货|教程拆解|产品测评|种草分享|开箱体验|探店vlog|混剪卡点",',
  '  "tags": ["3-6 个内容标签"],',
  '  "hook": "前三秒的具体钩子文案",',
  '  "hookType": "痛点提问|结果前置|反常识|身份代入|悬念|优惠刺激",',
  '  "structure": [{"beat": "段落名", "startSec": 0, "endSec": 4, "voiceover": "该段口播/旁白原文或复述", "onScreen": "屏幕出现的大字或字幕", "purpose": "这一段在做什么"}],',
  '  "storyboard": [{"shotNo": 1, "startSec": 0, "endSec": 4, "frameIndex": 1, "visual": "画面主体与场景", "camera": "景别与运镜", "caption": "该镜头字幕", "audio": "人声/音效/BGM 变化", "purpose": "叙事作用"}],',
  '  "analysis": { "pacing": "快|中|慢", "viralPoints": ["爆款点，2-4 条，具体到做法"], "reusableRules": ["可复用的规则，2-4 条"], "targetAudience": "目标人群" }',
  '}',
  '要求：structure 的段落数与 storyboard 的镜头数尽量与帧数对齐；时间用秒（可带小数）；只描述画面里能看到或能合理推断的信息。',
  '重要：这条模板要能被别人拿去复用，所以即使原片没有人声和字幕，也要给出可执行的建议口播与建议屏幕字，不要整段写“不确定”。',
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

async function callModel(messages, model) {
  // 18 帧的逐帧 JSON 实测 4800 token 上下（含推理 token），给 4000 会被截断成半截 JSON；
  // 走 response_format=json_object 让推理型模型直接吐纯 JSON，省掉一次修复重试。
  const { message } = await chatCompletion({
    model,
    messages,
    temperature: 0.3,
    maxTokens: 8000,
    json: true,
  })
  // 推理型多模态模型可能把 JSON 写进 reasoning_content（content 为空），这里兜住
  const content = String(message.content || '').trim() || String(message.reasoning_content || '').trim()
  if (!content) throw Object.assign(new Error('视觉模型 ' + model + ' 没有返回内容'), { retryable: true })
  return content
}

// 同一个模型最多试 2 次（上游 overloaded 属于瞬时故障），再换下一个候选模型
async function callWithRetry(messages, model, log) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await callModel(messages, model)
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

async function callWithFallback(messages, log) {
  const candidates = [config.vision.model, ...config.vision.fallbacks]
  let lastError
  for (const model of candidates) {
    try {
      log?.('视觉模型：' + model)
      return { text: await callWithRetry(messages, model, log), model }
    } catch (error) {
      lastError = error
      log?.(model + ' 失败：' + String(error?.message || error).slice(0, 120))
    }
  }
  throw lastError || new Error('所有视觉模型都不可用')
}

function normalizeResult(raw, frames) {
  const last = frames[frames.length - 1]?.t ?? 0
  const clampSec = (value, fallback) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return fallback
    return Math.max(0, Math.min(last + 2, Math.round(num * 10) / 10))
  }
  const structure = (Array.isArray(raw.structure) ? raw.structure : []).slice(0, 12).map((beat, index) => ({
    beat: String(beat.beat || ('段落 ' + (index + 1))).slice(0, 40),
    startSec: clampSec(beat.startSec, index === 0 ? 0 : last * (index / 12)),
    endSec: clampSec(beat.endSec, last),
    voiceover: String(beat.voiceover || '').slice(0, 600),
    onScreen: String(beat.onScreen || '').slice(0, 120),
    purpose: String(beat.purpose || '').slice(0, 200),
  }))
  const storyboard = (Array.isArray(raw.storyboard) ? raw.storyboard : []).slice(0, 24).map((shot, index) => ({
    shotNo: index + 1,
    startSec: clampSec(shot.startSec, frames[index]?.t ?? 0),
    endSec: clampSec(shot.endSec, frames[index + 1]?.t ?? last),
    frameIndex: Number(shot.frameIndex) || index + 1,
    visual: String(shot.visual || '').slice(0, 300),
    camera: String(shot.camera || '').slice(0, 80),
    caption: String(shot.caption || '').slice(0, 120),
    audio: String(shot.audio || '').slice(0, 120),
    purpose: String(shot.purpose || '').slice(0, 200),
  }))
  return {
    title: String(raw.title || '').slice(0, 40),
    contentType: String(raw.contentType || '口播干货').slice(0, 20),
    tags: (Array.isArray(raw.tags) ? raw.tags : []).map((tag) => String(tag).slice(0, 16)).slice(0, 8),
    hook: String(raw.hook || '').slice(0, 300),
    hookType: String(raw.hookType || '痛点提问').slice(0, 20),
    structure,
    storyboard,
    analysis: {
      pacing: String(raw.analysis?.pacing || '中').slice(0, 8),
      viralPoints: (raw.analysis?.viralPoints || []).map((v) => String(v).slice(0, 200)).slice(0, 6),
      reusableRules: (raw.analysis?.reusableRules || []).map((v) => String(v).slice(0, 200)).slice(0, 6),
      targetAudience: String(raw.analysis?.targetAudience || '').slice(0, 120),
    },
  }
}

export async function analyzeFrames({ frames, meta, sceneCuts, log }) {
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
    '下面是 ' + frames.length + ' 张按时间顺序的抽帧，请逐帧分析并输出 JSON。',
  ].join('\n')
  log?.('调用视觉模型逐帧分析（' + frames.length + ' 帧）')
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: [{ type: 'text', text: summary }, ...payload] },
  ]
  const first = await callWithFallback(messages, log)
  let parsed
  try {
    parsed = extractJson(first.text)
  } catch {
    log?.('模型返回非 JSON，追加修复指令重试一次')
    const repaired = await callWithFallback([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [{ type: 'text', text: summary + '\n上一次输出无法解析，请只输出 JSON。' }, ...payload] },
    ], log)
    parsed = extractJson(repaired.text)
  }
  return normalizeResult(parsed, frames)
}
