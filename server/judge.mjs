// 判断模型（TypeSafe / Jev）：给视觉评审的结论再加一层可编程判断。
//
// 为什么单独一层：视觉模型负责「看到什么、哪里有问题」，Jev 负责「这份结论站不站得住」——
// 结论是否被自己列出的证据支撑、建议能不能直接动手、发布前风险多高。
// 两个判断的口径不同，混在一句话里就没法追责；所以这里只产出结构化判断，
// 由界面并排展示，绝不悄悄改掉视觉模型的结论。
//
// Key 走平台 Key 池（能力标「判断」），与出图 / 出视频同一套「优先级 → 权重 → 故障回退」。
// 没配 Key 时返回 status=disabled，评审照常出结论，不因为判断层缺席就把评审卡住。
import { recordRoute, reportKey, resolveKeyCandidates } from './keyvault.mjs'

const TIMEOUT_MS = 12_000
const MAX_ATTEMPTS = 2

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
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

function parseAnswers(data) {
  const answers = data?.answers || {}
  const evidence = answers.evidence_consistent || {}
  const support = answers.verdict_supported || {}
  const actionable = answers.actionable || {}
  const risk = answers.publish_risk || {}
  return {
    evidenceConsistent: clamp01(evidence.noul),
    verdictSupport: support.choice
      ? {
          choice: String(support.choice),
          confidence: clamp01(support.confidence),
          probabilities: support.probabilities || null,
        }
      : null,
    actionable: clamp01(actionable.noul),
    publishRisk:
      typeof risk.score === 'number'
        ? {
            score: Number(risk.score),
            confidence: clamp01(risk.confidence),
            legend: risk.legend || null,
            probabilities: risk.probabilities || null,
          }
        : null,
    answered: Object.keys(answers),
  }
}

/** 判断层有没有 Key（后台与评审页要用它决定显示「已启用」还是「未启用」）。 */
export function judgeStatus() {
  const candidates = resolveKeyCandidates({ capability: 'judge', limit: 1 })
  if (!candidates.length) return { configured: false, provider: '', model: '' }
  return { configured: true, provider: candidates[0].provider, model: candidates[0].model || 'jev-latest' }
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
    let response
    let text
    try {
      response = await fetch(trimBase(key.baseUrl) + '/systemone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key.apiKey },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      text = await response.text()
    } catch (error) {
      lastError = String(error?.message || error)
      reportKey(key.id, false, lastError)
      recordRoute({ capability: 'judge', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: lastError })
      continue
    }
    if (!response.ok) {
      lastError = 'HTTP ' + response.status + ' ' + text.slice(0, 160)
      reportKey(key.id, false, lastError)
      recordRoute({ capability: 'judge', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: lastError })
      continue
    }
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      lastError = '上游返回的不是 JSON'
      reportKey(key.id, false, lastError)
      recordRoute({ capability: 'judge', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: lastError })
      continue
    }
    const parsed = parseAnswers(data)
    if (!parsed.answered.length) {
      lastError = '上游没有返回判断结果'
      reportKey(key.id, false, lastError)
      recordRoute({ capability: 'judge', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: false, error: lastError })
      continue
    }
    reportKey(key.id, true)
    recordRoute({ capability: 'judge', model, keyId: key.id, keyName: key.name, source: 'pool', reason: key.reason, attempt: key.attempt, ms: Date.now() - started, ok: true })
    return {
      status: 'ok',
      model: String(data?.model || model),
      provider: 'typesafe',
      ms: Date.now() - started,
      usage: data?.usage || null,
      ...parsed,
    }
  }
  return { status: 'failed', error: lastError || '判断模型暂时不可用', ms: Date.now() - started }
}
