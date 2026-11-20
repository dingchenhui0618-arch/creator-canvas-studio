// r288：对话框里一句话直接出图 / 出视频（明确触发词，不依赖上游 function calling）。
//
// 为什么先做这一条，而不是直接把 tools 透给上游（见 docs/r288-chat-generate-2026-11-20.md）：
//  1) server/chatcall.mjs 现在不透 tools / tool_calls，要让模型自己决定去生成，先得改上游契约，
//     而 deepseek-flash 认不认 tools 还没验过（验一次要真调文本）；
//  2) 生成是要花积分的动作：明确触发词用户看得懂、单测卡得住，也不会因为模型「理解得很热情」，
//     在多聊两句时顺手画一张图。
//
// 只认「开头就是生成指令」的句子：「怎么生成图」「生成一张图要多久」都不算命令——
// 用户只是在问问题，不该先花掉积分。判定规则写死在这个文件里，路由与界面都只读它一个真源。
import { VIDEO_DURATIONS, VIDEO_RESOLUTIONS, defaultModelFor, findModel } from './media-models.mjs'

// 生成上限与 server/routes/media-gen.mjs 的 MAX_PROMPT_CHARS 一致：那边才是真拒绝的地方
const MAX_PROMPT_CHARS = 1200

// 「帮我 / 请 / 给我」这类客气话可以出现在指令前面，最多剥两层
const POLITE = ['请', '帮我', '帮忙', '麻烦', '给我', '我想', '我要']

const SLASH_LEADS = {
  image: ['/生图', '/画图', '/图'],
  video: ['/生视频', '/视频'],
}

const NATURAL_LEADS = {
  image: [
    '生成一张图片',
    '生成一张海报',
    '生成一幅图',
    '生成一张图',
    '生成图片',
    '生成海报',
    '生成图',
    '画一张图片',
    '画一张图',
    '画一幅图',
    '画一张',
    '画一幅',
    '画个图',
    '画图',
    '出一张图',
    '出一幅图',
    '做一张图',
    '做一张封面',
    '做张封面',
    '做一张海报',
    '生图',
    '出图',
    '做张图',
    '做个图',
  ],
  video: [
    '生成一段视频',
    '生成一个视频',
    '生成一条视频',
    '生成短视频',
    '做一段视频',
    '做一个视频',
    '拍一段视频',
    '出一段视频',
    '生成视频',
    '出段视频',
    '做段视频',
    '做个视频',
    '来个视频',
    '拍个视频',
    '生视频',
    '出视频',
  ],
}

// 长的先匹配：「生成一张图片」不能被「生成一张」抢走，「生成视频教程」也不该被当成命令
const LEADS = [
  ...Object.entries(SLASH_LEADS).flatMap(([kind, list]) => list.map((token) => ({ kind, token, slash: true }))),
  ...Object.entries(NATURAL_LEADS).flatMap(([kind, list]) => list.map((token) => ({ kind, token, slash: false }))),
].sort((a, b) => b.token.length - a.token.length)

// 自然语言触发词后面必须有个断点（空格、标点、比例数字），否则「生成视频教程的文案」会被误解成要出视频
const TAIL_OK = /^[\s:：,，、。;；\-—0-9（(“"]/
// 「生成一张图要多久」这类是在问问题：这些开头说明后面跟的是问题，不是提示词
const QUESTION_START = /^(要|会|能|需|得|大概|多少|多久|多长|怎么|如何|为什么|为啥|可不可以|是不是|行不行|吗|呢)/

function usageOf(lead) {
  if (lead.kind === 'image') {
    return lead.slash
      ? '「' + lead.token + '」后面写清要画什么，例如：' + lead.token + ' 9:16 咖啡店门口的雨夜海报'
      : '在「' + lead.token + '」后面写清要画什么，例如：' + lead.token + ' 9:16 咖啡店门口的雨夜海报'
  }
  return lead.slash
    ? '「' + lead.token + '」后面写清要拍什么，例如：' + lead.token + ' 16:9 8秒 咖啡店门口的雨夜'
    : '在「' + lead.token + '」后面写清要拍什么，例如：' + lead.token + ' 16:9 8秒 咖啡店门口的雨夜'
}

function matchLead(text) {
  for (const item of LEADS) {
    if (!text.startsWith(item.token)) continue
    const tail = text.slice(item.token.length)
    // 斜杠指令本身就是命令，不要求后面还有断点；自然语言触发词要有个断点才算
    if (!item.slash && tail && !TAIL_OK.test(tail)) continue
    return { ...item, tail }
  }
  return null
}

/**
 * 从一句话里认出「要生成图片 / 视频」以及参数。
 *
 * @returns null（不是生成指令）| { kind, prompt, model, ratio, duration, resolution, notes, lead } | { kind, code, error }
 */
export function parseMediaIntent(raw) {
  const text = String(raw || '').trim()
  if (!text) return null

  let rest = text
  for (let round = 0; round < 2; round += 1) {
    const polite = POLITE.find((prefix) => rest.startsWith(prefix))
    if (!polite) break
    rest = rest.slice(polite.length).replace(/^[\s,，、]+/, '')
  }

  const lead = matchLead(rest)
  if (!lead) return null

  let body = lead.tail.replace(/^[\s:：,，、。;；\-—]+/, '').trim()
  if (!lead.slash) {
    if (/^[?？]/.test(body)) return null
    if (QUESTION_START.test(body)) return null
  }

  const kind = lead.kind
  const spec = findModel(kind, defaultModelFor(kind))
  if (!spec) {
    return { kind, code: 'MEDIA_MODEL', error: '现在没有可用的' + (kind === 'image' ? '图片' : '视频') + '模型，先找管理员看一下通道' }
  }

  const notes = []
  // 模型：只认表里真的有的那几档，说错了不猜，按默认模型走（提示里说明）
  let model = spec.id
  if (kind === 'video') {
    const fast = body.match(/seedance[\s-]*2\.0[\s-]*(?:fast|极速)/i)
    if (fast) {
      const fastSpec = findModel('video', 'seedance-2.0-fast')
      if (fastSpec) {
        model = fastSpec.id
        body = body.replace(fast[0], ' ')
      }
    }
  }

  // 比例：图片默认 1:1、视频默认 9:16（与 media-models 里的第一档一致）
  let ratio = kind === 'image' ? spec.ratios[0] : '9:16'
  const ratioMatch = body.match(/(\d{1,2}:\d{1,2})/)
  if (ratioMatch) {
    const wanted = ratioMatch[1]
    body = body.replace(wanted, ' ')
    if (spec.ratios.includes(wanted)) ratio = wanted
    else notes.push('这个模型没有 ' + wanted + '，这次按 ' + ratio + ' 生成')
  }

  // 时长 / 清晰度只有视频有
  let duration = kind === 'video' ? spec.durations[0] : null
  let resolution = kind === 'video' ? spec.resolutions[0] : ''
  if (kind === 'video') {
    const durationMatch = body.match(/(\d{1,2})\s*(?:秒|s\b)/i)
    if (durationMatch) {
      const wanted = Number(durationMatch[1])
      body = body.replace(durationMatch[0], ' ')
      if (VIDEO_DURATIONS.includes(wanted) && spec.durations.includes(wanted)) duration = wanted
      else notes.push('视频只能 ' + spec.durations.map((item) => item + ' 秒').join(' / ') + '，这次按 ' + duration + ' 秒生成')
    }
    const resolutionMatch = body.match(/(480p|720p|1080p)/i)
    if (resolutionMatch) {
      const wanted = resolutionMatch[1].toLowerCase()
      body = body.replace(resolutionMatch[0], ' ')
      if (VIDEO_RESOLUTIONS.includes(wanted) && spec.resolutions.includes(wanted)) resolution = wanted
      else notes.push('这个模型只出 ' + spec.resolutions.join(' / ') + '，这次按 ' + resolution + ' 生成')
    }
  }

  // 参数词从提示词里拿掉，别让上游把「9:16」也当成画面描述
  const prompt = body
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/(?:\s*[,，、:：;；\-—]\s*)+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s,，、]+|[\s,，、]+$/g, '')
    .trim()
  if (prompt.length < 2) return { kind, code: 'MEDIA_PROMPT', error: usageOf(lead) }
  if (prompt.length > MAX_PROMPT_CHARS) notes.push('提示词太长，只把前 ' + MAX_PROMPT_CHARS + ' 字交给模型')

  return {
    kind,
    prompt: prompt.slice(0, MAX_PROMPT_CHARS),
    model,
    ratio,
    duration,
    resolution,
    notes,
    lead: lead.token,
  }
}
