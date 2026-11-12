// 用户可见报错必须用产品语言：上游原始报文里带着模型标识、供应商地址、账号余额细节，
// 直接透出既不专业也等于把内部配置亮给客户。排障细节仍然写服务端日志。
const MODEL_NAME = /deepseek[-a-z0-9.]*|qwen[-a-z0-9.]*|doubao[-a-z0-9.]*|gpt-[a-z0-9.-]*|glm[-a-z0-9.]*|claude[-a-z0-9.]*/gi

export function publicError(error, fallback = '服务暂时不可用，请稍后重试') {
  // 只认 Error.message 或字符串本身：以前 message 为空时会把 Error 对象整个 String 成 "Error"，
  // 用户看到的就是一句「Error」（测试里发现的）
  const message = error && typeof error === 'object' ? error.message : error
  const raw = String(message ?? '').trim()
  if (!raw) return fallback
  if (/Insufficient Balance|insufficient_balance|HTTP 402/i.test(raw)) {
    return '模型服务额度不足，本次不计费；请联系管理员充值后再试'
  }
  if (/HTTP 401|Unauthorized|invalid_api_key|Invalid API key/i.test(raw)) {
    return '模型服务凭证不可用，请联系管理员检查接入配置'
  }
  if (/HTTP 429|rate limit|频率/i.test(raw)) {
    return '模型服务触发频率限制，请稍后重试'
  }
  // 推理型模型偶发把预算吃在思考上、正文撞到 max_tokens：报给用户的是「没写完、不计费、重试」，
  // 而不是上游那句 finish_reason=length（2026-11-12 生产真实踩到一次）
  if (/finish_reason=length|max_tokens 截断|截断（finish_reason/i.test(raw)) {
    // 评审、画布节点都会走到这里：只说「这次没写完、不计费、再来一次」，不假定是哪个入口
    return '模型这次没写完输出（撞到长度上限），本次不计费；稍后再试一次'
  }
  if (/ETIMEDOUT|fetch failed|timed out|ECONNREFUSED|EAI_AGAIN/i.test(raw)) {
    return '模型服务连接超时，请稍后重试'
  }
  const cleaned = raw
    .replace(MODEL_NAME, '模型服务')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 300)
    .trim()
  return cleaned || fallback
}
