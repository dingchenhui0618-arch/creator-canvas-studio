// /api/share/project/<token>：作品的只读分享，不需要登录。
//
// 链接本身就是凭证（18 字节随机 token），公开视图只走 project-share.mjs 的白名单：
// 标题、脚本、分镜、评审与运行次数；不带账号、画布、模板 id 与原始素材。
// 分镜帧图也走这条带 token 的地址——/media/frames 是要登录的，分享页拿不到。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sendJson } from './_shared.mjs'
import { getProjectByShareToken } from '../projects.mjs'
import { getTemplate } from '../templates.mjs'
import { scriptView } from '../project-script.mjs'
import { reviewSummaryByVersion } from '../reviews.mjs'
import { listRunsByFlows } from '../flows.mjs'
import { frameFileOf, publicProjectView } from '../project-share.mjs'

const SHARED = /^\/api\/share\/project\/([\w-]+)$/
const FRAME = /^\/api\/share\/project\/([\w-]+)\/frame\/(\d+)$/
const FRAME_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

async function serveFrame(res, file) {
  const ext = path.extname(file).toLowerCase()
  if (!FRAME_MIME[ext]) return false
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) return false
    res.writeHead(200, {
      'Content-Type': FRAME_MIME[ext],
      'Content-Length': stat.size,
      // 只缓存 10 分钟：停止分享后旧链接失效，缓存不该比链接活得更久
      'Cache-Control': 'public, max-age=600',
    })
    res.end(await fsp.readFile(file))
    return true
  } catch {
    return false
  }
}

function notFound(res) {
  return sendJson(res, 404, { error: '这个分享链接已失效，或分享者已停止分享', code: 'SHARE_NOT_FOUND' })
}

export function createProjectShareRouter() {
  return {
    prefix: '/api/share/project',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/share/project')) return false
      const frameMatch = pathname.match(FRAME)
      const sharedMatch = pathname.match(SHARED)
      if (!frameMatch && !sharedMatch) {
        sendJson(res, 404, { error: '没有这个分享接口' })
        return true
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '分享链接只能读，不能改' })
        return true
      }
      const token = (frameMatch || sharedMatch)[1]
      const project = await getProjectByShareToken(token)
      if (!project) return notFound(res)
      // 已软删除的模板不再对外：作品自己的脚本仍然可以看
      const found = project.templateId ? await getTemplate(project.templateId, null) : null
      const template = found && !found.deletedAt ? found : null

      if (frameMatch) {
        const file = frameFileOf(template, frameMatch[2])
        if (file && (await serveFrame(res, file))) return true
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('no frame')
        return true
      }

      const script = scriptView(project, template)
      const flows = [project.flowId, ...project.versions.map((entry) => entry.flowId)].filter(Boolean)
      const [versionCounts, runData] = await Promise.all([
        reviewSummaryByVersion(project.id, null),
        flows.length ? listRunsByFlows(flows, { limit: 1 }, null) : Promise.resolve({ total: 0 }),
      ])
      // 跨版本合计：分享页给的是「这条作品一共评过几次」，不按版本拆（版本是内部概念）
      let count = 0
      let lastVerdict = ''
      let lastAt = ''
      for (const entry of Object.values(versionCounts || {})) {
        count += Number(entry?.count) || 0
        if (String(entry?.lastAt || '') > lastAt) {
          lastAt = String(entry.lastAt || '')
          lastVerdict = String(entry.lastVerdict || '')
        }
      }
      sendJson(res, 200, {
        ok: true,
        ...publicProjectView({
          project,
          template,
          script,
          reviews: { count, lastVerdict, lastAt },
          runs: runData.total,
          token,
        }),
      })
      return true
    },
  }
}
