// 工作流页空状态的「起手」清单（r249 / v0.9.232）。
//
// 以前空状态只有三个按钮，点了就离开这一页——更糟的是它们其实点不动（外层浮层
// pointer-events: none，按钮继承了去），人站在画布上以为这页什么也干不了。
// 现在把「手上有什么」直接摊在画布上，点了就在原地建好：
//   · 还没开过工作流的作品 → 按它现在的脚本开一条（服务端生成输入 + 复刻两个节点）
//   · 已经有工作流的作品   → 直接打开那一条
//   · 来自工作流的模板     → 套用成一条新的
//
// 只挑真能建出东西的：一个节点都没有的工作流模板不列（套出来还是空画布），
// 当前正打开的那条也不列（点了等于原地不动）。取哪几条、显示什么字都在这里定，
// 组件只负责画——文案改了单测会跟着报。
import type { ProjectSummary } from './project'
import type { ReplicaTemplate } from './radar'

export type CanvasStartProject = {
  source: 'project'
  id: string
  title: string
  /** 作品归属：只列自己的。公共示例作品的 ownerId 是空串，不拿它起手（绑不上去） */
  ownerId: string
  /** 0 = 还没开过工作流；>=1 = 已经有工作流（打开那条，不重建） */
  version: number
  /** 已有的工作流 id；空串表示还没开过 */
  flowId: string
  updatedAt: string
}

export type CanvasStartTemplate = {
  source: 'template'
  id: string
  title: string
  /** 模板里存下的节点数：0 的不列 */
  nodes: number
  updatedAt: string
}

export type CanvasStartItem = CanvasStartProject | CanvasStartTemplate

export type CanvasStartPlan = {
  projects: CanvasStartProject[]
  templates: CanvasStartTemplate[]
  /** 两组加起来的条数；0 表示这个人手上暂时没有能起手的东西 */
  total: number
}

/** 两组各留两条：浮层是画布上的一块，堆太多会把画布整片盖住。 */
export const START_PROJECT_LIMIT = 2
export const START_TEMPLATE_LIMIT = 2

function timeOf(value: string): number {
  const at = Date.parse(value || '')
  return Number.isFinite(at) ? at : 0
}

/** 模板里存了几个节点：列表接口给 flowNodes，详情/老数据可能只有 blueprint。 */
export function templateNodeCount(template: ReplicaTemplate): number {
  const summary = Array.isArray(template?.flowNodes) ? template.flowNodes.length : 0
  if (summary > 0) return summary
  const blueprint = template?.blueprint
  const nodes = blueprint && Array.isArray(blueprint.nodes) ? blueprint.nodes.length : 0
  return nodes > 0 ? nodes : 0
}

/**
 * 从作品与模板里挑出这次可以起手的几条。
 * 作品先排「还没开过工作流的」（那是真能在原地开出一条新流程的），再按最近动过的排；
 * 模板只认来自工作流的（kind === 'flow'）并且节点数大于 0。
 */
export function canvasStartPlan(
  projects: readonly ProjectSummary[] | null | undefined,
  templates: readonly ReplicaTemplate[] | null | undefined,
  options: { currentFlowId?: string; ownerId?: string; projectLimit?: number; templateLimit?: number } = {},
): CanvasStartPlan {
  const current = options.currentFlowId || ''
  const owner = options.ownerId || ''
  const projectLimit = Math.max(0, options.projectLimit ?? START_PROJECT_LIMIT)
  const templateLimit = Math.max(0, options.templateLimit ?? START_TEMPLATE_LIMIT)

  const pickedProjects = (Array.isArray(projects) ? projects : [])
    .filter((project) => Boolean(project && project.id))
    .map((project) => {
      const flowId = typeof project.flowId === 'string' ? project.flowId : ''
      return {
        source: 'project' as const,
        id: project.id,
        title: project.title || '未命名作品',
        ownerId: typeof (project as { ownerId?: unknown }).ownerId === 'string' ? (project as { ownerId: string }).ownerId : '',
        version: Math.max(0, Math.round(Number(project.version) || 0)),
        flowId,
        updatedAt: project.updatedAt || '',
      }
    })
    // 别人的（含公共示例）作品不列：开工作流要绑到这条作品上，绑不上只会给一句看不懂的报错
    .filter((item) => !owner || item.ownerId === owner)
    // 当前这条工作流就在眼前，不需要「打开它」这一行
    .filter((item) => !(item.flowId && item.flowId === current))
    // 既没有工作流、版本又不是 0 的最多算老数据：没有能开的东西，不列
    .filter((item) => item.version === 0 || Boolean(item.flowId))
    .sort((a, b) => {
      const rank = (item: { version: number }) => (item.version === 0 ? 0 : 1)
      return rank(a) - rank(b) || timeOf(b.updatedAt) - timeOf(a.updatedAt)
    })
    .slice(0, projectLimit)

  const pickedTemplates = (Array.isArray(templates) ? templates : [])
    .filter((template) => Boolean(template && template.id) && template.kind === 'flow')
    .map((template) => ({
      source: 'template' as const,
      id: template.id,
      title: template.title || '未命名模板',
      nodes: templateNodeCount(template),
      updatedAt: template.createdAt || template.savedAt || '',
    }))
    .filter((item) => item.nodes > 0)
    .sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt))
    .slice(0, templateLimit)

  return {
    projects: pickedProjects,
    templates: pickedTemplates,
    total: pickedProjects.length + pickedTemplates.length,
  }
}

/** 行上那句说明：写清这条现在是什么状态，不写「点我」。 */
export function canvasStartMeta(item: CanvasStartItem): string {
  if (item.source === 'project') {
    return item.flowId ? '已经有工作流' : '还没开过工作流'
  }
  return '来自工作流 · ' + item.nodes + ' 个节点'
}

/** 行上那个动作：写它会建什么、开什么。 */
export function canvasStartAction(item: CanvasStartItem): string {
  if (item.source === 'project') {
    return item.flowId ? '打开那条' : '按它的脚本开一条'
  }
  return '套用成新工作流'
}
