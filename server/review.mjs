import { callTextModel, extractJson, llmEnabled, visionChain } from './llm.mjs'
import { assertPublicHttpUrl } from './media.mjs'
import { judgeReview, judgeStatus } from './judge.mjs'
import { refusal } from './public-error.mjs'
import { compressForReview } from './image-scale.mjs'
import { isolateStatus } from './isolate.mjs'

// VisionQA 视觉评审：优先接 VisionQA 插件服务（同一套 VisualReview 契约），
// 服务不可用时退到本地模型的 visual-baseline 评审，并如实标注 provider。
const SERVICE_URL = process.env.VISIONQA_SERVICE_URL || 'http://127.0.0.1:6300'
const PROFILES = ['visual-baseline', 'visual-hierarchy', 'content-cover', 'ecommerce-apparel']

const SYSTEM = [
  '你是 VisionQA 的视觉评审器。你的任务是对给定画面做出可复查的视觉判断，而不是夸它好看。',
  '',
  '评审维度（profile=visual-baseline）：层级（谁是第一视觉落点）、对比（文字与背景可读性）、对齐与间距、字体与字号一致性、色彩克制、构图与裁切（重要元素是否被切）、可识别性（主体是否清楚）。',
  '',
  '硬性规则：',
  '1. 只输出 JSON，不要 markdown，不要解释过程。',
  '2. 每条 observation 必须能落到**具体元素**：statement 里写清「是哪个元素 + 什么数值/什么位置」，例如「页头标题 #1A1A1A 压在以 #F5F5F5 为主的背景上，对比度约 2.4:1」「右下角卡片的按钮距容器底边 0px，文字被裁掉约 8px」。',
  '3. 写不出具体元素、也说不出数值或位置的维度判断（如「视觉层级需要加强」「配色可以更协调」）**不是问题**：不写进 observation，放到 notAssessable 里说明「哪个维度无法定位到具体元素」；**不要用整张画面的锚点去支撑一句笼统的话**。',
  '4. evidence 必须是该条问题所指元素所在区域的 bbox（x/y/w/h，0–1 相对坐标），框住元素本身而不是整幅画面；框不出这个元素，就说明这条看不出来，不要写。',
  '5. 没有证据的猜测不要写成问题；看不到的部分不要猜，放进 notAssessable。',
  '6. 严重度只用 blocker / major / minor / info；info 只用于「看到但不确定算不算问题」。',
  '7. 修正建议必须是有界的（改字号、改对比、改裁切、改间距），写清改哪个元素的哪一项参数，不要写「重新设计」「优化视觉」。',
  '8. 每条 statement 控制在 60 个汉字内，不做设计理论科普。',
  '9. 输出有上限：observations 最多 5 条（按严重度从高到低取前 5，多出来的不要写），fixes 最多 3 条，notAssessable 最多 3 条；同样的话不说第二遍。',
  '',
  '输出结构：',
  '{"verdict":"pass|needs_review|fail","summary":"一句话结论","observations":[{"dimension":"hierarchy|contrast|spacing|type|color|composition|legibility","severity":"blocker|major|minor|info","statement":"具体元素 + 数值/位置","evidence":{"x":0,"y":0,"w":0,"h":0},"confidence":0.0}],"fixes":[{"title":"动作","detail":"具体怎么改"}],"notAssessable":["缺什么信息导致无法判断"]}',
].join('\n')

async function serviceHealth() {
  try {
    const response = await fetch(SERVICE_URL + '/api/health', { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 判断层：视觉模型出完结论后，再让判断模型（Jev）给一份结构化判断。
 * 它只加一块「依据」，不改 verdict —— 两个模型口径不同，改结论就说不清是谁的责任。
 * 判断层没配 / 调不通时原样返回，评审不因此失败。
 */
async function attachJudge(mapped, intent, meter = null) {
  const judge = await judgeReview(mapped, { intent, meter })
  return { ...mapped, judge }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function tooBigImage() {
  return refusal(413, 'MEDIA_TOO_LARGE', '这张图超过 8 MB 上限：先压一下再评审，这次没扣积分')
}

// 把远程图片取下来：先看声明大小、再边读边卡 8 MB。
// 以前两条路（插件服务 / 本地模型）各写一遍，其中插件服务那条是整段 arrayBuffer 下来之后才判大小——
// 一个 100 MB 的图床地址就是一次 OOM。现在两条路共用这一个口。
async function fetchImageCapped(imageUrl) {
  await assertPublicHttpUrl(imageUrl)
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('取不到这张图（HTTP ' + response.status + '）')
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_IMAGE_BYTES) throw tooBigImage()
  const chunks = []
  let received = 0
  for await (const chunk of response.body) {
    received += chunk.length
    if (received > MAX_IMAGE_BYTES) {
      try { await response.body.cancel() } catch { /* 已经结束 */ }
      throw tooBigImage()
    }
    chunks.push(chunk)
  }
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim()
  return { bytes: Buffer.concat(chunks), mime: type.startsWith('image/') ? type : 'image/jpeg' }
}

function toDataUrl(bytes, mime = 'image/jpeg') {
  return 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64')
}

function normalize(raw, provider, requestId) {
  const verdict = ['pass', 'needs_review', 'fail'].includes(raw?.verdict) ? raw.verdict : 'needs_review'
  // 上限与提示词里的一致（5 条问题 / 3 条修正）：服务端再兜一次，模型偶尔会多写
  const observations = (Array.isArray(raw?.observations) ? raw.observations : []).slice(0, 6).map((item, index) => ({
    id: 'obs-' + (index + 1),
    dimension: String(item?.dimension || 'composition').slice(0, 24),
    severity: ['blocker', 'major', 'minor', 'info'].includes(item?.severity) ? item.severity : 'minor',
    statement: String(item?.statement || '').slice(0, 300),
    evidence: item?.evidence && typeof item.evidence === 'object'
      ? {
          x: Number(item.evidence.x) || 0,
          y: Number(item.evidence.y) || 0,
          w: Number(item.evidence.w) || 0,
          h: Number(item.evidence.h) || 0,
        }
      : null,
    confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0.6)),
  }))
  const fixes = (Array.isArray(raw?.fixes) ? raw.fixes : []).slice(0, 4).map((item) => ({
    title: String(item?.title || '').slice(0, 60),
    detail: String(item?.detail || '').slice(0, 200),
  }))
  return {
    requestId,
    provider,
    profile: 'visual-baseline',
    verdict,
    summary: String(raw?.summary || '').slice(0, 240),
    observations,
    fixes,
    notAssessable: (Array.isArray(raw?.notAssessable) ? raw.notAssessable : []).map((v) => String(v).slice(0, 160)).slice(0, 3),
  }
}

export async function reviewVisual({ imageUrl, imageBytes, mime = 'image/jpeg', intent = '', log, projectId = '', ref = '' }) {
  const requestId = 'vr_' + Math.random().toString(36).slice(2, 10)
  const started = Date.now()
  // 计量口径：kind 由各调用点自己定（视觉=vision、判断=judge），这里只负责把
  // 「哪条作品、哪次请求」带下去，后台成本页才能按作品回看一次评审花了多少。
  const meter = { projectId: String(projectId || ''), ref: String(ref || requestId) }

  // 发模型之前先缩图（v0.9.74）：堆占用跟着送审字节数走，8 MB 的图一缩只剩几百 KB，
  // 三条并发就从 27% 堆掉到一个零头。缩失败会自动退回原图，失败不会让评审失败。
  let compression = null
  if (imageBytes) {
    const shot = await compressForReview(imageBytes, mime, { log })
    imageBytes = shot.bytes
    mime = shot.mime
    compression = shot.report
  }

  // 1) VisionQA 插件服务：同一套契约，能连上就用它的结果
  if (await serviceHealth()) {
    try {
      const form = new FormData()
      form.append('request', JSON.stringify({
        schema_version: 'visual-review-v0.1',
        request_id: requestId,
        artifact: { kind: 'image', label: intent || '工作台产物' },
        intent: intent || '评审这张画面是否适合作为内容封面/分镜',
        constraints: { locale: 'zh-CN' },
        permissions: { allow_network: false },
        operation: { mode: 'review' },
      }))
      form.append('provider', 'mock')
      if (imageBytes) {
        form.append('candidate', new Blob([imageBytes], { type: mime }), 'candidate.' + (mime.includes('png') ? 'png' : 'jpg'))
      } else if (imageUrl) {
        // 评审接口接受外部图片地址：同样要拦内网地址，否则它就是一个匿名 SSRF 入口；
        // 取图与缩图走和本地模型同一条路（8 MB 硬上限 + 长边 1600）
        const remote = await fetchImageCapped(imageUrl)
        const shot = await compressForReview(remote.bytes, remote.mime, { log })
        compression = shot.report
        form.append('candidate', new Blob([shot.bytes], { type: shot.mime }), 'candidate.' + (shot.mime.includes('png') ? 'png' : 'jpg'))
      }
      const response = await fetch(SERVICE_URL + '/api/visual-review', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
      const json = await response.json()
      if (response.ok) {
        const mapped = await attachJudge(normalize(json, 'visionqa-plugin@' + SERVICE_URL.replace(/^https?:\/\//, ''), requestId), intent, meter)
        return { ...mapped, ms: Date.now() - started, mode: 'service', note: '由 VisionQA 插件服务返回（fixture provider 时只证明链路可用，不代表模型准确率）', compression }
      }
    } catch (error) {
      log?.('VisionQA 服务评审失败，退回本地模型：' + String(error?.message || error).slice(0, 120))
    }
  }

  // 2) 本地模型：按同一份 visual-baseline 规则评审
  if (!llmEnabled()) {
    return {
      requestId,
      provider: 'unavailable',
      profile: 'visual-baseline',
      verdict: 'needs_review',
      summary: '当前没有可用的评审通道：VisionQA 插件服务未启动，本地模型也未配置。',
      observations: [],
      fixes: [],
      notAssessable: ['缺少可用的评审 provider'],
      ms: Date.now() - started,
      mode: 'unavailable',
      note: '未做任何像素判断，不伪造结论。',
    }
  }

  let dataUrl = imageUrl
  if (imageBytes) dataUrl = toDataUrl(imageBytes, mime)
  if (!dataUrl) throw Object.assign(new Error('没有可评审的画面'), { code: 'NO_IMAGE' })
  if (!imageBytes) {
    // 自己把图取下来再当 data URL 发出去，不要把远程地址原样交给上游模型：
    // 模型服务未必够得着我们的图床（生产实测 DeepSeek 取 GitHub raw 直接 400），
    // 而且这样一来图片地址只在我们的出口出现，不给上游当代理跳板。
    const remote = await fetchImageCapped(imageUrl)
    const shot = await compressForReview(remote.bytes, remote.mime, { log })
    compression = shot.report
    dataUrl = toDataUrl(shot.bytes, shot.mime)
  }

  log?.('本地模型评审（visual-baseline）')
  const result = await callTextModel([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: (intent || '请评审这张画面') + '\n请按 visual-baseline 维度逐条给证据，只输出 JSON：问题最多 5 条、修正最多 3 条，这是硬上限。' },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
      ],
    },
  ], { temperature: 0.2, maxTokens: 3000, json: true, log, models: visionChain(), meter })

  const parsed = extractJson(result.text)
  const mapped = await attachJudge(normalize(parsed, 'local-model:' + result.model, requestId), intent, meter)
  return { ...mapped, ms: Date.now() - started, mode: 'local-model', note: '由本地视觉模型按 VisionQA visual-baseline 规则评审', compression }
}

export async function reviewStatus() {
  return {
    service: await serviceHealth(),
    serviceUrl: SERVICE_URL,
    model: llmEnabled(),
    profiles: PROFILES,
    // 判断层是否启用：评审页据此决定要不要显示「判断模型」区块
    judge: judgeStatus(),
    // 重活隔离（v0.9.77）：有没有开、上限多少、跑过几次——不用真发一次评审也能确认它在工作
    isolate: isolateStatus(),
  }
}
