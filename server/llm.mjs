import { config, visionEnabled } from './config.mjs'
import { chatCompletion, sleep } from './chatcall.mjs'
import { vaultModels } from './keyvault.mjs'

// 纯文本模型调用：与 vision.mjs 共用同一套「重试 + 降级链」，供评审、智能体对话、画布节点使用

export function modelChain() {
  // 文本模型优先；LLM_* 没配时退回视觉链（很多多模态模型聊天一样好用）
  // 后台 Key 池里声明的模型也进候选链：管理员加一把新 Key 就能直接选到它的模型，不用改环境变量。
  const text = [...new Set([config.llm.model, ...config.llm.fallbacks, ...vaultModels('text')].filter(Boolean))]
  return text.length ? text : [...new Set([config.vision.model, ...config.vision.fallbacks, ...vaultModels('vision')].filter(Boolean))]
}

export function llmEnabled() {
  return visionEnabled()
}

/**
 * 多模态调用（评审要看图）专用的模型链：只允许「明确声明为视觉模型」的模型进来。
 * 为什么单独一条：文本 fallback 常常是纯文本模型（deepseek-v4-pro 这类），
 * 一旦视觉模型失败就换它，图片会被静默丢掉，评审返回一句「未提供可分析的截图图像」——
 * 比报错更难发现（2026-11-11 生产实测踩到）。
 */
export function visionChain() {
  const list = [...new Set([config.vision.model, ...config.vision.fallbacks, ...config.vision.models].filter(Boolean))]
  return list.length ? list : modelChain()
}

async function callOnce(messages, model, { temperature = 0.3, maxTokens = 2000, json = false, meter = null, signal } = {}) {
  // max_tokens 包含推理 token：推理型模型给太小会把正文截断，chatCompletion 会按可重试错误抛出
  // signal 是「用户停止运行」的通道（v0.9.101）：传下去之后 fetch 会被立刻中止，不再换模型重试
  const { message } = await chatCompletion({ model, messages, temperature, maxTokens, json, meter, signal })
  const content = String(message.content || '').trim()
  // 推理型模型偶发把整段输出塞进 reasoning_content、content 为空：
  // 换下一个候选模型，绝不把思考过程当答案返回。
  if (!content) {
    throw Object.assign(
      new Error('模型 ' + model + (message.reasoning_content ? ' 只返回了推理过程（content 为空）' : ' 没有返回内容')),
      { retryable: true },
    )
  }
  return { text: content, model }
}

export async function callTextModel(messages, options = {}) {
  if (!llmEnabled()) throw Object.assign(new Error('未配置模型凭证（VISION_API_KEY 或本地 OpenCodex）'), { code: 'NO_MODEL' })
  const chain = options.models?.length ? options.models : modelChain()
  const log = options.log
  // 推理型模型的 reasoning_tokens 也算在 max_tokens 里：同一个预算重试一次只会拿到同样的半截 JSON。
  // 因此被截断时把预算放宽一档再试，第二次还被截断才换模型（换模型可以从原预算重新开始）。
  const baseTokens = Math.max(256, Number(options.maxTokens) || 2000)
  const retryTokens = Math.min(8000, Math.round(baseTokens * 1.6))
  let lastError
  for (const model of chain) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const maxTokens = attempt === 0 ? baseTokens : retryTokens
      try {
        log?.(attempt === 0 ? '模型：' + model : '模型：' + model + ' · 截断后把 max_tokens 放宽到 ' + maxTokens + ' 再试一次')
        return await callOnce(messages, model, { ...options, maxTokens })
      } catch (error) {
        // 用户停止：不换候选模型、不重试，直接把中止交给运行层收尾
        if (options.signal?.aborted) throw error
        lastError = error
        const truncated = Boolean(error?.truncated)
        const retryable = truncated || error?.retryable || error?.name === 'AbortError' || /fetch failed/i.test(String(error?.message))
        if (!retryable || attempt === 1) break
        await sleep(truncated ? 400 : (attempt + 1) * 2500)
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
