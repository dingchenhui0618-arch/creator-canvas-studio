import { config } from './config.mjs'
import { recordRoute, resolveKey, reportKey } from './keyvault.mjs'

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
 *
 * 凭证解析：优先用后台「平台 Key」池里符合能力的 Key（运行时可增删），
 * 池里没有可用 Key 时回落到环境变量里的旧凭证；Key 由管理员在后台维护，不写死在进程里。
 */
export async function chatCompletion({
  model,
  messages,
  temperature = 0.3,
  maxTokens = 2000,
  json = false,
  signal,
  timeoutMs = config.vision.timeoutMs,
  capability = 'text',
}) {
  let useJson = Boolean(json)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = Date.now()
    const resolved = resolveKey({ capability, model })
    const baseUrl = String(resolved?.baseUrl || config.vision.baseUrl || '').replace(/\/+$/, '')
    const apiKey = resolved?.apiKey || config.vision.apiKey
    // 每次真实调用落一条路由记录：走了哪把 Key、为什么、耗时多少、成没成。
    // 后台「路由决策」页读的就是这条日志，所以失败也要记，不能只记成功的。
    const route = (extra = {}) =>
      recordRoute({
        capability,
        model,
        keyId: resolved?.id,
        keyName: resolved?.name,
        source: resolved ? 'pool' : apiKey ? 'env' : 'none',
        reason: resolved?.reason || (apiKey ? '池里没有可用 Key，回落到环境变量凭证' : '池里没有可用 Key，环境变量也没配'),
        attempt: attempt + 1,
        ms: Date.now() - started,
        ...extra,
      })
    if (!apiKey) {
      route({ ok: false, error: '未配置模型凭证' })
      const error = new Error('未配置模型凭证：管理员还没有在后台添加可用 Key')
      error.code = 'NO_MODEL'
      throw error
    }
    const controller = signal ? null : new AbortController()
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    const body = { model, messages, temperature, max_tokens: maxTokens }
    if (useJson) body.response_format = { type: 'json_object' }
    try {
      const response = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(body),
        signal: signal || controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        const busy = response.status === 429 || response.status >= 500 || /overloaded/i.test(text)
        // 网关不认 response_format：去掉它重试一次，而不是把整条链路判死
        // （这不是 Key 的问题，不能计入失败次数，否则正常请求也会把 Key 打进冷却）
        if (useJson && response.status === 400 && /response_format|json_object|unsupported/i.test(text)) {
          useJson = false
          continue
        }
        reportKey(resolved?.id, false, 'HTTP ' + response.status + ' ' + text.slice(0, 160))
        route({ ok: false, error: 'HTTP ' + response.status + ' ' + text.slice(0, 120) })
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
        reportKey(resolved?.id, false, 'finish_reason=length')
        route({ ok: false, error: '输出被 max_tokens 截断（finish_reason=length）' })
        const error = new Error(model + ' 输出被 max_tokens 截断（finish_reason=length）')
        error.retryable = true
        error.truncated = true
        throw error
      }
      reportKey(resolved?.id, true)
      route({ ok: true })
      return { message: choice.message || {}, finishReason, usage: parsed?.usage, jsonMode: useJson }
    } catch (error) {
      if (error?.code === 'NO_MODEL' || error?.status) throw error
      reportKey(resolved?.id, false, String(error?.message || error))
      route({ ok: false, error: String(error?.message || error).slice(0, 120) })
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  throw new Error(model + ' 调用失败')
}

export { sleep }
