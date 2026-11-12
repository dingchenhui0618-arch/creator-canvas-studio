import { config } from './config.mjs'
import { recordRoute, reportKey, resolveKeyCandidates } from './keyvault.mjs'

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
 *
 * 多 Key 故障回退（2026-11-11 补）：以前这里只取「首选那一把」，它挂了整条模型链就算失败，
 * 后面的 Key 明明可用也没机会上场 —— 与目标里「多 Key 权重与故障回退」不符。
 * 现在按优先级 / 权重拿到一串候选 Key，同一把挂了（欠费、无效、限流、上游 5xx、连不上）
 * 就换下一把接着试，每次真实请求都落一条带 attempt 序号的记录；
 * 后台「路由决策」里的「换把成功」就是 attempt > 1 且 ok 的那些记录。
 * 只有「输出被 max_tokens 截断」不换把：那是模型与参数的问题，换 Key 也一样截断，
 * 留给上层的模型链去换模型。
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
  maxKeys = 3,
}) {
  const candidates = resolveKeyCandidates({ capability, model, limit: maxKeys })
  // 池里没有任何可用 Key 时，仍按老规矩回落环境变量凭证；来源在路由日志里标 env / none。
  const attempts = candidates.length
    ? candidates
    : [
        {
          id: '',
          name: '',
          baseUrl: '',
          apiKey: '',
          attempt: 1,
          source: config.vision.apiKey ? 'env' : 'none',
          reason: config.vision.apiKey ? '池里没有可用 Key，回落到环境变量凭证' : '池里没有可用 Key，环境变量也没配',
        },
      ]
  let lastError = null
  for (const candidate of attempts) {
    const baseUrl = String(candidate.baseUrl || config.vision.baseUrl || '').replace(/\/+$/, '')
    const apiKey = candidate.apiKey || (candidate.source === 'env' || candidate.source === 'none' ? config.vision.apiKey : '')
    const source = candidate.id ? 'pool' : candidate.source || (apiKey ? 'env' : 'none')
    let useJson = Boolean(json)
    for (let pass = 0; pass < 2; pass += 1) {
      const started = Date.now()
      // 每次真实调用落一条路由记录：走了哪把 Key、为什么、耗时多少、成没成。
      // 后台「路由决策」页读的就是这条日志，所以失败也要记，不能只记成功的。
      const route = (extra = {}) =>
        recordRoute({
          capability,
          model,
          keyId: candidate.id,
          keyName: candidate.name,
          source,
          reason: candidate.reason || (source === 'env' ? '池里没有可用 Key，回落到环境变量凭证' : '池里没有可用 Key，环境变量也没配'),
          attempt: candidate.attempt || 1,
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
          reportKey(candidate.id, false, 'HTTP ' + response.status + ' ' + text.slice(0, 160))
          route({ ok: false, error: 'HTTP ' + response.status + ' ' + text.slice(0, 120) })
          const error = new Error(
            model + (busy ? ' 上游繁忙（HTTP ' + response.status + '）' : ' HTTP ' + response.status + '：' + text.slice(0, 140)),
          )
          error.retryable = busy
          error.status = response.status
          console.error('[chat] ' + model + ' ' + response.status + ' ' + text.slice(0, 400))
          lastError = error
          break
        }
        const parsed = JSON.parse(text)
        const choice = parsed?.choices?.[0] || {}
        const finishReason = String(choice.finish_reason || '')
        if (finishReason === 'length') {
          // 截断到底是「我们自己给少了」还是「上游把 max_tokens 打了折」，只能看 usage：
          // completion_tokens 贴着请求值说明上限生效（加大有用），明显偏低说明被拦在更小的一档。
          console.error('[chat] ' + model + ' finish_reason=length max_tokens=' + maxTokens + ' usage=' + JSON.stringify(parsed?.usage || null))
          reportKey(candidate.id, false, 'finish_reason=length')
          route({ ok: false, error: '输出被 max_tokens 截断（finish_reason=length）' })
          const error = new Error(model + ' 输出被 max_tokens 截断（finish_reason=length）')
          error.retryable = true
          error.truncated = true
          // 截断是「模型 + max_tokens」的问题：换一把同模型的 Key 只会再截断一次，
          // 直接交给上层的模型链换模型，不在这里多烧一次钱。
          throw error
        }
        reportKey(candidate.id, true)
        route({ ok: true })
        return { message: choice.message || {}, finishReason, usage: parsed?.usage, jsonMode: useJson }
      } catch (error) {
        if (error?.code === 'NO_MODEL' || error?.status || error?.truncated) {
          lastError = error
          break
        }
        reportKey(candidate.id, false, String(error?.message || error))
        route({ ok: false, error: String(error?.message || error).slice(0, 120) })
        lastError = error
        break
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    // 还有候选就换下一把（故障回退）；没有候选时这一段结束、下面抛出最后一次错误。
    if (lastError?.truncated) throw lastError
  }
  throw lastError || new Error(model + ' 调用失败')
}

export { sleep }
