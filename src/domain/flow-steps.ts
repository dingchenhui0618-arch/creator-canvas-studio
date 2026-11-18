/**
 * 工作流的执行顺序（v0.9.211）。
 *
 * 手机上没有可用的画布（一块 272×309 的缩水画布，空状态还会盖住缩放按钮），
 * 只能用「按执行顺序的步骤清单」把这条工作流讲清楚。服务端执行用的是同一套
 * Kahn 拓扑排序（server/flows.mjs 的 topoSort），这里抄同一套规则，前端只在
 * 这一步「猜顺序」，真跑的时候仍以服务端为准。
 *
 * 有环时把原顺序照抄、标 cyclic：列不出来比顺序不准更没用，界面同时要提示跑不动。
 */
export type FlowStep = { id: string; deps: number[] }

export type FlowStepPlan = { steps: FlowStep[]; cyclic: boolean }

type NodeLike = { id: string }
type EdgeLike = { source: string; target: string }

export function flowStepPlan(nodes: NodeLike[], edges: EdgeLike[]): FlowStepPlan {
  const ids = nodes.map((node) => node.id)
  const known = new Set(ids)
  // 指向不存在的节点、自环的连线服务端会剔掉，这里同样先剔一遍：
  // 顺序与「依赖第几步」用的是同一批线，不能一处过滤一处不过滤。
  const usable = edges.filter(
    (edge) => known.has(edge.source) && known.has(edge.target) && edge.source !== edge.target,
  )
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]))
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const edge of usable) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.get(edge.source)?.push(edge.target)
  }
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift() as string
    order.push(id)
    for (const target of outgoing.get(id) ?? []) {
      const left = (indegree.get(target) ?? 0) - 1
      indegree.set(target, left)
      if (left === 0) queue.push(target)
    }
  }
  const cyclic = order.length !== ids.length
  const sequence = cyclic ? ids : order
  const stepNo = new Map(sequence.map((id, index) => [id, index + 1]))
  const steps = sequence.map((id) => ({
    id,
    // 上游步骤号（1 起，按清单顺序）：让人看出这一步为什么要等前面几步
    deps: usable
      .filter((edge) => edge.target === id && stepNo.has(edge.source))
      .map((edge) => stepNo.get(edge.source) as number)
  }))
  return { steps, cyclic }
}
