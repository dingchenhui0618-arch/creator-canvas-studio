import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, redfoxEnabled, visionEnabled } from './config.mjs'
import { searchMedia } from './redfox.mjs'
import { searchFixtures } from './fixtures.mjs'
import { startReplicate, getJob } from './jobs.mjs'
import { listTemplates, getTemplate, reuseTemplate, deleteTemplate, templateStats } from './templates.mjs'
import { createAgentsRouter } from './routes/agents.mjs'
import { createFlowsRouter } from './routes/flows.mjs'
import { createReviewRouter } from './routes/review.mjs'
import { createAuthRouter } from './routes/auth.mjs'
import { currentUser } from './auth.mjs'
import { bdcStatus, listCanvases, createCanvas, appendCanvasNote } from './bdc.mjs'
import { modelCatalog } from './models.mjs'

// 功能路由：每个模块自己处理 /api/<prefix> 下的请求，index.mjs 只管分发
// auth 放最前面：/api/auth/* 永远不需要登录就能访问
const featureRoutes = [createAuthRouter(), createAgentsRouter(), createFlowsRouter(), createReviewRouter()]

// VQ_REQUIRE_AUTH=1 时，除少数公开端点外所有 /api/* 都要登录。
// 默认关闭，本地演示不受影响；生产必须打开。
const PUBLIC_API = ['/api/auth', '/api/health', '/api/version', '/api/models']
function needsLogin(pathname) {
  if (!config.auth.requireAuth) return false
  if (!pathname.startsWith('/api/')) return false
  return !PUBLIC_API.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))
}

const STARTED_AT = new Date().toISOString()

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
  try { return JSON.parse(text) } catch { return {} }
}

async function serveFile(res, file) {
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) return false
    const ext = path.extname(file).toLowerCase()
    // 入口 HTML 不缓存，避免用户拿到旧 bundle；带 hash 的静态资源长缓存
    const cache = ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=604800, immutable'
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': cache })
    res.end(await fsp.readFile(file))
    return true
  } catch {
    return false
  }
}

async function proxyImage(res, target) {
  try {
    const url = new URL(target)
    if (!/^https?:$/.test(url.protocol)) throw new Error('bad protocol')
    const response = await fetch(url, { headers: { Referer: url.origin, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122 Safari/537.36' } })
    const type = response.headers.get('content-type') || ''
    if (!response.ok || !type.startsWith('image/')) throw new Error('not an image')
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > 8 * 1024 * 1024) throw new Error('too large')
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' })
    res.end(buffer)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('image unavailable')
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)

  try {
    for (const route of featureRoutes) {
      const prefixes = [route.prefix, ...(route.extraPrefixes || [])]
      if (prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))) {
        const handled = await route.handle(req, res, url, pathname)
        if (handled !== false) return
      }
    }

    if (needsLogin(pathname) && !currentUser(req)) {
      return sendJson(res, 401, { error: '未登录', loginRequired: true })
    }

    if (pathname === '/api/version') {
      // 真实的版本号：读本仓库 package.json；客户端拿它和自己的构建版本比对，用来发现「页面是旧的」
      const pkg = JSON.parse(await fsp.readFile(path.join(process.cwd(), 'package.json'), 'utf8'))
      sendJson(res, 200, { version: pkg.version, name: pkg.name, startedAt: STARTED_AT })
      return
    }

    if (pathname === '/api/bdc/status') {
      sendJson(res, 200, await bdcStatus())
      return
    }

    // 画布 ↔ 工作台：列画布、建画布、往画布里落评审笔记（都走画布自己的 HTTP 接口，不碰它的文件）
    if (pathname === '/api/bdc/canvases' && req.method === 'GET') {
      return sendJson(res, 200, await listCanvases())
    }

    if (pathname === '/api/bdc/canvases' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        return sendJson(res, 200, await createCanvas(body.name))
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: String(error?.message || error).slice(0, 160) })
      }
    }

    if (pathname === '/api/bdc/canvases/note' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        return sendJson(res, 200, await appendCanvasNote(body.canvasId, body.text, body.title))
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: String(error?.message || error).slice(0, 160) })
      }
    }

    if (pathname === '/api/models') {
      // 模型清单只读：给界面提供「切换模型」的下拉选项，模型本体在服务端 .env 里配
      return sendJson(res, 200, { ok: true, ...modelCatalog() })
    }

    if (pathname === '/api/health') {
      const stats = await templateStats()
      return sendJson(res, 200, { ok: true, redfox: redfoxEnabled(), vision: visionEnabled(), visionModel: config.vision.model, templates: stats.total })
    }

    if (pathname === '/api/search') {
      const platform = url.searchParams.get('platform') || 'all'
      const keyword = url.searchParams.get('q') || ''
      const startDate = url.searchParams.get('start') || ''
      const endDate = url.searchParams.get('end') || ''
      if (!redfoxEnabled()) {
        const items = searchFixtures(keyword)
        return sendJson(res, 200, { mode: 'mock', items, total: items.length, note: '未配置 REDFOX_API_KEY，当前展示示例数据（非真实平台数据）' })
      }
      try {
        const result = await searchMedia({ platform, keyword, startDate, endDate, pageNum: Number(url.searchParams.get('page') || 1), pageSize: 24 })
        return sendJson(res, 200, { ...result, note: result.errors?.length ? result.errors.join('；') : '' })
      } catch (error) {
        if (error?.code === 'REDFOX_RATE') {
          return sendJson(res, 429, { error: '红狐接口触发频率限制（抖音 10 次/秒、小红书 20 次/秒），请稍后重试', code: 'REDFOX_RATE' })
        }
        if (error?.code === 'REDFOX_DISABLED') {
          const items = searchFixtures(keyword)
          return sendJson(res, 200, {
            mode: 'mock',
            items,
            total: items.length,
            note: '红狐 API Key 已被禁用（3105），当前显示的是示例数据：请到红狐后台确认 Key 状态后再试。',
            quota: { code: 'REDFOX_DISABLED', message: error.message, rechargeUrl: 'https://redfox.hk/dashboard' },
          })
        }
        if (error?.code === 'REDFOX_QUOTA') {
          // 有 Key 但积分不足：不伪装成真实数据，明确说明并给示例数据兜底
          const items = searchFixtures(keyword)
          return sendJson(res, 200, {
            mode: 'mock',
            items,
            total: items.length,
            note: '红狐接口已连通，但账号积分不足（' + (error.quota?.amount ?? 0) + ' 元起充 / ' + (error.quota?.goodsName || '见红狐后台') + '），当前显示的是示例数据。',
            quota: { code: 'REDFOX_QUOTA', message: error.message, rechargeUrl: error.rechargeUrl, goodsName: error.quota?.goodsName || '' },
          })
        }
        throw error
      }
    }

    if (pathname === '/api/replicate' && req.method === 'POST') {
      const body = await readBody(req)
      const job = await startReplicate(body.item || {}, body.url || '')
      return sendJson(res, 200, { jobId: job.id })
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([\w-]+)$/)
    if (jobMatch) {
      const job = getJob(jobMatch[1])
      if (!job) return sendJson(res, 404, { error: 'job not found' })
      return sendJson(res, 200, job)
    }

    if (pathname === '/api/templates') {
      const stats = await templateStats()
      const list = await listTemplates({ q: url.searchParams.get('q') || '', contentType: url.searchParams.get('type') || '', platform: url.searchParams.get('platform') || '' })
      return sendJson(res, 200, { items: list, ...stats })
    }

    const tplMatch = pathname.match(/^\/api\/templates\/([\w-]+)(\/reuse)?$/)
    if (tplMatch) {
      const id = tplMatch[1]
      if (tplMatch[2]) {
        const updated = await reuseTemplate(id)
        if (!updated) return sendJson(res, 404, { error: '模板不存在' })
        return sendJson(res, 200, updated)
      }
      if (req.method === 'DELETE') {
        const done = await deleteTemplate(id)
        return sendJson(res, done ? 200 : 404, { ok: done })
      }
      const template = await getTemplate(id)
      if (!template) return sendJson(res, 404, { error: '模板不存在' })
      return sendJson(res, 200, template)
    }

    if (pathname === '/api/cover') {
      const target = url.searchParams.get('url') || ''
      return proxyImage(res, target)
    }

    const frameMatch = pathname.match(/^\/media\/frames\/([\w-]+)\/([\w.-]+)$/)
    if (frameMatch) {
      const file = path.join(config.framesDir, frameMatch[1], frameMatch[2])
      const ok = await serveFile(res, file)
      if (!ok) { res.writeHead(404); res.end('frame not found') }
      return
    }

    // 生产环境静态托管 dist
    const distDir = path.join(process.cwd(), 'dist')
    const candidate = pathname === '/' ? path.join(distDir, 'index.html') : path.join(distDir, pathname)
    if (await serveFile(res, candidate)) return
    if (await serveFile(res, path.join(distDir, 'index.html'))) return

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + pathname)
  } catch (error) {
    sendJson(res, 500, { error: String(error?.message || error) })
  }
})

server.listen(config.port, '127.0.0.1', () => {
  console.log('[api] http://127.0.0.1:' + config.port + '  redfox=' + (redfoxEnabled() ? 'on' : 'mock') + '  vision=' + (visionEnabled() ? config.vision.model : 'off'))
})
