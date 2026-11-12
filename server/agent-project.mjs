// 智能体的草稿写进作品（v0.9.30）：结构化草稿的第三个出口。
//
// 草稿是「段 + 镜」的机器可读版，作品脚本只认「钩子 + 段落」——所以这一条出口写的是脚本，
// 分镜仍留在草稿里：要镜头就送到画布，作品的分镜跟着模板走（画布出生的作品没有模板，
// 也就不编一份分镜出来）。写进去走的是作品脚本的 copy-on-write：模板与别的作品一个字不动。
import { getProject, saveProjectScript } from './projects.mjs'
import { getTemplate } from './templates.mjs'
import { normalizeProjectScript, scriptPace, scriptView } from './project-script.mjs'
import { projectBrief } from './project-briefs.mjs'
import { syncCanvasScript } from './project-canvas-sync.mjs'

/**
 * 草稿 → 作品脚本的形状。草稿的 structure 已经是 normalizeProjectScript 那一套字段，
 * 这里按作品当前模板的语速档重算时长；没有段落（只有分镜）就返回 null，不给这个出口。
 */
export function draftProjectScript(draft, { pace = '中', totalSec = 0 } = {}) {
  if (!draft || typeof draft !== 'object') return null
  const structure = Array.isArray(draft.structure) ? draft.structure : []
  if (!structure.length) return null
  return normalizeProjectScript({ hook: draft.hook || '', structure }, { pace, totalSec })
}

/**
 * 写进一条作品。返回 { status, body }，与画布归作品那条路同一个回执形状：
 * 出错只给「为什么」，成功给作品简报、脚本视图与被换掉的那份摘要（界面据此如实写一句）。
 */
export async function writeDraftToProject({ draft, projectId, user }) {
  const id = String(projectId || '').trim()
  if (!id) {
    return { status: 400, body: { error: '先选一条作品：草稿要写进哪一条', code: 'PROJECT_REQUIRED' } }
  }
  const project = await getProject(id, user)
  if (!project) {
    return { status: 404, body: { error: '作品不存在：' + id, code: 'PROJECT_NOT_FOUND' } }
  }
  const template = project.templateId ? await getTemplate(project.templateId, user) : null
  const script = draftProjectScript(draft, {
    pace: scriptPace(template),
    totalSec: Number(template?.durationSec) || 0,
  })
  if (!script) {
    return {
      status: 400,
      body: {
        error: '这份草稿只有分镜、没有脚本段落：先在草稿里给出 structure，或者把它送到画布',
        code: 'DRAFT_NO_SCRIPT',
      },
    }
  }
  // 换掉的是哪一份要说清楚：这份草稿是覆盖，不是合并（合并会留半句旧口播在画布里）
  const before = scriptView(project, template)
  const saved = await saveProjectScript(project.id, script, user)
  if (!saved) {
    return { status: 500, body: { error: '脚本没存上：作品可能刚被删掉，刷新再试', code: 'SCRIPT_SAVE_FAILED' } }
  }
  const canvas = await syncCanvasScript(saved, template, script, before?.hook || '', user)
  return {
    status: 200,
    body: {
      ok: true,
      project: projectBrief(saved),
      script: scriptView(saved, template),
      canvas,
      replaced: {
        source: before?.source || '',
        beats: Array.isArray(before?.structure) ? before.structure.length : 0,
      },
    },
  }
}
