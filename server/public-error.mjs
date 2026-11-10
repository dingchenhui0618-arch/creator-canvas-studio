// 用户可见报错必须用产品语言：上游原始报文里带着模型标识、供应商地址、账号余额细节，
// 直接透出既不专业也等于把内部配置亮给客户。排障细节仍然写服务端日志。
const MODEL_NAME = /deepseek[-a-z0-9.]*|qwen[-a-z0-9.]*|doubao[-a-z0-9.]*|gpt-[a-z0-9.-]*|glm[-a-z0-9.]*|claude[-a-z0-9.]*/gi

export function publicError(error, fallback = '服务暂时不可用，请稍后重试') {
  const raw = String(error?.message || error || '').trim()
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
