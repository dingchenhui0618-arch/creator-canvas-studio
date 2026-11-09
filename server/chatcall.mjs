import { config } from './config.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 一次 OpenAI 兼容的 chat/completions 调用（文本与多模态共用）。
 *
 * 三个上游差异都在这里兜住，调用方不用各写一份：
 * 1. 推理型模型（deepseek-flash 之类）会先产出 reasoning_tokens，正文常被 markdown 代码块包裹或带前缀；
 *    传 json:true 走 response_format=json_object 直接拿纯 JSON。
 * 2. 有些网关不认 response_format（直接 400），这时自动退回不带它的请求，不让功能整体挂掉。
 * 3. finish_reason=length 说明 max_tokens 被推理过程吃满、拿到的是半截 JSON：
 *    按可重试错误抛出，让上层换更宽松的参数或候选模型，而不是把半截 JSON 当答案。
 */
export async function chatCompletion({
  model,
  messages,
  temperature = 0.3,
  maxTokens = 2000,
  json = false,
  signal,
  timeoutMs = config.vision.timeoutMs,
}) {
  let useJson = Boolean(json)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = signal ? null : new AbortController()
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    const body = { model, messages, temperature, max_tokens: maxTokens }
    if (useJson) body.response_format = { type: 'json_object' }
    try {
      const response = await fetch(config.vision.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.vision.apiKey },
        body: JSON.stringify(body),
        signal: signal || controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        const busy = response.status === 429 || response.status >= 500 || /overloaded/i.test(text)
        // 网关不认 response_format：去掉它重试一次，而不是把整条链路判死
        if (useJson && response.status === 400 && /response_format|json_object|unsupported/i.test(text)) {
          useJson = false
          continue
        }
        const error = new Error(
          model + (busy ? ' 上游繁忙（HTTP ' + response.status + '）' : ' HTTP ' + response.status + '：' + text.slice(0, 140)),
        )
        error.retryable = busy
        error.status = response.status
        console.error('[chat] ' + model + ' ' + response.status + ' ' + text.slice(0, 400))
        throw error
      }
      const parsed = JSON.parse(text)
      const choice = parsed?.choices?.[0] || {}
      const finishReason = String(choice.finish_reason || '')
      if (finishReason === 'length') {
        const error = new Error(model + ' 输出被 max_tokens 截断（finish_reason=length）')
        error.retryable = true
        error.truncated = true
        throw error
      }
      return { message: choice.message || {}, finishReason, usage: parsed?.usage, jsonMode: useJson }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  throw new Error(model + ' 调用失败')
}

export { sleep }
