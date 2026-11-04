export async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
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
