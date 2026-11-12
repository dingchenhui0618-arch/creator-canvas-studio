// /api/projects：作品（一条内容的主线对象）。
//
// 作品本身只存「绑哪条模板、绑哪块画布、到哪一步」；脚本与分镜从模板实时读，
// 画布从流程服务实时读，评审按 projectId 关联。这样改模板不会让作品里留一份过期副本。
import { sendJson, readBody } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { config } from '../config.mjs'
import { getTemplate } from '../templates.mjs'
import { getFlow } from '../flows.mjs'
import { listReviews, reviewCountsByProject, detachReviewsFromProject } from '../reviews.mjs'
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
} from '../projects.mjs'

const ITEM = /^\/api\/projects\/([\w-]+)$/

// 列表只给卡片要用的那几项：模板标题、流程名、评审计数
function templateBrief(template) {
  if (!template) return null
  return {
    id: template.id,
    title: template.title,
    kind: template.kind,
    contentType: template.contentType || '',
    durationSec: Number(template.durationSec) || 0,
    beats: Array.isArray(template.structure) ? template.structure.length : 0,
    shots: Array.isArray(template.storyboard) ? template.storyboard.length : 0,
  }
}

// 作品页要渲染脚本与分镜：只取这几项，不把抽帧与视频元数据整包丢过去
function templateDetail(template) {
  if (!template) return null
  return {
    ...templateBrief(template),
    hook: template.hook || '',
    hookType: template.hookType || '',
    platformLabel: template.platformLabel || '',
    structure: template.structure || [],
    storyboard: template.storyboard || [],
    timing: template.timing || null,
    cover: template.thumb || template.cover || '',
    reuseCount: Number(template.reuseCount) || 0,
  }
}

function flowBrief(flow) {
  if (!flow) return null
  return {
    id: flow.id,
    name: flow.name,
    nodes: Array.isArray(flow.nodes) ? flow.nodes.length : 0,
    updatedAt: flow.updatedAt,
  }
}

export function createProjectsRouter() {
  return {
    prefix: '/api/projects',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/projects')) return false
      const user = currentUser(req)
      // 生产必须登录；本地演示（VQ_REQUIRE_AUTH=0）沿用模板/评审的做法：不认人但照常可用。
      if (!user && config.auth.requireAuth) {
        sendJson(res, 401, { error: '未登录', loginRequired: true })
        return true
      }

      if (pathname === '/api/projects' && req.method === 'GET') {
        const [projects, reviews] = await Promise.all([listProjects(user), reviewCountsByProject(user)])
        const items = []
        for (const project of projects) {
          const template = project.templateId ? await getTemplate(project.templateId, user) : null
          const counters = reviews[project.id] || { count: 0, lastVerdict: '', lastAt: '' }
          items.push({
            ...project,
            template: templateBrief(template),
            reviews: counters,
          })
        }
        sendJson(res, 200, { ok: true, items, total: items.length })
        return true
      }

      if (pathname === '/api/projects' && req.method === 'POST') {
        const body = await readBody(req)
        const templateId = String(body.templateId || '')
        if (!templateId) {
          sendJson(res, 400, { error: '作品要从一条模板开始：请先选模板再建作品', code: 'TEMPLATE_REQUIRED' })
          return true
        }
        const template = await getTemplate(templateId, user)
        if (!template) {
          sendJson(res, 404, { error: '模板不存在或不属于当前账号' })
          return true
        }
        if (template.kind === 'saved' || (!template.structure?.length && !template.storyboard?.length)) {
          sendJson(res, 400, { error: '这条模板还没解析出脚本与分镜，先解析再建作品', code: 'TEMPLATE_UNPARSED' })
          return true
        }
        const project = await createProject(
          { title: String(body.title || template.title || '').slice(0, 80), templateId: template.id },
          user,
        )
        sendJson(res, 201, { ok: true, project })
        return true
      }

      const item = pathname.match(ITEM)
      if (item && req.method === 'GET') {
        const project = await getProject(item[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const [template, flow, reviews] = await Promise.all([
          project.templateId ? getTemplate(project.templateId, user) : null,
          project.flowId ? getFlow(project.flowId, user) : null,
          listReviews({ projectId: project.id, limit: 20 }, user),
        ])
        sendJson(res, 200, {
          ok: true,
          project,
          template: templateDetail(template),
          flow: flowBrief(flow),
          reviews: reviews.items,
        })
        return true
      }

      if (item && req.method === 'PATCH') {
        const body = await readBody(req)
        if ('flowId' in body && body.flowId) {
          const flow = await getFlow(String(body.flowId), user)
          if (!flow) {
            sendJson(res, 404, { error: '要绑定的画布不存在', code: 'FLOW_NOT_FOUND' })
            return true
          }
        }
        const patch = {}
        if ('title' in body) patch.title = String(body.title || '')
        if ('status' in body) patch.status = String(body.status || '')
        if ('flowId' in body) patch.flowId = String(body.flowId || '')
        const project = await updateProject(item[1], patch, user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        sendJson(res, 200, { ok: true, project })
        return true
      }

      if (item && req.method === 'DELETE') {
        const removed = await deleteProject(item[1], user)
        if (!removed) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        // 评审记录留着当历史，但不再挂在已删除的作品上
        const detached = await detachReviewsFromProject(removed.id)
        sendJson(res, 200, { ok: true, removed: { id: removed.id, detachedReviews: detached } })
        return true
      }

      sendJson(res, 404, { error: '未知的作品接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}
