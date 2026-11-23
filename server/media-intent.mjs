// r288：对话框里一句话直接出图 / 出视频（明确触发词，不依赖上游 function calling）。
// r293：把「口语怎么说」和「写死的参数」补齐——用户说「帮我出个视频」就该出，写了 1080p / 12 秒 /
// 4:5 就按写的提交，不再被默认档位悄悄顶掉。
//
// 为什么先做触发词，而不是直接把 tools 透给上游（见 docs/r288-chat-generate-2026-11-20.md）：
//  1) server/chatcall.mjs 现在不透 tools / tool_calls，要让模型自己决定去生成，先得改上游契约，
//     而 deepseek-flash 认不认 tools 还没验过（验一次要真调文本）；
//  2) 生成是要花积分的动作：触发词用户看得懂、单测卡得住，也不会因为模型「理解得很热情」，
//     在多聊两句时顺手画一张图。
//
// 判定规则写死在这个文件里，路由与界面都只读它一个真源：
//  - 只认「开头就是生成指令」的句子：「怎么生成图」「生成一张图要多久」都不算命令；
//  - 自然语言触发词后面必须有断点，「生成视频教程的文案」仍然按普通对话处理；
//  - 参数（比例 / 尺寸 / 秒数 / 清晰度）从话里抠出来，抠出来的词不进提示词；
//    写死的值放进 locked，交给 server/media-models.mjs 原样提交。
import { VIDEO_RESOLUTIONS, defaultModelFor, findModel, normalizeRatio } from './media-models.mjs'

// 生成上限与 server/routes/media-gen.mjs 的 MAX_PROMPT_CHARS 一致：那边才是真拒绝的地方
const MAX_PROMPT_CHARS = 1200

// 「帮我 / 请 / 给我」这类客气话可以出现在指令前面，最多剥两层
const POLITE = ['请', '帮我', '帮忙', '麻烦', '给我', '我想', '我要', '能不能', '可以']

const SLASH_LEADS = {
  image: ['/生图', '/画图', '/图'],
  video: ['/生视频', '/视频'],
}

// 说全的形态：这些一眼就是指令，比正则稳，先照旧留着
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
    '生成一张封面',
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

// r293 的口语族：动词 + 量词 + 名词。「出个视频」「做条短视频」「来一段」「整一个视频」都在这里，
// 不必再往上面的词表里一条条加（上一版就是词表漏了「出个」才把「帮我出个视频」当成了普通聊天）。
const VERB_LEAD = /^(?:出|做|来|拍|整|生成|搞|画)(?:一|两|个|条|段|支|张|幅|期){0,2}\s*(短视频|视频|小视频|图片|图|海报|封面图|封面)/
// 名词 → 能力：只有图片类的名词算图，其余都算视频
const IMAGE_NOUNS = /^(图片|图|海报|封面图|封面)$/

// 长的先匹配：「生成一张图片」不能被「生成一张」抢走，「生成视频教程」也不该被当成命令
const LEADS = [
  ...Object.entries(SLASH_LEADS).flatMap(([kind, list]) => list.map((token) => ({ kind, token, slash: true }))),
  ...Object.entries(NATURAL_LEADS).flatMap(([kind, list]) => list.map((token) => ({ kind, token, slash: false }))),
].sort((a, b) => b.token.length - a.token.length)

// 自然语言触发词后面必须有个断点（空格、标点、比例数字、秒数），否则「生成视频教程的文案」会被误解成要出视频
const TAIL_OK = /^[\s:：,，、。;；\-—0-9（(“"吧啊呀呗哈]/
// 「生成一张图要多久」这类是在问问题：这些开头说明后面跟的是问题，不是提示词
const QUESTION_START = /^(要|会|能|需|得|大概|多少|多久|多长|怎么|如何|为什么|为啥|可不可以|是不是|行不行|吗|呢)/
// 竖屏 / 横屏 / 方形这类口语比例
const ORIENT = [
  { re: /(竖屏|竖版|竖着|竖屏版)/, ratio: '9:16' },
  { re: /(横屏|横版|横着|横屏版)/, ratio: '16:9' },
  { re: /(方形|正方形|方图)/, ratio: '1:1' },
]

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

// 动词 + 量词，名词被参数隔在后面：「帮我做一个 30 秒的抖音爆款视频，卖毛衣收纳袋」。
// 这一族的 body 保留名词（它本身就是风格线索），交给后面的改写把这句理成提示词。
const LOOSE_VERB = /^(?:出|做|来|拍|整|生成|搞|画)(?:一|两|个|条|段|支|张|幅|期){0,2}\s*/
const MEDIA_NOUN = /(短视频|视频|小视频|图片|海报|封面图|封面|图)/
// 名词离动词太远就不是指令了（「做个方案再剪视频」这种）
const LOOSE_MAX_GAP = 24

function afterNounOk(tail, noun, at) {
  const after = tail.slice(at + noun.length)
  return !after || TAIL_OK.test(after)
}

function matchLead(text) {
  for (const item of LEADS) {
    if (!text.startsWith(item.token)) continue
    const tail = text.slice(item.token.length)
    // 斜杠指令本身就是命令，不要求后面还有断点；自然语言触发词要有个断点才算
    if (!item.slash && tail && !TAIL_OK.test(tail)) continue
    return { ...item, tail }
  }
  const spoken = VERB_LEAD.exec(text)
  if (spoken) {
    const tail = text.slice(spoken[0].length)
    if (tail && !TAIL_OK.test(tail)) return null
    const kind = IMAGE_NOUNS.test(spoken[1]) ? 'image' : 'video'
    return { kind, token: spoken[0].trim(), slash: false, tail }
  }
  const loose = LOOSE_VERB.exec(text)
  if (loose) {
    const tail = text.slice(loose[0].length)
    const noun = MEDIA_NOUN.exec(tail)
    if (noun && noun.index <= LOOSE_MAX_GAP && afterNounOk(tail, noun[0], noun.index)) {
      const kind = IMAGE_NOUNS.test(noun[1]) ? 'image' : 'video'
      return { kind, token: loose[0].trim(), slash: false, tail }
    }
  }
  return null
}

/** 从话里抠参数：比例 / 尺寸 / 秒数 / 清晰度。抠出来的词要从提示词里删掉，别让上游当画面描述。 */
function extractParams(kind, spec, body) {
  const notes = []
  const locked = {}
  let rest = body
  let ratio = kind === 'image' ? spec.ratios[0] : (spec.ratios.includes('9:16') ? '9:16' : spec.ratios[0])
  let size = ''
  let duration = kind === 'video' ? spec.durations[0] : null
  let resolution = kind === 'video' ? spec.resolutions[0] : ''

  // 1) 比例：先认 n:m，再认「竖屏 / 横屏 / 方形」
  const mRatio = /(\d{1,2})\s*:\s*(\d{1,2})/.exec(rest)
  if (mRatio) {
    const wanted = normalizeRatio(mRatio[1] + ':' + mRatio[2])
    rest = rest.replace(mRatio[0], ' ')
    if (wanted) {
      ratio = wanted
      if (!spec.ratios.includes(wanted)) locked.ratio = true
    }
  } else {
    for (const item of ORIENT) {
      if (!item.re.test(rest)) continue
      rest = rest.replace(item.re, ' ')
      if (spec.ratios.includes(item.ratio)) ratio = item.ratio
      else {
        ratio = item.ratio
        locked.ratio = true
      }
      break
    }
  }

  // 2) 尺寸：图片认「2048x2048 / 2K / 4K」；视频也认「1920x1080」并换算成比例与清晰度
  const mSize = /(\d{2,4})\s*[x×*]\s*(\d{2,4})/i.exec(rest)
  if (mSize) {
    const w = Number(mSize[1])
    const h = Number(mSize[2])
    rest = rest.replace(mSize[0], ' ')
    if (w >= 64 && h >= 64 && w <= 4096 && h <= 4096) {
      if (kind === 'image') {
        size = w + 'x' + h
        locked.size = true
        const wanted = reduceRatio(w, h)
        if (wanted) {
          ratio = wanted
          if (!spec.ratios.includes(wanted)) locked.ratio = true
        }
      } else {
        const wantedRatio = reduceRatio(w, h)
        if (wantedRatio) {
          ratio = wantedRatio
          if (!spec.ratios.includes(wantedRatio)) locked.ratio = true
        }
        const wantedResolution = h >= 1080 || w >= 1080 ? '1080p' : h >= 720 || w >= 720 ? '720p' : '480p'
        resolution = wantedResolution
        if (!spec.resolutions.includes(wantedResolution)) locked.resolution = true
      }
    }
  } else if (kind === 'image') {
    const mK = /\b(2k|4k)\b/i.exec(rest)
    if (mK) {
      rest = rest.replace(mK[0], ' ')
      const longSide = mK[1].toLowerCase() === '4k' ? 4096 : 2048
      const [a, b] = ratio.split(':').map(Number)
      const long = Math.max(a, b)
      const round8 = (value) => Math.min(4096, Math.max(64, Math.round(value / 8) * 8))
      size = round8((a / long) * longSide) + 'x' + round8((b / long) * longSide)
      locked.size = true
    }
  }

  if (kind === 'video') {
    // 3) 秒数：写死就认，超出 1–60 才退回默认并说明
    const mDuration = /(\d{1,3})\s*(?:秒|s\b)/i.exec(rest)
    if (mDuration) {
      const wanted = Number(mDuration[1])
      rest = rest.replace(mDuration[0], ' ')
      if (Number.isInteger(wanted) && wanted >= 1 && wanted <= 60) {
        duration = wanted
        if (!spec.durations.includes(wanted)) locked.duration = true
      } else {
        notes.push('秒数只能 1–60，这次按 ' + duration + ' 秒生成')
      }
    }
    // 4) 清晰度：写死就认
    const mResolution = /(\d{3,4})\s*p\b/i.exec(rest)
    if (mResolution) {
      const wanted = mResolution[1] + 'p'
      rest = rest.replace(mResolution[0], ' ')
      if (VIDEO_RESOLUTIONS.includes(wanted) || spec.resolutions.includes(wanted)) resolution = wanted
      else {
        resolution = wanted
        locked.resolution = true
      }
    }
  }

  return { rest, ratio, size, duration, resolution, notes, locked }
}

/** 1920x1080 → 16:9；1024x1536 → 9:16。约不出来的（如 1000x999）就回空。 */
function reduceRatio(w, h) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const d = gcd(w, h)
  const a = w / d
  const b = h / d
  if (a > 64 || b > 64) return ''
  return a + ':' + b
}

/**
 * 从一句话里认出「要生成图片 / 视频」以及参数。
 *
 * @returns null（不是生成指令）| { kind, prompt, model, ratio, size, duration, resolution, notes, locked, needsPrompt, lead } | { kind, code, error }
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

  const params = extractParams(kind, spec, body)
  notes.push(...params.notes)
  body = params.rest

  // 参数词从提示词里拿掉，别让上游把「9:16」也当成画面描述
  const prompt = body
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/(?:\s*[,，、:：;；\-—]\s*)+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s,，、]+|[\s,，、]+$/g, '')
    // 上面抠掉「30 秒」后会剩下一个「的」：「的抖音爆款视频，卖毛衣收纳袋」
    .replace(/^的+/, '')
    // 口语那句常以「…的短视频 / …的封面图」收尾，最后那个名词是句式外壳，不是画面
    .replace(kind === 'video' ? /的(?:短视频|视频)$/ : /的(?:图片|海报|封面图|封面|图)$/, '')
    .trim()
  if (prompt.length > MAX_PROMPT_CHARS) notes.push('提示词太长，只把前 ' + MAX_PROMPT_CHARS + ' 字交给模型')

  const plan = {
    kind,
    prompt: prompt.slice(0, MAX_PROMPT_CHARS),
    model,
    ratio: params.ratio,
    size: params.size,
    duration: params.duration,
    resolution: params.resolution,
    notes,
    locked: params.locked,
    lead: lead.token,
  }
  // 只写了指令、没写画面：不报错也不空跑，交给对话层用文本模型把提示词写出来（r293）
  if (prompt.length < 2) return { ...plan, needsPrompt: true, usage: usageOf(lead) }
  return plan
}
