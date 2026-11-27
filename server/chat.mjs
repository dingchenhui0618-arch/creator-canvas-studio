// 快捷创作对话（r214 建立，r217 加流式）：一页 DeepSeek —— 长上下文、联网搜索、读链接、思考模式。
//
// 为什么要单独一条链路：以前的「对话」是对话预设的短轮问答（每次带预设、输出类型、结构化草稿），
// 用户说那本质上是伪智能体。这里换成平台对话模型的直接多轮：
//  - 会话在服务端存，关页面、换设备回来还在；
//  - 上下文取最近 30 条（单条最长 8000 字），不是只带上一句；
//  - 联网搜索 / 读链接是官方服务端工具，思考模式开到官方 thinking；
//  - 先扣费后调用，失败、空回复、用户按停止都全额退回；没登录不扣费（本地演示）。
//
// r217 补上流式：`sendChatMessage`（一次性）与 `streamChatMessage`（逐字）共用同一套
// 「扣费 → 落用户这句 → 调模型 → 落回答 / 退款」的流程，只是取结果的方式不同。
// 两条链路的行为必须一致，所以下面把前半段（beginChat）和收尾（finishChat / failChat）抽出来，
// 不各写一份——以前每加一条链路就要把退款口径再抄一遍，抄漏一次就是真金白银的差评。
//
// r218 接上附件：脚本/文档/表格/PDF 先在服务端读成文字，再连同问题一起问模型（server/chat-files.mjs）。
// 附件是「这一轮的上下文」，不是文件托管：原文落盘 20 份轮转，抽出的文字跟着这条消息进上下文。
// r219 接上读链接：消息里带网址时，先在本地把页面读成文字（server/link-read.mjs），
// 不再依赖上游 deepseek_read_url —— 一把 Key 不认这个工具就会整条请求 400。
// r245 接上图片：截图、手机拍的稿子原样交给视觉模型看，图里的字由模型自己读（本地不做 OCR）。
// 只把图片放进「发送那一轮」：更早的轮次在上下文里只剩一行占位说明，不是每轮都重复付图片的输入费。
// 带图的一轮走一次性回答（多模态 + 流式在不同上游并不都成立，一条 400 会让整次对话失败并退款）。
// r246 接上真的联网搜索：平台自己用自己的搜索服务搜一次、自己把前 3 条网页读成文字
// （server/web-search.mjs）。同时把上游的 deepseek_web_search 工具撤掉——上游不认它就整条 400。
// 没配搜索服务时不假装搜过：开关在界面是禁用的，万一带了也只在上下文里写一句「没搜成」。
// r288 接上直接生成：一句话开头是「/生图」「生成一段视频」这类指令时，这一轮不走对话模型，
// 直接交给现成的生成管线（server/media-intent.mjs 认指令，server/chat-media.mjs 开任务）；
// 生成积分照旧由媒体管线扣、失败照旧全额退，对话那 1 积分不扣。问「怎么生成图」不会被当成命令。
// 还没做的：语音。
import { callTextModel, callTextModelStream, visionChain } from './llm.mjs'
import { charge, priceOf, refund } from './credits.mjs'
import { contextMessages, createConversation, getConversation, latestConversationImage, recentMediaTask, saveConversation, titleFrom } from './chat-store.mjs'
import { CHAT_FILE_LIMITS, readChatFileBytes, resolveChatFiles } from './chat-files.mjs'
import { findLinks, readLinks } from './link-read.mjs'
import { publicSearch, searchAndRead } from './web-search.mjs'
import { publicError } from './public-error.mjs'
import {
  MEDIA_PARAM_KEYS,
  MEDIA_PARAM_LABELS,
  applyMediaDefaults,
  mergeMediaDefaults,
  parseMediaIntent,
  parseParamChange,
  planFromMediaParams,
  sanitizeMediaDefaults,
} from './media-intent.mjs'
import { defaultModelFor } from './media-models.mjs'
import { enhanceMediaPrompt } from './media-prompt.mjs'
import { startChatMedia } from './chat-media.mjs'

const MAX_INPUT = 8000
const CONTEXT_MESSAGES = 30
const MAX_OUTPUT_TOKENS = 4096
// 截图要看字，用 high：low 会把 1024 宽的稿子压成 512，标题还行，小一号的正文就糊了。
const IMAGE_DETAIL = 'high'
// 画质的三档在用户面前只叫这三种说法（与图片面板的下拉一致）
const QUALITY_LABEL = { low: '快速', medium: '标准', high: '高清' }

// r343（用户明确要求）：模型只能自称「VisionQA 通用模型」。
// 提示词里**不写**上游厂牌与型号的举例——那句话本身就会随上下文进模型，
// 把例子写进去等于教它说这些名字；要防的名字放在这条注释里，不要进字符串。
const SYSTEM_PROMPT = [
  '你是 VisionQA 通用模型，回答一律用简体中文。',
  '被问到「你是什么模型 / 是哪家的 / 什么版本」时，只回答「我是 VisionQA 通用模型」；不许提到任何上游厂牌或型号，也不许说「我底层是…」。',
  '你的用户在做短视频与图文内容：找选题、拆结构、写脚本、出分镜、写提示词、复盘数据。',
  '说话要具体、能直接照着做；不要寒暄，不要复述用户的问题，不要编造数据与来源。',
  '需要最新信息或具体链接时，先联网搜索或读取用户给的链接，再给结论；引用时把链接原样写出来。',
  '不确定就说不确定，并说明还需要什么信息。',
  // r342：用户问「每次对话都会扣 1 积分吗」时，模型只能说「我不确定，也不该替平台乱答」——
  // 平台自己的价与退回规则不该让模型去猜，这是实话，写进系统提示词。
  '平台的口径（用户问起时照实说）：对话一轮 1 积分；出图 / 出视频按模型标价，先扣后调，失败、空回复或用户按停止都全额退回。',
  '生成图片 / 视频的比例、画质、时长、分辨率由系统参数处理，不要把这些参数写进提示词里，也不要在回答里编造参数。',
].join('\n')

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

export function chatOptionsFrom(input = {}) {
  const tools = input && typeof input.tools === 'object' && input.tools ? input.tools : {}
  return { search: Boolean(tools.search), readUrl: Boolean(tools.readUrl), thinking: Boolean(tools.thinking) }
}

/**
 * 上游服务端工具：r246 起一个都不带了。
 * 联网搜索改成平台自己搜（server/web-search.mjs），读链接 r219 就已经在本地读。
 * 为什么不再带上游工具：上游不认这个工具就整条 400——用户打开开关换来的是一句
 * 「这次没有回上来，积分已退回」，而他自己并不知道上游根本没这个能力。
 */
export function officialTools() {
  return []
}

/** 这一轮的联网搜索：开关关着就不搜（一条都不发）。搜不到不抛错，交给上下文里那一句如实说明。 */
async function runSearch(content, options) {
  if (!options.search) return { search: null, links: [], text: '', chars: 0 }
  try {
    return await searchAndRead(content)
  } catch (error) {
    return {
      search: { ok: false, code: 'SEARCH_FAIL', query: '', provider: '', providerLabel: '', results: [], note: String(error?.message || error) },
      links: [],
      text: '【联网搜索没有成功：' + String(error?.message || error) + '】',
      chars: 0,
    }
  }
}

/** 这一轮消息里的链接：开关关着就一条都不读（界面会提示打开）。 */
async function readMessageLinks(content, options) {
  if (!options.readUrl) return { links: [], text: '', chars: 0, requested: 0, found: [] }
  const found = findLinks(content)
  if (!found.length) return { links: [], text: '', chars: 0, requested: 0, found }
  const result = await readLinks(found)
  return { ...result, found }
}

/** 这一轮的图片：读成 base64 data URL，跟文字一起拼进多模态正文（detail=high，见上面）。 */
function imageParts(userId, files) {
  const parts = []
  let count = 0
  for (const file of files) {
    const raw = readChatFileBytes(userId, file.id)
    if (!raw) continue
    count += 1
    parts.push({ type: 'text', text: '图片 ' + count + '：' + file.name })
    parts.push({
      type: 'image_url',
      image_url: { url: 'data:' + raw.mime + ';base64,' + raw.buffer.toString('base64'), detail: IMAGE_DETAIL },
    })
  }
  return { parts, count }
}

/** 这一轮带哪几个附件：先按归属读，读不到就跳过（别人的 / 已删除），不让整次对话失败。 */
function readAttachments(userId, input = {}) {
  const raw = Array.isArray(input?.files) ? input.files.map(String).filter(Boolean) : []
  if (!raw.length) return { files: [], text: '', skipped: 0, chars: 0 }
  if (raw.length > CHAT_FILE_LIMITS.maxPerMessage) {
    throw fail(400, 'CHAT_FILES', '一条消息最多带 ' + CHAT_FILE_LIMITS.maxPerMessage + ' 个附件')
  }
  return resolveChatFiles(userId, raw)
}

function messageId(prefix = 'm') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** 扣费 + 落用户这句话，两条链路共用。 */
async function beginChat(user, input = {}) {
  const content = String(input?.content || '').trim()
  if (!content) throw fail(400, 'CHAT_EMPTY', '说点什么再发送')
  if (content.length > MAX_INPUT) throw fail(400, 'CHAT_TOO_LONG', '一次最多 ' + MAX_INPUT + ' 字，长文请分几条发')
  if (!user?.id) throw fail(401, 'LOGIN_REQUIRED', '请先登录')

  // 会话先认下来（r288）：生成指令也要落进会话里，开任务失败时用户那句话不能凭空消失
  let conv = input.conversationId ? getConversation(user.id, input.conversationId) : null
  if (input.conversationId && !conv) throw fail(404, 'CHAT_NOT_FOUND', '这条对话已经不在了')
  if (!conv) conv = createConversation(user.id, { title: titleFrom(content) })

  // r288：开头就是「/生图」「生成一段视频」这类指令时，不走对话模型，直接接到现成的生成管线。
  // 认不出来就照常当对话回答——问「怎么生成图」不会被当成要花积分。
  // r342：下拉里选的比例 / 画质 / 时长 / 分辨率一起交给解析器，选了就以选的为准
  const media = parseMediaIntent(content, input.media)
  if (media) {
    // r343：会话当前设置是「长期记忆」，这次说 / 选的覆盖它；这次明确说 / 选的再写回去。
    // 两件事分开做：没说的键只借会话设置（不写回），说过的键才落到会话上（没参数就一个都不加）。
    const merged = applyMediaDefaults(media.kind, media, conv.mediaDefaults)
    conv.mediaDefaults = mergeMediaDefaults(conv.mediaDefaults, merged.explicitValues)
    return beginMediaChat(user, conv, content, merged.plan, input)
  }

  // r343：没有生成动词，但这句话就是在改参数（「改成 8 秒」「换成 16:9」「画质改高清」）。
  // 这一轮不扣对话积分：接得上上一版就按新参数重出一版（生成管线自己扣费 / 退款），
  // 接不上就只把设置记在会话上，一分钱都不花。
  const change = parseParamChange(content)
  if (change) {
    // 对话框里这次选的那几档也算「明确改参数」：选了就以选的为准（与 r342 的覆盖顺序一致）
    const picked = sanitizeMediaDefaults(input.media)
    for (const key of Object.keys(picked)) {
      change.values[key] = picked[key]
      change.explicit[key] = true
    }
    return beginParamChangeChat(user, conv, content, change, input)
  }

  // 附件与链接都先读完再扣费：读不出来（扫描件、超过 5 个、链接打不开）时一分钱都不该扣
  const options = chatOptionsFrom(input)
  const attachments = readAttachments(user.id, input)
  // 读链接放在会话校验之后：会话已经不在的请求不该先去抓一遍网页
  const linked = await readMessageLinks(content, options)
  // 联网搜索（r246）：用户自己贴了链接就不搜了——先把他的页面读准，
  // 再自己搜一遍只会多读三张网页、多花十几秒，还可能把他要问的那件事带偏。
  const searched = linked.links.length ? { search: null, links: [], text: '', chars: 0 } : await runSearch(content, options)
  const docText = [attachments.text, linked.text, searched.text].filter(Boolean).join('\n\n')

  // 图片在扣费之前读：原图读不到（被顶掉了 / 不是自己的）就不该扣这一轮的钱
  const images = attachments.files.filter((file) => file.kind === 'image')
  if (images.length > CHAT_FILE_LIMITS.imagesPerMessage) {
    throw fail(400, 'CHAT_IMAGES', '一条消息最多带 ' + CHAT_FILE_LIMITS.imagesPerMessage + ' 张图片：把要问的那两张挑出来再发')
  }
  const pictures = imageParts(user.id, images)
  if (images.length && !pictures.count) {
    throw fail(422, 'CHAT_IMAGE_UNREADABLE', '这几张图的原图读不到了：重新传一次再发')
  }

  const paid = charge(user.id, 'chat', {
    ref: '对话 · ' + conv.title,
    amount: priceOf('chat'),
    meta: { conversationId: conv.id, search: options.search, readUrl: options.readUrl, thinking: options.thinking },
  })
  if (!paid.ok) {
    const error = fail(402, paid.code || 'CREDIT_INSUFFICIENT', paid.message || '余额不够发起这次对话')
    error.balance = paid.balance
    error.needed = paid.needed
    throw error
  }

  const startedAt = Date.now()
  // 界面会先建一条空会话再发第一句（这样才能「一边建一边打字」），于是标题一直停在「新对话」。
  // 第一句进来时用它的开头当标题：这是左侧列表唯一能认出来的信息（r217 实测：以前十条全是「新对话」）。
  if (!conv.messages.some((item) => item.role === 'user')) conv.title = titleFrom(content)
  // 附件抽出来的文字跟这条消息一起存：下一轮还能用上（长对话里最早的那几轮会被上下文窗口挤掉，
  // 挤掉就只剩文件名，界面与文档都这么说，不假装还记着）。
  conv.messages.push({
    id: messageId('u'),
    role: 'user',
    content,
    at: startedAt,
    files: attachments.files,
    links: linked.links,
    search: publicSearch(searched.search),
    docText,
  })
  const savedTurn = saveConversation(user.id, conv)
  conv = savedTurn || conv

  const tools = officialTools(options)
  const extra = {}
  if (tools.length) extra.tools = tools
  if (options.thinking) extra.thinking = { type: 'enabled' }

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...contextMessages(conv.messages)]
  if (pictures.count) {
    // 只把「这一条」换成多模态正文：文字照旧（含这一轮的附件与链接），图跟在后面。
    // 更早的轮次不重复带图（chat-store 里留的是一行占位说明），否则每追问一句都要再付一遍图片输入费。
    const turnText = [content, docText ? '【这一轮的附件与链接】\n' + docText : ''].filter(Boolean).join('\n\n')
    messages[messages.length - 1] = {
      role: 'user',
      content: [
        { type: 'text', text: turnText + '\n\n（下面是这一轮带的 ' + pictures.count + ' 张图，直接看原图；图里的字按你看到的写。）' },
        ...pictures.parts,
      ],
    }
  }

  return {
    conv,
    // 发出去的那句（还没落回答）就已经挤掉了多少条：跟落回答那次合起来算这一轮一共挤掉几条
    evicted: Number(savedTurn?.trimmedNow) || 0,
    options,
    tools,
    extra,
    paid,
    startedAt,
    messages,
    attachments,
    links: linked.links,
    search: publicSearch(searched.search),
    visionTurn: pictures.count > 0,
  }
}

// 参考图的扩展名：给上游 multipart 用，按服务端认出来的 mime 定，不信客户端文件名
const REF_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/**
 * 生成指令带的那张参考图（r289）：对话附件里的图本来就是读给模型看的，
 * 这里把它读出来直接当生成管线的参考素材——不再要求先去「图片」页签入素材库。
 * 只收 1 张：生图只有「参考图」一种带图方式（1 张），生视频是「首帧」（也是 1 张）。
 * 文档附件不静默丢掉：生成指令只认图，让用户知道那份文档没被算进去。
 */
function mediaReferences(user, input, plan, conv) {
  const raw = Array.isArray(input?.files) ? input.files.map(String).filter(Boolean) : []
  const notes = []
  let ids = raw
  let reused = null
  if (!ids.length) {
    const latest = latestConversationImage(conv)
    if (latest) {
      ids = [String(latest.id)]
      reused = latest
    }
  }
  if (!ids.length) return { files: [], refs: [], notes }
  const resolved = resolveChatFiles(user.id, ids)
  const docs = resolved.files.filter((file) => file.kind !== 'image')
  if (docs.length) {
    throw fail(
      400,
      'MEDIA_CHAT_REF_DOC',
      '生成指令只认参考图片：' + docs.map((file) => file.name).join('、') + ' 这份文档没算进去，请单独用对话问，或者去掉附件再生成',
    )
  }
  const images = resolved.files.filter((file) => file.kind === 'image')
  if (!images.length) throw fail(422, 'CHAT_IMAGE_UNREADABLE', '这张图的原图读不到了：重新传一次再发')
  // 一次只按一张当参考（上游的参考图通道就是 1 张）：多带的不静默挑，回答里说明用的是哪张
  const first = images[0]
  if (images.length > 1) {
    notes.push(
      '这条带了 ' + images.length + ' 张图，这次按第 1 张「' + (first.name || '参考图') + '」当参考' +
        (plan.kind === 'image' ? '；要换就把其余几张删掉再发' : '；要换首帧就把其余几张删掉再发'),
    )
  }
  if (reused) notes.push('按这条对话里你上一条带的那张图「' + (first.name || '参考图') + '」当参考（这条没带附件）')
  const rawFile = readChatFileBytes(user.id, first.id)
  if (!rawFile) throw fail(422, 'CHAT_IMAGE_UNREADABLE', '这张图的原图读不到了：重新传一次再发')
  const mime = rawFile.mime || first.mime || 'image/png'
  const refs = [{
    // id 用附件 id：这一轮不落素材库，只在内存里把字节传给生成管线
    id: first.id,
    kind: 'image',
    name: first.name || '参考图',
    mime,
    ext: REF_EXT[mime] || 'png',
    bytes: rawFile.buffer.length,
    width: null,
    height: null,
    duration: null,
    buffer: rawFile.buffer,
  }]
  // 沿用的那张不挂回这条消息（它本来就没在这条里发过），只把说明写进回答
  return { files: raw.length ? [first] : [], refs, notes }
}

/**
 * 生成指令这一轮：不扣对话积分、不调文本模型，只把用户那句话落库，交给 finishMediaChat 去开任务。
 * 带图（r289）：一张图就按它出图 / 当视频首帧；对话附件不进素材库，字节只活到任务建出来为止。
 */
function beginMediaChat(user, conv, content, plan, input) {
  // r293：只写了「帮我出个视频」不再直接报错——这一轮照常落库，提示词交给 finishMediaChat 去写
  if (plan.error) throw fail(400, plan.code || 'MEDIA_PROMPT', plan.error)
  const { files, refs, notes } = mediaReferences(user, input, plan, conv)
  if (!conv.messages.some((item) => item.role === 'user')) conv.title = titleFrom(content)
  const userMessage = {
    id: messageId('u'),
    role: 'user',
    content,
    at: Date.now(),
    ...(files.length ? { files } : {}),
  }
  conv.messages.push(userMessage)
  const saved = saveConversation(user.id, conv)
  return {
    conv: saved || conv,
    media: { ...plan, notes: [...(plan.notes || []), ...notes], refs },
    // r343：这条消息的 id 要留给 lastMediaTask——「最近 6 条里有没有上一版」按它定位
    userMessageId: userMessage.id,
    evicted: Number(saved?.trimmedNow) || 0,
  }
}

/** 存进回答里的那条生成记录：界面拿 id 去轮询 /api/media/tasks/:id，别再存一份会过期的进度。 */
function mediaMeta(task) {
  const credits = task.credits || {}
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    model: task.model,
    modelLabel: task.modelLabel || '',
    mode: task.mode || '',
    ratio: task.ratio || '',
    size: task.size || '',
    duration: task.duration || null,
    resolution: task.resolution || '',
    // r342：卡片要说得出这次是什么画质；空串 = 没指定、走上游默认档
    quality: task.quality || '',
    prompt: task.prompt,
    // 失败原因是任务自己的结论：卡片在「已失败」时不轮询，不带上它就只剩一句「没有返回结果」
    error: task.error || '',
    // 下载地址按任务号推出来：刚建出来时还没有文件（downloadUrl 为空），但卡片等成功后再拿它当链接，
    // 这样刷新页面也能直接下载，不用额外一次请求。
    downloadUrl: '/api/media/tasks/' + task.id + '/file',
    // 参考素材只回形状：卡片上要能说出「这条是按图生成的」，但不必把图再存进聊天记录
    assets: (Array.isArray(task.assets) ? task.assets : []).map((asset) => ({
      kind: asset.kind,
      name: asset.name || '',
    })),
    credits: {
      cost: Number(credits.cost) || 0,
      balance: typeof credits.balance === 'number' ? credits.balance : null,
      refunded: Boolean(credits.refunded),
    },
  }
}

/** 这一轮的平台回话：说清模型、规格、扣了多少、去哪儿看结果；参数被改过的先照实写。 */
function mediaReply(task, plan) {
  const credits = task.credits || {}
  // r293：用户写死的参数不解释一句，容易被当成「被系统改了」
  const lockedLabels = []
  if (plan.locked?.ratio) lockedLabels.push('比例 ' + (task.ratio || plan.ratio))
  if (plan.locked?.size) lockedLabels.push('尺寸 ' + (task.size || plan.size))
  if (plan.locked?.duration) lockedLabels.push('时长 ' + (task.duration || plan.duration) + ' 秒')
  if (plan.locked?.resolution) lockedLabels.push('清晰度 ' + (task.resolution || plan.resolution))
  if (plan.locked?.quality) lockedLabels.push('画质 ' + (QUALITY_LABEL[task.quality] || task.quality))
  const refs = Array.isArray(task.assets) ? task.assets.length : 0
  const spec = [
    task.modelLabel || task.model,
    task.ratio,
    task.kind === 'image' ? task.size : '',
    task.quality ? '画质 ' + (QUALITY_LABEL[task.quality] || task.quality) : '',
    task.kind === 'video' ? task.duration + ' 秒' : '',
    task.resolution,
    refs ? '参考 ' + refs + ' 张' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const lines = []
  if (plan.notes?.length) lines.push(...plan.notes.map((note) => note + '。'))
  // 画质是「选才传」的那一档：上游到底收不收，我们没有真调过，所以先把话说在前面
  if (task.quality && task.status !== 'failed') {
    lines.push('画质「' + (QUALITY_LABEL[task.quality] || task.quality) + '」是这次选的；上游要是不接受这一档，这次会失败并全额退回。')
  }
  if (lockedLabels.length) {
    lines.push('这几个参数是你指定的（写死在话里，或在对话框里选的），我按原样提交：' + lockedLabels.join(' · ') + '；上游要是不接受，这次生成的积分全额退回。')
  }
  if (task.status === 'failed') {
    lines.push('这次没有生成出来：' + (task.error || '上游没有返回结果') + '。')
    lines.push(
      credits.refunded
        ? '这 ' + credits.cost + ' 积分已全额退回。'
        : '积分还没确认退回，带着任务号 ' + task.id + ' 找管理员。',
    )
    if (lockedLabels.length) {
      lines.push('你写死的参数上游可能不接受，换回默认档再试一次就行；想让我按默认值重发，直接说「按默认再来一条」。')
    }
    return lines.join('\n')
  }
  const balance = typeof credits.balance === 'number' ? '，余额 ' + credits.balance + ' 积分' : ''
  lines.push('已开始生成' + (task.kind === 'image' ? '图片' : '视频') + '：' + spec + ' · ' + credits.cost + ' 积分' + balance + '。')
  lines.push(
    task.kind === 'image'
      ? '出图一般 20～90 秒，最长等到 4 分钟；关掉这一页也会跑完，结果在下面这张卡片里，也留在「最近生成」里。'
      : '视频要几分钟（真调过 3～6 分钟）；关掉这一页也会跑完，结果在下面这张卡片里，也留在「最近生成」里。',
  )
  return lines.join('\n')
}

/**
 * 记下「这条对话上一版是怎么生成的」（r343）：接着改参数时要照它重出一版。
 *
 * 参数一律取任务上真正生效的那份（task 是 resolveSelection 收敛过的），不是用户原话里那份：
 * 用户写「3:4」，任务上就是 3:4，重出时不用再猜一遍。
 * 只有用户自己写死的尺寸才带过去（plan.locked.size）——按比例算出来的尺寸要跟着新比例走，
 * 否则「换成 9:16」之后还是 1:1 那个尺寸。
 */
function rememberMediaTask(conv, plan, task, at) {
  if (!task || !task.id) return
  conv.lastMediaTask = {
    id: task.id,
    kind: task.kind,
    prompt: task.prompt || plan.prompt || '',
    params: {
      ratio: task.ratio || '',
      quality: task.kind === 'image' ? task.quality || '' : '',
      duration: task.kind === 'video' ? task.duration ?? null : null,
      resolution: task.kind === 'video' ? task.resolution || '' : '',
      size: plan.locked?.size ? task.size || '' : '',
    },
    refIds: (plan.refs || []).map((ref) => String(ref.id || '')).filter(Boolean),
    at: String(at || ''),
  }
}

// 回答里把参数说成人话：不把键名丢给用户，也不出现英文
function paramValueText(key, value) {
  if (key === 'quality') return QUALITY_LABEL[value] || String(value)
  if (key === 'duration') return String(value) + ' 秒'
  return String(value)
}

function paramListText(values, keys) {
  return keys
    .filter((key) => values[key] !== undefined && values[key] !== null && values[key] !== '')
    .map((key) => paramValueText(key, values[key]))
    .join('、')
}

function paramNameText(keys) {
  return keys.map((key) => MEDIA_PARAM_LABELS[key] || key).join('、')
}

/** 「下一张 / 下一段」的量词：带时长或分辨率的按视频说，其余按图片说。 */
function defaultsUnit(keys) {
  return keys.some((key) => key === 'duration' || key === 'resolution') ? '段' : '张'
}

/**
 * 「接着说一句改参数」这一轮（r343）：不扣对话积分、不调文本模型。
 * 先把用户这句话落库；「上一版」在落库之前就认掉——判「最近 6 条」要用落库前的下标。
 */
function beginParamChangeChat(user, conv, content, change, input) {
  const previous = recentMediaTask(conv)
  if (!conv.messages.some((item) => item.role === 'user')) conv.title = titleFrom(content)
  const userMessage = { id: messageId('u'), role: 'user', content, at: Date.now() }
  conv.messages.push(userMessage)
  const saved = saveConversation(user.id, conv)
  return {
    conv: saved || conv,
    param: change,
    previous,
    input,
    userMessageId: userMessage.id,
    evicted: Number(saved?.trimmedNow) || 0,
  }
}

/** 只记设置 / 只回一句的那一档：落回答、存盘，不建任务、不扣任何积分。 */
function saveParamOnlyReply(user, ctx, reply, keys, startedAt) {
  ctx.conv.messages.push({
    id: messageId('a'),
    role: 'assistant',
    content: reply,
    at: Date.now(),
    ms: Date.now() - startedAt,
    meta: { paramChange: { keys, reissued: false } },
  })
  const saved = saveConversation(user.id, ctx.conv)
  const trimmedNow = (Number(ctx.evicted) || 0) + (Number(saved?.trimmedNow) || 0)
  const conversation = trimmedNow > 0 && saved ? { ...saved, trimmedNow } : saved
  return {
    conversation,
    reply: conversation.messages[conversation.messages.length - 1],
    model: null,
    // 这一轮既没走对话模型也没建任务：一分钱都不扣
    cost: 0,
    balance: null,
  }
}

/** 只改参数这一轮的收尾：能接上一版就重出一版，接不上就只记设置（都不扣对话积分）。 */
async function finishParamChangeChat(user, ctx) {
  const startedAt = Date.now()
  const change = ctx.param
  const previous = ctx.previous
  const keys = MEDIA_PARAM_KEYS.filter(
    (key) => change.explicit[key] && change.values[key] !== undefined && change.values[key] !== '',
  )
  // 会话当前设置：改一次记一次。它与「上一版是什么类型」无关——它是这条对话的当前设置，
  // 所以上一版是图片时说的「8 秒」也照样记下，下一段视频就用它。
  ctx.conv.mediaDefaults = mergeMediaDefaults(ctx.conv.mediaDefaults, change.values)

  // 上一版与这次改的参数类型不兼容（图片没有时长 / 分辨率这一档，视频没有画质这一档）：
  // 不建任务——按上一版重出也表达不了这一档，只会白扣一次积分。
  const incompatible = previous
    ? keys.filter((key) => (previous.kind === 'image' ? key === 'duration' || key === 'resolution' : key === 'quality'))
    : []
  if (!previous || incompatible.length) {
    const head = previous
      ? '上一版是' + (previous.kind === 'image' ? '图片' : '视频') + '，没有' + paramNameText(incompatible) + '这一档。'
      : ''
    const list = paramListText(change.values, keys)
    // 「按 8 秒出」「按 16:9 出」：以秒结束时不再多一个空格，读起来才是人话
    const gap = /秒$/.test(list) ? '' : ' '
    const reply = head + '已记下：下一' + defaultsUnit(keys) + '按 ' + list + gap + '出；这条对话里之后生成都按这个来。'
    return saveParamOnlyReply(user, ctx, reply, keys, startedAt)
  }

  // 同一档再说一遍别重出：上一版本来就是 8 秒，再开一条只是白扣一次生成积分
  const unchanged = keys.every(
    (key) => String(previous.params?.[key] ?? '') === String(change.values[key] ?? ''),
  )
  if (unchanged) {
    const list = paramListText(change.values, keys)
    const reply = '上一版已经是 ' + list + '，没有重出；这条对话里之后生成都按这个来。'
    return saveParamOnlyReply(user, ctx, reply, keys, startedAt)
  }

  // 重出一版：同一个提示词、新参数、同一个参考素材；扣费 / 退款走生成管线那一套
  const next = { ...sanitizeMediaDefaults(previous.params) }
  if (previous.params && previous.params.size) next.size = previous.params.size
  for (const key of keys) next[key] = change.values[key]
  const plan = {
    kind: previous.kind,
    prompt: previous.prompt,
    model: defaultModelFor(previous.kind),
    notes: [],
    ...planFromMediaParams(previous.kind, next),
  }
  // 参考素材沿用上一版那张（这条消息自己带了附件就用新的）：不静默把「按图生成」降级成纯文生图
  const refIds = Array.isArray(ctx.input?.files) && ctx.input.files.length ? ctx.input.files.map(String).filter(Boolean) : previous.refIds || []
  const resolved = refIds.length ? mediaReferences(user, { files: refIds }, plan, ctx.conv) : { refs: [], notes: [] }
  plan.notes = [...resolved.notes]
  plan.refs = resolved.refs
  const task = await startChatMedia(user, plan, plan.refs)
  rememberMediaTask(ctx.conv, plan, task, ctx.userMessageId)
  const list = paramListText(change.values, keys)
  const gap = /秒$/.test(list) ? '' : ' '
  const head = '按 ' + list + gap + '重出上一版，上一版还留在上面。'
  ctx.conv.messages.push({
    id: messageId('a'),
    role: 'assistant',
    content: head + '\n' + mediaReply(task, plan),
    at: Date.now(),
    model: task.model,
    ms: Date.now() - startedAt,
    meta: { media: mediaMeta(task), streamed: false },
  })
  const saved = saveConversation(user.id, ctx.conv)
  const trimmedNow = (Number(ctx.evicted) || 0) + (Number(saved?.trimmedNow) || 0)
  const conversation = trimmedNow > 0 && saved ? { ...saved, trimmedNow } : saved
  return {
    conversation,
    reply: conversation.messages[conversation.messages.length - 1],
    model: task.model,
    cost: 0,
    balance: typeof task.credits?.balance === 'number' ? task.credits.balance : null,
    media: mediaMeta(task),
  }
}

/** 生成指令的收尾：开任务、落一条平台回答、回给界面（这一轮不计对话费）。 */
async function finishMediaChat(user, ctx) {
  const startedAt = Date.now()
  const plan = { ...ctx.media }
  // r293：只写了「帮我出个视频」——先把这句意愿写成提示词。写不出来就不开任务、不扣生成积分，
  // 回一句「补一句画面再发一次」（绝不拿空提示词去扣 15 积分）。
  if (plan.needsPrompt) {
    const earlier = (ctx.conv.messages || []).slice(0, -1).map((item) => item.role === 'user' ? item.content : '');
    const enhanced = await enhanceMediaPrompt({
      kind: plan.kind,
      text: '',
      locked: plan.locked || {},
      context: earlier,
    })
    if (!enhanced.prompt) throw fail(400, 'MEDIA_PROMPT', enhanced.note || plan.usage || '补一句画面再发一次')
    plan.prompt = enhanced.prompt
    plan.rewritten = true
    plan.notes = [...(plan.notes || []), '提示词是按你说的补出来的：「' + enhanced.prompt + '」。想改直接说「改成…」']
  }
  const task = await startChatMedia(user, plan, plan.refs || [])
  // r343：这条任务就是「上一版」——下一句「改成 8 秒」要照它重出
  rememberMediaTask(ctx.conv, plan, task, ctx.userMessageId)
  ctx.conv.messages.push({
    id: messageId('a'),
    role: 'assistant',
    content: mediaReply(task, ctx.media),
    at: Date.now(),
    model: task.model,
    ms: Date.now() - startedAt,
    meta: { media: mediaMeta(task), streamed: false },
  })
  const saved = saveConversation(user.id, ctx.conv)
  const trimmedNow = (Number(ctx.evicted) || 0) + (Number(saved?.trimmedNow) || 0)
  const conversation = trimmedNow > 0 && saved ? { ...saved, trimmedNow } : saved
  return {
    conversation,
    reply: conversation.messages[conversation.messages.length - 1],
    model: task.model,
    // 这一轮没走对话模型：对话的 1 积分不扣，生成积分记在 task.credits 里
    cost: 0,
    balance: typeof task.credits?.balance === 'number' ? task.credits.balance : null,
    media: mediaMeta(task),
  }
}

/** 落回答 + 返回给前端；正文为空算这次没成，交给 failChat 退款。 */
function finishChat(user, ctx, result) {
  const reply = String(result?.text ?? result?.message?.content ?? '').trim()
  if (!reply) throw fail(502, 'CHAT_EMPTY_REPLY', '模型没有返回内容，这次不计费')
  const truncated = result?.finishReason === 'length'
  ctx.conv.messages.push({
    id: messageId('a'),
    role: 'assistant',
    content: reply,
    at: Date.now(),
    model: result?.model,
    ms: Date.now() - ctx.startedAt,
    meta: {
      tools: ctx.tools.map((item) => item.type),
      files: ctx.attachments.files.map((item) => item.name),
      // 带图这一轮记一笔：出问题时要能分清「模型没看图」还是「看了但没看出」
      ...(ctx.visionTurn ? { vision: true } : {}),
      // 这一轮搜了什么：出问题时同样要能分清「没搜到」还是「没接通搜索服务」
      ...(ctx.search ? { search: { ok: ctx.search.ok, provider: ctx.search.provider, results: ctx.search.results.length } } : {}),
      thinking: ctx.options.thinking,
      finishReason: result?.finishReason || '',
      usage: result?.usage || null,
      streamed: Boolean(result?.streamed),
      truncated,
    },
  })
  const saved = saveConversation(user.id, ctx.conv)
  // 这一轮一共挤掉多少条（用户那句一次、落回答一次），合起来只说一次，别报两个小数字（r248）
  const trimmedNow = (Number(ctx.evicted) || 0) + (Number(saved?.trimmedNow) || 0)
  const conversation = trimmedNow > 0 && saved ? { ...saved, trimmedNow } : saved
  return {
    conversation,
    reply: saved.messages[saved.messages.length - 1],
    model: result?.model,
    cost: ctx.paid.cost,
    balance: ctx.paid.balance,
    truncated,
  }
}

/** 退款 + 包口径：停止与失败都走这里，钱只退一次。 */
function failChat(user, ctx, error) {
  if (ctx.paid.cost > 0) {
    try {
      refund(user.id, 'chat', { ref: '对话 · ' + ctx.conv.title, amount: ctx.paid.cost, meta: { conversationId: ctx.conv.id, failed: true } })
    } catch {
      /* 退款失败不掩盖原错误 */
    }
  }
  const stopped = Boolean(error?.aborted) || error?.name === 'AbortError'
  const wrapped = fail(
    stopped ? 499 : error?.status || 502,
    stopped ? 'CHAT_ABORTED' : error?.code || 'CHAT_UPSTREAM',
    stopped
      ? '已停止生成，这次不计费（积分已退回）'
      // 上游原话常带型号、供应商地址与英文废话：走统一口径，不把报文原样丢给用户（r248）
      : '这次没有回上来，积分已退回：' + publicError(error, '上游没有返回可用的回答，稍后再试一次'),
  )
  wrapped.detail = String(error?.stack || error).slice(0, 400)
  wrapped.stopped = stopped
  return wrapped
}

export async function sendChatMessage(user, input = {}) {
  const ctx = await beginChat(user, input)
  // r288：生成指令这一轮只开任务，不经过文本模型（也就不扣对话那 1 积分）
  if (ctx.media) return finishMediaChat(user, ctx)
  // r343：只改参数这一轮要么重出一版（生成管线扣费），要么只记设置——都不走文本模型
  if (ctx.param) return finishParamChangeChat(user, ctx)
  try {
    const result = await callTextModel(ctx.messages, {
      temperature: 0.6,
      maxTokens: MAX_OUTPUT_TOKENS,
      extra: Object.keys(ctx.extra).length ? ctx.extra : null,
      meter: { kind: 'text', ref: ctx.conv.id },
      // 带图必须走视觉链：文本链里常是纯文本模型，图片会被静默丢掉，回答装得像看过了（llm.mjs 有同样教训）
      ...(ctx.visionTurn ? { models: visionChain() } : {}),
    })
    return finishChat(user, ctx, result)
  } catch (error) {
    throw failChat(user, ctx, error)
  }
}

/**
 * 流式回答（r217）。hooks.onDelta(text) 每拿到一段正文就调一次；hooks.signal 是「停止」通道。
 * 停止：不落半截回答（用户看到的是自己按了停），积分全额退回；
 * 上游不认流式：退回一次性回答，拿到整段后一次性推给界面，用户不会因为网关差异拿不到答案。
 */
export async function streamChatMessage(user, input = {}, hooks = {}) {
  const ctx = await beginChat(user, input)
  // 生成指令没有逐字输出：开完任务一次性把结论交回去，界面照样是「发送 → 卡片出现」
  if (ctx.media) return finishMediaChat(user, ctx)
  // 只改参数这一轮同理：没有逐字输出，一次性把结果（重出的卡片或「已记下」）交回去
  if (ctx.param) return finishParamChangeChat(user, ctx)
  try {
    // 带图片的这一轮走一次性：多模态 + 流式在不同上游并不都成立，一条 400 就会让整次对话失败并退款。
    // 一次性拿到整段再一次性推给界面（前端本来就有「没有增量就一次性显示」的分支），行为可预期。
    if (ctx.visionTurn) {
      const result = await callTextModel(ctx.messages, {
        temperature: 0.6,
        maxTokens: MAX_OUTPUT_TOKENS,
        extra: Object.keys(ctx.extra).length ? ctx.extra : null,
        meter: { kind: 'text', ref: ctx.conv.id },
        models: visionChain(),
        signal: hooks.signal,
      })
      const whole = String(result?.text || '').trim()
      if (whole) hooks.onDelta?.(whole)
      return { ...finishChat(user, ctx, result), fellBack: false, vision: true }
    }
    let result = null
    let fellBack = false
    try {
      result = await callTextModelStream(ctx.messages, {
        temperature: 0.6,
        maxTokens: MAX_OUTPUT_TOKENS,
        extra: Object.keys(ctx.extra).length ? ctx.extra : null,
        meter: { kind: 'text', ref: ctx.conv.id },
        signal: hooks.signal,
        onDelta: hooks.onDelta,
      })
    } catch (error) {
      if (error?.code !== 'STREAM_UNSUPPORTED') throw error
      fellBack = true
      result = await callTextModel(ctx.messages, {
        temperature: 0.6,
        maxTokens: MAX_OUTPUT_TOKENS,
        extra: Object.keys(ctx.extra).length ? ctx.extra : null,
        meter: { kind: 'text', ref: ctx.conv.id },
      })
      // 降级路径没有增量：拿到整段后一次性推给界面，用户看到的仍然是「有回答」，不是空白等到底
      const whole = String(result?.text || '').trim()
      if (whole) hooks.onDelta?.(whole)
    }
    const answer = finishChat(user, ctx, result)
    return { ...answer, fellBack }
  } catch (error) {
    throw failChat(user, ctx, error)
  }
}

// SYSTEM_PROMPT 导出只给测试用：断言「自称 VisionQA 通用模型」「文案里不出现上游厂牌」
// 不该靠读源码字符串（r343）。
export { MAX_INPUT, CONTEXT_MESSAGES, SYSTEM_PROMPT }
