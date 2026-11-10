// 真实可用性状态：/models 能连通不等于账号出得了结果——上游余额为 0 时 /models 照样 200，
// 直到真正发起一次补全才 402。这里记住最近一次真实调用的结果，用于三件事：
//   1) 健康检查不再把「接口能连」当成「服务可用」；
//   2) 已知额度/凭证问题时直接拦在扣费之前，避免每次先扣再退；
//   3) 生产只给产品语言，内部环境保留上游原始报文、模型名与时间。
//
// 状态在进程内保存，5 分钟后自动失效：管理员充值或换 key 后不用重启服务，
// 下一次真实调用成功就会把状态清掉。
const BLOCK_MS = 5 * 60 * 1000
const MAX_COUNT = 99

const model = { blocked: false, code: '', at: 0, count: 0, lastMessage: '', lastModel: '', verifiedAt: 0 }

const PUBLIC_MESSAGE = {
  quota: '模型服务额度不足，暂时不能生成。本次未扣积分，管理员正在处理。',
  auth: '模型服务接入异常，暂时不能生成。本次未扣积分，管理员正在处理。',
  unknown: '模型服务暂时不可用。本次未扣积分，请稍后再试。',
}

const INTERNAL_LABEL = {
  quota: '上游额度不足（Insufficient Balance / 402）',
  auth: '上游凭证无效（401 / 403）',
  unknown: '上游调用失败',
}

// 只把「账号级」故障当成不可用：额度不足、凭证失效换模型也没用。
// 超时、限流、单个模型 404 属于可重试问题，不该整站拦掉。
export function classifyModelError(error) {
  const raw = String(error?.message || error || '')
  if (/Insufficient Balance|insufficient_balance|HTTP 402|status 402/i.test(raw)) return 'quota'
  if (/HTTP 401|HTTP 403|Unauthorized|invalid_api_key|Invalid API key|authentication_error/i.test(raw)) return 'auth'
  return ''
}

export function noteModelFailure(error, modelName = '') {
  const code = classifyModelError(error)
  if (!code) return false
  model.blocked = true
  model.code = code
  model.at = Date.now()
  model.count = Math.min(MAX_COUNT, model.count + 1)
  model.lastMessage = String(error?.message || error || '').slice(0, 300)
  model.lastModel = String(modelName || '').slice(0, 80)
  // 出过失败就不再算「已验证」：即使 5 分钟后自动失效，也要等下一次真实成功才算数
  model.verifiedAt = 0
  return true
}

export function noteModelSuccess() {
  model.blocked = false
  model.code = ''
  model.at = 0
  model.count = 0
  model.lastMessage = ''
  model.lastModel = ''
  model.verifiedAt = Date.now()
}

function resetWithoutProof() {
  model.blocked = false
  model.code = ''
  model.at = 0
  model.count = 0
  model.lastMessage = ''
  model.lastModel = ''
  model.verifiedAt = 0
}

// 管理员处理完之后由界面「重新检测」调用：先放行一次真实请求，成功了状态自然清掉。
// 这里只清阻塞，不代表「已验证」——进程刚启动或刚放行时都还是待验证。
export function clearModelBlock() {
  resetWithoutProof()
}

export function modelServiceState(now = Date.now()) {
  const active = model.blocked && now - model.at <= BLOCK_MS
  if (!active) {
    return {
      available: true,
      verified: model.verifiedAt > 0,
      verifiedAt: model.verifiedAt ? new Date(model.verifiedAt).toISOString() : null,
      code: 'ok',
      message: model.verifiedAt ? '模型服务可用' : '模型服务已连通，待首次生成验证',
      internalDetail: '',
      upstreamMessage: '',
      lastModel: '',
      since: null,
      count: model.count,
      retryAfterSec: 0,
    }
  }
  const code = model.code || 'unknown'
  const since = new Date(model.at).toISOString()
  const parts = [
    INTERNAL_LABEL[code] || INTERNAL_LABEL.unknown,
    '最近一次 ' + since,
    '连续 ' + model.count + ' 次',
    model.lastModel ? '模型 ' + model.lastModel : '',
  ].filter(Boolean)
  return {
    available: false,
    verified: false,
    verifiedAt: null,
    code,
    message: PUBLIC_MESSAGE[code] || PUBLIC_MESSAGE.unknown,
    internalDetail: parts.join(' · '),
    upstreamMessage: model.lastMessage,
    lastModel: model.lastModel,
    since,
    count: model.count,
    retryAfterSec: Math.max(1, Math.ceil((BLOCK_MS - (now - model.at)) / 1000)),
  }
}
