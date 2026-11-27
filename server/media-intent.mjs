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
import { IMAGE_QUALITIES, VIDEO_RESOLUTIONS, defaultModelFor, findModel, halfWidthDigits, normalizeRatio, normalizeSize } from './media-models.mjs'

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

/**
 * 从话里抠参数：比例 / 尺寸 / 秒数 / 清晰度 / 画质。抠出来的词要从提示词里删掉，别让上游当画面描述。
 *
 * r342 两处补丁，都来自生产上的真事：
 *  1) 全角冒号与全角数字：中文输入法打的是「3：4」，旧的半角正则不认——图按 1:1 出来了，
 *     而「3 4的比例」还留在提示词里被当成画面描述（参数既没生效、又污染画面）。
 *  2) 参数后面的连接词一起吃掉：「3：4的比例」整段都算参数，抠完不能只剩「…图 的比例」。
 */
function extractParams(kind, spec, body) {
  const notes = []
  const locked = {}
  // r343：explicit 记的是「这一次用户到底明确说了哪些键」。
  // 光看值分不出来：
  //  - 比例 1:1 可能是默认档，也可能是用户真的写了「1:1」；
  //  - 「没带任何参数时不许凭空塞值」要求我们把这两种情况分开，
  //    所以抠到哪个键就在这里记一笔，最终写进会话的当前设置。
  const explicit = {}
  let rest = body
  let ratio = kind === 'image' ? spec.ratios[0] : (spec.ratios.includes('9:16') ? '9:16' : spec.ratios[0])
  let size = ''
  let duration = kind === 'video' ? spec.durations[0] : null
  let resolution = kind === 'video' ? spec.resolutions[0] : ''
  let quality = ''

  // 1) 比例：先认 n:m（半角 / 全角冒号 / 「比」），再认「竖屏 / 横屏 / 方形」
  const mRatio = /([0-9０-９]{1,2})\s*[:：∶]\s*([0-9０-９]{1,2})\s*(?:的)?\s*(?:比例|画幅|构图)?/.exec(rest)
    || /([0-9０-９]{1,2})\s*比\s*([0-9０-９]{1,2})\s*(?:的)?\s*(?:比例|画幅)?/.exec(rest)
  if (mRatio) {
    const wanted = normalizeRatio(halfWidthDigits(mRatio[1]) + ':' + halfWidthDigits(mRatio[2]))
    rest = rest.replace(mRatio[0], ' ')
    if (wanted) {
      ratio = wanted
      explicit.ratio = true
      if (!spec.ratios.includes(wanted)) locked.ratio = true
    }
  } else {
    for (const item of ORIENT) {
      if (!item.re.test(rest)) continue
      rest = rest.replace(item.re, ' ')
      ratio = item.ratio
      explicit.ratio = true
      if (!spec.ratios.includes(item.ratio)) locked.ratio = true
      break
    }
  }

  // 2) 尺寸：图片认「2048x2048 / 2K / 4K」；视频也认「1920x1080」并换算成比例与清晰度
  const mSize = /([0-9０-９]{2,4})\s*[x×*＊]\s*([0-9０-９]{2,4})\s*(?:的)?\s*(?:尺寸|大小|分辨率)?/i.exec(rest)
  if (mSize) {
    const w = Number(halfWidthDigits(mSize[1]))
    const h = Number(halfWidthDigits(mSize[2]))
    rest = rest.replace(mSize[0], ' ')
    if (w >= 64 && h >= 64 && w <= 4096 && h <= 4096) {
      if (kind === 'image') {
        size = w + 'x' + h
        locked.size = true
        explicit.size = true
        const wanted = reduceRatio(w, h)
        if (wanted) {
          ratio = wanted
          // 比例是从用户写的尺寸推出来的，同样算「这次明确说了比例」（r343）
          explicit.ratio = true
          if (!spec.ratios.includes(wanted)) locked.ratio = true
        }
      } else {
        const wantedRatio = reduceRatio(w, h)
        if (wantedRatio) {
          ratio = wantedRatio
          explicit.ratio = true
          if (!spec.ratios.includes(wantedRatio)) locked.ratio = true
        }
        const wantedResolution = h >= 1080 || w >= 1080 ? '1080p' : h >= 720 || w >= 720 ? '720p' : '480p'
        resolution = wantedResolution
        explicit.resolution = true
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
      explicit.size = true
    }
  }

  if (kind === 'image') {
    // 2.5) 画质（r342）：只认能确定是画质说法的那几个词。
    //      不把光秃秃的「标准」「普通」当画质——「标准流程」「普通背景」是画面描述，不是参数。
    const mQuality = /(高清|超清|高画质|精修|标清|标准画质|普通画质|低清|快速出图)\s*(?:的)?\s*(?:画质|质量|清晰度)?/.exec(rest)
    if (mQuality) {
      rest = rest.replace(mQuality[0], ' ')
      const word = mQuality[1]
      quality = /高清|超清|高画质|精修/.test(word) ? 'high' : /标清|标准画质|普通画质/.test(word) ? 'medium' : 'low'
      // 用户自己写了画质：这份是「指定」的，回答里要说清，上游不收就失败全额退回
      locked.quality = true
      explicit.quality = true
    }
  }

  if (kind === 'video') {
    // 3) 秒数：写死就认，超出 1–60 才退回默认并说明
    const mDuration = /([0-9０-９]{1,3})\s*(?:秒|s\b|Ｓ)\s*(?:的)?\s*(?:时长|秒数)?/i.exec(rest)
    if (mDuration) {
      const wanted = Number(halfWidthDigits(mDuration[1]))
      rest = rest.replace(mDuration[0], ' ')
      if (Number.isInteger(wanted) && wanted >= 1 && wanted <= 60) {
        duration = wanted
        explicit.duration = true
        if (!spec.durations.includes(wanted)) locked.duration = true
      } else {
        notes.push('秒数只能 1–60，这次按 ' + duration + ' 秒生成')
      }
    }
    // 4) 清晰度：写死就认
    const mResolution = /([0-9０-９]{3,4})\s*[pPＰ]\s*(?:的)?\s*(?:分辨率|清晰度)?/.exec(rest)
    if (mResolution) {
      const wanted = halfWidthDigits(mResolution[1]) + 'p'
      rest = rest.replace(mResolution[0], ' ')
      if (VIDEO_RESOLUTIONS.includes(wanted) || spec.resolutions.includes(wanted)) resolution = wanted
      else {
        resolution = wanted
        locked.resolution = true
      }
      explicit.resolution = true
    }
  }

  return { rest, ratio, size, duration, resolution, quality, notes, locked, explicit }
}

/**
 * 下拉里选的那几个参数（r342）：选了就按选的走，没选就跟随提示词。
 *
 * 为什么不把选择拼进提示词：拼进去就是让上游把「9:16」当画面描述——生产上已经出现过一次
 * （提示词里留着「3 4的比例」，出图跟着画歪）。所以选择只走参数通道；
 * 文本里写的那份照样被抠掉，只是不再决定实际值。
 * 选了表外的档（3:4 / 4:5）按「写死」处理：原样提交，上游不收就失败全额退回。
 */
function applyPicked(kind, spec, params, overrides = {}) {
  const picked = overrides && typeof overrides === 'object' ? overrides : {}
  const ratio = normalizeRatio(picked.ratio)
  if (ratio) {
    params.ratio = ratio
    params.explicit.ratio = true
    if (spec.ratios.includes(ratio)) delete params.locked.ratio
    else params.locked.ratio = true
  }
  const quality = String(picked.quality || '').trim().toLowerCase()
  if (IMAGE_QUALITIES.includes(quality)) {
    params.quality = quality
    params.locked.quality = true
    params.explicit.quality = true
  }
  if (kind !== 'video') return
  const duration = picked.duration === undefined || picked.duration === null || picked.duration === '' ? null : Number(picked.duration)
  if (Number.isInteger(duration) && duration >= 1 && duration <= 60) {
    params.duration = duration
    params.explicit.duration = true
    if (spec.durations.includes(duration)) delete params.locked.duration
    else params.locked.duration = true
  }
  const resolution = String(picked.resolution || '').trim().toLowerCase()
  if (/^[0-9]{3,4}p$/.test(resolution)) {
    params.resolution = resolution
    params.explicit.resolution = true
    if (spec.resolutions.includes(resolution)) delete params.locked.resolution
    else params.locked.resolution = true
  }
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
 * @param raw 用户这句话
 * @param overrides 界面下拉里选的参数（r342）：{ ratio, quality, duration, resolution }，没选就不传
 * @returns null（不是生成指令）| { kind, prompt, model, ratio, size, duration, resolution, quality, notes, locked, needsPrompt, lead } | { kind, code, error }
 */
export function parseMediaIntent(raw, overrides = {}) {
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
  // 模型：记录里写显示模型 id（用户认的名字），上游型号只在服务端通道里出现
  let model = spec.display
  if (kind === 'video') {
    const fast = body.match(/seedance[\s-]*2\.0[\s-]*(?:fast|极速)/i)
    if (fast) {
      const fastSpec = findModel('video', 'seedance-2.0-fast')
      if (fastSpec) {
        model = fastSpec.display
        body = body.replace(fast[0], ' ')
      }
    }
  }

  const params = extractParams(kind, spec, body)
  // 下拉里选过的：盖过文本里的那份；文本里那份照样已经从提示词里抠掉了
  applyPicked(kind, spec, params, overrides)
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
    quality: params.quality,
    duration: params.duration,
    resolution: params.resolution,
    notes,
    locked: params.locked,
    // r343：这次明确说/选的键（值是 defaults 补的就不在其中）——写完生成后要回写到会话的当前设置
    explicit: params.explicit,
    lead: lead.token,
  }
  // 只写了指令、没写画面：不报错也不空跑，交给对话层用文本模型把提示词写出来（r293）
  if (prompt.length < 2) return { ...plan, needsPrompt: true, usage: usageOf(lead) }
  return plan
}
// ── r343：会话级「当前生成设置」+「接着说一句改参数」 ─────────────────────────
//
// 用户在生产上的原话（2026-11-27）：出完一条之后再接着说「改成 8 秒」「换成 16:9」，
// 现在这句话被当成普通聊天，什么都没改（docs/r342 的边界里也记着「多轮修改仍没做」）。
// 这一版把它拆成两件事：
//  1) 会话上的当前设置 mediaDefaults：改一次就长期算数（旧会话没有这个字段 = {}，不许报错）；
//  2) 只改参数这一句：接得上上一版就按新参数重出一版，接不上就只记设置、一分钱不花。
//
// 判定与合并都写在这个文件里：与 r288 的 parseMediaIntent 同一个理由，路由与对话层只读一个真源。

/** 会话当前设置能记的四个键。尺寸不进长期记忆——它本来就是按比例算出来的。 */
export const MEDIA_PARAM_KEYS = ['ratio', 'quality', 'duration', 'resolution']

/** 键对应的中文名：回答里说人话用（「没有时长这一档」），不把键名丢给用户。 */
export const MEDIA_PARAM_LABELS = { ratio: '比例', quality: '画质', duration: '时长', resolution: '分辨率' }

/**
 * 会话当前设置只收形状对的值：坏值（超范围、乱写）直接丢掉，
 * 不让一条脏数据把后面的生成全带成失败。旧会话没有 mediaDefaults 字段时回 {}。
 */
export function sanitizeMediaDefaults(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const out = {}
  const ratio = normalizeRatio(raw.ratio)
  if (ratio) out.ratio = ratio
  const quality = String(raw.quality || '').trim().toLowerCase()
  if (IMAGE_QUALITIES.includes(quality)) out.quality = quality
  const duration = raw.duration === undefined || raw.duration === null || raw.duration === '' ? null : Number(raw.duration)
  if (Number.isInteger(duration) && duration >= 1 && duration <= 60) out.duration = duration
  const resolution = String(raw.resolution || '').trim().toLowerCase()
  if (/^[0-9]{3,4}p$/.test(resolution)) out.resolution = resolution
  return out
}

/** 会话当前设置叠加：后写的盖前面的；两边都先过一遍 sanitize。 */
export function mergeMediaDefaults(base, add) {
  return { ...sanitizeMediaDefaults(base), ...sanitizeMediaDefaults(add) }
}

function valueInSpec(spec, key, value) {
  if (!spec) return false
  if (key === 'ratio') return spec.ratios.includes(String(value))
  if (key === 'quality') return IMAGE_QUALITIES.includes(String(value))
  if (key === 'duration') return spec.durations.includes(Number(value))
  if (key === 'resolution') return spec.resolutions.includes(String(value))
  return false
}

/**
 * 把会话当前设置铺到一次生成下面（长期记忆 < 这次说 / 选的）。
 *
 * 返回三个东西：
 *  - plan：直接交给生成管线的参数。这次没说的键用会话设置补上，越过白名单的照样标 locked
 *    （原样提交、上游不收就失败全额退回）；
 *  - explicitValues：这次明确说 / 选的键，调用方要写回会话；
 *  - applied：这次是从会话设置补来的键（回答里可以说清「按上次的设置」）。
 *
 * 「没带任何参数时不许凭空塞值」就落在这里：explicit 里没有的键才可能被补，
 * 会话设置里也没有的键一个都不加。
 */
export function applyMediaDefaults(kind, plan, defaults) {
  const base = sanitizeMediaDefaults(defaults)
  const explicit = plan && plan.explicit && typeof plan.explicit === 'object' ? plan.explicit : {}
  const out = { ...plan, locked: { ...((plan && plan.locked) || {}) } }
  const explicitValues = {}
  const applied = []
  const spec = findModel(kind, defaultModelFor(kind))
  for (const key of MEDIA_PARAM_KEYS) {
    if (explicit[key]) {
      const value = out[key]
      if (value !== undefined && value !== null && value !== '') explicitValues[key] = value
      continue
    }
    if (base[key] === undefined) continue
    // 画质只管图片、时长与分辨率只管视频：不把这些键塞进另一种生成的参数里
    if (kind === 'image' && (key === 'duration' || key === 'resolution')) continue
    if (kind === 'video' && key === 'quality') continue
    out[key] = base[key]
    applied.push(key)
    if (!valueInSpec(spec, key, base[key])) out.locked[key] = true
  }
  return { plan: out, explicitValues, applied }
}

/**
 * 「上一版的参数 + 这次改的」收敛成一次生成要用的参数，并按模型档位重新标 locked。
 *
 * 为什么是重新标、不沿用上一版的 locked：改了比例之后，上一版那个 locked.size
 * 会把新比例顶掉（resolveSelection 里 locked.size 优先于 ratio），重出一版还是旧尺寸。
 */
export function planFromMediaParams(kind, params = {}) {
  const spec = findModel(kind, defaultModelFor(kind))
  const out = { ratio: '', size: '', quality: '', duration: null, resolution: '', locked: {} }
  const ratio = normalizeRatio(params.ratio)
  if (ratio) out.ratio = ratio
  const size = normalizeSize(params.size)
  if (size) {
    out.size = size
    out.locked.size = true
  }
  if (kind === 'image') {
    const quality = String(params.quality || '').trim().toLowerCase()
    if (IMAGE_QUALITIES.includes(quality)) {
      out.quality = quality
      // 与 r342 一致：画质是「选才传」，说了就按指定处理（上游不收就失败全额退回）
      out.locked.quality = true
    }
  } else {
    const duration = Number(params.duration)
    if (Number.isInteger(duration) && duration >= 1 && duration <= 60) out.duration = duration
    const resolution = String(params.resolution || '').trim().toLowerCase()
    if (/^[0-9]{3,4}p$/.test(resolution)) out.resolution = resolution
  }
  if (out.ratio && !valueInSpec(spec, 'ratio', out.ratio)) out.locked.ratio = true
  if (kind === 'video') {
    if (out.duration !== null && !valueInSpec(spec, 'duration', out.duration)) out.locked.duration = true
    if (out.resolution && !valueInSpec(spec, 'resolution', out.resolution)) out.locked.resolution = true
  }
  return out
}

// 「只说改参数」的动词，分两档：
//  - 强：改成 / 换成 / 调成 / 设置为… 后面直接跟值，不必再说参数名（「改成 8 秒」）；
//  - 弱：参数名 + 单字动词（「画质改高清」「比例用 16:9」）。
// 为什么单字动词必须带参数名：不带参数名时「要 8 秒的背景音乐」这种普通句子也会命中，
// 而误判的代价是白扣一次生成积分——这一轮的反证测试就盯着这条。
const STRONG_CHANGE_TAIL = /(改成|改为|改到|改一下|改下|换成|换为|换到|换个|换一下|调成|调到|调为|调一下|调整为|调整成|设为|设成|设置成|设置为|变成|弄成|搞成)$/
const WEAK_CHANGE_TAIL = /(比例|画幅|尺寸|时长|秒数|画质|质量|分辨率|清晰度)((?:改|换|调|用|来|要)+(?:成|为|到|一下|下)?)$/
// 句首的「我要 / 用 / 来 / 要」也是改参数的说法（「我要 16:9」），但它必须**整句就说到这儿**：
// 后面还跟着一个东西（「要 8 秒的背景音乐」）就说明这是普通句子，不是在改设置。
const BARE_CHANGE_LEAD = /^(用|来|要|我要|我想要|需要)$/
const BARE_CHANGE_TAIL_OK = /^[\s,，、。！!~～的了吧啊呀呗哈]*$/
// 在征求意见、不是在下指令：「换成 16:9 会不会更好」不许重出
const CHANGE_ADVICE = /(会不会|好不好|行不行|合不合适|值不值|有必要)/
// 问句里带的参数通常是在问「这是什么意思」，不是在改
const CHANGE_QUESTION = /(怎么|如何|为什么|为啥|什么|吗|呢|多少|多久|几秒|哪)/

const CHANGE_ORIENT = [
  { re: /(竖屏|竖版|竖着|竖屏版)/, ratio: '9:16' },
  { re: /(横屏|横版|横着|横屏版)/, ratio: '16:9' },
  { re: /(方形|正方形|方图)/, ratio: '1:1' },
]

function qualityWord(word) {
  return /高清|超清|高画质|精修/.test(word) ? 'high' : /标清|标准画质|普通画质/.test(word) ? 'medium' : 'low'
}

// 值扫描表：每个键一条（或几条）正则，value 把命中转成最终值；转不出来（超范围）的不算改。
const PARAM_SCAN = [
  {
    key: 'ratio',
    re: '([0-9０-９]{1,2})\\s*[:：∶]\\s*([0-9０-９]{1,2})(?:\\s*(?:的)?\\s*(?:比例|画幅|构图))?',
    value: (m) => normalizeRatio(halfWidthDigits(m[1]) + ':' + halfWidthDigits(m[2])),
  },
  {
    key: 'ratio',
    re: '([0-9０-９]{1,2})\\s*比\\s*([0-9０-９]{1,2})(?:\\s*(?:的)?\\s*(?:比例|画幅))?',
    value: (m) => normalizeRatio(halfWidthDigits(m[1]) + ':' + halfWidthDigits(m[2])),
  },
  {
    key: 'quality',
    re: '(高清|超清|高画质|精修|标清|标准画质|普通画质|低清|快速出图)\\s*(?:的)?\\s*(?:画质|质量|清晰度)?',
    value: (m) => qualityWord(m[1]),
  },
  {
    key: 'duration',
    re: '([0-9０-９]{1,3})\\s*(?:秒|s\\b|Ｓ)\\s*(?:的)?\\s*(?:时长|秒数)?',
    value: (m) => {
      const value = Number(halfWidthDigits(m[1]))
      return Number.isInteger(value) && value >= 1 && value <= 60 ? value : ''
    },
  },
  {
    key: 'resolution',
    re: '([0-9０-９]{3,4})\\s*[pPＰ]\\s*(?:的)?\\s*(?:分辨率|清晰度)?',
    value: (m) => halfWidthDigits(m[1]) + 'p',
  },
]

function orientationSpans(text) {
  const found = []
  for (const item of CHANGE_ORIENT) {
    const re = new RegExp(item.re.source, 'g')
    let matched
    while ((matched = re.exec(text))) found.push({ key: 'ratio', value: item.ratio, index: matched.index, length: matched[0].length })
  }
  return found
}

/** 值前面那几个字里有没有「改参数」的说法；返回 strong / weak / 空。 */
function changeLevelBefore(text, index) {
  const tail = text.slice(0, index).replace(/[\s,，、。:：;；\-—]+$/, '')
  const slice = tail.slice(-12)
  if (STRONG_CHANGE_TAIL.test(slice)) return 'strong'
  if (WEAK_CHANGE_TAIL.test(slice)) return 'weak'
  return ''
}

/** 句首只有「我要 / 用 / 来 / 要」，且值后面没有别的东西：才算改参数。 */
function bareChangeLevel(text, index, length) {
  const tail = text.slice(0, index).replace(/[\s,，、。:：;；\-—]+$/, '')
  if (!BARE_CHANGE_LEAD.test(tail.slice(-6))) return ''
  return BARE_CHANGE_TAIL_OK.test(text.slice(index + length)) ? 'weak' : ''
}

/**
 * 从一句「接着说」里认出改参数（r343）。
 *
 * @returns null（不是改参数）| { values, explicit, kindHint, text }
 *   values 是这次要改成的值；kindHint 只用来把回答里的量词说顺（下一张 / 下一段），
 *   不决定这次生成是图片还是视频——那由上一版决定。
 */
export function parseParamChange(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  // 开头就是生成指令的（「生成一张图 改成 16:9」）走生成那条路，这一层不抢
  if (parseMediaIntent(text)) return null

  const spans = []
  for (const item of PARAM_SCAN) {
    const re = new RegExp(item.re, 'g')
    let matched
    while ((matched = re.exec(text))) {
      const value = item.value(matched)
      if (value === '' || value === undefined || value === null) continue
      const level = changeLevelBefore(text, matched.index) || bareChangeLevel(text, matched.index, matched[0].length)
      if (!level) continue
      spans.push({ key: item.key, value, index: matched.index, level })
    }
  }
  for (const item of orientationSpans(text)) {
    const level = changeLevelBefore(text, item.index) || bareChangeLevel(text, item.index, item.length)
    if (level) spans.push({ ...item, level })
  }
  if (!spans.length) return null
  if (CHANGE_ADVICE.test(text)) return null
  // 弱动词必须「不是问句」才认；强动词（改成 / 换成…）问句里也是在提要求（「能不能改成 8 秒」）
  if (CHANGE_QUESTION.test(text) && !spans.some((span) => span.level === 'strong')) return null

  spans.sort((a, b) => a.index - b.index)
  const values = {}
  const explicit = {}
  for (const span of spans) {
    values[span.key] = span.value
    explicit[span.key] = true
  }
  const kindHint = /(视频|短片|片子|片段|短视频)/.test(text) ? 'video' : /(图片|图|海报|封面)/.test(text) ? 'image' : ''
  return { values, explicit, kindHint, text }
}

