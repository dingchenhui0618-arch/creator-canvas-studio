import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, redfoxEnabled, visionEnabled } from './config.mjs'
import { searchMedia } from './redfox.mjs'
import { searchFixtures } from './fixtures.mjs'
import { startReplicate, getJob } from './jobs.mjs'
import { listTemplates, getTemplate, reuseTemplate, deleteTemplate, templateStats } from './templates.mjs'

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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=3600' })
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
      const result = await searchMedia({ platform, keyword, startDate, endDate, pageNum: Number(url.searchParams.get('page') || 1), pageSize: 24 })
      return sendJson(res, 200, { ...result, note: result.errors?.length ? result.errors.join('；') : '' })
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
