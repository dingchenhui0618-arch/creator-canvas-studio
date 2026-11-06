// BD Canvas 探活：BD Canvas 是 Source-Available 项目，源码不随本仓库分发，
// 只在本机部署后通过 127.0.0.1:6677（网页入口）/ 5313（后台管理）访问。
const WEB_URL = process.env.BDC_WEB_URL || 'http://127.0.0.1:6677'
// 对外嵌进 iframe 用的地址：公网部署时 nginx 上有 Basic Auth，
// 带上一次性入口（/__auth?k=...）会种 cookie，iframe 里就无需再弹登录框。
// 探活仍然走 WEB_URL，避免把带凭据的地址写进日志和界面。
const EMBED_URL = process.env.BDC_EMBED_URL || WEB_URL
// 探活地址：公网入口可能带 Basic Auth（401 会让探活误判成没部署），
// 所以默认探本机 6677；需要探公网时再显式设 BDC_WEB_PROBE_URL。
const PROBE_URL = process.env.BDC_WEB_PROBE_URL || WEB_URL
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
  // Vite 开发服务器首次响应通常要 1~5s（要转译 index.html 与依赖），探活给足 5s；
  // 正式构建后这一步是毫秒级。
  const [web, admin, api] = await Promise.all([
    probe(PROBE_URL, 5000),
    probe(ADMIN_URL + '/admin/'),
    probe(API_URL),
  ])
  return {
    web: { url: WEB_URL, embedUrl: EMBED_URL, ...web },
    admin: { url: ADMIN_URL + '/admin/', ...admin },
    api: { url: API_URL, ...api },
    deployed: web.up,
  }
}
