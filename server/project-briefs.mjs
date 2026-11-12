// 作品与画布的简报：列表、卡片、路由回执共用同一份形状。
//
// 两件事必须同时成立：不带能打开它的凭证（分享 token 等于钥匙），也不带原始脚本
// （脚本只从作品详情的顶层 script 读，一页里两个口径迟早读到旧的那个）。

/** 作品简报：去掉脚本副本与分享凭证，其余字段原样保留。 */
export function projectBrief(project) {
  const { script: _script, share: _share, shareHistory: _shareHistory, ...brief } = project
  return brief
}

/** 画布简报：页面只需要认得是哪块、几个节点、什么时候改过。 */
export function flowBrief(flow) {
  if (!flow) return null
  return {
    id: flow.id,
    name: flow.name,
    nodes: Array.isArray(flow.nodes) ? flow.nodes.length : 0,
    updatedAt: flow.updatedAt || '',
  }
}
