// 画布归作品（v0.9.29）：一块画布从「空白画布」变成「某条作品的第几版」。
//
// 以前这块接口是缺的：空白画布直接跑出来的运行只写一句「没挂在作品上」，
// 运行记录给不出下一步——想把它变成一条作品，只能从头再走一遍模板。
//
// 两条路，一个判据：
//   1. 挂到已有作品  PUT /api/projects/:id/canvas  { flowId }
//   2. 照画布建作品  POST /api/projects             { flowId }
// 判据是同一张索引（projectsByFlow）：一块画布只归一条作品，一条作品只有一块当前画布。
// 这条线不是为了整齐——运行与评审都按 flowId 反查作品，画布要是归了两条，
// 同一次运行的「作品 · 第几版」就有两个答案。
//
// 归过去不改任何运行记录：运行仍只认 flowId，作品那侧记着指针，一接上，
// 这块画布以前跑过的运行与之后的评审就都落在这一条作品里了。
import { getFlow, listRuns } from './flows.mjs'
import { createProject, bindProjectFlow, listProjects } from './projects.mjs'
import { projectsByFlow } from './run-ownership.mjs'
import { flowBrief, projectBrief } from './project-briefs.mjs'

/** 这块画布现在归哪条作品：没归返回 null（空白画布）。 */
export function canvasOwner(byFlow, flowId) {
  const key = String(flowId || '')
  if (!key || !(byFlow instanceof Map)) return null
  return byFlow.get(key) || null
}

/** 归在哪条作品的第几版：归档版也要说出来，「v1（已归档）」比只写 v1 诚实。 */
function ownedText(ref) {
  if (!ref) return ''
  return '《' + ref.title + '》第 ' + ref.version + ' 版' + (ref.archived ? '（已归档）' : '')
}

/**
 * 把画布挂到已有作品前的判断：返回 null 就是可以挂。
 * 白名单只有一种：这条作品已经绑着同一块画布（重复点一下不该报错，也不该多一条记录）。
 */
export function adoptCanvasBlock({ project, flow, byFlow }) {
  if (!project) return { status: 404, code: 'PROJECT_NOT_FOUND', error: '作品不存在或已被删除' }
  if (!flow) return { status: 404, code: 'FLOW_NOT_FOUND', error: '要接过来的画布不存在（可能已被删掉）' }
  const owner = canvasOwner(byFlow, flow.id)
  if (owner && owner.id !== project.id) {
    return {
      status: 409,
      code: 'FLOW_BOUND',
      error: '这块画布已经归在' + ownedText(owner) + '上：一块画布只归一条作品，运行与评审才不会串到两条作品里',
    }
  }
  const current = String(project.flowId || '')
  if (current && current !== String(flow.id)) {
    return {
      status: 409,
      code: 'CANVAS_TAKEN',
      error:
        '这条作品已经绑着另一块画布（当前第 ' + Math.max(1, Number(project.version) || 1) + ' 版）：' +
        '直接换画布会让旧版的运行与评审对不上号，要换先「开一版新的」',
    }
  }
  return null
}

/** 照画布建一条作品前的判断：画布得在，而且不能已经属于别的作品。 */
export function newProjectFromCanvasBlock({ flow, byFlow }) {
  if (!flow) return { status: 404, code: 'FLOW_NOT_FOUND', error: '要接过来的画布不存在（可能已被删掉）' }
  const owner = canvasOwner(byFlow, flow.id)
  if (owner) {
    return {
      status: 409,
      code: 'FLOW_BOUND',
      error: '这块画布已经归在' + ownedText(owner) + '上：要接着做就打开那条作品，别新建一条重复的',
    }
  }
  return null
}

/** 画布来的作品叫什么：画布名优先；画布名是空的（老数据）才退回一个诚实的占位。 */
export function canvasProjectTitle(name) {
  const text = String(name || '').trim().slice(0, 80)
  return text || '画布作品'
}

async function runsOnFlow(flowId, user) {
  const result = await listRuns({ flowId, limit: 1 }, user)
  return { count: Number(result?.total) || 0 }
}

/**
 * 把一块画布归到已有作品上。
 * 返回 { status, body }：路由只负责发出去，判断与写在同一个函数里，免得两处口径分叉。
 */
export async function adoptCanvasForProject({ projectId, flowId, user }) {
  const key = String(flowId || '')
  if (!key) return { status: 400, body: { error: '要说清是哪块画布', code: 'FLOW_REQUIRED' } }
  const [projects, flow] = await Promise.all([listProjects(user), getFlow(key, user)])
  const project = projects.find((item) => item.id === String(projectId || '')) || null
  const block = adoptCanvasBlock({ project, flow, byFlow: projectsByFlow(projects) })
  if (block) return { status: block.status, body: { error: block.error, code: block.code } }
  const runs = await runsOnFlow(key, user)
  // 已经是这块画布：不改任何字段，也不刷新更新时间——重复点一下不该像改了一次作品
  if (String(project.flowId || '') === key) {
    return { status: 200, body: { ok: true, changed: false, project: projectBrief(project), flow: flowBrief(flow), runs } }
  }
  const bound = await bindProjectFlow(project.id, key, user)
  if (!bound) return { status: 404, body: { error: '作品不存在或已被删除', code: 'PROJECT_NOT_FOUND' } }
  return { status: 200, body: { ok: true, changed: true, project: projectBrief(bound), flow: flowBrief(flow), runs } }
}

/** 照一块画布新建一条作品：没有模板，脚本在作品页现写，画布已经在了所以从 v1 起算。 */
export async function createProjectFromCanvas({ flowId, title, user }) {
  const key = String(flowId || '')
  if (!key) return { status: 400, body: { error: '要说清是哪块画布', code: 'FLOW_REQUIRED' } }
  const [projects, flow] = await Promise.all([listProjects(user), getFlow(key, user)])
  const block = newProjectFromCanvasBlock({ flow, byFlow: projectsByFlow(projects) })
  if (block) return { status: block.status, body: { error: block.error, code: block.code } }
  const project = await createProject(
    { title: canvasProjectTitle(title || flow.name), flowId: flow.id },
    user,
  )
  const runs = await runsOnFlow(key, user)
  return { status: 201, body: { ok: true, changed: true, project: projectBrief(project), flow: flowBrief(flow), runs } }
}
