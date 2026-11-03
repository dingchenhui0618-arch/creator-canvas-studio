// BD Canvas 探活：BD Canvas 是 Source-Available 项目，源码不随本仓库分发，
// 只在本机部署后通过 127.0.0.1:6677（网页入口）/ 5313（后台管理）访问。
const WEB_URL = process.env.BDC_WEB_URL || 'http://127.0.0.1:6677'
const ADMIN_URL = process.env.BDC_ADMIN_URL || 'http://127.0.0.1:5313'
const API_URL = process.env.BDC_API_URL || 'http://127.0.0.1:5312'

async function probe(url, timeout = 1200) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    return { up: response.ok, status: response.status }
  } catch (error) {
    return { up: false, status: 0, error: String(error?.message || error).slice(0, 80) }
  }
}

export async function bdcStatus() {
  const [web, admin, api] = await Promise.all([probe(WEB_URL), probe(ADMIN_URL + '/admin/'), probe(API_URL)])
  return {
    web: { url: WEB_URL, ...web },
    admin: { url: ADMIN_URL + '/admin/', ...admin },
    api: { url: API_URL, ...api },
    deployed: web.up,
  }
}
