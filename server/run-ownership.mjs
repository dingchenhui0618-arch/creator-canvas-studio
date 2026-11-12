// 运行记录挂在哪个作品的哪一版上。
//
// 运行记录只认 flowId（逐节点结果存在流程服务里），作品自己记着当前版与归档版两张画布指针，
// 所以「这条运行属于哪条作品」是一次纯索引：不写存储、不复制运行数据。
// 和评审按 projectId 反查、模板按 templateId 反查是同一套做法——一条记录永远只有一份，
// 作品只是它的一个视角。

const roundVersion = (value) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 同一张画布被两条作品绑着时（复制画布后手动绑过）谁作数：当前版胜过归档版，再比最近改动。 */
function preferred(next, prev) {
  if (next.binding.archived !== prev.binding.archived) return !next.binding.archived
  return String(next.project.updatedAt || '') > String(prev.project.updatedAt || '')
}

/**
 * 画布 → 作品索引：作品的当前版与归档版都算它的。
 * 值是 `{ id, title, version, archived }`——认出是哪条、第几版，不带脚本与分享凭证。
 */
export function projectsByFlow(projects = []) {
  const picked = new Map()
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project?.id) continue
    const bindings = []
    for (const version of Array.isArray(project.versions) ? project.versions : []) {
      if (version?.flowId) bindings.push({ flowId: String(version.flowId), version: roundVersion(version.n), archived: true })
    }
    if (project.flowId) bindings.push({ flowId: String(project.flowId), version: roundVersion(project.version), archived: false })
    for (const binding of bindings) {
      const next = {
        ref: {
          id: String(project.id),
          title: String(project.title || '未命名作品'),
          version: binding.version,
          archived: binding.archived,
        },
        project,
        binding,
      }
      const prev = picked.get(binding.flowId)
      if (!prev || preferred(next, prev)) picked.set(binding.flowId, next)
    }
  }
  const byFlow = new Map()
  for (const [flowId, entry] of picked) byFlow.set(flowId, entry.ref)
  return byFlow
}

/** 一条运行挂在哪条作品上：没挂作品（空白画布直接跑的）返回 null，页面据此写「没挂在作品上」。 */
export function runProjectRef(byFlow, flowId) {
  if (!flowId || !(byFlow instanceof Map)) return null
  return byFlow.get(String(flowId)) || null
}

/** 给一页运行记录逐条挂上作品：只加一个字段，原有的字段一个字都不动。 */
export function withRunProject(runs = [], byFlow = new Map()) {
  return (Array.isArray(runs) ? runs : []).map((run) => ({ ...run, project: runProjectRef(byFlow, run?.flowId) }))
}

/**
 * 给一块画布挂上「属于哪条作品的第几版」：画布页据此写「在帮《X》· 第 N 版」，
 * 并给「打开作品 / 去评审这一版」。没归作品（空白画布）就是 null，页面据此什么也不写。
 * 与运行、评审同一张索引、同一个 ref——三处口径不分叉。
 */
export function withFlowProject(flows = [], byFlow = new Map()) {
  return (Array.isArray(flows) ? flows : []).map((flow) => ({ ...flow, project: runProjectRef(byFlow, flow?.id) }))
}

/**
 * 按作品名搜索运行：运行自己只记 flowName（画布名可以改、也可能是「画布 3」），
 * 搜「毛衣」要能搜到这条作品的运行——这里把作品的当前版与归档版画布一起交回给查询。
 */
export function projectFlowsMatching(projects = [], keyword = '') {
  const needle = String(keyword || '').trim().toLowerCase()
  if (!needle) return []
  const flowIds = []
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!String(project?.title || '').toLowerCase().includes(needle)) continue
    if (project.flowId) flowIds.push(String(project.flowId))
    for (const version of Array.isArray(project.versions) ? project.versions : []) {
      if (version?.flowId) flowIds.push(String(version.flowId))
    }
  }
  return Array.from(new Set(flowIds))
}
