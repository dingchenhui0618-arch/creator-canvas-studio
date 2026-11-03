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
    throw Object.assign(new Error(message), { status: response.status, body })
  }
  return body as T
}
