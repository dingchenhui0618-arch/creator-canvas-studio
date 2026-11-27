/**
 * 断网、服务没起来、跨域被拦，浏览器统一报一句英文的「Failed to fetch」。
 * 那是给开发者看的；用户看到只会以为是自己操作错了（v0.9.246）。
 * 翻成一句能行动的中文，原始那串留在 detail 里排障，不丢线索。
 */
export function networkError(caught: unknown): Error {
  const detail = caught instanceof Error ? caught.message : String(caught ?? '')
  return Object.assign(new Error('连不上服务：检查网络后重试。'), { status: 0, network: true, detail })
}

/** 主动取消（用户点停、切页）不是失败：原样抛回，调用方按取消处理。 */
export function isAbortError(caught: unknown): boolean {
  return Boolean(caught && typeof caught === 'object' && (caught as { name?: string }).name === 'AbortError')
}

/** fetch 只包这一层：网络层失败翻译掉，HTTP 层的错误仍按服务端给的 error 文案走。 */
export async function safeFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (caught) {
    if (isAbortError(caught)) throw caught
    throw networkError(caught)
  }
}

/**
 * 这次响应里有没有「钱动了」的痕迹（r342）：扣费接口都会在正文里回 cost / balance，
 * 任务接口回 task.credits.cost，退款回 refunded。右上角那块余额就靠它刷新。
 *
 * 为什么在这里统一派发、而不是每个调用点各写一遍：扣费接口十几处（评审 / 复刻 /
 * 对话预设 / 工作流 / 素材 / 计费），漏一处就是一次「积分没扣」的错觉——
 * 生产上用户就是这么报的（2026-11-27：右上角 169 一直不动，而对话里已经写着扣了 3 积分）。
 */
function carriesCredits(value: unknown, depth = 0): boolean {
  if (!value || depth > 3) return false
  if (Array.isArray(value)) return value.some((item) => carriesCredits(item, depth + 1))
  if (typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.cost === 'number') return true
  if (typeof record.balance === 'number') return true
  if (record.refunded === true) return true
  return Object.values(record).some((item) => carriesCredits(item, depth + 1))
}

/** 余额查询自己会带回 balance：在这里派发等于自己触发自己，转圈。 */
function isCreditsQuery(input: string): boolean {
  return /^\/api\/credits(\?|$)/.test(input) || /^\/api\/account(\?|$)/.test(input)
}

export async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await safeFetch(input, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { error: text.slice(0, 200) }
  }
  if (!response.ok) {
    const message = (body as { error?: string })?.error || 'HTTP ' + response.status
    // 受保护接口在未登录时返回 { loginRequired: true }：统一派发事件，由 useSession 清会话回登录页。
    // 只在浏览器里派发，SSR / 测试环境没有 window。
    if (response.status === 401 && (body as { loginRequired?: boolean } | null)?.loginRequired && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('vq:auth-required'))
    }
    throw Object.assign(new Error(message), { status: response.status, body })
  }
  // 钱动过就让右上角重读一次。
  // 只看写请求：查询也是 GET（任务轮询每 2.5 秒一次，正文里一直有 cost，按 GET 也派发就是每 2.5 秒白读一次余额）；
  // 查询余额本身除外，见 isCreditsQuery。
  const method = String(init?.method || 'GET').toUpperCase()
  if (typeof window !== 'undefined' && method !== 'GET' && !isCreditsQuery(input) && carriesCredits(body)) {
    window.dispatchEvent(new Event('vq:credits'))
  }
  return body as T
}
