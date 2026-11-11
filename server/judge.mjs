// 判断模型（Jev 类）：给视觉评审的结论再加一层可编程判断。
//
// 为什么单独一层：视觉模型负责「看到什么、哪里有问题」，判断模型负责「这份结论站不站得住」——
// 结论是否被自己列出的证据支撑、建议能不能直接动手、发布前风险多高。
// 两个判断的口径不同，混在一句话里就没法追责；所以这里只产出结构化判断，
// 由界面并排展示，绝不悄悄改掉视觉模型的结论。
//
// 两种上游协议，按 Key 的 baseUrl 自动选，管理员贴地址时不用选：
//  - systemone：TypeSafe 官方（https://api.typesafe.ai/v1）—— POST /v1/systemone，四个问题一次问完；
//  - chat     ：任何 OpenAI 兼容的对话模型（DeepSeek / 百炼 / 中转）—— POST /v1/chat/completions，
//               让它按固定 JSON 回答同样四个判断。国内网络没有 TypeSafe 出口时用这条。
// Key 走平台 Key 池（能力标「判断」），与出图 / 出视频同一套「优先级 → 权重 → 故障回退」。
// 没配 Key 时返回 status=disabled，评审照常出结论，不因为判断层缺席就把评审卡住。
import { recordRoute, reportKey, resolveKeyCandidates } from './keyvault.mjs'

const TIMEOUT_MS = 12_000
const MAX_ATTEMPTS = 2
const VERSION_SUFFIX = /\/v\d+$/

/**
 * 判断上游协议：TypeSafe 官方走 /v1/systemone，其余一律按 OpenAI 兼容的对话接口。
 * 先看 Key 上登记的供应商（后台下拉里选「TypeSafe（Jev 判断）」，或自建中转仍想走 TypeSafe 形态），
 * 再看 baseUrl 域名兜底 —— 两种情况都不用管理员额外勾「协议」。
 */
export function judgeProtocol(key) {
  const provider = String(key?.provider || '').toLowerCase()
  if (provider === 'typesafe' || provider === 'jev') return 'systemone'
  return /typesafe\.ai/i.test(String(key?.baseUrl || '')) ? 'systemone' : 'chat'
}

/** 拼地址：baseUrl 带不带 /v1 都能用（TypeSafe 只认 /v1/systemone，少写一段就是 404）。 */
export function judgeEndpoint(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  return (VERSION_SUFFIX.test(base) ? base : base + '/v1') + path
}

/** 上游状态码翻成人话：地区限制是这台服务器上真的会踩到的坑（2026-11-11 实测 451）。 */
export function friendlyJudgeError(status, text) {
  const raw = String(text || '').slice(0, 200)
  if (Number(status) === 451 || /not available in your region/i.test(raw)) {
    return '判断模型在当前网络不可用：上游按地区拒绝（HTTP 451）。换一条出口，或改用国内可用的判断模型'
  }
  if (Number(status) === 401 || Number(status) === 403) return '判断模型的 Key 无效或没有权限（HTTP ' + status + '）'
  if (Number(status) === 402) return '判断模型额度不足（HTTP 402）'
  if (Number(status) === 404) return '判断模型接口路径不对（HTTP 404）：检查 baseUrl 是否带 /v1'
  if (Number(status) === 429) return '判断模型被限流（HTTP 429）'
  if (Number(status) >= 500) return '判断模型暂时不可用（HTTP ' + status + '）'
  return raw ? '判断模型报错（HTTP ' + status + '）：' + raw : '判断模型暂时不可用'
}

/**
 * 四个问题一次问完（同一份 state，互相看不见）：
 * - evidence_consistent：结论里的每条问题是否真有画面依据，而不是套话；
 * - verdict_supported：结论与问题严重度是否一致（会不会过严 / 过松）；
 * - actionable：修正建议是否具体到能动手；
 * - publish_risk：放在真实渠道发布前，问题的紧迫程度。
 */
function buildQuestions() {
  return {
    evidence_consistent: {
      type: 'noul',
      instructions:
        '这份视觉评审里列出的每条问题，是否都能从它自己给出的证据（像素锚点或明确描述）推出来，' +
        '而不是套话、复述原文或凭空猜测？有明显套话或无法定位的问题就算否。',
    },
    verdict_supported: {
      type: 'choice',
      instructions: '评审的最终结论（pass / needs_review / fail）是否被它自己列出的问题严重程度支撑？',
      criteria: {
        supported: '结论与问题严重程度一致，没有明显偏差',
        too_strict: '问题大多是轻微或信息性，结论却比问题更重',
        too_lenient: '列出了阻断级或重要问题，结论却偏轻',
      },
    },
    actionable: {
      type: 'noul',
      instructions:
        '修正建议是否具体到可以直接动手（例如改字号、改对比、改裁切、改间距），' +
        '而不是「重新设计」「优化视觉」这类无法执行的空话？',
    },
    publish_risk: {
      type: 'score',
      instructions: '把这幅画面放到真实投放渠道之前，需要处理问题的紧迫程度如何？',
      criteria: ['可以直接发布', '小修后可以发布', '必须先解决问题再发布'],
    },
  }
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.max(0, Math.min(1, number))
}

function normalizeAnswers(parsed) {
  return {
    evidenceConsistent: clamp01(parsed.evidenceConsistent),
    verdictSupport: parsed.verdictSupport
      ? {
          choice: String(parsed.verdictSupport.choice),
          confidence: clamp01(parsed.verdictSupport.confidence),
          probabilities: parsed.verdictSupport.probabilities || null,
        }
      : null,
    actionable: clamp01(parsed.actionable),
    publishRisk: parsed.publishRisk
      ? {
          score: Number(parsed.publishRisk.score),
          confidence: clamp01(parsed.publishRisk.confidence),
          legend: parsed.publishRisk.legend || null,
          probabilities: parsed.publishRisk.probabilities || null,
        }
      : null,
    answered: parsed.answered || [],
  }
}

/** TypeSafe 形态：answers 里每项自带 type，以及 noul / choice / score 各自的字段。 */
function parseAnswers(data) {
  const answers = data?.answers || {}
  const evidence = answers.evidence_consistent || {}
  const support = answers.verdict_supported || {}
  const actionable = answers.actionable || {}
  const risk = answers.publish_risk || {}
  return normalizeAnswers({
    evidenceConsistent: evidence.noul,
    verdictSupport: support.choice
      ? { choice: support.choice, confidence: support.confidence, probabilities: support.probabilities || null }
      : null,
    actionable: actionable.noul,
    publishRisk:
      risk.score !== undefined && risk.score !== null
        ? { score: risk.score, confidence: risk.confidence, legend: risk.legend || null, probabilities: risk.probabilities || null }
        : null,
    answered: Object.keys(answers),
  })
}

/** 对话形态：模型直接回一段 JSON，字段名与四个判断一一对应，这里收敛成同一套结构。 */
function parseChatJudgment(raw) {
  const support = raw?.verdict_supported
  const risk = raw?.publish_risk
  const supportChoice = typeof support === 'string' ? support : support?.choice
  const riskScore = typeof risk === 'number' ? risk : risk?.score
  return normalizeAnswers({
    evidenceConsistent: raw?.evidence_consistent,
    verdictSupport: supportChoice ? { choice: supportChoice, confidence: support?.confidence, probabilities: null } : null,
    actionable: raw?.actionable,
    publishRisk:
      riskScore !== undefined && riskScore !== null ? { score: riskScore, confidence: risk?.confidence ?? null, legend: null, probabilities: null } : null,
    answered: ['evidence_consistent', 'verdict_supported', 'actionable', 'publish_risk'].filter((name) => raw?.[name] !== undefined),
  })
}

/** 从对话模型的回复里挖出 JSON（可能带代码块围栏或前后废话）。 */
function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    // 接着往下挖
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    try {
      return JSON.parse(fenced[1])
    } catch {
      return null
    }
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      return null
    }
  }
  return null
}

// 对话模型的提示：字段与 TypeSafe 的四个问题一一对应，两条协议共用一套解析与展示。
const CHAT_INSTRUCTIONS = [
  '你是一名严格的评审质检员。下面给你一份「视觉评审」的结构化内容（state）和四个判断问题（questions）。',
  '只做判断，不改写评审结论。严格输出一个 JSON 对象，不要解释、不要用代码块，字段如下：',
  '{',
  '  "evidence_consistent": 0 到 1 的小数（评审列出的每条问题是否都能从它自己给的证据推出来，套话或无法定位就给低分）,',
  '  "verdict_supported": { "choice": "supported" | "too_strict" | "too_lenient", "confidence": 0 到 1 },',
  '  "actionable": 0 到 1 的小数（修正建议是否具体到能直接动手）,',
  '  "publish_risk": { "score": 0 | 1 | 2, "confidence": 0 到 1 }',
  '}',
  'score 口径：0 = 可以直接发布，1 = 小修后可以发布，2 = 必须先解决问题再发布。',
].join('\n')

/** 判断层有没有 Key（后台与评审页要用它决定显示「已启用」还是「未启用」）。 */
export function judgeStatus() {
  const candidates = resolveKeyCandidates({ capability: 'judge', limit: 1 })
  if (!candidates.length) return { configured: false, provider: '', model: '', protocol: '' }
  const key = candidates[0]
  return { configured: true, provider: key.provider, model: key.model || 'jev-latest', protocol: judgeProtocol(key) }
}

/**
 * 网络层失败要重试一次：上游（尤其经 CDN 的）返回 4xx 后会掐掉连接，
 * 复用这条连接的下一次 fetch 会直接抛「fetch failed」。换个连接就正常，
 * 不重试的话管理员会看到一条查不出原因的报错。
 */
async function requestWithRetry(url, options) {
  try {
    return await fetch(url, options)
  } catch (error) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (second) {
      const code = second?.cause?.code || error?.cause?.code || ''
      const network = new Error('连不上判断模型上游' + (code ? '（' + code + '）' : '') + '：检查 baseUrl 与服务器的网络出口')
      network.network = true
      throw network
    }
  }
}

function judgeFailure(status, text) {
  const error = new Error(friendlyJudgeError(status, text))
  error.status = status
  error.raw = String(text || '').slice(0, 200)
  return error
}

/** 真正发一次判断请求。两条协议在这里分叉，上层拿到的都是同一套结构。 */
export async function callJudge(key, state, questions, model) {
  const protocol = judgeProtocol(key)
  const started = Date.now()
  if (protocol === 'systemone') {
    const response = await requestWithRetry(judgeEndpoint(key.baseUrl, '/systemone'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key.apiKey },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) throw judgeFailure(response.status, text)
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('判断模型返回的不是 JSON')
    }
    const parsed = parseAnswers(data)
    if (!parsed.answered.length) throw new Error('判断模型没有返回判断结果')
    return { protocol, model: String(data?.model || model), usage: data?.usage || null, parsed, ms: Date.now() - started }
  }
  const response = await requestWithRetry(judgeEndpoint(key.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key.apiKey },
    body: JSON.stringify({
      model,
      temperature: 0,
      stream: false,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CHAT_INSTRUCTIONS },
        { role: 'user', content: JSON.stringify({ state, questions }) },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw judgeFailure(response.status, text)
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('判断模型返回的不是 JSON')
  }
  const content = body?.choices?.[0]?.message?.content || ''
  const answers = extractJson(content)
  if (!answers) throw new Error('判断模型没有按格式返回判断结果')
  const parsed = parseChatJudgment(answers)
  if (!parsed.answered.length) throw new Error('判断模型没有按格式返回判断结果')
  return { protocol, model: String(body?.model || model), usage: body?.usage || null, parsed, ms: Date.now() - started }
}

/**
 * 对一份评审结论做判断。永远不抛错：拿不到判断就回 status=disabled / failed，
 * 评审本身照常返回 —— 判断层是加值，不是新的故障点。
 * 失败会记进路由日志并计入那把 Key 的健康度，后台看得到「判断模型调不通」。
 */
export async function judgeReview(review, { intent = '' } = {}) {
  const started = Date.now()
  const candidates = resolveKeyCandidates({ capability: 'judge', limit: MAX_ATTEMPTS })
  if (!candidates.length) {
    return {
      status: 'disabled',
      note: '判断模型还没接入：这份结论只由视觉模型给出，没有做交叉核对。',
    }
  }
  const state = {
    intent: String(intent || '未填写'),
    verdict: String(review?.verdict || ''),
    summary: String(review?.summary || ''),
    problems: (Array.isArray(review?.observations) ? review.observations : []).slice(0, 10).map((item) => ({
      dimension: String(item?.dimension || ''),
      severity: String(item?.severity || ''),
      statement: String(item?.statement || '').slice(0, 300),
      hasEvidence: Boolean(item?.evidence),
    })),
    fixes: (Array.isArray(review?.fixes) ? review.fixes : []).slice(0, 8).map((item) => ({
      title: String(item?.title || ''),
      detail: String(item?.detail || '').slice(0, 200),
    })),
    notAssessable: (Array.isArray(review?.notAssessable) ? review.notAssessable : []).slice(0, 6).map((item) => String(item).slice(0, 160)),
  }
  const questions = buildQuestions()
  let lastError = ''
  for (const key of candidates) {
    const model = key.model || 'jev-latest'
    try {
      const result = await callJudge(key, state, questions, model)
      reportKey(key.id, true)
      recordRoute({ capability: 'judge', model: result.model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: true })
      return {
        status: 'ok',
        model: result.model,
        provider: result.protocol === 'systemone' ? 'typesafe' : 'chat',
        protocol: result.protocol,
        ms: Date.now() - started,
        usage: result.usage,
        ...result.parsed,
      }
    } catch (error) {
      lastError = String(error?.message || error)
      reportKey(key.id, false, lastError)
      recordRoute({ capability: 'judge', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: lastError })
    }
  }
  return { status: 'failed', error: lastError || '判断模型暂时不可用', ms: Date.now() - started }
}

/**
 * 后台「测试 Key」用：拿一小段样例评审真跑一次判断，证明这把 Key 能用来判断。
 * 只花一次很小的调用，结果直接告诉管理员「通不通、走哪种协议、四个判断有没有回来」。
 */
export async function judgeSelfCheck(key) {
  const model = key.model || (key.models || [])[0] || 'jev-latest'
  const state = {
    intent: '自检',
    verdict: 'needs_review',
    summary: '标题对比度偏低，主体偏左。',
    problems: [
      { dimension: '对比度', severity: 'important', statement: '标题与背景对比度不足以支撑正文阅读', hasEvidence: true },
      { dimension: '构图', severity: 'minor', statement: '主体偏左，右侧留白偏多', hasEvidence: true },
    ],
    fixes: [{ title: '把标题换成深色', detail: '正文同样的灰度，对比度到 4.5:1 以上' }],
    notAssessable: [],
  }
  try {
    const result = await callJudge(key, state, buildQuestions(), model)
    return {
      ok: true,
      protocol: result.protocol,
      model: result.model,
      ms: result.ms,
      usage: result.usage,
      answers: {
        evidenceConsistent: result.parsed.evidenceConsistent,
        verdictSupport: result.parsed.verdictSupport?.choice || '',
        publishRisk: result.parsed.publishRisk?.score ?? null,
        actionable: result.parsed.actionable,
      },
      error: '',
    }
  } catch (error) {
    return {
      ok: false,
      protocol: judgeProtocol(key),
      model,
      ms: 0,
      usage: null,
      answers: null,
      error: String(error?.message || error),
    }
  }
}
