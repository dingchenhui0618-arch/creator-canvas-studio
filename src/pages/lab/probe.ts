// Lab 控制台的探测工具：只做真实 fetch + 计时，不缓存、不兜底编造数据。
export type ProbeResult = {
  ok: boolean
  status: number
  ms: number
  data: unknown
  error: string
  at: string
}

function readError(data: unknown): string {
  if (data && typeof data === 'object' && 'error' in data) {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return ''
}

export async function probeJson(path: string, timeoutMs = 4500): Promise<ProbeResult> {
  const startedAt = performance.now()
  const at = new Date().toISOString()
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(path, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    })
    const text = await response.text()
    let data: unknown = null
    try {
      data = text ? (JSON.parse(text) as unknown) : null
    } catch {
      data = { raw: text.slice(0, 240) }
    }
    return {
      ok: response.ok,
      status: response.status,
      ms: Math.round(performance.now() - startedAt),
      data,
      error: response.ok ? '' : readError(data) || 'HTTP ' + response.status,
      at,
    }
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? '超时（>' + timeoutMs + 'ms）'
        : String((error as Error)?.message || error)
    return {
      ok: false,
      status: 0,
      ms: Math.round(performance.now() - startedAt),
      data: null,
      error: message,
      at,
    }
  } finally {
    window.clearTimeout(timer)
  }
}

export function pickField(data: unknown, path: string): unknown {
  let current: unknown = data
  for (const key of path.split('.')) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

export function formatField(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join(' / ') : '—'
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 140)
  return String(value)
}

export function itemsOf(data: unknown): unknown[] {
  if (data && typeof data === 'object') {
    const items = (data as { items?: unknown }).items
    if (Array.isArray(items)) return items
  }
  return []
}

export function countOf(data: unknown): number | null {
  if (data && typeof data === 'object') {
    const total = (data as { total?: unknown }).total
    if (typeof total === 'number') return total
    const items = (data as { items?: unknown }).items
    if (Array.isArray(items)) return items.length
  }
  return null
}

export function formatClock(iso: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms + ' ms'
}
