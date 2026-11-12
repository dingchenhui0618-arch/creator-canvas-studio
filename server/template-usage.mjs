// 模板 ↔ 作品 的用量：模板库里每条模板「有几条作品在用」，模板详情里「是哪几条」。
//
// 不拿 reuseCount 代替：那是「点过几次用它做作品」的计数器，删掉作品也不会减；
// 「现在还有几条作品绑着它」才是事实，所以这里从 projects.json 现算。
// 归属沿用 listProjects 的同一套规则：谁能看这条作品，它的模板才被算进用量。
import { listProjects } from './projects.mjs'
import { deliveredCurrent } from './project-status.mjs'

/** 模板详情里的一行：够认出是哪条作品、走到哪一步。 */
export function templateProjectRef(project) {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    // 交付看「这一版交没交」：开了新版的作品不能说已交付
    delivered: deliveredCurrent(project),
    version: project.version,
    updatedAt: project.updatedAt,
  }
}

/**
 * 按模板 id 分组；组内最近改过的排前面（详情里先看到正在做的那条）。
 * 没有 templateId 的作品（模板已删）不进分组：它已经没有模板可算。
 */
export async function projectsByTemplate(user = null) {
  const map = new Map()
  for (const project of await listProjects(user)) {
    if (!project.templateId) continue
    const list = map.get(project.templateId) || []
    list.push(templateProjectRef(project))
    map.set(project.templateId, list)
  }
  for (const list of map.values()) list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return map
}

/**
 * 摊平成「一条作品一行」，并把 templateId 带回来。
 * byTemplate 里的行是给详情抽屉看的（没有 templateId），而「同一条原片开出了几条作品」
 * 要靠 templateId 把作品按模板归到原片上——少了这一列，那块永远算成 0 条。
 */
export function flattenTemplateWorks(byTemplate) {
  const rows = []
  for (const [templateId, list] of byTemplate) {
    for (const project of list) rows.push({ ...project, templateId })
  }
  return rows
}

/** 模板列表卡片：每条挂一个「几条作品在用」；没被用过的写 0，卡片按 0 不显示。 */
export function withProjectCount(items, byTemplate) {
  return items.map((item) => ({ ...item, projectCount: (byTemplate.get(item.id) || []).length }))
}
/** 这些模板名下总共有几条作品在用（模板库顶部汇总条那一格）。 */
export function totalProjectCount(byTemplate) {
  let total = 0
  for (const list of byTemplate.values()) total += list.length
  return total
}

// 模板详情里最多列 8 条：一条模板名下作品多时，抽屉不该被这一块占满
export const TEMPLATE_PROJECT_LIMIT = 8

/** 详情要的两样：总共有几条、要列出来的那几条（超出的部分页面写「还有 N 条」）。 */
export function templateWorksView(projects = []) {
  return {
    projectCount: projects.length,
    projects: projects.slice(0, TEMPLATE_PROJECT_LIMIT),
  }
}
