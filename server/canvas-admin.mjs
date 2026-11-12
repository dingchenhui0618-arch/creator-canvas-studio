// 画布身份（跨系统）：VisionQA 后台用它在管理员页里看谁进过画布、并停用/恢复。
// 只走服务端到服务端：密钥放请求头，浏览器永远看不到。
import { config } from './config.mjs'

const TIMEOUT_MS = 6000

function fail(message, code, status) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

// 每次都读一次环境变量：密钥可以在不停进程的情况下轮换，测试也能单独改配置。
function adminSettings() {
  const secret = (process.env.VQ_CANVAS_SHARED_SECRET || '').trim() || config.canvas.sharedSecret
  const url = (process.env.VQ_CANVAS_ADMIN_URL || '').trim() || config.canvas.adminUrl
  return { secret: secret || '', url: url || '' }
}

export function canvasAdminConfigured() {
  const { secret, url } = adminSettings()
  return Boolean(secret && url)
}

async function callCanvas(pathname, init = {}) {
  const { secret, url } = adminSettings()
  if (!secret || !url) throw fail('画布账号互通未配置', 'CANVAS_NOT_CONFIGURED', 503)
  const base = String(url).replace(/\/+$/, '')
  let response
  try {
    response = await fetch(base + pathname, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-VisionQA-Secret': secret,
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw fail('画布服务暂时连不上', 'CANVAS_UNREACHABLE', 502)
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = fail(data?.error || '画布服务拒绝了这次请求', 'CANVAS_REJECTED', 502)
    error.upstreamCode = data?.code
    throw error
  }
  return data
}

export async function listCanvasUsers() {
  const data = await callCanvas('/enterprise/api/visionqa/users')
  return Array.isArray(data?.items) ? data.items : []
}

export async function setCanvasUserAccess(id, enabled) {
  const data = await callCanvas(`/enterprise/api/visionqa/users/${encodeURIComponent(id)}/access`, {
    method: 'POST',
    body: JSON.stringify({ enabled: Boolean(enabled) }),
  })
  return data?.item || null
}
