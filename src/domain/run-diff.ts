import type { ApiFlowEdge, ApiFlowNode, RunGraphSnapshot } from '../api/flows'

/** 一条运行之后，当前画布上还改了什么：节点按「新增 / 删除 / 位置 / 标题 / 参数」分开数。 */
export type RunGraphChange = { id: string; title: string }

export type RunGraphDiff = {
  /** 快照里 / 当前画布上的节点数：两个数不一样时先说数量，再说改了什么 */
  snapshotNodes: number
  currentNodes: number
  /** 运行之后才加进来的节点 */
  added: RunGraphChange[]
  /** 运行之后被删掉的节点：标题取快照里的名字 */
  removed: RunGraphChange[]
  /** 还在、但位置被挪过的节点 */
  moved: RunGraphChange[]
  /** 还在、但标题改过的节点 */
  retitled: RunGraphChange[]
  /** 还在、但类型或参数改过的节点（位置 / 标题不算参数） */
  changed: RunGraphChange[]
  /** 新增 / 减少的连线数：节点删掉时它两端的线也会算在这里 */
  edgesAdded: number
  edgesRemoved: number
  /** 两边完全一样（位置、标题、参数、连线都没动） */
  same: boolean
  /** 一行能读的摘要；没有改动时为空串，由页面自己写「一致」 */
  summary: string
}

type GraphLike = { nodes: ApiFlowNode[]; edges: ApiFlowEdge[] }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map((item) => stableJson(item)).join(',') + ']'
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + stableJson(record[key])).join(',') + '}'
  }
  return JSON.stringify(value) ?? 'null'
}

function labelOf(node: ApiFlowNode | undefined): string {
  if (!node) return ''
  const title = String(node.data?.title || '').trim()
  return title || node.id
}

function positionOf(node: ApiFlowNode): string {
  return Math.round(Number(node.position?.x) || 0) + ',' + Math.round(Number(node.position?.y) || 0)
}

function edgeKey(edge: ApiFlowEdge): string {
  return [edge.source || '', edge.sourceHandle || '', edge.target || '', edge.targetHandle || ''].join('\u0000')
}

/**
 * 回看运行时的「与当前画布比」（v0.9.108）。
 * 快照是运行开始那一刻的节点与连线；当前画布是这次打开页面时从服务端读到的内容。
 * 这里只做事实对照，不判断能不能续跑——能不能复用由服务端的 resume-plan 按内容指纹算。
 * 位置和标题分开数：挪一下画布、改个名字都不影响复用，不能和「改了提示词」混成一句。
 */
export function diffRunGraph(snapshot: GraphLike | RunGraphSnapshot | null | undefined, current: GraphLike | null | undefined): RunGraphDiff | null {
  if (!snapshot || !current) return null
  const snapshotNodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
  const currentNodes = Array.isArray(current.nodes) ? current.nodes : []
  const snapshotEdges = Array.isArray(snapshot.edges) ? snapshot.edges : []
  const currentEdges = Array.isArray(current.edges) ? current.edges : []
  const before = new Map(snapshotNodes.map((node) => [node.id, node]))
  const after = new Map(currentNodes.map((node) => [node.id, node]))

  const added: RunGraphChange[] = []
  const removed: RunGraphChange[] = []
  const moved: RunGraphChange[] = []
  const retitled: RunGraphChange[] = []
  const changed: RunGraphChange[] = []

  for (const node of currentNodes) {
    const old = before.get(node.id)
    if (!old) {
      added.push({ id: node.id, title: labelOf(node) })
      continue
    }
    if (positionOf(old) !== positionOf(node)) moved.push({ id: node.id, title: labelOf(node) })
    if (String(old.data?.title || '') !== String(node.data?.title || '')) {
      retitled.push({ id: node.id, title: labelOf(node) })
    }
    const oldShape = stableJson({ type: old.type, kind: old.data?.kind, config: old.data?.config || {} })
    const newShape = stableJson({ type: node.type, kind: node.data?.kind, config: node.data?.config || {} })
    if (oldShape !== newShape) changed.push({ id: node.id, title: labelOf(node) })
  }
  for (const node of snapshotNodes) {
    if (!after.has(node.id)) removed.push({ id: node.id, title: labelOf(node) })
  }

  const oldEdges = new Set(snapshotEdges.map(edgeKey))
  const newEdges = new Set(currentEdges.map(edgeKey))
  let edgesAdded = 0
  let edgesRemoved = 0
  for (const key of newEdges) if (!oldEdges.has(key)) edgesAdded += 1
  for (const key of oldEdges) if (!newEdges.has(key)) edgesRemoved += 1

  const parts: string[] = []
  if (changed.length) parts.push('参数 ' + changed.length)
  if (moved.length) parts.push('位置 ' + moved.length)
  if (retitled.length) parts.push('标题 ' + retitled.length)
  if (added.length) parts.push('新增 ' + added.length)
  if (removed.length) parts.push('删除 ' + removed.length)
  if (edgesAdded) parts.push('连线 +' + edgesAdded)
  if (edgesRemoved) parts.push('连线 -' + edgesRemoved)

  const same = parts.length === 0
  return {
    snapshotNodes: snapshotNodes.length,
    currentNodes: currentNodes.length,
    added,
    removed,
    moved,
    retitled,
    changed,
    edgesAdded,
    edgesRemoved,
    same,
    summary: same ? '' : parts.join(' · '),
  }
}
