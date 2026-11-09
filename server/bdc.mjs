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

// ─── 画布数据打通 ─────────────────────────────────────────────────────────────
// 画布的 JSON 存在它自己的 workspace 里（/api/canvas/{list,load,save}），工作台不去碰它的文件，
// 只通过本机 5312 的 HTTP 接口读写，画布的版本号（_bdCanvasRevision）由它自己维护。
const CANVAS_API = API_URL + '/api/canvas'
const CANVAS_TIMEOUT = 8000

async function canvasFetch(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(CANVAS_TIMEOUT) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  if (!response.ok) {
    const message = json?.error?.message || json?.error || text.slice(0, 120) || ('HTTP ' + response.status)
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message))
  }
  return json ?? {}
}

function canvasName(raw) {
  const name = String(raw || '').trim().slice(0, 60)
  return name || ('未命名画布 ' + new Date().toISOString().slice(0, 16).replace('T', ' '))
}

export async function listCanvases() {
  try {
    const data = await canvasFetch(CANVAS_API + '/list')
    const canvases = (data.canvases || []).map((item) => ({
      id: String(item.canvas_id || ''),
      name: String(item.name || item.canvas_id || '未命名画布'),
      nodeCount: Number(item.node_count || 0),
      revision: Number(item.revision || 0),
      updatedAt: Number(item.mtime || 0) * 1000,
    }))
    return { ok: true, canvases }
  } catch (error) {
    return { ok: false, canvases: [], error: String(error?.message || error).slice(0, 160) }
  }
}

function emptyCanvas(id, name) {
  const now = Date.now()
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    thumbnail: null,
    nodes: [],
    connections: [],
    groups: [],
    annotations: [],
    annotationTool: 'node-select',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodeCounter: 0,
  }
}

export async function createCanvas(rawName) {
  const name = canvasName(rawName)
  const id = 'vq-' + Date.now().toString(36)
  await canvasFetch(CANVAS_API + '/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvas_id: id, data: emptyCanvas(id, name) }),
  })
  return { ok: true, canvas: { id, name, nodeCount: 0, revision: 1, updatedAt: Date.now() } }
}

// 工作台 → 画布：往指定画布里落一个「文本」节点（评审结论的载体）。
// 用 _bdCanvasRevision 做乐观锁，别人同时改画布时返回 stale 而不是覆盖。
export async function appendCanvasNote(canvasId, rawText, rawTitle) {
  const id = String(canvasId || '').trim()
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('画布 id 不合法')
  const text = String(rawText || '').trim().slice(0, 4000)
  if (!text) throw new Error('写入内容为空')

  const data = await canvasFetch(CANVAS_API + '/load/' + encodeURIComponent(id))
  const nodes = Array.isArray(data.nodes) ? data.nodes : []
  const revision = Number(data._bdCanvasRevision || 0)
  const counter = Number(data.nodeCounter || nodes.length || 0)
  const seq = counter + 1

  // 字段形状对齐画布自己的 createTextNode：正文放 prompt，params 只放卡片尺寸与来源标记
  const nodeId = 'node-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  nodes.push({
    id: nodeId,
    type: 'text',
    x: 120,
    y: 120 + Math.min(nodes.length, 12) * 40,
    title: String(rawTitle || 'VisionQA 评审笔记').slice(0, 40),
    prompt: text,
    model: 'text',
    // 卡片默认尺寸按「评审结论要能读」定：460×300，比画布默认的 360×220 大一档
    params: { _width: 460, _height: 300, _agentTextNode: true, _source: 'visionqa-workbench' },
    refs: [],
    status: 'idle',
  })

  const next = {
    ...data,
    nodes,
    nodeCounter: seq,
    updatedAt: Date.now(),
    _bdCanvasRevision: revision,
  }
  delete next.id
  const saved = await canvasFetch(CANVAS_API + '/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvas_id: id, data: next, expected_revision: revision }),
  })
  return { ok: true, canvasId: id, nodeId, revision: Number(saved.revision || revision + 1) }
}
