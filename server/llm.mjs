import { config, visionEnabled } from './config.mjs'

// 纯文本模型调用：与 vision.mjs 共用同一套「重试 + 降级链」，供评审、智能体对话、画布节点使用
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function modelChain() {
  return [config.vision.model, ...config.vision.fallbacks].filter(Boolean)
}

export function llmEnabled() {
  return visionEnabled()
}

async function callOnce(messages, model, { temperature = 0.3, maxTokens = 2000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.vision.timeoutMs)
  try {
    const response = await fetch(config.vision.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.vision.apiKey },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      const busy = response.status === 429 || response.status >= 500 || /overloaded/i.test(text)
      const error = new Error('模型 ' + model + (busy ? ' 上游繁忙（HTTP ' + response.status + '）' : ' HTTP ' + response.status + '：' + text.slice(0, 140)))
      error.retryable = busy
      throw error
    }
    const json = JSON.parse(text)
    const content = json?.choices?.[0]?.message?.content
    if (!content) throw new Error('模型 ' + model + ' 没有返回内容')
    return { text: String(content), model }
  } finally {
    clearTimeout(timer)
  }
}

export async function callTextModel(messages, options = {}) {
  if (!llmEnabled()) throw Object.assign(new Error('未配置模型凭证（VISION_API_KEY 或本地 OpenCodex）'), { code: 'NO_MODEL' })
  const chain = options.models?.length ? options.models : modelChain()
  const log = options.log
  let lastError
  for (const model of chain) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        log?.('模型：' + model)
        return await callOnce(messages, model, options)
      } catch (error) {
        lastError = error
        const retryable = error?.retryable || error?.name === 'AbortError' || /fetch failed/i.test(String(error?.message))
        if (!retryable || attempt === 1) break
        await sleep((attempt + 1) * 2500)
      }
    }
    log?.(model + ' 不可用，切换下一个候选模型')
  }
  throw lastError || new Error('没有可用的模型')
}

export function extractJson(text) {
  const trimmed = String(text).trim().replace(/^\uFEFF/, '')
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('模型返回里没有 JSON')
  return JSON.parse(candidate.slice(start, end + 1))
}
