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
  return body as T
}
